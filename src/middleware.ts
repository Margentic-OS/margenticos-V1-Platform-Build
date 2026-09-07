// Supabase SSR middleware — session refresh and cookie propagation for Server Components.
// Without this, supabase.auth.getUser() in Server Components receives stale/null
// sessions even immediately after a successful login.
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS FILE LIVES IN src/ AND MUST STAY THERE. IT WAS AT THE REPO ROOT AND DEAD.
//
// Next.js resolves middleware relative to the PARENT OF THE APP DIRECTORY. This project
// uses src/app, so the only path Next scans is src/middleware.ts. A file at the repo root
// is never found and never compiled. Moved 2026-08-26.
//
// It failed silently and, worse, it looked like it worked, because DEV AND PRODUCTION
// DISAGREED. Measured before the move, on Next 16.2.7:
//
//   .next/server/middleware-manifest.json      -> middleware {}, sortedMiddleware []
//   .next/dev/server/middleware-manifest.json  -> middleware { "/" }, matcher compiled
//
// Turbopack's dev build picked up the root file; the production build did not. So local
// testing showed a working middleware and production had none at all.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY /api IS EXCLUDED, AND WHY THAT IS NOT A WEAKENING
//
// Turning on dead middleware is a behaviour change on every request it matches, and the
// original matcher matched everything except static assets. Verified against the real route
// list: it would have matched all 12 /api/cron/* routes and the webhook routes.
//
// Those authenticate with `Authorization: Bearer CRON_SECRET` or a webhook signature. They
// have NO Supabase user session, so supabase.auth.getUser() returns null and the block
// below would have returned 401 BEFORE the route ever ran. That is every scheduled job on
// the platform: queue-worker every minute, verify-pending, verify-catch-all, monitor-sweep,
// auto-approve, process-replies, instantly-poll, reap-agent-runs and the rest. Enabling the
// middleware as written would have been a platform-wide outage of all automation, presented
// as a one-line file move.
//
// Excluding /api is also the conservative choice rather than a relaxation: production has
// NEVER had middleware on /api, because it has never had middleware at all. Excluding it
// preserves today's behaviour exactly for all 66 API routes, which are protected by their
// own per-route checks (auth.getUser, requireOperator, or CRON_SECRET), and adds only the
// session refresh for pages, which is what this file was written for.

import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request })

  // BELT AND BRACES WITH THE MATCHER, IN THE SAFE DIRECTION.
  //
  // The matcher below already excludes /api. This guard means that widening the matcher
  // cannot silently 401 the crons and webhooks: anyone who wants middleware on /api has to
  // delete this line too, which is a conscious decision rather than a regex edit.
  if (request.nextUrl.pathname.startsWith('/api/')) return response

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          // Forward cookies onto both the forwarded request and the response so
          // that updated tokens are visible to Server Components and sent to the
          // browser in the same round-trip.
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Refresh the session. Must be called before any conditional logic that reads
  // the user — do not move this call or add logic before it.
  let user = null
  try {
    const { data: authData } = await supabase.auth.getUser()
    user = authData.user
  } catch (err) {
    // Auth check failed. Only pages reach here: /api returned above.
    if (request.nextUrl.pathname.startsWith('/dashboard/')) {
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search)
      return NextResponse.redirect(loginUrl)
    }
  }

  // ── Bare /dashboard is not a client route for an operator ──────────────────
  //
  // resolveViewingOrg falls back to the caller's OWN organisation_id when there is no
  // ?client= parameter. For an operator that is doug@margenticos.com's own row, which
  // points at "ARCHIVE 2026-04 do not use", archived 2026-08-05. So bare /dashboard
  // rendered an archived organisation's data dressed as a client dashboard, and was
  // useless as a check of the real client path because the data was never a client's.
  //
  // ONE BEHAVIOUR, NOT A HEURISTIC. An operator asking for /dashboard with no client
  // named is asking for their own home, and their home is /dashboard/operator. The
  // alternative considered and rejected was resolving to the most recently active
  // non-archived organisation: that guesses, and a guess about whose data an operator is
  // looking at is exactly the wrong thing to be clever about.
  //
  // Nothing legitimate breaks. "View as client" always carries ?client=, so every real
  // operator view of a client keeps working; this only catches the bare URL, which had no
  // correct meaning before.
  //
  // Here rather than in the page because the page is (client)/page.tsx, and a redirect in
  // the middleware happens before any of that page's reads are issued.
  if (user && request.nextUrl.pathname === '/dashboard' && !request.nextUrl.searchParams.has('client')) {
    const { data: userRow } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()

    if (userRow?.role === 'operator') {
      return NextResponse.redirect(new URL('/dashboard/operator', request.url))
    }
  }

  // Handle unauthenticated requests. Only pages reach here: /api returned above.
  if (!user) {
    // For pages under /dashboard: redirect to login with returnTo
    if (request.nextUrl.pathname.startsWith('/dashboard/')) {
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search)
      return NextResponse.redirect(loginUrl)
    }
  }

  return response
}

export const config = {
  matcher: [
    // Pages only. Excludes Next.js internals, static assets, and ALL of /api.
    //
    // The `api|` term is the load-bearing addition. See the header: without it this
    // middleware 401s every cron and webhook, because those authenticate by shared secret
    // or signature and carry no user session. middleware-scope.test.ts asserts it.
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
