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

  // ─── NAMES, added 2026-09-24 after eight prospects lost their email to this counter ───
  //
  // MEASURED. Eight of nineteen were rejected by the one-sentence observation gate on EVERY
  // attempt. The first inspected was "You shared the news that Brittney Nichols and
  // Katherine O. Brien were promoted", counted as TWO. The copy was one sentence; the
  // counter was wrong, and the gate was reporting a fault that did not exist.
  //
  // It surfaced now because the observation is where people and companies are named, and it
  // had been latent in the BRIDGE gate, which has used this counter for longer.
  it('does not split on a personal initial', () => {
    expect(countSentences('You shared the news that Katherine O. Brien was promoted.')).toBe(1)
    expect(countSentences('You spoke on a panel with J. R. Smith in August.')).toBe(1)
  })

  it('does not split on a company suffix', () => {
    expect(countSentences('Acme Inc. announced a new office in Leeds.')).toBe(1)
    expect(countSentences('They joined the Puzzle Co. partner network in July.')).toBe(1)
  })

  it('STILL counts a real second sentence that begins with a capital', () => {
    // POSITIVE CONTROL. The initial rule protects a capital before a full stop; it must not
    // protect the capital AFTER one, or every two-sentence observation would read as one and
    // the gate would stop rejecting anything.
    expect(countSentences('You added a press in March. It runs two shifts.')).toBe(2)
    expect(countSentences('Acme Inc. opened in Leeds. The second site follows.')).toBe(2)
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

  // NARROWED 2026-09-24. The claim is still that the BRIDGE gate reads the bridge alone, and
  // that is what it now asserts. It used to assert no failures AT ALL from a long
  // observation, which stopped being true when the observation got a one-sentence gate of
  // its own: the failure it now sees belongs to the observation, not to the bridge.
  it('reads the bridge part alone, so a three-sentence observation does not trip the BRIDGE gate', () => {
    const longObservation = 'You added a press in March. It is large-format. It runs two shifts.'
    const failures = bridgeFailures('Your second press needs work from customers you have not quoted yet.', longObservation)
    expect(failures.filter(f => f.includes('the bridge is'))).toEqual([])
  })

  it('and the OBSERVATION gate does see it, which is the other half of the same claim', () => {
    const longObservation = 'You added a press in March. It is large-format. It runs two shifts.'
    const failures = bridgeFailures('Your second press needs work from customers you have not quoted yet.', longObservation)
    expect(failures.some(f => f.includes('the observation is 3 sentences'))).toBe(true)
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
    expect(flat).toContain('The bridge is ONE sentence stating what follows')
    expect(flat).toContain('The bridge is exactly one of them')
    expect(flat).toContain('BRIDGE: <the pattern, in one sentence, its own paragraph>')
    expect(flat).not.toContain('TWO SHORT SENTENCES BEAT ONE CONDITIONAL')
  })
})
