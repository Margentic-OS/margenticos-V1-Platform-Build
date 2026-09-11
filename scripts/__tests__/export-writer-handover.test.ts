// THE EXPORT HANDS THE WRITER WHAT A PRODUCTION REUSE RUN HANDS IT. Added 2026-09-11.
//
// For two days every export measured a thinner handover than production: it passed the
// candidates alone, while a production reuse run also carries the stored relevance reason.
// These pin the export to the reuse path's own code, so the instrument and the thing it
// measures cannot drift apart again without a test going red.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { writerInputForStored, describeHandover } from '../export-writer-run'
import { synthesisFromStored } from '@/lib/agents/prospect-research-agent-v2'
import { writerInputFromSynthesis } from '@/lib/agents/research/writer-input'
import type { ObservationCandidate, ProspectContext } from '@/lib/agents/research/types'

const candidate: ObservationCandidate = {
  id: 'c1',
  observation: 'You added a second press in March.',
  source: 'website',
  provenance: 'example.com/news',
  date: '2026-03',
  is_composite: false,
  scores: { specific: true, verifiable: true, inferential: true, relevant: true, useful: true, non_judgemental: true },
  passes_all: true,
  score_total: 6,
  model_readable_claim: true,
  opposite_reading: 'The press may replace an old one rather than add capacity.',
  inference_direction: 'compatible_with_both',
  readability: {
    hard_fail: false, penalty: 0, max_sentence_words: 7, hedges: [],
    nominalisation_density: 0, nominalisation_over_threshold: false, reasons: [],
  },
  demoted: false,
  rejection_reason: null,
}

const ctx: ProspectContext = {
  id: 'p1', organisation_id: 'org1', segment_id: null, first_name: 'Sam', last_name: null,
  company_name: 'Example Co', role: null, job_title: 'Founder', email: null, linkedin_url: null, website_url: null,
}

const stored = (relevance_reason: string | null) => ({
  result_id: 'r1',
  candidates: [candidate],
  had_linkedin: true,
  created_at: '2026-09-01T00:00:00Z',
  synthesized_at: null,
  icp_fit: 'strong' as const,
  qualification_status: 'qualified' as const,
  qualification_reason: null,
  confidence: 'high' as const,
  has_dateable_signal: true,
  signal_observation: null,
  relevance_reason,
})

describe('the export hands the writer what a production reuse run hands it', () => {
  it('carries the stored relevance reason into the findings block', async () => {
    const input = await writerInputForStored(stored('The press needs new customers.'), ctx, 'org1')
    expect(input.relevanceReason).toBe('The press needs new customers.')
    expect(describeHandover(input).findings_block).toContain(
      'Why this material was judged relevant to what the client solves: The press needs new customers.',
    )
  })

  it('marks no selection, because a reuse run reaches none of its own', async () => {
    const input = await writerInputForStored(stored('A reason.'), ctx, 'org1')
    expect(input.selectedCandidateId).toBeNull()
    expect(describeHandover(input).findings_block).not.toContain('[SELECTED BY SYNTHESIS]')
  })

  it('falls back to the reuse path\'s own sentence when the row has no reason', async () => {
    const input = await writerInputForStored(stored(null), ctx, 'org1')
    expect(input.relevanceReason).toContain('Findings reused from research result r1')
  })

  it('is the production mapping, not a copy of it', async () => {
    const s = stored('A reason.')
    expect(await writerInputForStored(s, ctx, 'org1'))
      .toEqual(writerInputFromSynthesis(await synthesisFromStored(s, ctx, 'org1')))
  })
})

describe('writerInputFromSynthesis, the one mapping every caller uses', () => {
  it('passes a fresh synthesis\'s selection through, so a fresh run still marks it', () => {
    const input = writerInputFromSynthesis({ candidates: [candidate], selected_candidate_id: 'c1', relevance_reason: 'R' })
    expect(input).toEqual({ candidates: [candidate], selectedCandidateId: 'c1', relevanceReason: 'R' })
    expect(describeHandover(input).findings_block).toContain('[SELECTED BY SYNTHESIS]')
  })
})
