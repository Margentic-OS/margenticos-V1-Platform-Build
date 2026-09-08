// deriveFilterSpec has no default seniority, and cannot be made to invent one.
//
// ─── WHAT THIS REPLACES ──────────────────────────────────────────────────────
//
// The field used to be computed inside deriveFilterSpec by lowercasing two sentences of the
// client's document, asking whether either contained one of two particular words, and
// returning one of two lists written into that file. There was no third outcome.
//
// MEASURED against the live provider on 2026-09-08, on all three live clients: it removed
// 103 of the 104 people one client's own job titles reach, 35,585 of 46,772 for another,
// and 6,403 for the third. For all three, sending every band the provider accepts returned
// exactly the same count as omitting the parameter, so the axis has never added anybody.
//
// So the tests that matter here are the ones that fail if a default comes back.
//
// ─── NO BAND IS NAMED IN THIS FILE ───────────────────────────────────────────
//
// Every value comes from the fixture, which takes them from the provider's own list by
// position. A band name written here would be the defect returning by the back door.

import { describe, it, expect } from 'vitest'
import { deriveFilterSpec, CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'
import type { IcpDocument } from '@/lib/agents/icp-filter-spec'
import { aTargetableCode, aGeography } from '@/test-utils/geography-fixture'

import { seniorityFixture, someBands, NO_SENIORITY } from '@/test-utils/seniority-fixture'
import {
  PROVIDER_SENIORITY_BANDS, keepHonourableBands, isProviderSeniorityBand,
} from '@/lib/sourcing/handlers/provider-seniority'

// Taken from the canonical list by position rather than written out, for the same reason
// the bands are: a sector name in a test is a sector name in the repository.
const anIndustry = () => CANONICAL_INDUSTRIES[0]

const doc: IcpDocument = {
  summary: 's',
  jtbd_statement: 'j',
  tier_1: {
    company_profile: { revenue_range: 'r', headcount: '5-20 people', industries: [anIndustry()] },
    buyer_profile: { title: 't', seniority: 'whatever this client\'s document happens to say' },
    disqualifiers: [],
  },
  tier_2: {
    company_profile: { revenue_range: 'r', headcount: '5-20 people', industries: [anIndustry()] },
    buyer_profile: { title: 't', seniority: 'and whatever the second tier says' },
    disqualifiers: [],
  },
  tier_3: { company_profile: { revenue_range: 'r', headcount: '5-20 people', industries: [] } },
}

const geo = () => aGeography([aTargetableCode()])

describe('seniority is required and has no substitute', () => {
  it('refuses when no bands were derived', () => {
    // THE CENTRAL ASSERTION. An empty set is what the derivation returns when a client's
    // documents do not establish where their buyer sits, and it must stop the run.
    expect(() => deriveFilterSpec(doc, null, geo(), NO_SENIORITY)).toThrow(/no seniority bands/i)
  })

  it('refuses when the parameter is absent entirely', () => {
    // A JavaScript caller, or a stale call site, reaches here with undefined. The type is
    // the notice to whoever writes the next caller; this is the check that fires.
    expect(() => deriveFilterSpec(doc, null, geo(), undefined as never)).toThrow(/no seniority bands/i)
  })

  it('refuses on a malformed parameter rather than treating it as empty', () => {
    expect(() => deriveFilterSpec(doc, null, geo(), { bands: 'not an array' } as never))
      .toThrow(/no seniority bands/i)
  })

  it('the refusal says why there is no default', () => {
    // An error that only says "missing" invites the next reader to supply a default. This
    // one has to carry the reason, because the reason is the whole change.
    let message = ''
    try { deriveFilterSpec(doc, null, geo(), NO_SENIORITY) } catch (e) { message = (e as Error).message }
    expect(message).toMatch(/deliberately no default/i)
    expect(message).toMatch(/own documents/i)
    expect(message).toMatch(/two particular words/i)
  })

  it('stores exactly what it was given, unaltered', () => {
    const spec = deriveFilterSpec(doc, null, geo(), seniorityFixture(3))
    expect(spec.seniority_levels).toEqual(someBands(3))
  })

  it('does not alias the caller\'s array', () => {
    // Two specs sharing one array instance means a caller mutating either changes both,
    // across clients, with no error. The same guard the country fields already carry.
    const param = seniorityFixture(3)
    const spec = deriveFilterSpec(doc, null, geo(), param)
    param.bands.push(PROVIDER_SENIORITY_BANDS[4])
    expect(spec.seniority_levels).toHaveLength(3)
  })

  it('the outcome does NOT depend on what the document says about seniority', () => {
    // THE MUTATION-PROOF FOR THE DELETED RULE, expressed as behaviour. The old code read
    // these two strings and branched on them. Nothing does now, so two documents whose
    // seniority prose differs completely must produce the same spec given the same bands.
    const other: IcpDocument = {
      ...doc,
      tier_1: { ...doc.tier_1, buyer_profile: { title: 't', seniority: 'entirely different prose' } },
      tier_2: { ...doc.tier_2, buyer_profile: { title: 't', seniority: 'different again' } },
    }
    const a = deriveFilterSpec(doc, null, geo(), seniorityFixture(2))
    const b = deriveFilterSpec(other, null, geo(), seniorityFixture(2))
    expect(a.seniority_levels).toEqual(b.seniority_levels)
  })
})

describe('the provider vocabulary lives in the handler layer and is validated against', () => {
  it('keeps only values the provider will honour', () => {
    const kept = keepHonourableBands([...someBands(2), 'a-value-the-provider-never-defined'])
    expect(kept).toEqual(someBands(2))
  })

  it('deduplicates and orders deterministically, so two runs store the same array', () => {
    const [first, second] = someBands(2)
    expect(keepHonourableBands([second, first, second])).toEqual([first, second])
  })

  it('returns nothing when nothing is honourable, so the caller refuses', () => {
    // The path that turns an invented vocabulary into a refusal rather than into a filter
    // the provider silently drops.
    expect(keepHonourableBands(['nonsense', 42, null, undefined])).toEqual([])
  })

  it('membership is tested against the one list, not a copy', () => {
    for (const band of PROVIDER_SENIORITY_BANDS) expect(isProviderSeniorityBand(band)).toBe(true)
    expect(isProviderSeniorityBand('not-in-the-list')).toBe(false)
  })

  it('the list is non-empty, so none of the above passes vacuously', () => {
    expect(PROVIDER_SENIORITY_BANDS.length).toBeGreaterThan(3)
  })
})
