// Unit tests for readabilityScore in readability.ts.
//
// The two anchors are the real failing observation that scored 6/6 and shipped, and the
// real benchmark from a campaign that replied at 7 percent. If the failing one ever stops
// hard-failing, or the benchmark ever starts hard-failing, the gate is wrong.

import { describe, it, expect } from 'vitest'
import { readabilityScore, MAX_SENTENCE_WORDS, HEDGE_PHRASES } from '../readability'

const FAILING_OBSERVATION =
  'Running Taffet alongside the CRC Director engagement from mid-2024 through mid-2025 ' +
  'is a particular kind of balancing act, and with that role now wrapped, the pipeline ' +
  'question for Taffet tends to land differently.'

const BENCHMARK_OBSERVATION =
  'Read through your last 30 reviews on Google. Front desk hold times keep coming up, ' +
  '4 of the most recent 10.'

describe('readabilityScore — the two anchor examples', () => {
  it('hard-fails the observation that scored 6/6 and shipped', () => {
    const score = readabilityScore(FAILING_OBSERVATION)
    expect(score.hardFail).toBe(true)
  })

  it('flags the failing observation for BOTH length and hedging', () => {
    const score = readabilityScore(FAILING_OBSERVATION)
    expect(score.maxSentenceWords).toBeGreaterThan(MAX_SENTENCE_WORDS)
    expect(score.hedges).toContain('a particular kind of')
    expect(score.hedges).toContain('tends to')
  })

  it('passes the 7 percent benchmark cleanly', () => {
    const score = readabilityScore(BENCHMARK_OBSERVATION)
    expect(score.hardFail).toBe(false)
    expect(score.hedges).toEqual([])
    expect(score.penalty).toBe(0)
  })

  it('ranks the benchmark far ahead of the failing observation', () => {
    const failing = readabilityScore(FAILING_OBSERVATION)
    const benchmark = readabilityScore(BENCHMARK_OBSERVATION)
    expect(benchmark.penalty).toBeLessThan(failing.penalty)
  })

  it('splits the benchmark into two sentences', () => {
    expect(readabilityScore(BENCHMARK_OBSERVATION).sentences).toHaveLength(2)
  })
})

describe('readabilityScore — sentence length', () => {
  it('passes a sentence exactly at the cap', () => {
    const text = Array.from({ length: MAX_SENTENCE_WORDS }, (_, i) => `word${i}`).join(' ') + '.'
    const score = readabilityScore(text)
    expect(score.maxSentenceWords).toBe(MAX_SENTENCE_WORDS)
    expect(score.longSentences).toEqual([])
    expect(score.hardFail).toBe(false)
  })

  it('hard-fails a sentence one word over the cap', () => {
    const text = Array.from({ length: MAX_SENTENCE_WORDS + 1 }, (_, i) => `word${i}`).join(' ') + '.'
    const score = readabilityScore(text)
    expect(score.hardFail).toBe(true)
    expect(score.longSentences).toHaveLength(1)
  })

  it('scales the penalty with how far over the cap the sentence runs', () => {
    const justOver = Array.from({ length: MAX_SENTENCE_WORDS + 1 }, (_, i) => `word${i}`).join(' ') + '.'
    const wayOver  = Array.from({ length: MAX_SENTENCE_WORDS + 15 }, (_, i) => `word${i}`).join(' ') + '.'
    expect(readabilityScore(wayOver).penalty).toBeGreaterThan(readabilityScore(justOver).penalty)
  })

  it('measures the longest sentence, not the total', () => {
    // Two short sentences totalling more than the cap must still pass.
    const text = 'He ran the firm and the second role side by side for fourteen months. That finished in August.'
    const score = readabilityScore(text)
    expect(score.hardFail).toBe(false)
  })

  it('returns zero words for empty text without throwing', () => {
    const score = readabilityScore('')
    expect(score.maxSentenceWords).toBe(0)
    expect(score.hardFail).toBe(false)
  })
})

describe('readabilityScore — hedging', () => {
  it.each([
    ['tends to', 'The pipeline tends to go quiet.'],
    ['can be', 'That can be the pattern here.'],
    ['often', 'The second role often ends first.'],
    ['usually', 'Which usually means pipeline resets.'],
    ['a particular kind of', 'That is a particular kind of juggle.'],
  ])('hard-fails on the hedge "%s"', (hedge, text) => {
    const score = readabilityScore(text)
    expect(score.hedges).toContain(hedge)
    expect(score.hardFail).toBe(true)
  })

  it('does not fire "may" on a month, which dated observations routinely carry', () => {
    const score = readabilityScore('The Director role started in May 2024 and ended in August 2025.')
    expect(score.hedges).toEqual([])
    expect(score.hardFail).toBe(false)
  })

  it('does not treat "suggests" as a hedge, since the prompt prescribes it', () => {
    // NON_JUDGEMENTAL guidance actively recommends this frame for composite absences.
    // Banning it would hard-fail every composite candidate.
    const text = 'The gap between the last case study and the delivery work suggests marketing got what was left.'
    expect(readabilityScore(text).hedges).toEqual([])
  })

  it('respects word boundaries so "might" does not fire inside "mighty"', () => {
    expect(readabilityScore('A mighty result.').hedges).toEqual([])
  })

  it('deduplicates a hedge repeated in one text', () => {
    const score = readabilityScore('It tends to slip. It tends to stall.')
    expect(score.hedges.filter(h => h === 'tends to')).toHaveLength(1)
  })

  it('has no duplicate entries in the hedge list itself', () => {
    expect(new Set(HEDGE_PHRASES).size).toBe(HEDGE_PHRASES.length)
  })
})

describe('readabilityScore — nominalisation is penalty only, never a hard fail', () => {
  it('never hard-fails on nominalisation density alone', () => {
    // Dense with -tion/-ment nouns, but short sentences and no hedging.
    const text = 'Retention and acquisition drive expansion. Segmentation shapes attribution and conversion.'
    const score = readabilityScore(text)
    expect(score.nominalisation.exceedsThreshold).toBe(true)
    expect(score.hardFail).toBe(false)
  })

  it('still adds demerits so denser copy ranks worse', () => {
    const dense = 'Retention and acquisition drive expansion. Segmentation shapes attribution and conversion.'
    const plain = 'They keep more clients. They win new ones faster.'
    expect(readabilityScore(dense).penalty).toBeGreaterThan(readabilityScore(plain).penalty)
  })

  it('records the matched nominalisations in the reasons', () => {
    const text = 'Retention and acquisition drive expansion. Segmentation shapes attribution and conversion.'
    const score = readabilityScore(text)
    expect(score.reasons.some(r => r.includes('Nominalisation density'))).toBe(true)
  })
})
