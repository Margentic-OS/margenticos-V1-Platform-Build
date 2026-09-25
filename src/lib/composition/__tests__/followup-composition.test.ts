// THE PIECES follow-up substitution is built from, each tested on its own.
//
// WHAT THIS FILE NO LONGER DOES, and why that is the point. It used to hold a local
// decide() that RESTATED composeSequence's fallback ladder, pair gate included, and
// asserted against its own copy. Its header claimed the opposite in these very words:
// "TESTED AGAINST THE REAL DECISION LOGIC, not a restatement of it ... anything
// reimplemented here would pass while the real code did something else, which is the shape
// of a fake that cannot fail." It was itself that fake, and it proved the point on
// 2026-09-25: composition changed emails 2 and 3 from a pair verdict to a per-position one,
// and every test here stayed green while production behaviour inverted. Worse, the
// restatement then asserted the OLD rule, so the suite was actively vouching for behaviour
// the code no longer had.
//
// So the ladder is gone from here and is tested where it actually lives, by driving the
// real composeSequence: see followup-seam.test.ts. What is left is what this file can
// honestly own — the pure helpers, called directly.
//
// The lesson is cheap to restate and was expensive to learn: a comment claiming a test is
// not a restatement is not evidence. Only calling the real function is.
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

describe('the generated middle goes into the template frame, and only the middle', () => {
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

describe('the two helpers the decision is built from', () => {
  it('the arm is a property of the prospect id, so it is stable across calls', () => {
    const id = 'aa12c353-7441-47c7-88eb-d54f4e8d070f'
    expect(assignFollowupArm(id)).toBe(assignFollowupArm(id))
  })

  it('the fingerprint changes when Email 1 changes, and matches when it does not', () => {
    const fp = fingerprintEmail1(EMAIL1_AS_SENT)
    expect(followupsMatchEmail1(fp, EMAIL1_AS_SENT)).toBe(true)
    expect(followupsMatchEmail1(fp, EMAIL1_AS_SENT.replace('March', 'June'))).toBe(false)
  })

  it('FAILS CLOSED: a missing stored fingerprint never counts as a match', () => {
    expect(followupsMatchEmail1(null, EMAIL1_AS_SENT)).toBe(false)
  })
})
