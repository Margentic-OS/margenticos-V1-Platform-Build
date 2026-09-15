// @vitest-environment jsdom
//
// A meeting with a date renders that date. A meeting without one renders a dash.
//
// WHY BOTH HALVES. Until 2026-09-15 the booking path never wrote meetings.meeting_date, so
// every webhook meeting arrived here as null and rendered as a dash. The dash is correct
// BEHAVIOUR for a genuinely dateless row and must stay, so the guard cannot be "never render
// a dash". It has to be "a date that exists is shown", which is the half that was failing.
//
// The database side of the same fix is proved in
// src/lib/meetings/__tests__/record-booking-event.live.test.ts, which runs the client's real
// monthly-count query. This file proves only what the component does with the value.

import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import { MeetingsListCard, type MeetingRow } from '../MeetingsListCard'

// en-GB renders September as "Sept" and December as "Dec", and which of those you get
// depends on the ICU build. Matching /20 Sept?/ rather than a fixed string keeps this test
// about "a date is shown" instead of about a month abbreviation. Times are mid-day UTC on
// purpose: formatMeetingDate renders in the SERVER's local zone, so a booking near midnight
// UTC would legitimately render as the adjacent day and make this test about timezones.

afterEach(cleanup)

function meeting(overrides: Partial<MeetingRow> = {}): MeetingRow {
  return {
    id: 'm1',
    prospectFirstName: 'Sam',
    prospectLastName: 'Okafor',
    company: 'Northwind Advisory',
    meetingDate: '2026-09-20T14:00:00.000Z',
    qualification: null,
    revenueValue: null,
    ...overrides,
  }
}

describe('a meeting that carries a date', () => {
  it('renders the date rather than a dash', () => {
    render(<MeetingsListCard meetings={[meeting()]} launchDate={null} currency="USD" />)

    expect(screen.getByText(/^20 Sept?$/)).toBeInTheDocument()
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })

  it('renders the month it is actually in', () => {
    render(<MeetingsListCard meetings={[meeting({ meetingDate: '2026-12-08T14:00:00.000Z' })]} launchDate={null} currency="USD" />)

    expect(screen.getByText(/^8 Dec$/)).toBeInTheDocument()
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })
})

describe('a meeting with no date', () => {
  it('still renders, with a dash, because a dateless row is not an error', () => {
    render(<MeetingsListCard meetings={[meeting({ meetingDate: null })]} launchDate={null} currency="USD" />)

    // Present in the list: the row was never the thing that went missing.
    expect(screen.getByText('Sam Okafor')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})
