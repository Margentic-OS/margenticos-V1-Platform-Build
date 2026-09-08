// POST /api/operator/prospects/stop
//
// The operator's answer to "stop contacting this person".
//
// This route is the surface that did not exist. Every mechanism for stopping somebody was
// already built and working; none of them could be reached by a person deciding to use one.
// The measured consequence was that stopping a prospect mid-sequence meant clicking in the
// vendor's own UI, outside the product, leaving no record here of who did it or why.
//
// The route owns the auth gate and nothing else. What a stop MEANS lives in
// stopProspect(), so this file cannot drift from it and a second caller cannot get a
// different definition of the same word.
//
// ONE PROSPECT PER CALL, and that is a design decision rather than a first iteration. See
// the header of stop-prospect.ts: the batch and whole-client cases need a decision about
// what triggers them before they need code.

import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import { requireOperator } from '@/lib/supabase/require-operator'
import { asServiceRoleClient } from '@/lib/supabase/service-role'
import { stopProspect } from '@/lib/suppression/stop-prospect'

export const dynamic = 'force-dynamic'

/** Long enough to be a reason, short enough not to be an essay pasted into a column. */
const MAX_REASON_LENGTH = 1000

async function buildSessionClient() {
  const cookieStore = await cookies()
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        },
      },
    }
  )
}

export async function POST(request: NextRequest) {
  try {
    const sessionClient = await buildSessionClient()
    // Branded at the one expression that passes the service-role key, which is the only
    // place asServiceRoleClient may be called. See service-role.ts: the brand exists because
    // passing an SSR session client to a service-role parameter compiled clean four times.
    const supabase = asServiceRoleClient(
      createServiceClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      )
    )

    // Checked on every request, not just at login. CLAUDE.md, auth section.
    const { user, authorized } = await requireOperator(sessionClient, supabase)
    if (!authorized || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    const body = await request.json().catch(() => null)
    const prospectId = typeof body?.prospect_id === 'string' ? body.prospect_id : null
    const rawReason = typeof body?.reason === 'string' ? body.reason : ''

    if (!prospectId) {
      return NextResponse.json({ error: 'Missing prospect_id' }, { status: 400 })
    }

    // Rejected here as well as in stopProspect. The module refuses an empty reason because
    // it must be impossible to stop somebody without one whatever the caller does; the
    // route refuses it here so the operator gets a 400 that says what is wrong rather than
    // a 500 carrying an internal message.
    const reason = rawReason.trim()
    if (reason.length === 0) {
      return NextResponse.json(
        { error: 'A reason is required. It is what tells a later reader this was a decision and not a bug.' },
        { status: 400 }
      )
    }
    if (reason.length > MAX_REASON_LENGTH) {
      return NextResponse.json(
        { error: `Reason must be ${MAX_REASON_LENGTH} characters or fewer` },
        { status: 400 }
      )
    }

    // Read the columns the stop needs, and no more. outbound_lead_id decides whether there
    // is anything at the provider to stop at all.
    const { data: prospect, error: prospectError } = await supabase
      .from('prospects')
      .select('id, organisation_id, email, outbound_lead_id')
      .eq('id', prospectId)
      .single()

    if (prospectError || !prospect) {
      return NextResponse.json({ error: 'Prospect not found' }, { status: 404 })
    }

    const result = await stopProspect(supabase, {
      subject: {
        id: prospect.id,
        organisation_id: prospect.organisation_id,
        email: prospect.email,
        outbound_lead_id: prospect.outbound_lead_id,
      },
      operatorId: user.id,
      reason,
    })

    if (!result.ok) {
      // The database write failed, so nothing was stopped and nothing is watching.
      logger.error('stop prospect route: the stop was not recorded', {
        prospect_id: prospectId,
        organisation_id: prospect.organisation_id,
        error: result.error,
      })
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    // 200 with carry_status, NOT a 5xx when the provider call failed.
    //
    // The stop IS recorded: the prospect is blocked, and MON-026 will read the provider back
    // and go red if the sequence is still running. Returning an error here would tell the
    // operator the stop did not happen and invite a retry of something already correct.
    // The response says plainly which half landed.
    return NextResponse.json({
      ok: true,
      prospect_id: prospect.id,
      carry_status: result.carry.status,
      carry_error: result.carry.error,
      stopped_lead_count: result.carry.stoppedLeadIds.length,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('stop prospect route: unhandled failure', { error: message })
    return NextResponse.json({ error: 'Failed to stop prospect' }, { status: 500 })
  }
}
