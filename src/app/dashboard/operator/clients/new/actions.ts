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

export type CreateOrgState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'success'; orgId: string; orgName: string }

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
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

  if (!orgName || !founderFirstName || !founderEmail || !currency) {
    return { status: 'error', message: 'Organisation name, founder first name, founder email, and currency are required.' }
  }
  if (!['GBP', 'EUR', 'USD'].includes(currency)) {
    return { status: 'error', message: 'Currency must be GBP, EUR, or USD.' }
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(founderEmail)) {
    return { status: 'error', message: 'Founder email is not a valid email address.' }
  }
  const monthlyMeetingsTarget = parseInt(meetingsTargetRaw, 10)
  if (isNaN(monthlyMeetingsTarget) || monthlyMeetingsTarget < 1) {
    return { status: 'error', message: 'Monthly meetings target must be a positive whole number.' }
  }

  // ── 2. Operator auth check ──────────────────────────────────────────────────
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return { status: 'error', message: 'Not authenticated.' }
  }

  const { data: userRow, error: roleError } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (roleError || !userRow || userRow.role !== 'operator') {
    return { status: 'error', message: 'Operator access required.' }
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
        }
      }
    }
  } catch (e) {
    logger.warn('createOrganisation: email pre-check failed — proceeding', { error: String(e) })
  }

  // ── 4. INSERT organisation row ─────────────────────────────────────────────
  const adminClient = getAdminClient()

  const { data: org, error: orgError } = await adminClient
    .from('organisations')
    .insert({
      name: orgName,
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
    return { status: 'error', message: 'Failed to create organisation record. Please try again.' }
  }

  const orgId = org.id

  // ── 5. Generate invite link — compensating delete on failure ───────────────
  const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
    type: 'invite',
    email: founderEmail,
    options: {
      redirectTo: `${getAppUrl()}/auth/callback`,
      data: { organisation_id: orgId, intended_role: 'client' },
    },
  })

  if (linkError || !linkData?.properties?.action_link) {
    logger.error('createOrganisation: generateLink failed — rolling back org', { orgId, error: linkError?.message })
    await adminClient.from('organisations').delete().eq('id', orgId)
    return {
      status: 'error',
      message: `Failed to generate invite link: ${linkError?.message ?? 'Unknown error'}. Organisation record removed.`,
    }
  }

  const actionLink  = linkData.properties.action_link
  const authUserId  = linkData.user.id

  // ── 6. Send welcome email — compensating delete on failure ─────────────────
  const emailResult = await sendTransactionalEmail({
    to: founderEmail,
    subject: clientWelcomeSubject(orgName),
    html: clientWelcomeTemplate({ founderFirstName, orgName, actionLink }),
  })

  if (!emailResult.success) {
    logger.error('createOrganisation: welcome email failed — rolling back org and auth user', { orgId, authUserId })
    await adminClient.auth.admin.deleteUser(authUserId)
    await adminClient.from('organisations').delete().eq('id', orgId)
    return {
      status: 'error',
      message: 'Welcome email could not be sent. Organisation setup has been rolled back. Please try again.',
    }
  }

  logger.info('createOrganisation: success', { orgId, orgName, founderEmail })
  return { status: 'success', orgId, orgName }
}
