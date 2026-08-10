import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

export async function POST(request: Request) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { prospect_id, reason } = await request.json()

    if (!prospect_id) {
      return Response.json({ error: 'Missing prospect_id' }, { status: 400 })
    }

    // Fetch user's organisation_id
    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('organisation_id')
      .eq('id', user.id)
      .single()

    if (userError || !userRow?.organisation_id) {
      return Response.json({ error: 'Organisation not found' }, { status: 404 })
    }

    // Verify the prospect belongs to this user's organisation
    const { data: prospect, error: prospectError } = await supabase
      .from('prospects')
      .select('id, outbound_upload_status')
      .eq('id', prospect_id)
      .eq('organisation_id', userRow.organisation_id)
      .single()

    if (prospectError || !prospect) {
      return Response.json({ error: 'Prospect not found' }, { status: 404 })
    }

    // Prevent rejection if already sending
    if (prospect.outbound_upload_status === 'uploaded' || prospect.outbound_upload_status === 'uploading') {
      return Response.json(
        { error: 'Cannot reject prospect that is already sending' },
        { status: 409 }
      )
    }

    // Update prospect with rejection
    const { error: updateError } = await supabase
      .from('prospects')
      .update({
        client_review_status: 'rejected',
        client_review_reason: reason || null,
      })
      .eq('id', prospect_id)
      .eq('organisation_id', userRow.organisation_id)

    if (updateError) {
      logger.error('reject prospect: update failed', {
        prospect_id,
        error: updateError.message,
      })
      throw updateError
    }

    logger.info('prospect rejected', {
      prospect_id,
      reason: reason || 'no reason provided',
    })

    return Response.json({ ok: true, prospect_id })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger.error('reject prospect: failed', { error: errorMsg })
    return Response.json(
      { error: `Failed to reject prospect: ${errorMsg}` },
      { status: 500 }
    )
  }
}
