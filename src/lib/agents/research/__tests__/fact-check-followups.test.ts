// THE CODE HALF OF THE FACT-CHECK, which is the half that does not trust the model.
//
// A model asked to check itself agrees with itself, and a model asked to cite will cite
// something. So every assertion here is about what CODE derives from the verifier's output
// plus the corpus, never about the verdict it returned.
//
// Fixtures are industry-neutral.

import { describe, it, expect } from 'vitest'
import {
  countFindingLines, parseFactCheckResponse, checkCitations, buildFactCheckPrompt,
  findReaderArrangements,
} from '../fact-check-followups'

const CORPUS = [
  '1. The firm posted for a site manager on 13 August 2026.',
  '   source: linkedin | a public post',
  '2. The firm was listed in a national index on 11 August 2026.',
  '   source: web | an index page',
].join('\n')

const PROSE_2 = 'You posted for a site manager in August.\n\nThat is the month the next job has to be found.'
const PROSE_3 = 'The listing went up the same week.\n\nWorth a look?'

describe('countFindingLines', () => {
  it('counts the numbered lines, not the source lines', () => {
    expect(countFindingLines(CORPUS)).toBe(2)
  })

  it('returns zero for an unnumbered corpus, so a citation into it is fabricated', () => {
    // THE SHAPE THAT CAUGHT A TEST FIXTURE. An unnumbered corpus has no line 1, so every
    // citation is to a finding that does not exist, which is exactly right.
    expect(countFindingLines('They opened a second site in March.')).toBe(0)
  })
})

describe('parseFactCheckResponse', () => {
  it('reads the claims out of a reply with prose around the JSON', () => {
    const raw = 'Here is my check:\n{"claims":[{"email":2,"claim":"x","finding":1,"supported":true,"why":"y"}]}\nDone.'
    expect(parseFactCheckResponse(raw, [2, 3])).toEqual([
      { email: 2, claim: 'x', finding: 1, supported: true, why: 'y' },
    ])
  })

  it('returns NOTHING for a malformed or absent reply, which then fails the shortfall check', () => {
    // Deliberately not throwing: an unreadable verdict is "checked nothing", and the
    // shortfall check below turns that into a failure rather than a silent pass.
    expect(parseFactCheckResponse('no json here', [2, 3])).toEqual([])
    expect(parseFactCheckResponse('{"claims": not json}', [2, 3])).toEqual([])
  })

  it('drops a claim about an email that does not exist', () => {
    const raw = '{"claims":[{"email":1,"claim":"x","finding":1,"supported":true},{"email":2,"claim":"y","finding":1,"supported":true}]}'
    expect(parseFactCheckResponse(raw, [2, 3])).toHaveLength(1)
  })

  it('reads a null citation as null rather than as zero', () => {
    const raw = '{"claims":[{"email":2,"claim":"x","finding":null,"supported":false,"why":"nothing says so"}]}'
    expect(parseFactCheckResponse(raw, [2, 3])[0].finding).toBeNull()
  })
})

describe('checkCitations', () => {
  const clean = [
    { email: 2, claim: 'You posted for a site manager in August.', finding: 1, supported: true, why: 'finding 1' },
    { email: 3, claim: 'The listing went up the same week.', finding: 2, supported: true, why: 'finding 2' },
  ]

  it('passes a check whose citations all exist', () => {
    expect(checkCitations(clean, CORPUS, PROSE_2, PROSE_3)).toEqual([])
  })

  it('REJECTS a citation to a finding that does not exist', () => {
    // The model invents these. A claim resting on one is unsupported whatever it says.
    const invented = [{ ...clean[0], finding: 7 }]
    const f = checkCitations(invented, CORPUS, PROSE_2, PROSE_3)
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('does not exist')
    expect(f[0]).toContain('2 lines')
  })

  it('REJECTS a claim marked supported with no citation at all', () => {
    const uncited = [{ ...clean[0], finding: null }]
    expect(checkCitations(uncited, CORPUS, PROSE_2, PROSE_3)).toHaveLength(1)
  })

  it('reports a claim the verifier itself marked unsupported, quoting it', () => {
    const bad = [{ email: 2, claim: 'You brought on a new operations lead.', finding: null, supported: false, why: 'the finding says the post directed people to them' }]
    const f = checkCitations(bad, CORPUS, PROSE_2, PROSE_3)
    // TWO failures, and the second is correct rather than noise. PROSE_2 asserts "You posted
    // for a site manager in August", and this verifier returned a claim about something else
    // entirely, so that sentence was never checked. The coverage rule added 2026-09-25 says
    // so. The count is asserted exactly rather than relaxed to a `some`, so a third failure
    // appearing later is still a test change and not a silent drift.
    expect(f).toHaveLength(2)
    expect(f.some(x => x.includes('You brought on a new operations lead.') && x.includes('directed people to them'))).toBe(true)
    expect(f.some(x => x.includes('never returned as a claim') && x.includes('You posted for a site manager'))).toBe(true)
  })

  it('REJECTS AN EMPTY VERDICT, which is the failure mode that looks clean', () => {
    // A verifier that returns nothing has not checked anything. Without this, a malformed
    // reply, a refusal or an outage all read as a pass, and the whole check becomes
    // decorative. This is the assertion the module exists for.
    const f = checkCitations([], CORPUS, PROSE_2, PROSE_3)
    // An empty verdict trips BOTH rules, which is right: nothing was checked, and the
    // sentence about them in particular was not.
    expect(f).toHaveLength(2)
    expect(f.some(x => x.includes('an empty verdict is not a clean one'))).toBe(true)
    expect(f.some(x => x.includes('never returned as a claim'))).toBe(true)
  })

  it('does not fire the shortfall check when there is nothing to check', () => {
    // POSITIVE CONTROL ON THE CONTROL: questions and empty prose are not statements, so an
    // email of one question with no claims is legitimately clean.
    expect(checkCitations([], CORPUS, 'Worth a look?', '')).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// A SENTENCE ASSERTING HOW THE READER'S BUSINESS IS ARRANGED.
//
// Measured 2026-09-24: "Your outbound runs on a retained basis" shipped. It is the SENDER'S
// SERVICE described as the reader's existing arrangement, and the fact-check passed it,
// reading it as an offer. The prompt was corrected with that exact sentence as its worked
// example and the model still returned a bare empty list. ADR-028: the prompt is advisory,
// so the SHAPE is detected in code and the model only has to cite it.
describe('findReaderArrangements', () => {
  it('finds a claim about how their business runs', () => {
    expect(findReaderArrangements('Your outbound runs on a retained basis, meaning conversations are in motion.'))
      .toEqual(['Your outbound runs on a retained basis, meaning conversations are in motion.'])
    expect(findReaderArrangements('Your LinkedIn content is consistent.')).toHaveLength(1)
    expect(findReaderArrangements('Your pipeline depends on referrals.')).toHaveLength(1)
  })

  it('does NOT match the same service with the SENDER as the subject', () => {
    // THE CONTROL THAT MATTERS. The two sentences describe the same thing and only one is a
    // claim about the reader. A rule that could not tell them apart would ban the offer.
    expect(findReaderArrangements('We run outbound on a retained basis, so conversations are in motion.')).toEqual([])
  })

  it('does NOT match reporting an event, which the findings carry', () => {
    expect(findReaderArrangements('Your 15 September post used a sharp line to name what transactional recruiters do.')).toEqual([])
    expect(findReaderArrangements('You opened a second site in March.')).toEqual([])
  })
})

describe('an arrangement must be covered by a supported claim', () => {
  const CORPUS_2 = '1. The firm posted for a site manager on 13 August 2026.\n   source: linkedin | a post'
  const ARRANGED = 'Your outbound runs on a retained basis.\n\nWe build and work the list.'

  it('REJECTS it by name when the fact-check covered nothing', () => {
    const f = checkCitations([], CORPUS_2, ARRANGED, 'Worth a quick call?')
    expect(f.some(x => x.includes('states how their business is arranged'))).toBe(true)
    expect(f.some(x => x.includes('Your outbound runs on a retained basis.'))).toBe(true)
  })

  it('ACCEPTS it when a supported claim covers that sentence', () => {
    // POSITIVE CONTROL. The rule is about COVERAGE, not about banning the construction: a
    // finding that establishes the arrangement makes the sentence legitimate.
    const claims = [{
      email: 2, claim: 'Your outbound runs on a retained basis.', finding: 1,
      supported: true, why: 'finding 1 establishes it',
    }]
    const f = checkCitations(claims, CORPUS_2, ARRANGED, 'Worth a quick call?')
    expect(f.filter(x => x.includes('states how their business is arranged'))).toEqual([])
  })

  it('does not accept it on an UNSUPPORTED claim that merely mentions it', () => {
    const claims = [{
      email: 2, claim: 'Your outbound runs on a retained basis.', finding: null,
      supported: false, why: 'nothing says so',
    }]
    const f = checkCitations(claims, CORPUS_2, ARRANGED, 'Worth a quick call?')
    expect(f.some(x => x.includes('states how their business is arranged'))).toBe(true)
  })
})

describe('the fact-check prompt', () => {
  const p = buildFactCheckPrompt({ emailsShown: 'two emails', exampleEmail: 2, questionsCanCarryClaims: false })

  it('says the verb matters, which is the failure it was built for', () => {
    // "brought on X" where the finding says a post DIRECTED people to X. Every proper noun
    // matches; the invention is in the verb, so a name-matching check returns clean.
    expect(p).toContain('THE VERB MATTERS AS MUCH AS THE NOUN')
    expect(p).toContain('is NOT supported')
  })

  it('says an absent subject makes every claim about it unsupported', () => {
    // The second fabrication shape: a whole category of material that does not exist.
    expect(p).toContain('no material on a subject at all')
  })

  it('demands every claim, because a short list reads as a clean email', () => {
    expect(p).toContain('RETURN EVERY CLAIM')
  })

  it('says the SUBJECT decides, not the topic', () => {
    // The correction that followed a shipped line describing the sender's service as the
    // reader's arrangement.
    expect(p).toContain('THE SUBJECT DECIDES, NOT THE TOPIC')
    expect(p).toContain('their activities, methods and arrangements'.toUpperCase())
  })

  it('excludes the sender only when the SENDER is the subject', () => {
    expect(p).toContain('with the SENDER as the subject')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE SENTENCE THE VERIFIER NEVER RETURNED. Added 2026-09-25.
//
// A follow-up shipped "You refreshed the Higher Impact site in early 2026, which signals
// active investment in growth." Nothing in that prospect's research mentions a website, a
// refresh, or 2026.
//
// The fact-check RAN and REJECTED it, but only the trailing clause: it returned the claim as
// "which signals active investment in growth" and explained that "the finding notes the site
// was refreshed but makes no claim about growth investment intent". There is no such finding.
// The verifier decomposed the sentence, checked the inference, treated the premise as
// established, and invented a finding to justify doing so.
//
// So the escape was not a wrong verdict. It was a claim never returned, invisible to the
// arrangement rule (which matches "your X runs", not "You refreshed X") and to the shortfall
// rule (which fires only on an EMPTY list, and the list was not empty).
// ═══════════════════════════════════════════════════════════════════════════════

describe('a sentence about them that the verifier never returned', () => {
  const FINDINGS = [
    '1. Karl ended his Director of Coaching role in January 2025, after holding it since September 2022.',
    '   source: linkedin | profile',
  ].join('\n')

  const KARL = 'You refreshed the Higher Impact site in early 2026, which signals active investment in growth.'

  it('POSITIVE CONTROL: the real escape is caught', () => {
    // Exactly what the verifier returned on the day: the trailing clause only.
    const claims = [{
      email: 3, claim: 'which signals active investment in growth',
      finding: null, supported: false,
      why: 'No finding draws this inference; the finding notes the site was refreshed.',
    }]
    const f = checkCitations(claims, FINDINGS, 'Worth a look?', KARL, 'Higher Impact Consulting Group')
    expect(f.some(x => x.includes('never returned as a claim'))).toBe(true)
    expect(f.some(x => x.includes('You refreshed the Higher Impact site'))).toBe(true)
  })

  it('CONTROL: the same sentence passes once the verifier actually returns it', () => {
    const claims = [{
      email: 3, claim: 'You refreshed the Higher Impact site in early 2026',
      finding: 1, supported: true, why: 'covered',
    }]
    const f = checkCitations(claims, FINDINGS, 'Worth a look?', KARL, 'Higher Impact Consulting Group')
    expect(f.some(x => x.includes('never returned as a claim'))).toBe(false)
  })

  it('CONTROL: a question is not a claim, so a CTA never trips this', () => {
    const f = checkCitations(
      [{ email: 2, claim: 'x', finding: 1, supported: true, why: '' }],
      FINDINGS, 'Is that something you are working on?', 'Worth a look?', 'Higher Impact Consulting Group',
    )
    expect(f.some(x => x.includes('never returned as a claim'))).toBe(false)
  })

  it('CONTROL: a sentence about the SENDER is the offer, not a claim about them', () => {
    const f = checkCitations(
      [{ email: 2, claim: 'x', finding: 1, supported: true, why: '' }],
      FINDINGS, 'We run the outreach so meetings keep arriving.', 'Worth a look?', 'Higher Impact Consulting Group',
    )
    expect(f.some(x => x.includes('never returned as a claim'))).toBe(false)
  })
})
