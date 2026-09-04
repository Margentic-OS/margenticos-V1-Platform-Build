import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { suppressProspectAtProvider } from '@/lib/suppression/provider-suppression'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: prospectId } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const reason = body.reason ? String(body.reason).slice(0, 200) : null

    // Get user's organisation
    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('organisation_id')
      .eq('id', user.id)
      .single()

    if (userError || !userRow) {
      return NextResponse.json({ error: 'User not found' }, { status: 403 })
    }

    const orgId = userRow.organisation_id
    if (!orgId) {
      return NextResponse.json({ error: 'User has no organisation' }, { status: 403 })
    }

    // Race-safe reject: fail if prospect is already sending (outbound_upload_status != 'pending')
    const { data: rejected, error: rejectError } = await supabase
      .from('prospects')
      .update({
        suppressed: true,
        suppressed_at: new Date().toISOString(),
        suppression_reason: 'client_rejected',
        client_review_status: 'rejected',
        client_review_reason: reason,
      })
      .eq('id', prospectId)
      .eq('organisation_id', orgId)
      .eq('outbound_upload_status', 'pending') // ← Race-safe: fail if already sending (uploading/uploaded)
      .select('id, sourced_tier, email, outbound_lead_id')

    if (rejectError) throw rejectError

    if (!rejected || rejected.length === 0) {
      return NextResponse.json(
        { error: 'This prospect is already sending; cannot reject' },
        { status: 409 }
      )
    }

    const prospect = rejected[0]

    // ── Carry the rejection out to the sending provider ────────────────────────
    //
    // The UPDATE above is guarded on outbound_upload_status = 'pending', so a prospect that
    // reaches here has not been uploaded and the provider holds nothing for them. This call
    // therefore resolves 'not_required' today, and that is the point of making it anyway:
    //
    //   1. It writes outbound_suppression_status, so the row STATES that the provider holds
    //      nothing rather than leaving NULL, which on a suppressed row means "something
    //      bypassed the shared path" and is a finding.
    //   2. If that pending guard is ever relaxed, this path is already correct. The two
    //      prospects that prompted this whole build were suppressed by a hand-written UPDATE
    //      precisely because this route refused them.
    //
    // A service-role client, because the suppression path reads integrations_registry and
    // writes columns the session client cannot reach. The session client above still owns
    // the auth gate and the organisation scoping, which is ADR-027's two-client pattern.
    const serviceClient = await createServiceRoleClient()
    const suppression = await suppressProspectAtProvider(serviceClient, {
      id: prospectId,
      organisation_id: orgId,
      email: prospect.email,
      outbound_lead_id: prospect.outbound_lead_id,
    })

    // Never fails the rejection. The client's decision is recorded and stands; a provider
    // that could not be reached is on the row, in Sentry, and in front of the sweep.
    if (suppression.status === 'failed') {
      logger.error('prospect reject: the provider was not told', {
        prospect_id: prospectId,
        organisation_id: orgId,
        error: suppression.error,
      })
    }

    logger.info('prospect reject: success', {
      user_id: user.id,
      organisation_id: orgId,
      prospect_id: prospectId,
      tier: prospect.sourced_tier,
    })

    return NextResponse.json({
      ok: true,
      prospect_id: prospectId,
      suppressed: true,
      tier: prospect.sourced_tier,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    logger.error('prospect reject: failed', {
      user_id: user.id,
      prospect_id: prospectId,
      error: errorMsg,
    })

    return NextResponse.json(
      { error: `Reject failed: ${errorMsg}` },
      { status: 500 }
    )
  }
}
