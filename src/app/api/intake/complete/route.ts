// POST /api/intake/complete
//
// Called by the client's intake form when critical-field completeness crosses
// the 80% threshold for the first time. Dispatches all four strategy agents
// (ICP, TOV, Positioning, Messaging) and notifies the operator.
//
// Design: returns 202 immediately. Agent dispatch + operator email run in
// after() so the client gets a fast response. Each agent runs as its own
// independent serverless invocation.
//
// Idempotency: organisations.agents_dispatched_at is the guard. The first
// POST atomically claims the dispatch; subsequent POSTs get 200 already_dispatched.
//
// Auth: authenticated client user. Operator role is NOT required here.
// The internal secret (x-internal-secret) is added to agent dispatch requests
// so the agent routes can accept calls from this route (not just operator sessions).

import { NextRequest, NextResponse, after } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { sendTransactionalEmail } from '@/lib/email/send'
import { intakeCompleteTemplate, intakeCompleteSubject } from '@/lib/email/templates/intake-complete'
import { getAppUrl } from '@/lib/urls/app-url'

function getAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function POST(_request: NextRequest) {
  // ── 1. Auth: authenticated user (client or operator) ───────────────────────
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // ── 2. Resolve organisation_id ─────────────────────────────────────────────
  const { data: userRow, error: userError } = await supabase
    .from('users')
    .select('organisation_id')
    .eq('id', user.id)
    .single()

  if (userError || !userRow?.organisation_id) {
    return NextResponse.json({ error: 'Organisation not found for this user.' }, { status: 403 })
  }

  const orgId = userRow.organisation_id
  const adminClient = getAdminClient()

  // ── 3. Atomic dispatch guard ───────────────────────────────────────────────
  // UPDATE ... WHERE agents_dispatched_at IS NULL returns a row only if this
  // is the first POST. Zero rows = already dispatched.
  const { data: claimed } = await adminClient
    .from('organisations')
    .update({ agents_dispatched_at: new Date().toISOString() })
    .eq('id', orgId)
    .is('agents_dispatched_at', null)
    .select('id, name')
    .single()

  if (!claimed) {
    return NextResponse.json({ status: 'already_dispatched' }, { status: 200 })
  }

  const orgName = claimed.name

  // ── 4. Defense-in-depth: re-verify 80% threshold ──────────────────────────
  // The form checks this client-side, but a direct POST could bypass it.
  // segment_id is read here so the ICP and Messaging dispatches can carry it.
  const { data: intakeRows } = await supabase
    .from('intake_responses')
    .select('is_critical, response_value, segment_id')
    .eq('organisation_id', orgId)

  const criticalRows = (intakeRows ?? []).filter(r => r.is_critical)
  const answeredRows = criticalRows.filter(r => (r.response_value ?? '').trim().length > 0)
  const completeness = criticalRows.length > 0
    ? answeredRows.length / criticalRows.length
    : 0

  // Resolve segment_id from backfilled intake rows. Fall back to first org segment if NULL.
  const intakeSegmentId: string | null =
    (intakeRows ?? []).find(r => r.segment_id != null)?.segment_id ?? null

  if (completeness < 0.8) {
    // Reset the guard so the client can try again once more fields are answered
    await adminClient
      .from('organisations')
      .update({ agents_dispatched_at: null })
      .eq('id', orgId)
    logger.warn('intake-complete: below 80% threshold — dispatch aborted', { orgId, completeness })
    return NextResponse.json(
      { error: 'Intake completeness is below 80%. Answer more critical fields and try again.' },
      { status: 400 }
    )
  }

  // ── 5. Dispatch runs after the 202 is sent ─────────────────────────────────
  after(async () => {
    // Send intake-complete notification to operator
    const operatorEmail = process.env.RESEND_OPERATOR_EMAIL
    if (operatorEmail) {
      await sendTransactionalEmail({
        to: operatorEmail,
        subject: intakeCompleteSubject(orgName),
        html: intakeCompleteTemplate({ orgName, orgId }),
      })
    } else {
      logger.warn('intake-complete: RESEND_OPERATOR_EMAIL not set — notification skipped', { orgId })
    }

    // Dispatch each agent route with an 8-second timeout to accommodate Vercel
    // cold starts (observed up to ~7s on Hobby tier). Each fetch creates a new
    // serverless invocation that runs independently. The AbortController timeout
    // just confirms dispatch was received — we don't wait for the agent to complete.
    const appUrl  = getAppUrl()
    const secret  = process.env.NEXT_INTERNAL_SECRET
    if (!secret) {
      logger.error('intake-complete: NEXT_INTERNAL_SECRET not configured — agent dispatch aborted')
      return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 })
    }

    // Resolve segment for ICP and Messaging dispatches.
    // intakeSegmentId was populated from the backfilled intake_responses.segment_id.
    // If still null (edge case: brand-new org with no backfill yet), fetch the first segment.
    let dispatchSegmentId: string | null = intakeSegmentId
    if (!dispatchSegmentId) {
      const adminClient = getAdminClient()
      const { data: firstSeg } = await adminClient
        .from('segments')
        .select('id')
        .eq('organisation_id', orgId)
        .order('created_at', { ascending: true })
        .limit(1)
        .single()
      dispatchSegmentId = firstSeg?.id ?? null
    }

    const dispatchAgent = async (path: string, extraPayload?: Record<string, unknown>) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8000)
      try {
        await fetch(`${appUrl}${path}`, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': secret,
          },
          body: JSON.stringify({ organisation_id: orgId, ...extraPayload }),
        })
        logger.info(`intake-complete: dispatched ${path}`, { orgId })
      } catch {
        // AbortError = 2s elapsed; the request was sent, the agent is running.
        // NetworkError = request could not be sent; log and continue.
        logger.warn(`intake-complete: dispatch timeout/error for ${path}`, { orgId })
      } finally {
        clearTimeout(timeout)
      }
    }

    const segmentPayload = dispatchSegmentId ? { segment_id: dispatchSegmentId } : undefined

    await Promise.all([
      dispatchAgent('/api/agents/icp', segmentPayload),
      dispatchAgent('/api/agents/positioning'),
      dispatchAgent('/api/agents/tov'),
      dispatchAgent('/api/agents/messaging', segmentPayload),
    ])
  })

  return NextResponse.json({ status: 'dispatched' }, { status: 202 })
}
