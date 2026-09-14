// THE SAMPLER, GIVEN A WAY TO BE RUN AND A REASON TO TRUST WHAT IT SAYS.
//
// It was written, tested, and left with no caller: no CLI, no route, nothing scheduled. So the
// question it answers, is this client's search finding the right people, was answered instead
// by grading every prospect during research at roughly $0.19 a head. That is a sampling
// question being paid for per head.
//
// Four things had to be true before a caller was worth having, and this file holds each one to
// a test that fails if it is removed:
//
//   1. the figure arrives with an interval, so nobody acts on a number the sample cannot support
//   2. the limits move with the sample asked for, not with the default
//   3. the standard is the client's OWN stored conditions, so two runs are comparable
//   4. the result is written down, so a later run has something to be compared against
//
// RULE ZERO: no industry, sector, country, job title or company name below.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  assessFit, wilsonInterval, minResolvedFor,
  MIN_RESOLVED_FOR_A_FIGURE, MIN_RESOLVED_FLOOR, MIN_RESOLVED_SHARE,
  type JudgedCompany, type FitVerdict, type FitOutcome,
} from '@/lib/tuner/fit-judge'
import { DEFAULT_SAMPLE_SIZE } from '@/lib/tuner/spread-sample'
import { writeSearchTunerRecord } from '@/lib/tuner/record'
import type { SearchTunerResult, RoundReport } from '@/lib/tuner/search-tuner'

const rows = (counts: Partial<Record<FitVerdict, number>>): JudgedCompany[] => {
  const out: JudgedCompany[] = []
  for (const [verdict, n] of Object.entries(counts)) {
    for (let i = 0; i < (n ?? 0); i++) {
      out.push({
        sourceId: `${verdict}-${i}`, jobTitle: 'placeholder-role', companyName: 'Placeholder Company',
        verdict: verdict as FitVerdict, reason: '', researchText: null, billableSearches: 0,
      })
    }
  }
  return out
}

// ─── 1. A FIGURE WITH ITS INTERVAL ───────────────────────────────────────────

describe('a fit figure never travels without its interval', () => {
  it('reports an interval alongside every figure it reports', () => {
    const out = assessFit(rows({ best: 20, acceptable: 10, neither: 20, cannot_establish: 30 }))
    expect(out.fitOfResolved).toBeCloseTo(30 / 50)
    expect(out.interval).not.toBeNull()
    expect(out.interval!.low).toBeLessThan(out.fitOfResolved!)
    expect(out.interval!.high).toBeGreaterThan(out.fitOfResolved!)
    // And it is in the human-readable note too, because that is what an operator reads.
    expect(out.note).toContain('95% interval')
  })

  it('reports no interval when it reports no figure', () => {
    // NULL, NEVER A WIDE INTERVAL AROUND NOTHING. An interval implies a measurement was made.
    const out = assessFit(rows({ best: 5, neither: 5, cannot_establish: 70 }))
    expect(out.fitOfResolved).toBeNull()
    expect(out.interval).toBeNull()
  })

  it('the interval is wider on a small sample than on a large one, at the same rate', () => {
    // This is the whole reason for reporting it: 50% of 20 and 50% of 200 are the same number
    // and not the same fact.
    const small = wilsonInterval(10, 20)
    const large = wilsonInterval(100, 200)
    expect(large.high - large.low).toBeLessThan(small.high - small.low)
  })

  it('stays inside 0 and 1 where the textbook formula does not', () => {
    // p ± 1.96·sqrt(p(1-p)/n) is the one everyone remembers, and at a rate near the end of the
    // scale it reports intervals like "-4% to 11%". Wilson is used precisely because this loop
    // lives at small n and lopsided rates.
    for (const [successes, n] of [[0, 12], [12, 12], [1, 30], [29, 30]] as const) {
      const w = wilsonInterval(successes, n)
      expect(w.low).toBeGreaterThanOrEqual(0)
      expect(w.high).toBeLessThanOrEqual(1)
      expect(w.high).toBeGreaterThan(w.low)
    }
  })

  it('a rate of 1 on few rows does not claim certainty', () => {
    // Twelve of twelve is not "100%, settled". A caller reading a bare 1.0 would conclude it was.
    const w = wilsonInterval(12, 12)
    expect(w.low).toBeLessThan(0.9)
  })
})

// ─── 2. LIMITS THAT MOVE WITH THE SAMPLE ASKED FOR ───────────────────────────

describe('the minimum rows move with the sample that was asked for', () => {
  it('lets a small sample report a figure that a fixed minimum refused outright', () => {
    // A run asked for 30 resolves about 20 of them, which the old fixed 25 could almost never
    // reach: 15% to 40% of rows resolve to nothing. So a run asked for 30 reported nothing at
    // all, every time, and the sample size was effectively not a parameter.
    const out = assessFit(rows({ best: 8, neither: 6, cannot_establish: 16 }), 30)
    expect(out.resolved).toBe(14)
    expect(out.resolved).toBeLessThan(MIN_RESOLVED_FOR_A_FIGURE)
    expect(out.fitOfResolved).not.toBeNull()
    expect(out.interval).not.toBeNull()
  })

  it('still refuses the SAME resolved count when the sample asked for was large', () => {
    // 14 rows out of 30 is a thin measurement. 14 rows out of 80 is two thirds of the sample
    // vanishing, and a figure would describe the third that did not.
    const out = assessFit(rows({ best: 8, neither: 6, cannot_establish: 66 }), 80)
    expect(out.resolved).toBe(14)
    expect(out.fitOfResolved).toBeNull()
    expect(out.note).toContain('for a sample of 80')
  })

  it('holds the floor so a tiny sample cannot buy a figure by being tiny', () => {
    // Without a floor, a sample of 4 would need 2 resolved rows and report a proportion on them.
    expect(minResolvedFor(4)).toBe(MIN_RESOLVED_FLOOR)
    expect(minResolvedFor(1)).toBe(MIN_RESOLVED_FLOOR)
    const out = assessFit(rows({ best: 3, neither: 1 }), 4)
    expect(out.fitOfResolved).toBeNull()
  })

  it('asks of a large sample what it asked of the default, proportionally', () => {
    // The share is the old fixed minimum expressed against the sample it was chosen for, so the
    // default is unchanged and everything else is scaled rather than inheriting a number meant
    // for 80 rows.
    expect(minResolvedFor(DEFAULT_SAMPLE_SIZE)).toBe(MIN_RESOLVED_FOR_A_FIGURE)
    expect(minResolvedFor(400)).toBe(Math.ceil(400 * MIN_RESOLVED_SHARE))
    expect(minResolvedFor(400)).toBeGreaterThan(MIN_RESOLVED_FOR_A_FIGURE)
  })

  it('defaults to judging the sample it was actually given', () => {
    // A caller that passes nothing gets the honest denominator rather than the default of 80,
    // which would refuse every short draw.
    const judged = rows({ best: 8, neither: 6 })
    expect(assessFit(judged).fitOfResolved).toBe(assessFit(judged, judged.length).fitOfResolved)
  })
})

// ─── 4. THE RESULT IS WRITTEN DOWN ───────────────────────────────────────────
//
// (3, the stored-conditions rubric and the sample-aware population gate, is exercised end to
// end through runSearchTuner in stored-conditions-rubric.test.ts, which needs a different set
// of module mocks than this file.)

// WRITTEN OUT IN FULL, NOT CAST. `as RoundReport` over a partial literal would switch off the
// one check that notices when the shape gains a field the writer should be storing.
function roundWithFit(index: number, fit: FitOutcome | null): RoundReport {
  return {
    index, kind: index === 0 ? 'zero' : 'adjust',
    reachable: 5000, ceiling: 9000,
    fit, fitIncludingNameDecided: fit, nameSignal: null, judged: [],
    changeDescription: 'placeholder', comparisonNote: null, audienceNote: null,
    billableSearches: 3, modelCalls: 1, providerCalls: 2, cost: null,
  }
}

function resultWith(rounds: RoundReport[]): SearchTunerResult {
  return {
    terminalState: 'no_combination_reached_the_standard',
    terminalReason: 'placeholder reason',
    rounds,
    baselineReachable: 5000, ceilingReachable: 9000,
    proposal: null,
    documentMarker: { documentId: 'doc-1', version: '4', updatedAt: new Date(0).toISOString() },
    noiseFloor: 0.19,
    billableSearches: 6, modelCalls: 2, providerCalls: 4,
    notes: [], consumedBy: 'nothing',
  }
}

/** Records what reached each table, and honours nothing it does not implement. */
function recordingSupabase() {
  const writes: Record<string, unknown[]> = { tuning_runs: [], tuning_rounds: [] }
  const client = {
    from: (table: string) => ({
      insert: (payload: unknown) => {
        writes[table] ??= []
        writes[table].push(payload)
        return {
          select: () => ({ single: async () => ({ data: { id: 'run-written' }, error: null }) }),
          then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
        }
      },
    }),
  } as unknown as SupabaseClient
  return { client, writes }
}

describe('a run is persisted so the next one has something to compare against', () => {
  const persist = (result: SearchTunerResult, over: Partial<{ sampleSize: number; rubricSource: 'stored_conditions' | 'derived_this_run' }> = {}) => {
    const { client, writes } = recordingSupabase()
    return writeSearchTunerRecord({
      supabase: client, organisationId: 'org-under-test', result,
      startedAt: new Date(0).toISOString(),
      sampleSize: over.sampleSize ?? DEFAULT_SAMPLE_SIZE,
      rubricSource: over.rubricSource ?? 'stored_conditions',
    }).then(r => ({ ...r, writes }))
  }

  it('writes the figure, the interval and the rows it was computed from', async () => {
    const fit = assessFit(rows({ best: 20, acceptable: 10, neither: 20, cannot_establish: 30 }))
    const { runId, writes } = await persist(resultWith([roundWithFit(0, null), roundWithFit(1, fit)]))

    expect(runId).toBe('run-written')
    const run = writes.tuning_runs[0] as Record<string, unknown>
    expect(run.fit_of_resolved).toBeCloseTo(0.6)
    // THE INTERVAL IS STORED, NOT RECOMPUTED ON READ. A later reader re-deriving it would be
    // re-deriving from counts produced by whatever the resolution rules were at the time.
    expect(run.fit_interval_low).toBeCloseTo(fit.interval!.low)
    expect(run.fit_interval_high).toBeCloseTo(fit.interval!.high)
    expect(run.fit_resolved_rows).toBe(50)
    expect(run.fit_sampled_rows).toBe(80)
    expect(run.sample_size).toBe(DEFAULT_SAMPLE_SIZE)
  })

  it('records WHICH STANDARD the rate was measured against', async () => {
    // A rate graded against a rubric derived for that run alone cannot be compared with one
    // graded against the client's stored conditions. Without this column a reader comparing two
    // runs cannot tell whether the search moved or the standard did.
    const fit = assessFit(rows({ best: 30, neither: 20, cannot_establish: 30 }))
    const stored = await persist(resultWith([roundWithFit(1, fit)]), { rubricSource: 'stored_conditions' })
    const derived = await persist(resultWith([roundWithFit(1, fit)]), { rubricSource: 'derived_this_run' })

    expect((stored.writes.tuning_runs[0] as Record<string, unknown>).rubric_source).toBe('stored_conditions')
    expect((derived.writes.tuning_runs[0] as Record<string, unknown>).rubric_source).toBe('derived_this_run')
  })

  it('records the sample ASKED FOR beside the rows actually drawn', async () => {
    // A short draw and a full one are different measurements. Storing only what was drawn hides
    // that a run asked for 80 and the provider could only fill 41.
    const fit = assessFit(rows({ best: 20, neither: 15, cannot_establish: 6 }), 80)
    const { writes } = await persist(resultWith([roundWithFit(1, fit)]), { sampleSize: 80 })

    const run = writes.tuning_runs[0] as Record<string, unknown>
    expect(run.sample_size).toBe(80)
    expect(run.fit_sampled_rows).toBe(41)
    expect(run.sample_size).not.toBe(run.fit_sampled_rows)
  })

  it('takes the LAST round that produced a figure, not the first and not an empty one', async () => {
    // Round zero measures the population and judges nobody. A run row carrying its null would
    // record every run as unmeasured.
    const early = assessFit(rows({ best: 10, neither: 40, cannot_establish: 30 }))
    const late = assessFit(rows({ best: 40, neither: 10, cannot_establish: 30 }))
    const { writes } = await persist(resultWith([
      roundWithFit(0, null), roundWithFit(1, early), roundWithFit(2, late),
    ]))

    expect((writes.tuning_runs[0] as Record<string, unknown>).fit_of_resolved).toBeCloseTo(0.8)
  })

  it('writes every round, so a reader can disagree with the rate and not only with the number', async () => {
    const fit = assessFit(rows({ best: 30, neither: 20, cannot_establish: 30 }))
    const { writes } = await persist(resultWith([roundWithFit(0, null), roundWithFit(1, fit)]))

    expect((writes.tuning_rounds[0] as unknown[]).length).toBe(2)
  })

  it('reports the run rather than disappearing when the write fails', async () => {
    // A run that completed and then failed to write should still be reported: the caller has the
    // result in hand, and an error for work that succeeded is worse than a warning.
    const failing = {
      from: () => ({
        insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'no such column' } }) }) }),
      }),
    } as unknown as SupabaseClient

    const fit = assessFit(rows({ best: 30, neither: 20, cannot_establish: 30 }))
    await expect(writeSearchTunerRecord({
      supabase: failing, organisationId: 'org-under-test', result: resultWith([roundWithFit(1, fit)]),
      startedAt: new Date(0).toISOString(), sampleSize: 80, rubricSource: 'stored_conditions',
    })).resolves.toEqual({ runId: null })
  })

  it('does not throw when the client itself throws', async () => {
    const throwing = { from: () => { throw new Error('connection reset') } } as unknown as SupabaseClient
    await expect(writeSearchTunerRecord({
      supabase: throwing, organisationId: 'org-under-test', result: resultWith([]),
      startedAt: new Date(0).toISOString(), sampleSize: 80, rubricSource: 'stored_conditions',
    })).resolves.toEqual({ runId: null })
  })
})

beforeEach(() => vi.clearAllMocks())
