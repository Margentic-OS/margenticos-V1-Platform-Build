// @vitest-environment jsdom
//
// The client pipeline renders money in the ORGANISATION'S currency, never a fixed symbol.
//
// WHAT THIS GUARDS, and why it is written as a mutation test rather than a snapshot.
// Until 2026-09-15 both cards formatted money with a hardcoded pound sign and neither read
// organisations.currency. A client whose record said EUR was shown their pipeline value in
// pounds: not merely mislabelled, but wrong by whatever the rate was. A snapshot would have
// locked that in. So every assertion here is a PAIR — the right symbol present AND the
// pound sign absent — because only the second half fails when someone reinstates a literal.

import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import { MeetingsListCard, type MeetingRow } from '../MeetingsListCard'
import { StatsRow } from '../StatsRow'
import {
  formatCurrency,
  toOrganisationCurrency,
  DEFAULT_CURRENCY,
} from '@/lib/currency/format-currency'

afterEach(cleanup)

const meeting: MeetingRow = {
  id: 'm1',
  prospectFirstName: 'Sam',
  prospectLastName: 'Okafor',
  company: 'Northwind Advisory',
  meetingDate: '2026-09-20T14:00:00.000Z',
  qualification: 'qualified',
  revenueValue: 45000,
}

describe('formatCurrency', () => {
  it('uses the symbol of the currency it is given, not a default', () => {
    expect(formatCurrency(45000, 'EUR')).toBe('€45k')
    expect(formatCurrency(45000, 'USD')).toBe('$45k')
    expect(formatCurrency(45000, 'GBP')).toBe('£45k')
  })

  it('keeps the existing thousands shape, which this change was not about', () => {
    expect(formatCurrency(999, 'USD')).toBe('$999')
    expect(formatCurrency(1000, 'USD')).toBe('$1k')
  })
})

describe('toOrganisationCurrency', () => {
  it('passes through every value the database CHECK admits', () => {
    expect(toOrganisationCurrency('GBP')).toBe('GBP')
    expect(toOrganisationCurrency('EUR')).toBe('EUR')
    expect(toOrganisationCurrency('USD')).toBe('USD')
  })

  it('falls back rather than crashing a client dashboard on an unreadable value', () => {
    expect(toOrganisationCurrency(null)).toBe(DEFAULT_CURRENCY)
    expect(toOrganisationCurrency(undefined)).toBe(DEFAULT_CURRENCY)
    expect(toOrganisationCurrency('YEN')).toBe(DEFAULT_CURRENCY)
  })

  it('defaults to USD, the decided currency', () => {
    expect(DEFAULT_CURRENCY).toBe('USD')
  })
})

// ─── The mutation guard: an EUR organisation must not render in pounds ────────

describe('an organisation set to EUR', () => {
  it('renders its meeting revenue in EUR and not in pounds', () => {
    render(<MeetingsListCard meetings={[meeting]} launchDate={null} currency="EUR" />)

    expect(screen.getByText(/€45k/)).toBeInTheDocument()
    // The half that bites when a literal comes back.
    expect(document.body.textContent).not.toContain('£')
  })

  it('renders its pipeline value in EUR and not in pounds', () => {
    render(
      <StatsRow qualifiedMeetings={1} totalMeetings={1} pipelineValue={45000} replyRate={4.2} currency="EUR" />,
    )

    expect(screen.getByText('€45k')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('£')
  })
})

describe('an organisation set to USD', () => {
  it('renders both cards in dollars', () => {
    const { unmount } = render(
      <MeetingsListCard meetings={[meeting]} launchDate={null} currency="USD" />,
    )
    expect(screen.getByText(/\$45k/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('£')
    unmount()

    render(
      <StatsRow qualifiedMeetings={1} totalMeetings={1} pipelineValue={45000} replyRate={4.2} currency="USD" />,
    )
    expect(screen.getByText('$45k')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('£')
  })
})

// A GBP organisation still renders correctly. The fix is "read the column", not "ban the
// pound": banning it would be the same hardcoding with a different literal.
describe('an organisation set to GBP', () => {
  it('still renders in pounds, because the column says so', () => {
    render(<MeetingsListCard meetings={[meeting]} launchDate={null} currency="GBP" />)
    expect(screen.getByText(/£45k/)).toBeInTheDocument()
  })
})
