import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'

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
      .select('id, sourced_tier')

    if (rejectError) throw rejectError

    if (!rejected || rejected.length === 0) {
      return NextResponse.json(
        { error: 'This prospect is already sending; cannot reject' },
        { status: 409 }
      )
    }

    const prospect = rejected[0]

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
