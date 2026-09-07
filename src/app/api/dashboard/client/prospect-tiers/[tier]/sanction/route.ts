import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { createServiceRoleClient } from '@/lib/supabase/service-role'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tier: string }> }
) {
  const { tier } = await params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Validate tier
  if (!['tier_1', 'tier_2', 'tier_3'].includes(tier)) {
    return NextResponse.json({ error: 'Invalid tier' }, { status: 400 })
  }

  try {
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

    // Check if tier is locked: any prospect reached 'uploaded' (durable) or is 'uploading' (in flight).
    // Use both checks: 'uploaded' survives reclaim, 'uploading' catches in-flight sends.
    // This prevents tier unlock via stale-lock reclaim once sending has genuinely started.
    // THE LOCK READ USES A SERVICE CLIENT AND THE UPDATE BELOW DOES NOT, DELIBERATELY.
    //
    // prospects carries two policies that disagree: clients_read_own_prospects_denied is
    // USING (false) for SELECT, while clients_update_own_prospect_review permits UPDATE on
    // the client's own organisation. So a client session cannot read this table but can
    // write it.
    //
    // Through the session client this SELECT returned [] for every real client, with no
    // error, because an RLS denial is not an error. The 409 below could therefore never
    // fire, and the UPDATE that follows it succeeded, because UPDATE is the one thing the
    // policy allows. A client could sanction or unsanction a tier whose prospects were
    // already uploaded or in flight: 95 of them on the live organisation.
    //
    // A guard that reads zero rows and concludes "safe" is the shape CLAUDE.md keeps
    // returning to. The read is now service-role so the guard can see what it is guarding.
    const prospectReader = await createServiceRoleClient()

    const { data: lockedData, error: lockedError } = await prospectReader
      .from('prospects')
      .select('id')
      .eq('organisation_id', orgId)
      .eq('sourced_tier', tier)
      .or('outbound_upload_status.eq.uploaded,outbound_upload_status.eq.uploading')
      .limit(1)

    if (lockedError) throw lockedError
    if ((lockedData ?? []).length > 0) {
      return NextResponse.json(
        { error: 'This tier is locked because sending has started' },
        { status: 409 }
      )
    }

    // Sanction: update pending prospects to approved
    const { data: sanctioned, error: sanctionError } = await supabase
      .from('prospects')
      .update({ sourcing_review_status: 'approved' })
      .eq('organisation_id', orgId)
      .eq('sourced_tier', tier)
      .in('sourcing_review_status', [null, 'pending_review'])
      .eq('suppressed', false)
      .select('id')

    if (sanctionError) throw sanctionError

    const sanctionedCount = (sanctioned ?? []).length

    logger.info('prospect-tier sanction: success', {
      user_id: user.id,
      organisation_id: orgId,
      tier,
      sanctioned_count: sanctionedCount,
    })

    return NextResponse.json({
      ok: true,
      sanctioned_count: sanctionedCount,
      tier,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    logger.error('prospect-tier sanction: failed', {
      user_id: user.id,
      tier,
      error: errorMsg,
    })

    return NextResponse.json(
      { error: `Sanction failed: ${errorMsg}` },
      { status: 500 }
    )
  }
}
