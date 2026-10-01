// THE CODE HALF of Email 1's fact-check, driven with the real sentences that provoked it.
//
// WHAT IS AND IS NOT TESTED HERE. The model's verdict is not: that needs an API call. What is
// tested is everything the code decides GIVEN a verdict, which is where the guarantees live.
// Both halves matter and they fail differently: a wrong verdict is a judgement error, a code
// half that cannot act on a verdict is a gate that does not gate.
//
// THE CONTROLS RUN BOTH WAYS. Two real sentences from the 104 must fail and a population
// statement must pass. Without the passing control every assertion here would also hold for a
// checker that rejected everything, which would stop Email 1 shipping at all.
//
// RULE ZERO. The two failing sentences are real copy this system produced and are kept
// verbatim because the whole point is that they read fine. Everything invented is neutral.

import { describe, it, expect } from 'vitest'
import { checkOpeningCitations } from '../fact-check-opening'
import type { CheckedClaim } from '../fact-check-followups'

const FINDINGS = [
  '1. Devon ended his Director of Coaching role at Christian Business Fellowship in January 2025, after holding it since September 2022.',
  '   source: linkedin | profile',
  '2. Devon became Founder and Board Chair at a regional chamber of commerce in August 2025.',
  '   source: linkedin | profile',
].join('\n')

// Real copy from the 2026-09-25 cohort. Every existing gate passed both.
const KARL_BRIDGE = 'A structured role like that one brings new people to Brightpath regularly.'
const NICK_BRIDGE = 'The Delivery Company now needs to win new clients without a second income behind it.'

// The form Email 1's bridge is SUPPOSED to take: a claim about a population, naming nobody.
const POPULATION_BRIDGE = 'A new hire needs client work in their diary before the first invoice lands.'

const NEUTRAL_QUESTION = 'Worth a look?'

const claim = (over: Partial<CheckedClaim>): CheckedClaim => ({
  email: 1, claim: '', finding: 1, supported: true, why: '', ...over,
})

describe('a claim about the named prospect or firm needs a cited finding', () => {
  it('FAILS Devon: the verifier found nothing supporting it', () => {
    const f = checkOpeningCitations(
      [claim({ claim: 'brings new people to Brightpath regularly', finding: null, supported: false, why: 'No finding says the role brought anyone in.' })],
      FINDINGS, KARL_BRIDGE, NEUTRAL_QUESTION, 'Brightpath Delivery Group',
    )
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('brings new people to Brightpath regularly')
    expect(f[0]).toContain('which the findings do not support')
  })

  it('FAILS Marin: the verifier found nothing supporting it', () => {
    const f = checkOpeningCitations(
      [claim({ claim: 'needs to win new clients without a second income behind it', finding: null, supported: false, why: 'Nothing establishes the company finances.' })],
      FINDINGS, NICK_BRIDGE, NEUTRAL_QUESTION, 'The Delivery Company',
    )
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('without a second income behind it')
  })

  /**
   * THE SHORTFALL, NARROWED. An empty verdict over a sentence that NAMES the firm is the
   * verifier not having checked. This is the branch that catches both sentences above even if
   * the model declines to classify them at all, which is exactly what it did on the follow-up
   * side for three iterations.
   */
  it('FAILS Devon on an EMPTY verdict, because the sentence names the firm', () => {
    const f = checkOpeningCitations([], FINDINGS, KARL_BRIDGE, NEUTRAL_QUESTION, 'Brightpath Delivery Group')
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('an empty verdict is not a clean one')
  })

  it('FAILS Marin on an EMPTY verdict, because the sentence names the firm', () => {
    const f = checkOpeningCitations([], FINDINGS, NICK_BRIDGE, NEUTRAL_QUESTION, 'The Delivery Company')
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('an empty verdict is not a clean one')
  })

  // ─── THE PASSING CONTROLS. Without these the gate could be rejecting everything. ─────

  it('PASSES a population statement on an empty verdict: it names nobody', () => {
    expect(
      checkOpeningCitations([], FINDINGS, POPULATION_BRIDGE, NEUTRAL_QUESTION, 'Brightpath Delivery Group'),
    ).toEqual([])
  })

  it('PASSES a claim the verifier supported with a real finding', () => {
    expect(
      checkOpeningCitations(
        [claim({ claim: 'ended the Director of Coaching role in January 2025', finding: 1, supported: true })],
        FINDINGS,
        'You ended that role in January 2025.',
        NEUTRAL_QUESTION,
        'Brightpath Delivery Group',
      ),
    ).toEqual([])
  })

  it('PASSES when a second-person sentence is supported, so "you" alone is not a failure', () => {
    expect(
      checkOpeningCitations(
        [claim({ claim: 'you held it for over two years', finding: 1, supported: true })],
        FINDINGS,
        'You held it for over two years.',
        NEUTRAL_QUESTION,
        'Brightpath Delivery Group',
      ),
    ).toEqual([])
  })

  // ─── The citation must exist ─────────────────────────────────────────────────────────

  it('FAILS a citation to a finding that does not exist', () => {
    const f = checkOpeningCitations(
      [claim({ claim: 'something', finding: 9, supported: true })],
      FINDINGS, 'You did something.', NEUTRAL_QUESTION, 'Brightpath Delivery Group',
    )
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('does not exist')
    expect(f[0]).toContain('the findings have 2 lines')
  })

  /**
   * THE QUESTION IS CHECKED, which is the difference from the follow-up rules. Devon's real
   * question presupposes introductions that no finding establishes, inside a sentence ending
   * in a question mark.
   */
  it('FAILS a question that presupposes a fact no finding carries', () => {
    const f = checkOpeningCitations(
      [claim({ claim: 'those introductions', finding: null, supported: false, why: 'No finding establishes that introductions happened.' })],
      FINDINGS,
      POPULATION_BRIDGE,
      "Is finding new coaching clients to replace those introductions something you're working on?",
      'Brightpath Delivery Group',
    )
    expect(f.some(x => x.includes('those introductions'))).toBe(true)
  })

  it('CONTROL: a neutral question that assumes nothing passes', () => {
    expect(
      checkOpeningCitations([], FINDINGS, POPULATION_BRIDGE, 'Worth a look?', 'Brightpath Delivery Group'),
    ).toEqual([])
  })

  it('CONTROL: a null company name does not throw and does not fire the shortfall', () => {
    expect(checkOpeningCitations([], FINDINGS, POPULATION_BRIDGE, NEUTRAL_QUESTION, null)).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE SHORTFALL RULE IS NARROWED. Added 2026-09-28.
//
// Re-running the fact-check on six empty-verdict positions showed three of them failing for
// having a closing question, and one for a general market statement that merely contained
// "you". Both are the shortfall rule answering a question it was not asked: it exists to spot
// a verifier that did not work, and neither shape is evidence of that.
// ═══════════════════════════════════════════════════════════════════════════════

describe('what counts as a sentence the verifier should have checked', () => {
  const F = '1. The firm posted a role in March.\n   source: website'

  it('a CTA question does NOT trigger the shortfall', () => {
    expect(
      checkOpeningCitations([], F, POPULATION_BRIDGE,
        "Is getting your work in front of buyers who have never come across it something you are focused on?",
        'Willow Court Consulting'),
    ).toEqual([])
  })

  it('a market statement that merely contains "you" does NOT trigger it', () => {
    expect(
      checkOpeningCitations([], F,
        'The deals worth winning require the right buyers to find you before the wrong ones do.',
        'Worth a look?', 'Tessellate Consulting'),
    ).toEqual([])
  })

  it('an offer line with a participial adjective is still exempt', () => {
    // "focused" ends in -ed, which the first FACT_MARKER matched, denying the exemption.
    expect(
      checkOpeningCitations([], F, 'You stay focused on delivery.', 'Worth a look?', 'ZQP Consulting'),
    ).toEqual([])
  })

  it('STILL FAILS a subject-position claim about them on an empty verdict', () => {
    const f = checkOpeningCitations([], F,
      'Your Technical Services practice runs ahead of the buyers who know to look for it.',
      'Worth a look?', 'Summit9 Consulting LLC')
    expect(f.length).toBeGreaterThan(0)
  })

  it('STILL FAILS Devon, which is the control that must never go green by accident', () => {
    const f = checkOpeningCitations([], F,
      'You refreshed the Brightpath site in early 2026.', 'Worth a look?',
      'Brightpath Delivery Group')
    expect(f.some(x => x.includes('empty verdict'))).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// THE PERMITTED STRANGER LINE IS NOT A CLAIM. Added 2026-09-30.
//
// stranger-group.test.ts owns which sentences are the permitted shape. These assert the
// FACT-CHECK acts on that, because the fact-check is what was rejecting it: of five prospects
// templated on stranger lines on 2026-09-28, four were the asserting form and one was the
// permitted form, and the permitted form is the most common bridge in the corpus.
//
// RULE ZERO. Every fixture is invented.
// ═══════════════════════════════════════════════════════════════════════════════

describe('a stranger line defined by a relative clause survives the fact-check', () => {
  const EVIDENCE = '1. The firm opened a second workshop in March.\n   source: web | a listings page'
  const unsupported = (claim: string) => [{
    email: 1, claim, finding: null, supported: false, why: 'no finding establishes this',
  }]

  it('does NOT fail the permitted form', () => {
    const bridge = "Buyers who have never heard of Kestrel Works won't find the second workshop on their own."
    const failures = checkOpeningCitations(
      unsupported('Buyers who have never heard of Kestrel Works'), EVIDENCE, bridge, 'Worth a look?', 'Kestrel Works',
    )
    expect(failures).toEqual([])
  })

  it('STILL fails the asserting form, which is the control', () => {
    // Without this the test above would pass just as happily if the suppression swallowed
    // every unsupported claim, which is an outage rather than a fix.
    const bridge = 'Buyers have not heard of Kestrel Works yet.'
    const failures = checkOpeningCitations(
      unsupported('Buyers have not heard of Kestrel Works yet'), EVIDENCE, bridge, 'Worth a look?', 'Kestrel Works',
    )
    expect(failures.length).toBeGreaterThan(0)
    expect(failures[0]).toContain('the findings do not support')
  })

  it('suppresses only the claim carried by that sentence, not the rest of the email', () => {
    const bridge = "Buyers who have never heard of Kestrel Works won't find it on their own."
    const question = 'Is replacing the revenue that role was carrying something you are working on?'
    const failures = checkOpeningCitations(
      [
        ...unsupported('Buyers who have never heard of Kestrel Works'),
        ...unsupported('the revenue that role was carrying'),
      ],
      EVIDENCE, bridge, question, 'Kestrel Works',
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('revenue')
  })

  it('does not suppress a claim that merely shares a word with the stranger sentence', () => {
    // The attribution is on shared distinctive words, so a claim about something else in the
    // same email must not inherit the exemption.
    const bridge = "Buyers who have never heard of Kestrel Works won't find it on their own."
    const failures = checkOpeningCitations(
      unsupported('Kestrel Works doubled its workshop capacity last year'), EVIDENCE, bridge, 'Worth a look?', 'Kestrel Works',
    )
    expect(failures.length).toBeGreaterThan(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// EXPERIMENT, 2026-10-01: A POSSIBILITY ABOUT FIRMS LIKE THEIRS IS NOT A CLAIM.
//
// The verifier returns "unsupported" for a hedged pattern, correctly on its own terms: no
// finding carries it. The code half now lets that through, and ONLY that. Every control
// below is a sentence one word away from the allowed one that must still fail, because a
// rule that excused everything with "often" in it would let the Devon sentence back in.
describe('a hedged pattern about firms like theirs survives the fact-check', () => {
  const HEDGED = 'A new hire often needs client work lined up before the first invoice lands.'
  const FLAT = 'A new hire needs client work lined up before the first invoice lands.'
  const ABOUT_THEM = 'Your new hire often needs client work lined up before the first invoice lands.'
  const NAMES_THEM = 'A new hire at Brightpath often needs client work lined up before the first invoice lands.'
  const unsupported = (text: string) =>
    [claim({ claim: text.replace(/\.$/, ''), finding: null, supported: false, why: 'No finding establishes this.' })]

  it('does NOT fail the hedged pattern', () => {
    expect(checkOpeningCitations(unsupported(HEDGED), FINDINGS, HEDGED, NEUTRAL_QUESTION, 'Brightpath Delivery Group')).toEqual([])
  })

  it('STILL fails the same sentence stated flat, which is the control', () => {
    const f = checkOpeningCitations(unsupported(FLAT), FINDINGS, FLAT, NEUTRAL_QUESTION, 'Brightpath Delivery Group')
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('which the findings do not support')
  })

  it('STILL fails the hedged sentence when it says "your"', () => {
    const f = checkOpeningCitations(unsupported(ABOUT_THEM), FINDINGS, ABOUT_THEM, NEUTRAL_QUESTION, 'Brightpath Delivery Group')
    expect(f).toHaveLength(1)
  })

  it('STILL fails the hedged sentence when it names their firm', () => {
    const f = checkOpeningCitations(unsupported(NAMES_THEM), FINDINGS, NAMES_THEM, NEUTRAL_QUESTION, 'Brightpath Delivery Group')
    expect(f.length).toBeGreaterThan(0)
    expect(f.join(' ')).toContain('which the findings do not support')
  })

  it('STILL fails Devon and Marin: neither real sentence is hedged, and both name the firm', () => {
    expect(checkOpeningCitations(
      [claim({ claim: 'brings new people to Brightpath regularly', finding: null, supported: false, why: '' })],
      FINDINGS, KARL_BRIDGE, NEUTRAL_QUESTION, 'Brightpath Delivery Group',
    )).toHaveLength(1)
    expect(checkOpeningCitations(
      [claim({ claim: 'needs to win new clients without a second income behind it', finding: null, supported: false, why: '' })],
      FINDINGS, NICK_BRIDGE, NEUTRAL_QUESTION, 'The Delivery Company',
    )).toHaveLength(1)
  })

  it('does not excuse a QUESTION that presupposes a fact, even under a hedged bridge', () => {
    // The question shares most of its words with the bridge. `some` would excuse it on the
    // strength of the bridge; `every` does not, because a question is never a hedged pattern.
    const question = 'Is the client work for the new hire lined up before the first invoice lands?'
    const f = checkOpeningCitations(
      [claim({ claim: 'client work for the new hire lined up before the first invoice lands', finding: null, supported: false, why: 'Presupposes a hire and an invoice.' })],
      FINDINGS, HEDGED, question, 'Brightpath Delivery Group',
    )
    expect(f).toHaveLength(1)
  })

  it('suppresses only the hedged claim, not another unsupported claim in the same email', () => {
    const f = checkOpeningCitations(
      [
        ...unsupported(HEDGED),
        claim({ claim: 'the chamber role fills the diary on its own', finding: null, supported: false, why: 'Nothing says so.' }),
      ],
      FINDINGS, HEDGED, 'Is the chamber role something that fills the diary on its own?', 'Brightpath Delivery Group',
    )
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('chamber role')
  })
})
