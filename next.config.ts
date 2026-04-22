import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs'

const nextConfig: NextConfig = {
  // No external image domains configured yet — add when needed
}

export default withSentryConfig(nextConfig, {
  // Source map upload requires SENTRY_ORG + SENTRY_PROJECT in env.
  // Find both in Sentry dashboard → Settings → Projects → your project → General.
  // Add to .env.local as SENTRY_ORG and SENTRY_PROJECT.
  // Error tracking works without them; source maps and release tagging require them.
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Suppress Sentry build output noise
  silent: true,

  // Upload larger client-side files for better stack traces
  widenClientFileUpload: true,
})
