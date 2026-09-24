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
    expect(parseFactCheckResponse(raw)).toEqual([
      { email: 2, claim: 'x', finding: 1, supported: true, why: 'y' },
    ])
  })

  it('returns NOTHING for a malformed or absent reply, which then fails the shortfall check', () => {
    // Deliberately not throwing: an unreadable verdict is "checked nothing", and the
    // shortfall check below turns that into a failure rather than a silent pass.
    expect(parseFactCheckResponse('no json here')).toEqual([])
    expect(parseFactCheckResponse('{"claims": not json}')).toEqual([])
  })

  it('drops a claim about an email that does not exist', () => {
    const raw = '{"claims":[{"email":1,"claim":"x","finding":1,"supported":true},{"email":2,"claim":"y","finding":1,"supported":true}]}'
    expect(parseFactCheckResponse(raw)).toHaveLength(1)
  })

  it('reads a null citation as null rather than as zero', () => {
    const raw = '{"claims":[{"email":2,"claim":"x","finding":null,"supported":false,"why":"nothing says so"}]}'
    expect(parseFactCheckResponse(raw)[0].finding).toBeNull()
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
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('You brought on a new operations lead.')
    expect(f[0]).toContain('directed people to them')
  })

  it('REJECTS AN EMPTY VERDICT, which is the failure mode that looks clean', () => {
    // A verifier that returns nothing has not checked anything. Without this, a malformed
    // reply, a refusal or an outage all read as a pass, and the whole check becomes
    // decorative. This is the assertion the module exists for.
    const f = checkCitations([], CORPUS, PROSE_2, PROSE_3)
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('an empty verdict is not a clean one')
  })

  it('does not fire the shortfall check when there is nothing to check', () => {
    // POSITIVE CONTROL ON THE CONTROL: questions and empty prose are not statements, so an
    // email of one question with no claims is legitimately clean.
    expect(checkCitations([], CORPUS, 'Worth a look?', '')).toEqual([])
  })
})

describe('the fact-check prompt', () => {
  const p = buildFactCheckPrompt()

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

  it('excludes what the SENDER does, so an offer is not checked as a claim about them', () => {
    expect(p).toContain('what the SENDER does or offers')
  })
})
