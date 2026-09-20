// A PROVIDER STATUS IS CLASSIFIED SERVER-SIDE AND NEVER REACHES A SCREEN.
//
// Item 2 of the 2026-09-17 walkthrough: "N prospects failed email verification, N on
// HTTP 429". A rate limit is not a failure, and a status code is a thing to look up rather
// than a thing to read.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/operator/__tests__/verification-hold.test.ts

import { describe, it, expect } from 'vitest'
import {
  classifyVerificationStatus,
  VERIFICATION_HOLD_LABELS,
  VERIFICATION_HOLD_KINDS,
} from '../prospect-status'

describe('classifyVerificationStatus', () => {
  it('reads a rate limit as its own kind, not as a failure', () => {
    expect(classifyVerificationStatus(429)).toBe('rate_limited')
  })

  it.each([[401], [403]])('reads %i as the provider refusing us, not the address', status => {
    expect(classifyVerificationStatus(status)).toBe('refused')
  })

  it.each([[400], [404], [500], [502], [503]])('reads %i as a provider error', status => {
    expect(classifyVerificationStatus(status)).toBe('provider_error')
  })

  it('keeps "no status recorded" visible rather than folding it into a neighbour', () => {
    expect(classifyVerificationStatus(null)).toBe('unknown')
  })
})

describe('the labels', () => {
  it('covers every kind, so no kind can render as a raw code', () => {
    for (const kind of VERIFICATION_HOLD_KINDS) {
      expect(VERIFICATION_HOLD_LABELS[kind]).toBeTruthy()
    }
  })

  // RULE ZERO plus the no-codes rule, asserted over the whole map rather than one entry.
  it('names no vendor, no number and no country', () => {
    for (const label of Object.values(VERIFICATION_HOLD_LABELS)) {
      expect(label).not.toMatch(/\d/)
      expect(label.toLowerCase()).not.toContain('http')
      for (const vendor of ['myemailverifier', 'bouncer', 'hunter', 'apollo', 'instantly']) {
        expect(label.toLowerCase()).not.toContain(vendor)
      }
    }
  })

  it('does not call a rate limit a failure', () => {
    expect(VERIFICATION_HOLD_LABELS.rate_limited.toLowerCase()).not.toContain('fail')
  })
})
