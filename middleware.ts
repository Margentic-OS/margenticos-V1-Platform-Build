// Supabase SSR middleware — required for session refresh and cookie propagation.
// Without this, supabase.auth.getUser() in Server Components receives stale/null
// sessions even immediately after a successful login.
//
// x-pathname is injected into requestHeaders (the forwarded request object) so
// layouts can read the current pathname via headers(). requestHeaders is passed to
// both NextResponse.next() calls (initial and inside setAll).
//
// view-as-client is injected directly into requestHeaders' Cookie header before
// creating the initial response. This is necessary because cookies() in server
// components reads from the Cookie header of the forwarded requestHeaders object.
// request.cookies.set() updates request.headers (a different object) and does NOT
// reach cookies() in the layout. response.cookies.set() reaches the browser only.
// Mutating requestHeaders.cookie before NextResponse.next() is the only path that
// makes the value visible to cookies() in the same request.

import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  const clientParam = request.nextUrl.searchParams.get('client')
  const pathname = request.nextUrl.pathname
  const isOperatorRoute = pathname.startsWith('/dashboard/operator')

  // Build modified request headers. These are forwarded to server components.
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-pathname', pathname)

  // Inject view-as-client into the Cookie header of requestHeaders so that
  // cookies() in layout server components sees it on the same request.
  // Done here, before NextResponse.next(), so both the initial response and any
  // setAll-triggered response (which also passes requestHeaders) forward it.
  if (clientParam && !isOperatorRoute) {
    const existing = requestHeaders.get('cookie') ?? ''
    const cleaned = existing.split('; ').filter(c => !c.startsWith('view-as-client=')).join('; ')
    requestHeaders.set('cookie', cleaned ? `${cleaned}; view-as-client=${clientParam}` : `view-as-client=${clientParam}`)
  } else if (isOperatorRoute || (pathname.startsWith('/dashboard') && !clientParam)) {
    const existing = requestHeaders.get('cookie')
    if (existing?.includes('view-as-client=')) {
      const cleaned = existing.split('; ').filter(c => !c.startsWith('view-as-client=')).join('; ')
      if (cleaned) requestHeaders.set('cookie', cleaned)
      else requestHeaders.delete('cookie')
    }
  }

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

  // Browser persistence: also set/clear the cookie on the response so the browser
  // carries it across navigations (complements the requestHeaders injection above).
  if (clientParam && !isOperatorRoute) {
    response.cookies.set('view-as-client', clientParam, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
    })
  } else if (isOperatorRoute || (pathname.startsWith('/dashboard') && !clientParam)) {
    response.cookies.delete('view-as-client')
  }

  return response
}

export const config = {
  matcher: [
    // Run on all routes except Next.js internals and static assets.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
