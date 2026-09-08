// A seniority parameter for tests, DERIVED FROM THE PROVIDER'S OWN LIST.
//
// ─── WHY NOT JUST WRITE THE BANDS OUT ────────────────────────────────────────
//
// Because a band name in a fixture is a band name in the repository, and the whole defect
// this replaced was band names living in code. A fixture is where that comes back: it is
// the least-read file in a change, it gets copied into the next test, and within a few
// commits the vocabulary is spread across a dozen files again.
//
// So these are taken from PROVIDER_SENIORITY_BANDS by position. No test needs to know what
// any particular band means; every test here cares only whether the set is empty, non-empty
// or invalid. If the provider's list ever changes, these follow it and nothing needs editing.

import {
  PROVIDER_SENIORITY_BANDS,
  type ProviderSeniorityBand,
} from '@/lib/sourcing/handlers/provider-seniority'
import type { SpecSeniority } from '@/lib/agents/icp-filter-spec'

/** `count` bands off the provider's own list. Never a written-out name. */
export function someBands(count = 2): ProviderSeniorityBand[] {
  return PROVIDER_SENIORITY_BANDS.slice(0, count)
}

/** A usable seniority parameter, the shape a real derivation produces. */
export function seniorityFixture(count = 2): SpecSeniority {
  return {
    bands: someBands(count),
    discarded: [],
    evidence: 'Derived from the documents for the purposes of this test.',
  }
}

/**
 * The shape a derivation produces when the documents do not establish a level.
 *
 * Exported so the refusal is tested against the exact value the agent would return, not
 * against a hand-built approximation of it.
 */
export const NO_SENIORITY: SpecSeniority = { bands: [], discarded: [], evidence: '' }
