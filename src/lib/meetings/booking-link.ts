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
 * The stored booking URL with the prospect reference added, and nothing else.
 *
 * With no prospect (a draft with no prospect attached) the link goes out without a
 * reference and the booking can still be matched by email. A stored URL that will not
 * parse is returned exactly as stored rather than mangled.
 *
 * DELIBERATELY NO EXTRA PARAMETERS. This took an extraParams argument, and the reply path
 * passed utm_source=reply and utm_medium=email on every link it built. Those were identical
 * every time and nothing of ours read them back, so on 2026-09-14 they went, and the
 * argument that carried them went with them: a parameter no caller uses is an invitation to
 * add a constant back. booking-link-roundtrip.test.ts asserts the link carries prospect_ref
 * and nothing else, so re-adding one fails a test rather than just widening a URL.
 */
export function buildProspectBookingLink(
  bookingUrl: string,
  prospectId: string | null,
): string {
  if (!prospectId) return bookingUrl

  let url: URL
  try {
    url = new URL(bookingUrl)
  } catch {
    return bookingUrl
  }
  url.searchParams.set(PROSPECT_REF_PARAM, prospectId)
  return url.toString()
}
