// The trigger-definition proposal changes the live ICP by the definitions and nothing else
// (2026-10-03).
//
// The script files a pending ICP suggestion for the operator to approve. What it files must
// be the live document with ONLY a `definition` added to each trigger: a wording edit, so
// ADR-061's approve path sees no targeting field change and the search is untouched. And it
// must refuse a file that does not line up with the live list, in either direction, because
// a definition keyed to a trigger that has since been reworded would silently attach to
// nothing.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect } from 'vitest'
import { addTriggerDefinitions, changedLeafPaths } from '../propose-trigger-definitions'

const LIVE = {
  summary: 'A summary.',
  tier_1: {
    label: 'Ideal',
    buyer_profile: { title: 'Owner' },
    triggers: [
      { trigger: 'A new site is opened.', reason: 'A new site means a new area.', evidence_to_find: ['A post naming the site'] },
      { trigger: 'An award is won.', reason: 'An award opens doors.', evidence_to_find: [] },
    ],
  },
  tier_2: { label: 'Second' },
}

const DEFS = {
  'A new site is opened.': 'Counts: a site that serves customers. Does not count: a storage unit.',
  'An award is won.': 'Counts: a named award or ranking. Does not count: a nomination or a shortlist.',
}

describe('addTriggerDefinitions', () => {
  it('PLANTED: adds each definition to its trigger, and changes no other leaf of the document', () => {
    const out = addTriggerDefinitions(LIVE, DEFS)
    expect(out.problems).toEqual([])
    const triggers = (out.content as typeof LIVE).tier_1.triggers as Array<Record<string, unknown>>
    expect(triggers[0].definition).toBe(DEFS['A new site is opened.'])
    expect(triggers[1].definition).toBe(DEFS['An award is won.'])
    expect(changedLeafPaths(LIVE, out.content)).toEqual(['tier_1.triggers[0].definition', 'tier_1.triggers[1].definition'])
    // The input is not mutated: the live document read is the comparison baseline.
    expect((LIVE.tier_1.triggers[0] as Record<string, unknown>).definition).toBeUndefined()
  })

  it('PLANTED: refuses a definition for a trigger the live ICP does not have', () => {
    const out = addTriggerDefinitions(LIVE, { ...DEFS, 'A site is closed.': 'Counts: anything.' })
    expect(out.problems.join('\n')).toMatch(/not in the live ICP: "A site is closed\."/)
  })

  it('PLANTED: refuses when a live trigger has no definition in the file', () => {
    const out = addTriggerDefinitions(LIVE, { 'A new site is opened.': DEFS['A new site is opened.'] })
    expect(out.problems.join('\n')).toMatch(/no definition in the file: "An award is won\."/)
  })

  it('refuses an empty definition, and a wording that differs only by spacing is not the same trigger', () => {
    expect(addTriggerDefinitions(LIVE, { ...DEFS, 'An award is won.': '  ' }).problems.join('\n')).toMatch(/empty/)
    const spaced = { 'A new site is opened. ': DEFS['A new site is opened.'], 'An award is won.': DEFS['An award is won.'] }
    expect(addTriggerDefinitions(LIVE, spaced).problems.length).toBeGreaterThan(0)
  })

  it('refuses a document with no trigger list, rather than filing a proposal that adds nothing', () => {
    expect(addTriggerDefinitions({ tier_1: {} }, DEFS).problems.length).toBeGreaterThan(0)
  })
})
