import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A fingerprint of patches/, mixed into webpack's cache version below.
 *
 * WHY (2026-09-12). webpack's filesystem cache treats node_modules as managed paths and
 * validates them by PACKAGE VERSION, not by file contents. patch-package rewrites files
 * inside a package whose version never changes, so a restored cache can hand back the
 * pre-patch compiled module. That is exactly what shipped on 2026-09-11: the patch was
 * applied at install, the install-time check passed, and the deployed bundle had no retry
 * in it. Changing the cache version whenever a patch changes makes that impossible.
 */
function patchesFingerprint(): string {
  const dir = join(process.cwd(), 'patches')
  try {
    const files = readdirSync(dir).filter(name => name.endsWith('.patch')).sort()
    if (files.length === 0) return 'none'
    const hash = createHash('sha256')
    for (const name of files) {
      hash.update(name)
      hash.update(readFileSync(join(dir, name)))
    }
    return hash.digest('hex').slice(0, 16)
  } catch {
    // No patches directory is a legitimate state, and must not fail the build.
    return 'none'
  }
}

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
  // Any change to patches/ changes the cache version, so webpack recompiles the patched
  // package instead of reusing what it compiled before the patch existed. See
  // patchesFingerprint above and scripts/check-patch-in-build.ts, which checks the output.
  webpack(config) {
    if (config.cache && typeof config.cache === 'object') {
      const cache = config.cache as { version?: string }
      cache.version = [cache.version, `patches-${patchesFingerprint()}`].filter(Boolean).join('|')
    }
    return config
  },
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
