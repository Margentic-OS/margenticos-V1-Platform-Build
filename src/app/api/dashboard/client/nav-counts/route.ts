// Prospect nav counts for the organisation actually being viewed.
//
// WHY THIS ROUTE EXISTS. A Next.js App Router layout receives `params` but never
// `searchParams`, so (client)/layout.tsx cannot see `?client=` and cannot honour an
// operator's "View as client". It resolved the organisation from users.organisation_id
// instead, which meant the sidebar counted one organisation while the page rendered
// another. Measured: doug@margenticos.com resolves to "MargenticOS (archived April 2026)"
// with 0 on the roster, while the page rendered "MargenticOS" with 103.
//
// The layout still server-renders the counts for the common case, which is correct for
// every real client because resolveViewingOrg pins a client to their own organisation
// regardless of the URL. This route serves the operator-preview case, using the SAME
// resolver the page uses, so the two cannot disagree.

import { createClient } from '@/lib/supabase/server'
import { createServiceRoleClient } from '@/lib/supabase/service-role'
import { resolveViewingOrg } from '@/lib/dashboard/resolve-viewing-org'
import { getProspectNavCounts, EMPTY_NAV_COUNTS } from '@/lib/dashboard/prospect-nav-counts'
import { NextResponse, type NextRequest } from 'next/server'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // resolveViewingOrg owns the whole authorisation question here: it honours ?client=
  // ONLY for role = 'operator', and pins a client to their own organisation whatever the
  // URL says. This route adds no rule of its own, deliberately, so there is one place
  // where "which org may this user see" is decided.
  const clientParam = request.nextUrl.searchParams.get('client') ?? undefined
  const { organisationId } = await resolveViewingOrg(supabase, user, clientParam)

  if (!organisationId) {
    return NextResponse.json(EMPTY_NAV_COUNTS)
  }

  try {
    const serviceClient = await createServiceRoleClient()
    const counts = await getProspectNavCounts(serviceClient, organisationId)
    return NextResponse.json(counts)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('nav-counts: failed to read prospect counts', {
      organisation_id: organisationId,
      error: message,
    })
    // Zeros hide the nav entry rather than showing a wrong number. The layout's
    // server-rendered counts remain in place on the client side, so a failure here
    // degrades to "no correction applied" rather than to an empty sidebar.
    return NextResponse.json(EMPTY_NAV_COUNTS, { status: 200 })
  }
}
