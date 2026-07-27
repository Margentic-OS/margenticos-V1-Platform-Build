import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'

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

    // Check if tier is locked: any prospect reached 'uploaded' (durable) or is 'uploading' (in flight).
    // Use both checks: 'uploaded' survives reclaim, 'uploading' catches in-flight sends.
    // This prevents tier unlock via stale-lock reclaim once sending has genuinely started.
    const { data: lockedData, error: lockedError } = await supabase
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
      .update({ client_review_status: 'approved' })
      .eq('organisation_id', orgId)
      .eq('sourced_tier', tier)
      .in('client_review_status', [null, 'pending_review'])
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
