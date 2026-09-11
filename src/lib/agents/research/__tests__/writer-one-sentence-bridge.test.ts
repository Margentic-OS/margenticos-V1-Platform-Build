// THE BRIDGE IS ONE SENTENCE, ENFORCED IN CODE. Added 2026-09-11.
//
// Three things have to stay true together, and each gets a test that fails on its own:
//   1. the counter counts what a reader would call a sentence, semicolons and colons
//      included, and does not split on a time, a decimal or an abbreviation;
//   2. the gate rejects a bridge of more than one sentence, on the bridge part ALONE;
//   3. the prompt agrees with the gate: every endorsed bridge it shows is one sentence.
//      Read from the prompt at runtime, so an edit that brings back a two-sentence model
//      fails here rather than teaching the writer to fail the gate.

import { describe, it, expect } from 'vitest'
import { countSentences } from '@/lib/style/sentence-count'
import { checkOpeningGates, buildWriterPrompt } from '../write-opening'
import { shapeModels, concreteRewrites, plainRewrites, printShopBridge } from './writer-prompt-specimens'

describe('countSentences', () => {
  it('counts full stops, question marks and exclamation marks as breaks', () => {
    expect(countSentences('One thing happens.')).toBe(1)
    expect(countSentences('One thing happens. Another follows.')).toBe(2)
    expect(countSentences('It happens! Does it?')).toBe(2)
  })

  it('counts a semicolon and a colon as breaks, which is the evasion they would otherwise allow', () => {
    expect(countSentences('Crews stay on site; the tender waits.')).toBe(2)
    expect(countSentences('The tender waits: nobody has priced it.')).toBe(2)
  })

  it('does not split on a time, a decimal or a common abbreviation', () => {
    expect(countSentences('Priced at 9:30 on day 2.5 of the build.')).toBe(1)
    expect(countSentences('Owners, e.g. those with one site, wait.')).toBe(1)
  })

  it('counts a break after a closing quote, and ignores empty input', () => {
    expect(countSentences('They said "not yet." Then the week filled.')).toBe(2)
    expect(countSentences('')).toBe(0)
    expect(countSentences('No full stop at all')).toBe(1)
  })
})

describe('the bridge gate', () => {
  const observation = 'You added a second large-format press in March.'
  const question = 'Is filling that press something you are working on?'
  const bridgeFailures = (bridge: string, obs = observation) =>
    checkOpeningGates(
      `${obs}\n\n${bridge} ${question}`, null, `${obs} ${bridge}`, undefined,
      { observation: obs, bridge, question }, { prospectId: 'one-sentence-test' },
    ).filter(f => f.includes('must be ONE'))

  it('passes a one-sentence bridge', () => {
    expect(bridgeFailures('Your second press needs work from customers you have not quoted yet.')).toEqual([])
  })

  it('rejects a two-sentence bridge and says how many sentences it found', () => {
    const f = bridgeFailures('Your first press is full. Your second press needs new work.')
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('the bridge is 2 sentences')
  })

  it('rejects a semicolon and a colon join', () => {
    expect(bridgeFailures('Your first press is full; your second press needs new work.')).toHaveLength(1)
    expect(bridgeFailures('Your second press needs one thing: new work.')).toHaveLength(1)
  })

  it('reads the bridge part alone, so a three-sentence observation does not trip it', () => {
    const longObservation = 'You added a press in March. It is large-format. It runs two shifts.'
    expect(bridgeFailures('Your second press needs work from customers you have not quoted yet.', longObservation)).toEqual([])
  })
})

describe('the prompt agrees with the gate', () => {
  it('every shape model is one sentence', () => {
    const models = shapeModels()
    expect(models).toHaveLength(4)
    for (const m of models) expect(countSentences(m), m).toBe(1)
  })

  it('every endorsed rewrite read by the stale-copy helpers is one sentence', () => {
    const endorsed = [...concreteRewrites(), ...plainRewrites(), printShopBridge()]
    expect(endorsed).toHaveLength(5)
    for (const e of endorsed) expect(countSentences(e), e).toBe(1)
  })

  it('states the rule where the writer reads it, and asks for one sentence in the output', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('ONE PLAIN SENTENCE BEATS ONE CONDITIONAL')
    expect(flat).toContain('The bridge is exactly one of them')
    expect(flat).toContain('BRIDGE: <the pattern, in one sentence, its own paragraph>')
    expect(flat).not.toContain('TWO SHORT SENTENCES BEAT ONE CONDITIONAL')
  })
})
