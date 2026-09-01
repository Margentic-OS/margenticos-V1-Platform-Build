// The shared tier gate.
//
// WHAT THIS TEST DOES NOT PROVE, stated here so nobody over-trusts it: it proves the
// MODULE, not the WIRING. A shared predicate that no consumer calls passes every assertion
// below. Each of the five consumers has its own test that drives the real code path and
// goes red when the gate is removed from that specific query:
//
//   V1  verification   src/lib/sourcing/__tests__/verification-trigger-safety.test.ts
//   R1  research queue src/lib/queue/__tests__/research-enqueue.test.ts
//   R2  research inline src/lib/operator/__tests__/research-batch-entry-tier-gate.test.ts
//   AA  approve-all    src/app/api/dashboard/client/prospects/approve-all/__tests__/
//   S   send gate      src/app/dashboard/operator/clients/[id]/__tests__/
//                        handleUploadLeads.suppression-prefilter.test.ts

import { describe, it, expect } from 'vitest'
import {
  TIER_NOT_REJECTED_FILTER,
  TIER_PRESENT_COLUMN,
  excludeTierRejected,
  requireTierPresent,
} from '../tier-verdict'

describe('the tier gate filter strings', () => {
  it('excludes rejected rows and admits not-yet-tiered rows', () => {
    // The negation of (sourced_tier IS NULL AND tiering_reason IS NOT NULL).
    //
    // Asserted as an exact string because this one line IS the rule, it is interpreted by
    // PostgREST rather than by TypeScript, and a typo in it produces a filter that matches
    // everything without erroring. Changing it should require changing this line too.
    expect(TIER_NOT_REJECTED_FILTER).toBe('sourced_tier.not.is.null,tiering_reason.is.null')
  })

  it('is built from column names and operators only, and no value at all', () => {
    // RULE ZERO, asserted as a WHITELIST rather than a blacklist of forbidden words. A
    // blacklist has to name the things it forbids, which puts them in the file; it also
    // passes for any value nobody thought to list. This says what the filter may contain,
    // so a reason string, a job title, an industry or a country cannot appear without
    // failing here, whether or not anyone anticipated it.
    const permitted = new Set(['sourced_tier', 'tiering_reason', 'not', 'is', 'null'])
    const tokens = TIER_NOT_REJECTED_FILTER.split(/[.,]/)

    expect(tokens.filter(t => !permitted.has(t))).toEqual([])
  })

  it('the send gate requires a positive tier, which is stricter', () => {
    expect(TIER_PRESENT_COLUMN).toBe('sourced_tier')
  })
})

describe('the helpers apply exactly one filter to the query they are given', () => {
  it('excludeTierRejected calls .or() once with the filter and returns the builder', () => {
    const calls: string[] = []
    const builder = { or(f: string) { calls.push(f); return builder } }
    expect(excludeTierRejected(builder)).toBe(builder)
    expect(calls).toEqual(['sourced_tier.not.is.null,tiering_reason.is.null'])
  })

  it('requireTierPresent calls .not(sourced_tier, is, null) once', () => {
    const calls: Array<[string, string, unknown]> = []
    const builder = {
      not(c: string, op: string, v: unknown) { calls.push([c, op, v]); return builder },
    }
    expect(requireTierPresent(builder)).toBe(builder)
    expect(calls).toEqual([['sourced_tier', 'is', null]])
  })
})
