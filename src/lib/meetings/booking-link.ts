// src/lib/meetings/booking-link.ts
//
// The booking link a prospect is sent, carrying a reference back to that prospect.
//
// WHY. When a prospect books, the booking tool's notification has to be tied back to the
// prospect we emailed. Matching on the address they type into the booking form is only the
// fallback, and it fails whenever someone books with a different address from the one we
// wrote to. So the link itself carries the prospect's id as a query parameter, the booking
// tool fills a hidden booking question of the same name from it, and the notification
// hands it back.
//
// PROSPECT_REF_PARAM is the contract between this module and every booking-tool handler.
// It is vendor-neutral on purpose: any tool with a hidden booking question that can be
// filled from the link carries it. The hidden question must be named exactly this inside
// the booking tool, which is a manual setup step, not something code can do.
// booking-link-roundtrip.test.ts exercises the pair.

export const PROSPECT_REF_PARAM = 'prospect_ref'

/**
 * The stored booking URL with the prospect reference, and any extra parameters, added.
 *
 * With no prospect (a draft with no prospect attached) the link goes out without a
 * reference and the booking can still be matched by email. A stored URL that will not
 * parse is returned exactly as stored rather than mangled.
 */
export function buildProspectBookingLink(
  bookingUrl: string,
  prospectId: string | null,
  extraParams: Record<string, string> = {},
): string {
  const params: Record<string, string> = { ...extraParams }
  if (prospectId) params[PROSPECT_REF_PARAM] = prospectId
  if (Object.keys(params).length === 0) return bookingUrl

  let url: URL
  try {
    url = new URL(bookingUrl)
  } catch {
    return bookingUrl
  }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}
