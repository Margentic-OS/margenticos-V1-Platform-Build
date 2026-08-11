import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import type { Database } from '@/types/database'

export async function POST(request: Request) {
  // Use anon client for auth verification only
  const anonClient = await createClient()

  const { data: { user } } = await anonClient.auth.getUser()
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { prospect_id, reason } = await request.json()

    if (!prospect_id) {
      return Response.json({ error: 'Missing prospect_id' }, { status: 400 })
    }

    console.log('[REJECT-API] prospect_id received:', prospect_id)

    // Use service role client for database operations (bypasses RLS)
    const serviceClient = createServiceClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    // Fetch user's organisation_id
    const { data: userRow, error: userError } = await serviceClient
      .from('users')
      .select('organisation_id')
      .eq('id', user.id)
      .single()

    console.log('[REJECT-API] userRow:', userRow, 'error:', userError?.message)

    if (userError || !userRow?.organisation_id) {
      return Response.json({ error: 'Organisation not found' }, { status: 404 })
    }

    const org_id = userRow.organisation_id
    console.log('[REJECT-API] Looking up prospect id=%s in org_id=%s', prospect_id, org_id)

    // Verify the prospect belongs to this user's organisation
    const { data: prospect, error: prospectError } = await serviceClient
      .from('prospects')
      .select('id, organisation_id, outbound_upload_status')
      .eq('id', prospect_id)
      .eq('organisation_id', org_id)
      .single()

    console.log('[REJECT-API] prospect lookup result:', {
      found: !!prospect,
      prospect_id_match: prospect?.id === prospect_id,
      org_match: prospect?.organisation_id === org_id,
      prospect,
      error: prospectError?.message,
    })

    if (prospectError || !prospect) {
      console.log('[REJECT-API] Prospect lookup failed:', prospectError?.message)
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
    const { error: updateError } = await serviceClient
      .from('prospects')
      .update({
        client_review_status: 'rejected',
        client_review_reason: reason || null,
      })
      .eq('id', prospect_id)
      .eq('organisation_id', org_id)

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
