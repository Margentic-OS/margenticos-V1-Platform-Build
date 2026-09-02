import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type { Database } from '@/types/database'
import { excludeTierRejected } from '@/lib/sourcing/tier-verdict'
// Its own module, not a const here: a Next.js route may only export the handler names and
// a fixed set of config fields, and `npm run build` refuses anything else. tsc and the
// whole test suite accepted it as a route export. See client-review-status.ts.
import { UNREVIEWED_FILTER } from '@/lib/sourcing/client-review-status'

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
    // THE UNREVIEWED FILTER. This was `.in('client_review_status', [null, 'pending_review'])`,
    // which selected NOTHING. SQL IN never matches NULL, and NULL is where an unreviewed
    // prospect actually sits: the column has no default, so nothing writes 'pending_review'
    // on the way in. Measured before the fix on the live organisation: 100 rows at NULL, 0 at
    // 'pending_review', and the route matched 0 of them. It returned ok:true every time,
    // because an UPDATE matching zero rows is not an error. Approve-all was a no-op that
    // reported success, which is the same shape as the opt-out footer that was validated and
    // then discarded.
    //
    // 'pending_review' is kept in the filter rather than dropped. It is a legitimate stored
    // value the review UI can write, and a row sitting at it is unreviewed by any reading.
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
      .or(UNREVIEWED_FILTER))

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
