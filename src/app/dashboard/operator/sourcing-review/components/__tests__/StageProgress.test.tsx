// @vitest-environment jsdom
// WHAT THE OPERATOR SEES WHILE A LONG STEP IS RUNNING.
//
// Covers items 1 to 4 of the 2026-09-17 walkthrough: verification had no visible state at
// all, a rate limit was rendered as a failure with an HTTP code, research's middle stage was
// invisible for about fifteen minutes, and enrichment reported no progress.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/app/dashboard/operator/sourcing-review/components/__tests__/StageProgress.test.tsx

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { StageProgress, timeAgo, timeUntil } from '../StageProgress'
import type { PipelineProgress } from '@/lib/operator/pipeline-progress'
import type { VerificationFailureMetrics } from '@/lib/operator/sourcing-metrics'

// ── FIXTURE DEFAULTS FOR THE PROGRESS FIELDS ADDED 2026-09-21 ────────────────
//
// Spread into every fixture rather than written out in each one. These are the "we could not
// read the schedule" values, so an existing test that says nothing about the next run or the
// press plan renders exactly what it did before: those lines are omitted when the value is
// null. A test that wants them says so by overriding.
const NO_SWEEP_SCHEDULE = { nextRunAt: null, estimatedMinutesRemaining: null }
const NO_PRESS_PLAN = { pressPlan: null, queueNextRunAt: null }


afterEach(cleanup)

const QUIET: PipelineProgress = {
  verification: { ...NO_SWEEP_SCHEDULE, waiting: 0, inFlight: 0, lastCompletedAt: null, sweepLastRanAt: null },
  enrichment: { ...NO_PRESS_PLAN, done: 0, waiting: 0, inFlight: 0 },
  research: {
    stage: 'idle',
    awaitingSubmission: 0,
    nextSubmissionRunAt: null,
    fetchingSources: 0,
    awaitingModel: 0,
    collecting: 0,
    waveDone: null,
    waveTotal: null,
    oldestBatchSubmittedAt: null,
  },
}

const NO_FAILURES: VerificationFailureMetrics = { count: 0, byKind: {}, givenUp: 0 }

function renderProgress(over: Partial<PipelineProgress>, failures = NO_FAILURES) {
  return render(<StageProgress progress={{ ...QUIET, ...over }} failures={failures} />)
}

describe('item 1 — email verification has visible state', () => {
  it('says how many are being checked, how many wait, and when one last finished', () => {
    renderProgress({
      verification: { ...NO_SWEEP_SCHEDULE,
        waiting: 12,
        inFlight: 3,
        lastCompletedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
        sweepLastRanAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      },
    })

    expect(screen.getByText('Being checked right now')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('Waiting to be checked')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('4 minutes ago')).toBeInTheDocument()
  })

  // THE SWEEP TIME IS PLATFORM-WIDE AND MUST SAY SO. It does one organisation per
  // invocation, so a per-client reading would report a healthy sweep as dead whenever
  // another client was ahead in the queue.
  it('labels the sweep time as covering every client', () => {
    renderProgress({
      verification: { ...NO_SWEEP_SCHEDULE,
        waiting: 1, inFlight: 0, lastCompletedAt: null,
        sweepLastRanAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      },
    })
    expect(screen.getByText(/Checker last ran \(all clients\)/)).toBeInTheDocument()
  })

  it('distinguishes never-verified from a verification we could not read', () => {
    renderProgress({
      verification: { ...NO_SWEEP_SCHEDULE, waiting: 5, inFlight: 0, lastCompletedAt: null, sweepLastRanAt: null },
    })
    expect(screen.getByText('Never')).toBeInTheDocument()
    expect(screen.getByText('Not recorded')).toBeInTheDocument()
  })

  it('renders nothing when every step is quiet, rather than an empty box', () => {
    const { container } = renderProgress({})
    expect(container).toBeEmptyDOMElement()
  })
})

describe('item 2 — a rate limit is not a failure and no status code appears', () => {
  const RATE_LIMITED: VerificationFailureMetrics = {
    count: 12,
    byKind: { rate_limited: { waiting: 12, givenUp: 0 } },
    givenUp: 0,
  }

  it('says it is waiting to retry rather than that it failed', () => {
    renderProgress(
      { verification: { ...NO_SWEEP_SCHEDULE, waiting: 12, inFlight: 0, lastCompletedAt: null, sweepLastRanAt: null } },
      RATE_LIMITED,
    )
    expect(screen.getByText(/waiting to retry automatically/)).toBeInTheDocument()
  })

  // THE CONTROL FOR THE ASSERTION BELOW. If "429" could never appear in this component
  // whatever it was given, the absence assertion would prove nothing. The count 12 IS
  // rendered, so the component does print numbers it is given.
  it('shows no raw status code anywhere', () => {
    const { container } = renderProgress(
      { verification: { ...NO_SWEEP_SCHEDULE, waiting: 12, inFlight: 0, lastCompletedAt: null, sweepLastRanAt: null } },
      RATE_LIMITED,
    )
    expect(container.textContent).toContain('12')          // control: numbers do render
    expect(container.textContent).not.toContain('429')
    expect(container.textContent).not.toContain('HTTP')
    expect(container.textContent).not.toMatch(/\b4\d\d\b|\b5\d\d\b/)
  })

  it('separates what will retry from what has run out of attempts', () => {
    renderProgress(
      { verification: { ...NO_SWEEP_SCHEDULE, waiting: 4, inFlight: 0, lastCompletedAt: null, sweepLastRanAt: null } },
      {
        count: 7,
        byKind: { refused: { waiting: 4, givenUp: 3 } },
        givenUp: 3,
      },
    )
    expect(screen.getByText(/waiting to retry automatically/)).toBeInTheDocument()
    expect(screen.getByText(/out of attempts/)).toBeInTheDocument()
  })
})

describe('item 4 — enrichment reports how many of how many', () => {
  it('shows a numerator and a denominator', () => {
    renderProgress({ enrichment: { ...NO_PRESS_PLAN, done: 18, waiting: 7, inFlight: 0 } })
    expect(screen.getByText('Enriched so far')).toBeInTheDocument()
    expect(screen.getByText('18')).toBeInTheDocument()
    expect(screen.getByText(/of 25/)).toBeInTheDocument()
    expect(screen.getByText('Still to enrich')).toBeInTheDocument()
  })

  it('stays silent once nothing is waiting', () => {
    const { container } = renderProgress({ enrichment: { ...NO_PRESS_PLAN, done: 25, waiting: 0, inFlight: 0 } })
    expect(container.textContent).not.toContain('Enrichment')
  })
})

describe('item 3 — the research stage that had no queue row', () => {
  // ── THE FIFTEEN-MINUTE WINDOW ─────────────────────────────────────────────
  //
  // Measured on production 2026-09-17: phase 1 ended 19:48:31, phase 2 was created
  // 20:03:03. In between, 62 prospects were in flight with no job row anywhere and the
  // screen showed nothing, which reads as a stall.
  // ── THE FRONT OF THAT WINDOW, WHICH THE FIRST FIX DID NOT REACH ───────────
  //
  // awaitingModel is counted through an OPEN BATCH, and an entry has no batch until the
  // sweep submits it. So between phase 1 finishing and the next firing every count was
  // zero, the stage read 'idle', and this panel rendered NOTHING AT ALL.
  //
  // Measured on production 2026-09-21: phase 1 finished for 107 prospects at 18:06:17, the
  // first batch was created 18:08:01, and 7 that did not fit it waited until 18:13:01.
  it('shows that stage one is done while nothing has been sent yet', () => {
    renderProgress({
      research: {
        stage: 'awaiting_submission',
        fetchingSources: 0,
        awaitingSubmission: 107,
        nextSubmissionRunAt: new Date(Date.now() + 104_000).toISOString(),
        awaitingModel: 0,
        collecting: 0,
        waveDone: null,
        waveTotal: null,
        oldestBatchSubmittedAt: null,
      },
    })

    expect(screen.getByText('Sources done, waiting to be sent to the model')).toBeInTheDocument()
    expect(screen.getByText(/The sources are gathered for 107 prospects/)).toBeInTheDocument()
    expect(screen.getByText(/nothing has stalled/)).toBeInTheDocument()
  })

  // A COUNT WITH NO TIME BESIDE IT STILL READS AS A STALL. During this stage there is no
  // queue row, no open batch, and nothing else on the panel that moves.
  it('says when the waiting ends', () => {
    renderProgress({
      research: {
        stage: 'awaiting_submission',
        fetchingSources: 0,
        awaitingSubmission: 7,
        nextSubmissionRunAt: new Date(Date.now() + 104_000).toISOString(),
        awaitingModel: 0,
        collecting: 0,
        waveDone: null,
        waveTotal: null,
        oldestBatchSubmittedAt: null,
      },
    })
    expect(screen.getByText(/go to the model on the next send, in about 2 minutes/))
      .toBeInTheDocument()
  })

  // Null rather than a guess, on the same rule as every other caption here: an invented
  // time rendered on an operator screen is worse than no time.
  it('names no send time when the schedule could not be read', () => {
    renderProgress({
      research: {
        stage: 'awaiting_submission',
        fetchingSources: 0,
        awaitingSubmission: 107,
        nextSubmissionRunAt: null,
        awaitingModel: 0,
        collecting: 0,
        waveDone: null,
        waveTotal: null,
        oldestBatchSubmittedAt: null,
      },
    })
    expect(screen.getByText(/They go to the model on the next send\./)).toBeInTheDocument()
    expect(screen.queryByText(/in about/)).not.toBeInTheDocument()
  })

  // THE COUNT THIS STAGE CONTRIBUTES MUST REACH THE TOTAL. Left out of `left`, the panel
  // would appear and then report "Still to go 0" beside 107 waiting prospects.
  it('counts the waiting prospects in what is still to go', () => {
    renderProgress({
      research: {
        stage: 'awaiting_submission',
        fetchingSources: 0,
        awaitingSubmission: 107,
        nextSubmissionRunAt: null,
        awaitingModel: 0,
        collecting: 0,
        waveDone: null,
        waveTotal: null,
        oldestBatchSubmittedAt: null,
      },
    })
    const row = screen.getByText('Still to go').closest('div')
    expect(row?.textContent).toContain('107')
  })

  // The singular reads to one person about one prospect, not "1 prospects ... for them".
  it('reads correctly for a single prospect', () => {
    renderProgress({
      research: {
        stage: 'awaiting_submission',
        fetchingSources: 0,
        awaitingSubmission: 1,
        nextSubmissionRunAt: null,
        awaitingModel: 0,
        collecting: 0,
        waveDone: null,
        waveTotal: null,
        oldestBatchSubmittedAt: null,
      },
    })
    expect(screen.getByText(/gathered for 1 prospect and nothing more is being bought for it/))
      .toBeInTheDocument()
  })

  it('names the wait on the model and says nothing has stalled', () => {
    renderProgress({
      research: {
        stage: 'awaiting_model',
        awaitingSubmission: 0,
    nextSubmissionRunAt: null,
    fetchingSources: 0,
        awaitingModel: 62,
        collecting: 0,
        waveDone: 0,
        waveTotal: 62,
        oldestBatchSubmittedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      },
    })

    expect(screen.getByText('Waiting for the model to come back')).toBeInTheDocument()
    expect(screen.getByText(/62 are with the model now/)).toBeInTheDocument()
    expect(screen.getByText(/nothing has stalled/)).toBeInTheDocument()
    expect(screen.getByText(/sent 6 minutes ago/)).toBeInTheDocument()
  })

  it('reports how many of the run are done and how many are left', () => {
    renderProgress({
      research: {
        stage: 'collecting',
        awaitingSubmission: 0,
    nextSubmissionRunAt: null,
    fetchingSources: 0,
        awaitingModel: 0,
        collecting: 9,
        waveDone: 53,
        waveTotal: 62,
        oldestBatchSubmittedAt: null,
      },
    })
    expect(screen.getByText('Done in this run')).toBeInTheDocument()
    expect(screen.getByText('53')).toBeInTheDocument()
    expect(screen.getByText(/of 62/)).toBeInTheDocument()
    expect(screen.getByText('Still to go')).toBeInTheDocument()
  })

  // A denominator of zero renders as "0 of 0 done", which reads as failure rather than as
  // nothing running.
  it('omits the done-of-total line when no wave is open', () => {
    renderProgress({
      research: {
        stage: 'fetching_sources',
        awaitingSubmission: 0,
    nextSubmissionRunAt: null,
    fetchingSources: 4,
        awaitingModel: 0,
        collecting: 0,
        waveDone: null,
        waveTotal: null,
        oldestBatchSubmittedAt: null,
      },
    })
    expect(screen.getByText('Reading the sources')).toBeInTheDocument()
    expect(screen.queryByText('Done in this run')).not.toBeInTheDocument()
  })

  it('shows nothing for research when the stage is idle', () => {
    const { container } = renderProgress({ enrichment: { ...NO_PRESS_PLAN, done: 1, waiting: 1, inFlight: 0 } })
    expect(container.textContent).not.toContain('Stage')
  })
})

describe('timeAgo', () => {
  const NOW = new Date('2026-09-17T20:00:00Z').getTime()

  it.each([
    ['2026-09-17T19:59:30Z', 'just now'],
    ['2026-09-17T19:56:00Z', '4 minutes ago'],
    ['2026-09-17T19:00:00Z', '1 hour ago'],
    ['2026-09-16T20:00:00Z', '1 day ago'],
  ])('%s -> %s', (iso, expected) => {
    expect(timeAgo(iso, NOW)).toBe(expected)
  })

  // Clock skew between the database and the browser can put a timestamp slightly ahead.
  // "in 3 seconds" would look broken.
  it('reads a slightly future timestamp as just now rather than negative', () => {
    expect(timeAgo('2026-09-17T20:00:05Z', NOW)).toBe('just now')
  })

  it('returns null rather than rendering an invalid date', () => {
    expect(timeAgo(null, NOW)).toBeNull()
    expect(timeAgo('not a date', NOW)).toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// PROGRESS AN OPERATOR CAN ACT ON (2026-09-21)
//
// A backlog count on its own cannot separate "drains in ten minutes" from "drains tomorrow",
// and enrichment's per-press ceiling was enforced by the route and mentioned nowhere.

describe('timeUntil', () => {
  const now = Date.parse('2026-09-21T12:00:00Z')

  it('reads forward the way timeAgo reads back', () => {
    expect(timeUntil('2026-09-21T12:04:00Z', now)).toBe('in about 4 minutes')
    expect(timeUntil('2026-09-21T13:00:00Z', now)).toBe('in about 1 hour')
    expect(timeUntil('2026-09-21T14:00:00Z', now)).toBe('in about 2 hours')
  })

  it('says a minute rather than sixty seconds', () => {
    expect(timeUntil('2026-09-21T12:01:00Z', now)).toBe('in about a minute')
  })

  // pg_cron and the browser do not share a clock, and a firing a few seconds overdue by our
  // reckoning is not late in any sense an operator cares about. "in -3 seconds" looks broken.
  it('reads a moment already past as imminent, never as negative', () => {
    expect(timeUntil('2026-09-21T11:59:30Z', now)).toBe('any moment now')
    expect(timeUntil('2026-09-21T11:55:00Z', now)).toBe('any moment now')
  })

  it('is null for a missing or unparseable time', () => {
    expect(timeUntil(null, now)).toBeNull()
    expect(timeUntil('not a date', now)).toBeNull()
  })
})

describe('verification says when the next run is and when it will finish', () => {
  it('shows both, with the one-client-per-run assumption stated', () => {
    renderProgress({
      verification: {
        waiting: 38,
        inFlight: 0,
        lastCompletedAt: null,
        sweepLastRanAt: new Date(Date.now() - 60_000).toISOString(),
        nextRunAt: new Date(Date.now() + 4 * 60_000).toISOString(),
        estimatedMinutesRemaining: 14,
      },
    })

    expect(screen.getByText('Next check runs')).toBeInTheDocument()
    expect(screen.getByText('in about 4 minutes')).toBeInTheDocument()
    expect(screen.getByText('Estimated to finish')).toBeInTheDocument()
    expect(screen.getByText('about 14 minutes')).toBeInTheDocument()
    // The caveat travels with the number it qualifies.
    expect(screen.getByText(/one client per run/i)).toBeInTheDocument()
  })

  // A CONFIDENT TIME BUILT ON A DEFAULT NOBODY CHOSE IS WORSE THAN A BLANK LINE. Both of
  // these are null when the schedule or the provider pace could not be read.
  it('says nothing about a next run when the schedule could not be read', () => {
    renderProgress({
      verification: {
        waiting: 38,
        inFlight: 0,
        lastCompletedAt: null,
        sweepLastRanAt: null,
        nextRunAt: null,
        estimatedMinutesRemaining: null,
      },
    })

    expect(screen.queryByText('Next check runs')).not.toBeInTheDocument()
    expect(screen.queryByText('Estimated to finish')).not.toBeInTheDocument()
    expect(screen.queryByText(/one client per run/i)).not.toBeInTheDocument()
    // The counts it could read are still there.
    expect(screen.getByText('Waiting to be checked')).toBeInTheDocument()
    expect(screen.getByText('38')).toBeInTheDocument()
  })

  // A finish time beside an empty queue would read as work still to come.
  it('shows no finish estimate when nothing is waiting', () => {
    renderProgress({
      verification: {
        waiting: 0,
        inFlight: 0,
        lastCompletedAt: new Date(Date.now() - 60_000).toISOString(),
        sweepLastRanAt: new Date(Date.now() - 60_000).toISOString(),
        nextRunAt: new Date(Date.now() + 4 * 60_000).toISOString(),
        estimatedMinutesRemaining: 0,
      },
    })

    expect(screen.getByText('Next check runs')).toBeInTheDocument()
    expect(screen.queryByText('Estimated to finish')).not.toBeInTheDocument()
  })
})

describe('enrichment says another press is needed', () => {
  it('names what this press does and what it leaves', () => {
    renderProgress({
      enrichment: {
        done: 60,
        waiting: 240,
        inFlight: 0,
        pressPlan: { thisPress: 100, remainingAfter: 140, pressesNeeded: 3 },
        queueNextRunAt: null,
      },
    })

    expect(screen.getByText('Presses needed')).toBeInTheDocument()
    expect(screen.getByText(/Enriching runs 100 at a time/)).toBeInTheDocument()
    expect(screen.getByText(/leave 140 waiting/)).toBeInTheDocument()
    expect(screen.getByText(/press it again/)).toBeInTheDocument()
    expect(screen.getByText(/3 presses in total/)).toBeInTheDocument()
  })

  // A client whose whole backlog fits in one press gains no warning, because for them there
  // is nothing to warn about.
  it('gives no warning when one press clears the backlog', () => {
    renderProgress({
      enrichment: {
        done: 10,
        waiting: 40,
        inFlight: 0,
        pressPlan: { thisPress: 40, remainingAfter: 0, pressesNeeded: 1 },
        queueNextRunAt: null,
      },
    })

    expect(screen.getByText('Presses needed')).toBeInTheDocument()
    expect(screen.queryByText(/press it again/)).not.toBeInTheDocument()
  })

  it('drops the total when exactly two presses are needed, because "again" already says it', () => {
    renderProgress({
      enrichment: {
        done: 0,
        waiting: 150,
        inFlight: 0,
        pressPlan: { thisPress: 100, remainingAfter: 50, pressesNeeded: 2 },
        queueNextRunAt: null,
      },
    })

    expect(screen.getByText(/press it again/)).toBeInTheDocument()
    expect(screen.queryByText(/presses in total/)).not.toBeInTheDocument()
  })

  // ON THE INLINE PATH THERE IS NO SCHEDULED RUN TO NAME. The answer to "when does it next
  // run" is "when you press it", and printing a queue time would be wrong.
  it('names a queue run only while the queue actually holds work', () => {
    const soon = new Date(Date.now() + 45_000).toISOString()

    renderProgress({
      enrichment: {
        done: 0, waiting: 120, inFlight: 0,
        pressPlan: { thisPress: 100, remainingAfter: 20, pressesNeeded: 2 },
        queueNextRunAt: null,
      },
    })
    expect(screen.queryByText('Next queue run')).not.toBeInTheDocument()

    cleanup()

    renderProgress({
      enrichment: {
        done: 0, waiting: 120, inFlight: 12,
        pressPlan: { thisPress: 100, remainingAfter: 20, pressesNeeded: 2 },
        queueNextRunAt: soon,
      },
    })
    expect(screen.getByText('Next queue run')).toBeInTheDocument()
  })
})
