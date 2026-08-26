// What the middleware is allowed to touch.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS TEST EXISTS
//
// The middleware sat at the repo root and was never compiled, because Next resolves
// middleware relative to the parent of the app directory and this project uses src/app.
// Moving it to src/middleware.ts switches it on for the first time, and switching on dead
// middleware is a behaviour change on every request it matches.
//
// The original matcher matched everything except static assets, including all 12
// /api/cron/* routes. Those authenticate with `Authorization: Bearer CRON_SECRET` and have
// no Supabase user session, so the middleware's `if (!user) return 401` would have fired
// before the route ran. Enabling it as written would have stopped every scheduled job on
// the platform.
//
// The matcher is therefore load-bearing, it is one regex, and a plausible-looking edit to
// it is an outage. This test reads the REAL config from the real module and pins it.

import { describe, it, expect } from 'vitest'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../middleware'

/** Compile the matcher the way Next does: anchored, one entry per matcher string. */
function matches(pathname: string): boolean {
  return (config.matcher as string[]).some(m => new RegExp(`^${m}$`).test(pathname))
}

/** Every cron route that exists on disk, as a request path. */
function cronRoutePaths(): string[] {
  const dir = join(process.cwd(), 'src', 'app', 'api', 'cron')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => `/api/cron/${d.name}`)
}

describe('middleware scope: machine-authenticated routes must never be matched', () => {
  it('finds the cron routes on disk, so this test cannot pass vacuously', () => {
    const paths = cronRoutePaths()
    expect(paths.length, 'no cron routes found; the test would prove nothing').toBeGreaterThan(5)
  })

  it('does not match ANY /api/cron route', () => {
    for (const p of cronRoutePaths()) {
      expect(
        matches(p),
        `${p} authenticates by CRON_SECRET and has no user session. If the middleware runs ` +
        `on it, it returns 401 before the route does anything, and that job stops.`,
      ).toBe(false)
    }
  })

  it('does not match webhook routes, which authenticate by signature', () => {
    for (const p of ['/api/webhooks/calendly', '/api/webhooks/users-pending-review-notify']) {
      expect(matches(p), `${p} would 401`).toBe(false)
    }
  })

  it('does not match ANY /api path at all', () => {
    for (const p of [
      '/api/version',
      '/api/operator/verify-enriched',
      '/api/monitor-data',
      '/api/anything/at/all',
    ]) {
      expect(matches(p), `${p} should be left to its own per-route auth`).toBe(false)
    }
  })
})

describe('middleware scope: pages ARE matched, which is the point of the file', () => {
  it('matches dashboard pages, where Server Components need a fresh session', () => {
    for (const p of ['/dashboard', '/dashboard/operator/monitor', '/dashboard/replies']) {
      expect(matches(p), `${p} should get session refresh`).toBe(true)
    }
  })

  it('matches the root and login pages', () => {
    expect(matches('/')).toBe(true)
    expect(matches('/login')).toBe(true)
  })

  it('does not match Next internals or static assets', () => {
    for (const p of [
      '/_next/static/chunks/main.js',
      '/_next/image',
      '/favicon.ico',
      '/logo.svg',
      '/photo.png',
    ]) {
      expect(matches(p), `${p} should be skipped`).toBe(false)
    }
  })
})

describe('middleware scope: the in-function guard backs up the matcher', () => {
  it('the module still carries an explicit /api early return', async () => {
    // Belt and braces in the safe direction: widening the matcher alone must not be enough
    // to 401 the crons. Anyone enabling middleware on /api has to remove this too.
    const src = await import('node:fs').then(fs =>
      fs.readFileSync(join(process.cwd(), 'src', 'middleware.ts'), 'utf8'),
    )
    expect(src).toContain("request.nextUrl.pathname.startsWith('/api/')")
  })
})
