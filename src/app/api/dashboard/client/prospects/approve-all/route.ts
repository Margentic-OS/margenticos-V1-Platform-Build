import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type { Database } from '@/types/database'
import { excludeTierRejected } from '@/lib/sourcing/tier-verdict'

export async function POST(request: Request) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { removed_prospect_ids } = await request.json()

    // Fetch user's organisation_id
    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('organisation_id')
      .eq('id', user.id)
      .single()

    if (userError || !userRow?.organisation_id) {
      return Response.json({ error: 'Organisation not found' }, { status: 404 })
    }

    const organisationId = userRow.organisation_id
    const removedIds = removed_prospect_ids || []

    // Create admin client to handle updates
    const adminClient = createServiceClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // Build update query with proper filters.
    //
    // THE TIER GATE. This route is a send-path consumer even though it sends nothing: it is
    // what moves a prospect to 'approved', which is one of the seven conditions the send gate
    // checks. Approving a prospect tiering rejected walks it right up to that gate and leaves
    // a single clause standing between it and Instantly.
    //
    // excludeTierRejected, not requireTierPresent, matching every other upstream consumer: a
    // prospect tiering has not reached yet is a normal prospect awaiting a verdict, and the
    // send gate refuses it on its own until one exists.
    let query = excludeTierRejected(adminClient
      .from('prospects')
      .update({
        client_review_status: 'approved',
        client_review_auto_approved_at: new Date().toISOString(),
      })
      .eq('organisation_id', organisationId)
      .in('client_review_status', [null, 'pending_review']))

    // Exclude removed prospects
    if (removedIds.length > 0) {
      query = query.filter('id', 'not.in', `(${removedIds.join(',')})`)
    }

    const { error: updateError } = await query

    if (updateError) {
      logger.error('approve all: update failed', {
        organisation_id: organisationId,
        error: updateError.message,
      })
      throw updateError
    }

    logger.info('approved all remaining prospects', {
      organisation_id: organisationId,
      removed_count: removedIds.length,
    })

    return Response.json({ ok: true })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger.error('approve all: failed', { error: errorMsg })
    return Response.json(
      { error: `Failed to approve prospects: ${errorMsg}` },
      { status: 500 }
    )
  }
}
