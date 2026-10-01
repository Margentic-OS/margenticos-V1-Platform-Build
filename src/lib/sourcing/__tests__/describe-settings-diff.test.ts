// A change to a client's search settings, in the words the operator reads. ADR-061 step 6.
//
// The first block is the plan's own check: the difference one real client's settings went
// through on 2026-09-30, rebuilt with invented names, described line by line.
//
// The planted blocks iterate the real lists (filter fields, switchable axes, exclusion
// fields), so a field added to the settings has to produce a line here before the suite
// passes. A change the operator approves without being shown it is the failure this file
// exists to prevent.

import { describe, it, expect } from 'vitest'
import {
  describeRemovedExclusions,
  describeSettingsDiff,
} from '@/lib/sourcing/describe-settings-diff'
import { diffSettings, EXCLUSION_FIELDS } from '@/lib/sourcing/settings-diff'
import { exclusionKey } from '@/lib/sourcing/approve-icp-filter-spec'
import { FILTER_SPEC_FIELDS, OMITTABLE_AXES, type ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import { BANNED_TITLE_WORDS, findBannedContent } from '@/agents/buyer-criterion-agent'
import { twoTargetableCodes } from '@/test-utils/geography-fixture'
import { someBands } from '@/test-utils/seniority-fixture'
import {
  ADDED_TITLE,
  after,
  afterWithCriterionHeld,
  before,
  EXCLUDED_AFTER,
  EXCLUDED_BEFORE,
  handlerIndustries,
} from './helpers/settings-change-fixture'

function proposal(change: (spec: ICPFilterSpec) => void): ICPFilterSpec {
  const spec = before()
  change(spec)
  return spec
}

const describeChange = (change: (spec: ICPFilterSpec) => void) =>
  describeSettingsDiff(diffSettings(before(), proposal(change)))

describe('the 2026-09-30 difference, with invented names', () => {
  it('is described line by line, in the order the settings are listed', () => {
    const addedBand = someBands(3)[2].replace(/_/g, ' ')
    expect(describeSettingsDiff(diffSettings(before(), after()))).toEqual([
      { label: 'Job titles searched', detail: `adds ${ADDED_TITLE}` },
      {
        label: 'Job titles excluded',
        detail: `adds ${EXCLUDED_AFTER.join(', ')}; removes ${EXCLUDED_BEFORE.join(', ')}`,
      },
      { label: 'Seniority levels searched', detail: `adds ${addedBand}` },
      {
        label: 'Who we email',
        detail:
          `now also accepts ${ADDED_TITLE}; ` +
          `now also rejects ${EXCLUDED_AFTER.join(', ')}; ` +
          `no longer rejects ${EXCLUDED_BEFORE.join(', ')}; ` +
          'goes from settled to matching almost everyone or almost no one; ' +
          'would stop being applied to anyone',
      },
      {
        label: 'Research fit conditions',
        detail: 'changed. This affects how research grades fit, and never who is sourced',
      },
    ])
  })

  it('says nothing about the notes: rewording them changes nothing the settings do', () => {
    const lines = describeSettingsDiff(diffSettings(before(), proposal(spec => { spec.notes = 'reworded' })))
    expect(lines).toEqual([])
  })

  it('as step 4 files it, with the live criterion kept, only the fit conditions change', () => {
    expect(describeSettingsDiff(diffSettings(before(), afterWithCriterionHeld()))).toEqual([
      {
        label: 'Research fit conditions',
        detail: 'changed. This affects how research grades fit, and never who is sourced',
      },
    ])
  })

  it('asks for a tick for each excluded title that stops applying, one per title', () => {
    const ticks = describeRemovedExclusions(diffSettings(before(), after()).removed_exclusions)
    expect(ticks).toEqual(EXCLUDED_BEFORE.map(title => ({
      // One tick, both places the title was excluded.
      keys: [`job_titles_excluded:${title}`, `buyer_criterion.reject:${title}`],
      label: `Stop excluding the job title “${title}”`,
    })))
  })
})

describe('planted: every filter field is described when it changes', () => {
  const industries = handlerIndustries()

  // One change per field. The lookup is by the field's own value, so a field added to
  // FILTER_SPEC_FIELDS is changed here with nothing to remember.
  function changeField(spec: ICPFilterSpec, field: (typeof FILTER_SPEC_FIELDS)[number]) {
    const record = spec as unknown as Record<string, unknown>
    const current = record[field]
    if (Array.isArray(current)) {
      if (field === 'industries' || field === 'industries_excluded') record[field] = [...current, industries[3]]
      else if (field === 'person_countries' || field === 'company_countries') record[field] = [...twoTargetableCodes()]
      else if (field === 'seniority_levels') record[field] = someBands(3)
      else record[field] = [...current, 'an added placeholder']
    } else {
      record[field] = typeof current === 'number' ? current + 7 : 1_000_000
    }
  }

  it.each([...FILTER_SPEC_FIELDS])('%s produces exactly one line, with a label and a detail', field => {
    const lines = describeChange(spec => changeField(spec, field))
    // The criterion and fit conditions are untouched, so the field's own line is the only one.
    expect(lines).toHaveLength(1)
    expect(lines[0].label.length).toBeGreaterThan(5)
    expect(lines[0].detail.length).toBeGreaterThan(5)
    // The label is words, not the column name.
    expect(lines[0].label).not.toContain('_')
  })

  it('gives every field its own label', () => {
    const labels = FILTER_SPEC_FIELDS.map(field => describeChange(spec => changeField(spec, field))[0].label)
    expect(new Set(labels).size).toBe(FILTER_SPEC_FIELDS.length)
  })

  it.each([...OMITTABLE_AXES])('switching %s off, and on again, is each described', axis => {
    const off = describeSettingsDiff(diffSettings(
      proposal(spec => { spec.omitted_axes = [] }),
      proposal(spec => { spec.omitted_axes = [axis] }),
    ))
    const on = describeSettingsDiff(diffSettings(
      proposal(spec => { spec.omitted_axes = [axis] }),
      proposal(spec => { spec.omitted_axes = [] }),
    ))
    expect(off).toHaveLength(1)
    expect(off[0].detail).toContain('switched off')
    expect(on).toHaveLength(1)
    expect(on[0].detail).toContain('switched on')
    expect(off[0].label).toBe(on[0].label)
    expect(off[0].label).not.toContain('_')
  })
})

describe('how values are written', () => {
  it('a company size is a number of people, before and after', () => {
    expect(describeChange(spec => { spec.company_headcount_max = 50 })).toEqual([
      { label: 'Largest company size', detail: 'changes from 30 people to 50 people' },
    ])
  })

  it('a revenue bound that was not set says so, and is not called people', () => {
    expect(describeChange(spec => { spec.company_revenue_min = 1_000_000 })).toEqual([
      { label: 'Lowest company revenue', detail: 'changes from not set to 1,000,000' },
    ])
  })

  it('a country is shown by its name, not its code', () => {
    const codes = twoTargetableCodes()
    const names = new Intl.DisplayNames(['en'], { type: 'region' })
    const lines = describeChange(spec => { spec.company_countries = [...codes] })
    expect(lines).toHaveLength(1)
    // CONTROL: the runtime can name these codes. If it could not, the next line would pass
    // by comparing a code with itself.
    expect(names.of(codes[1])).not.toBe(codes[1])
    for (const code of codes) {
      if (!before().company_countries.includes(code)) expect(lines[0].detail).toContain(names.of(code)!)
    }
  })

  it('a seniority band loses the provider\'s underscores', () => {
    const lines = describeChange(spec => { spec.seniority_levels = someBands(3) })
    expect(lines[0].detail).not.toContain('_')
  })

  it('a removal alone has no dangling "adds"', () => {
    expect(describeChange(spec => { spec.job_titles = spec.job_titles.slice(1) })[0].detail)
      .toBe('removes placeholder title 1')
  })

  it('a change of rank in the buyer criterion is described', () => {
    const lines = describeChange(spec => {
      spec.buyer_criterion = {
        ...spec.buyer_criterion!,
        accept: spec.buyer_criterion!.accept.map((entry, i) => i === 0 ? { ...entry, rank: 'secondary' } : entry),
      }
    })
    expect(lines).toEqual([
      { label: 'Who we email', detail: 'changes how strongly it prefers placeholder title 1' },
    ])
  })

  it('first settings are described as what the search will do', () => {
    const lines = describeSettingsDiff(diffSettings(null, before()))
    expect(lines.find(line => line.label === 'Job titles searched')?.detail).toMatch(/^adds placeholder title 1, /)
    expect(lines.find(line => line.label === 'Who we email')?.detail).toContain('starts being applied')
  })
})

describe('the ticks: every removed exclusion is confirmed by exactly one of them', () => {
  const industries = handlerIndustries()
  const withExclusions = () => proposal(spec => {
    spec.industries_excluded = [industries[2], industries[3]]
    spec.keywords_excluded = ['excluded keyword one', 'excluded keyword two']
  })

  const SHAPES: Array<[string, (spec: ICPFilterSpec) => void]> = [
    ...EXCLUSION_FIELDS.map(field => [
      `every entry dropped from ${field}`,
      (spec: ICPFilterSpec) => { (spec as unknown as Record<string, string[]>)[field] = [] },
    ] as [string, (spec: ICPFilterSpec) => void]),
    ['the excluded-keywords filter switched off', spec => { spec.omitted_axes = [...(spec.omitted_axes ?? []), 'keywords_excluded'] }],
    ['the excluded-industries filter switched off', spec => { spec.omitted_axes = [...(spec.omitted_axes ?? []), 'industries_excluded'] }],
    ['the criterion\'s reject list emptied', spec => { spec.buyer_criterion = { ...spec.buyer_criterion!, reject: [] } }],
    ['an excluded title dropped from the search list and the criterion together', spec => {
      spec.job_titles_excluded = [EXCLUDED_BEFORE[1]]
      spec.buyer_criterion = { ...spec.buyer_criterion!, reject: [EXCLUDED_BEFORE[1]] }
    }],
  ]

  it.each(SHAPES)('%s', (_name, change) => {
    const proposed = withExclusions()
    change(proposed)
    const removed = diffSettings(withExclusions(), proposed).removed_exclusions
    // CONTROL: the change does remove something, or the two assertions below are empty.
    expect(removed.length).toBeGreaterThan(0)

    const ticks = describeRemovedExclusions(removed)
    const confirmed = ticks.flatMap(tick => tick.keys)
    expect([...confirmed].sort()).toEqual(removed.map(exclusionKey).sort())
    expect(new Set(confirmed).size).toBe(confirmed.length)
    for (const tick of ticks) expect(tick.label).toMatch(/^Stop excluding /)
  })

  it('words each kind of exclusion as what it is', () => {
    const ticks = describeRemovedExclusions([
      { source: 'job_titles_excluded', value: 'a placeholder', how: 'removed' },
      { source: 'industries_excluded', value: 'a placeholder sector', how: 'removed' },
      { source: 'keywords_excluded', value: 'a placeholder word', how: 'axis_switched_off' },
    ])
    expect(ticks.map(tick => tick.label)).toEqual([
      'Stop excluding the job title “a placeholder”',
      'Stop excluding the industry “a placeholder sector”',
      'Stop excluding companies described as “a placeholder word” (the whole filter is being switched off)',
    ])
  })

  it('folds a title excluded in both places into one tick, and keeps different titles apart', () => {
    const ticks = describeRemovedExclusions([
      { source: 'job_titles_excluded', value: 'title a', how: 'removed' },
      { source: 'job_titles_excluded', value: 'title b', how: 'removed' },
      { source: 'buyer_criterion.reject', value: 'title a', how: 'removed' },
    ])
    expect(ticks.map(tick => tick.keys)).toEqual([
      ['job_titles_excluded:title a', 'buyer_criterion.reject:title a'],
      ['job_titles_excluded:title b'],
    ])
  })
})

describe('Rule Zero: the fixed copy names no role and no sector', () => {
  it('holds for every label and every fixed phrase the fixtures can produce', () => {
    const lines = [
      ...describeSettingsDiff(diffSettings(before(), after())),
      ...describeSettingsDiff(diffSettings(null, before())),
      ...OMITTABLE_AXES.flatMap(axis => describeSettingsDiff(diffSettings(
        proposal(spec => { spec.omitted_axes = [] }),
        proposal(spec => { spec.omitted_axes = [axis] }),
      ))),
    ]
    // Labels are entirely fixed copy. A list line's detail is fixed verbs around the
    // client's own values (titles, bands, sectors), so only its verbs are scanned. Every
    // other detail is fixed copy around placeholders or numbers and is scanned whole.
    for (const line of lines) {
      const isListLine = /^(adds|removes) /.test(line.detail)
      const copy = isListLine
        ? `${line.label} adds removes`
        : `${line.label} ${line.detail.replace(/placeholder[^,;]*/g, '')}`
      expect(findBannedContent(copy), `"${copy}"`).toEqual([])
    }
    // CONTROL: the scanner does find a banned word when one is present. Taken from the
    // list by position, so no role is written down here.
    expect(findBannedContent(`a line about a ${BANNED_TITLE_WORDS[0]}`)).toEqual([BANNED_TITLE_WORDS[0]])
  })
})
