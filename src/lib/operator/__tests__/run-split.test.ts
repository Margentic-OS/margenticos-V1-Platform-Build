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
    expect(line).toBe('35 from the run on 17 Sep 2026, 27 carried over from earlier runs.')
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
      'None of these came from the run on 17 Sep 2026. All 27 carried over from earlier runs.',
    )
    expect(line?.startsWith('0')).toBe(false)
  })

  it('falls back to naming the run without a date rather than rendering an empty one', () => {
    const line = describeRunSplit({ total: 62, fromLatestRun: 35, latestRunStartedAt: null })
    expect(line).toBe('35 from the most recent run, 27 carried over from earlier runs.')
    expect(line).not.toContain('null')
    expect(line).not.toContain('Invalid')
  })
})
