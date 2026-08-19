// Unit tests for cross-variant full-sentence reuse detection.
//
// The anchor is the real failure: variants A, B and C all ended Email 1 P3 with
// "You take the calls and close them." Nothing saw it, because the only cross-variant
// checks covered subject lines and Email 1 openers.

import { describe, it, expect } from 'vitest'
import {
  SentenceRegistry,
  comparableSentences,
  sentenceKey,
  MIN_SHARED_SENTENCE_WORDS,
} from '../sentence-frames'

const SIGN_OFF = ['Doug', 'MargenticOS']

const body = (...paras: string[]) =>
  ['{{first_name}}', ...paras, 'Doug\nMargenticOS'].join('\n\n')

const VARIANT_A_E1 = body(
  'A project ends and the next few months get quiet.',
  'We fill your diary with qualified meetings every month. You take the calls and close them.',
  'Is pipeline consistency something you are actively trying to fix?',
)

const VARIANT_B_E1 = body(
  'Referrals keep things ticking, but they set the ceiling too.',
  'We get conversations in your diary every month. You take the calls and close them.',
  'Is getting more qualified meetings something you are working on?',
)

describe('the anchor case', () => {
  it('catches the offer line reused across two variants', () => {
    const registry = new SentenceRegistry()
    registry.register('A', VARIANT_A_E1, SIGN_OFF)

    const reuse = registry.findReuse('B', VARIANT_B_E1, SIGN_OFF)
    expect(reuse.map(r => r.sentence)).toContain('You take the calls and close them.')
  })

  it('names the variant that used it first', () => {
    const registry = new SentenceRegistry()
    registry.register('A', VARIANT_A_E1, SIGN_OFF)
    expect(registry.findReuse('B', VARIANT_B_E1, SIGN_OFF)[0].firstSeenId).toBe('A')
  })

  it('does not flag the first variant against itself', () => {
    const registry = new SentenceRegistry()
    registry.register('A', VARIANT_A_E1, SIGN_OFF)
    expect(registry.findReuse('A', VARIANT_A_E1, SIGN_OFF)).toEqual([])
  })

  it('leaves the genuinely different sentences alone', () => {
    const registry = new SentenceRegistry()
    registry.register('A', VARIANT_A_E1, SIGN_OFF)
    const reuse = registry.findReuse('B', VARIANT_B_E1, SIGN_OFF).map(r => r.sentence)
    expect(reuse).not.toContain('Referrals keep things ticking, but they set the ceiling too.')
    expect(reuse).toHaveLength(1)
  })
})

describe('the sign-off is exempt', () => {
  it('never reports the mandatory two-line sign-off as reuse', () => {
    const registry = new SentenceRegistry()
    registry.register('A', body('Opener one here.', 'Offer line one here.'), SIGN_OFF)
    const reuse = registry.findReuse('B', body('Opener two here.', 'Offer line two here.'), SIGN_OFF)
    expect(reuse).toEqual([])
  })

  it('a short sign-off is already exempt via the word floor, without the exclusion', () => {
    // "Doug" and "MargenticOS" are one word each, so the MIN_SHARED_SENTENCE_WORDS floor
    // filters them before the exclusion list is consulted.
    const registry = new SentenceRegistry()
    registry.register('A', body('Opener one here.', 'Offer line one here.'), [])
    expect(registry.findReuse('B', body('Opener two here.', 'Offer line two here.'), [])).toEqual([])
  })

  it('the exclusion earns its keep on a company name long enough to clear the floor', () => {
    // This is the case the floor cannot cover: a four-word company name is a legitimate
    // sentence-length line repeated in all sixteen emails by design.
    const LONG = ['Doug', 'The Margentic Consulting Group']
    const longBody = (...paras: string[]) =>
      ['{{first_name}}', ...paras, 'Doug\nThe Margentic Consulting Group'].join('\n\n')

    const withoutExclusion = new SentenceRegistry()
    withoutExclusion.register('A', longBody('Opener one here.'), [])
    expect(withoutExclusion.findReuse('B', longBody('Opener two here.'), []).length).toBeGreaterThan(0)

    const withExclusion = new SentenceRegistry()
    withExclusion.register('A', longBody('Opener one here.'), LONG)
    expect(withExclusion.findReuse('B', longBody('Opener two here.'), LONG)).toEqual([])
  })
})

describe('normalisation', () => {
  it('treats a swapped proper noun as the same sentence', () => {
    const registry = new SentenceRegistry()
    registry.register('A', body('We book qualified meetings for Acme every month.'), SIGN_OFF)
    const reuse = registry.findReuse('B', body('We book qualified meetings for Beta every month.'), SIGN_OFF)
    expect(reuse).toHaveLength(1)
  })

  it('treats a swapped number as the same sentence', () => {
    expect(sentenceKey('We ran it for 13 months.')).toBe(sentenceKey('We ran it for 20 months.'))
  })

  it('keeps genuinely different sentences distinct', () => {
    expect(sentenceKey('We fill your diary with meetings.')).not.toBe(sentenceKey('We run the outbound for you.'))
  })
})

describe('short sentences are exempt', () => {
  it(`ignores sentences under ${MIN_SHARED_SENTENCE_WORDS} words`, () => {
    const registry = new SentenceRegistry()
    registry.register('A', body('It doesn\'t. Something longer here to anchor it.'), SIGN_OFF)
    const reuse = registry.findReuse('B', body('It doesn\'t. A different anchor sentence entirely.'), SIGN_OFF)
    expect(reuse).toEqual([])
  })

  it('still catches a four-word fingerprint', () => {
    const registry = new SentenceRegistry()
    registry.register('A', body('Last one from me.'), SIGN_OFF)
    const reuse = registry.findReuse('B', body('Last one from me.'), SIGN_OFF)
    expect(reuse).toHaveLength(1)
  })
})

describe('comparableSentences', () => {
  it('drops the greeting and the sign-off, keeping the prose', () => {
    const sentences = comparableSentences(body('The opener sentence here.', 'The offer sentence here.'), SIGN_OFF)
    expect(sentences).toEqual(['The opener sentence here.', 'The offer sentence here.'])
  })

  it('splits multi-sentence paragraphs', () => {
    const sentences = comparableSentences(body('First sentence right here. Second sentence right here.'), SIGN_OFF)
    expect(sentences).toHaveLength(2)
  })

  it('covers every email position, not just email 1', () => {
    // A body with no greeting at all (a follow-up shape) still yields its sentences.
    const sentences = comparableSentences('Some following sentence here.\n\nDoug\nMargenticOS', SIGN_OFF)
    expect(sentences).toEqual(['Some following sentence here.'])
  })
})
