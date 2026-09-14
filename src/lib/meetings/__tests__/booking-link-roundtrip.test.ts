// The PAIR: the link we send carries the prospect reference, and the booking-tool handler
// reads the same reference back. Each side has its own tests; this is the one that fails if
// they stop agreeing on the parameter's name, which is the producer-and-consumer shape that
// mailed two prospects in August (CLAUDE.md, "A producer and a consumer that are each
// correct and disagree on FORMAT").
//
// WHAT THIS CANNOT PROVE: that the booking tool copies a URL parameter into its hidden
// booking question. That is the tool's behaviour, set up by hand, and is proven only by a
// real booking made through a real link. See the operator steps in ADR-056.

import { describe, it, expect } from 'vitest'
import { buildProspectBookingLink, PROSPECT_REF_PARAM } from '../booking-link'
import { parseCalComEvent } from '@/lib/integrations/handlers/cal-com/webhook'

const PROSPECT_ID = '11111111-2222-3333-4444-555555555555'

describe('the prospect reference survives the round trip', () => {
  it('what the link carries is what the handler reads back', () => {
    const link = new URL(buildProspectBookingLink('https://booking.test/host/30min', PROSPECT_ID))
    const carried = link.searchParams.get(PROSPECT_REF_PARAM)
    expect(carried).toBe(PROSPECT_ID)

    // The booking tool fills the hidden question named PROSPECT_REF_PARAM from the link and
    // returns it among the booking answers, as { label, value }.
    const event = parseCalComEvent({
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        uid: 'booking-uid-1',
        organizer: { email: 'host@example.test' },
        attendees: [{ email: 'sam@example.test', name: 'Sam' }],
        responses: { [PROSPECT_REF_PARAM]: { label: PROSPECT_REF_PARAM, value: carried } },
      },
    })

    expect(event).toMatchObject({ kind: 'created', prospectRef: PROSPECT_ID })
  })
})

describe('buildProspectBookingLink', () => {
  it('keeps a query string the stored link already had', () => {
    const link = new URL(buildProspectBookingLink('https://booking.test/host?month=2026-09', PROSPECT_ID))
    expect(link.searchParams.get('month')).toBe('2026-09')
    expect(link.searchParams.get(PROSPECT_REF_PARAM)).toBe(PROSPECT_ID)
  })

  it('adds the reference and NOTHING else', () => {
    // CHANGED 2026-09-14. This asserted that extra parameters were added alongside the
    // reference, and the reply path used it to attach utm_source=reply and utm_medium=email
    // to every link. They were the same on every link and nothing read them back, so both
    // they and the argument are gone.
    //
    // The assertion is now on the ABSENCE, and it is deliberately an exact key list rather
    // than a check for the ones that were removed: a constant query parameter is exactly the
    // kind of thing somebody adds back "just in case", and naming only utm_source would not
    // catch the next one.
    const link = new URL(buildProspectBookingLink('https://booking.test/host', PROSPECT_ID))
    expect([...link.searchParams.keys()]).toEqual([PROSPECT_REF_PARAM])
    expect(link.searchParams.get(PROSPECT_REF_PARAM)).toBe(PROSPECT_ID)
  })

  it('sends the stored link unchanged when there is no prospect', () => {
    expect(buildProspectBookingLink('https://booking.test/host', null)).toBe('https://booking.test/host')
  })

  it('returns a link that will not parse exactly as stored, rather than mangling it', () => {
    expect(buildProspectBookingLink('not a url', PROSPECT_ID)).toBe('not a url')
  })
})
