// The SCRATCH block: the writer's working, and the guarantee that it never reaches an email.
//
// It exists because the writer had nowhere to put its deliberation and so sometimes put it
// in the bridge. Measured on the 33-prospect run of 2026-09-14: three attempts came back
// with bridges of 508, 493 and 235 words against a 22-word target. The gates caught all
// three, so nothing shipped, but each one burned an attempt out of the two or three a
// prospect gets.
//
// The prose below is SYNTHETIC, deliberately. The real dumps name real prospects and this
// repository is public. What is reproduced here is the SHAPE: a writer narrating its own
// deliberation, at length, in a field that takes one sentence.

import { describe, it, expect } from 'vitest'
import {
  parseWriterOutput,
  checkOpeningGates,
  joinOpening,
  buildWriterPrompt,
  OPENING_MAX_WORDS,
} from '../write-opening'

const FINDINGS =
  'Finding 1: The firm partnered with an external talent marketplace this year. ' +
  'Finding 2: The partner network is their main source of work.'

/** The production call shape, from produceOpening. */
function gatesFor(raw: string) {
  const p = parseWriterOutput(raw)
  const opening = joinOpening(p.observation, p.bridge)
  const gates = checkOpeningGates(
    `${opening} ${p.question}`.trim(), 'David', FINDINGS, undefined,
    { observation: p.observation, bridge: p.bridge, question: p.question },
    { prospectId: 'test' }, FINDINGS,
  )
  if (!p.question) gates.push('writer returned no closing question')
  if (!p.observation) gates.push('writer returned no observation')
  if (!p.bridge) gates.push('writer returned no bridge')
  return { parsed: p, gates }
}

/** A writer narrating its deliberation instead of writing. The shape of a real dump. */
const DELIBERATION = [
  'Looking at these findings carefully before writing.',
  'The offer line generates new qualified meetings.',
  'So the bridge must not land on converting people they already know.',
  'The counter-readings are strong throughout.',
  'The partnership is plausibly the pipeline mechanism.',
  'Flat headcount is plausibly a choice.',
  'I cannot assert pipeline stress, and I cannot assert their model is failing.',
  'Finding 1 is the one thing I can observe without asserting an absence.',
  'Let me test the ending against the camera test.',
  'No, that asserts a verdict. Let me fix the ending.',
].join(' ').repeat(5)

const GOOD_EMAIL =
  'OBSERVATION: The firm partnered with a talent marketplace this year.\n' +
  'BRIDGE: That channel brings in work the partner network never reached.\n' +
  'QUESTION: Worth a look at what it would take to run that alongside?\n' +
  'SUBJECT: the marketplace route'

describe('SCRATCH block', () => {
  it('POSITIVE CONTROL: deliberation in the BRIDGE field is rejected', () => {
    const { parsed, gates } = gatesFor(
      `OBSERVATION: Looking at these findings carefully before writing:\n` +
      `BRIDGE: ${DELIBERATION}\nQUESTION: \nSUBJECT: `,
    )
    // The instrument can see it: the dump really did land in the bridge.
    expect(parsed.bridge.split(/\s+/).length).toBeGreaterThan(OPENING_MAX_WORDS * 3)
    expect(gates.length).toBeGreaterThan(0)
    expect(gates.some(g => g.includes('hard cap'))).toBe(true)
    expect(gates.some(g => g.includes('must be ONE'))).toBe(true)
  })

  it('the same deliberation in SCRATCH is discarded, and the email passes', () => {
    const { parsed, gates } = gatesFor(`SCRATCH: ${DELIBERATION}\n${GOOD_EMAIL}`)
    expect(gates).toEqual([])
    expect(parsed.bridge).toBe('That channel brings in work the partner network never reached.')
    // Not in any returned field, and there is no field it could be returned in.
    for (const v of [parsed.observation, parsed.bridge, parsed.question, parsed.subject, parsed.opening]) {
      expect(v).not.toContain('counter-readings')
      expect(v).not.toContain('SCRATCH')
    }
    // No field carries it, so no caller can store, compose or send it.
    expect(Object.keys(parsed).sort()).toEqual(['bridge', 'observation', 'opening', 'question', 'subject'])
  })

  it('an output with no SCRATCH block parses exactly as before', () => {
    expect(parseWriterOutput(GOOD_EMAIL)).toEqual(parseWriterOutput(`SCRATCH: ${DELIBERATION}\n${GOOD_EMAIL}`))
  })

  it('a SCRATCH block that writes "BRIDGE:" mid-thought does not supply the bridge', () => {
    const { parsed } = gatesFor(
      `SCRATCH: I considered it. BRIDGE: maybe the board seats?\nNo, that asserts a verdict.\n${GOOD_EMAIL}`,
    )
    expect(parsed.bridge).toBe('That channel brings in work the partner network never reached.')
  })

  it('a reply that is all SCRATCH and no email is rejected, and the strip declines to act', () => {
    // The strip requires the OBSERVATION anchor and does nothing without it, deliberately:
    // stripping to end of string would destroy a valid email whose labels arrived in a
    // shape the anchor did not match. So this text survives parsing, and the GATES are
    // what reject it, exactly as they did before the block existed.
    const { gates } = gatesFor(`SCRATCH: ${DELIBERATION}`)
    expect(gates.length).toBeGreaterThan(0)
    expect(gates.some(g => g.includes('hard cap'))).toBe(true)
    expect(gates).toContain('writer returned no closing question')
  })

  it('the strip never removes an email: no OBSERVATION anchor, no strip', () => {
    // The fail-dangerous version of this ended `|$)` and stripped to end of string. On the
    // first run of the 33 that is not what broke, but it is the shape that would have
    // turned any unrecognised label format into a silently empty email.
    const odd = `SCRATCH: thinking\n**OBSERVATION:** the firm partnered with a marketplace.`
    expect(parseWriterOutput(odd).observation).not.toBe('')
  })

  it('the prompt tells the writer the block exists and that it is discarded', () => {
    // Guards the prompt/parser pair: a label here that the parser does not strip would put
    // the working straight into the email.
    const prompt = buildWriterPrompt()
    expect(prompt).toContain('SCRATCH:')
    expect(prompt).toContain('five labelled blocks')
    expect(prompt).not.toContain('four labelled blocks')
  })
})
