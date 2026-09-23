// POSITIVE CONTROLS for the trigger evidence gate, both directions.
//
// The REJECT cases use evidence the ICP generator actually produced on 2026-09-23, verbatim.
// The ACCEPT cases matter as much: a gate that rejects everything is an outage, and this one
// stands between the generator and a landable suggestion.

import { describe, it, expect } from 'vitest'
import { findEvidenceFaults, evidenceFaultFeedback, findEvidenceAbsenceReport, findRecordFields, TRIGGER_REASON_MAX_WORDS } from '../trigger-evidence-gate'

// A VALID REASON ON EVERY FIXTURE, added 2026-09-23 when the reason became required.
// These fixtures exist to exercise the EVIDENCE rules, so they carry a reason that passes
// so the evidence fault is the only one a test can see.
const OK_REASON = 'The event changes what the company needs next.'

const trig = (evidence: string[]) =>
  [{ trigger: 'Something happened on a date', reason: OK_REASON, evidence_to_find: evidence }]

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
      { trigger: 'first', reason: OK_REASON, evidence_to_find: ['a clean one: a post naming a new role'] },
      { trigger: 'second', reason: OK_REASON, evidence_to_find: ['headcount increase in the last 90 days'] },
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

  it('an EMPTY list is not a fault, because a vacuous rejection would hide the real cause', () => {
    // A generator that produced no triggers has a different problem, and this gate must not
    // be the thing that reports it.
    expect(findEvidenceFaults([])).toEqual([])
    expect(findEvidenceFaults(null)).toEqual([])
  })

  it('a trigger with no evidence items is not an EVIDENCE fault', () => {
    expect(findEvidenceFaults([{ trigger: 'x', reason: OK_REASON, evidence_to_find: ['', '   '] }])).toEqual([])
  })

  // SPLIT OUT 2026-09-23. This case used to sit inside the empty-list test and assert no
  // fault, which was right while a trigger had nothing but evidence to get wrong. A trigger
  // with no reason is now a real fault and the most likely one a generator will produce,
  // so it must be reported rather than pass with the empty list.
  it('a trigger with NO REASON is a fault, which is the new contract', () => {
    const faults = findEvidenceFaults([{ trigger: 'x' }])
    expect(faults.map(f => f.kind)).toEqual(['reason_missing'])
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

// ─── THE REASON, AND THE TRIGGER SENTENCE THAT MUST NOT CARRY ONE ────────────
//
// Added 2026-09-23. Every trigger now carries a short principle saying why the event
// creates a need, because without one the copy has only the client's core pain to fall back
// on and every email argues the same thing whatever happened to the prospect.
//
// RULE ZERO: nothing below names a client, a market, a service or a buyer. The fixtures are
// the SHAPES the gate rejects, and they are the same shapes in any market.

describe('every trigger carries a reason, and the gate checks its shape', () => {
  const withReason = (reason: unknown) =>
    [{ trigger: 'Something happened on a date', reason, evidence_to_find: ['a post naming it, with its date'] }]

  it('a missing reason is a fault', () => {
    expect(findEvidenceFaults(withReason(undefined)).map(f => f.kind)).toEqual(['reason_missing'])
  })

  it('an empty or whitespace reason is a fault, not an empty string that passes', () => {
    expect(findEvidenceFaults(withReason('')).map(f => f.kind)).toEqual(['reason_missing'])
    expect(findEvidenceFaults(withReason('   ')).map(f => f.kind)).toEqual(['reason_missing'])
  })

  it('a reason over the cap is a fault, and the cap is one exported constant', () => {
    const long = Array.from({ length: TRIGGER_REASON_MAX_WORDS + 1 }, () => 'word').join(' ')
    const faults = findEvidenceFaults(withReason(long))
    expect(faults.map(f => f.kind)).toContain('reason_long')
    expect(faults.find(f => f.kind === 'reason_long')?.detail).toBe(`${TRIGGER_REASON_MAX_WORDS + 1} words`)
  })

  it('a reason exactly AT the cap passes, so the boundary is not off by one', () => {
    const atCap = Array.from({ length: TRIGGER_REASON_MAX_WORDS }, () => 'word').join(' ')
    expect(findEvidenceFaults(withReason(atCap))).toEqual([])
  })

  it.each([
    ['claims their time',      'The work now competes for hours your week does not have.'],
    ['claims who sells',       'Nobody is left doing the outreach once they go.'],
    ['claims busyness',        'They are too busy to keep new conversations going.'],
  ])('a reason that %s is a fault', (_label, reason) => {
    expect(findEvidenceFaults(withReason(reason)).map(f => f.kind)).toContain('reason_assumes')
  })

  it.each([
    'The event changes what the company needs next.',
    'New capacity is committed before the work that pays for it exists.',
    'A new offer has no existing buyers to sell it to.',
    'Revenue that was predictable has ended and has to be replaced.',
  ])('a clean reason passes: %s', (reason) => {
    // POSITIVE CONTROL for the four rejections above. A gate that fails every reason is an
    // outage, and these are the shapes a correct generator produces.
    expect(findEvidenceFaults(withReason(reason))).toEqual([])
  })
})

describe('the trigger sentence names the event only', () => {
  const sentence = (trigger: string) =>
    [{ trigger, reason: 'The event changes what the company needs next.', evidence_to_find: ['a post naming it, with its date'] }]

  it.each([
    'A large project completed, signalling they are about to re-enter delivery.',
    'A named person left, leaving nobody responsible for new conversations.',
    'A contract ended, creating a revenue gap that has to be filled.',
    'An offer launched, suggesting they are moving into a new market.',
    'A role was posted, which means capacity is being added.',
  ])('flags an inference clause: %s', (trigger) => {
    expect(findEvidenceFaults(sentence(trigger)).map(f => f.kind)).toContain('trigger_infers')
  })

  it.each([
    'A job is posted for a delivery or client-facing role.',
    'A new service, programme or productised offer is launched.',
    'A named person is promoted into a senior or client-facing title.',
    'A partnership, network membership or accreditation is announced.',
    // "signalling" INSIDE a description of evidence is not a verdict about the company, and
    // the pattern is anchored to a comma so this one has to pass.
    'A post signalling the start date is published.',
  ])('leaves a plain event alone: %s', (trigger) => {
    expect(findEvidenceFaults(sentence(trigger))).toEqual([])
  })

  it('reports ONE inference fault per trigger, not one per matching clause', () => {
    const faults = findEvidenceFaults(sentence('A thing happened, signalling one thing, suggesting another.'))
    expect(faults.filter(f => f.kind === 'trigger_infers')).toHaveLength(1)
  })
})

describe('the feedback covers the new faults too', () => {
  it('names the reason fault and quotes the reason', () => {
    const faults = findEvidenceFaults([
      { trigger: 'A thing happened.', reason: 'They are too busy to follow it up.', evidence_to_find: ['a post naming it'] },
    ])
    const text = evidenceFaultFeedback(faults)
    expect(text).toContain('They are too busy to follow it up.')
    expect(text).toMatch(/claim about the reader's time or who does their selling/)
  })

  it('quotes the TRIGGER when the fault is on the sentence, which has no evidence to quote', () => {
    const faults = findEvidenceFaults([
      { trigger: 'A thing happened, signalling trouble.', reason: 'The event changes what is needed.', evidence_to_find: ['a post'] },
    ])
    expect(evidenceFaultFeedback(faults)).toContain('A thing happened, signalling trouble.')
  })
})
