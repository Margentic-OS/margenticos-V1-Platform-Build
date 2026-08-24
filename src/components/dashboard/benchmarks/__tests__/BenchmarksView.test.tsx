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
import { render, screen, cleanup } from '@testing-library/react'
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
    hasData: true,
    ...overrides,
  }
}

// A sample large enough for every send-denominated card to report.
function largeSample(): ClientVisibleCampaignMetrics {
  return metrics({
    contactedCount: 500,
    sentCount: 1000,
    deliveredCount: 980,
    bouncedCount: 20,
    unsubscribedCount: 5,
    repliedCount: 40,
    positiveReplyCount: 20,
    meetingsBooked: 15,
    meetingsHeld: 9,
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
    expect(screen.getByText('3–6%')).toBeInTheDocument()
    expect(screen.getByText('40–65%')).toBeInTheDocument()
  })

  it('says where a rate sits without saying whether it is good', () => {
    render(<BenchmarksView metrics={largeSample()} />)
    // 40 replies from 1000 is 4%, inside the 3 to 6 range.
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
    expect(screen.getByText('1 reply from 26 sent')).toBeInTheDocument()
    expect(screen.getByText('1 opted out of 26 sent')).toBeInTheDocument()
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
    expect(screen.getByText('4.0%')).toBeInTheDocument()   // reply rate
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
    expect(screen.getByText(/a 2025 cold email industry report/)).toBeInTheDocument()
  })
})

describe('what the first ninety days look like', () => {
  it('is a plain paragraph block on the page', () => {
    render(<BenchmarksView metrics={metrics()} />)

    expect(screen.getByText('What the first ninety days look like')).toBeInTheDocument()
    expect(screen.getByText(/Cold outreach is slow before it is fast/)).toBeInTheDocument()
    expect(screen.getByText(/Month two is where the messaging starts earning its keep/)).toBeInTheDocument()
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
