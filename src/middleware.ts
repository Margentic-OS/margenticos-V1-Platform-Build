import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Inject the current pathname as a request header so server-side layouts
// can read it via headers(). Next.js App Router does not expose the current
// URL to server components directly — this is the standard workaround.
export function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-pathname', request.nextUrl.pathname)

  return NextResponse.next({
    request: { headers: requestHeaders },
  })
}

export const config = {
  matcher: [
    // Apply to all dashboard routes only — no need to run on API, static, or auth routes.
    '/dashboard/:path*',
  ],
}
