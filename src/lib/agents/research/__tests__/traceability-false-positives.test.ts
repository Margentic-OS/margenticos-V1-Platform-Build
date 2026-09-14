// THREE MEASURED FALSE POSITIVES IN THE OPENING GATES, AND THE PROOF THEY STILL REJECT.
//
// Each of the three cost a real prospect all three attempts on 2026-09-14, and each pair
// below is the point of the file: the case that WRONGLY failed must now pass, and the case
// the gate exists for must still fail. A fix proven in one direction only is a fix that
// might have deleted the gate.
//
// Every sentence here is invented. No client or prospect text appears in the repository.

import { describe, it, expect } from 'vitest'
import { checkOpeningGates, stripQuotedSpans } from '../write-opening'

/** The evidence corpus: observation plus provenance, which is what the gate has always read. */
const EVIDENCE = [
  '1. Bramwell Logistics has run the same two depots since the company was founded.',
  '   source: website | homepage, no date',
].join('\n')

/** What the writer is shown: the evidence, plus a counter-reading and a relevance line. */
const WRITER_BLOCK = [
  EVIDENCE,
  '   counter-reading (inference): the firm has run on the same two depots for 31 years and has no reason to change.',
  '',
  'Why this material was judged relevant: a 31-year-old operator with no visible outbound.',
].join('\n')

const gates = (opening: string, writerBlock = WRITER_BLOCK) =>
  checkOpeningGates(opening, null, EVIDENCE, undefined, undefined, undefined, writerBlock)

const traceability = (opening: string, writerBlock = WRITER_BLOCK) =>
  gates(opening, writerBlock).filter(f => f.startsWith('claims not traceable'))

const questionMarks = (opening: string) =>
  gates(opening).filter(f => f.includes('question marks'))

describe('a possessive of a name that IS in the findings', () => {
  it('passes on a plural possessive, which is the form that failed', () => {
    expect(traceability("Bramwell Logistics' next customer conversation waits for the quiet week.")).toEqual([])
  })

  it('passes on a singular possessive, which already worked and must keep working', () => {
    expect(traceability("Bramwell's next customer conversation waits for the quiet week.")).toEqual([])
  })

  it('passes on the curly apostrophe, because the writer produces both', () => {
    expect(traceability('Bramwell Logistics’ next customer conversation waits for the quiet week.')).toEqual([])
  })

  // THE OTHER DIRECTION. Stripping the possessive must not turn an invented name traceable.
  it('STILL FAILS on an invented company name', () => {
    const failures = traceability('The next conversation at Caldermoor Freight waits for the quiet week.')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('Caldermoor')
  })

  it('STILL FAILS on an invented company name in the possessive', () => {
    // NAMED BY ITS SECOND TOKEN, not its first, and that is PRE-EXISTING behaviour rather
    // than anything the possessive fix changed: untraceableClaims exempts the first word of
    // every sentence, because a capital there is convention and not evidence. The invented
    // name is still rejected, which is what this control is for. checkSentenceInitialNames
    // is the gate that covers the exempt position and it is report-only today.
    const failures = traceability("Caldermoor Freight's next conversation waits for the quiet week.")
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('Freight')
  })
})

describe('a number the writer was shown', () => {
  it('passes when the figure is in the block the writer read', () => {
    expect(traceability('Operators running two depots for 31 years rarely need a new customer until they do.')).toEqual([])
  })

  // THE OTHER DIRECTION, and the important half: widening the haystack must not accept
  // a figure that appears in NEITHER text.
  it('STILL FAILS on an invented figure', () => {
    const failures = traceability('Operators running two depots for 47 years rarely need a new customer until they do.')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('47')
  })

  it('STILL FAILS on an invented figure even with no writer block supplied at all', () => {
    const failures = traceability('Operators running for 47 years rarely need a new customer.', '')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('47')
  })

  it('omitting the writer block restores the old narrow behaviour, so the widening is opt-in', () => {
    // 31 is in the writer's block and NOT in the evidence corpus, so without the block it fails.
    const failures = traceability('Operators running for 31 years rarely need a new customer.', '')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('31')
  })

  it('does not widen NAMES, which is the concern recorded above buildFindingsBlock', () => {
    // "Nothing" appears only in the counter-reading prose, never in the evidence corpus.
    const withCounterOnlyName = [EVIDENCE, '   counter-reading (inference): Halvorsen sees no reason to change.'].join('\n')
    const failures = traceability('The next conversation at Halvorsen waits for the quiet week.', withCounterOnlyName)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('Halvorsen')
  })
})

describe('a question mark inside a quotation', () => {
  it('does not count toward the one-question limit', () => {
    const opening = 'Your site\'s only ask is a referral button. "do you know someone who needs us?" '
      + 'The next customer waits in someone\'s address book. Is that where the next one is sitting?'
    expect(questionMarks(opening)).toEqual([])
  })

  it('does not count inside curly quotes either', () => {
    const opening = 'Your site’s only ask is a button. “do you know someone who needs us?” '
      + 'The next customer waits. Is that where the next one is sitting?'
    expect(questionMarks(opening)).toEqual([])
  })

  // THE OTHER DIRECTION. A real second question must still fail.
  it('STILL FAILS on a genuine second question outside any quotation', () => {
    const opening = 'Is your site\'s only ask a referral button? The next customer waits. '
      + 'Is that where the next one is sitting?'
    const failures = questionMarks(opening)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('2 question marks')
  })

  it('STILL FAILS when a genuine second question sits alongside a quoted one', () => {
    const opening = 'Your page asks "do you know someone who needs us?" but is that the only ask? '
      + 'The next customer waits. Is that where the next one is sitting?'
    const failures = questionMarks(opening)
    expect(failures).toHaveLength(1)
  })

  it('STILL FAILS on an unbalanced quote, because an unresolved span keeps counting', () => {
    const opening = 'Your page asks "do you know someone who needs us? The next customer waits. '
      + 'Is that where the next one is sitting?'
    expect(questionMarks(opening)).toHaveLength(1)
  })
})

describe('stripQuotedSpans, the helper the question count depends on', () => {
  it('removes a balanced double-quoted span', () => {
    expect(stripQuotedSpans('He asked "are you sure?" today')).not.toContain('?')
  })

  it('leaves an apostrophe in a contraction alone', () => {
    expect(stripQuotedSpans("It isn't a quote, and it shouldn't be treated as one")).toContain("isn't")
  })

  it('leaves an unbalanced quote alone', () => {
    expect(stripQuotedSpans('He asked "are you sure? and left')).toContain('?')
  })
})
