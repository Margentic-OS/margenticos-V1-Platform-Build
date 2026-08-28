// Guards the output-side vendor gate, built 2026-08-28.
//
// The cases below use the REAL shapes measured in stored documents on that date, not
// invented ones. Three unrelated phrasings reached tier_3.disqualifiers and
// evidence_to_find, which is the evidence that a phrasing-based gate could not have
// worked and why the test is sourcedness.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { findVendorNames, assertNoUnsourcedVendorNames, VENDOR_GATE_MODE } from '../vendor-name-gate'

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
import { logger } from '@/lib/logger'

const ctx = { agent: 'icp-agent', organisation_id: 'org-1', document_type: 'icp' }
beforeEach(() => vi.clearAllMocks())

describe('findVendorNames: the three real shapes that leaked', () => {
  const REAL = [
    'Apollo-detectable: headcount reduction or senior role departure in the last 90 days',
    'Company revenue below £1.5m. Checkable via Apollo revenue estimates, company headcount under 10.',
    'Company founded within the last 6 months AND no visible team beyond the founder on Apollo or LinkedIn',
  ]

  it.each(REAL)('catches it when nothing in the input supplied the name: %s', text => {
    const hits = findVendorNames({ tier_1: { disqualifiers: [text] } }, 'intake says nothing about tools')
    expect(hits).toHaveLength(1)
    expect(hits[0].vendor).toBe('Apollo')
    expect(hits[0].sourced).toBe(false)
  })

  it('reports the dotted field path so a hit can be found in the document', () => {
    const doc = { tier_3: { disqualifiers: ['ok', 'checkable via Apollo estimates'] } }
    const hits = findVendorNames(doc, '')
    expect(hits[0].field).toBe('tier_3.disqualifiers[1]')
  })

  it('walks nested arrays of objects, which is where evidence_to_find lives', () => {
    const doc = { tier_1: { triggers: [{ trigger: 't', evidence_to_find: ['Apollo-detectable: x'] }] } }
    expect(findVendorNames(doc, '')[0].field).toBe('tier_1.triggers[0].evidence_to_find[0]')
  })
})

describe('the boundary: a client describing their own market is never blocked', () => {
  it('allows a vendor the intake named', () => {
    const doc = { tier_1: { company_profile: { industries: ['teams running Apollo and Salesforce'] } } }
    const input = 'INTAKE\n  Q: who do you sell to?\n  A: sales teams running Apollo'
    const hits = findVendorNames(doc, input)
    expect(hits).toHaveLength(1)
    expect(hits[0].sourced).toBe(true)
  })

  it('allows a vendor the website text named', () => {
    const hits = findVendorNames({ s: 'buyers who already use Lemlist' }, 'CLIENT WEBSITE CONTENT ... we integrate with Lemlist')
    expect(hits[0].sourced).toBe(true)
  })

  it('allows a vendor the research results named', () => {
    const hits = findVendorNames({ s: 'competitors include Smartlead' }, 'WEB RESEARCH\nResult: Smartlead raised a round')
    expect(hits[0].sourced).toBe(true)
  })

  it('is case-insensitive in both directions, because ambiguity resolves to allow', () => {
    expect(findVendorNames({ s: 'APOLLO' }, 'we tried apollo once')[0].sourced).toBe(true)
    expect(findVendorNames({ s: 'apollo' }, 'We tried APOLLO once')[0].sourced).toBe(true)
  })

  it('does not fire on the capability phrasing that replaced the vendor name', () => {
    const doc = { e: ['Company-data-detectable: headcount change in last 90 days'] }
    expect(findVendorNames(doc, '')).toEqual([])
  })

  it('does not fire on ordinary words that merely contain a vendor name', () => {
    // "Instantly" is a common adverb. Word boundaries matter, but a bare adverb use is a
    // real false positive we accept: it is logged, not blocked, and the observation week
    // is where that gets judged.
    expect(findVendorNames({ s: 'Apollonian ideals and bouncers at the door' }, '')).toEqual([])
  })
})

describe('assertNoUnsourcedVendorNames', () => {
  it('is report-only today, so an unsourced name is logged and does not throw', () => {
    expect(VENDOR_GATE_MODE).toBe('report')
    expect(() =>
      assertNoUnsourcedVendorNames({ s: 'Apollo-detectable: x' }, 'nothing', ctx),
    ).not.toThrow()
    expect(logger.warn).toHaveBeenCalledOnce()
    const payload = vi.mocked(logger.warn).mock.calls[0][1] as Record<string, unknown>
    // Doug's requirement: log the document, the field, and whether it was sourced.
    expect(payload.document_type).toBe('icp')
    expect(payload.organisation_id).toBe('org-1')
    expect((payload.hits as Array<{ field: string }>)[0].field).toBe('s')
  })

  it('logs sourced hits separately, since that is where the known hole shows up', () => {
    assertNoUnsourcedVendorNames({ s: 'we integrate with Lemlist' }, 'intake mentions Lemlist', ctx)
    expect(logger.info).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('says nothing at all when the document names no vendor', () => {
    expect(assertNoUnsourcedVendorNames({ s: 'Company-data-detectable: x' }, '', ctx)).toEqual([])
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('the vendor list is built from one source, so pattern and list cannot drift', () => {
    // Every name in the list must actually be detected. A name added to the array but
    // missing from the regex would be a silent gap, which is the parallel-list shape.
    for (const v of ['Instantly', 'Apollo', 'Taplio', 'Lemlist', 'GoHighLevel', 'Calendly',
                     'Hunter.io', 'MyEmailVerifier', 'Bouncer', 'Apify', 'Brave', 'Smartlead']) {
      expect(findVendorNames({ s: `uses ${v} for this` }, ''), v).toHaveLength(1)
    }
  })
})
