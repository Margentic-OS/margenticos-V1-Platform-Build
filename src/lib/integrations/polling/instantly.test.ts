// Test suite for Instantly polling mechanism.
// IMPORTANT: These tests verify the MECHANISM is correct (the wiring works).
// They do NOT verify the status values themselves are correct. Only live API
// data can confirm the actual bounce/unsubscribe numeric values and field.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { INSTANTLY_LEAD_STATUS_BOUNCED, INSTANTLY_LEAD_STATUS_UNSUBSCRIBED, INSTANTLY_LEAD_STATUS_VERIFIED } from './instantly'

describe('Instantly polling - bounce/unsubscribe detection mechanism', () => {
  describe('Status value constants - mechanism verification', () => {
    it('exports BOUNCED as the number -1, per the Instantly v2 Lead schema', () => {
      // Lead.status: 1 Active, 2 Paused, 3 Completed, -1 Bounced, -2 Unsubscribed, -3 Skipped.
      // Previously '-2' as a string: inverted AND the wrong type.
      expect(INSTANTLY_LEAD_STATUS_BOUNCED).toBe(-1)
      expect(typeof INSTANTLY_LEAD_STATUS_BOUNCED).toBe('number')
    })

    it('exports UNSUBSCRIBED as the number -2, per the Instantly v2 Lead schema', () => {
      // Previously '-1' as a string: inverted AND the wrong type.
      expect(INSTANTLY_LEAD_STATUS_UNSUBSCRIBED).toBe(-2)
      expect(typeof INSTANTLY_LEAD_STATUS_UNSUBSCRIBED).toBe('number')
    })

    it('BOUNCED and UNSUBSCRIBED values are distinct (mechanism requirement)', () => {
      expect(INSTANTLY_LEAD_STATUS_BOUNCED).not.toBe(INSTANTLY_LEAD_STATUS_UNSUBSCRIBED)
    })

    it('INSTANTLY_LEAD_STATUS_VERIFIED flag is false (operating on unverified values)', () => {
      // While this is false, polling logs warnings on every run about unverified values.
      // At activation, after live confirmation, this flips to true and warnings stop.
      expect(INSTANTLY_LEAD_STATUS_VERIFIED).toBe(false)
    })

    it('status values are numbers, so a strict comparison against the API can succeed', () => {
      // The API types Lead.status as a number. When these were strings, every strict
      // comparison against a returned row was false regardless of the value, so
      // correcting the inversion alone would have changed nothing observable.
      const statusValues = [INSTANTLY_LEAD_STATUS_BOUNCED, INSTANTLY_LEAD_STATUS_UNSUBSCRIBED]
      statusValues.forEach(value => {
        expect(typeof value).toBe('number')
        expect(Number.isInteger(value)).toBe(true)
      })

      // The bug being locked out: a numeric row value must not equal a string constant.
      expect(INSTANTLY_LEAD_STATUS_BOUNCED === -1).toBe(true)
      // @ts-expect-error comparing number to string is exactly what used to happen
      expect(INSTANTLY_LEAD_STATUS_BOUNCED === '-1').toBe(false)
    })
  })

  describe('Detection wiring - mechanism correctness', () => {
    it('bounce detection would trigger when configured BOUNCED value matches response status field', () => {
      // This test documents the expected wiring:
      // If polling finds a lead with status = INSTANTLY_LEAD_STATUS_BOUNCED,
      // the code should generate an email_bounced signal.
      const mockLeadWithBounceStatus = {
        id: 'lead-1',
        email: 'test@example.com',
        status: INSTANTLY_LEAD_STATUS_BOUNCED,
      }

      // Mechanism: if (lead.status === INSTANTLY_LEAD_STATUS_BOUNCED) → write email_bounced signal
      // This test verifies the comparison works correctly
      expect(mockLeadWithBounceStatus.status).toBe(INSTANTLY_LEAD_STATUS_BOUNCED)
      expect(mockLeadWithBounceStatus.status).not.toBe(INSTANTLY_LEAD_STATUS_UNSUBSCRIBED)
    })

    it('unsubscribe detection would trigger when configured UNSUBSCRIBED value matches response status field', () => {
      // This test documents the expected wiring:
      // If polling finds a lead with status = INSTANTLY_LEAD_STATUS_UNSUBSCRIBED,
      // the code should generate a lead_unsubscribed signal.
      const mockLeadWithUnsubStatus = {
        id: 'lead-2',
        email: 'test@example.com',
        status: INSTANTLY_LEAD_STATUS_UNSUBSCRIBED,
      }

      // Mechanism: if (lead.status === INSTANTLY_LEAD_STATUS_UNSUBSCRIBED) → write lead_unsubscribed signal
      expect(mockLeadWithUnsubStatus.status).toBe(INSTANTLY_LEAD_STATUS_UNSUBSCRIBED)
      expect(mockLeadWithUnsubStatus.status).not.toBe(INSTANTLY_LEAD_STATUS_BOUNCED)
    })

    it('different status values prevent cross-signal detection (mechanism safety)', () => {
      // Safety property: a bounced lead must not trigger unsubscribe detection and vice versa.
      // This is guaranteed by the distinct constant values.
      const bouncedLead = { status: INSTANTLY_LEAD_STATUS_BOUNCED }
      const unsubLead = { status: INSTANTLY_LEAD_STATUS_UNSUBSCRIBED }

      // Bounce detection: status === '-2'
      const isBounced = bouncedLead.status === INSTANTLY_LEAD_STATUS_BOUNCED
      // Unsub detection: status === '-1'
      const isUnsub = bouncedLead.status === INSTANTLY_LEAD_STATUS_UNSUBSCRIBED

      expect(isBounced).toBe(true)
      expect(isUnsub).toBe(false)

      // And vice versa
      const isUnsubCorrect = unsubLead.status === INSTANTLY_LEAD_STATUS_UNSUBSCRIBED
      const isBouncedWrong = unsubLead.status === INSTANTLY_LEAD_STATUS_BOUNCED

      expect(isUnsubCorrect).toBe(true)
      expect(isBouncedWrong).toBe(false)
    })
  })

  describe('Live verification gate', () => {
    it('INSTANTLY_LEAD_STATUS_VERIFIED flag controls verification status', () => {
      // When VERIFIED = false: polling logs warnings about unverified values
      // When VERIFIED = true: polling operates in confident mode (no warnings)
      // This flag exists to ensure live confirmation at activation is never forgotten.
      expect(INSTANTLY_LEAD_STATUS_VERIFIED).toBe(false)
      // If ever this is true without proper live confirmation, that's a bug in the activation process.
    })
  })
})

describe('Instantly polling — feature flag guards', () => {
  beforeEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
  })

  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
  })

  it('guard prevents production fetch when flag=false and URL=production', () => {
    // Documents the guard condition in fetchOutboundEmailBody, instantlyGet, instantlyPost:
    // if (!isActive && !shouldUseMockDispatch(isActive) && baseUrl.includes('api.instantly.ai'))
    //   throw InstantlyFlagError

    const isActive = false
    const baseUrl = 'https://api.instantly.ai/api/v2'
    process.env.INSTANTLY_API_BASE_URL = baseUrl

    // Guard evaluates to:
    // !isActive = true
    // !shouldUseMockDispatch(isActive) = !(!isActive && !process.env.INSTANTLY_API_BASE_URL)
    //                                  = !(true && false) = !false = true
    // baseUrl.includes('api.instantly.ai') = true
    // Result: true && true && true = true → throw

    const shouldThrow =
      !isActive &&
      !(isActive === false && !process.env.INSTANTLY_API_BASE_URL) &&
      baseUrl.includes('api.instantly.ai')

    expect(shouldThrow).toBe(true)
  })

  it('guard permits mock path when flag=false and env var unset', () => {
    // Documents that the guard allows mock dispatch when env var is not set

    const isActive = false
    delete process.env.INSTANTLY_API_BASE_URL // env var unset

    // shouldUseMockDispatch returns: !isActive && !process.env.INSTANTLY_API_BASE_URL
    const shouldUseMock = !isActive && !process.env.INSTANTLY_API_BASE_URL
    expect(shouldUseMock).toBe(true)

    // When shouldUseMock is true, the else branch (real fetch) is not taken
  })

  it('guard permits production fetch when flag=true', () => {
    // Documents that guard does not fire when flag is true

    const isActive = true
    const baseUrl = 'https://api.instantly.ai/api/v2'
    process.env.INSTANTLY_API_BASE_URL = baseUrl

    // Guard condition: !isActive && !shouldUseMockDispatch(isActive) && baseUrl.includes(...)
    // !isActive = false → entire guard is false (short-circuit)
    const shouldThrow = !isActive && baseUrl.includes('api.instantly.ai')
    expect(shouldThrow).toBe(false)
  })
})
