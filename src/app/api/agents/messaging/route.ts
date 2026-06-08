// POST /api/agents/messaging
// Triggers the Messaging Playbook generation agent for a given organisation.
//
// Auth: operator session OR valid x-internal-secret header.
// The internal secret allows /api/intake/complete to dispatch this route
// on behalf of a client user without an operator session.
//
// Dependencies: ICP, Positioning, and TOV documents must all exist and be active.
// If any are missing, the agent throws a clear error naming exactly which are absent.
// Dispatched by the cascade helper after ICP + positioning + TOV are all approved.
//
// On success: sends the operator a suggestion-ready notification.
// On failure: sends the operator an agent-failure alert.
//
// The agent writes to document_suggestions only.
// Doug reviews and approves before anything reaches strategy_documents.
//
// ADR-021: operator routes are cross-org — any org_id is valid for authenticated operators

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { runMessagingGenerationAgent } from '@/agents/messaging-generation-agent'
import { resolveOrgPrimarySegment } from '@/lib/segments/resolve-primary-segment'
import { logger } from '@/lib/logger'
import { sendTransactionalEmail } from '@/lib/email/send'
import { suggestionReadyTemplate, suggestionReadySubject } from '@/lib/email/templates/suggestion-ready'
import { agentFailureTemplate, agentFailureSubject } from '@/lib/email/templates/agent-failure'

export const maxDuration = 300

function getAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function POST(request: NextRequest) {
  // ── 1. Parse request body ──────────────────────────────────────────────────
  let body: { organisation_id?: string; segment_id?: string | null; is_refresh?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON in request body.' },
      { status: 400 }
    )
  }

  const { organisation_id, segment_id: bodySegmentId, is_refresh = false } = body

  if (!organisation_id || typeof organisation_id !== 'string') {
    return NextResponse.json(
      { error: 'organisation_id is required.' },
      { status: 400 }
    )
  }

  // ── 2. Auth: operator session OR internal secret ───────────────────────────
  const internalSecret = process.env.NEXT_INTERNAL_SECRET
  const providedSecret = request.headers.get('x-internal-secret')
  const isInternalCall = internalSecret && providedSecret === internalSecret

  // ── 3. Create Supabase clients ─────────────────────────────────────────────
  const cookieStore = await cookies()
  const sessionClient = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )
  const supabase = getAdminClient()

  let operatorId = 'internal'

  if (!isInternalCall) {
    const { data: { user }, error: authError } = await sessionClient.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Not authenticated.' },
        { status: 401 }
      )
    }

    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    if (userError || !userRow) {
      return NextResponse.json(
        { error: 'Could not verify user role.' },
        { status: 403 }
      )
    }

    if (userRow.role !== 'operator') {
      logger.warn(
        'Messaging route: non-operator attempted to trigger agent',
        { user_id: user.id, role: userRow.role, organisation_id }
      )
      return NextResponse.json(
        { error: 'Only operators can trigger document generation.' },
        { status: 403 }
      )
    }

    operatorId = user.id
  }

  // ── 4. Verify the organisation exists ──────────────────────────────────────
  const { data: org, error: orgError } = await supabase
    .from('organisations')
    .select('id, name')
    .eq('id', organisation_id)
    .single()

  if (orgError || !org) {
    return NextResponse.json(
      { error: `Organisation ${organisation_id} not found.` },
      { status: 404 }
    )
  }

  // ── 5. Resolve segment_id ──────────────────────────────────────────────────
  // Priority: (1) explicit body param, (2) org's intake segment, (3) first org segment.
  let resolvedSegmentId: string | null = bodySegmentId ?? null

  if (!resolvedSegmentId) {
    const { data: intakeRow } = await supabase
      .from('intake_responses')
      .select('segment_id')
      .eq('organisation_id', organisation_id)
      .not('segment_id', 'is', null)
      .limit(1)
      .single()

    resolvedSegmentId = intakeRow?.segment_id ?? null
  }

  if (!resolvedSegmentId) {
    resolvedSegmentId = await resolveOrgPrimarySegment(supabase as import('@supabase/supabase-js').SupabaseClient, organisation_id)
  }

  // ── 6. Run the agent ───────────────────────────────────────────────────────
  logger.info(
    'Messaging route: starting agent run',
    { operator_id: operatorId, organisation_id, org_name: org.name, segment_id: resolvedSegmentId, is_refresh }
  )

  try {
    const result = await runMessagingGenerationAgent({
      organisation_id,
      segment_id: resolvedSegmentId,
      supabase,
      is_refresh,
    })

    const operatorEmail = process.env.RESEND_OPERATOR_EMAIL
    if (operatorEmail) {
      try {
        await sendTransactionalEmail({
          to: operatorEmail,
          subject: suggestionReadySubject(org.name, 'messaging'),
          html: suggestionReadyTemplate({ orgName: org.name, orgId: organisation_id, docType: 'messaging' }),
        })
      } catch (emailErr) {
        logger.warn('Messaging route: operator notification failed', {
          organisation_id,
          error: emailErr instanceof Error ? emailErr.message : String(emailErr),
        })
      }
    }

    return NextResponse.json(result, { status: 200 })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    logger.error(
      'Messaging route: agent run failed',
      { organisation_id, error: message }
    )

    const operatorEmail = process.env.RESEND_OPERATOR_EMAIL
    if (operatorEmail) {
      try {
        await sendTransactionalEmail({
          to: operatorEmail,
          subject: agentFailureSubject(org.name, 'messaging'),
          html: agentFailureTemplate({ orgName: org.name, orgId: organisation_id, docType: 'messaging', error: message }),
        })
      } catch (emailErr) {
        logger.warn('Messaging route: failure notification email failed', {
          organisation_id,
          error: emailErr instanceof Error ? emailErr.message : String(emailErr),
        })
      }
    }

    // Surface pre-flight errors directly — missing name fields are operator-actionable.
    if (message.includes('required fields are missing')) {
      return NextResponse.json({ error: message }, { status: 422 })
    }

    // Surface document status errors directly — names exactly what needs approval.
    if (message.includes('documents need attention') || message.includes('has status "')) {
      return NextResponse.json({ error: message }, { status: 422 })
    }

    return NextResponse.json(
      { error: 'Messaging agent failed. Check server logs for details.' },
      { status: 500 }
    )
  }
}
