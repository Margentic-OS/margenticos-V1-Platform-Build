// Changes the tuner is not allowed to make, and what it does instead of making them.
//
// ─── THE RULE, AND WHY IT REPORTS RATHER THAN DEGRADES ───────────────────────
//
// Two changes are forbidden outright:
//
//   1. A COUNTRY THE LEGAL SUBTRACTION WOULD REMOVE. The exclusion list is a legal
//      constraint, not a targeting preference, and it is the one thing a client's own
//      document is not allowed to widen. The sourcing handler already refuses such a spec;
//      the tuner must never propose one in the first place, because a proposal sitting in
//      front of an operator with an Approve button is a different kind of object from a
//      query that throws.
//
//   2. WIDENING PAST WHAT THE CLIENT'S OWN DOCUMENT STATES. The tuner's job is to make a
//      search find the people the document describes. Adding a classification code or a
//      size the document never named is not tuning, it is deciding who the client sells to,
//      and it would do so with no approval step and no evidence.
//
// WHEN A WANTED CHANGE IS FORBIDDEN, THE RUN REPORTS THAT AS ITS REASON AND STOPS. It does
// not fall back to a smaller legal change. A lesser change made silently is the worst of
// both: the operator sees a result rather than a question, the actual problem stays
// unsolved, and nothing anywhere records that the tuner wanted to do something it could
// not. That is the shape this project keeps finding and it is why the state exists.

import { ALL_EXCLUDED_COUNTRIES } from '@/lib/sourcing/geography-exclusion'
import type { ProposedChange } from '@/lib/tuner/types'

export interface ForbiddenVerdict {
  forbidden: boolean
  /** Operator-facing, and it names what was wanted rather than only that it was refused. */
  reason: string
}

const ALLOWED = { forbidden: false, reason: '' } as const

/**
 * What the client's own document permits, read off the stored spec.
 *
 * The spec IS the document's statement, mechanically derived from it, so it is the right
 * thing to compare against. Comparing against the document's prose instead would mean
 * re-parsing it here and disagreeing with the derivation about what it said.
 */
export interface DocumentBounds {
  industryCodes: readonly string[]
  jobTitles: readonly string[]
  seniorities: readonly string[]
  companyCountries: readonly string[]
  personCountries: readonly string[]
}

/**
 * Is this change allowed?
 *
 * Every change the loop wants to make goes through here before it reaches a plan. There is
 * no second path: `proposeChange` in the loop returns only what this function permits, and
 * a refusal becomes the run's terminal reason.
 */
export function checkForbidden(change: ProposedChange, bounds: DocumentBounds): ForbiddenVerdict {
  // ── Dropping is always within bounds ──
  //
  // Removing an item can only narrow, and narrowing cannot introduce a country the
  // subtraction removes nor reach a population the document did not describe. The interesting
  // cases are all on the adding side.
  if (change.action === 'drop_item') return ALLOWED

  if (change.action === 'relax_layer') {
    // Relaxing a layer removes a constraint the document stated, which widens past it.
    // The two person-side layers are the exception ONLY as a measurement: the ceiling
    // relaxes them to produce a number, and that number is never proposed as a change.
    return {
      forbidden: true,
      reason:
        `Wanted to relax the ${change.axis} layer. That widens the search past what the ` +
        `client's own document states, which is a decision about who they sell to rather ` +
        `than a correction to how the search finds them. It needs the document changed, ` +
        `not the search. ${change.evidence}`,
    }
  }

  if (change.action === 'add_word') {
    const value = (change.value ?? '').trim()
    if (value.length === 0) {
      return { forbidden: true, reason: 'Wanted to add an empty search word, which constrains nothing.' }
    }

    // A search word narrows within the population the codes already select. It cannot reach
    // outside the document's industries and it cannot name a country. So it is allowed, and
    // this is the one adding action that is.
    return ALLOWED
  }

  return { forbidden: true, reason: `Unrecognised change action, refused rather than guessed at.` }
}

/**
 * Would this set of country codes survive the legal subtraction?
 *
 * Checked separately from `checkForbidden` because it applies to a whole proposed country
 * list rather than to one change, and because it must be callable on any list the tuner is
 * about to put in front of a person, however that list was arrived at.
 *
 * The excluded set is IMPORTED, never restated. A second copy of a legal exclusion list is
 * a second thing to keep in step, and the direction it drifts is the dangerous one.
 */
export function checkCountriesPermitted(codes: readonly string[]): ForbiddenVerdict {
  const blocked = codes.filter(c => ALL_EXCLUDED_COUNTRIES.has(c.toUpperCase()))
  if (blocked.length === 0) return ALLOWED
  return {
    forbidden: true,
    reason:
      `Wanted to propose ${blocked.length} ${blocked.length === 1 ? 'country' : 'countries'} that the ` +
      `legal subtraction removes. This is refused outright rather than quietly dropped: a plan ` +
      `an operator can approve must never contain one, and silently proposing the remainder ` +
      `would hide that the tuner wanted to go somewhere it may not.`,
  }
}

/** Every code, title and seniority the client's own document put on the table. */
export function boundsFromSpec(spec: Record<string, unknown>, request: Record<string, unknown>): DocumentBounds {
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return {
    industryCodes: arr(request.organization_naics_codes),
    jobTitles: arr(request.person_titles),
    seniorities: arr(request.person_seniorities),
    companyCountries: arr(spec.company_countries),
    personCountries: arr(spec.person_countries),
  }
}
