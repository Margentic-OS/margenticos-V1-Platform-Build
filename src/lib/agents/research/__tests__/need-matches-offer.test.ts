// CONTROLS FOR "THE NEED MUST MATCH THE OFFER".
//
// Everything here is the CODE HALF: the corpus, the parser and the citation check. The model
// call is not exercised, deliberately. Its only job is to produce a verdict, and every way a
// verdict can be wrong is checked below against a document the test owns.
//
// THE ONE THAT MATTERS MOST is "a real sentence from the wrong line". A verifier quoting
// something genuinely present in the positioning document, but not on the line it cited, is
// the shape scripts/derive-trigger-reasons.ts cannot see, because it searches the whole
// document. Measured reason it matters: 23% of the live positioning document describes
// COMPETITORS AND ALTERNATIVES, so a quote can be entirely real and describe work the client
// does not do.
//
// NO REAL CLIENT, PROSPECT OR VENDOR APPEARS. The document below is invented and the service
// it describes is deliberately nobody's.

import { describe, it, expect } from 'vitest'
import {
  flattenPositioningText,
  positioningLines,
  buildPositioningCorpus,
} from '../positioning-text'
import {
  buildNeedMatchPrompt,
  parseNeedMatchResponse,
  checkNeedCitations,
  MIN_QUOTE_CHARS,
  type CheckedNeed,
} from '../need-matches-offer'

// An invented positioning document with the shape the real ones have: nine top-level keys,
// a mix of strings, objects and arrays, and a section describing ALTERNATIVES, which is the
// section a citation must never be credited for.
const DOC = {
  positioning_summary: 'We find and contact people who have never dealt with the client before.',
  key_messages: {
    cold_outreach_hook: 'Reaching strangers is slow work and it stops when everyone is busy.',
  },
  value_themes: [
    { theme: 'A steady flow of first conversations with people outside the existing network.' },
    { theme: 'The work carries on while the team is delivering.' },
  ],
  competitive_alternatives: [
    { alternative: 'An in-house hire who also re-engages the audience the company already has.' },
  ],
  headcount: 4,
  active: true,
  nothing: null,
}

const TEXT = flattenPositioningText(DOC)

// THE DEFAULT IS A CITATION THAT HOLDS, so every test below breaks exactly one thing and the
// failure it asserts is the thing it broke. A default that already failed would let a test
// pass for a reason it is not about.
const need = (over: Partial<CheckedNeed>): CheckedNeed => ({
  id: 1, need: 'a need', line: 3, quote: 'A steady flow of first conversations', why: '', ...over,
})

/** The labels the EMAIL callers use. The follow-up writer routes on these exact strings. */
const emailLabel = (id: number) => (id === 1 ? 'Email 1' : `email ${id}`)
const check = (needs: CheckedNeed[], text = TEXT) => checkNeedCitations(needs, text, emailLabel)

describe('positioning-text', () => {
  it('labels every string leaf with its path and drops everything that is not a string', () => {
    expect(TEXT).toContain('positioning_summary: We find and contact people')
    expect(TEXT).toContain('key_messages.cold_outreach_hook: Reaching strangers')
    expect(TEXT).toContain('value_themes[0].theme: A steady flow')
    expect(TEXT).toContain('value_themes[1].theme: The work carries on')
    // The path is what makes an alternatives line recognisable as one.
    expect(TEXT).toContain('competitive_alternatives[0].alternative: An in-house hire')
    // Numbers, booleans and null carry no prose and are not quotable.
    expect(TEXT).not.toContain('headcount')
    expect(TEXT).not.toContain('active')
    expect(TEXT).not.toContain('nothing')
  })

  it('collapses a newline inside a leaf, so one leaf is always one line', () => {
    const text = flattenPositioningText({ a: 'first half\nsecond half\n\nthird' })
    expect(text.split('\n')).toHaveLength(1)
    expect(text).toBe('a: first half second half third')
  })

  it('reads the lines back without their labels', () => {
    const lines = positioningLines(TEXT)
    expect(lines).toHaveLength(5)
    expect(lines[0].path).toBe('positioning_summary')
    expect(lines[0].text).toBe(DOC.positioning_summary)
    // The label is for the reader and for the model. A citation is checked against the TEXT,
    // so quoting the path must never count as quoting the sentence.
    expect(lines[0].text).not.toContain('positioning_summary')
  })

  it('keeps the tail of a leaf that itself contains a colon and a space', () => {
    const lines = positioningLines(flattenPositioningText({ a: 'one thing: and another' }))
    expect(lines[0].path).toBe('a')
    expect(lines[0].text).toBe('one thing: and another')
  })

  it('numbers the corpus from 1', () => {
    const corpus = buildPositioningCorpus(TEXT)
    expect(corpus.startsWith('1. [positioning_summary] ')).toBe(true)
    expect(corpus).toContain('5. [competitive_alternatives[0].alternative] ')
  })
})

describe('buildNeedMatchPrompt', () => {
  it('carries the numbered corpus and an output example using an email number that parses', () => {
    const prompt = buildNeedMatchPrompt({ shown: '2 emails', exampleId: 2, positioningText: TEXT })
    expect(prompt).toContain(buildPositioningCorpus(TEXT))
    expect(prompt).toContain('"id":2')
    // The model returns a citation and NO verdict. A schema carrying a boolean is a second
    // verdict able to disagree with the citation, which is what this change removed.
    expect(prompt).not.toContain('"supported"')
    expect(prompt).toContain('YOU RETURN A CITATION, NOT A VERDICT')
    // THE REASONING FIELD COMES FIRST, and that ordering is load-bearing. With `line` ahead
    // of `why` the model committed to a null line and then reasoned its way to a citation in
    // the prose it emitted afterwards, ending one reply "Citing line 6." with line null.
    expect(prompt.indexOf('"why"')).toBeLessThan(prompt.indexOf('"line"'))
    expect(prompt).toContain('WRITE THE FIELDS IN THAT ORDER')
    // The instruction the code half actually enforces, so a reader of the prompt is not
    // surprised by a rejection. See checkNeedCitations.
    expect(prompt).toContain('THE LINE NUMBER IS CHECKED IN CODE')
    // An example email number the parser would discard would make every verdict vanish
    // silently, which is the one failure a prompt test can catch cheaply.
    expect(parseNeedMatchResponse('{"needs":[{"id":2,"need":"n","line":1,"quote":"q","why":""}]}', [2]))
      .toHaveLength(1)
  })

  it('is Rule Zero clean: two clients differ by their own document and by nothing else', () => {
    // The same comparison synthesis-prompt-choosing.test.ts makes. "Nothing client-specific
    // in the shared prompt" means exactly this: swap one client's document for another's and
    // the two prompts become identical.
    // The two documents differ by ONE TOKEN on purpose. Any other difference would make the
    // final comparison pass for the wrong reason, or fail for a reason that is the fixture's
    // rather than the prompt's.
    const alpha = flattenPositioningText({ summary: 'ALPHA_POSITIONING_TEXT is what this client does.' })
    const beta = flattenPositioningText({ summary: 'BETA_POSITIONING_TEXT is what this client does.' })
    const opts = { shown: 'one email', exampleId: 1 }
    const a = buildNeedMatchPrompt({ ...opts, positioningText: alpha })
    const b = buildNeedMatchPrompt({ ...opts, positioningText: beta })

    expect(a).toContain('ALPHA_POSITIONING_TEXT')
    expect(b).toContain('BETA_POSITIONING_TEXT')
    expect(a).not.toContain('BETA_POSITIONING_TEXT')
    expect(a.replace('ALPHA_POSITIONING_TEXT', 'BETA_POSITIONING_TEXT')).toBe(b)
  })
})

describe('parseNeedMatchResponse', () => {
  it('reads a well-formed reply', () => {
    const [n] = parseNeedMatchResponse(
      'here you go {"needs":[{"id":1,"need":"more first conversations","line":3,"quote":"A steady flow","why":""}]} done',
      [1],
    )
    expect(n).toEqual({ id: 1, need: 'more first conversations', line: 3, quote: 'A steady flow', why: '' })
  })

  it('reads absent, malformed or wrong-shaped replies as "checked nothing" rather than throwing', () => {
    expect(parseNeedMatchResponse('', [1])).toEqual([])
    expect(parseNeedMatchResponse('no json here at all', [1])).toEqual([])
    expect(parseNeedMatchResponse('{"needs":[{"id":1,', [1])).toEqual([])
    expect(parseNeedMatchResponse('{"needs":"not an array"}', [1])).toEqual([])
    expect(parseNeedMatchResponse('{"needs":[null,"x",7]}', [1])).toEqual([])
  })

  it('drops a verdict for an email it was not asked about', () => {
    const raw = '{"needs":[{"id":1,"need":"a","line":1,"quote":"q","why":""},' +
                '{"id":9,"need":"b","line":1,"quote":"q","why":""}]}'
    expect(parseNeedMatchResponse(raw, [1]).map(n => n.id)).toEqual([1])
  })

  it('keeps a null line as null rather than as a number', () => {
    const [n] = parseNeedMatchResponse('{"needs":[{"id":1,"need":"a","line":null,"quote":"","why":"nothing"}]}', [1])
    expect(n.line).toBeNull()
    expect(n.why).toBe('nothing')
  })

  it('IGNORES a supported flag the model sends anyway, in both directions', () => {
    // The flag is out of the schema. Reading it back would quietly restore the second verdict
    // this change removed, and the shape that made it worth removing was a model that wrote
    // "so this is SUPPORTED" in its reasoning while the boolean beside it said otherwise.
    const cited = parseNeedMatchResponse(
      '{"needs":[{"id":1,"need":"a","line":3,"quote":"A steady flow of first conversations","supported":false,"why":"x"}]}', [1])
    expect(cited[0]).not.toHaveProperty('supported')
    expect(check(cited)).toEqual([])

    const uncited = parseNeedMatchResponse(
      '{"needs":[{"id":1,"need":"a","line":null,"quote":"","supported":true,"why":"x"}]}', [1])
    expect(check(uncited)).toHaveLength(1)
  })
})

describe('checkNeedCitations: the citation is the whole of the verdict', () => {
  it('passes a need cited to the line that really carries the quote', () => {
    expect(check([need({})])).toEqual([])
  })

  it('fails a need the verifier could not cite, and carries its reason', () => {
    const [f] = check([need({
      need: 'putting their own article in front of more people',
      line: null, quote: '',
      why: 'the document describes contacting new people, not distributing their content',
    })])
    expect(f).toContain('putting their own article in front of more people')
    expect(f).toContain('no line of the document was cited for it')
    expect(f).toContain('the document describes contacting new people')
    // The instruction travels with the fault, because the writer's retry feedback appends a
    // general sentence about the FACT-CHECK after whatever it is given.
    expect(f).toContain('Name a need this service does meet, or drop it.')
  })

  it('fails a real sentence cited to the wrong line', () => {
    // THE CASE THIS CHECK EXISTS FOR. The quote is genuinely in the document, on the
    // ALTERNATIVES line, and is offered as support under a different line number. A
    // whole-document search would return clean here.
    const [f] = check([need({
      need: 're-engaging the audience they already have',
      line: 1,
      quote: 'An in-house hire who also re-engages the audience',
    })])
    expect(f).toContain('does not contain the sentence quoted as support')
    expect(f).toContain('[positioning_summary]')
  })

  it('fails a citation to a line that does not exist, in both directions', () => {
    const count = positioningLines(TEXT).length
    for (const line of [0, -1, count + 1, 999]) {
      const [f] = check([need({ line })])
      expect(f, `line ${line}`).toContain('which does not exist')
      expect(f, `line ${line}`).toContain(`has ${count} lines`)
    }
  })

  it('fails a quote too short to be a sentence', () => {
    const short = 'A steady flow'
    expect(short.length).toBeLessThan(MIN_QUOTE_CHARS)
    const [f] = check([need({ quote: short })])
    expect(f).toContain('quotes nothing long enough to be a sentence')
  })

  it('accepts a quote that differs only in case, curly quotes, dashes or run of whitespace', () => {
    const text = flattenPositioningText({ a: 'We reach people the client has never spoken to \u2014 anywhere.' })
    expect(check([need({
      line: 1, quote: '  WE REACH people   the client has never spoken to - anywhere. ',
    })], text)).toEqual([])
  })

  it('returns nothing for an empty verdict, deliberately', () => {
    // An empty list is REPORTED and never gated. There is no code-side detector for "this
    // sentence names a need", so "the copy names none" and "the verifier went quiet" cannot
    // be told apart. See the header of need-matches-offer.ts.
    expect(check([])).toEqual([])
  })

  it('pre-approves no need, and no category of need, anywhere', () => {
    // The SAME need text passes or fails purely on whether a line can be cited for it. If any
    // need or category were hardcoded as acceptable, these two would not differ.
    const NEEDS = [
      'reaching people who have never heard of them',
      'converting the audience they already have',
      'putting their article in front of more people',
      'anything at all, in words nobody has used before',
    ]
    for (const text of NEEDS) {
      expect(check([need({ need: text })]), text).toEqual([])
      expect(check([need({ need: text, line: null, quote: '' })]), text).toHaveLength(1)
    }
  })

  it('takes its label from the CALLER, so a new caller cannot inherit the email wording', () => {
    // checkNeedCitations has no default label. write-followups.ts routes failures by matching
    // "email 2" and "email 3" in this exact string, so a caller that silently got the email
    // wording for a trigger reason would produce a failure routed to an email that does not
    // exist in its run.
    const [f] = checkNeedCitations([need({ id: 4, line: null, quote: '' })], TEXT, id => `trigger ${id}`)
    expect(f.startsWith('trigger 4 names the need')).toBe(true)
    expect(f).not.toContain('email')
  })

  it('names the email in every failure, so the follow-up writer can charge it to one email', () => {
    const two = check([need({ id: 2, line: null, quote: '' })])
    const three = check([need({ id: 3, line: null, quote: '' })])
    expect(/\bemail 2\b/.test(two[0])).toBe(true)
    expect(/\bemail 3\b/.test(two[0])).toBe(false)
    expect(/\bemail 3\b/.test(three[0])).toBe(true)
    expect(/\bemail 2\b/.test(three[0])).toBe(false)
    const one = check([need({ id: 1, line: null, quote: '' })])
    expect(one[0].startsWith('Email 1 names the need')).toBe(true)
  })

  it('reports every failing need, not just the first', () => {
    const failures = check([
      need({ need: 'one', line: null, quote: '' }),
      need({ need: 'two', line: 999 }),
      need({ need: 'three' }),
      need({ need: 'four', line: 1, quote: 'An in-house hire who also re-engages the audience' }),
    ])
    expect(failures).toHaveLength(3)
    expect(failures.some(f => f.includes('"one"'))).toBe(true)
    expect(failures.some(f => f.includes('"two"'))).toBe(true)
    expect(failures.some(f => f.includes('"three"'))).toBe(false)
    expect(failures.some(f => f.includes('"four"'))).toBe(true)
  })
})
