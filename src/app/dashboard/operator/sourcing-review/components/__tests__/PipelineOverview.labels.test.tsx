// @vitest-environment jsdom
//
// THE BUTTON LABELS AND THE COUNTS BESIDE THEM. Items 5, 6 and 8.
//
// Every actionable count on this screen was an all-time total across every sourcing run and
// none of them said so; the publish button counted a different population from the one its
// click would touch; and the spend warning never said how many people it would spend on.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/app/dashboard/operator/sourcing-review/components/__tests__/PipelineOverview.labels.test.tsx

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { PipelineOverview } from '../PipelineOverview'
import type { BatchFunnel, PipelineMetrics, TierMetrics } from '@/lib/operator/sourcing-metrics'

// ── FIXTURE DEFAULTS FOR THE PROGRESS FIELDS ADDED 2026-09-21 ────────────────
//
// Spread into every fixture rather than written out in each one. These are the "we could not
// read the schedule" values, so an existing test that says nothing about the next run or the
// press plan renders exactly what it did before: those lines are omitted when the value is
// null. A test that wants them says so by overriding.
const NO_SWEEP_SCHEDULE = { nextRunAt: null, estimatedMinutesRemaining: null }
const NO_PRESS_PLAN = { pressPlan: null, queueNextRunAt: null }


vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

afterEach(cleanup)

function tier(total: number, sendable = total): TierMetrics {
  return { total, sendable, notSendableByReason: {} }
}

function funnel(over: Partial<BatchFunnel> = {}): BatchFunnel {
  return {
    sourcing_run_id: 'run-latest',
    started_at: '2026-09-17T19:47:56Z',
    completed_at: '2026-09-17T19:48:31Z',
    status: 'completed',
    target_batch_size: 50,
    candidates_returned: 50,
    dropped_by_reason: {},
    error_message: null,
    backfilled: false,
    sourced: 50,
    pending_review: 0,
    approved: 50,
    enriched: 50,
    tiers: { tier_1: tier(35), tier_2: tier(14), tier_3: tier(0) },
    removed: 1,
    removed_by_reason: {},
    verified: 49,
    eligible: 45,
    researched: 0,
    personalised: 0,
    unpublished: 0,
    verification_failures: { count: 0, byKind: {}, givenUp: 0 },
    ...over,
  }
}

function metrics(over: Partial<PipelineMetrics> = {}): PipelineMetrics {
  return {
    organisation_id: 'org-1',
    organisation_name: 'Test Client',
    pending_review_count: 0,
    approved_unenriched_count: 0,
    tiers: { tier_1: tier(140), tier_2: tier(43), tier_3: tier(3) },
    enriched_untiered_count: 0,
    unpublished_count: 0,
    removed_count: 0,
    removed_by_reason: {},
    verification_failures: { count: 0, byKind: {}, givenUp: 0 },
    breakdowns_truncated: false,
    research: {
      actionable: 0,
      blocked: null,
      skippedBreakdown: null,
      actionableByRun: {},
      path: 'queue:batch',
      stoppable: 0,
    },
    progress: {
      verification: { ...NO_SWEEP_SCHEDULE, waiting: 0, inFlight: 0, lastCompletedAt: null, sweepLastRanAt: null },
      enrichment: { ...NO_PRESS_PLAN, done: 0, waiting: 0, inFlight: 0 },
      research: {
        stage: 'idle', fetchingSources: 0, awaitingModel: 0, collecting: 0,
        waveDone: null, waveTotal: null, oldestBatchSubmittedAt: null,
      },
    },
    batches: [funnel()],
    unattributed: null,
    ...over,
  }
}

function renderOverview(over: Partial<PipelineMetrics> = {}) {
  return render(
    <PipelineOverview
      enrichmentMode="live"
      metrics={[metrics(over)]}
      sourcingMaxBatchSize={100}
    />,
  )
}

describe('item 8 — the publish control counts what the click will act on', () => {
  // MEASURED ON PRODUCTION 2026-09-17: 187 tiered prospects across five runs, of which 49
  // had never been published. The label carried 187. The ACTION was already correct.
  it('shows the unpublished count, not the all-time tiered total', () => {
    renderOverview({
      tiers: { tier_1: tier(140), tier_2: tier(43), tier_3: tier(3) },
      unpublished_count: 49,
    })
    const link = screen.getByRole('link', { name: /publish for the client/i })
    expect(link).toHaveTextContent('Check 49 new and publish for the client')
    expect(link).not.toHaveTextContent('186')
  })

  it('says so plainly when there is nothing new to publish', () => {
    renderOverview({
      tiers: { tier_1: tier(140), tier_2: tier(43), tier_3: tier(3) },
      unpublished_count: 0,
    })
    expect(screen.getByRole('link', { name: /already published/i })).toBeInTheDocument()
  })

  it('still offers the removal explanation when everything was removed', () => {
    renderOverview({
      tiers: { tier_1: tier(0), tier_2: tier(0), tier_3: tier(0) },
      unpublished_count: 0,
      removed_count: 12,
    })
    expect(screen.getByRole('link', { name: /See why all were removed/ })).toBeInTheDocument()
  })
})

describe('item 5 — a count that spans more than one run says so', () => {
  it('splits the approve count into the latest run and what carried over', () => {
    renderOverview({
      pending_review_count: 100,
      batches: [funnel({ pending_review: 35 })],
    })
    expect(screen.getByText(/Approve: 35 from the run on 17 Sep 2026, 65 carried over/))
      .toBeInTheDocument()
  })

  it('splits the publish count the same way', () => {
    renderOverview({
      unpublished_count: 49,
      batches: [funnel({ unpublished: 20 })],
    })
    expect(screen.getByText(/Publish: 20 from the run on 17 Sep 2026, 29 carried over/))
      .toBeInTheDocument()
  })

  it('splits the research count from the selection’s own attribution', () => {
    renderOverview({
      research: {
        actionable: 62,
        blocked: null,
        skippedBreakdown: null,
        actionableByRun: { 'run-latest': 49 },
        path: 'queue:batch',
        stoppable: 0,
      },
    })
    expect(screen.getByText(/Research: 49 from the run on 17 Sep 2026, 13 carried over/))
      .toBeInTheDocument()
  })

  // A SAMPLED SPLIT IS WORSE THAN NO SPLIT. The totals are exact head-counts and the
  // per-run figures come from a walk capped at STATUS_ROW_LIMIT. Above that cap the
  // subtraction attributes real prospects to "carried over", and the sentence would read as
  // precise while being built on a sample. The screen already warns the breakdowns are
  // truncated; a confident line underneath it would undo that warning.
  it('shows no split at all when the per-run figures are a sample', () => {
    const { container } = renderOverview({
      pending_review_count: 100,
      batches: [funnel({ pending_review: 35 })],
      breakdowns_truncated: true,
    })
    expect(container.textContent).toContain('Approve 100 prospects')  // control
    expect(container.textContent).not.toContain('carried over')
  })

  // THE CONTROL. A single-batch client must NOT gain a line saying "all 1 run", or the
  // disclosure becomes noise and buries the cases that matter.
  it('says nothing when a count comes entirely from the latest run', () => {
    const { container } = renderOverview({
      pending_review_count: 35,
      batches: [funnel({ pending_review: 35 })],
    })
    expect(container.textContent).toContain('Approve 35 prospects')  // control
    expect(container.textContent).not.toContain('carried over')
  })
})

describe('item 6 — the spend warning names how many people', () => {
  it('carries the count of prospects the run would spend on', () => {
    renderOverview({ approved_unenriched_count: 23 })
    expect(screen.getByText(/will spend real enrichment credits on 23 prospects/))
      .toBeInTheDocument()
  })

  it('reads in the singular for one prospect', () => {
    renderOverview({ approved_unenriched_count: 1 })
    expect(screen.getByText(/on 1 prospect$/)).toBeInTheDocument()
  })
})
