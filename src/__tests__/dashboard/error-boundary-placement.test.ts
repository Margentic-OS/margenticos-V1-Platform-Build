// WHERE the boundary is IS the fix, so that is what this file asserts.
//
// (client)/error.tsx already existed and did not catch a throw from (client)/layout.tsx.
// In the App Router a segment's error boundary is rendered INSIDE that segment's layout:
// create-component-tree.js builds LayoutRouter({ error: ErrorComponent, ... }) and passes
// it as the children prop into the layout component. So the layout's own render sits
// outside its own boundary, and the code that builds the sidebar had nothing between it
// and app/global-error.tsx, which replaces the root <html>.
//
// A test that renders the component and checks it says "did not load" would pass from any
// directory in the repo. The only property that matters is the path, so the path is what
// is pinned. Move this file into (client)/ and the bug is back with every render test
// still green.

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const APP = join(process.cwd(), 'src', 'app')

describe('dashboard error boundary placement', () => {
  it('has an error boundary at dashboard/, outside the (client) route group', () => {
    expect(
      existsSync(join(APP, 'dashboard', 'error.tsx')),
      'src/app/dashboard/error.tsx is missing. Without it a throw in (client)/layout.tsx ' +
      'has no boundary before app/global-error.tsx, which replaces the root <html> and ' +
      'is the path that produces a blank document on an HTTP 200.',
    ).toBe(true)
  })

  it('finds the boundary it is meant to be complementing, so it cannot pass vacuously', () => {
    // Guard the guard. If the (client) boundary were ever removed, the reasoning above
    // changes and this file should be re-read rather than quietly still passing.
    expect(existsSync(join(APP, 'dashboard', '(client)', 'error.tsx'))).toBe(true)
  })

  it('keeps dashboard/layout.tsx a passthrough, which is what puts the boundary outside', () => {
    // The boundary at dashboard/ is only OUTSIDE (client)/layout.tsx because
    // dashboard/layout.tsx renders its children and nothing else. If that layout ever
    // starts fetching, it acquires the same uncovered-layout problem one level up and
    // this whole arrangement needs rethinking rather than patching.
    const layout = readFileSync(join(APP, 'dashboard', 'layout.tsx'), 'utf8')
    expect(layout).not.toMatch(/createClient|await\s+supabase|\.from\(/)
  })

  it('reports to Sentry AND writes a row, because Sentry alone is a channel nobody reads', () => {
    const boundary = readFileSync(join(APP, 'dashboard', 'error.tsx'), 'utf8')
    expect(boundary, 'boundary does not capture to Sentry').toMatch(/Sentry\.captureException/)
    expect(
      boundary,
      'boundary does not POST to /api/dashboard/failure, so a render failure never ' +
      'reaches MON-032 and the monitor board stays green through an outage',
    ).toMatch(/\/api\/dashboard\/failure/)
  })

  it('carries no em dash, en dash or double hyphen in client-facing copy', () => {
    const boundary = readFileSync(join(APP, 'dashboard', 'error.tsx'), 'utf8')
    expect(boundary).not.toMatch(/[—–]|--/)
  })
})
