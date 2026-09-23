// Rendering a changed answer for the operator notification.
//
// THE ONE RULE WORTH A WHOLE FILE: nothing here may ever emit the literal words "null",
// "undefined" or "NaN". validateEmailContent in src/lib/email/send.ts refuses an email
// containing any of them, and the operator audience is exempt from the STYLE rules only,
// never from those RENDERING checks. BuyerProfile is full of legitimate nulls
// (buyer_headcount_min until answered, signoff_required where null means "not answered" and
// is a different state from false), so the obvious String(value) formatter would produce an
// email the validator throws away and an operator who is never told a client edited anything.

import { describe, it, expect } from 'vitest'
import {
  ANSWER_EXCERPT_LIMIT,
  BLANK_ANSWER,
  BUYER_PROFILE_FIELD_LABELS,
  UNANSWERED,
  buyerProfileAnswerChanges,
  renderAnswerValue,
  renderBuyerProfileValue,
} from '../answer-change'
import { BUYER_PROFILE_FIELD_KEYS, EMPTY_BUYER_PROFILE } from '../buyer-profile'
import { validateEmailContent } from '@/lib/email/send'

// The exact tokens the validator refuses, as one list, so a test cannot check two of three.
const FORBIDDEN_TOKENS = ['null', 'undefined', 'NaN']

function containsForbiddenToken(text: string): string | null {
  for (const token of FORBIDDEN_TOKENS) {
    if (new RegExp(`\\b${token}\\b`, 'i').test(text)) return token
  }
  return null
}

describe('the forbidden-token detector works, so a clean result means something', () => {
  // Positive control. Every negative assertion below leans on this function.
  it.each(FORBIDDEN_TOKENS)('detects a planted "%s"', (token) => {
    expect(containsForbiddenToken(`value was ${token} here`)).toBe(token)
  })

  it('does not fire on ordinary prose', () => {
    expect(containsForbiddenToken('We help teams ship faster.')).toBeNull()
  })

  it('agrees with the real validator, which is the thing that actually refuses', () => {
    // Guards against this file drifting away from send.ts and testing its own opinion.
    expect(validateEmailContent('subject', '<p>value was null</p>', undefined, 'operator'))
      .toContain('null')
    expect(validateEmailContent('subject', '<p>value was fine</p>', undefined, 'operator'))
      .toBeNull()
  })
})

describe('renderAnswerValue', () => {
  it('names a blank answer rather than rendering nothing', () => {
    expect(renderAnswerValue('')).toBe(BLANK_ANSWER)
    expect(renderAnswerValue('   ')).toBe(BLANK_ANSWER)
  })

  it('never renders a null or undefined input as its own name', () => {
    expect(renderAnswerValue(null)).toBe(BLANK_ANSWER)
    expect(renderAnswerValue(undefined)).toBe(BLANK_ANSWER)
    expect(containsForbiddenToken(renderAnswerValue(null))).toBeNull()
    expect(containsForbiddenToken(renderAnswerValue(undefined))).toBeNull()
  })

  it('trims, because stored answers are trimmed for word counting anyway', () => {
    expect(renderAnswerValue('  an answer  ')).toBe('an answer')
  })

  it('marks a truncated answer so it cannot be read as a short one', () => {
    const long = 'x'.repeat(ANSWER_EXCERPT_LIMIT + 50)
    const rendered = renderAnswerValue(long)
    expect(rendered).toContain('(truncated)')
    expect(rendered.length).toBeLessThan(long.length)
  })

  it('leaves an answer exactly at the limit alone', () => {
    const exact = 'x'.repeat(ANSWER_EXCERPT_LIMIT)
    expect(renderAnswerValue(exact)).toBe(exact)
  })
})

describe('renderBuyerProfileValue never emits a forbidden token', () => {
  it('spells out an unanswered integer', () => {
    expect(renderBuyerProfileValue(null)).toBe(UNANSWERED)
    expect(containsForbiddenToken(renderBuyerProfileValue(null))).toBeNull()
  })

  it('spells out an unanswered boolean, which is not the same state as false', () => {
    expect(renderBuyerProfileValue(null)).toBe(UNANSWERED)
    expect(renderBuyerProfileValue(false)).toBe('No')
    expect(renderBuyerProfileValue(true)).toBe('Yes')
  })

  it('renders an empty list as (none), not as an empty string', () => {
    expect(renderBuyerProfileValue([])).toBe('(none)')
  })

  it('joins a list', () => {
    expect(renderBuyerProfileValue(['one', 'two'])).toBe('one, two')
  })

  it('renders a real integer, including zero', () => {
    expect(renderBuyerProfileValue(0)).toBe('0')
    expect(renderBuyerProfileValue(250)).toBe('250')
  })

  it('does not render NaN as its own name, even though no column should hold one', () => {
    expect(renderBuyerProfileValue(Number.NaN)).toBe(UNANSWERED)
    expect(containsForbiddenToken(renderBuyerProfileValue(Number.NaN))).toBeNull()
  })

  // The sweep. Every value the EMPTY profile holds is exactly the unanswered case, which is
  // the state most likely to reach the formatter, and all of them are null or empty.
  it('renders every field of an entirely unanswered profile safely', () => {
    for (const key of BUYER_PROFILE_FIELD_KEYS) {
      const rendered = renderBuyerProfileValue(EMPTY_BUYER_PROFILE[key])
      expect(containsForbiddenToken(rendered), `${key} rendered as "${rendered}"`).toBeNull()
      expect(rendered.length).toBeGreaterThan(0)
    }
  })
})

describe('every buyer-profile column has an operator label', () => {
  // Checked against BUYER_PROFILE_FIELD_KEYS, which is itself derived from
  // EMPTY_BUYER_PROFILE, so this reads the interface rather than a second hand-written list.
  it('has a label for every column', () => {
    expect(BUYER_PROFILE_FIELD_KEYS.length).toBeGreaterThan(5) // guard the guard
    for (const key of BUYER_PROFILE_FIELD_KEYS) {
      expect(BUYER_PROFILE_FIELD_LABELS[key], `no label for ${key}`).toBeTruthy()
    }
  })

  it('has no label for a column that does not exist', () => {
    const labelled = Object.keys(BUYER_PROFILE_FIELD_LABELS).sort()
    expect(labelled).toEqual([...BUYER_PROFILE_FIELD_KEYS].sort())
  })

  it('no label is a raw database key, which is what a missing label would fall back to', () => {
    for (const key of BUYER_PROFILE_FIELD_KEYS) {
      expect(BUYER_PROFILE_FIELD_LABELS[key]).not.toBe(key)
    }
  })
})

describe('buyerProfileAnswerChanges', () => {
  const previous = { ...EMPTY_BUYER_PROFILE, buyer_headcount_min: 5, buyer_headcount_max: 20 }
  const next = { ...EMPTY_BUYER_PROFILE, buyer_headcount_min: 21, buyer_headcount_max: 50 }

  it('reports from what to what, with labels', () => {
    const changes = buyerProfileAnswerChanges(previous, next, ['buyer_headcount_min'])
    expect(changes).toEqual([{
      fieldKey: 'buyer_headcount_min',
      fieldLabel: BUYER_PROFILE_FIELD_LABELS.buyer_headcount_min,
      previous: '5',
      next: '21',
    }])
  })

  it('reports an answer that was never given as unanswered, not as null', () => {
    const changes = buyerProfileAnswerChanges(
      EMPTY_BUYER_PROFILE,
      { ...EMPTY_BUYER_PROFILE, signoff_required: true },
      ['signoff_required'],
    )
    expect(changes[0].previous).toBe(UNANSWERED)
    expect(changes[0].next).toBe('Yes')
    expect(containsForbiddenToken(JSON.stringify(changes))).toBeNull()
  })

  it('only reports the fields it was given, never every field', () => {
    // The caller passes changedBuyerProfileFields' result. Recomputing here would be a
    // second derivation of one fact and could disagree with what was flagged stale.
    const changes = buyerProfileAnswerChanges(previous, next, ['buyer_headcount_max'])
    expect(changes).toHaveLength(1)
    expect(changes[0].fieldKey).toBe('buyer_headcount_max')
  })

  it('returns nothing for an empty change list', () => {
    expect(buyerProfileAnswerChanges(previous, next, [])).toEqual([])
  })
})
