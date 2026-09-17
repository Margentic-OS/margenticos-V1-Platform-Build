// Both directions, because a detector that fires on everything is an outage and one that
// fires on nothing is a comment. Every BANNED case below is a real sentence that shipped
// to a real prospect, or the writer brief's own worked failure. Every PERMITTED case is a
// real sentence from the same corpus that the brief explicitly allows.

import { describe, it, expect } from 'vitest'
import {
  findActivityVerdicts,
  checkActivityVerdict,
  ACTIVITY_VERDICT_MODE,
} from '../activity-verdict'

const kinds = (o: string, b: string) => findActivityVerdicts(o, b).map(h => h.kind)

describe('activity-verdict: it fires on the shapes the brief forbids', () => {
  it('fires when the gap lands on a room that has already met them', () => {
    // The shape of a real bridge that shipped: the audience is the people who attended his
    // talk, and the sentence tells him they have not acted. Names replaced; shape exact.
    const bridge =
      "The leaders who heard you present at the conference don't yet know the firm " +
      'takes on new clients.'
    const hits = findActivityVerdicts('', bridge)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.map(h => h.kind)).toContain('already_acquainted_gap')
    expect(hits[0].part).toBe('bridge')
  })

  it('fires on "with no mention of new mandates or BD targets"', () => {
    // NOTE: this shipped in the OBSERVATION, not the bridge. The absence ban covers both
    // parts by its own terms, so the check reads both and reports which one it found.
    const observation =
      'Your posts over the last 60 days are all client-facing advice on positioning ' +
      'and hiring, with no mention of new mandates or business development.'
    const hits = findActivityVerdicts(observation, '')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.map(h => h.kind)).toContain('names_an_absence')
    expect(hits[0].part).toBe('observation')
  })

  it("fires on the brief's own worked failure, a network declared unable to deliver", () => {
    const bridge =
      'What a trade event and a strong network cannot do is put the firm in front of ' +
      'the right buyers before the new delivery hire is already busy.'
    expect(kinds('', bridge)).toContain('activity_declared_failing')
  })

  it('fires on an absence of visible effort stated as a fact about them', () => {
    expect(kinds('', 'A 15-year firm with no visible footprint hands the next client ' +
      'discovery entirely to whoever already knows your number.'))
      .toContain('names_an_absence')
  })

  it('fires on a gap aimed at an audience already reading', () => {
    expect(kinds('', 'The people who need you next are already reading your feed.'))
      .toContain('already_acquainted_gap')
  })
})

describe('activity-verdict: it stays silent on copy the brief permits', () => {
  // THE MOST IMPORTANT CASE IN THIS FILE. This is the brief's own WORKING example shape
  // and the single most common bridge in the corpus. A detector that fires here is worse
  // than no detector, because it would reject the copy the rules are trying to produce.
  it('is silent when the gap lands on people who have never heard of them', () => {
    expect(findActivityVerdicts('', 'A referral network built over decades keeps existing ' +
      'contacts close but rarely puts your name in front of clients who have never heard ' +
      'of you.')).toEqual([])
  })

  it('is silent on a plain situation consequence about a category', () => {
    expect(findActivityVerdicts('', 'New-client conversations at owner-led firms tend ' +
      'to wait until the current engagement wraps.')).toEqual([])
  })

  it('is silent on a concrete observation with no negation at all', () => {
    expect(findActivityVerdicts(
      'You ran the firm alongside a group director role for about nine years, and that ' +
      'ended in September 2022.',
      'Your second press needs work from customers you have not quoted yet.',
    )).toEqual([])
  })

  it('is silent on "no" doing ordinary determiner work', () => {
    expect(findActivityVerdicts('', 'No two client engagements start the same way.')).toEqual([])
  })

  // THE THREE BELOW ARE REGRESSIONS, not hypotheticals. Each is a real sentence from the
  // export corpus that an earlier version of this module flagged, and each is permitted.
  // They are the class that makes a checker of this kind unusable: the first one had
  // already SHIPPED to a prospect, so a blocking gate with that defect would have rejected
  // copy the brief was asking for. Precision on the permitted shape is the whole product.
  it('is silent when the gap lands on people who have never READ their posts', () => {
    // The exclusion once listed heard/met/seen and not read, so rule 3 fired on this.
    expect(findActivityVerdicts('', 'Prospects who have never read your posts do not know ' +
      'the firm exists yet.')).toEqual([])
  })

  it('is silent when the activity noun is not what the negation is predicated of', () => {
    // "The weeks" is the subject, not "speaking engagements". A bare article let the
    // activity noun sit anywhere in the subject; the rule now needs a possessive.
    expect(findActivityVerdicts('', 'The weeks between speaking engagements rarely fill ' +
      'themselves with new client conversations.')).toEqual([])
  })

  it('does not join two clauses across a semicolon', () => {
    expect(findActivityVerdicts('', 'Speaking slots and papers reach the people who saw ' +
      'them; the next client rarely finds you between them.')).toEqual([])
  })
})

describe('activity-verdict: the mode', () => {
  // FLIPPED 2026-09-16. This assertion is the flip: if someone returns the constant to
  // 'report', this test is what tells them the gate stopped gating, rather than a silent
  // return to the state in which two genuine violations reached real prospects.
  it('ships BLOCKING, so the production default rejects the banned shape', () => {
    expect(ACTIVITY_VERDICT_MODE).toBe('block')
    const bridge = "The leaders who heard you speak don't yet know you take new clients."
    expect(findActivityVerdicts('', bridge).length).toBeGreaterThan(0)
    // No mode argument: this is exactly what production calls.
    const failures = checkActivityVerdict('', bridge, { prospectId: 'p' })
    expect(failures.length).toBeGreaterThan(0)
  })

  it('report mode still gates nothing when it is asked for explicitly', () => {
    const bridge = "The leaders who heard you speak don't yet know you take new clients."
    expect(checkActivityVerdict('', bridge, { prospectId: 'p' }, 'report')).toEqual([])
  })

  it('the blocking path can be executed, and names the part and the span', () => {
    const bridge = "The leaders who heard you speak don't yet know you take new clients."
    const failures = checkActivityVerdict('', bridge, { prospectId: 'p' }, 'block')
    expect(failures.length).toBeGreaterThan(0)
    expect(failures[0]).toContain('bridge')
    expect(failures[0]).toContain('already met them')
  })
})


// ─── The permitted shape, from production copy rather than invented for the test ───────
//
// MUTATION PROOF, and the reason this block exists: the gate's cost is false positives on
// company-data facts. Both sentences below are real signal_observations from MargenticOS
// prospects on 2026-09-14. Flat or slow headcount is the single most common permitted
// observation in the corpus, and a rule that rejected it would take out good openings on
// exactly the firms the ICP targets.
//
// If a future narrowing of the rule starts firing here, that narrowing is wrong.
describe('activity-verdict: a firmographic fact is not an absence', () => {
  it('is silent on flat headcount stated as a company fact', () => {
    const observation =
      'Sustainable Success has been at 6 people for at least the past year with 0% headcount growth, ' +
      '20 years after founding in 2003.'
    expect(findActivityVerdicts(observation, '')).toEqual([])
    expect(checkActivityVerdict(observation, '', { prospectId: 'p' })).toEqual([])
  })

  it('is silent on slow headcount growth stated as a company fact', () => {
    const observation =
      'Strategy Here has been operating since 2018 with 2.5% headcount growth over the past 12 months.'
    expect(findActivityVerdicts(observation, '')).toEqual([])
    expect(checkActivityVerdict(observation, '', { prospectId: 'p' })).toEqual([])
  })
})

// ─── The shapes that actually reached prospects ───────────────────────────────────────
//
// Both of these SHIPPED to real prospects while the gate was in report mode. They are the
// evidence that justified blocking, so they are the regression test for it. Verbatim from
// .writer-export/ACTIVITY-VERDICT-hits.txt.
describe('activity-verdict: the two hits that shipped are now rejected', () => {
  it('rejects the observation that listed what their website lacks', () => {
    const observation =
      "Your LinkedIn posts over the last 60 days have all been reshares of other people's content, " +
      'and the People Strategy Consulting website carries no dated articles or case studies.'
    expect(checkActivityVerdict(observation, '', { prospectId: 'p' }).length).toBeGreaterThan(0)
  })

  it('rejects the bridge that told a 13-year-old firm it has no visible content', () => {
    const bridge =
      'A thirteen-year-old consulting firm with no visible business development content tends to ' +
      'win the next client from whoever already knows it.'
    expect(checkActivityVerdict('', bridge, { prospectId: 'p' }).length).toBeGreaterThan(0)
  })
})
