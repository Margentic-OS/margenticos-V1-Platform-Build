// GRADING AGAINST THE CLIENT'S OWN STORED CONDITIONS, AND REFUSING A RUN BY THE SAMPLE ASKED FOR.
//
// Two changes, proved end to end through runSearchTuner because both are about what the run
// does BEFORE it spends anything, and both were previously decided by a constant.
//
// ─── WHY THE STANDARD MUST BE STORED ─────────────────────────────────────────
//
// The rubric used to be derived fresh on every run by an Opus call, and roughly a quarter of
// that call's output moves between identical calls. A fit rate measured against a standard that
// wobbles cannot be compared with last month's, and comparison is most of what a sampler is
// for: 42% is neither good nor bad, 42% against 31% on the same standard is a finding. The
// stored list is derived once at profile approval and read every time after.
//
// It is also the cheaper path. That derivation was the only model call outside the rounds, it
// was an Opus one, and no dollar figure this module reported ever counted it.
//
// ─── WHY THE POPULATION GATE MUST FOLLOW THE SAMPLE ──────────────────────────
//
// It compared the reachable population against a constant pinned to the default sample, so a
// run asked for 30 was refused on a population of 50 that would have filled it comfortably.
//
// RULE ZERO: no industry, sector, country, job title or company name below.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'
import { aTargetableCode } from '@/test-utils/geography-fixture'
import { seniorityFixture, someBands } from '@/test-utils/seniority-fixture'
import type { FitContext } from '@/lib/tuner/fit-judge'

vi.mock('@/lib/tuner/in-flight', async (orig) => ({
  ...(await orig<typeof import('@/lib/tuner/in-flight')>()),
  findInFlight: async () => null,
  registerTunerRun: async () => ({ runId: 'run-under-test', complete: async () => {}, fail: async () => {} }),
}))

/** The reachable population this run will see. Set per test, before the run. */
let reachable = 5000

vi.mock('@/lib/tuner/differencing', async (orig) => ({
  ...(await orig<typeof import('@/lib/tuner/differencing')>()),
  differenceSearch: async () => ({ population: reachable, suspectedIgnoredAxes: [] }),
}))

vi.mock('@/lib/tuner/relaxation-ceiling', async (orig) => ({
  ...(await orig<typeof import('@/lib/tuner/relaxation-ceiling')>()),
  measureCeiling: async () => ({ ceiling: reachable * 2 }),
}))

const derive = vi.fn(async () => {
  const { parseProposedSearch } = await import('@/lib/tuner/proposed-search')
  return {
    criterion: {
      status: 'derived', accept: [{ fragment: 'a-fragment', rank: 'primary' }], reject: [],
      statement: 's', evidence: [], unsettled_reason: null, sanity: null,
      derived_at: new Date(0).toISOString(), model: 'test',
    },
    vocabulary: { sells: 'derived-offer', usedFor: 'derived-use', nameWords: [] },
    seniority: seniorityFixture(),
    search: parseProposedSearch({
      words: [{ value: 'placeholder-word', reason: 'the document states it', basis: 'stated' }],
    }),
  }
})
vi.mock('@/agents/buyer-criterion-agent', () => ({
  deriveBuyerCriterionWithVocabulary: (...a: unknown[]) => derive(...(a as [])),
}))

vi.mock('@/lib/tuner/spread-sample', async (orig) => ({
  ...(await orig<typeof import('@/lib/tuner/spread-sample')>()),
  drawSpreadSample: async (_req: unknown, _p: unknown, n: number) => ({
    rows: Array.from({ length: n }, (_, i) => ({
      sourceId: `row-${i}`, firstName: null, jobTitle: 'placeholder-role', companyName: `Placeholder Company ${i}`,
    })),
    positions: Array.from({ length: n }, (_, i) => i + 1),
    total: reachable,
    missed: 0,
  }),
}))

vi.mock('@/lib/agents/tools/webSearch', () => ({
  webSearch: async () => ({
    synthesis: 'A description long enough to be usable, running past the minimum length the ' +
      'module requires before it will treat a lookup as having resolved anything at all.',
    limited: false, searchCount: 1, resultCount: 3,
    inputTokens: 9000, outputTokens: 300, model: 'claude-haiku-4-5-20251001',
    source: 'anthropic_native', query: 'q',
  }),
}))

import { runSearchTuner } from '@/lib/tuner/search-tuner'

// What the client's profile actually says, in the shape the approval step stores it.
const STORED_STATEMENTS = {
  required: 'The organisation meets the first condition the profile requires.',
  alsoRequired: 'The organisation meets the second condition the profile requires.',
  supporting: 'The organisation shows a trait the profile treats as typical rather than required.',
}

function storedFitDimensions() {
  return {
    derived_at: new Date(0).toISOString(),
    model: 'claude-opus-4-6',
    dimensions: [
      { key: 'condition_one', statement: STORED_STATEMENTS.required, source: 'the profile says so', role: 'required', establishable: true },
      { key: 'condition_two', statement: STORED_STATEMENTS.alsoRequired, source: 'the profile says so', role: 'required', establishable: true },
      { key: 'condition_three', statement: STORED_STATEMENTS.supporting, source: 'the profile says so', role: 'supporting', establishable: true },
    ],
  }
}

function fakeSupabase(fitDimensions: unknown): SupabaseClient {
  const code = aTargetableCode()
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    single: async () => ({
      data: {
        id: 'doc-1', version: 4, updated_at: new Date(0).toISOString(),
        content: { summary: 'what this client sells, in its own words', jtbd_statement: 'what it is used for' },
        icp_filter_spec: {
          job_titles: ['placeholder-role'], job_titles_excluded: [], seniority_levels: someBands(2),
          person_countries: [code], company_countries: [code],
          company_headcount_min: 5, company_headcount_max: 20,
          industries: [CANONICAL_INDUSTRIES[0]], industries_excluded: [],
          keywords: [], keywords_excluded: [],
          company_revenue_min: null, company_revenue_max: null, notes: '',
          ...(fitDimensions === undefined ? {} : { fit_dimensions: fitDimensions }),
        },
      },
      error: null,
    }),
  }
  return { from: () => chain } as unknown as SupabaseClient
}

/** Captures the standard it was asked to grade against, and passes everything. */
const seenContexts: FitContext[] = []
const judge = vi.fn(async (rows: { sourceId: string }[], context: FitContext) => {
  seenContexts.push(context)
  return {
    verdicts: rows.map(r => ({ sourceId: r.sourceId, verdict: 'best' as const, reason: 'placeholder' })),
    modelCalls: 1,
  }
})

const run = (fitDimensions: unknown, sampleSize = 3) => runSearchTuner({
  supabase: fakeSupabase(fitDimensions), organisationId: 'org-under-test',
  sampleSize, maxRounds: 1, useNameSignal: false, fitJudge: judge,
})

beforeEach(() => {
  reachable = 5000
  derive.mockClear()
  judge.mockClear()
  seenContexts.length = 0
})

describe('the standard comes from the client\'s stored conditions', () => {
  it('grades against the stored statements and never derives a rubric', async () => {
    const result = await run(storedFitDimensions())

    expect(judge).toHaveBeenCalled()
    // THE STATEMENTS REACH THE JUDGE. A note saying so is not the same as it happening: this
    // asserts on the context the judge was actually handed.
    const context = seenContexts[0]
    expect(context.bestDescription).toContain(STORED_STATEMENTS.required)
    expect(context.bestDescription).toContain(STORED_STATEMENTS.supporting)
    // ACCEPTABLE is the REQUIRED conditions only. A prospect meeting those and not the rest is
    // the acceptable kind of customer, which is exactly the distinction the judge is asked to draw.
    expect(context.acceptableDescription).toContain(STORED_STATEMENTS.required)
    expect(context.acceptableDescription).toContain(STORED_STATEMENTS.alsoRequired)
    expect(context.acceptableDescription).not.toContain(STORED_STATEMENTS.supporting)
    // And the client's own document supplies what it sells, unchanged between runs.
    expect(context.sells).toBe('what this client sells, in its own words')
    expect(context.usedFor).toBe('what it is used for')

    // THE OPUS CALL IS NOT MADE. This is the saving and the reason the figure is comparable.
    expect(derive).not.toHaveBeenCalled()
    expect(result.notes.join(' ')).toContain('stored on this client\'s own settings')
    expect(result.notes.join(' ')).toContain('No model call was made to decide what fit means')
  })

  it('falls back to deriving one when the client has no stored conditions', async () => {
    // Every client had this before the lists existed, and a run that refused to measure them
    // would be worse than one that measures them against a standard of its own.
    const result = await run(undefined)

    expect(derive).toHaveBeenCalledTimes(1)
    expect(seenContexts[0].sells).toBe('derived-offer')
    expect(result.notes.join(' ')).not.toContain('stored on this client\'s own settings')
  })

  it('falls back, and says why, when the stored conditions cannot be read', async () => {
    // A malformed list must not silently become "no conditions": the operator needs to know the
    // run they are about to compare was graded against something else.
    const result = await run({ dimensions: [{ key: 'broken' }] })

    expect(derive).toHaveBeenCalledTimes(1)
    expect(result.notes.join(' ')).toContain('stored conditions could not be read')
  })
})

describe('the population gate follows the sample that was asked for', () => {
  it('refuses a population that cannot fill the sample asked for', async () => {
    reachable = 50
    const result = await run(storedFitDimensions(), 80)

    expect(result.terminalState).toBe('audience_cannot_support_the_work')
    expect(result.terminalReason).toContain('below the 80 needed')
    // Refused for free: no research, no judging, and the reason says so.
    expect(judge).not.toHaveBeenCalled()
    expect(result.billableSearches).toBe(0)
    expect(result.terminalReason).toContain('No model call and no research were spent')
  })

  it('runs on the SAME population when a smaller sample was asked for', async () => {
    // The pair is the point. One population, two answers, and the only difference is the number
    // the caller passed in. Against a constant, this run was refused.
    reachable = 50
    const result = await run(storedFitDimensions(), 30)

    expect(result.terminalState).not.toBe('audience_cannot_support_the_work')
    expect(judge).toHaveBeenCalled()
  })
})
