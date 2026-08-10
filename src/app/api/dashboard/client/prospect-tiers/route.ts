import { createClient } from '@/lib/supabase/server'
import { getClientProspectTiers } from '@/lib/prospect-tiers-data'
import { logger } from '@/lib/logger'

export async function GET() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const tierDataArray = await getClientProspectTiers(supabase)
    return Response.json({
      ok: true,
      tiers: tierDataArray,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger.error('prospect-tiers GET: failed', {
      user_id: user.id,
      error: errorMsg,
    })
    return Response.json(
      { error: `Failed to fetch tiers: ${errorMsg}` },
      { status: 500 }
    )
  }
}
