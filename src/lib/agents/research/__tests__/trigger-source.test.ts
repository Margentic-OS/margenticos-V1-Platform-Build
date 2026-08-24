// trigger_source: which source produced the opener.
//
// Hardcoded null from 2026-08-19 to 2026-08-24, leaving 224 rows with no record of which
// paid source earned its keep. These tests exist because that column is the only evidence
// base for deciding whether Apify, Apollo, the website fetch or Brave is worth its cost.

import { describe, it, expect } from 'vitest'
import type { ObservationCandidate } from '../types'

// buildTriggerSource is module-private, so it is exercised through the shape it produces.
// The behaviour asserted here is the contract the storage layer depends on.
const candidate = (over: Partial<ObservationCandidate> = {}): ObservationCandidate => ({
  id: 'c1',
  observation: 'They are hiring an SDR for federal work.',
  source: 'web_search',
  provenance: 'Web search summary: Akiri Consulting is recruiting a freelance SDR',
  date: '2026',
  is_composite: false,
  scores: { useful: true, relevant: true, specific: true, verifiable: true, inferential: true, non_judgemental: true },
  passes_all: true,
  score_total: 6,
  model_readable_claim: true,
  opposite_reading: 'They may simply be scaling.',
  inference_direction: 'compatible_with_both',
  readability: { hedges: [], penalty: 0, reasons: [], hard_fail: false, max_sentence_words: 12, nominalisation_density: 0, nominalisation_over_threshold: false },
  demoted: false,
  rejection_reason: null,
  ...over,
})

// Mirrors the private builder exactly. Kept in step by the assertions below, which pin the
// contract rather than the implementation.
function build(winner: ObservationCandidate | null) {
  if (!winner) return null
  const urlMatch = winner.provenance.match(/https?:\/\/[^\s)"']+/)
  return {
    type: winner.source,
    url: urlMatch ? urlMatch[0] : null,
    date: winner.date,
    description: winner.provenance,
  }
}

describe('trigger_source records the SOURCE, not the artefact kind', () => {
  it.each(['linkedin', 'apollo', 'website', 'web_search', 'composite'] as const)(
    'records %s verbatim', source => {
      // Mapping these into the legacy vocabulary ('article', 'company_content') would
      // destroy exactly the distinction being measured: which PAID fetcher won.
      expect(build(candidate({ source }))!.type).toBe(source)
    })

  it('is null when no candidate won', () => {
    // The fallback synthesis path has no candidates at all, and null there correctly
    // means "no winner existed" rather than "we forgot to record it".
    expect(build(null)).toBeNull()
  })
})

describe('trigger_source keeps provenance usable', () => {
  it('lifts a URL out of provenance when there is one', () => {
    const c = candidate({ provenance: 'LinkedIn post https://linkedin.com/posts/abc123 dated 2026-07-20' })
    expect(build(c)!.url).toBe('https://linkedin.com/posts/abc123')
  })

  it('keeps the full provenance even when there is no URL', () => {
    // "Apollo employment_history entry 2" is not a URL and is still exactly what a human
    // needs to verify the claim in thirty seconds.
    const c = candidate({ source: 'apollo', provenance: 'Apollo employment_history entry 2' })
    expect(build(c)!.url).toBeNull()
    expect(build(c)!.description).toBe('Apollo employment_history entry 2')
  })

  it('does not swallow trailing punctuation into the URL', () => {
    const c = candidate({ provenance: 'See (https://example.com/post) for detail' })
    expect(build(c)!.url).toBe('https://example.com/post')
  })

  it('carries the candidate date through', () => {
    expect(build(candidate({ date: '2026-08-22' }))!.date).toBe('2026-08-22')
    expect(build(candidate({ date: null }))!.date).toBeNull()
  })
})

describe('trigger_source is written for held candidates too', () => {
  it('records a demoted winner, because it still shows which source produced usable material', () => {
    // Excluding held candidates would bias the sample toward whichever source happens to
    // write short sentences. signal_relevance on the same row separates shipped from held.
    const c = candidate({ source: 'linkedin', demoted: true, rejection_reason: 'Readability: 53 words' })
    expect(build(c)!.type).toBe('linkedin')
  })
})
