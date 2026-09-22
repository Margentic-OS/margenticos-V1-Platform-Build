// Does a count say which sourcing runs it covers?
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/operator/__tests__/run-split.test.ts

import { describe, it, expect } from 'vitest'
import { describeRunSplit } from '../run-split'

const RUN_DAY = '2026-09-17T19:47:56Z'

describe('describeRunSplit', () => {
  it('names both parts when a count spans more than one run', () => {
    const line = describeRunSplit({ total: 62, fromLatestRun: 35, latestRunStartedAt: RUN_DAY })
    expect(line).toBe('35 from the run on 17 Sep 2026 at 19:47 UTC, 27 carried over from earlier runs.')
  })

  // ── SILENT WHERE THERE IS NOTHING TO DISCLOSE ──────────────────────────────
  //
  // The rule is "say so when it spans more than one run", not "annotate everything".
  // Annotating a single-batch client would bury the cases that matter.
  it('says nothing when the whole count came from the latest run', () => {
    expect(describeRunSplit({ total: 35, fromLatestRun: 35, latestRunStartedAt: RUN_DAY })).toBeNull()
  })

  it('says nothing about a zero count', () => {
    expect(describeRunSplit({ total: 0, fromLatestRun: 0, latestRunStartedAt: RUN_DAY })).toBeNull()
  })

  // A caller that cannot attribute anything passes the total through, which must not
  // produce "0 carried over" noise.
  it('says nothing when the split would be negative', () => {
    expect(describeRunSplit({ total: 10, fromLatestRun: 12, latestRunStartedAt: RUN_DAY })).toBeNull()
  })

  it('words the all-carried-over case without opening on a zero', () => {
    const line = describeRunSplit({ total: 27, fromLatestRun: 0, latestRunStartedAt: RUN_DAY })
    expect(line).toBe(
      'None of these came from the run on 17 Sep 2026 at 19:47 UTC. All 27 carried over from earlier runs.',
    )
    expect(line?.startsWith('0')).toBe(false)
  })

  // ── THE CASE THE DATE-ONLY LABEL COULD NOT DESCRIBE ────────────────────────
  //
  // Measured on the live database: 2026-09-21 holds THREE runs for one client, at 15:38,
  // 15:42 and 15:48 UTC. Under the old wording all three were "the run on 21 Sep 2026", so
  // a prospect from the 15:38 run was reported as carried over from an earlier run with no
  // way to see that the earlier run was twelve minutes before this one. The two labels must
  // differ, and the clock is the only thing that can make them.
  it('tells two runs on the same day apart', () => {
    const first = describeRunSplit({
      total: 40, fromLatestRun: 13, latestRunStartedAt: '2026-09-21T15:38:47Z',
    })
    const third = describeRunSplit({
      total: 40, fromLatestRun: 13, latestRunStartedAt: '2026-09-21T15:48:19Z',
    })

    expect(first).toContain('21 Sep 2026 at 15:38 UTC')
    expect(third).toContain('21 Sep 2026 at 15:48 UTC')
    expect(first).not.toBe(third)
  })

  // A date with no clock in it is a day, not a moment. Rendering "at 00:00 UTC" would assert
  // a run time nothing recorded, so the label keeps its date-only wording instead.
  it('adds no clock to a date that carries none', () => {
    const line = describeRunSplit({ total: 62, fromLatestRun: 35, latestRunStartedAt: '2026-09-17' })
    expect(line).toBe('35 from the run on 17 Sep 2026, 27 carried over from earlier runs.')
    expect(line).not.toContain('00:00')
  })

  // An unparseable timestamp must not produce "at Invalid Date" or drop the sentence.
  it('keeps the sentence when the timestamp cannot be read', () => {
    const line = describeRunSplit({ total: 62, fromLatestRun: 35, latestRunStartedAt: 'not a date' })
    expect(line).toContain('35 from the run on')
    expect(line).not.toContain('Invalid')
    expect(line).not.toContain('NaN')
  })

  it('falls back to naming the run without a date rather than rendering an empty one', () => {
    const line = describeRunSplit({ total: 62, fromLatestRun: 35, latestRunStartedAt: null })
    expect(line).toBe('35 from the most recent run, 27 carried over from earlier runs.')
    expect(line).not.toContain('null')
    expect(line).not.toContain('Invalid')
  })
})
