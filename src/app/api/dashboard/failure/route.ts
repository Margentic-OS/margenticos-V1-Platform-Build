// POST /api/dashboard/failure
//
// The error boundary at src/app/dashboard/error.tsx calls this when a dashboard page
// failed to render. It is the only way a RENDER failure can reach the monitor board: the
// boundary runs in the browser, and the browser cannot write to the database.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CALLER IS A CLIENT, SO ALMOST NOTHING IT SENDS IS TRUSTED
//
// This route feeds MON-032. Anything a caller can put in a row here, it can put on the
// operator's monitor board, so the request body is deliberately nearly empty of authority:
//
//   kind             FORCED to 'render'. A caller cannot report a read failure, because a
//                    read failure is something only server code can observe.
//   source           FORCED to a constant. Not accepted from the body at all.
//   organisation_id  resolved SERVER-SIDE from the caller's own user row. Never read from
//                    the body, so a caller cannot attribute a failure to another
//                    organisation and cannot make another client's dashboard look broken.
//   route, digest    accepted, and they are the only two, both length-capped. A digest is
//                    the handle that ties this row to its Sentry event.
//
// Authentication is required. An unauthenticated caller cannot reach a dashboard page in
// the first place, so it cannot legitimately have a dashboard render failure to report,
// and letting one write here would make the board writable by anybody.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { recordDashboardFailure } from '@/lib/dashboard/record-dashboard-failure'

const ROUTE_MAX = 200
const DIGEST_MAX = 100

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  // The caller's organisation, from the database, not from the request.
  const { data: userRow } = await supabase
    .from('users')
    .select('organisation_id')
    .eq('id', user.id)
    .single()

  let body: { route?: unknown; digest?: unknown } = {}
  try {
    body = await request.json()
  } catch {
    // A boundary firing during a bad network moment may well fail to send a body. That is
    // not a reason to lose the report: the fact that it fired is the signal.
  }

  const route = typeof body.route === 'string' ? body.route.slice(0, ROUTE_MAX) : '/dashboard'
  const digest = typeof body.digest === 'string' ? body.digest.slice(0, DIGEST_MAX) : null

  await recordDashboardFailure({
    kind: 'render',
    source: 'dashboard-error-boundary',
    route,
    organisationId: userRow?.organisation_id ?? null,
    detail: 'A dashboard page threw and the error boundary rendered in its place.',
    digest,
  })

  return NextResponse.json({ recorded: true })
}
