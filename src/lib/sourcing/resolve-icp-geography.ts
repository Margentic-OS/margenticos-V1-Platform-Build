// The geography half of a filter spec, resolved end to end.
//
// FOUR STEPS, IN THIS ORDER, AND THE ORDER IS LOAD-BEARING:
//
//   1. read the targeting tiers only
//   2. derive the countries the document NAMES  (the one model call)
//   3. subtract the excluded countries          (the one subtraction point)
//   4. check what remains is reachable          (against the active handler)
//
// Subtraction comes before the reachability check on purpose. An excluded country is
// excluded whether or not a handler could reach it, and checking reachability first would
// report "this country is unreachable" about a country that was never allowed anyway,
// which sends an operator to fix the wrong thing.
//
// WHY THIS SITS IN THE SOURCING LAYER AND NOT BESIDE deriveFilterSpec. Steps 3 and 4 both
// need to know things that belong to the integrations layer: which countries are excluded
// (a constant owned by a handler) and which are reachable (a capability advertised by
// whichever handler is registered). deriveFilterSpec is the tool-agnostic derivation and
// must not import either. So the vendor-aware work happens here and the finished result
// is passed in as a parameter, which is the same shape the buyer criterion already uses.
//
// It is also what keeps the import graph acyclic: adapter-apollo imports icp-filter-spec,
// so icp-filter-spec importing anything that reaches adapter-apollo would be a cycle.
// A cycle passes tsc and the whole vitest suite and fails only `npm run build`.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import {
  collectTargetingGeographyStatements,
  deriveIcpGeography,
} from '@/agents/icp-geography-agent'
import { applyGeographyExclusions } from '@/lib/sourcing/geography-exclusion'
import { resolveActiveSourcingHandler } from '@/lib/sourcing/handler-registry'
import type { IcpDocument } from '@/lib/agents/icp-filter-spec'

/**
 * A client's targeting geography, finished: derived, subtracted, and checked reachable.
 *
 * Every field is required. There is no shape of this object that means "geography could
 * not be worked out", because that condition throws rather than being represented.
 */
export interface ResolvedGeography {
  /** ISO-2 codes the document named, minus the excluded ones. Never empty. */
  countries: string[]
  /** Excluded codes the document named and this removed. Empty when it named none. */
  removed_by_exclusion: string[]
  /** Phrases from the document that named no country, verbatim. */
  unresolved_phrases: string[]
}

export interface ResolveIcpGeographyInput {
  supabase: SupabaseClient
  doc: IcpDocument
  /**
   * Test seam. Production passes nothing and the active handler is resolved from the
   * integrations registry, which is the only tool-agnostic way to ask the question.
   */
  targetableCountries?: readonly string[]
}

/**
 * Resolve one client's targeting geography, or throw naming what stopped it.
 *
 * THROWS ON EVERY FAULT. There is no partial result and no default. A country list is
 * the one part of a filter spec whose failure mode is legal rather than commercial, and
 * every value that could stand in for a missing one is a guess about which countries a
 * client sells to.
 */
export async function resolveIcpGeography(
  input: ResolveIcpGeographyInput,
): Promise<ResolvedGeography> {
  const statements = collectTargetingGeographyStatements(input.doc)

  const derived = await deriveIcpGeography({ statements })

  // ── The single subtraction point ──────────────────────────────────────────
  // Throws if it empties the list. Both country lists on the spec come from this one
  // result, so there is no second place an exclusion could be missed.
  const { kept, removed } = applyGeographyExclusions(derived.countries)

  if (removed.length > 0) {
    logger.warn('resolveIcpGeography: excluded countries removed from a client ICP', {
      removed,
      kept,
      consequence:
        'This client\'s ICP names countries that are excluded for every client. They are ' +
        'removed from the spec and recorded in its notes. Prospects already sourced or ' +
        'uploaded are NOT affected by this: see ADR-034.',
    })
  }

  // ── Reachability, against whichever handler is registered ─────────────────
  const targetable = input.targetableCountries
    ?? (await resolveActiveSourcingHandler(input.supabase)).targetable_countries

  const targetableSet = new Set(Array.from(targetable, code => code.toUpperCase()))
  const unreachable = kept.filter(code => !targetableSet.has(code))

  if (unreachable.length > 0) {
    throw new Error(
      `ICP filter spec: this ICP names ${unreachable.join(', ')}, which the active ` +
      'sourcing handler cannot target. Writing the spec anyway would store a country the ' +
      'query cannot express, and the handler would refuse the run later with nothing ' +
      'pointing back at this document. Either register the country with the handler that ' +
      'owns its translation, or name a country the handler reaches.',
    )
  }

  return {
    countries: kept,
    removed_by_exclusion: removed,
    unresolved_phrases: derived.unresolved_phrases,
  }
}
