// POSITIVE CONTROLS for the trigger evidence gate, both directions.
//
// The REJECT cases use evidence the ICP generator actually produced on 2026-09-23, verbatim.
// The ACCEPT cases matter as much: a gate that rejects everything is an outage, and this one
// stands between the generator and a landable suggestion.

import { describe, it, expect } from 'vitest'
import { findEvidenceFaults, evidenceFaultFeedback, findEvidenceAbsenceReport } from '../trigger-evidence-gate'

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
    expect(faults).toHaveLength(1)
    expect(faults[0].trigger_index).toBe(2)
    expect(faults[0].trigger).toBe('second')
    expect(faults[0].evidence).toContain('headcount increase')
  })
})

describe('COUNTS absences, and never blocks on them', () => {
  // ALL SIX absence items the ICP generator actually produced across the two runs of
  // 2026-09-23. The activity-verdict detector caught two of these, which is why a separate
  // evidence-text pattern set exists. If any of these stops being caught, the counter has
  // regressed to the instrument it replaced.
  const REAL_ABSENCES = [
    'Website-detectable: careers page exists but lists no open roles, or previously listed a sales hire that is no longer active',
    'Web search-detectable: job post for a sales role now marked closed or expired within the last 90 days',
    'Website-detectable: recently published lead magnet or downloadable resource with no clear follow-up funnel or booking mechanism',
    'Website-detectable: last case study or blog post published more than 6 months ago despite an otherwise professional site',
    'Company-data-detectable: no headcount change in 12 or more months, suggesting flat growth',
    'Web search-detectable: no posts about new client wins or project starts in the last 90 days',
  ]

  it.each(REAL_ABSENCES)('catches: %s', item => {
    expect(findEvidenceAbsenceReport(trig([item])).length).toBeGreaterThan(0)
  })

  it('catches all six, which the borrowed detector managed two of', () => {
    const caught = REAL_ABSENCES.filter(i => findEvidenceAbsenceReport(trig([i])).length > 0)
    expect(caught).toHaveLength(6)
  })

  it('NEVER BLOCKS: an absence produces no fault, only a report entry', () => {
    // The whole of report mode. If this goes red, absences have started ending runs.
    for (const item of REAL_ABSENCES) {
      expect(findEvidenceFaults(trig([item])).filter(f => f.kind === 'absence')).toEqual([])
    }
  })

  it('quotes the matched span so a false positive is diagnosable without re-running', () => {
    const r = findEvidenceAbsenceReport(trig(['Web search-detectable: no posts about new client wins in the last 90 days']))
    expect(r[0].matched).toBeTruthy()
    expect(r[0].evidence).toContain('no posts')
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

  it('the absence counter does not fire on any clean item either', () => {
    for (const item of [
      'A post on the founder or company page naming a role they are hiring for',
      'A service page published with a start date',
      'An announcement naming a partner, award or accreditation',
      'An event listing naming them as a speaker, with the date',
      'A podcast episode page naming them as the guest',
      'A post naming a person and the new title they have moved into',
    ]) {
      expect(findEvidenceAbsenceReport(trig([item]))).toEqual([])
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
