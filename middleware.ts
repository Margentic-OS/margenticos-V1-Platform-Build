// Supabase SSR middleware — required for session refresh, cookie propagation, and auth redirects.
// Without this, supabase.auth.getUser() in Server Components receives stale/null
// sessions even immediately after a successful login.

import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request })

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
    // Auth check failed — return 401 for API, redirect for pages
    if (request.nextUrl.pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (request.nextUrl.pathname.startsWith('/dashboard/')) {
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search)
      return NextResponse.redirect(loginUrl)
    }
  }

  // Handle unauthenticated requests
  if (!user) {
    // For API routes: return 401 JSON
    if (request.nextUrl.pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

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
    // Run on all routes except Next.js internals and static assets.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
