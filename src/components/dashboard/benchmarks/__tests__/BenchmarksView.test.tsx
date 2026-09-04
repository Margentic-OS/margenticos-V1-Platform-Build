// @vitest-environment jsdom
//
// Tests for the benchmarks page.
//
// Three things this page was doing that it must not do again:
//
//   1. Printing "Target >= 2%" for a meeting booking rate we underwrite at roughly 0.9%.
//      A target on a client's dashboard is a promise, and that one committed us in writing
//      to missing it by half, every time they opened the page.
//   2. Rendering 3.8% from a single reply as though it were a measurement.
//   3. Citing Belkins's 2025 study beside a 1 to 3% meeting booking range, when Belkins's
//      own published production figure is 0.16 meetings per 1,000 emails: 0.016%.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { BenchmarksView } from '../BenchmarksView'
import type { ClientVisibleCampaignMetrics } from '@/lib/metrics/get-client-visible-campaign-metrics'

function metrics(overrides: Partial<ClientVisibleCampaignMetrics> = {}): ClientVisibleCampaignMetrics {
  return {
    contactedCount: 15,
    sentCount: 26,
    deliveredCount: 26,
    bouncedCount: 0,
    unsubscribedCount: 1,
    repliedCount: 1,
    replyRate: (1 / 26) * 100,
    positiveReplyCount: 0,
    meetingsBooked: 0,
    meetingsHeld: 0,
    meetingRate: null,
    hasData: true,
    ...overrides,
  }
}

// A sample large enough for EVERY card to report, meetings included.
//
// 2,000 people and 4,000 emails, not the old 500 and 1,000. The meeting rate is gated on
// 1,500 PEOPLE now, so the old fixture cleared four gates and silently missed the fifth,
// and a fixture that cannot reach the case is not a test of it.
function largeSample(): ClientVisibleCampaignMetrics {
  return metrics({
    contactedCount: 2000,
    sentCount: 4000,
    deliveredCount: 3920,
    bouncedCount: 80,
    unsubscribedCount: 20,
    repliedCount: 160,
    positiveReplyCount: 80,
    meetingsBooked: 30,
    meetingsHeld: 18,
  })
}

afterEach(cleanup)

describe('no targets anywhere', () => {
  it('never prints a target line', () => {
    const { container } = render(<BenchmarksView metrics={largeSample()} />)
    const text = container.textContent ?? ''

    // The old card rendered "3–6% · Target ≥ 5%" under Industry Benchmark.
    expect(text).not.toMatch(/Target\s*[≥>]/i)
    expect(text).not.toMatch(/Target\s*\d/i)
    // The one surviving use of the word is the sentence saying there is no target, which
    // is the opposite of the problem.
    expect(text).toContain('context, not targets')
  })

  it('never prints a threshold arrow', () => {
    const { container } = render(<BenchmarksView metrics={largeSample()} />)
    expect(container.textContent).not.toContain('≥')
    expect(container.textContent).not.toContain('>=')
  })

  it('never grades the client against a target', () => {
    const { container } = render(<BenchmarksView metrics={largeSample()} />)
    for (const verdict of ['On track', 'Below target', 'Needs attention', 'Watch this', 'List quality issue', 'Healthy']) {
      expect(container.textContent).not.toContain(verdict)
    }
  })

  it('keeps the industry ranges as context', () => {
    render(<BenchmarksView metrics={largeSample()} />)
    expect(screen.getAllByText('Industry range').length).toBeGreaterThan(0)
    // The unit is printed WITH the range now. A bare "3–6%" is what let a per-email
    // range sit under a per-person rate without anything on screen saying so.
    expect(screen.getByText('0.7–3% of people contacted')).toBeInTheDocument()
    expect(screen.getByText('40–65% of replies')).toBeInTheDocument()
    expect(screen.getByText('0–2% of emails sent')).toBeInTheDocument()
  })

  it('says where a rate sits without saying whether it is good', () => {
    render(<BenchmarksView metrics={largeSample()} />)
    // Bounce 80 of 4,000 is 2.0%, at the top of the 0 to 2 range.
    expect(screen.getAllByText('Within the industry range').length).toBeGreaterThan(0)
  })
})

describe('too early to report', () => {
  it('shows a dash rather than 3.8% for one reply from twenty-six emails', () => {
    const { container } = render(<BenchmarksView metrics={metrics()} />)

    expect(container.textContent).not.toContain('3.8%')
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('says so plainly, and says how far off it is', () => {
    render(<BenchmarksView metrics={metrics()} />)

    expect(screen.getAllByText(/Too early to report a rate/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/374 to go/).length).toBeGreaterThan(0)
  })

  it('shows the counts anyway, because those are true from the first email', () => {
    render(<BenchmarksView metrics={metrics()} />)
    // The reply card names PEOPLE, and says so, because the denominator is the thing a
    // reader has to be able to see. The opt-out card still names emails.
    expect(screen.getByText('1 reply from 15 people contacted')).toBeInTheDocument()
    expect(screen.getByText('1 opted out from 26 emails sent')).toBeInTheDocument()
  })

  it('withholds a zero rate too', () => {
    // 0 meetings from 26 emails is 0%, which is as much noise as 3.8% and reads worse.
    const { container } = render(<BenchmarksView metrics={metrics({ meetingsBooked: 0 })} />)
    expect(container.textContent).not.toContain('0.0%')
  })

  it('gates the positive reply share on replies, not on emails', () => {
    // 1000 emails is plenty for every send-denominated rate, but 3 replies is not enough
    // to say what share of replies were positive.
    render(<BenchmarksView metrics={largeSample()} />)
    expect(screen.queryByText(/around 25 replies/)).not.toBeInTheDocument()

    cleanup()
    render(<BenchmarksView metrics={metrics({ sentCount: 1000, repliedCount: 3, positiveReplyCount: 2 })} />)
    expect(screen.getByText(/around 25 replies/)).toBeInTheDocument()
  })

  it('reports every rate once the sample supports it', () => {
    render(<BenchmarksView metrics={largeSample()} />)

    expect(screen.queryByText(/Too early to report/)).not.toBeInTheDocument()
    // 40 replies from 500 PEOPLE, not from 1000 emails. 8.0%, not 4.0%.
    expect(screen.getByText('8.0%')).toBeInTheDocument()   // reply rate
    expect(screen.getByText('50.0%')).toBeInTheDocument()  // positive share
    expect(screen.getByText('1.5%')).toBeInTheDocument()   // meeting booking
    expect(screen.getByText('2.0%')).toBeInTheDocument()   // bounce
    expect(screen.getByText('0.5%')).toBeInTheDocument()   // opt-out
  })
})

describe('the aggregates a client is always shown', () => {
  it('includes bounce rate and opt-out rate, which had no surface before', () => {
    render(<BenchmarksView metrics={largeSample()} />)

    expect(screen.getByText('Bounce rate')).toBeInTheDocument()
    expect(screen.getByText('Opt-out rate')).toBeInTheDocument()
    expect(screen.getByText('Reply rate')).toBeInTheDocument()
    expect(screen.getByText('Positive reply rate')).toBeInTheDocument()
    expect(screen.getByText('Meeting booking rate')).toBeInTheDocument()
  })
})

describe('the Belkins citation', () => {
  it('is gone', () => {
    const { container } = render(<BenchmarksView metrics={largeSample()} />)

    expect(container.textContent).not.toMatch(/Belkins/i)
    expect(container.querySelector('a[href*="belkins"]')).toBeNull()
  })

  it('leaves the remaining attribution intact and says ranges are not targets', () => {
    render(<BenchmarksView metrics={largeSample()} />)
    expect(screen.getByText(/Industry ranges are context, not targets/)).toBeInTheDocument()
    expect(screen.getByText(/a 2026 study of over 850 million emails/)).toBeInTheDocument()
  })
})

describe('what the first ninety days look like', () => {
  it('starts collapsed, showing the heading and the first line only', () => {
    render(<BenchmarksView metrics={metrics()} />)

    expect(screen.getByText('What the first ninety days look like')).toBeInTheDocument()
    // The lead line is what makes the rest worth opening, so it stays on screen.
    expect(screen.getByText(/Cold outreach is slow before it is fast/)).toBeInTheDocument()
    // The other three paragraphs are behind the disclosure.
    expect(screen.queryByText(/Month two is where the messaging starts earning its keep/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Replies arrive in ones and twos/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Meetings do not arrive evenly/)).not.toBeInTheDocument()
  })

  it('opens on click and closes again', () => {
    render(<BenchmarksView metrics={metrics()} />)
    const toggle = screen.getByRole('button', { name: /What the first ninety days look like/ })

    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/Month two is where the messaging starts earning its keep/)).toBeInTheDocument()
    expect(screen.getByText(/Meetings do not arrive evenly/)).toBeInTheDocument()
    // The lead line is not duplicated once the rest is revealed.
    expect(screen.getAllByText(/Cold outreach is slow before it is fast/)).toHaveLength(1)

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/Month two is where the messaging starts earning its keep/)).not.toBeInTheDocument()
  })

  it('promises no number', () => {
    const { container } = render(<BenchmarksView metrics={metrics()} />)
    const paragraphBlock = screen.getByText(/Cold outreach is slow before it is fast/).parentElement
    expect(paragraphBlock?.textContent).not.toMatch(/\d+(\.\d+)?%/)
    // And no forbidden AI tells crept into the copy.
    for (const tell of ['delve', 'leverage', 'seamless', 'robust', 'Furthermore', 'Moreover']) {
      expect(container.textContent?.toLowerCase()).not.toContain(tell.toLowerCase())
    }
  })

  it('contains no em dash, en dash or double hyphen', () => {
    const { container } = render(<BenchmarksView metrics={metrics()} />)
    const text = container.textContent ?? ''
    // The en dash in "3–6%" is the range separator in a numeric range, which is typography
    // rather than prose, so the check is scoped to the prose block.
    const prose = screen.getByText(/Cold outreach is slow before it is fast/).parentElement?.textContent ?? ''
    expect(prose).not.toContain('—')
    expect(prose).not.toContain('–')
    expect(prose).not.toContain('--')
    expect(text.length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE DENOMINATOR, WHICH IS THE WHOLE POINT OF THIS CARD
//
// Reply rate divided by emails sent until 2026-09-03. A four-step sequence sends up to
// four emails to one person, so that denominator counted the same person up to four times
// and produced a rate roughly a quarter of what published figures mean, then rendered it
// beside a published range measured the other way.
//
// The fixture below is the LIVE CAMPAIGN as measured on 2026-09-03: 24 people, 60 emails,
// 2 replies. 2 of 60 is 3.3%. 2 of 24 is 8.3%. Same performance, nearly three times apart.
//
// These are mutation guards. Putting sentCount back in the denominator turns them red.

describe('reply rate is denominated in people, not emails', () => {
  // The live campaign, exactly as the database held it on 2026-09-03.
  function liveCampaign(): ClientVisibleCampaignMetrics {
    return metrics({
      contactedCount: 24,
      sentCount: 60,
      deliveredCount: 60,
      bouncedCount: 0,
      unsubscribedCount: 0,
      repliedCount: 2,
      positiveReplyCount: 0,
      meetingsBooked: 0,
      meetingsHeld: 0,
    })
  }

  it('names people in the counts line, and never names sent on the reply card', () => {
    render(<BenchmarksView metrics={liveCampaign()} />)

    expect(screen.getByText('2 replies from 24 people contacted')).toBeInTheDocument()
    // The old line. If this ever renders again the denominator has gone back to emails.
    expect(screen.queryByText('2 replies from 60 sent')).not.toBeInTheDocument()
  })

  it('measures the shortfall in people, so the too-early line counts the right thing', () => {
    render(<BenchmarksView metrics={liveCampaign()} />)

    // 400 - 24 = 376 people. On the old denominator it would have been 400 - 60 = 340
    // emails, which is the same sentence measuring a different thing.
    expect(screen.getByText(/376 to go/)).toBeInTheDocument()
    expect(screen.getByText(/around 400 people contacted/)).toBeInTheDocument()
  })

  it('computes 8.3% and not 3.3% once the sample clears the gate', () => {
    // Same 2-to-24 ratio, scaled past the threshold so the rate actually prints. This is
    // the assertion that fails if the denominator goes back to emails: at these values
    // sent-denominated would read 3.3%.
    render(<BenchmarksView metrics={metrics({
      contactedCount: 480, sentCount: 1200, repliedCount: 40,
      bouncedCount: 0, unsubscribedCount: 0, meetingsBooked: 0, positiveReplyCount: 0,
    })} />)

    expect(screen.getByText('8.3%')).toBeInTheDocument()
    expect(screen.queryByText('3.3%')).not.toBeInTheDocument()
  })

  it('leaves bounce, opt-out and the positive share on their own denominators', () => {
    // Bounce and opt-out are per email BY DEFINITION: deliverability is a property of a
    // message, not of a person. The positive share is of replies. None of them move.
    render(<BenchmarksView metrics={largeSample()} />)

    expect(screen.getByText('80 bounced from 4,000 emails sent')).toBeInTheDocument()
    expect(screen.getByText('20 opted out from 4,000 emails sent')).toBeInTheDocument()
    expect(screen.getByText('80 positive from 160 replies')).toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE MEETING RATE IS DENOMINATED IN PEOPLE, AND ITS GATE IS ITS OWN
//
// These are MUTATION GUARDS, written so that undoing the change turns them red rather
// than leaving a green suite over a reverted denominator. Each one names the mutation it
// catches. If you are reading this because one failed, the question is not "why is this
// test strict" but "did the denominator move back".

describe('meeting booking rate is denominated in people, not emails', () => {
  // Deliberately a sample where the two denominators give VISIBLY different answers and
  // both are printable, so neither can pass by rounding into the other.
  //   30 meetings / 2,000 people = 1.5%
  //   30 meetings / 4,000 emails = 0.75%
  function bigEnough(): ClientVisibleCampaignMetrics {
    return metrics({
      contactedCount: 2000,
      sentCount: 4000,
      repliedCount: 160,
      positiveReplyCount: 80,
      bouncedCount: 0,
      unsubscribedCount: 0,
      meetingsBooked: 30,
      meetingsHeld: 18,
    })
  }

  it('computes 1.5% and not 0.75%', () => {
    // MUTATION: put sentCount back under the meeting rate and this reads 0.8%.
    render(<BenchmarksView metrics={bigEnough()} />)

    expect(screen.getByText('1.5%')).toBeInTheDocument()
    expect(screen.queryByText('0.8%')).not.toBeInTheDocument()
    expect(screen.queryByText('0.75%')).not.toBeInTheDocument()
  })

  it('names people in the counts line, and never names sent on the meeting card', () => {
    // The denominator has to be legible on the card. That is the whole reason the defect
    // this file records survived: the unit was in nobody's line of sight.
    render(<BenchmarksView metrics={bigEnough()} />)

    expect(screen.getByText('30 meetings from 2,000 people contacted')).toBeInTheDocument()
    expect(screen.queryByText('30 meetings from 4,000 emails sent')).not.toBeInTheDocument()
  })

  it('gates on 1,500 people, not on the 400 the reply card uses', () => {
    // MUTATION: swap MIN_PEOPLE_FOR_MEETING_RATE for MIN_PEOPLE_FOR_RATE and the meeting
    // rate prints here off 8 meetings, while the reply rate legitimately does not wait.
    render(<BenchmarksView metrics={metrics({
      contactedCount: 800, sentCount: 2000, repliedCount: 64,
      meetingsBooked: 8, bouncedCount: 0, unsubscribedCount: 0, positiveReplyCount: 0,
    })} />)

    // Reply rate clears its own gate at 800 people and prints.
    expect(screen.getByText('8.0%')).toBeInTheDocument()
    // The meeting rate does not: 8 / 800 would be 1.0%.
    expect(screen.queryByText('1.0%')).not.toBeInTheDocument()
    expect(screen.getByText(/around 1,500 people contacted/)).toBeInTheDocument()
    expect(screen.getByText(/700 to go/)).toBeInTheDocument()
  })

  it('measures the meeting shortfall in people, never in emails', () => {
    render(<BenchmarksView metrics={metrics({ contactedCount: 24, sentCount: 60 })} />)
    // 1,500 - 24 people. On the old send denominator it was 400 - 60 = 340 emails, which
    // is the same sentence measuring a different thing.
    expect(screen.getByText(/1,476 to go/)).toBeInTheDocument()
  })
})

describe('the meeting card shows no industry range, and says why', () => {
  it('prints no range and no position pill for meetings', () => {
    render(<BenchmarksView metrics={largeSample()} />)

    // The removed number, in every form it was ever rendered in.
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('1–3%')
    expect(text).not.toContain('1-3%')
    expect(text).not.toContain('1–3% of people contacted')
  })

  it('says the range is absent rather than leaving the heading empty', () => {
    // A heading with nothing under it reads as a loading failure. Silently dropping the
    // number would have been the easy version of this change and the wrong one.
    render(<BenchmarksView metrics={largeSample()} />)

    expect(screen.getByText(/No published range/)).toBeInTheDocument()
    // Said in BOTH places on purpose: on the card, where a reader looking at the meeting
    // rate will see it, and in the attribution, where a reader auditing the sources will.
    // Exactly two, so neither copy can be dropped without this failing.
    expect(screen.getAllByText(/cited a report that does not measure meetings/)).toHaveLength(2)
  })

  it('never claims the meeting rate sits anywhere relative to a range', () => {
    // 30 from 2,000 is 1.5%, which would have been "within" the old 1 to 3 range. With no
    // range there is nothing to be within, and inventing a position would be the deleted
    // number coming back wearing a different hat.
    render(<BenchmarksView metrics={largeSample()} />)

    const meetingCard = screen.getByText('Meeting booking rate').closest('div')
    expect(meetingCard?.textContent).not.toContain('Within the industry range')
    expect(meetingCard?.textContent).not.toContain('Above the industry range')
    expect(meetingCard?.textContent).not.toContain('Below the industry range')
  })
})

describe('every card states the unit it was measured in', () => {
  // The generalisation of the whole defect. A rate whose denominator is invisible is a
  // rate nobody can check, and that is how a per-person number came to be compared with a
  // per-email range for a day without anyone noticing.
  it('names a unit on every counts line', () => {
    render(<BenchmarksView metrics={largeSample()} />)

    for (const line of [
      '160 replies from 2,000 people contacted',
      '80 positive from 160 replies',
      '30 meetings from 2,000 people contacted',
      '80 bounced from 4,000 emails sent',
      '20 opted out from 4,000 emails sent',
    ]) {
      expect(screen.getByText(line)).toBeInTheDocument()
    }
  })

  it('names a unit beside every published range too', () => {
    // Both halves of the comparison, not just ours. A reader who can see only one unit
    // cannot tell whether the two match, which was exactly the state of this page.
    render(<BenchmarksView metrics={largeSample()} />)

    expect(screen.getByText('0.7–3% of people contacted')).toBeInTheDocument()
    expect(screen.getByText('40–65% of replies')).toBeInTheDocument()
    expect(screen.getByText('0–2% of emails sent')).toBeInTheDocument()
    expect(screen.getByText('0–1% of emails sent')).toBeInTheDocument()
  })
})

describe('the reply range is measured per person, matching the rate above it', () => {
  it('no longer shows the per-email range from the Instantly report', () => {
    // 3 to 6% came from a source defining its metric as replies divided by TOTAL EMAILS
    // SENT. It sat under a per-person rate for one day. If it renders again, the range
    // and the rate have gone back to counting different things.
    render(<BenchmarksView metrics={largeSample()} />)

    const text = document.body.textContent ?? ''
    expect(text).not.toContain('3–6%')
    expect(text).not.toContain('3-6%')
  })

  it('cites the two per-person sources by their measurement, not by name alone', () => {
    render(<BenchmarksView metrics={largeSample()} />)

    expect(screen.getByText(/both measured per person contacted/)).toBeInTheDocument()
    expect(screen.getAllByText('Smartlead and ReplyLead · 2026').length).toBeGreaterThan(0)
  })
})
