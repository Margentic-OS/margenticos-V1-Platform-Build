// A MONTH ABBREVIATION IS NOT AN INVENTED NAME (the operator, 2026-10-03: "'Sept'-style
// month abbreviations allowed").
//
// The names half of the traceability gate (untraceableNames in write-opening.ts) reads any
// capitalised word that is not sentence-initial as the name of a thing, and refuses it when
// the findings do not carry it. The full month names have been exempt since 2026-09-25; the
// abbreviations were not, so "in Sept" was refused as an invented name unless the findings
// happened to hold "September" (a substring match). The operator's earlier read said the
// opposite of a fault: full months everywhere read as robotic.
//
// Each case is a pair: the abbreviation must pass, and an invented name in the same
// sentence must still be refused, for its own reason. Every sentence here is invented.

import { describe, it, expect } from 'vitest'
import { checkOpeningGates, untraceableNames } from '../write-opening'

/** Findings that name no month at all, so nothing can clear an abbreviation by substring. */
const EVIDENCE = [
  '1. Bramwell Logistics opened a second depot and hired two engineers.',
  '   source: website | news page, no date',
].join('\n')

const traceability = (opening: string) =>
  checkOpeningGates(opening, null, EVIDENCE, undefined, undefined, undefined, EVIDENCE)
    .filter(failure => failure.startsWith('claims not traceable'))

const ABBREVIATIONS = ['Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec']

describe('month abbreviations in generated copy', () => {
  it.each(ABBREVIATIONS)('PLANTED: "%s" is not an untraceable name, with or without its full stop', month => {
    expect(untraceableNames(`Bramwell Logistics opened a second depot in ${month} and hired two engineers.`, EVIDENCE)).toEqual([])
    expect(untraceableNames(`Bramwell Logistics opened a second depot in ${month}. and hired two engineers.`, EVIDENCE)).toEqual([])
  })

  it('PLANTED: "Sept" passes the opening gate, where it was refused as a claim not traceable to any finding', () => {
    expect(traceability('Bramwell Logistics opened a second depot in Sept and hired two engineers.')).toEqual([])
  })

  it('STILL REFUSES an invented name beside it, for its own reason (control)', () => {
    const names = untraceableNames('Bramwell Logistics opened a second depot in Sept and hired Yomal Quorvex.', EVIDENCE)
    expect(names).toContain('Yomal')
    expect(names).toContain('Quorvex')
    expect(names).not.toContain('Sept')
    const failures = traceability('Bramwell Logistics opened a second depot in Sept with Quorvex.')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('Quorvex')
    expect(failures[0]).not.toContain('Sept')
  })

  it('a word that only looks like an abbreviation is still a name (control)', () => {
    // "Septa" and "Decca" start like a month and are not one.
    expect(untraceableNames('Bramwell Logistics opened a second depot with Septa and Decca.', EVIDENCE)).toEqual(['Septa', 'Decca'])
  })
})
