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
import {
  checkOpeningGates, buildWriterPrompt, OBSERVATION_MAX_WORDS, OBSERVATION_CAP_MARKER,
  WRITER_MAX_SENTENCE_WORDS, isSentenceLengthOnly,
} from '../write-opening'
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

  // NARROWED 2026-09-24, then narrowed again the same day. The claim is still that the
  // BRIDGE gate reads the bridge alone. For one afternoon the observation had a
  // one-sentence gate of its own and this test asserted that gate fired; that gate is gone,
  // replaced by OBSERVATION_MAX_WORDS, so a three-sentence observation inside the word
  // limit is now correct copy and NOTHING should fire on it.
  it('reads the bridge part alone, so a three-sentence observation does not trip the BRIDGE gate', () => {
    const longObservation = 'You added a press in March. It is large-format. It runs two shifts.'
    const failures = bridgeFailures('Your second press needs work from customers you have not quoted yet.', longObservation)
    expect(failures.filter(f => f.includes('the bridge is'))).toEqual([])
  })

  it('and a three-sentence observation inside the word limit is accepted outright', () => {
    // 14 words across three sentences. Under the rule this replaced it was rejected, and the
    // only remedy offered was a join that the sentence-length gate then rejected.
    const longObservation = 'You added a press in March. It is large-format. It runs two shifts.'
    const bridge = 'Your second press needs work from customers you have not quoted yet.'
    const all = checkOpeningGates(
      `${longObservation}\n\n${bridge} ${question}`, null, `${longObservation} ${bridge}`, undefined,
      { observation: longObservation, bridge, question }, { prospectId: 'observation-word-cap' },
    )
    expect(longObservation.split(/\s+/).length).toBeLessThanOrEqual(OBSERVATION_MAX_WORDS)
    expect(countSentences(longObservation)).toBe(3)
    expect(all).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE OBSERVATION'S TOTAL WORD LIMIT, which replaced the one-sentence rule on 2026-09-24.
//
// THE POINT OF THE CHANGE IS THAT A LEGAL MOVE EXISTS. The old pair of rules had none: over
// 18 words in one sentence failed for length, and the split the length message asked for
// failed for count. Each test below names the half it protects.
describe('the observation word cap', () => {
  const bridge = 'Your second press needs work from customers you have not quoted yet.'
  const question = 'Is filling that press something you are working on?'
  const gatesFor = (observation: string) => checkOpeningGates(
    `${observation}

${bridge} ${question}`, null, `${observation} ${bridge}`, undefined,
    { observation, bridge, question }, { prospectId: 'observation-word-cap' },
  )
  // Built to a count rather than written out, so the boundary cannot drift when someone
  // edits the prose. Two sentences, because that is the shape the old rule forbade.
  const observationOf = (n: number) => {
    const first = ['You', 'added', 'a', 'press', 'in', 'March.']
    const rest = Array.from({ length: n - first.length }, (_, i) => (i === 0 ? 'It' : 'runs'))
    return [...first, ...rest].join(' ') + '.'
  }

  it('accepts an observation at exactly the cap', () => {
    const at = observationOf(OBSERVATION_MAX_WORDS)
    expect(at.trim().split(/\s+/)).toHaveLength(OBSERVATION_MAX_WORDS)
    expect(gatesFor(at).filter(f => f.includes(OBSERVATION_CAP_MARKER))).toEqual([])
  })

  it('rejects one word over the cap, and says the count and the cap', () => {
    const over = Array.from({ length: OBSERVATION_MAX_WORDS + 1 }, (_, i) => (i === 0 ? 'Word' : 'word')).join(' ') + '.'
    const f = gatesFor(over).filter(x => x.includes(OBSERVATION_CAP_MARKER))
    expect(f).toHaveLength(1)
    expect(f[0]).toContain(`the observation is ${OBSERVATION_MAX_WORDS + 1} words`)
    expect(f[0]).toContain(String(OBSERVATION_MAX_WORDS))
  })

  it('does not reject on sentence count at any number of sentences inside the cap', () => {
    // THE HALF THAT COST FOUR PROSPECTS. A two-sentence observation is now ordinary copy.
    const two = 'You added a press in March. It runs two shifts.'
    expect(countSentences(two)).toBe(2)
    expect(gatesFor(two)).toEqual([])
  })

  it('counts the words raw, including a quoted title', () => {
    // Deliberately unlike the SENTENCE count, which exempts a verbatim quote because its
    // punctuation is a counting artefact. Its words are not: they occupy the email.
    const title = Array.from({ length: OBSERVATION_MAX_WORDS }, () => 'title').join(' ')
    const quoted = `You published "${title}" in March.`
    expect(quoted.trim().split(/\s+/).length).toBeGreaterThan(OBSERVATION_MAX_WORDS)
    expect(gatesFor(quoted).some(f => f.includes(OBSERVATION_CAP_MARKER))).toBe(true)
  })

  it('the marker is in the gate the writer emits, so the extra attempt still matches', () => {
    // A control on the control, matching the one in extra-attempt-sentence-length.test.ts.
    const over = Array.from({ length: OBSERVATION_MAX_WORDS + 1 }, (_, i) => (i === 0 ? 'Word' : 'word')).join(' ') + '.'
    const f = gatesFor(over).filter(x => x.includes(OBSERVATION_CAP_MARKER))
    expect(isSentenceLengthOnly(f)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE FIVE SHAPES THE OLD RULE REJECTED, AS SYNTHETIC EQUIVALENTS.
//
// RULE ZERO. The five real observations that motivated this change carry real prospect and
// company names and must never enter this repository. What transfers is the SHAPE and the
// WORD COUNT, and both are reproduced here in industry-neutral copy. The real five are
// checked in a gitignored script and the result was 4 pass, 1 fails.
//
// THE FIFTH MUST STILL FAIL, and on the gate it always should have failed on. A control
// that only proves things now pass would be satisfied by deleting every gate.
describe('the shapes the one-sentence rule rejected', () => {
  const bridge = 'Firms at that point usually find the next month of work is the part nobody owns.'
  const question = 'Is that something you are working on?'
  const gatesFor = (observation: string) => checkOpeningGates(
    `${observation}\n\n${bridge} ${question}`, null, `${observation} ${bridge}`, undefined,
    { observation, bridge, question }, { prospectId: 'five-shapes' },
  )
  const wordsOf = (t: string) => t.trim().split(/\s+/).filter(Boolean).length

  // Two sentences, second sentence a SECOND FACT: the supporting event the assignment block
  // explicitly offers the writer. The old rule rejected the one construction it asked for.
  const secondFact = 'You posted for a site manager on 13 August. Two days earlier the group was listed in a national index.'

  // Two sentences, second sentence the DATE OF THE SAME EVENT. Nothing added, just split.
  const sameEventSplit = 'You shared the announcement that the operations lead and the finance lead were promoted last month. That post went up on 27 August.'

  // Two sentences and a currency amount and a count read off the record. Over the word cap
  // AND banned outright, which is the point: it fails for the reason it always did.
  const firmographic = 'You posted a summary in June showing one location grew monthly takings to $426K. The same summary cut recorded visits from 7,348 to 6,019 over the same period.'

  it('accepts a two-sentence observation naming a second fact', () => {
    expect(countSentences(secondFact)).toBe(2)
    expect(wordsOf(secondFact)).toBeLessThanOrEqual(OBSERVATION_MAX_WORDS)
    expect(gatesFor(secondFact)).toEqual([])
  })

  it('accepts a two-sentence observation that only split the same event', () => {
    expect(countSentences(sameEventSplit)).toBe(2)
    expect(wordsOf(sameEventSplit)).toBeLessThanOrEqual(OBSERVATION_MAX_WORDS)
    expect(gatesFor(sameEventSplit)).toEqual([])
  })

  it('STILL REJECTS the one carrying figures off the record, on the firmographic gate', () => {
    const failures = gatesFor(firmographic)
    expect(wordsOf(firmographic)).toBeGreaterThan(OBSERVATION_MAX_WORDS)
    // Named separately, because the word cap alone would make this test pass even if the
    // firmographic gate were deleted, and that gate is the one that matters here.
    expect(failures.some(f => f.includes('currency amount'))).toBe(true)
    expect(failures.some(f => f.includes(OBSERVATION_CAP_MARKER))).toBe(true)
  })

  it('and the firmographic rejection does not depend on the length', () => {
    // MUTATION-PROOF IN A TEST. Shorten the same copy under the cap and the firmographic
    // gate must still fire on its own, or the assertion above was really about length.
    const short = 'You posted a summary in June showing monthly takings of $426K.'
    expect(wordsOf(short)).toBeLessThanOrEqual(OBSERVATION_MAX_WORDS)
    const failures = gatesFor(short)
    expect(failures.some(f => f.includes('currency amount'))).toBe(true)
    expect(failures.some(f => f.includes(OBSERVATION_CAP_MARKER))).toBe(false)
  })
})

describe('the sentence-length remedy is part-aware', () => {
  // ONE MESSAGE FOR BOTH PARTS TOLD THE BRIDGE TO DO SOMETHING THE BRIDGE GATE REJECTS.
  // The observation may split; the bridge is one sentence and must shorten instead.
  const question = 'Is filling that press something you are working on?'
  const long = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? 'Word' : 'word')).join(' ') + '.'
  const gatesFor = (observation: string, bridge: string) => checkOpeningGates(
    `${observation}

${bridge} ${question}`, null, `${observation} ${bridge}`, undefined,
    { observation, bridge, question }, { prospectId: 'part-aware-remedy' },
  )

  it('tells the OBSERVATION to split', () => {
    const f = gatesFor(long(WRITER_MAX_SENTENCE_WORDS + 1), 'A short bridge sentence.')
      .filter(x => x.includes('the observation has a sentence of'))
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('split it into two shorter sentences')
  })

  it('tells the BRIDGE to shorten, and never to split', () => {
    const f = gatesFor('You added a press in March.', long(WRITER_MAX_SENTENCE_WORDS + 1))
      .filter(x => x.includes('the bridge has a sentence of'))
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('The bridge stays ONE sentence')
    expect(f[0]).not.toContain('split')
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
