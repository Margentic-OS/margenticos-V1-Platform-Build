// Supabase SSR middleware — required for session refresh and cookie propagation.
// Without this, supabase.auth.getUser() in Server Components receives stale/null
// sessions even immediately after a successful login.
//
// Also injects x-pathname and x-view-as-client into the forwarded REQUEST headers
// so that server components can read them via headers(). Response headers set via
// response.headers.set() go to the browser only — they are not visible to server
// components via headers(). The requestHeaders object is passed to both
// NextResponse.next() calls (initial and inside setAll) to survive cookie refresh.

import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  // Build modified request headers before creating the Supabase client.
  // These are forwarded to server components via headers() — response headers are not.
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-pathname', request.nextUrl.pathname)
  requestHeaders.set('x-view-as-client', new URL(request.url).searchParams.get('client') ?? 'none')

  let response = NextResponse.next({
    request: { headers: requestHeaders },
  })

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
          // browser in the same round-trip. Pass requestHeaders to preserve the
          // custom headers through the cookie-refresh path.
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          response = NextResponse.next({
            request: { headers: requestHeaders },
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Refresh the session. Must be called before any conditional logic that reads
  // the user — do not move this call or add logic before it.
  await supabase.auth.getUser()

  // DIAGNOSTIC — remove after view-as-client header investigation
  console.log(
    '[MW] x-view-as-client injecting:',
    requestHeaders.get('x-view-as-client'),
    '| pathname:', request.nextUrl.pathname,
    '| searchParams:', request.nextUrl.searchParams.toString(),
  )

  return response
}

export const config = {
  matcher: [
    // Run on all routes except Next.js internals and static assets.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
