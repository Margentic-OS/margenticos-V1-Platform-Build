// @vitest-environment jsdom
//
// Tests for the client prospect roster surface.
//
// This page used to be a review queue that vanished once the client approved. It is now a
// permanent record: a task while something is pending, read-only afterwards. Three things
// are pinned here because each one shipped broken at some point:
//
//   1. The read-only state offers no Approve and no Remove. A dead control on a record is
//      worse than no control.
//   2. Remove appears only on rows genuinely awaiting a decision. The old page rendered it
//      on every row, and subtracted every removal from a pending-only total, so removing
//      an already-decided row drove the button below the true count and could disable
//      approval while prospects were still pending.
//   3. No industry or client wording. The old header read "founders of consulting firms",
//      which is a Rule Zero violation on industry-agnostic infrastructure.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ProspectReviewClient } from '../ProspectReviewClient'
import { buildRosterGroups, countPending, countRoster } from '@/lib/dashboard/prospect-roster'
import type { RosterProspect } from '@/lib/dashboard/prospect-roster'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

function prospect(overrides: Partial<RosterProspect> & { id: string }): RosterProspect {
  return {
    first_name: 'Sam',
    last_name: 'Reed',
    company_name: 'Northwind',
    job_title: 'Operations Lead',
    linkedin_url: null,
    website_url: null,
    client_review_status: 'approved',
    outbound_upload_attempted_at: null,
    email_send_eligible: true,
    ...overrides,
  }
}

function renderRoster(prospects: RosterProspect[], viewerIsOperator = false) {
  const groups = buildRosterGroups(prospects)
  return render(
    <ProspectReviewClient
      groups={groups}
      pendingCount={countPending(groups)}
      rosterCount={countRoster(groups)}
      autoSanctionDate="2026-09-11T00:00:00Z"
      organisationId="org-1"
      viewerIsOperator={viewerIsOperator}
    />
  )
}

afterEach(cleanup)

describe('read-only record, once nothing is pending', () => {
  const approvedRoster = [
    prospect({ id: 'a', outbound_upload_attempted_at: '2026-09-07T09:00:00Z' }),
    prospect({ id: 'b', email_send_eligible: false }),
  ]

  it('offers no approve control', () => {
    renderRoster(approvedRoster)
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument()
  })

  it('offers no remove control on any row', () => {
    renderRoster(approvedRoster)
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
  })

  it('does not show the auto-approval deadline, which no longer applies', () => {
    renderRoster(approvedRoster)
    expect(screen.queryByText(/auto-approved on/i)).not.toBeInTheDocument()
  })

  it('describes the list as the campaign rather than as a review', () => {
    renderRoster(approvedRoster)
    expect(screen.getByText(/2 people in your campaign/i)).toBeInTheDocument()
  })

  it('still shows a prospect that can no longer be emailed', () => {
    renderRoster(approvedRoster)
    expect(screen.getAllByText('Sam Reed').length).toBeGreaterThan(0)
  })
})

describe('task state, while something is pending', () => {
  it('offers approve, counting only the pending prospects', () => {
    renderRoster([
      prospect({ id: 'waiting-1', client_review_status: 'pending_review' }),
      prospect({ id: 'waiting-2', client_review_status: 'pending_review' }),
      prospect({ id: 'already-approved' }),
    ])

    expect(screen.getByRole('button', { name: 'Approve remaining 2' })).toBeInTheDocument()
  })

  // The defect this build fixes. All three rows sit in one group, and only the pending
  // ones may be removed, so the button's arithmetic is over a single population.
  it('offers remove only on rows awaiting a decision', () => {
    renderRoster([
      prospect({ id: 'waiting', client_review_status: 'pending_review' }),
      prospect({ id: 'already-approved' }),
    ])

    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1)
  })

  it('shows the auto-approval deadline while a decision is outstanding', () => {
    renderRoster([prospect({ id: 'waiting', client_review_status: 'pending_review' })])
    expect(screen.getByText(/auto-approved on 11 Sep 2026/i)).toBeInTheDocument()
  })

  it('opens on the group holding the work, not the newest batch', () => {
    renderRoster([
      prospect({ id: 'uploaded', outbound_upload_attempted_at: '2026-09-07T09:00:00Z' }),
      prospect({ id: 'waiting', client_review_status: 'pending_review' }),
    ])

    const selected = screen.getByRole('tab', { selected: true })
    expect(selected).toHaveTextContent('Not yet in the campaign')
  })
})

describe('grouping is visible to the client', () => {
  it('renders a tab per group with its count, and shows only that group', () => {
    renderRoster([
      prospect({ id: 'a', outbound_upload_attempted_at: '2026-09-07T09:00:00Z' }),
      prospect({ id: 'b', outbound_upload_attempted_at: '2026-08-21T09:00:00Z' }),
      prospect({ id: 'c', outbound_upload_attempted_at: '2026-08-21T10:00:00Z' }),
    ])

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(t => t.textContent)).toEqual(['7 Sep 20261', '21 Aug 20262'])

    // Newest batch is selected by default and holds exactly one row.
    expect(screen.getAllByText('Northwind')).toHaveLength(1)
  })

  it('renders no tab strip when there is only one group', () => {
    renderRoster([prospect({ id: 'a' })])
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
  })
})

// Rule Zero: this surface serves any B2B client, so no industry or buyer type may be
// baked into it. The header previously read "founders of consulting firms".
describe('industry-agnostic copy', () => {
  const forbidden = [/consulting/i, /founders of/i, /coach/i, /agency/i]

  it('names no industry in the task state', () => {
    const { container } = renderRoster([
      prospect({ id: 'waiting', client_review_status: 'pending_review' }),
    ])
    for (const pattern of forbidden) {
      expect(container.textContent).not.toMatch(pattern)
    }
  })

  it('names no industry in the read-only state', () => {
    const { container } = renderRoster([
      prospect({ id: 'a', outbound_upload_attempted_at: '2026-09-07T09:00:00Z' }),
    ])
    for (const pattern of forbidden) {
      expect(container.textContent).not.toMatch(pattern)
    }
  })
})

describe('empty group handling', () => {
  it('renders the roster when every prospect is in one batch', () => {
    renderRoster([
      prospect({ id: 'a', outbound_upload_attempted_at: '2026-09-07T09:00:00Z' }),
    ])
    const rows = screen.getAllByText('Sam Reed')
    expect(within(rows[0].closest('div')!).getByText('Northwind')).toBeInTheDocument()
  })
})


// ---------------------------------------------------------------------------
// 4. An operator may not approve or reject on a client's behalf. Decided 2026-09-08.
//
// This screen is a client-facing handshake by design. An operator acting through a URL
// parameter is a different capability needing its own decision, audit trail and
// attribution, so it must not arrive as a side effect of a view mode.
//
// These tests are the live control. The two write routes still resolve the ACTOR's
// organisation rather than the one being viewed, which is tracked and deliberately left
// unfixed: hiding the controls is what removes the consequence. If someone re-renders
// these buttons for an operator, the 404 comes back with them.
// ---------------------------------------------------------------------------
describe('operator view offers no client decisions', () => {
  const pendingRoster = [
    prospect({ id: 'p1', client_review_status: 'pending_review' }),
    prospect({ id: 'p2', client_review_status: 'pending_review' }),
  ]

  it('offers no approve control to an operator while prospects are pending', () => {
    renderRoster(pendingRoster, true)
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument()
  })

  it('offers no remove control to an operator on any pending row', () => {
    renderRoster(pendingRoster, true)
    expect(screen.queryByRole('button', { name: /^remove$/i })).not.toBeInTheDocument()
  })

  // The control must not be silently absent. An operator who cannot see why the buttons
  // are gone will reasonably conclude the page is broken, which is how the original defect
  // was reported in the first place.
  it('says why the decisions are absent, and whose they are', () => {
    renderRoster(pendingRoster, true)
    expect(screen.getByText(/only they can approve or remove/i)).toBeInTheDocument()
  })

  // The guard is the VIEWER, not the state. Same roster, client viewer, controls present.
  it('still offers both controls to the client on the same roster', () => {
    renderRoster(pendingRoster, false)
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^remove$/i }).length).toBe(2)
  })

  it('shows the client no operator-view wording', () => {
    renderRoster(pendingRoster, false)
    expect(screen.queryByText(/operator view/i)).not.toBeInTheDocument()
  })
})
