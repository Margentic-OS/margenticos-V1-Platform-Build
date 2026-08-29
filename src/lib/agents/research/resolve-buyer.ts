// Who the email is being read by, resolved from data rather than assumed.
//
// WHY THIS EXISTS. The writer's system prompt and the judge's question both used to
// name one buyer archetype outright. The judge is the one that cost real copy: it
// compares the written opening against the approved template and picks a winner, and
// it picked by imagining a reader nobody had checked. An opening pitched correctly at
// a different buyer could lose to the template for no reason but the judge picturing
// the wrong person, which is the personalisation layer being graded against a stranger.
//
// A PRECEDENCE ORDER, NOT A BLEND. The two sources answer two different questions and
// are never merged or reconciled, because when copy comes out wrong we have to be able
// to name the single input that caused it. A blend would make every wrong email a
// question about which half was responsible.
//
//   1. the prospect's OWN sourced job title   who THIS PERSON is
//   2. the client's ICP tier-1 buyer title    who this CLIENT sells to
//   3. the category-level fallback            nothing is known, and it says so
//
// THE FALLBACK NAMES NO BUYER TYPE, and that is the point of it. Per CLAUDE.md an agent
// facing thin intake data must FLAG THE GAP rather than fill it with an assumption, and
// a default value is the opposite of flagging: it is a gap made invisible. The same rule
// already forced the identical change on loadClientContext's icpSummary, where
// `buyer ?? <an archetype>` produced a confident description of a client the document
// had never named. A missing title must not resurrect a default here either.

/** Which of the three tiers supplied the description. Logged at every call site. */
export type BuyerSource = 'prospect_title' | 'icp_buyer_title' | 'none'

export interface ResolvedBuyer {
  /**
   * The phrase naming the reader, rendered into the writer's assignment block and the
   * judge's question. Never empty: tier 3 always produces something sayable.
   */
  description: string
  /** Which tier it came from, so a wrong-sounding email is traceable to its input. */
  source: BuyerSource
}

/**
 * Tier 3. Category level, and it names no role, no seniority and no industry.
 *
 * Phrased to complete the same "who is reading this" frame as a real title, so the two
 * prompts need one sentence rather than a branch.
 */
export const BUYER_UNKNOWN = 'not stated. Assume nothing about their role or seniority.'

/**
 * Both inputs are optional at the TYPE level, not just nullable, because one of them
 * arrives out of a JSONB snapshot written before the column existed. A batch entry
 * created by an older phase 1 has no buyer title key at all, so it reads back as
 * `undefined` rather than `null`, and a signature that only accepted `string | null`
 * would be lying about what actually reaches it.
 */
export function resolveBuyer(
  prospectJobTitle: string | null | undefined,
  icpBuyerTitle: string | null | undefined,
): ResolvedBuyer {
  // Whitespace-only counts as absent. The sourced column is free text off a third-party
  // handler, so an empty-but-present string is a real shape, and treating it as a title
  // would render "Who you are writing to:" followed by nothing at all.
  const prospect = prospectJobTitle?.trim()
  if (prospect) return { description: prospect, source: 'prospect_title' }

  const icp = icpBuyerTitle?.trim()
  if (icp) return { description: icp, source: 'icp_buyer_title' }

  return { description: BUYER_UNKNOWN, source: 'none' }
}
