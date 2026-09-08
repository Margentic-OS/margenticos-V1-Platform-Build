// Differencing: for each part of a search, what it contributes alone and what removing it
// does. Free, deterministic, no model.
//
// ─── THE TWO SIGNALS, AND WHY THEY ARE NEVER ONE ─────────────────────────────
//
// For every item this asks two questions and keeps the answers apart forever after:
//
//   alone      the population with only this item on its axis
//   withoutIt  the population with this item removed and its siblings kept
//
// A low `alone` means the item is WEAK: it finds almost nobody, and that is evidence the
// item is a bad choice.
//
// `withoutIt` equal to the full population means the item is REDUNDANT: everyone it finds
// is already found by its siblings. Dropping it may be correct for tidiness. IT IS NEVER
// EVIDENCE OF A TARGETING FAULT, and the loop must never treat it as one.
//
// They are indistinguishable if you only ask "did removing it change the count", which is
// what a layer-level difference measures and is why this module is item-level. Measured on
// a live organisation 2026-09-08: a job title scoring 4,068 alone whose removal moved the
// population by zero, sitting in the same search as a word scoring 39 alone whose removal
// also moved it by zero. One of those is a good constraint covered by its neighbours and
// the other finds nobody. A single signal calls them the same thing and deletes both.

import type {
  DifferencingResult,
  ItemAxis,
  ItemDifference,
  LayerDifference,
} from '@/lib/tuner/types'
import { countAndSample, type ProviderBudget } from '@/lib/tuner/count-and-sample'

/**
 * Every axis the tuner can difference, paired with the request key that carries it.
 *
 * ONE LIST OF PAIRS, never two parallel arrays. There is no way to add an axis without
 * naming the request key it reads, and no index arithmetic to get wrong. This is the shape
 * CLAUDE.md requires after a monitor sweep silently skipped its last check for exactly the
 * opposite arrangement.
 */
export const AXIS_REQUEST_KEYS = [
  ['industry_code', 'organization_naics_codes'],
  ['search_word', 'q_organization_keyword_tags'],
  ['job_title', 'person_titles'],
  ['seniority', 'person_seniorities'],
  ['headcount_band', 'organization_num_employees_ranges'],
  ['company_country', 'organization_locations'],
  ['person_country', 'person_locations'],
] as const satisfies readonly (readonly [ItemAxis, string])[]

/**
 * Axes whose members are differenced one at a time.
 *
 * The headcount band is excluded on purpose: its single member is a range string, and
 * "the band with one of its two numbers removed" is not a query the provider accepts. It
 * is differenced at layer level only, which is the honest granularity for it.
 */
const ITEM_LEVEL_AXES: readonly ItemAxis[] = [
  'industry_code', 'search_word', 'job_title', 'seniority',
]

/**
 * Below this share of the population, an item is WEAK: it finds almost nobody by itself.
 *
 * JUDGEMENT, stated here rather than buried. Relative and not absolute, because the
 * populations this runs against differ by five orders of magnitude: measured 2026-09-08,
 * three live organisations returned 1, 11,191 and 98,984. An absolute floor that means
 * anything at the top means "everything is weak" at the bottom.
 *
 * One percent is deliberately low. A weak item is the only signal that removes something a
 * client's own document asked for, so it has to clear a bar that a merely-small item does
 * not. At the measured populations it separates items finding 39 and 78 from one finding
 * 240, which is the distinction that matters.
 */
export const WEAK_SHARE = 0.01

/**
 * At or above this share, one item alone accounts for the majority of the population.
 *
 * Reported rather than acted on. An item can legitimately dominate: a client with one real
 * market has one code carrying it. What dominance means is that the search is effectively
 * that one item, so every other item on the axis is decoration, and an operator reading the
 * plan should know that before approving it.
 */
export const DOMINANCE_SHARE = 0.5

function itemsOf(request: Record<string, unknown>, key: string): string[] {
  const value = request[key]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function without(request: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...request }
  delete copy[key]
  return copy
}

/**
 * Difference one search, layer by layer and then item by item.
 *
 * Provider calls: one for the baseline, one per populated layer, and two per item on the
 * item-level axes. Every call is free and counted.
 */
export async function differenceSearch(
  request: Record<string, unknown>,
  budget: ProviderBudget,
): Promise<DifferencingResult> {
  const base = await countAndSample(request, budget)
  const population = base.total

  const layers: LayerDifference[] = []
  const items: ItemDifference[] = []

  for (const [axis, key] of AXIS_REQUEST_KEYS) {
    const present = itemsOf(request, key)
    if (present.length === 0) continue

    const layerCount = (await countAndSample(without(request, key), budget)).total
    layers.push({ axis, withoutLayer: layerCount, inert: layerCount === population })

    if (!ITEM_LEVEL_AXES.includes(axis)) continue

    for (let i = 0; i < present.length; i++) {
      const siblings = present.filter((_, j) => j !== i)

      // The last member of an axis has no "removed but siblings kept" state: removing it
      // removes the layer. Recorded as null rather than as the layer figure, because those
      // are different measurements and conflating them would report the layer's effect as
      // the item's.
      const withoutIt = siblings.length === 0
        ? null
        : (await countAndSample({ ...request, [key]: siblings }, budget)).total

      const alone = (await countAndSample({ ...request, [key]: [present[i]] }, budget)).total

      items.push({
        axis,
        index: i,
        alone,
        withoutIt,
        redundant: withoutIt !== null && withoutIt === population,
        weak: alone < WEAK_SHARE * population,
        dominant: population > 0 && alone >= DOMINANCE_SHARE * population,
      })
    }
  }

  return {
    population,
    layers,
    items,
    suspectedIgnoredAxes: suspectIgnored(population, layers, items),
  }
}

/**
 * Axes that look as though the provider never applied them.
 *
 * ─── WHY THIS IS NARROWER THAN "THE LAYER IS INERT" ──────────────────────────
 *
 * The provider silently ignores a parameter it does not recognise: it returns the count for
 * the query minus that parameter rather than erroring. That failure is invisible, because a
 * mapping that does nothing looks exactly like one that works.
 *
 * But an inert layer is usually NOT that. A layer is also inert when its members genuinely
 * match everyone the other constraints already select, which is a fact about the client's
 * market and not a bug. Measured 2026-09-08 on a live organisation: removing the whole word
 * layer changed the population by zero, and one of its words returned a non-zero count on
 * its own, so the parameter was plainly being honoured.
 *
 * So this reports an axis only when the layer is inert AND no single member of it finds
 * anybody at all. That is the shape a genuinely dropped parameter makes, and it is
 * distinguishable from the ordinary one.
 *
 * It is a suspicion and it is named as one. Confirming it needs the parameter control from
 * the repository's filter-proof harness: re-issue the same values under a deliberately
 * misspelled parameter name and see whether the count matches.
 */
function suspectIgnored(
  population: number,
  layers: LayerDifference[],
  items: ItemDifference[],
): ItemAxis[] {
  const out: ItemAxis[] = []
  for (const layer of layers) {
    if (!layer.inert) continue
    const own = items.filter(i => i.axis === layer.axis)
    if (own.length === 0) continue
    if (own.every(i => i.alone === 0)) out.push(layer.axis)
  }
  // A population of zero makes every layer trivially inert and every item trivially
  // empty, so every axis would be reported. That is noise, not a finding.
  return population === 0 ? [] : out
}
