'use server'

// Server action: create a new client organisation, generate an invite link,
// and send the founder a welcome email containing that link.
//
// Atomicity via compensating deletes:
//   - If generateLink fails: DELETE the just-inserted organisation row.
//   - If Resend fails: DELETE the auth.users row AND the organisation row.
// Each step's error is handled separately — not collapsed into one try/catch.
//
// ADR-021: operator-only. No organisation_id filter on auth check.
// ADR-001: no tool names in this file. Resend is referenced only via sendTransactionalEmail.
// ADR-020: founder_first_name is required and written to the organisations row at creation time.

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { sendTransactionalEmail } from '@/lib/email/send'
import { clientWelcomeTemplate, clientWelcomeSubject } from '@/lib/email/templates/client-welcome'
import { getAppUrl } from '@/lib/urls/app-url'

type FormFields = {
  org_name: string
  founder_first_name: string
  founder_email: string
  currency: string
  monthly_meetings_target: string
  contract_start_date: string
  contract_end_date: string
}

export type CreateOrgState =
  | { status: 'idle' }
  | { status: 'error'; message: string; fields?: FormFields }
  | { status: 'success'; orgId: string; orgName: string }

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org'
}

export async function createOrganisation(
  _prevState: CreateOrgState,
  formData: FormData
): Promise<CreateOrgState> {
  // ── 1. Extract and validate form fields ────────────────────────────────────
  const orgName             = formData.get('org_name')?.toString().trim() ?? ''
  const founderFirstName    = formData.get('founder_first_name')?.toString().trim() ?? ''
  const founderEmail        = formData.get('founder_email')?.toString().trim().toLowerCase() ?? ''
  const currency            = formData.get('currency')?.toString() ?? ''
  const meetingsTargetRaw   = formData.get('monthly_meetings_target')?.toString() ?? '8'
  const contractStartDate   = formData.get('contract_start_date')?.toString() || null
  const contractEndDate     = formData.get('contract_end_date')?.toString() || null

  const fields: FormFields = {
    org_name: orgName,
    founder_first_name: founderFirstName,
    founder_email: founderEmail,
    currency,
    monthly_meetings_target: meetingsTargetRaw,
    contract_start_date: contractStartDate ?? '',
    contract_end_date: contractEndDate ?? '',
  }

  if (!orgName || !founderFirstName || !founderEmail || !currency) {
    return { status: 'error', message: 'Organisation name, founder first name, founder email, and currency are required.', fields }
  }
  if (!['GBP', 'EUR', 'USD'].includes(currency)) {
    return { status: 'error', message: 'Currency must be GBP, EUR, or USD.', fields }
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(founderEmail)) {
    return { status: 'error', message: 'Founder email is not a valid email address.', fields }
  }
  const monthlyMeetingsTarget = parseInt(meetingsTargetRaw, 10)
  if (isNaN(monthlyMeetingsTarget) || monthlyMeetingsTarget < 1) {
    return { status: 'error', message: 'Monthly meetings target must be a positive whole number.', fields }
  }

  // ── 2. Operator auth check ──────────────────────────────────────────────────
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return { status: 'error', message: 'Not authenticated.', fields }
  }

  const { data: userRow, error: roleError } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (roleError || !userRow || userRow.role !== 'operator') {
    return { status: 'error', message: 'Operator access required.', fields }
  }

  // ── 3. Pre-invite check: does this email already exist in auth.users? ───────
  // Uses GoTrue admin REST API directly — no clean SDK method for email lookup.
  // Fail-open: if the check itself errors, proceed (compensating deletes handle duplicates).
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY!
  try {
    const checkRes = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1&email=${encodeURIComponent(founderEmail)}`,
      { headers: { 'Authorization': `Bearer ${serviceKey}`, 'apikey': serviceKey } }
    )
    if (checkRes.ok) {
      const body = await checkRes.json() as { users?: { email: string }[] }
      const exists = body.users?.some(u => u.email.toLowerCase() === founderEmail)
      if (exists) {
        logger.warn('createOrganisation: email already exists in auth.users', { founderEmail })
        return {
          status: 'error',
          message: 'A user with this email already exists. Check users_pending_review or delete the dangling auth user in the Supabase Dashboard before retrying.',
          fields,
        }
      }
    }
  } catch (e) {
    logger.warn('createOrganisation: email pre-check failed — proceeding', { error: String(e) })
  }

  // ── 4. INSERT organisation row ─────────────────────────────────────────────
  const adminClient = getAdminClient()

  // Generate a URL-safe slug from the org name. On the rare collision, append a
  // short base-36 timestamp so the uniqueness constraint is never the cause of failure.
  const baseSlug = toSlug(orgName)
  const { data: slugConflict } = await adminClient
    .from('organisations')
    .select('id')
    .eq('slug', baseSlug)
    .maybeSingle()
  const slug = slugConflict ? `${baseSlug}-${Date.now().toString(36)}` : baseSlug

  const { data: org, error: orgError } = await adminClient
    .from('organisations')
    .insert({
      name: orgName,
      slug,
      founder_first_name: founderFirstName,
      currency,
      monthly_meetings_target: monthlyMeetingsTarget,
      contract_start_date: contractStartDate,
      contract_end_date: contractEndDate,
    })
    .select('id, name')
    .single()

  if (orgError || !org) {
    logger.error('createOrganisation: failed to insert organisation', { orgName, error: orgError?.message })
    return {
      status: 'error',
      message: `Failed to create organisation record: ${orgError?.message ?? 'Unknown error'}. Please try again.`,
      fields,
    }
  }

  const orgId = org.id

  // ── 5. Generate invite OTP — compensating delete on failure ───────────────
  // We use email_otp (the typed code), not action_link (the consumable URL).
  // action_link is a one-time token that Outlook Safe Links prefetches and
  // consumes before the founder ever sees the email. email_otp is a short
  // alphanumeric code the founder types manually — immune to prefetch.
  const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
    type: 'invite',
    email: founderEmail,
    options: {
      data: { organisation_id: orgId, intended_role: 'client' },
    },
  })

  if (linkError || !linkData?.properties?.email_otp) {
    logger.error('createOrganisation: generateLink failed — rolling back org', { orgId, error: linkError?.message })
    await adminClient.from('organisations').delete().eq('id', orgId)
    return {
      status: 'error',
      message: `Failed to generate invite code: ${linkError?.message ?? 'Unknown error'}. Organisation record removed.`,
      fields,
    }
  }

  const emailOtp   = linkData.properties.email_otp
  const authUserId = linkData.user.id

  // Login URL pre-fills the founder's email and signals invite flow so the
  // login page skips the send-code step and goes straight to code entry.
  const loginUrl = `${getAppUrl()}/login?email=${encodeURIComponent(founderEmail)}&invite=1`

  // ── 6. Send welcome email — compensating delete on failure ─────────────────
  const emailResult = await sendTransactionalEmail({
    to: founderEmail,
    subject: clientWelcomeSubject(orgName),
    html: clientWelcomeTemplate({ founderFirstName, orgName, otpCode: emailOtp, loginUrl }),
  })

  if (!emailResult.success) {
    logger.error('createOrganisation: welcome email failed — rolling back org and auth user', { orgId, authUserId })
    await adminClient.auth.admin.deleteUser(authUserId)
    await adminClient.from('organisations').delete().eq('id', orgId)
    return {
      status: 'error',
      message: 'Welcome email could not be sent. Organisation setup has been rolled back. Please try again.',
      fields,
    }
  }

  logger.info('createOrganisation: success', { orgId, orgName, founderEmail })
  return { status: 'success', orgId, orgName }
}
