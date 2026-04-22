import * as Sentry from '@sentry/nextjs'
import type { Instrumentation } from 'next'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config')
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config')
  }
}

// Required for Next.js 15+ App Router — without this, errors caught by Next.js
// internally (API routes, server components) are never forwarded to Sentry.
export const onRequestError: Instrumentation.onRequestError = (...args) => {
  return Sentry.captureRequestError(...args)
}
