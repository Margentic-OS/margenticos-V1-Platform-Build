// THE SEND GATE, WRITTEN ONCE.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A MODULE AND NOT SEVEN CHAINED FILTERS
//
// This predicate was written out by hand THREE times, identically:
//
//   actions.ts:304  the suppression pre-filter, which decides what composition is paid for
//   actions.ts:343  the compare-and-set claim, which decides what is actually uploaded
//   page.tsx:102    the operator's "ready to send" count, which is how many the operator
//                   believes the send will be
//
// Three copies of seven filters, agreeing only because nobody had edited one of them yet,
// and nothing failing if one clause were deleted from one of them. The count is the worst
// place for it to drift: an operator reading a number that does not match what the claim
// will take has no way to notice.
//
// This is the same shape as the verification_calls finding in CLAUDE.md, where RLS was the
// only layer standing and there was nothing behind it. The tier clause in particular is now
// the only thing between a tier-rejected prospect and Instantly, so it must not live in
// three hand-copies.
//
// ═════════════════════════════════════════════════════════════════════════════
// EACH CLAUSE, AND WHY IT IS HERE
//
//   organisation_id           client isolation, per CLAUDE.md. Never optional.
//   outbound_upload_status    'pending' is the only sendable state. 'uploading' is claimed,
//                             'uploaded' is done, 'failed' needs a human.
//   email NOT NULL            nothing to send to.
//   sourced_tier NOT NULL     the tier verdict. See tier-verdict.ts.
//   email_send_eligible       the deliverability verdict, materialised at verification.
//                             It means the ADDRESS is deliverable and nothing else.
//   client_review_status      the client is the gatekeeper on who gets contacted.
//   suppressed = false        THIS DOES NOT COVER BOUNCES. Corrected 2026-09-04; the
//                             comment here previously read "opted out, bounced, or
//                             disqualified" and the middle word was false.
//                             prospects.suppressed carries FOUR per-organisation meanings,
//                             none of them deliverability: client rejection, research
//                             disqualification, an explicit opt-out reply, and a sourcing
//                             dedupe block. A bounce writes the GLOBAL suppressed_emails
//                             table and never touches this column, deliberately, because
//                             deriving one from the other destroys all four meanings.
//                             So this predicate ALONE does not gate a bounced address.
//                             findBlockedProspects in src/lib/suppression/send-gate.ts
//                             checks both stores, and every send path must go through it.
//                             The one caller that does not is the operator's ready-to-send
//                             count, which therefore overstates. Tracked in the Notion
//                             Backlog, gate "Before first paying client".

import { requireTierPresent } from '@/lib/sourcing/tier-verdict'

/** The minimum of a PostgREST filter builder this gate needs. */
interface SendGateFilterable<Q> {
  eq(column: string, value: unknown): Q
  not(column: string, operator: string, value: unknown): Q
}

/**
 * Applies every condition a prospect must meet to be uploaded to the outbound provider.
 *
 * Takes the builder AFTER .select() or .update() so the same predicate serves a read, a
 * count and a compare-and-set update without any of them restating it.
 */
export function applySendGate<Q extends SendGateFilterable<Q>>(query: Q, organisationId: string): Q {
  const withoutTier = query
    .eq('organisation_id', organisationId)
    .eq('outbound_upload_status', 'pending')
    .not('email', 'is', null)

  return requireTierPresent<Q>(withoutTier)
    .eq('email_send_eligible', true)
    .eq('client_review_status', 'approved')
    .eq('suppressed', false)
}
