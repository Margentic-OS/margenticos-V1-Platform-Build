// Middleware runs on every request.
// It refreshes the Supabase session and enforces route protection.
//
// Route rules:
//   /login, /auth/*       — public (no auth required)
//   /operator/*           — authenticated + role must be 'operator'
//   everything else       — authenticated only
//
// Three-check rule (from CLAUDE.md and prd/sections/04-auth.md):
//   1. User is authenticated
//   2. Role is appropriate for the route
//   3. Organisation check is enforced at the data layer via RLS

import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { Database } from '@/types/database'

const PUBLIC_PATHS = ['/login', '/auth']

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Always call getUser() — this is required to refresh the session token.
  // Do not use getSession() here; it does not validate the JWT server-side.
  const { data: { user } } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  // Allow public routes through without any auth check
  if (PUBLIC_PATHS.some(path => pathname.startsWith(path))) {
    return supabaseResponse
  }

  // Redirect unauthenticated users to login
  if (!user) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    return NextResponse.redirect(loginUrl)
  }

  // Operator route protection — check role against the users table
  if (pathname.startsWith('/operator')) {
    const { data: userRecord } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single() as { data: { role: string } | null; error: unknown }

    if (!userRecord || userRecord.role !== 'operator') {
      const unauthorizedUrl = request.nextUrl.clone()
      unauthorizedUrl.pathname = '/login'
      return NextResponse.redirect(unauthorizedUrl)
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    // Run on all routes except Next.js internals and static assets
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
