'use client'

// THE BOUNDARY THAT SITS OUTSIDE THE CLIENT LAYOUT.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE IS AT dashboard/ AND NOT INSIDE (client)/
//
// (client)/error.tsx already existed and it does NOT catch a throw from
// (client)/layout.tsx. In the App Router a segment's error boundary is rendered INSIDE
// that segment's layout, so the layout's own render sits outside its own boundary.
// Verified against the installed Next 16.2.7 source rather than from memory:
// create-component-tree.js builds LayoutRouter({ error: ErrorComponent, ... }), and that
// element is then passed as the children prop INTO the segment's layout component.
//
//   (client)/layout.tsx            <- sidebar, navigation, the frame.  NOT protected there.
//     └─ LayoutRouter error={(client)/error.tsx}
//          └─ (client)/page.tsx    <- protected
//
// So a throw while building the sidebar had no boundary between it and
// app/global-error.tsx, which replaces the root <html>. Swapping the root element after
// the shell has flushed is the one recovery React cannot reliably perform, and a failed
// recovery is a blank document on an HTTP 200 that nothing logs as an error.
//
// This file is that missing boundary. dashboard/layout.tsx is a bare passthrough, so this
// boundary is rendered outside (client)/layout.tsx and catches what it throws, one level
// below global-error and without touching the root html element.
//
// IT DELIBERATELY CANNOT SHOW THE SIDEBAR. If the layout that builds the sidebar threw,
// there is no sidebar to preserve. Keeping the frame on every path is the job of the
// layout not throwing in the first place, which is a separate change to that file. This
// is the floor underneath it: whatever else happens, the client gets a page with words on
// it and a way forward, never a white screen.

import { useEffect } from 'react'
import * as Sentry from '@sentry/nextjs'

interface ErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

export default function DashboardBoundaryError({ error, reset }: ErrorProps) {
  useEffect(() => {
    Sentry.captureException(error)

    // Also write a row, because Sentry is a channel somebody has to go and look at and
    // this needs to reach the monitor board that is read every day. keepalive so the
    // report survives the user navigating away from a page that just broke.
    void fetch('/api/dashboard/failure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        route: typeof window !== 'undefined' ? window.location.pathname : '/dashboard',
        digest: error.digest ?? null,
      }),
    }).catch(() => {
      // Reporting failed. Sentry still has it. Never let the reporter break the recovery
      // screen: this component is the last thing standing between the client and a blank
      // page.
    })
  }, [error])

  return (
    <div className="min-h-screen bg-surface-shell flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="bg-surface-card border border-border-card rounded-[10px] p-6">
          <p className="text-text-primary text-sm font-medium mb-2">
            This page did not load
          </p>
          <p className="text-text-secondary text-xs leading-relaxed mb-5">
            Something went wrong on our side, not yours. Your data is safe and nothing has
            been lost. Try again, and if it keeps happening we have already been told.
          </p>
          <div className="flex gap-3">
            <button
              onClick={reset}
              className="px-4 py-2 text-xs font-medium text-[#F5F0E8] bg-brand-green rounded-[20px] hover:opacity-90 transition-opacity"
            >
              Try again
            </button>
            <a
              href="/dashboard"
              className="px-4 py-2 text-xs font-medium text-text-secondary border border-border-card rounded-[20px] hover:text-text-primary transition-colors"
            >
              Back to dashboard
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
