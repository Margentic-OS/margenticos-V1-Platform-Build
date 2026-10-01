// What changes between live and proposed search settings (ADR-061).
//
// The planted tests here iterate the real field lists and never a copy of them. A field
// added to FILTER_SPEC_FIELDS is therefore diffed and tested with nothing to remember, and
// a metadata field added later has to be classified below before the suite passes.
//
// No value in this file names a real industry, role or country. Industries come from the
// canonical list by position, bands and countries from the shared fixtures.

import { describe, it, expect } from 'vitest'
import { diffSettings, EXCLUSION_FIELDS } from '@/lib/sourcing/settings-diff'
import {
  CANONICAL_INDUSTRIES,
  FILTER_SPEC_FIELDS,
  FILTER_SPEC_METADATA_FIELDS,
  OMITTABLE_AXES,
  type ICPFilterSpec,
} from '@/lib/agents/icp-filter-spec'
import type { BuyerCriterion } from '@/lib/sourcing/buyer-criterion'
import type { FitDimension } from '@/lib/agents/research/fit-dimensions'
import { aGeography } from '@/test-utils/geography-fixture'
import { someBands } from '@/test-utils/seniority-fixture'
import { targetingInputs } from '@/lib/sourcing/targeting-inputs'

function criterion(overrides: Partial<BuyerCriterion> = {}): BuyerCriterion {
  return {
    status: 'derived',
    accept: [
      { fragment: 'title one', rank: 'primary' },
      { fragment: 'title two', rank: 'secondary' },
    ],
    reject: ['excluded title one', 'excluded title two'],
    statement: 'A placeholder statement of who decides.',
    evidence: ['a placeholder line of evidence'],
    unsettled_reason: null,
    sanity: null,
    derived_at: '2026-01-01T00:00:00.000Z',
    model: 'test-model',
    ...overrides,
  }
}

const dimension = (key: string) =>
  ({ key, statement: `placeholder condition ${key}` }) as unknown as FitDimension

function baseSpec(): ICPFilterSpec {
  const countries = aGeography().countries
  return {
    job_titles: ['title one', 'title two'],
    job_titles_excluded: ['excluded title one', 'excluded title two'],
    seniority_levels: someBands(2),
    person_countries: [...countries],
    company_countries: [...countries],
    company_headcount_min: 10,
    company_headcount_max: 90,
    industries: [CANONICAL_INDUSTRIES[0], CANONICAL_INDUSTRIES[30]],
    industries_excluded: [CANONICAL_INDUSTRIES[5]],
    keywords: ['keyword one'],
    keywords_excluded: ['excluded keyword one'],
    company_revenue_min: null,
    company_revenue_max: null,
    omitted_axes: [],
    omission_reasons: {},
    notes: 'placeholder notes',
    unmatched_industries: [],
    buyer_criterion: criterion(),
    fit_dimensions: {
      dimensions: [dimension('a')],
      derived_at: '2026-01-01T00:00:00.000Z',
      model: 'test-model',
    },
    targeting_inputs: targetingInputs({}),
  }
}

const UNCHANGED_CRITERION = {
  status_before: 'derived', status_after: 'derived', gates_before: true, gates_after: true,
  accept_added: [], accept_removed: [], rank_changed: [], reject_added: [], reject_removed: [],
  changed: false,
}

describe('diffSettings', () => {
  it('reports nothing for identical settings', () => {
    expect(diffSettings(baseSpec(), baseSpec())).toEqual({
      changed: false,
      field_changes: [],
      axes_switched_off: [],
      axes_switched_on: [],
      removed_exclusions: [],
      criterion: UNCHANGED_CRITERION,
      fit_dimensions_changed: false,
    })
  })

  it('PLANTED: a change to every filter field in the real list is reported, alone', () => {
    let planted = 0
    for (const field of FILTER_SPEC_FIELDS) {
      const proposed = baseSpec() as unknown as Record<string, unknown>
      const current = proposed[field]
      proposed[field] = Array.isArray(current)
        ? [...current, `planted in ${field}`]
        : typeof current === 'number' ? current + 1 : 1

      const diff = diffSettings(baseSpec(), proposed as unknown as ICPFilterSpec)
      expect(diff.changed, field).toBe(true)
      expect(diff.field_changes.map(change => change.field), field).toEqual([field])
      planted++
    }
    // Guards the loop against an empty list, over which every assertion above is vacuous.
    expect(planted).toBe(FILTER_SPEC_FIELDS.length)
    expect(planted).toBeGreaterThan(10)
  })

  it('ignores order within a list, and repeats', () => {
    const proposed = baseSpec()
    proposed.job_titles = ['title two', 'title one', 'title one']
    proposed.industries = [...proposed.industries].reverse()
    expect(diffSettings(baseSpec(), proposed).changed).toBe(false)
  })

  it('PLANTED: every metadata field is either read on purpose or ignored on purpose', () => {
    // The diff reads three metadata fields because they change what the settings DO. The
    // rest are words about the settings. A metadata field added later lands in neither
    // list, and this test fails until somebody decides which it is.
    const READ = ['buyer_criterion', 'fit_dimensions', 'omitted_axes']
    const IGNORED = ['notes', 'unmatched_industries', 'omission_reasons', 'targeting_inputs']
    expect([...READ, ...IGNORED].sort()).toEqual([...FILTER_SPEC_METADATA_FIELDS].sort())

    const plants: Record<string, unknown> = {
      notes: 'different notes',
      unmatched_industries: ['a planted unmatched name'],
      omission_reasons: { keywords: 'a planted reason' },
      targeting_inputs: targetingInputs({}, { revenueFilterEnabled: true }),
    }
    for (const field of IGNORED) {
      const proposed = { ...baseSpec(), [field]: plants[field] } as ICPFilterSpec
      expect(JSON.stringify(proposed)).not.toBe(JSON.stringify(baseSpec())) // the plant landed
      expect(diffSettings(baseSpec(), proposed).changed, field).toBe(false)
    }
  })

  it('treats a client with no live settings as all additions and no removals', () => {
    const diff = diffSettings(null, baseSpec())
    expect(diff.changed).toBe(true)
    expect(diff.removed_exclusions).toEqual([])
    expect(diff.criterion.status_before).toBe('absent')
    expect(diff.criterion.gates_before).toBe(false)
    expect(diff.criterion.gates_after).toBe(true)
    expect(diff.field_changes.find(c => c.field === 'job_titles')).toEqual({
      field: 'job_titles', kind: 'list', added: ['title one', 'title two'], removed: [],
    })
  })
})

describe('removed exclusions are named, never counted', () => {
  it('the exclusion fields are exactly the filter fields that exclude', () => {
    const byName = FILTER_SPEC_FIELDS.filter(field => field.endsWith('_excluded'))
    expect(byName.length).toBeGreaterThan(0)
    expect([...EXCLUSION_FIELDS].sort()).toEqual([...byName].sort())
  })

  it('PLANTED: removing one entry from each exclusion field is reported by name', () => {
    for (const field of EXCLUSION_FIELDS) {
      const live = baseSpec()
      const proposed = baseSpec()
      const [gone] = live[field] as string[]
      ;(proposed as unknown as Record<string, string[]>)[field] =
        (live[field] as string[]).filter(value => value !== gone)
      expect(diffSettings(live, proposed).removed_exclusions, field)
        .toEqual([{ source: field, value: gone, how: 'removed' }])
    }
  })

  it('the 2026-09-30 shape: two exclusions swapped for two others, and the count does not move', () => {
    const live = baseSpec()
    const proposed = baseSpec()
    proposed.job_titles_excluded = ['excluded title three', 'excluded title four']
    proposed.buyer_criterion = criterion({ reject: ['excluded title three', 'excluded title four'] })

    expect(proposed.job_titles_excluded.length).toBe(live.job_titles_excluded.length)
    expect(diffSettings(live, proposed).removed_exclusions).toEqual([
      { source: 'job_titles_excluded', value: 'excluded title one', how: 'removed' },
      { source: 'job_titles_excluded', value: 'excluded title two', how: 'removed' },
      { source: 'buyer_criterion.reject', value: 'excluded title one', how: 'removed' },
      { source: 'buyer_criterion.reject', value: 'excluded title two', how: 'removed' },
    ])
  })

  it('switching an exclusion axis off removes every entry on it, listed or not', () => {
    const switchable = EXCLUSION_FIELDS.filter(field =>
      (OMITTABLE_AXES as readonly string[]).includes(field))
    expect(switchable.length).toBeGreaterThan(0)

    for (const field of switchable) {
      const live = baseSpec()
      const proposed = { ...baseSpec(), omitted_axes: [field] } as ICPFilterSpec
      const diff = diffSettings(live, proposed)
      expect(diff.axes_switched_off, field).toEqual([field])
      expect(diff.removed_exclusions, field).toEqual(
        (live[field] as string[]).map(value => ({ source: field, value, how: 'axis_switched_off' })),
      )
      expect(diff.removed_exclusions.length, field).toBeGreaterThan(0)
    }
  })

  it('adding an exclusion removes nothing', () => {
    const proposed = baseSpec()
    proposed.keywords_excluded = [...proposed.keywords_excluded, 'excluded keyword two']
    proposed.buyer_criterion = criterion({
      reject: ['excluded title one', 'excluded title two', 'excluded title three'],
    })
    const diff = diffSettings(baseSpec(), proposed)
    expect(diff.changed).toBe(true)
    expect(diff.removed_exclusions).toEqual([])
    expect(diff.criterion.reject_added).toEqual(['excluded title three'])
  })
})

describe('the buyer criterion', () => {
  it('reports a criterion that stops gating, which is what removed 62 prospects', () => {
    const proposed = { ...baseSpec(), buyer_criterion: criterion({ status: 'out_of_band' }) }
    const diff = diffSettings(baseSpec(), proposed)
    expect(diff.changed).toBe(true)
    expect(diff.criterion).toEqual({
      ...UNCHANGED_CRITERION, status_after: 'out_of_band', gates_after: false, changed: true,
    })
  })

  it('asks the real gate: every non-gating state reads as not gating', () => {
    const states: (BuyerCriterion | undefined)[] = [
      undefined,
      criterion({ status: 'unsettled' }),
      criterion({ status: 'out_of_band' }),
      criterion({ accept: [] }),
    ]
    for (const state of states) {
      const proposed = { ...baseSpec(), buyer_criterion: state } as ICPFilterSpec
      expect(diffSettings(baseSpec(), proposed).criterion.gates_after).toBe(false)
    }
    expect(diffSettings(baseSpec(), baseSpec()).criterion.gates_after).toBe(true)
  })

  it('reports fragments added, removed and re-ranked', () => {
    const proposed = {
      ...baseSpec(),
      buyer_criterion: criterion({
        accept: [
          { fragment: 'title one', rank: 'secondary' },
          { fragment: 'title three', rank: 'primary' },
        ],
      }),
    }
    const { criterion: change } = diffSettings(baseSpec(), proposed)
    expect(change.accept_added).toEqual(['title three'])
    expect(change.accept_removed).toEqual(['title two'])
    expect(change.rank_changed).toEqual(['title one'])
    expect(change.changed).toBe(true)
  })

  it('does not report a re-derivation that changed only its timestamp or its wording', () => {
    const proposed = {
      ...baseSpec(),
      buyer_criterion: criterion({
        derived_at: '2026-02-02T00:00:00.000Z',
        statement: 'The same criterion, described in different words.',
        accept: [...criterion().accept].reverse(),
      }),
    }
    expect(diffSettings(baseSpec(), proposed).changed).toBe(false)
  })
})

describe('the fit dimensions', () => {
  it('reports changed conditions and ignores a changed timestamp', () => {
    const redated = baseSpec()
    redated.fit_dimensions = { ...redated.fit_dimensions!, derived_at: '2026-03-03T00:00:00.000Z' }
    expect(diffSettings(baseSpec(), redated).changed).toBe(false)

    const rekeyed = baseSpec()
    rekeyed.fit_dimensions = { ...rekeyed.fit_dimensions!, dimensions: [dimension('b')] }
    const diff = diffSettings(baseSpec(), rekeyed)
    expect(diff.fit_dimensions_changed).toBe(true)
    expect(diff.changed).toBe(true)
    expect(diff.field_changes).toEqual([])
  })
})
