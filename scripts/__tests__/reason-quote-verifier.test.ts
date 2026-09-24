// A VERIFIER THAT CAN INVENT ITS EVIDENCE IS NOT A VERIFIER.
//
// The model half of this check is a judgement and cannot be unit-tested. The half that CAN
// be tested is the one that stops the judgement being worthless: a quoted sentence has to
// appear in the positioning document, or it counts as no quote at all.
//
// RULE ZERO: the fixture below is a positioning document for an invented business in an
// unrelated trade. Nothing here is any client's wording.

import { describe, it, expect } from 'vitest'
import { checkQuotesAreReal } from '../derive-trigger-reasons'

const POSITIONING = [
  'Northwind fits and services commercial refrigeration for independent food retailers.',
  'Engineers are on site within four hours of a callout, seven days a week.',
  'We do not sell equipment and we do not handle warranty claims on somebody else’s installation.',
].join('\n')

const verdict = (over: Partial<Parameters<typeof checkQuotesAreReal>[0][number]>) => ({
  index: 1, supported: true, quote: '', explanation: '', ...over,
})

describe('a quote that is really in the document survives', () => {
  it('accepts an exact sentence', () => {
    const [v] = checkQuotesAreReal([verdict({
      quote: 'Engineers are on site within four hours of a callout, seven days a week.',
    })], POSITIONING)
    expect(v.supported).toBe(true)
  })

  it('accepts it despite different case and collapsed whitespace', () => {
    const [v] = checkQuotesAreReal([verdict({
      quote: '  ENGINEERS are on site   within four hours of a callout, seven days a week. ',
    })], POSITIONING)
    expect(v.supported).toBe(true)
  })

  it('accepts a curly apostrophe quoted as a straight one', () => {
    const [v] = checkQuotesAreReal([verdict({
      quote: "We do not sell equipment and we do not handle warranty claims on somebody else's installation.",
    })], POSITIONING)
    expect(v.supported).toBe(true)
  })
})

describe('a quote that is NOT in the document is rejected', () => {
  it('rejects an invented sentence, however plausible', () => {
    const [v] = checkQuotesAreReal([verdict({
      quote: 'Northwind also markets your business to your existing customers.',
    })], POSITIONING)
    expect(v.supported).toBe(false)
    expect(v.explanation).toContain('does not appear in the positioning document')
  })

  it('rejects a paraphrase of a real sentence', () => {
    // THE LIKELIEST FAILURE. A verifier under pressure to support a reason paraphrases
    // rather than invents, and a paraphrase reads as evidence while proving nothing.
    const [v] = checkQuotesAreReal([verdict({
      quote: 'Engineers attend within four hours, every day of the week.',
    })], POSITIONING)
    expect(v.supported).toBe(false)
  })

  it('rejects "supported" with no quote at all', () => {
    const [v] = checkQuotesAreReal([verdict({ quote: '' })], POSITIONING)
    expect(v.supported).toBe(false)
    expect(v.explanation).toContain('quoted no sentence')
  })

  it('rejects a quote too short to mean anything', () => {
    const [v] = checkQuotesAreReal([verdict({ quote: 'Engineers' })], POSITIONING)
    expect(v.supported).toBe(false)
  })
})

describe('an unsupported verdict is passed through untouched', () => {
  it('keeps the verifier\'s own explanation', () => {
    const [v] = checkQuotesAreReal([verdict({
      supported: false, quote: '', explanation: 'the document never mentions marketing to existing customers',
    })], POSITIONING)
    expect(v.supported).toBe(false)
    expect(v.explanation).toBe('the document never mentions marketing to existing customers')
  })

  it('handles an empty verdict list without inventing one', () => {
    expect(checkQuotesAreReal([], POSITIONING)).toEqual([])
  })
})
