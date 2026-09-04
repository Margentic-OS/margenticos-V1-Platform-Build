// THE ONE PLACE AN EXCLUDED COUNTRY IS REMOVED FROM A CLIENT'S TARGETING.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A MODULE AND NOT THREE LINES INSIDE deriveFilterSpec
//
// Until this existed the exclusion was enforced in two places that did not agree, at two
// different stages, and neither was authoritative:
//
//   adapter-apollo.ts        LEGALLY_EXCLUDED_COUNTRIES   refuses at SOURCING, before spend
//   send-eligibility-rules.ts EXCLUDED_COUNTRIES          drops at VERIFICATION, after it
//
// The second list is currently a subset of the first, which is exactly the condition
// under which a difference is invisible. A prospect from a country on the first list and
// not the second is refused at sourcing and, if it reaches the database by any other
// route, sails through send eligibility. That has happened: two prospects were held back
// only by a hand-edited boolean, on a column that is recomputed from scratch at every
// re-verification.
//
// This module does not fix that. It is the third layer ADR-034 says is missing, applied
// one stage earlier than either of them: the country never enters the spec, so the query
// is never built for it. Both existing lists stay exactly as they are and keep firing.
// The handler's refusal in particular is left in place as the backstop, and a code
// reaching it is now a bug in this file rather than a client's document.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE UNION, AND WHY IT IS DERIVED RATHER THAN RESTATED
//
// A third hardcoded list of country codes would be the parallel-array shape CLAUDE.md
// warns about, three lists deep, and the drift would be silent in the dangerous
// direction: a country added to one enforcement list and forgotten here would still be
// derived into every client's spec. So this imports both and takes their union. Adding a
// country to either list widens this subtraction automatically, and there is no second
// list to keep in step.
//
// Nothing here names a country. The names live in the two modules that own them.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHERE A PER-CLIENT OVERRIDE WOULD ATTACH
//
// NOT BUILT, and deliberately not stubbed: an unused parameter is speculative machinery
// that reads as a feature. What makes an override addable later without moving anything
// is the property this module already has, which is that EVERY exclusion decision in the
// derivation path flows through applyGeographyExclusions and there is no second path
// around it.
//
// When it is built it belongs as a second argument to this function, carrying the
// operator's recorded decision: who allowed it, when, the lawful basis, and the single
// country it applies to. It is an operator decision with a recorded reason, never a
// client-facing setting and never a field on the ICP document, because a client document
// must not be able to widen a legal constraint. Callers of this function would not
// change; only the value they pass would.

import { LEGALLY_EXCLUDED_COUNTRIES } from '@/lib/sourcing/handlers/adapter-apollo'
import { EXCLUDED_COUNTRIES } from '@/lib/sourcing/send-eligibility-rules'

/**
 * Every country code excluded at any enforcement stage, derived from the stages
 * themselves so it cannot drift from them.
 */
export const ALL_EXCLUDED_COUNTRIES: ReadonlySet<string> = new Set<string>([
  ...LEGALLY_EXCLUDED_COUNTRIES,
  ...EXCLUDED_COUNTRIES,
])

export interface GeographyExclusionOutcome {
  /** The codes that survive, in the order they were given. */
  kept: string[]
  /** The codes removed, in the order they were given. Empty when nothing was excluded. */
  removed: string[]
}

/**
 * Remove every excluded country from a derived country list.
 *
 * Pure. Case-insensitive on input, canonical uppercase on output.
 *
 * THROWS WHEN IT EMPTIES THE LIST, because the alternative is a spec that asks for
 * nowhere. That spec would be stored, look complete, and fail at the sourcing handler
 * days later with an error about the spec rather than about the client's document. A
 * client whose entire stated market is excluded is a commercial conversation and an
 * operator has to have it; it is not a filter result.
 */
export function applyGeographyExclusions(codes: string[]): GeographyExclusionOutcome {
  const normalised = codes.map(code => code.trim().toUpperCase()).filter(code => code.length > 0)

  const kept = normalised.filter(code => !ALL_EXCLUDED_COUNTRIES.has(code))
  const removed = normalised.filter(code => ALL_EXCLUDED_COUNTRIES.has(code))

  if (kept.length === 0) {
    throw new Error(
      'ICP filter spec: every country this ICP names is excluded from outreach ' +
      `(${removed.join(', ')}), so the spec would target nowhere. The exclusions are ` +
      'legal constraints and a client document cannot widen them. An operator has to ' +
      'decide what this client is sold instead.',
    )
  }

  return { kept, removed }
}

// WHAT WAS SUBTRACTED IS RECORDED, AND THE WORDING LIVES ELSEWHERE. `removed` is carried
// through ResolvedGeography into the spec's notes by buildNotes in icp-filter-spec.ts.
// The sentence is written there rather than here because this module imports a handler
// and that one must not import anything that does, which would be a cycle. The decision
// of WHAT was removed is made here and only here; the decision of how to phrase it is
// presentation and belongs with the rest of the notes.
