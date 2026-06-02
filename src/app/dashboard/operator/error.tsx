'use client'

// Next.js operator-route error boundary — catches render errors within the operator layout.
// Shows a calm recovery message rather than a blank page.
// Mirrors src/app/dashboard/error.tsx; adjusted for operator context.

import { useEffect } from 'react'
import * as Sentry from '@sentry/nextjs'

interface ErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

export default function OperatorError({ error, reset }: ErrorProps) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <div className="min-h-screen bg-surface-shell flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="bg-surface-card border border-border-card rounded-[10px] p-6">
          <p className="text-text-primary text-sm font-medium mb-2">
            Something went wrong
          </p>
          <p className="text-text-secondary text-xs leading-relaxed mb-5">
            An unexpected error in the operator view. Your clients&apos; data is safe — this is a display issue only.
          </p>
          <div className="flex gap-3">
            <button
              onClick={reset}
              className="px-4 py-2 text-xs font-medium text-[#F5F0E8] bg-brand-green rounded-[20px] hover:opacity-90 transition-opacity"
            >
              Try again
            </button>
            <a
              href="/dashboard/operator"
              className="px-4 py-2 text-xs font-medium text-text-secondary border border-border-card rounded-[20px] hover:text-text-primary transition-colors"
            >
              Back to operator hub
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
