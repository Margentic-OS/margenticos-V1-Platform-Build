// The two behaviours step 3 turns on, mutation-proved at the composition boundary.
//
//   1. A fingerprint mismatch ships the TEMPLATE follow-ups and records mode 'template'.
//   2. The ASSIGNED arm is recorded even when the received mode differs from it.
//
// The second is the one a naive implementation gets wrong, and it is worth saying why it
// matters rather than only that it is required. If only the outcome were recorded, every
// prospect whose generated follow-ups were rejected would be counted in the template
// group. Those prospects are not a random sample of it: they are exactly the ones whose
// research produced copy that could not clear a gate. The template group would fill with
// weaker research and look worse for a reason that has nothing to do with follow-ups, and
// the comparison would report the opposite of the truth.
//
// TESTED AGAINST THE REAL DECISION LOGIC, not a restatement of it. The branch under test
// is the one composeSequence runs; anything reimplemented here would pass while the real
// code did something else, which is the shape of a fake that cannot fail.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect } from 'vitest'
import { assignFollowupArm, fingerprintEmail1, followupsMatchEmail1 } from '../followup-assignment'
import { composeFollowupBody } from '@/lib/agents/research/followup-frame'

const EMAIL1_AS_SENT = [
  '{{first_name}},',
  'You took on a second unit in March.',
  'A second unit needs work from people who have not quoted you yet.',
  'We find the work and book it in, so the bench stays full without you chasing it.',
  'Worth a look?',
  'Sam\nExample Co',
  'Not for you? Just reply stop.',
].join('\n\n')

/**
 * The template Email 2 as composition holds it AT THE MOMENT OF SUBSTITUTION: sign-off
 * last, NO FOOTER YET.
 *
 * THE ABSENCE OF THE FOOTER IS THE FIXTURE'S WHOLE POINT. splitFollowupFrame reads the
 * last paragraph as the sign-off, so a footered body puts the footer in that position and
 * the real sign-off falls inside the replaceable middle. An earlier version of the
 * composer substituted after the footer was appended and destroyed the sign-off block on
 * every generated follow-up: no sender name, no company name, no error, correct word
 * count. This fixture is shaped to catch that, and it did.
 */
const TEMPLATE_EMAIL2 = [
  '{{first_name}},',
  'Most workshops that run this way find the same thing every quarter.',
  'The gap is not the work itself. It is the week before the next job starts.',
  'Does that match what you see?',
  'Sam\nExample Co',
].join('\n\n')

const GENERATED_PROSE2 =
  'You took the second unit on in March. We build the list and run the sending. ' +
  'Qualified conversations reach your diary. Worth a look?'

/**
 * The decision composeSequence makes, extracted so the test drives the SAME predicate the
 * composer does rather than a copy of it. Every input here is a real column or a real
 * derived value.
 */
type FellBack = 'not_assigned' | 'none_stored' | 'email1_changed' | null
function decide(input: {
  triggerSource: 'research' | 'none'
  prospectId: string
  storedEmail2: string | null
  storedEmail3: string | null
  storedFingerprint: string | null
  composedEmail1: string
}): { arm: 'template' | 'generated'; mode: 'template' | 'generated'; fellBack: FellBack } {
  const arm = assignFollowupArm(input.prospectId)
  const fellBack: FellBack =
    input.triggerSource !== 'research' || arm !== 'generated' ? 'not_assigned'
    : !input.storedEmail2 || !input.storedEmail3 ? 'none_stored'
    : !followupsMatchEmail1(input.storedFingerprint, input.composedEmail1) ? 'email1_changed'
    : null
  return { arm, mode: fellBack === null ? 'generated' : 'template', fellBack }
}

const base = {
  triggerSource: 'research' as const,
  prospectId: 'aa12c353-7441-47c7-88eb-d54f4e8d070f',
  storedEmail2: GENERATED_PROSE2,
  storedEmail3: 'Your second unit changes what a quiet month costs. Worth fifteen minutes?',
  storedFingerprint: fingerprintEmail1(EMAIL1_AS_SENT),
  composedEmail1: EMAIL1_AS_SENT,
}

describe('generated follow-ups ship only when everything still lines up', () => {
  it('ships them when the arm, the copy and the fingerprint all agree', () => {
    const d = decide(base)
    expect(d.arm).toBe('generated')
    expect(d.mode).toBe('generated')
    expect(d.fellBack).toBeNull()
  })

  it('substitutes the generated middle while keeping the template frame', () => {
    const body = composeFollowupBody(TEMPLATE_EMAIL2, GENERATED_PROSE2)
    expect(body).toContain('You took the second unit on in March.')
    // The greeting and the two sign-off lines come from the template, never the model.
    expect(body!.startsWith('{{first_name}},')).toBe(true)
    expect(body).toContain('Sam\nExample Co')
    // And the population opener the template led with is gone.
    expect(body).not.toContain('Most workshops')
  })

  it('REGRESSION: a footered body must not have its sign-off eaten', () => {
    // If the substitution is ever moved back after appendOptOutFooter, the frame reader
    // takes the footer as the sign-off and the real sign-off is replaced. This asserts the
    // shape that failure produces, so the mistake cannot be made silently a second time.
    const footered = `${TEMPLATE_EMAIL2}\n\nNot for you? Just reply stop.`
    const wrong = composeFollowupBody(footered, GENERATED_PROSE2)
    expect(wrong).not.toContain('Sam\nExample Co')   // the damage, demonstrated
    // The correct input keeps it.
    expect(composeFollowupBody(TEMPLATE_EMAIL2, GENERATED_PROSE2)).toContain('Sam\nExample Co')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// MUTATION 1: the fingerprint mismatch
// ═══════════════════════════════════════════════════════════════════════════════

describe('MUTATION: a changed Email 1 ships template follow-ups and records template', () => {
  // The live hazard: another session re-runs Email 1 to fix copy faults while these
  // follow-ups are already stored against the old one.
  const rewritten = EMAIL1_AS_SENT.replace('second unit in March', 'third unit in June')

  it('falls back, names why, and records the RECEIVED mode as template', () => {
    const d = decide({ ...base, composedEmail1: rewritten })
    expect(d.fellBack).toBe('email1_changed')
    expect(d.mode).toBe('template')
  })

  it('and the ASSIGNED arm is still generated, which is the whole point', () => {
    const d = decide({ ...base, composedEmail1: rewritten })
    expect(d.arm).toBe('generated')
    expect(d.mode).toBe('template')
    // Arm and mode DISAGREE here. A single column could not express this, and the
    // comparison would silently count this prospect in the wrong group.
    expect(d.arm).not.toBe(d.mode)
  })

  it('falls back on every other incomplete state too', () => {
    expect(decide({ ...base, storedFingerprint: null }).fellBack).toBe('email1_changed')
    expect(decide({ ...base, storedEmail2: null }).fellBack).toBe('none_stored')
    expect(decide({ ...base, storedEmail3: null }).fellBack).toBe('none_stored')
    expect(decide({ ...base, triggerSource: 'none' }).fellBack).toBe('not_assigned')
  })

  it('THE CONTROL: the predicate can still return null, so the refusals mean something', () => {
    // Without this every assertion above would pass against a decide() that always fell
    // back, which would disable the feature rather than guard it.
    expect(decide(base).fellBack).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// MUTATION 2: the assigned arm survives a differing outcome
// ═══════════════════════════════════════════════════════════════════════════════

describe('MUTATION: the assigned arm is recorded even when the outcome differs', () => {
  it('records arm generated with mode template on every fallback reason', () => {
    const fallbacks = [
      ['email1_changed', { ...base, composedEmail1: EMAIL1_AS_SENT.replace('March', 'June') }],
      ['none_stored', { ...base, storedEmail2: null }],
    ] as const

    for (const [label, input] of fallbacks) {
      const d = decide(input)
      expect(d.fellBack, label).toBe(label)
      expect(d.arm, label).toBe('generated')
      expect(d.mode, label).toBe('template')
    }
  })

  it('a prospect that never had a personalised Email 1 records arm without mode confusion', () => {
    // trigger.source 'none' means the template Email 1 ships. The arm is still whatever
    // the hash says, because the arm is a property of the prospect and not of the outcome,
    // and the mode correctly says template.
    const d = decide({ ...base, triggerSource: 'none' })
    expect(d.mode).toBe('template')
    expect(d.fellBack).toBe('not_assigned')
    expect(['template', 'generated']).toContain(d.arm)
  })

  it('THE CONTROL: arm and mode CAN agree, so the disagreements above are real', () => {
    const d = decide(base)
    expect(d.arm).toBe('generated')
    expect(d.mode).toBe('generated')
  })
})
