// The arm, the fingerprint, and the two things they must never do.
//
// MUTATION-PROVED, NOT ASSERTED. Each of the two guards here has a test that constructs
// the state the guard forbids and requires it to be refused, plus a control proving the
// check can detect the fault it is looking for. A test that only asserts the happy path
// passes against a guard that returns true unconditionally.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect } from 'vitest'
import {
  assignFollowupArm,
  fingerprintEmail1,
  followupsMatchEmail1,
  GENERATED_ARM_PERCENT,
} from '../followup-assignment'
import { assignVariantDeterministically } from '../variant-assignment'

const ID_A = 'aa12c353-7441-47c7-88eb-d54f4e8d070f'
const ID_B = 'd0f531e0-fcb4-4230-b912-483d85325db2'

const EMAIL1 = [
  '{{first_name}},',
  'You took on a second unit in March.',
  'A second unit needs work from people who have not quoted you yet.',
  'We find the work and book it in, so the bench stays full without you chasing it.',
  'Worth a look?',
  'Sam\nExample Co',
  'Not for you? Just reply stop.',
].join('\n\n')

describe('the assigned arm', () => {
  it('is 100% generated today, which is the shipping decision', () => {
    expect(GENERATED_ARM_PERCENT).toBe(100)
    for (const id of [ID_A, ID_B, 'x', 'anything-at-all']) {
      expect(assignFollowupArm(id)).toBe('generated')
    }
  })

  it('is deterministic: the same id always lands in the same arm', () => {
    for (const pct of [0, 25, 50, 75, 100]) {
      expect(assignFollowupArm(ID_A, pct)).toBe(assignFollowupArm(ID_A, pct))
    }
  })

  it('honours the percentage, so a comparison is a setting change not a rebuild', () => {
    const ids = Array.from({ length: 400 }, (_, i) => `prospect-${i}`)
    const share = (pct: number) =>
      ids.filter(id => assignFollowupArm(id, pct) === 'generated').length / ids.length

    expect(share(0)).toBe(0)
    expect(share(100)).toBe(1)
    // 400 ids over 100 buckets: close to the nominal share, not exactly it.
    expect(share(50)).toBeGreaterThan(0.4)
    expect(share(50)).toBeLessThan(0.6)
  })

  it('is MONOTONIC in the percentage, so lowering it never reshuffles the arms', () => {
    // A prospect generated at 50 must still be generated at 100. Without this, changing
    // the setting mid-campaign would move prospects BOTH ways and the two groups would
    // stop being comparable to their own earlier selves.
    const ids = Array.from({ length: 300 }, (_, i) => `p-${i}`)
    for (const id of ids) {
      if (assignFollowupArm(id, 50) === 'generated') {
        expect(assignFollowupArm(id, 75)).toBe('generated')
        expect(assignFollowupArm(id, 100)).toBe('generated')
      }
    }
  })

  it('is INDEPENDENT of the variant, which is why the salt exists', () => {
    // Both derive from the prospect id through the same stableHash. Unsalted they would
    // correlate, every prospect in a variant would share an arm, and an arm difference
    // could not be told from a variant difference.
    const ids = Array.from({ length: 400 }, (_, i) => `p-${i}`)
    const variants = ['A', 'B', 'C', 'D']
    const generatedByVariant = new Map<string, number>()
    const totalByVariant = new Map<string, number>()

    for (const id of ids) {
      const v = assignVariantDeterministically(id, variants)
      totalByVariant.set(v, (totalByVariant.get(v) ?? 0) + 1)
      if (assignFollowupArm(id, 50) === 'generated') {
        generatedByVariant.set(v, (generatedByVariant.get(v) ?? 0) + 1)
      }
    }
    // At 50% every variant should be near half generated. A correlated assignment would
    // drive one of these to 0 or 1.
    for (const v of variants) {
      const share = (generatedByVariant.get(v) ?? 0) / (totalByVariant.get(v) ?? 1)
      expect(share, `variant ${v}`).toBeGreaterThan(0.25)
      expect(share, `variant ${v}`).toBeLessThan(0.75)
    }
  })
})

describe('the email 1 fingerprint', () => {
  it('is stable for the same body', () => {
    expect(fingerprintEmail1(EMAIL1)).toBe(fingerprintEmail1(EMAIL1))
  })

  it('ignores trailing whitespace and nothing else', () => {
    expect(fingerprintEmail1(`${EMAIL1}\n\n`)).toBe(fingerprintEmail1(EMAIL1))
    // A leading change is a real change.
    expect(fingerprintEmail1(` ${EMAIL1}`)).not.toBe(fingerprintEmail1(EMAIL1))
  })

  it('MOVES when any part of the shipped email moves', () => {
    // Each of these is a real, separate way Email 1 can change under a set of follow-ups:
    // a re-run rewrites the observation, or the question, or the subject; a new messaging
    // document version rewrites the offer line or the sign-off.
    const changes: [string, string][] = [
      ['observation', EMAIL1.replace('second unit in March', 'third unit in June')],
      ['bridge', EMAIL1.replace('have not quoted you yet', 'have never heard of you')],
      ['offer line', EMAIL1.replace('bench stays full', 'diary stays full')],
      ['question', EMAIL1.replace('Worth a look?', 'Worth fifteen minutes?')],
      ['sign-off', EMAIL1.replace('Sam\nExample Co', 'Alex\nExample Co')],
    ]
    for (const [what, changed] of changes) {
      expect(fingerprintEmail1(changed), what).not.toBe(fingerprintEmail1(EMAIL1))
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE MUTATION: a follow-up must never ship against an Email 1 it was not written for
// ═══════════════════════════════════════════════════════════════════════════════

describe('followupsMatchEmail1 fails closed in every direction', () => {
  const stored = fingerprintEmail1(EMAIL1)

  it('matches only the exact body it was taken from', () => {
    expect(followupsMatchEmail1(stored, EMAIL1)).toBe(true)
  })

  it('THE MUTATION: a changed Email 1 is refused', () => {
    const rewritten = EMAIL1.replace('second unit in March', 'third unit in June')
    expect(followupsMatchEmail1(stored, rewritten)).toBe(false)
  })

  it.each([
    ['no stored fingerprint', null, EMAIL1],
    ['empty stored fingerprint', '', EMAIL1],
    ['undefined stored fingerprint', undefined, EMAIL1],
    ['no composed body', stored, null],
    ['empty composed body', stored, ''],
    ['neither', null, null],
  ])('refuses on incomplete information: %s', (_label, fp, body) => {
    expect(followupsMatchEmail1(fp as string | null, body as string | null)).toBe(false)
  })

  it('THE CONTROL: the check can return true, so the refusals above mean something', () => {
    // Without this, every assertion above would pass against a function that returns
    // false unconditionally, which would disable the feature rather than guard it.
    expect(followupsMatchEmail1(fingerprintEmail1('anything'), 'anything')).toBe(true)
  })
})
