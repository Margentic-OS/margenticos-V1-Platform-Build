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
import { StageProgress, timeAgo } from '../StageProgress'
import type { PipelineProgress } from '@/lib/operator/pipeline-progress'
import type { VerificationFailureMetrics } from '@/lib/operator/sourcing-metrics'

afterEach(cleanup)

const QUIET: PipelineProgress = {
  verification: { waiting: 0, inFlight: 0, lastCompletedAt: null, sweepLastRanAt: null },
  enrichment: { done: 0, waiting: 0, inFlight: 0 },
  research: {
    stage: 'idle',
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
      verification: {
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
      verification: {
        waiting: 1, inFlight: 0, lastCompletedAt: null,
        sweepLastRanAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      },
    })
    expect(screen.getByText(/Checker last ran \(all clients\)/)).toBeInTheDocument()
  })

  it('distinguishes never-verified from a verification we could not read', () => {
    renderProgress({
      verification: { waiting: 5, inFlight: 0, lastCompletedAt: null, sweepLastRanAt: null },
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
      { verification: { waiting: 12, inFlight: 0, lastCompletedAt: null, sweepLastRanAt: null } },
      RATE_LIMITED,
    )
    expect(screen.getByText(/waiting to retry automatically/)).toBeInTheDocument()
  })

  // THE CONTROL FOR THE ASSERTION BELOW. If "429" could never appear in this component
  // whatever it was given, the absence assertion would prove nothing. The count 12 IS
  // rendered, so the component does print numbers it is given.
  it('shows no raw status code anywhere', () => {
    const { container } = renderProgress(
      { verification: { waiting: 12, inFlight: 0, lastCompletedAt: null, sweepLastRanAt: null } },
      RATE_LIMITED,
    )
    expect(container.textContent).toContain('12')          // control: numbers do render
    expect(container.textContent).not.toContain('429')
    expect(container.textContent).not.toContain('HTTP')
    expect(container.textContent).not.toMatch(/\b4\d\d\b|\b5\d\d\b/)
  })

  it('separates what will retry from what has run out of attempts', () => {
    renderProgress(
      { verification: { waiting: 4, inFlight: 0, lastCompletedAt: null, sweepLastRanAt: null } },
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
    renderProgress({ enrichment: { done: 18, waiting: 7, inFlight: 0 } })
    expect(screen.getByText('Enriched so far')).toBeInTheDocument()
    expect(screen.getByText('18')).toBeInTheDocument()
    expect(screen.getByText(/of 25/)).toBeInTheDocument()
    expect(screen.getByText('Still to enrich')).toBeInTheDocument()
  })

  it('stays silent once nothing is waiting', () => {
    const { container } = renderProgress({ enrichment: { done: 25, waiting: 0, inFlight: 0 } })
    expect(container.textContent).not.toContain('Enrichment')
  })
})

describe('item 3 — the research stage that had no queue row', () => {
  // ── THE FIFTEEN-MINUTE WINDOW ─────────────────────────────────────────────
  //
  // Measured on production 2026-09-17: phase 1 ended 19:48:31, phase 2 was created
  // 20:03:03. In between, 62 prospects were in flight with no job row anywhere and the
  // screen showed nothing, which reads as a stall.
  it('names the wait on the model and says nothing has stalled', () => {
    renderProgress({
      research: {
        stage: 'awaiting_model',
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
    const { container } = renderProgress({ enrichment: { done: 1, waiting: 1, inFlight: 0 } })
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
