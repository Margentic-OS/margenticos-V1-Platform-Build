'use client'

// global-error.tsx replaces the root layout — no Tailwind/globals.css available.
// Uses inline styles only. Sentry.captureException captures React render errors that
// bypass the dashboard error boundary (e.g. errors in the root layout itself).

import * as Sentry from '@sentry/nextjs'
import { useEffect } from 'react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en">
      <body style={{ margin: 0, backgroundColor: '#1A1F2E', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1rem',
        }}>
          <div style={{
            background: '#242B3E',
            border: '1px solid #333D52',
            borderRadius: '10px',
            padding: '1.5rem',
            maxWidth: '360px',
            width: '100%',
          }}>
            <p style={{ color: '#F5F0E8', fontSize: '14px', fontWeight: 500, margin: '0 0 8px' }}>
              Something went wrong
            </p>
            <p style={{ color: '#8B96A8', fontSize: '12px', lineHeight: 1.6, margin: '0 0 20px' }}>
              An unexpected error occurred. Your data is safe — this is a display issue only.
            </p>
            <div style={{ display: 'flex', gap: '12px' }}>
              <button
                onClick={reset}
                style={{
                  padding: '8px 16px',
                  fontSize: '12px',
                  fontWeight: 500,
                  color: '#F5F0E8',
                  background: '#2D6A4F',
                  borderRadius: '20px',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                Try again
              </button>
              <a
                href="/dashboard"
                style={{
                  padding: '8px 16px',
                  fontSize: '12px',
                  fontWeight: 500,
                  color: '#8B96A8',
                  border: '1px solid #333D52',
                  borderRadius: '20px',
                  textDecoration: 'none',
                  display: 'inline-block',
                }}
              >
                Back to dashboard
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  )
}
