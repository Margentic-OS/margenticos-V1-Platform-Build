// A BILLING OR AUTH FAILURE ENDS A TUNER RUN CLEANLY, AND NEVER BECOMES PART OF A MEASUREMENT.
//
// MEASURED 2026-09-10: the model provider's credit balance ran out partway through a paid
// 220-company round. The lookup step caught the failure and recorded each company as
// unresearched, which the judge reads as "could not establish": a verdict about the company,
// entered into the fit proportion, with no error anywhere. The lookup step now rethrows it, so
// this file proves what happens next, end to end through runSearchTuner:
//
//   the run ends as "failed", with the reason
//   the run's record is CLOSED, so the in-flight guard does not block the next run
//   the judge is never called, and no partial round is recorded
//
// The lookup step and the round loop are REAL. Only the database, the free provider counts,
// the derivation and the sample draw are faked, and the web search, which is what fails.
//
// RULE ZERO: no industry, sector, country or company name below.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FatalApiError } from '@/lib/agents/fatal-api-error'
import { CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'
import { aTargetableCode } from '@/test-utils/geography-fixture'
import { seniorityFixture, someBands } from '@/test-utils/seniority-fixture'

const handle = { runId: 'run-under-test', complete: vi.fn(async () => {}), fail: vi.fn(async () => {}) }

vi.mock('@/lib/tuner/in-flight', async (orig) => ({
  ...(await orig<typeof import('@/lib/tuner/in-flight')>()),
  findInFlight: async () => null,
  registerTunerRun: async () => handle,
}))

vi.mock('@/lib/tuner/differencing', async (orig) => ({
  ...(await orig<typeof import('@/lib/tuner/differencing')>()),
  differenceSearch: async () => ({ population: 5000, suspectedIgnoredAxes: [] }),
}))

vi.mock('@/lib/tuner/relaxation-ceiling', async (orig) => ({
  ...(await orig<typeof import('@/lib/tuner/relaxation-ceiling')>()),
  measureCeiling: async () => ({ ceiling: 9000 }),
}))

vi.mock('@/agents/buyer-criterion-agent', async () => {
  const { parseProposedSearch } = await import('@/lib/tuner/proposed-search')
  return {
    deriveBuyerCriterionWithVocabulary: async () => ({
      criterion: {
        status: 'derived', accept: [{ fragment: 'a-fragment', rank: 'primary' }], reject: [],
        statement: 's', evidence: [], unsettled_reason: null, sanity: null,
        derived_at: new Date(0).toISOString(), model: 'test',
      },
      vocabulary: { sells: 'placeholder-offer', usedFor: 'placeholder-use', nameWords: [] },
      seniority: seniorityFixture(),
      search: parseProposedSearch({
        words: [{ value: 'placeholder-word', reason: 'the document states it', basis: 'stated' }],
      }),
    }),
  }
})

vi.mock('@/lib/tuner/spread-sample', async (orig) => ({
  ...(await orig<typeof import('@/lib/tuner/spread-sample')>()),
  drawSpreadSample: async (_req: unknown, _p: unknown, n: number) => ({
    rows: Array.from({ length: n }, (_, i) => ({
      sourceId: `row-${i}`, firstName: null, jobTitle: 'placeholder-role', companyName: `Placeholder Company ${i}`,
    })),
    positions: Array.from({ length: n }, (_, i) => i + 1),
    total: 5000,
    missed: 0,
  }),
}))

const webSearch = vi.fn()
vi.mock('@/lib/agents/tools/webSearch', () => ({ webSearch: (...a: unknown[]) => webSearch(...a) }))

import { runSearchTuner } from '@/lib/tuner/search-tuner'

function specForTheStoredSearch() {
  const code = aTargetableCode()
  return {
    job_titles: ['placeholder-role'], job_titles_excluded: [], seniority_levels: someBands(2),
    person_countries: [code], company_countries: [code],
    company_headcount_min: 5, company_headcount_max: 20,
    industries: [CANONICAL_INDUSTRIES[0]], industries_excluded: [],
    keywords: [], keywords_excluded: [],
    company_revenue_min: null, company_revenue_max: null, notes: '',
  }
}

function fakeSupabase(): SupabaseClient {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    single: async () => ({
      data: { id: 'doc-1', version: 1, updated_at: new Date(0).toISOString(), content: {}, icp_filter_spec: specForTheStoredSearch() },
      error: null,
    }),
  }
  return { from: () => chain } as unknown as SupabaseClient
}

const judge = vi.fn(async (rows: { sourceId: string }[]) => ({
  verdicts: rows.map(r => ({ sourceId: r.sourceId, verdict: 'best' as const, reason: 'placeholder' })),
  modelCalls: 1,
}))

const run = () => runSearchTuner({
  supabase: fakeSupabase(), organisationId: 'org-under-test',
  sampleSize: 3, maxRounds: 1, useNameSignal: false, fitJudge: judge,
})

beforeEach(() => {
  webSearch.mockReset()
  judge.mockClear()
  handle.complete.mockClear()
  handle.fail.mockClear()
})

describe('a billing failure during the lookups', () => {
  it('ends the run as failed, says why, closes its record, and judges nothing', async () => {
    webSearch.mockRejectedValue(
      new FatalApiError('Anthropic credit balance exhausted (Anthropic web search)', 'placeholder'),
    )
    const result = await run()

    expect(result.terminalState).toBe('failed')
    expect(result.terminalReason).toMatch(/refused the account/)
    expect(result.terminalReason).toMatch(/credit balance/)
    // The record is closed, as failed, with the same reason.
    expect(handle.fail).toHaveBeenCalledTimes(1)
    expect(handle.fail).toHaveBeenCalledWith(result.terminalReason)
    expect(handle.complete).not.toHaveBeenCalled()
    // Nothing was measured on an account that could not pay.
    expect(judge).not.toHaveBeenCalled()
    expect(result.rounds.map(r => r.kind)).toEqual(['zero'])
  })
})

describe('CONTROL: the same run with a working search', () => {
  it('researches, judges, and does not end as failed', async () => {
    webSearch.mockResolvedValue({
      synthesis: 'A description long enough to be usable, running past the minimum length the ' +
        'module requires before it will treat a lookup as having resolved anything at all.',
      limited: false, searchCount: 1, resultCount: 3,
      inputTokens: 9000, outputTokens: 300, model: 'claude-haiku-4-5-20251001', source: 'anthropic_native', query: 'q',
    })
    const result = await run()

    expect(result.terminalState).not.toBe('failed')
    expect(judge).toHaveBeenCalled()
    expect(result.rounds.map(r => r.kind)).toEqual(['zero', 'adjust'])
    expect(handle.complete).toHaveBeenCalledTimes(1)
    expect(handle.fail).not.toHaveBeenCalled()
  })
})
