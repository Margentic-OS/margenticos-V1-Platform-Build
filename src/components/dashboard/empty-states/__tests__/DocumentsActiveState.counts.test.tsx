// @vitest-environment jsdom
//
// The two Overview numbers that disagreed with the rest of the dashboard.
//
// CONTACTS APPROVED. The Overview counted every tier, so it said "108 contacts approved"
// while the roster rendered 103. The 5 difference is tier 3, the disqualifier tier: people
// the client has never seen and never will. The card must count the roster population.
// That scoping lives in (client)/page.tsx; what is pinned here is that the card renders
// the number it is given rather than deriving its own.
//
// REPLIES. The card rendered metrics.repliedCount, the sending tool's tally. It now
// renders peopleRepliedCount: distinct PEOPLE who wrote to us, computed from our own
// intents. Out-of-office and not_a_response are excluded because nobody replied to us in
// either case; opt_out, objection_mild and unclear all count.
//
// The two values below are deliberately different so the test can tell which the card
// reads. On the live organisation both happen to be 2.
//
// Out-of-office stays out of INTEREST, which is a different number on the same row and is
// governed by CLIENT_VISIBLE_INTENTS. An out-of-office IS a reply; it is just not interest.
// Both are asserted together here so a future change cannot quietly merge the two ideas.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { DocumentsActiveState } from '../DocumentsActiveState'

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}))

const metrics = {
  contactedCount: 24,
  sentCount: 92,
  deliveredCount: 92,
  bouncedCount: 0,
  peopleOptedOutCount: 0,
  repliedCount: 9,
  peopleRepliedCount: 5,
  replyRate: null,
  positiveReplyCount: 0,
  meetingsBooked: 0,
  meetingsHeld: 0,
  meetingRate: null,
  hasData: true,
}

function renderState(overrides: Record<string, unknown> = {}) {
  const { metrics: metricsOverride, approvedProspectsCount, ...rest } = overrides
  return render(
    <DocumentsActiveState
      orgName="Acme"
      documents={[]}
      contractStartDate="2026-08-07"
      warmupStartedAt="2026-06-22T00:00:00.000Z"
      linkedinChannelEnabled={false}
      setupStatus={{ campaigns: 'in_progress', linkedin: 'pending' }}
      pendingProspectsCount={0}
      approvedProspectsCount={(approvedProspectsCount as number) ?? 103}
      metrics={(metricsOverride as typeof metrics) ?? metrics}
      liveness={{ verdict: 'sending', label: 'Sending', detail: 'Mail is going out.' }}
      {...rest}
    />
  )
}

afterEach(cleanup)

describe('the Replies card', () => {
  it('shows people who replied, not the provider tally', () => {
    renderState()
    const replies = screen.getByText('Replies').closest('div')!
    expect(within(replies).getByText('5')).toBeInTheDocument()
  })

  it('does not show the provider number anywhere on that row', () => {
    renderState()
    const replies = screen.getByText('Replies').closest('div')!
    expect(within(replies).queryByText('2')).not.toBeInTheDocument()
  })

  // Different question, different number, and it must stay that way.
  it('keeps Interested separate from Replies', () => {
    renderState()
    const interested = screen.getByText('Interested').closest('div')!
    expect(within(interested).getByText('0')).toBeInTheDocument()
  })

  it('counts an out-of-office as a reply but not as interest', () => {
    // Two people replied, both out of office: replies 2, interested 0.
    renderState({ metrics: { ...metrics, peopleRepliedCount: 2, positiveReplyCount: 0 } })
    expect(within(screen.getByText('Replies').closest('div')!).getByText('2')).toBeInTheDocument()
    expect(within(screen.getByText('Interested').closest('div')!).getByText('0')).toBeInTheDocument()
  })
})

describe('the contacts approved line', () => {
  it('renders the count it is given, so it matches the roster', () => {
    renderState()
    expect(screen.getByText(/103 contacts approved/)).toBeInTheDocument()
  })

  it('does not render the all-tier figure', () => {
    renderState()
    expect(screen.queryByText(/108 contacts approved/)).not.toBeInTheDocument()
  })
})
