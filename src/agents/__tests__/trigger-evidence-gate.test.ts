// POSITIVE CONTROLS for the trigger evidence gate, both directions.
//
// The REJECT cases use evidence the ICP generator actually produced on 2026-09-23, verbatim.
// The ACCEPT cases matter as much: a gate that rejects everything is an outage, and this one
// stands between the generator and a landable suggestion.

import { describe, it, expect } from 'vitest'
import { findEvidenceFaults, evidenceFaultFeedback, findEvidenceAbsenceReport, findRecordFields } from '../trigger-evidence-gate'

const trig = (evidence: string[]) => [{ trigger: 'Something happened on a date', evidence_to_find: evidence }]

describe('rejects a figure from the company record', () => {
  it.each([
    'Company-data-detectable: headcount reduction in last 90 days, suggesting a delivery team winding down after a project',
    'Company-data-detectable: headcount increase in the last 90 days, suggesting a delivery team scaling up for new work',
    'Company-data-detectable: no headcount change in 12 or more months, suggesting flat growth',
  ])('real generated item: %s', item => {
    const faults = findEvidenceFaults(trig([item]))
    expect(faults.some(f => f.kind === 'figure')).toBe(true)
  })

  it('names which trigger and quotes the item, so the fault is actionable', () => {
    const faults = findEvidenceFaults([
      { trigger: 'first', evidence_to_find: ['a clean one: a post naming a new role'] },
      { trigger: 'second', evidence_to_find: ['headcount increase in the last 90 days'] },
    ])
    // TWO faults on one line since 2026-09-23, not one: "headcount increase in the last 90
    // days" names a figure AND names a record field, and both gates are entitled to say so.
    // The test keeps its job by asserting on the figure fault specifically.
    const figure = faults.filter(f => f.kind === 'figure')
    expect(figure).toHaveLength(1)
    expect(figure[0].trigger_index).toBe(2)
    expect(figure[0].trigger).toBe('second')
    expect(figure[0].evidence).toContain('headcount increase')
    // And every fault points at the trigger that produced it, never the wrong one.
    expect(faults.every(f => f.trigger_index === 2)).toBe(true)
  })
})

describe('BLOCKS absences', () => {
  // ALL NINE absence items on file: the six from the two visible-trigger runs, plus three
  // found on 2026-09-23 in the hidden-section run that the FIRST version of these patterns
  // missed. That version listed the nouns an absence could attach to; these three attached
  // to nouns nobody had thought of, which is why the pattern is now "no" plus any word.
  //
  // RAN IN REPORT MODE FOR ONE GENERATION BEFORE BLOCKING, per the precedent
  // ACTIVITY_VERDICT_MODE set: a detector nobody has measured does not get to end a run.
  const REAL_ABSENCES = [
    'Website-detectable: careers page exists but lists no open roles, or previously listed a sales hire that is no longer active',
    'Web search-detectable: job post for a sales role now marked closed or expired within the last 90 days',
    'Website-detectable: recently published lead magnet or downloadable resource with no clear follow-up funnel or booking mechanism',
    'Website-detectable: last case study or blog post published more than 6 months ago despite an otherwise professional site',
    'Company-data-detectable: no headcount change in 12 or more months, suggesting flat growth',
    'Web search-detectable: no posts about new client wins or project starts in the last 90 days',
    // The three the first pattern set missed:
    'Website-detectable: a blog or insights section with recent posts but no clear call-to-action or booking mechanism',
    'Web search-detectable: a recently published article or LinkedIn post from the founder with engagement but no visible lead capture',
    'Web search-detectable: a recently published guide or downloadable resource with no visible distribution or paid promotion behind it',
  ]

  it.each(REAL_ABSENCES)('blocks: %s', item => {
    expect(findEvidenceFaults(trig([item])).some(f => f.kind === 'absence')).toBe(true)
  })

  it('catches all nine, where the borrowed detector managed two', () => {
    expect(REAL_ABSENCES.filter(i => findEvidenceFaults(trig([i])).length > 0)).toHaveLength(9)
  })

  it('the report function still reports, so a caller can count without blocking', () => {
    expect(findEvidenceAbsenceReport(trig([REAL_ABSENCES[0]])).length).toBeGreaterThan(0)
  })
})

describe('BLOCKS a record field named without a number', () => {
  // THE GAP findFirmographicFigures CANNOT SEE. Its headcount pattern needs the word near a
  // NUMBER. Both of these come from the hidden-section run of 2026-09-23, where the figure
  // gate passed with zero faults and two items still told a researcher to read headcount.
  const REAL_FIELDS = [
    'Company-data-detectable: a recent headcount reduction, specifically in a sales or business development role in the last 90 days',
    'Company-data-detectable: a recent headcount reduction in a delivery role, suggesting the team contracted after losing a client',
  ]

  it.each(REAL_FIELDS)('blocks: %s', item => {
    expect(findEvidenceFaults(trig([item])).some(f => f.kind === 'record_field')).toBe(true)
  })

  it('the figure gate alone would have passed both, which is why this exists', () => {
    for (const item of REAL_FIELDS) {
      expect(findEvidenceFaults(trig([item])).filter(f => f.kind === 'figure')).toEqual([])
    }
  })

  it.each(['revenue', 'funding', 'growth rate', 'staff count'])('also blocks %s', field => {
    expect(findRecordFields(`Company-data-detectable: a recent change in ${field}`).length).toBeGreaterThan(0)
  })
})

describe('ACCEPTS evidence that names where to look and what it would say', () => {
  // These are the shape the rule asks for. If any of these ever fails, the gate has become
  // an outage and the generator cannot land anything.
  it.each([
    'A post on the founder or company page naming a role they are hiring for',
    'A service page published with a start date',
    'An announcement naming a partner, award or accreditation',
    'An event listing naming them as a speaker, with the date',
    'A podcast episode page naming them as the guest',
    'A post naming a person and the new title they have moved into',
  ])('clean item: %s', item => {
    expect(findEvidenceFaults(trig([item]))).toEqual([])
  })

  it('no clean item trips the absence or record-field gates either', () => {
    for (const item of [
      'A post on the founder or company page naming a role they are hiring for',
      'A service page published with a start date',
      'An announcement naming a partner, award or accreditation',
      'An event listing naming them as a speaker, with the date',
      'A podcast episode page naming them as the guest',
      'A post naming a person and the new title they have moved into',
    ]) {
      expect(findEvidenceAbsenceReport(trig([item]))).toEqual([])
      expect(findRecordFields(item)).toEqual([])
      // And the whole gate, which is what actually stands between the generator and a
      // landable suggestion. If this goes red the gate has become an outage.
      expect(findEvidenceFaults(trig([item]))).toEqual([])
    }
  })

  it('an empty or malformed list is not a fault', () => {
    // A generator that produced no triggers has a different problem, and this gate must not
    // be the thing that reports it: a vacuous rejection would hide the real cause.
    expect(findEvidenceFaults([])).toEqual([])
    expect(findEvidenceFaults(null)).toEqual([])
    expect(findEvidenceFaults([{ trigger: 'x' }])).toEqual([])
    expect(findEvidenceFaults([{ trigger: 'x', evidence_to_find: ['', '   '] }])).toEqual([])
  })
})

describe('the feedback quotes the offending line and prescribes nothing', () => {
  it('names the item, not what the trigger should say', () => {
    // A FIGURE, not an absence. Absences moved to report mode on 2026-09-23 and produce no
    // fault, so feedback built from one is correctly empty; this test kept its job by
    // moving to the fault kind that still blocks.
    const faults = findEvidenceFaults(trig(['Company-data-detectable: headcount increase in the last 90 days']))
    const fb = evidenceFaultFeedback(faults)
    expect(fb).toContain('headcount increase in the last 90 days')
    expect(fb).toContain('Rewrite tier_1.triggers')
    // RULE ZERO: the feedback must not tell this or any client what to write.
    expect(fb).not.toMatch(/consult|pipeline|outbound|meeting|founder|agency/i)
  })

  it('is empty when there is nothing to say', () => {
    expect(evidenceFaultFeedback([])).toBe('')
  })
})
