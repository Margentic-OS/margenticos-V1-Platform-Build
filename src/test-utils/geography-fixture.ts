// Country codes for tests, COMPUTED FROM THE REAL CONSTANTS AND NEVER TYPED OUT.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY NOT JUST WRITE THE CODES IN THE TEST
//
// Two reasons, and the second is the one that keeps this file honest.
//
// 1. No real country name, in any form, may be added to this codebase outside the two
//    modules that own them: the alias table in country-code.ts and each handler's own
//    translation table. An ISO-2 code is a country name in two letters. A test fixture
//    naming one is the same failure as a prompt naming one, with a longer fuse: fixtures
//    get copied into new tests, and eventually into a default.
//
// 2. A hand-written code would be a THIRD copy of a membership decision that already
//    exists twice. If a country moved onto the excluded list, a test asserting on a
//    literal would keep passing while asserting the opposite of the truth. Derived
//    fixtures cannot drift: change either constant and these change with it.
//
// ═════════════════════════════════════════════════════════════════════════════
// EVERY GETTER HERE THROWS WHEN IT FINDS NOTHING
//
// A fixture builder that returns undefined, or an empty array, produces a test that
// passes vacuously. That is worse than a failing test, because the suite reports it as
// coverage. So each of these states the population it drew from and fails loudly if that
// population is empty, which is the same discipline as the migration-scan test that must
// fail rather than pass when it finds no views at all.

import { ALL_EXCLUDED_COUNTRIES } from '@/lib/sourcing/geography-exclusion'
import { apolloHandler } from '@/lib/sourcing/handlers/adapter-apollo'
import { knownIso2CountryCodes } from '@/lib/sourcing/country-code'

/** Every country the active handler can translate. */
const TARGETABLE: readonly string[] = apolloHandler.targetable_countries

function firstOrThrow(codes: string[], what: string): string {
  if (codes.length === 0) {
    throw new Error(
      `geography-fixture: found no ${what}. The test that called this cannot prove ` +
      'anything, and returning a placeholder would let it pass while proving nothing.',
    )
  }
  return codes[0]
}

/** A code the handler can target and nothing excludes. The ordinary case. */
export function aTargetableCode(): string {
  return firstOrThrow(
    TARGETABLE.filter(code => !ALL_EXCLUDED_COUNTRIES.has(code)),
    'targetable, non-excluded country',
  )
}

/** Two distinct codes the handler can target and nothing excludes. */
export function twoTargetableCodes(): [string, string] {
  const usable = TARGETABLE.filter(code => !ALL_EXCLUDED_COUNTRIES.has(code))
  if (usable.length < 2) {
    throw new Error('geography-fixture: fewer than two targetable, non-excluded countries.')
  }
  return [usable[0], usable[1]]
}

/**
 * A code that IS excluded and that the handler could otherwise target.
 *
 * Drawn from the intersection on purpose: an excluded code the handler cannot target
 * would fail the reachability check too, so a test using it could not tell which guard
 * fired.
 */
export function anExcludedCode(): string {
  return firstOrThrow(
    TARGETABLE.filter(code => ALL_EXCLUDED_COUNTRIES.has(code)),
    'excluded country that the handler can otherwise target',
  )
}

/**
 * A real country code that this platform recognises and the handler CANNOT target.
 *
 * The gap between the alias table and a handler's translation table is what the
 * reachability guard exists to catch, so the fixture is that gap, computed.
 */
export function anUntargetableCode(): string {
  const targetable = new Set(TARGETABLE)

  return firstOrThrow(
    Array.from(knownIso2CountryCodes()).filter(
      code => !targetable.has(code) && !ALL_EXCLUDED_COUNTRIES.has(code),
    ),
    'country the platform recognises but the handler cannot target',
  )
}

/**
 * A country NAME the alias table does not resolve, for testing the agent's refusal to
 * pass an unrecognised name through as if it were a code. Invented, not a real place.
 */
export const AN_UNRECOGNISED_COUNTRY_NAME = 'Placeholderia'

/** A ready-made geography argument for deriveFilterSpec, with nothing excluded or skipped. */
export function aGeography(countries?: string[]) {
  return {
    countries: countries ?? [aTargetableCode()],
    removed_by_exclusion: [],
    unresolved_phrases: [],
  }
}
