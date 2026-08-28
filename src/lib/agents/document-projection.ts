// What a downstream generation agent is allowed to see of an upstream strategy document.
//
// WHY THIS EXISTS. The messaging and positioning agents embedded the whole ICP document in
// their prompts with `doc.plain_text ?? JSON.stringify(doc.content, null, 2)`. plain_text is
// NULL on every row in production, so the stringify branch always ran and every top-level
// key went into the prompt verbatim, with no allowlist and no key stripping.
//
// That was tolerable while the ICP held only document content. It stopped being tolerable
// when the ICP gained OPERATOR-FACING keys. unresolved_fields exists so a gap the agent
// could not ground reaches a human before approval. A Tier Two claim flagged under Rule 9
// is an unverified third-party statement awaiting a human check. Neither belongs in a
// prompt that writes copy: a flagged claim is a review item in a document and an assertion
// of fact in an email sent to a stranger under the client's name, and measured 2026-08-28,
// NO OUTBOUND GATE CATCHES ONE. findFirmographicFigures returns [] for
// "The Department of Transport requires every operator to file a compliance audit by March",
// and scrubAITells leaves it untouched.
//
// ALLOWLIST, NOT DENYLIST, AND THAT CHOICE IS THE WHOLE POINT. A denylist is a second list
// kept in step with the schema by hand: add an operator-facing key, forget the denylist, and
// it leaks silently. An allowlist fails closed. A new key is invisible downstream until
// someone deliberately classifies it, and the drift test below makes forgetting a failure
// rather than a leak.
//
// THE CORRECT PATTERN ALREADY EXISTED HERE. src/lib/agents/research/synthesize.ts reads
// named fields off the ICP (tier_1.buyer_profile, tier_1.company_profile, tier_1.four_forces)
// and never stringifies the document, and composition's extractPainFromIcp does the same.
// Those are the two paths that actually reach a prospect's inbox, and both were already
// safe. This module applies their shape to the document-generation chain, which was not.

/**
 * ICP keys a downstream generation agent may read.
 *
 * These are the five keys the ICP output schema has always declared, and a live census of
 * all 15 ICP documents on 2026-08-28 found exactly these plus one legacy operator key.
 */
export const ICP_DOWNSTREAM_KEYS = [
  'jtbd_statement',
  'summary',
  'tier_1',
  'tier_2',
  'tier_3',
] as const

/**
 * ICP keys that are for the operator and must never enter a downstream prompt.
 *
 * unresolved_fields          gaps and flagged Rule 9 Tier Two claims, rendered as the
 *                            approval banner.
 * assumptions_we_have_made   the pre-2026-08-27 disclosure array. The rule that produced it
 *                            is gone, but one live document still carries it, so it is
 *                            classified here rather than left to fall through.
 */
export const ICP_OPERATOR_ONLY_KEYS = [
  'unresolved_fields',
  'assumptions_we_have_made',
] as const

export type IcpDownstreamKey = (typeof ICP_DOWNSTREAM_KEYS)[number]

/**
 * Narrow an ICP document to the keys a downstream generation agent may see.
 *
 * Returns a new object. Never mutates. A non-object input yields {} rather than throwing,
 * because a malformed upstream document should degrade the prompt, not fail the run: the
 * agent already handles a thin ICP, and a hard throw here would turn a bad row into an
 * outage.
 */
export function projectIcpForDownstream(content: unknown): Record<string, unknown> {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return {}
  const source = content as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of ICP_DOWNSTREAM_KEYS) {
    if (key in source) out[key] = source[key]
  }
  return out
}
