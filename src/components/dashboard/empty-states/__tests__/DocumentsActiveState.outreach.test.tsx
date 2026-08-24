// @vitest-environment jsdom
//
// Tests for the client overview once outreach has actually started.
//
// THE BUG THIS REPLACES. With 26 emails in the field, one reply received and a live
// campaign, this page read: "Your campaigns launch soon. Strategy is ready. Email warmup
// runs for 6 weeks to protect your domain reputation before the first campaign goes live.
// Meetings will appear here once outreach begins." Every clause of that was false, and
// the sidebar checklist agreed with it, showing "Campaigns live" as still pending.
//
// So the assertions here are mostly about what must NOT be on the screen. A results block
// that renders correctly is worth little if the launch promise is still sitting above it.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { DocumentsActiveState } from '../DocumentsActiveState'
import type { ClientVisibleCampaignMetrics } from '@/lib/metrics/get-client-visible-campaign-metrics'
import type { CampaignLiveness } from '@/lib/dashboard/campaign-liveness'

const SENDING: CampaignLiveness = {
  verdict: 'sending',
  label: 'Sending',
  detail: 'Emails are going out.',
}

const NOT_REPORTED: CampaignLiveness = {
  verdict: 'unknown',
  label: 'Not reported',
  detail: 'We have not been able to confirm sending status recently.',
}

function metrics(overrides: Partial<ClientVisibleCampaignMetrics> = {}): ClientVisibleCampaignMetrics {
  return {
    contactedCount: 15,
    sentCount: 26,
    deliveredCount: 26,
    repliedCount: 1,
    replyRate: (1 / 26) * 100,
    positiveReplyCount: 0,
    meetingsBooked: 0,
    meetingsHeld: 0,
    hasData: true,
    ...overrides,
  }
}

function renderOverview(
  m: ClientVisibleCampaignMetrics,
  liveness: CampaignLiveness = SENDING,
) {
  return render(
    <DocumentsActiveState
      orgName="MargenticOS"
      documents={[]}
      contractStartDate="2026-08-07"
      // Warmup started 2026-06-22, over six weeks ago. This is exactly the state that
      // produced "Your campaigns launch soon" while mail was already going out.
      warmupStartedAt="2026-06-22T00:00:00.000Z"
      linkedinChannelEnabled={false}
      setupStatus={{ campaigns: 'in_progress', linkedin: 'pending' }}
      pendingProspectsCount={0}
      approvedProspectsCount={15}
      metrics={m}
      liveness={liveness}
    />
  )
}

afterEach(cleanup)

describe('the overview once a single email has gone out', () => {
  it('does not promise a launch that already happened', () => {
    renderOverview(metrics())

    expect(screen.queryByText(/campaigns launch/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/warmup runs for 6 weeks/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/once outreach begins/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Warmup progress/i)).not.toBeInTheDocument()
  })

  it('leads with how many people have actually been contacted', () => {
    renderOverview(metrics())
    expect(screen.getByText('15 prospects contacted')).toBeInTheDocument()
  })

  it('shows the five counts the client is owed', () => {
    renderOverview(metrics({
      contactedCount: 15,
      deliveredCount: 24,
      repliedCount: 3,
      positiveReplyCount: 2,
      meetingsHeld: 1,
    }))

    for (const label of ['Contacted', 'Delivered', 'Replies', 'Interested', 'Meetings held']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByText('24')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('shows counts, never rates', () => {
    const { container } = renderOverview(metrics({ repliedCount: 1, sentCount: 26 }))
    // 1 of 26 is 3.8%. On a sample this small a rate is noise dressed as a measurement,
    // and it belongs on Benchmarks with a sample gate, not on the overview.
    expect(container.textContent).not.toMatch(/\d+(\.\d+)?%/)
  })

  it('carries the live sending verdict, not the campaign status', () => {
    renderOverview(metrics(), SENDING)
    expect(screen.getByText('Sending')).toBeInTheDocument()
    expect(screen.getByText('Emails are going out.')).toBeInTheDocument()
  })

  it('says a limit was reached rather than claiming the campaign is live', () => {
    renderOverview(metrics(), {
      verdict: 'not_sending',
      label: 'Daily sending limit reached',
      detail: 'Today’s emails have all gone out. Sending picks up again tomorrow.',
    })
    expect(screen.getByText('Daily sending limit reached')).toBeInTheDocument()
    expect(screen.queryByText('Sending')).not.toBeInTheDocument()
  })

  it('says not reported rather than inventing a state', () => {
    renderOverview(metrics(), NOT_REPORTED)
    expect(screen.getByText('Not reported')).toBeInTheDocument()
  })

  it('marks campaign setup complete, whatever the derived setup status says', () => {
    // setupStatus.campaigns is 'in_progress' in this fixture. deriveCampaignsStatus reads
    // shell sync and lead uploads, which can lag a campaign that has already sent. The
    // checklist follows the emails.
    renderOverview(metrics())

    expect(screen.getByText('Campaign setup')).toBeInTheDocument()
    expect(screen.getByText(/Your sequence is running/)).toBeInTheDocument()
    expect(screen.queryByText('In progress')).not.toBeInTheDocument()
  })

  it('names meetings booked separately when some have not been confirmed held', () => {
    renderOverview(metrics({ meetingsBooked: 3, meetingsHeld: 1 }))
    expect(screen.getByText(/3 booked in total/)).toBeInTheDocument()
    expect(screen.getByText(/confirmed after the date/)).toBeInTheDocument()
  })

  it('handles the very first send, before anyone is recorded as contacted', () => {
    // sent_count moves before contacted_count settles on some ticks. "0 prospects
    // contacted" as a headline would read worse than the truth.
    renderOverview(metrics({ contactedCount: 0, sentCount: 1, deliveredCount: 1 }))
    expect(screen.getByText('Your first emails are going out')).toBeInTheDocument()
  })

  it('uses the singular for one person', () => {
    renderOverview(metrics({ contactedCount: 1 }))
    expect(screen.getByText('1 prospect contacted')).toBeInTheDocument()
  })
})

describe('the overview before anything has been sent', () => {
  it('still shows the warmup promise, which is true at that point', () => {
    renderOverview(metrics({
      contactedCount: 0,
      sentCount: 0,
      deliveredCount: 0,
      repliedCount: 0,
      replyRate: null,
      hasData: false,
    }))

    expect(screen.getByText(/campaigns launch/i)).toBeInTheDocument()
    expect(screen.getByText(/Warmup progress/i)).toBeInTheDocument()
    expect(screen.queryByText('Contacted')).not.toBeInTheDocument()
  })

  it('no longer claims meetings will appear on this page', () => {
    // The Meetings surface is the Pipeline page. Promising them here was a promise about
    // a screen that does not show them.
    renderOverview(metrics({ sentCount: 0, hasData: false }))
    expect(screen.queryByText(/Meetings will appear here/i)).not.toBeInTheDocument()
  })
})
