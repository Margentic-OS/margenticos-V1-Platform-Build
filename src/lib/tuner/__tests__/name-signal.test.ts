// Deciding a company from its employer name, and measuring whether that was worth doing.
//
// ─── RULE ZERO GOVERNS THIS FILE AS MUCH AS THE PROMPT ───────────────────────
//
// No word, phrase, sector, product, buyer type or company name here may indicate WHAT A NAME
// MEANS. Every name below is an invented placeholder, and every client description is an
// invented placeholder. The point of the placeholders is not squeamishness: a fixture that
// carried a real word would be asserting a general rule about names, and the whole design
// says no such rule exists independently of a client's own document.
//
// The sharpest test of that is the last one in this file: the SAME name is decided one way
// for one client and the opposite way for another, and nothing in the module objects,
// because nothing in the module has an opinion about the name.

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'

const drawSpreadSample = vi.hoisted(() => vi.fn())
const lookUpMany = vi.hoisted(() => vi.fn())
const create = vi.hoisted(() => vi.fn())

// Only the CLIENT is replaced. The module also exports error classes other code does
// instanceof checks against, and a mock that drops them turns a failure path into a
// TypeError from inside the error handler rather than the behaviour under test.
vi.mock('@anthropic-ai/sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  default: class { messages = { create } },
}))

vi.mock('@/lib/tuner/spread-sample', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  drawSpreadSample,
}))
vi.mock('@/lib/tuner/lookup', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  lookUpMany,
}))

import {
  anthropicNameSignal, buildNameSignalPrompt, parseNameSignal, checkNameSignal, isDecided,
  oneVerdictWorth, type NameSignalFn,
} from '@/lib/tuner/name-signal'
import { runOneRound } from '@/lib/tuner/search-tuner'
import { assessFit, MIN_FIT_IMPROVEMENT, type FitContext, type FitJudgeFn } from '@/lib/tuner/fit-judge'
import { ProviderBudget } from '@/lib/tuner/count-and-sample'
import { SpendBudget } from '@/lib/tuner/run-budget'
import { LookupBudget } from '@/lib/tuner/lookup'

beforeAll(() => { process.env.ANTHROPIC_API_KEY = 'test-key-not-a-credential' })
afterEach(() => { vi.clearAllMocks() })

/** Invented. Says nothing about any real market. */
const CLIENT_A: FitContext = {
  sells: 'placeholder offering alpha',
  usedFor: 'placeholder purpose alpha',
  bestDescription: 'placeholder best-customer description alpha',
  acceptableDescription: 'placeholder acceptable-customer description alpha',
}
const CLIENT_B: FitContext = {
  sells: 'placeholder offering beta',
  usedFor: 'placeholder purpose beta',
  bestDescription: 'placeholder best-customer description beta',
  acceptableDescription: 'placeholder acceptable-customer description beta',
}

const row = (n: number) => ({
  sourceId: `id-${n}`, firstName: null, jobTitle: 'placeholder title', companyName: `Placeholder Org ${n}`,
})
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i))

const lookupResult = () => ({
  text: 'A placeholder description long enough to clear the usability floor this module keeps.',
  limited: false, billableSearches: 1, inputTokens: 9600, outputTokens: 150,
  model: 'claude-haiku-4-5-20251001',
})

/** Everything researched comes back with one verdict, so the researched rate is controllable. */
const judgeAlways = (verdict: 'best' | 'neither'): FitJudgeFn => async (rs) => ({
  verdicts: rs.map(r => ({ sourceId: r.sourceId, verdict, reason: 'placeholder reason' })),
  modelCalls: 1,
  usage: { inputTokens: 100, outputTokens: 10, model: 'claude-sonnet-4-6' },
})

/** Deterministic by index, so re-judging the same rows measures a variation of exactly zero. */
const judgeAlternating: FitJudgeFn = async (rs) => ({
  verdicts: rs.map((r, i) => ({ sourceId: r.sourceId, verdict: i % 2 === 0 ? 'best' as const : 'neither' as const, reason: 'placeholder reason' })),
  modelCalls: 1,
  usage: { inputTokens: 100, outputTokens: 10, model: 'claude-sonnet-4-6' },
})

const nameSaysFor = (map: (i: number) => 'best' | 'acceptable' | 'neither' | 'unclear'): NameSignalFn =>
  async (rs) => ({
    decisions: rs.map((r, i) => ({ sourceId: r.sourceId, answer: map(i), reason: 'placeholder reason' })),
    modelCalls: 1,
    usage: { inputTokens: 100, outputTokens: 10, model: 'claude-haiku-4-5-20251001' },
  })

async function round(opts: {
  n: number; nameSignal: NameSignalFn; fitJudge: FitJudgeFn; useNameSignal?: boolean
}) {
  const sample = rows(opts.n)
  drawSpreadSample.mockResolvedValue({ rows: sample, total: 5000 })
  lookUpMany.mockImplementation(async (names: unknown[]) => names.map(() => lookupResult()))
  return runOneRound({
    index: 1, request: {}, provider: new ProviderBudget(600),
    spend: new SpendBudget(10_000, 1000), lookups: new LookupBudget(10_000),
    sampleSize: opts.n, context: CLIENT_A,
    fitJudge: opts.fitJudge, random: () => 0.5,
    useNameSignal: opts.useNameSignal ?? true, nameSignal: opts.nameSignal,
  })
}

describe('the prompt carries no view about what a name means', () => {
  it('is built entirely from the client descriptions handed to it', () => {
    const a = buildNameSignalPrompt(CLIENT_A)
    for (const v of Object.values(CLIENT_A)) expect(a).toContain(v)
  })

  it('reaches a different prompt for a different client, with nothing shared but the frame', () => {
    // If any judgement about names lived in this module, it would survive changing the
    // client. Nothing of client A's may appear in client B's prompt.
    const b = buildNameSignalPrompt(CLIENT_B)
    for (const v of Object.values(CLIENT_A)) expect(b).not.toContain(v)
    for (const v of Object.values(CLIENT_B)) expect(b).toContain(v)
  })

  it('offers no-signal as a first-class answer rather than a failure', () => {
    const a = buildNameSignalPrompt(CLIENT_A)
    expect(a).toContain('THIS IS THE COMMON ANSWER AND IT IS A CORRECT ONE')
  })
})

describe('anything that is not a clear answer means research it', () => {
  it('passes the three deciding answers through', () => {
    const raw = JSON.stringify({ decisions: [
      { id: 'id-0', answer: 'best', reason: 'r' },
      { id: 'id-1', answer: 'acceptable', reason: 'r' },
      { id: 'id-2', answer: 'neither', reason: 'r' },
    ] })
    expect(parseNameSignal(raw).map(d => d.answer)).toEqual(['best', 'acceptable', 'neither'])
  })

  it('turns an invented answer into research, not into a verdict', () => {
    const raw = JSON.stringify({ decisions: [{ id: 'id-0', answer: 'definitely_a_customer', reason: 'r' }] })
    expect(parseNameSignal(raw)[0].answer).toBe('unclear')
    expect(isDecided(parseNameSignal(raw)[0].answer)).toBe(false)
  })

  it('turns a missing or wrongly-typed answer into research', () => {
    expect(parseNameSignal(JSON.stringify({ decisions: [{ id: 'id-0' }] }))[0].answer).toBe('unclear')
    expect(parseNameSignal(JSON.stringify({ decisions: [{ id: 'id-0', answer: true }] }))[0].answer).toBe('unclear')
  })

  it('returns nothing at all from malformed output, which the caller reads as research', () => {
    expect(parseNameSignal('not json')).toEqual([])
    expect(parseNameSignal('{"decisions": "not an array"}')).toEqual([])
  })
})

describe('a name with no clear signal is always researched', () => {
  it('researches every row when every name is unclear, and decides none', async () => {
    const r = await round({ n: 10, nameSignal: nameSaysFor(() => 'unclear'), fitJudge: judgeAlways('best') })

    expect(r.nameSignal!.decided).toBe(0)
    expect(r.nameSignal!.researched).toBe(10)
    expect(r.cost!.lookupsMade).toBe(10)
    expect(r.judged!.every(j => j.researchText !== null)).toBe(true)
  })

  it('researches a name even when the answer looks like a confident approval of the wrong shape', async () => {
    // The model returning something that is not one of the three deciding strings must not
    // remove a row from the research set, however confident it sounds.
    const r = await round({
      n: 6,
      nameSignal: async (rs) => ({
        decisions: rs.map(x => ({ sourceId: x.sourceId, answer: 'perfect_customer' as never, reason: 'r' })),
        modelCalls: 1,
      }),
      fitJudge: judgeAlways('best'),
    })
    expect(r.nameSignal!.decided).toBe(0)
    expect(r.cost!.lookupsMade).toBe(6)
  })
})

describe('the two figures are kept apart, and neither is the round on its own', () => {
  it('reports both, and they are genuinely different numbers', async () => {
    // Two rows are decided from a name, both one way. The other forty are researched and come
    // back half and half, so the researched rate is 50.0% and the combined rate is 22/42, or
    // 52.4%. That is 2.4 points against a floor of one verdict in forty, 2.5 points, so it is
    // INSIDE the floor. That is the only state in which two separate figures survive to be
    // reported: past the floor the round falls back and they collapse into one.
    const r = await round({
      n: 42,
      nameSignal: nameSaysFor(i => (i < 2 ? 'best' : 'unclear')),
      fitJudge: judgeAlternating,
    })

    expect(r.nameSignal!.fellBackToResearchingEverything).toBe(false)
    expect(r.fit!.fitOfResolved).toBeCloseTo(0.5, 5)
    expect(r.fitIncludingNameDecided!.fitOfResolved).toBeCloseTo(22 / 42, 5)
    // Two figures, not one number, and not the same object either.
    expect(r.fit).not.toBe(r.fitIncludingNameDecided)
  })

  it('a name-decided row carries no research and costs no searches', async () => {
    const r = await round({
      n: 80,
      nameSignal: nameSaysFor(i => (i < 4 ? 'neither' : 'unclear')),
      fitJudge: judgeAlways('neither'),
    })
    const byName = r.judged!.filter(j => j.reason.startsWith('Decided from the employer name'))
    expect(byName).toHaveLength(4)
    expect(byName.every(j => j.researchText === null)).toBe(true)
    expect(byName.every(j => j.billableSearches === 0)).toBe(true)
  })
})

describe('the reliability check', () => {
  const outcome = (best: number, neither: number) => assessFit(
    [
      ...Array.from({ length: best }, (_, i) => ({ sourceId: `b${i}`, jobTitle: null, companyName: null, verdict: 'best' as const, reason: '', researchText: null, billableSearches: 0 })),
      ...Array.from({ length: neither }, (_, i) => ({ sourceId: `n${i}`, jobTitle: null, companyName: null, verdict: 'neither' as const, reason: '', researchText: null, billableSearches: 0 })),
    ],
  )

  it('says nothing to disagree with when no name decided anything', () => {
    const v = checkNameSignal(outcome(30, 30), outcome(30, 30), 0, MIN_FIT_IMPROVEMENT)
    expect(v.reliable).toBe(true)
    expect(v.differenceOnResolved).toBeNull()
  })

  it('accepts a difference inside the judge\'s own variation', () => {
    const v = checkNameSignal(outcome(30, 30), outcome(32, 30), 2, MIN_FIT_IMPROVEMENT)
    expect(v.reliable).toBe(true)
    expect(v.differenceOnResolved!).toBeLessThanOrEqual(MIN_FIT_IMPROVEMENT)
  })

  it('rejects a difference larger than it', () => {
    const v = checkNameSignal(outcome(60, 0), outcome(60, 60), 60, MIN_FIT_IMPROVEMENT)
    expect(v.reliable).toBe(false)
    expect(v.reason).toContain('NAME SIGNAL IS UNRELIABLE FOR THIS CLIENT')
  })

  it('does NOT treat an impossible comparison as a pass', () => {
    // Nothing resolved on one side, so no rate exists. An unmeasured agreement is not an
    // agreement; this must fall back rather than sail through.
    const nothing = assessFit([{ sourceId: 'x', jobTitle: null, companyName: null, verdict: 'cannot_establish', reason: '', researchText: null, billableSearches: 0 }])
    const v = checkNameSignal(nothing, outcome(10, 10), 20, MIN_FIT_IMPROVEMENT)
    expect(v.reliable).toBe(false)
  })
})

describe('the fallback fires, and researches everything', () => {
  it('pays for the name-decided rows too once the two figures disagree', async () => {
    // Every researched row is 'best'; every name-decided row says 'neither'. The rates are
    // 100% and 50%, which is 50 points against a floor of 19.
    const r = await round({
      n: 80,
      nameSignal: nameSaysFor(i => (i < 40 ? 'neither' : 'unclear')),
      fitJudge: judgeAlways('best'),
    })

    expect(r.nameSignal!.fellBackToResearchingEverything).toBe(true)
    expect(r.nameSignal!.verdict.reliable).toBe(false)
    // The saving is given up: every one of the twenty is researched.
    expect(r.cost!.lookupsMade).toBe(80)
    expect(r.cost!.nameDecided).toBe(0)
    expect(r.nameSignal!.decidedBeforeFallback).toBe(40)
    expect(r.judged!.every(j => j.researchText !== null)).toBe(true)
    // Both figures now cover the same rows, and are reported as two regardless.
    expect(r.fit!.fitOfResolved).toBe(r.fitIncludingNameDecided!.fitOfResolved)
  })

  it('does not fire, and keeps the saving, when the names agree', async () => {
    const r = await round({
      n: 80,
      nameSignal: nameSaysFor(i => (i < 40 ? 'best' : 'unclear')),
      fitJudge: judgeAlways('best'),
    })

    expect(r.nameSignal!.fellBackToResearchingEverything).toBe(false)
    expect(r.nameSignal!.verdict.reliable).toBe(true)
    expect(r.cost!.lookupsMade).toBe(40)
    expect(r.cost!.nameDecided).toBe(40)
  })
})

describe('the floor is the judge\'s own variation, measured, not a borrowed constant', () => {
  it('fails a difference that a stable judge makes significant', async () => {
    // The judge here is perfectly stable: every row comes back the same verdict every time,
    // so its measured variation is zero and the floor drops to one verdict's worth. A modest
    // name-driven shift that would sail past the 19-point draw-to-draw floor must now fail.
    //
    // This is the case that was passing on live data when it should not have been.
    const r = await round({
      n: 80,
      nameSignal: nameSaysFor(i => (i < 40 ? 'best' : 'unclear')),
      fitJudge: judgeAlways('neither'),
    })

    expect(r.nameSignal!.verdict.reliable).toBe(false)
    expect(r.nameSignal!.verdict.noiseFloor).toBeLessThan(MIN_FIT_IMPROVEMENT)
    expect(r.nameSignal!.fellBackToResearchingEverything).toBe(true)
  })

  it('does not spend a call measuring a floor it has nothing to use on', async () => {
    // Nothing was decided from a name, so there is nothing to validate. The extra judging
    // pass must not happen: an instrument that runs when there is nothing to measure is just
    // a cost.
    const withNames = await round({
      n: 80, nameSignal: nameSaysFor(i => (i < 40 ? 'best' : 'unclear')), fitJudge: judgeAlways('best'),
    })
    const withoutNames = await round({
      n: 80, nameSignal: nameSaysFor(() => 'unclear'), fitJudge: judgeAlways('best'),
    })
    expect(withoutNames.modelCalls).toBeLessThan(withNames.modelCalls)
  })

  it('never lets the floor fall to zero', () => {
    // A re-run that happens to agree exactly gives a measured variation of zero, and a zero
    // floor fails every round including the honest ones.
    expect(oneVerdictWorth(40)).toBeCloseTo(0.025, 6)
    expect(oneVerdictWorth(0)).toBe(1)
  })
})

describe('too small to measure is not the same as measured and fine', () => {
  it('falls back when there are too few settled rows for a rate to exist', async () => {
    // Below the fit judge's own minimum for reporting a proportion, no rate exists on either
    // side, so the two figures cannot be compared. That must fall back rather than sail
    // through: an agreement that was never measured is not an agreement.
    const r = await round({
      n: 12,
      nameSignal: nameSaysFor(i => (i < 6 ? 'best' : 'unclear')),
      fitJudge: judgeAlways('best'),
    })

    expect(r.nameSignal!.verdict.reliable).toBe(false)
    expect(r.nameSignal!.fellBackToResearchingEverything).toBe(true)
    expect(r.cost!.lookupsMade).toBe(12)
  })
})

describe('the same name may be decided oppositely for two clients', () => {
  it('holds no opinion of its own about any name', async () => {
    // The module is handed the same employer name twice and told opposite things about it.
    // Neither call objects, because there is no rule in the module for either to violate.
    const sameName = [row(0)]
    drawSpreadSample.mockResolvedValue({ rows: sameName, total: 100 })
    lookUpMany.mockImplementation(async (names: unknown[]) => names.map(() => lookupResult()))

    const forClient = async (context: FitContext, answer: 'best' | 'neither') => runOneRound({
      index: 1, request: {}, provider: new ProviderBudget(600),
      spend: new SpendBudget(10_000, 1000), lookups: new LookupBudget(10_000),
      sampleSize: 1, context,
      fitJudge: judgeAlways(answer === 'best' ? 'best' : 'neither'), random: () => 0.5,
      useNameSignal: true,
      nameSignal: async (rs) => ({
        decisions: rs.map(x => ({ sourceId: x.sourceId, answer, reason: 'placeholder reason' })),
        modelCalls: 1,
      }),
    })

    const a = await forClient(CLIENT_A, 'best')
    const b = await forClient(CLIENT_B, 'neither')
    expect(a.judged![0].verdict).toBe('best')
    expect(b.judged![0].verdict).toBe('neither')
    expect(a.judged![0].companyName).toBe(b.judged![0].companyName)
  })
})


describe('a row the model never answered for is researched, not decided', () => {
  it('defaults a missing row to unclear even when every other row was decided', async () => {
    // The model is given three names and answers for two of them. The third must come back
    // as something that costs a lookup. Anything else means a company was placed against a
    // client's document on the strength of the model having forgotten it.
    create.mockResolvedValue({
      model: 'claude-haiku-4-5-20251001',
      usage: { input_tokens: 100, output_tokens: 20 },
      content: [{ type: 'text', text: JSON.stringify({ decisions: [
        { id: 'id-0', answer: 'best', reason: 'placeholder reason' },
        { id: 'id-1', answer: 'neither', reason: 'placeholder reason' },
      ] }) }],
    })

    const { decisions } = await anthropicNameSignal(rows(3), CLIENT_A)
    const missing = decisions.find(d => d.sourceId === 'id-2')!

    expect(missing.answer).toBe('unclear')
    expect(isDecided(missing.answer)).toBe(false)
    expect(missing.reason).toContain('researched as normal')
  })

  it('researches every row when the model answers for none of them', async () => {
    create.mockResolvedValue({
      model: 'claude-haiku-4-5-20251001',
      usage: { input_tokens: 100, output_tokens: 20 },
      content: [{ type: 'text', text: 'the model said something that is not JSON at all' }],
    })

    const { decisions } = await anthropicNameSignal(rows(5), CLIENT_A)
    expect(decisions).toHaveLength(5)
    expect(decisions.every(d => d.answer === 'unclear')).toBe(true)
  })
})
