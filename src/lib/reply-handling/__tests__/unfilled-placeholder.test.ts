// The shape matcher behind the last check before a reply is sent. The two send paths
// prove the check is WIRED IN (send-approved-draft.test.ts, reply-line-breaks-survive.test.ts);
// this file proves what it recognises.

import { describe, it, expect } from 'vitest'
import { findUnfilledPlaceholder } from '../unfilled-placeholder'

describe('findUnfilledPlaceholder', () => {
  it('finds a single-brace token, whatever its name', () => {
    expect(findUnfilledPlaceholder('Book here: {booking_link}')).toBe('{booking_link}')
    expect(findUnfilledPlaceholder('Book here: {some_future_token}')).toBe('{some_future_token}')
  })

  it('finds a double-brace token, including one with spaces inside', () => {
    expect(findUnfilledPlaceholder('Hi {{first_name}},')).toBe('{{first_name}}')
    expect(findUnfilledPlaceholder('Hi {{ first_name }},')).toBe('{{ first_name }}')
  })

  it('is case-insensitive, so a capitalised token cannot slip through', () => {
    expect(findUnfilledPlaceholder('Book: {Booking_Link}')).toBe('{Booking_Link}')
  })

  it('passes an ordinary finished reply, link and sign-off included', () => {
    const body = 'Hi Sam,\n\nGrab a slot that works: https://booking.test/alex?ref=1&utm_source=reply\n\nAlex'
    expect(findUnfilledPlaceholder(body)).toBeNull()
  })

  it('does not mistake braces that are not a token for one', () => {
    expect(findUnfilledPlaceholder('A set like {1, 2, 3} is not a token.')).toBeNull()
    expect(findUnfilledPlaceholder('Empty braces {} are not a token either.')).toBeNull()
  })
})
