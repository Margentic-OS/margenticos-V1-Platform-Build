import type { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'
import { getClientProspectTiers } from '@/lib/prospect-tiers-data'
import { logger } from '@/lib/logger'

// resolveViewingOrg owns the whole authorisation question here, exactly as it does on the
// page this route mirrors: it honours ?client= for an operator and IGNORES it for a
// client, who stays pinned to their own organisation whatever the URL says. This route
// adds no rule of its own, deliberately, so the two cannot drift apart.
//
// It previously called getClientProspectTiers(supabase) and let that function resolve the
// organisation from users.organisation_id, which is the defect fixed on 2026-09-08.
export async function GET(request: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const clientParam = request.nextUrl.searchParams.get('client') ?? undefined
  const { organisationId } = await resolveViewingOrg(supabase, user, clientParam)

  if (!organisationId) {
    return Response.json({ error: 'Organisation not found for user' }, { status: 404 })
  }

  try {
    const tierDataArray = await getClientProspectTiers(organisationId)
    return Response.json({
      ok: true,
      tiers: tierDataArray,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger.error('prospect-tiers GET: failed', {
      user_id: user.id,
      organisation_id: organisationId,
      error: errorMsg,
    })
    return Response.json(
      { error: `Failed to fetch tiers: ${errorMsg}` },
      { status: 500 }
    )
  }
}
