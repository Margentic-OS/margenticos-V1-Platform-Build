// A QUOTED SPAN THE RESEARCH FOUND IS ONE UNIT, for the length cap and the sentence count.
//
// MEASURED 2026-09-24. One prospect's selected candidate was a blog post whose title
// contained a colon and ran to eighteen words. Carried into an observation it produced TWO
// sentences and a NINETEEN-word sentence against an 18-word cap, and the prospect lost its
// email on every attempt because nothing could be done: shortening a title is a misquote.
//
// TWO OTHER PROSPECTS FAILED THE SAME GATES IN THE SAME RUN AND ARE NOT HELPED, which is
// why this was checked rather than assumed: their copy carried no quotation at all.

import { describe, it, expect } from 'vitest'
import { collapseVerbatimQuotes } from '../quoted-span'
import { countSentences } from '../sentence-count'
import { readabilityScore } from '../readability'

const TITLE = 'The sales bottleneck: why your business stopped scaling the day you became its best salesperson'
const FINDINGS = `A blog post on 25 August 2026 titled '${TITLE}'.`
const OBSERVATION = `You published '${TITLE}' in August.`

describe('a quoted span found in the findings collapses to one unit', () => {
  it('turns a two-sentence count into one', () => {
    expect(countSentences(OBSERVATION)).toBe(2)
    expect(countSentences(collapseVerbatimQuotes(OBSERVATION, FINDINGS))).toBe(1)
  })

  it('brings the longest sentence back under the writer cap', () => {
    expect(readabilityScore(OBSERVATION).maxSentenceWords).toBeGreaterThan(18)
    expect(readabilityScore(collapseVerbatimQuotes(OBSERVATION, FINDINGS)).maxSentenceWords).toBeLessThanOrEqual(18)
  })

  it('works with double quotes and curly quotes too', () => {
    for (const [open, close] of [['"', '"'], ['“', '”'], ['‘', '’']]) {
      const text = `You published ${open}${TITLE}${close} in August.`
      expect(collapseVerbatimQuotes(text, FINDINGS)).not.toContain('bottleneck')
    }
  })
})

describe('a quoted span NOT in the findings gets no exemption', () => {
  it('leaves the writer\'s own invented quotation alone', () => {
    // THE LOOPHOLE THIS CLOSES. Without the findings check, the writer evades the cap by
    // putting quotation marks round any long clause.
    const invented = 'You said \'this is a very long clause the writer invented purely to dodge the eighteen word cap\' in August.'
    expect(collapseVerbatimQuotes(invented, FINDINGS)).toBe(invented)
    expect(readabilityScore(invented).maxSentenceWords).toBeGreaterThan(18)
  })

  it('leaves a short quotation alone, because two words is a turn of phrase', () => {
    const short = "You called it 'the bottleneck' in August."
    expect(collapseVerbatimQuotes(short, FINDINGS)).toBe(short)
  })

  it('exempts nothing at all when there is no findings corpus', () => {
    expect(collapseVerbatimQuotes(OBSERVATION, '')).toBe(OBSERVATION)
  })

  it('leaves unquoted text untouched, however long', () => {
    const plain = 'You published a long piece about the sales bottleneck and why businesses stop scaling in August.'
    expect(collapseVerbatimQuotes(plain, FINDINGS)).toBe(plain)
  })
})

describe('matching ignores case and whitespace, not content', () => {
  it('matches across a line break in the findings', () => {
    const wrapped = `A blog post titled '${TITLE.replace(': ', ':\n')}'.`
    expect(collapseVerbatimQuotes(OBSERVATION, wrapped)).not.toContain('bottleneck')
  })

  it('does not match a DIFFERENT title that merely starts the same', () => {
    const other = "A blog post titled 'The sales bottleneck: why everything else is fine'."
    expect(collapseVerbatimQuotes(OBSERVATION, other)).toBe(OBSERVATION)
  })
})
