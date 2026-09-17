// "Nothing to research — all N prospects were filtered out". Item 7.
//
// Two things about that N were being misread: it spans every sourcing run the client has
// ever had, and it is a different population from the "Removed" card, which counts tiering
// disqualifications. Neither was stated, so an operator compared the two, found they did not
// match, and had no way to know that was correct.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/queue/__tests__/research-filtered-out-message.test.ts

import { describe, it, expect } from 'vitest'
import { describeResearchSelection, type ResearchSelection } from '../enqueue/research'

function selection(over: Partial<ResearchSelection> = {}): ResearchSelection {
  return {
    scope: 'unresearched',
    selected: 41,
    withTrigger: 0,
    eligible: 0,
    skippedReasons: Array(41).fill('unresolved_catch_all'),
    skippedLiveElsewhere: 0,
    enqueueable: [],
    enqueueableByRun: {},
    ...over,
  } as ResearchSelection
}

describe('the message shown when every prospect was filtered out', () => {
  const blocked = () => describeResearchSelection(selection(), 'research').blocked ?? ''

  it('still carries the count', () => {
    expect(blocked()).toContain('41')
  })

  it('says the count spans every sourcing run, not just the latest', () => {
    expect(blocked()).toMatch(/across every sourcing run/)
  })

  it('says they are excluded rather than queued', () => {
    const text = blocked()
    expect(text).toMatch(/excluded from research, not queued for it/)
    expect(text).toMatch(/nothing will pick them up on its own/)
  })

  // The two numbers will never agree, and an operator needs to know that is by design
  // rather than a fault. The Removed card counts tiering disqualifications; this counts
  // addresses we cannot use.
  it('says explicitly that this is not the Removed card', () => {
    const text = blocked()
    expect(text).toMatch(/different group from the Removed card/)
    expect(text).toMatch(/not meant to match/)
  })

  it('keeps the reason breakdown that explains the count', () => {
    expect(blocked()).toContain('catch')
  })

  // THE CONTROL. This wording belongs to the everything-filtered-out branch only; the
  // other refusals must not acquire it.
  it('does not attach the explanation to an empty population', () => {
    const text = describeResearchSelection(
      selection({ selected: 0, skippedReasons: [] }),
      'research',
    ).blocked ?? ''
    expect(text).toMatch(/already been researched/)
    expect(text).not.toMatch(/Removed card/)
  })

  it('does not attach it to the trigger guard', () => {
    const text = describeResearchSelection(
      selection({ withTrigger: 5, eligible: 5 }),
      'research',
    ).blocked ?? ''
    expect(text).toMatch(/personalisation trigger/)
    expect(text).not.toMatch(/Removed card/)
  })
})

describe('the run split travels with the verdict', () => {
  it('reports which run the actionable prospects came from', () => {
    const verdict = describeResearchSelection(
      selection({
        eligible: 3,
        skippedReasons: [],
        enqueueable: ['p1', 'p2', 'p3'],
        enqueueableByRun: { 'run-a': 2, 'run-b': 1 },
      }),
      'research',
    )
    expect(verdict.actionable).toBe(3)
    expect(verdict.actionableByRun).toEqual({ 'run-a': 2, 'run-b': 1 })
  })

  // The split must be emptied by whatever zeroes the count beside it, or the screen could
  // show a breakdown of work the click refuses.
  it('empties the split whenever the verdict is blocked', () => {
    const verdict = describeResearchSelection(
      selection({
        withTrigger: 2,
        eligible: 3,
        enqueueable: ['p1', 'p2', 'p3'],
        enqueueableByRun: { 'run-a': 3 },
      }),
      'research',
    )
    expect(verdict.actionable).toBe(0)
    expect(verdict.actionableByRun).toEqual({})
  })
})
