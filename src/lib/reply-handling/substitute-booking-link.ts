// src/lib/reply-handling/substitute-booking-link.ts
//
// Deterministic booking link substitution.
// Replaces all occurrences of {booking_link} in the body with the provided URL.
// Returns a result struct so the caller can distinguish "no placeholder" (not a failure)
// from "placeholder present but link missing" (send_failed).

export interface SubstituteBookingLinkResult {
  body: string
  missing: boolean     // true when placeholder present but link is null/empty
  substituted: boolean // true when at least one replacement was made
}

// THE ONE DEFINITION of the booking-link placeholder. The drafting prompt
// (docs/prompts/reply-draft-agent.md) tells the model to write exactly this, and the FAQ
// filler rule imports it rather than restating it. booking-link-placeholder-pair.test.ts
// fails if the prompt and this constant ever disagree, which is the drift that would
// otherwise ship a literal token to a prospect.
export const BOOKING_LINK_PLACEHOLDER = '{booking_link}'
const PLACEHOLDER = BOOKING_LINK_PLACEHOLDER

export function substituteBookingLink(
  body: string,
  bookingLink: string | null,
): SubstituteBookingLinkResult {
  if (!body.includes(PLACEHOLDER)) {
    // No placeholder — not a failure regardless of whether a link was supplied.
    return { body, missing: false, substituted: false }
  }

  if (!bookingLink || !bookingLink.trim()) {
    // Placeholder present but no link — caller must treat as send_failed.
    return { body, missing: true, substituted: false }
  }

  const substituted = body.split(PLACEHOLDER).join(bookingLink)
  return { body: substituted, missing: false, substituted: true }
}
