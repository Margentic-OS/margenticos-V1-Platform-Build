import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs'

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Content-Security-Policy-Report-Only',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://js.sentry-cdn.com",
      "connect-src 'self' https://*.supabase.co https://sentry.io wss://*.supabase.co",
      "img-src 'self' data: https:",
      "frame-ancestors 'none'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
    ].join('; '),
  },
]

const nextConfig: NextConfig = {
  // pdf-parse reads a test file at require() time that trips up Next.js bundling.
  // Marking it external tells Turbopack to leave it to Node.js at runtime.
  serverExternalPackages: ['pdf-parse'],
  // Agents load system prompts via fs.readFile with a constructed path (process.cwd() +
  // 'docs/prompts/...'). Vercel's static file tracer cannot follow dynamic paths, so the
  // prompt files are absent from /var/task at runtime without this explicit inclusion.
  outputFileTracingIncludes: {
    '/api/**': ['./docs/prompts/**'],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ]
  },
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
