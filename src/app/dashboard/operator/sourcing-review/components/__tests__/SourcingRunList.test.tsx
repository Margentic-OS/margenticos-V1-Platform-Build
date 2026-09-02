// @vitest-environment jsdom
//
// WHAT THIS ASSERTS, AND WHAT IT DOES NOT.
//
// This is a RENDERING test over fixture data. The numbers are not real and are not meant
// to be: whether the counts are correct is proved against a live database in
// batch-funnel.live.test.ts, and duplicating that here would be a second place for the
// same claim.
//
// What is only provable here is the part Doug called non-optional: EVERY VIEW NAMES ITS
// SCOPE AND ITS DATE. A default that is not visibly a filter is the defect being fixed, so
// a run line that renders a bare number is a regression even when the number is right.

import { describe, it, expect, afterEach } from 'vitest'
// fireEvent rather than user-event: the latter is not a dependency of this project and
// adding one to click a disclosure button is not a trade this test needs to make.
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SourcingRunList } from '../SourcingRunList'
import type { BatchFunnel, PipelineMetrics, TierMetrics } from '@/lib/operator/sourcing-metrics'

afterEach(cleanup)

function tier(total: number, sendable = total): TierMetrics {
  return { total, sendable, notSendableByReason: {} }
}

function funnel(over: Partial<BatchFunnel>): BatchFunnel {
  return {
    sourcing_run_id: 'run-a',
    started_at: '2026-09-01T17:13:17.000Z',
    completed_at: '2026-09-01T17:13:24.000Z',
    status: 'completed',
    target_batch_size: 100,
    candidates_returned: 100,
    dropped_by_reason: {},
    error_message: null,
    backfilled: false,
    sourced: 100,
    pending_review: 0,
    approved: 100,
    enriched: 100,
    tiers: { tier_1: tier(70), tier_2: tier(10), tier_3: tier(5) },
    removed: 15,
    removed_by_reason: { headcount_out_of_range: 15 },
    verified: 98,
    eligible: 82,
    researched: 79,
    personalised: 74,
    verification_failures: { count: 0, byStatus: {}, givenUp: 0 },
    ...over,
  }
}

function metrics(over: Partial<PipelineMetrics>): PipelineMetrics {
  return {
    organisation_id: 'org-1',
    organisation_name: 'Test Client',
    pending_review_count: 0,
    approved_unenriched_count: 0,
    tiers: { tier_1: tier(70), tier_2: tier(10), tier_3: tier(5) },
    enriched_untiered_count: 0,
    removed_count: 15,
    removed_by_reason: {},
    verification_failures: { count: 0, byStatus: {}, givenUp: 0 },
    breakdowns_truncated: false,
    research: { canRun: false, reason: 'nothing to research', eligibleCount: 0 } as never,
    batches: [funnel({})],
    unattributed: null,
    ...over,
  }
}

describe('SourcingRunList names its scope', () => {
  it('names the date on every run line, not just a count', () => {
    render(<SourcingRunList org={metrics({})} />)
    expect(screen.getByText('1 September 2026')).toBeInTheDocument()
  })

  it('says how many runs the cards above are summing', () => {
    render(<SourcingRunList org={metrics({
      batches: [funnel({ sourcing_run_id: 'a' }), funnel({ sourcing_run_id: 'b' })],
    })} />)
    expect(screen.getByText(/2 runs, most recent 1 September 2026/)).toBeInTheDocument()
    expect(screen.getByText(/cards above are every run added together/)).toBeInTheDocument()
  })

  it('expands the newest run by default, so no batch is silently chosen and hidden', () => {
    render(<SourcingRunList org={metrics({})} />)
    // A stage label only exists inside an expanded funnel.
    expect(screen.getByText('Has an opening line')).toBeInTheDocument()
  })
})

describe('SourcingRunList shows what would otherwise be invisible', () => {
  it('shows prospects belonging to no run rather than dropping them', async () => {
    render(<SourcingRunList org={metrics({
      unattributed: funnel({ sourcing_run_id: null, started_at: null, sourced: 19,
        candidates_returned: null, target_batch_size: null }),
    })} />)

    expect(screen.getByText('Not from any recorded run')).toBeInTheDocument()
    expect(screen.getByText(/19 prospects/)).toBeInTheDocument()
  })

  it('reconciles the run lines against the client total, in words', () => {
    render(<SourcingRunList org={metrics({
      batches: [funnel({ sourced: 100 })],
      unattributed: funnel({ sourcing_run_id: null, started_at: null, sourced: 19 }),
    })} />)
    expect(
      screen.getByText(/100 in the runs above plus 19 from no recorded run = 119 in total/),
    ).toBeInTheDocument()
  })

  it('says when a run wrote prospects that no longer exist', () => {
    render(<SourcingRunList org={metrics({
      batches: [funnel({ sourced: 0, candidates_returned: 25 })],
    })} />)
    expect(screen.getByText(/wrote 25, none still here/)).toBeInTheDocument()
  })

  // A reconstructed number and a recorded one must not look identical.
  it('marks a backfilled run as reconstructed', () => {
    render(<SourcingRunList org={metrics({ batches: [funnel({ backfilled: true })] })} />)
    expect(screen.getByText(/reconstructed afterwards from the/)).toBeInTheDocument()
  })

  it('says nothing has run yet rather than rendering an empty table', () => {
    render(<SourcingRunList org={metrics({ batches: [], unattributed: null })} />)
    expect(screen.getByText(/No sourcing runs recorded for this client yet/)).toBeInTheDocument()
  })

  it('opens a collapsed run when clicked', () => {
    render(<SourcingRunList org={metrics({
      batches: [
        funnel({ sourcing_run_id: 'newest', started_at: '2026-09-01T17:13:17.000Z' }),
        funnel({ sourcing_run_id: 'older', started_at: '2026-08-10T20:39:09.000Z', sourced: 25 }),
      ],
    })} />)

    // Only the newest is open, so one funnel is on screen.
    expect(screen.getAllByText('Has an opening line')).toHaveLength(1)

    fireEvent.click(screen.getByText('10 August 2026'))
    expect(screen.getAllByText('Has an opening line')).toHaveLength(2)
  })
})
