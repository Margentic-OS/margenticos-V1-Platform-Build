// Two sets of search settings that differ the way one real client's did on 2026-09-30,
// with every name invented.
//
// ─── THE SHAPE BEING REPRODUCED ──────────────────────────────────────────────
//
// That day an ICP edit touched two trigger reasons and nothing else, and the re-derivation
// it set off changed the search. Measured between the two versions' stored settings:
//
//   job titles searched     13 -> 14   one added
//   seniority levels         one added
//   job titles excluded      two swapped for two others, so the COUNT did not move
//   buyer criterion          accepts one more title, rejects the swapped pair, and went
//                            from derived to out of band, so it stopped gating
//   fit dimensions           one key renamed and one statement reworded
//   notes                    reworded
//   identical                industries, keywords, countries, headcount, revenue (off)
//
// `before()` and `after()` carry exactly that difference and no other. `afterWithCriterionHeld()`
// is the same change as ADR-061 step 4 files it today: the re-derived criterion did not
// gate, so the live one is kept and the proposal says so.
//
// ─── NOTHING HERE NAMES A REAL INDUSTRY, ROLE, BAND, COUNTRY OR CLIENT ───────
//
// Titles and keywords are placeholders. Industries are taken by position from the
// registered sourcing handler's own list, so the handler can build a request from these
// settings. Bands and countries come from the shared fixtures.

import type { CanonicalIndustry, ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import type { FitDimension } from '@/lib/agents/research/fit-dimensions'
import type { BuyerCriterion } from '@/lib/sourcing/buyer-criterion'
import { HANDLER_DISPATCH } from '@/lib/sourcing/handler-registry'
import { targetingInputs } from '@/lib/sourcing/targeting-inputs'
import type { SourcingHandler } from '@/lib/sourcing/types'
import { aGeography } from '@/test-utils/geography-fixture'
import { someBands } from '@/test-utils/seniority-fixture'

/** The registered sourcing handler, never named. Throws rather than return undefined. */
export function registeredHandler(): SourcingHandler {
  const handlers = Object.values(HANDLER_DISPATCH)
  if (handlers.length === 0) {
    throw new Error('settings-change-fixture: no sourcing handler is registered, so nothing can be built')
  }
  return handlers[0]
}

/** Canonical industries the handler can search for, by position. */
export function handlerIndustries(): readonly CanonicalIndustry[] {
  const industries = registeredHandler().targeted_industries as readonly CanonicalIndustry[]
  if (industries.length < 5) {
    throw new Error('settings-change-fixture: the handler targets too few industries for these fixtures')
  }
  return industries
}

export const TITLES = Array.from({ length: 13 }, (_, i) => `placeholder title ${i + 1}`)
export const ADDED_TITLE = 'placeholder title 14'
export const EXCLUDED_BEFORE = ['excluded placeholder a', 'excluded placeholder b']
export const EXCLUDED_AFTER = ['excluded placeholder c', 'excluded placeholder d']

const dimension = (key: string, statement: string) =>
  ({ key, statement }) as unknown as FitDimension

function criterion(overrides: Partial<BuyerCriterion> = {}): BuyerCriterion {
  return {
    status: 'derived',
    accept: TITLES.map((fragment, i) => ({ fragment, rank: i < 4 ? 'primary' : 'secondary' })),
    reject: [...EXCLUDED_BEFORE],
    statement: 'A placeholder statement of who decides.',
    evidence: ['a placeholder line of evidence'],
    unsettled_reason: null,
    sanity: null,
    derived_at: '2026-01-01T00:00:00.000Z',
    model: 'test-model',
    ...overrides,
  }
}

/** The settings as they stood before the re-derivation. */
export function before(): ICPFilterSpec {
  const industries = handlerIndustries()
  const countries = aGeography().countries
  return {
    job_titles: [...TITLES],
    job_titles_excluded: [...EXCLUDED_BEFORE],
    seniority_levels: someBands(2),
    person_countries: [...countries],
    company_countries: [...countries],
    company_headcount_min: 5,
    company_headcount_max: 30,
    industries: [industries[0], industries[1]],
    industries_excluded: [],
    keywords: ['placeholder keyword'],
    keywords_excluded: [],
    company_revenue_min: null,
    company_revenue_max: null,
    omitted_axes: ['company_revenue'],
    omission_reasons: { company_revenue: 'Not opted in. A placeholder reason.' },
    notes: 'placeholder notes, first wording',
    unmatched_industries: [],
    buyer_criterion: criterion(),
    fit_dimensions: {
      dimensions: [
        dimension('first_condition', 'a placeholder condition'),
        dimension('second_condition', 'another placeholder condition'),
      ],
      derived_at: '2026-01-01T00:00:00.000Z',
      model: 'test-model',
    },
    targeting_inputs: targetingInputs({}),
  }
}

/** The settings the re-derivation produced: the whole 2026-09-30 difference. */
export function after(): ICPFilterSpec {
  const spec = before()
  spec.job_titles = [...TITLES, ADDED_TITLE]
  spec.seniority_levels = someBands(3)
  spec.job_titles_excluded = [...EXCLUDED_AFTER]
  spec.buyer_criterion = criterion({
    status: 'out_of_band',
    accept: [
      ...TITLES.map((fragment, i) => ({ fragment, rank: (i < 4 ? 'primary' : 'secondary') as 'primary' | 'secondary' })),
      { fragment: ADDED_TITLE, rank: 'primary' },
    ],
    reject: [...EXCLUDED_AFTER],
    sanity: { checked: true, sample_size: 206, accept_rate: 0.956, note: 'A placeholder note: accepts almost every title sampled.' },
    derived_at: '2026-02-02T00:00:00.000Z',
  })
  spec.fit_dimensions = {
    dimensions: [
      dimension('first_condition_renamed', 'a placeholder condition'),
      dimension('second_condition', 'another placeholder condition, reworded'),
    ],
    derived_at: '2026-02-02T00:00:00.000Z',
    model: 'test-model',
  }
  spec.notes = 'placeholder notes, second wording'
  return spec
}

/**
 * The same targeting change as ADR-061 step 4 files it: the re-derived criterion did not
 * gate, so the live criterion, titles and seniority are carried over and the proposal
 * records why. Only the fit dimensions and the notes differ from `before()`.
 */
export function afterWithCriterionHeld(): ICPFilterSpec {
  const spec = before()
  spec.fit_dimensions = after().fit_dimensions
  spec.notes = 'placeholder notes, second wording'
  spec.criterion_held = {
    rederived_status: 'out_of_band',
    reason: 'A placeholder note: accepts almost every title sampled.',
    held_at: '2026-02-02T00:00:00.000Z',
  }
  return spec
}
