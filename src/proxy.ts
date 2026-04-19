import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { Database } from '@/types/database'

const PUBLIC_PATHS = ['/login', '/auth']

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Inject x-pathname into request headers so server-side layouts can read it
  // via headers(). Next.js App Router does not expose the URL to server
  // components directly — this is the standard workaround.
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-pathname', pathname)

  // Build the response using the enriched request so session cookies are
  // written back to the browser on every request.
  let supabaseResponse = NextResponse.next({
    request: { headers: requestHeaders },
  })

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
          // Recreate supabaseResponse with the enriched headers so x-pathname
          // is preserved when the Supabase client refreshes session cookies.
          supabaseResponse = NextResponse.next({ request: { headers: requestHeaders } })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Always call getUser() to refresh the session token.
  // Never use getSession() here — it does not validate the JWT server-side.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Allow public routes through without any auth check.
  // (The matcher already limits us to /dashboard/* so these won't match in
  // practice, but kept as an explicit guard in case the matcher ever widens.)
  if (PUBLIC_PATHS.some(path => pathname.startsWith(path))) {
    return supabaseResponse
  }

  // Redirect unauthenticated users to login.
  if (!user) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    return NextResponse.redirect(loginUrl)
  }

  // Operator route protection — role must be 'operator' to access /dashboard/operator/*.
  // Bug fix from original proxy.ts: was checking startsWith('/operator'), which never
  // matched any real route. The actual operator routes are under /dashboard/operator/.
  if (pathname.startsWith('/dashboard/operator')) {
    const { data: userRecord } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single() as { data: { role: string } | null; error: unknown }

    if (!userRecord || userRecord.role !== 'operator') {
      const dashboardUrl = request.nextUrl.clone()
      dashboardUrl.pathname = '/dashboard'
      return NextResponse.redirect(dashboardUrl)
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    // Apply to all dashboard routes only — no need to run on API, static, or auth routes.
    '/dashboard/:path*',
  ],
}
