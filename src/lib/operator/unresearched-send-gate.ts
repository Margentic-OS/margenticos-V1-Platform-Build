// HOW MANY OF THE PROSPECTS ABOUT TO BE SENT HAVE NEVER BEEN RESEARCHED.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// Research and upload have no enforced relationship, and that is deliberate: an
// unresearched send is sometimes the correct send. The variant's own authored opener is
// good copy that a human approved, and shipping it to a good-fit prospect is a decision
// an operator is allowed to make.
//
// What was missing was not a rule. It was the sentence on the screen. An upload of 21
// prospects went out where 18 had never been researched, all 18 shipped the authored
// opener, and nothing anywhere on the page said so. The operator read one number, "21
// pending", and it was correct; it just did not carry the consequence.
//
// So this is VISIBILITY, not a gate. Nothing here blocks, disables or shrinks an upload.
//
// ═════════════════════════════════════════════════════════════════════════════
// ONE GATE, TWO COUNTS, AND WHY THE DERIVATION IS THE WHOLE POINT
//
// The unresearched count is the ready-to-send count plus one clause. It is written that
// way LITERALLY: unresearchedSendGateCountQuery calls sendGateCountQuery and adds a single
// filter to what comes back. There is no second copy of the predicate to keep in step,
// and no way to express a version where the two counts are gated differently, because
// there is only one place the gate is applied.
//
// This is the parallel-arrays lesson from CLAUDE.md in its other form. Two numbers an
// operator compares in their head ("18 of these 21") are exactly as trustworthy as the
// guarantee that they were drawn from the same population. A hand-copied predicate would
// agree only until somebody edited one of them, and the failure would be silent: both
// numbers would still render, and neither would look wrong.
//
// THE RESEARCH CLAUSE DOES NOT GO INTO applySendGate, and that is a decision rather than a
// convenience. Putting it there would narrow the claim itself, so the upload would quietly
// take fewer prospects than the operator asked for, and the operator's own count would
// shrink to match with nothing explaining the difference. A number that silently agrees
// with a changed population is the failure this area keeps repeating. The gate decides who
// CAN be sent. This module only describes them.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT "NEVER RESEARCHED" MEANS, AND THE BOUNDARY IT DOES NOT CROSS
//
// research_ran_at IS NULL. The research agent stamps it on every run
// (prospect-research-agent-v2.ts:217), and src/lib/operator/sourcing-metrics.ts:358
// already defines "researched" as exactly this column being non-null, so this count and
// the sourcing metrics cannot disagree about what the word means.
//
// It is NOT the same question as "will ship the authored opener", and the difference is
// worth stating because the two are easy to conflate. Composition ships the authored
// opener whenever prospects.personalisation_trigger is empty (compose-sequence.ts,
// resolveTrigger). That set is strictly WIDER: it also contains prospects that were
// researched and whose writer then stopped for want of a usable candidate. Those are
// already on the screen, listed one by one, in WriterStoppedPanel, together with
// synthesis's own note explaining each decision.
//
// So this count deliberately covers the prospects NOTHING else on the page mentions, and
// double-counting the writer-stopped ones here would make two panels disagree about the
// same prospect. Every prospect counted here does ship the authored opener, because a
// prospect that has never been researched cannot have a personalisation trigger.

import { applySendGate } from '@/lib/sourcing/send-gate'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'

/** The column the research agent stamps on every run. Absent means never researched. */
export const RESEARCH_RAN_COLUMN = 'research_ran_at'

/**
 * The operator's "ready to send" head-count: every prospect the upload will claim.
 *
 * Returns the builder rather than the number so the caller can await it alongside its
 * other reads, and so the unresearched count below can be derived from this exact query.
 */
export function sendGateCountQuery(serviceRole: ServiceRoleClient, organisationId: string) {
  return applySendGate(
    serviceRole.from('prospects').select('id', { count: 'exact', head: true }),
    organisationId,
  )
}

/**
 * Of those, the ones that have never been researched and will therefore ship the client's
 * authored opener.
 *
 * One clause added to the query above. Deriving it is what makes "18 of these 21" a
 * comparison of one population against itself rather than of two numbers that happen to
 * have been written to agree.
 */
export function unresearchedSendGateCountQuery(
  serviceRole: ServiceRoleClient,
  organisationId: string,
) {
  return sendGateCountQuery(serviceRole, organisationId).is(RESEARCH_RAN_COLUMN, null)
}

/**
 * The sentence the operator reads, or null when there is nothing to say.
 *
 * Plain language on purpose. The number alone ("18 unresearched") states a fact about the
 * database; the operator needs the consequence, which is which opening line goes out. It
 * names the standard opener as the thing that will be sent rather than describing research
 * as missing, because the operator is about to press a button and what matters is what
 * lands in the inbox.
 *
 * NULL AT ZERO, which is the requirement and not an oversight. A reassuring "0 of 21
 * unresearched" is one more thing to read on a screen that already has plenty, and a badge
 * that is usually empty teaches an operator to stop looking at that corner of the page.
 * When every prospect has been researched the panel says nothing at all.
 */
export function describeUnresearchedOpener(
  pendingCount: number,
  unresearchedCount: number,
): string | null {
  if (unresearchedCount <= 0) return null

  const subject = unresearchedCount === 1
    ? '1 of these ' + pendingCount + ' has never been researched'
    : unresearchedCount + ' of these ' + pendingCount + ' have never been researched'

  const consequence = unresearchedCount === 1
    ? 'It will send your standard opening line, not one written for that person.'
    : 'They will send your standard opening line, not one written for each person.'

  return subject + '. ' + consequence
}

/**
 * The same fact, short enough for the button the operator actually presses.
 *
 * The sentence above sits in the panel; this rides on the button. Both come from one count
 * so the button cannot promise something the panel contradicts, which is the failure mode
 * when a warning lives next to a control instead of on it: the operator reads the control.
 */
export function describeUnresearchedOnButton(unresearchedCount: number): string | null {
  if (unresearchedCount <= 0) return null
  return unresearchedCount === 1
    ? '1 with your standard opener'
    : unresearchedCount + ' with your standard opener'
}

// ═════════════════════════════════════════════════════════════════════════════
// AND HOW MANY OF THEM THE SUPPRESSION LIST WILL DROP
//
// applySendGate is a SQL predicate, and there is one thing it structurally cannot see.
// A bounce does NOT write prospects.suppressed. It writes the global suppressed_emails
// table, deliberately, because prospects.suppressed carries four per-organisation
// meanings and deriving one from the other destroys all four. The header of
// src/lib/sourcing/send-gate.ts says this in full, and names this count as the one
// caller that did not consult the second store.
//
// So the send dropped prospects the count had promised, and nothing explained the gap.
// The operator read a number, pressed upload, and a smaller number went out.
//
// WHAT THIS DOES NOT DO: it does not narrow the claim. The upload still attempts the
// whole ready-to-send population and the gate still drops these at send time, exactly as
// before. This only puts the difference on the screen, which is the same choice the
// unresearched count above makes and for the same reason: a number that silently shrinks
// to match a changed population is the failure this area keeps repeating.
//
// Over this population gate 1 can never fire, because applySendGate has already required
// suppressed = false and client_review_status = 'approved'. Everything counted here is
// therefore a globally suppressed address: a bounce or an opt-out recorded anywhere.

import { findBlockedProspects } from '@/lib/suppression/send-gate'

/**
 * How many of the ready-to-send population the suppression chokepoint will block.
 *
 * Reads the SAME gate as sendGateCountQuery, so the two cannot be drawn from different
 * populations. Throws rather than returning 0 on a failed read: a zero here reads as
 * "the gate will drop nothing", which is the reassuring direction and the one an operator
 * cannot check. That matches requireCount on the page that calls this.
 */
export async function sendGateBlockedCount(
  serviceRole: ServiceRoleClient,
  organisationId: string,
): Promise<number> {
  const { data, error } = await applySendGate(
    serviceRole.from('prospects').select('id, email'),
    organisationId,
  )

  if (error) {
    throw new Error(
      `suppression-blocked count failed for organisation ${organisationId}: ${error.message}`,
    )
  }

  const candidates = (data ?? []) as { id: string; email: string | null }[]
  const result = await findBlockedProspects(serviceRole, organisationId, candidates)

  if (!result.ok) {
    throw new Error(
      `suppression-blocked count failed for organisation ${organisationId}: ${result.error}`,
    )
  }

  return result.blocked.size
}
