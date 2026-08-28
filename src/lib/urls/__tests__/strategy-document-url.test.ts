import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { strategyDocumentUrl, isStrategyDocumentType } from '../strategy-document-url'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Every document notification linked to /dashboard/documents, which 404s. The route it
// should have used is /dashboard/strategy/[type]. These tests pin the shape of the link and,
// more usefully, check the route it points at actually exists on disk, because a URL that
// compiles is not a fix.

const ORIGINAL = process.env.NEXT_PUBLIC_APP_URL

beforeEach(() => { process.env.NEXT_PUBLIC_APP_URL = 'https://app.margenticos.com' })
afterEach(() => { process.env.NEXT_PUBLIC_APP_URL = ORIGINAL })

describe('strategyDocumentUrl', () => {
  it('deep links to the specific document type', () => {
    expect(strategyDocumentUrl('icp')).toBe('https://app.margenticos.com/dashboard/strategy/icp')
    expect(strategyDocumentUrl('positioning')).toBe('https://app.margenticos.com/dashboard/strategy/positioning')
    expect(strategyDocumentUrl('tov')).toBe('https://app.margenticos.com/dashboard/strategy/tov')
    expect(strategyDocumentUrl('messaging')).toBe('https://app.margenticos.com/dashboard/strategy/messaging')
  })

  it('never points at the route that does not exist', () => {
    for (const type of ['icp', 'positioning', 'tov', 'messaging']) {
      expect(strategyDocumentUrl(type)).not.toContain('/dashboard/documents')
    }
  })

  it('carries ?client= for an operator recipient', () => {
    expect(strategyDocumentUrl('icp', '0ed34697-0fa9-4f08-ac15-d3504ac45caf'))
      .toBe('https://app.margenticos.com/dashboard/strategy/icp?client=0ed34697-0fa9-4f08-ac15-d3504ac45caf')
  })

  it('omits ?client= for a client recipient, because the resolver ignores it for them', () => {
    expect(strategyDocumentUrl('icp', null)).not.toContain('client=')
    expect(strategyDocumentUrl('icp')).not.toContain('client=')
  })

  // THE PART THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. Asserting the string is circular:
  // the broken link was internally consistent too. This asserts the route file is there.
  it('points at a route that exists in the app directory', () => {
    const routeFile = join(process.cwd(), 'src/app/dashboard/(client)/strategy/[type]/page.tsx')
    expect(existsSync(routeFile)).toBe(true)

    const brokenRoute = join(process.cwd(), 'src/app/dashboard/documents/page.tsx')
    expect(existsSync(brokenRoute)).toBe(false)
  })

  it('knows which document types are real', () => {
    expect(isStrategyDocumentType('icp')).toBe(true)
    expect(isStrategyDocumentType('documents')).toBe(false)
  })
})
