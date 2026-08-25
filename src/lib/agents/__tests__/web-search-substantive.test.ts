// isSubstantive decides whether a web search result is stored and fed to the paid Sonnet
// synthesis call, or discarded as "limited". It used to disqualify a negative only when the
// WHOLE text was under 220 characters, so a verbose negative outgrew the test: 72% of the
// stored native texts carried an explicit "could not find" and every one passed.
//
// The texts quoted below are real, taken from prospect_research_results.raw_web_search on
// 2026-08-25 and shortened only where marked. Names are the prospects' own, already in the
// database.

import { describe, it, expect } from 'vitest'
import { isSubstantive } from '../tools/webSearch'

describe('the verbose negative, which is what this change exists to catch', () => {
  // Rejected at 32% positive share. The old rule passed it purely because it ran long.
  it('rejects a long negative whose bullets are also negative', () => {
    const real =
      'Based on my research, I could not find verifiable information about "Jochen" Knot ' +
      'Consulting GmbH publishing podcasts, conducting interviews, writing articles, or ' +
      'other media appearances in 2026.\n\n**Findings:**\n\n• No podcast, interview, article, ' +
      'or published content attributable to Jochen Ladwig or KNOT Consulting GmbH in 2026 ' +
      'appears in search results.\n\n• The company\'s website and professional directories ' +
      'contain no evidence of media appearances or published content during 2026.'
    expect(isSubstantive(real)).toBe(false)
  })

  it('rejects a negative about having matched the wrong entity entirely', () => {
    const real =
      'Based on the search results, I was unable to find verifiable content matching the ' +
      'specific query of "Richard" associated with Blue Sky Consulting in podcast, interview, ' +
      'article, or published content from 2026. The search results show multiple "Blue Sky" ' +
      'entities, but none show a person named "Richard" as a primary figure.'
    expect(isSubstantive(real)).toBe(false)
  })

  // The bullets carry the negation, not the opening line. Extending only the marker list
  // changed zero verdicts on the real corpus, which is why the patterns exist.
  it('catches a bullet-borne negation that no marker string matches', () => {
    const bulletsOnly =
      '• No dated blog posts, case studies or press mentions were located for this firm.\n' +
      '• The website does not appear to have been updated since launch.\n' +
      '• None of the directories list published content for the principal.'
    expect(isSubstantive(bulletsOnly)).toBe(false)
  })
})

describe('mixed text keeps passing, which is the risk of over-tightening', () => {
  // This shape produced three shipped openings. Losing it would be a real regression.
  it('keeps a negative opener when a dated positive fact follows', () => {
    const mixed =
      'No verifiable 2026 press releases were found for the firm. ' +
      'DRI Consulting Limited was incorporated in the UK on 19 March 2026, registered at ' +
      '3 Wakeling Street, London, and now reports approximately 14 employees across three ' +
      'continents including North America, Asia and South America as of July 2026.'
    expect(isSubstantive(mixed)).toBe(true)
  })

  it('keeps a text whose findings outweigh a single negative line', () => {
    const mixed =
      'I could not find 2026 conference appearances. ' +
      'Mark Eber retired from management responsibilities in December 2022. ' +
      'His previous company had nearly 250 employees and $44 million in fee income, and he ' +
      'founded Command 31 Consulting the following year, operating it as a solo practice.'
    expect(isSubstantive(mixed)).toBe(true)
  })

  it('leaves a wholly positive text untouched', () => {
    const positive =
      'Electro launched in March 2024 with a team of two. The Founders Future podcast, ' +
      'hosted by Milan Kohut, aired an episode on 28 January 2026 covering the founding journey.'
    expect(isSubstantive(positive)).toBe(true)
  })
})

describe('the guards that were already there', () => {
  it('rejects a bare bullet glyph', () => {
    expect(isSubstantive('•')).toBe(false)
    expect(isSubstantive('• \n• \n•')).toBe(false)
  })

  it('rejects the model announcing a search it has not run', () => {
    expect(isSubstantive("I'll search for information about Robert Taffet and his consulting work, podcast, interviews, or publications in 2026.")).toBe(false)
  })

  it('rejects anything under the minimum length regardless of content', () => {
    expect(isSubstantive('Launched in March 2024.')).toBe(false)
  })
})

describe('the specific regression: length must not buy a pass', () => {
  // The old rule's exact failure mode, reduced to one assertion. Padding a negative past
  // 220 characters used to flip it to substantive.
  it('does not pass a negative merely because it is long', () => {
    const short = 'I was unable to find any verifiable information.'
    const padded = short + ' ' + 'No records were located in any public directory. '.repeat(6)

    expect(isSubstantive(short)).toBe(false)
    expect(padded.replace(/[•\-*\s]/g, '').length).toBeGreaterThan(220)
    expect(isSubstantive(padded)).toBe(false)
  })
})
