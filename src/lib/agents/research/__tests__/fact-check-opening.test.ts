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
  '1. Karl ended his Director of Coaching role at Christian Business Fellowship in January 2025, after holding it since September 2022.',
  '   source: linkedin | profile',
  '2. Karl became Founder and Board Chair at a regional chamber of commerce in August 2025.',
  '   source: linkedin | profile',
].join('\n')

// Real copy from the 2026-09-25 cohort. Every existing gate passed both.
const KARL_BRIDGE = 'A structured role like that one brings new people to Higher Impact regularly.'
const NICK_BRIDGE = 'The Operations Company now needs to win new clients without a second income behind it.'

// The form Email 1's bridge is SUPPOSED to take: a claim about a population, naming nobody.
const POPULATION_BRIDGE = 'A new hire needs client work in their diary before the first invoice lands.'

const NEUTRAL_QUESTION = 'Worth a look?'

const claim = (over: Partial<CheckedClaim>): CheckedClaim => ({
  email: 1, claim: '', finding: 1, supported: true, why: '', ...over,
})

describe('a claim about the named prospect or firm needs a cited finding', () => {
  it('FAILS Karl: the verifier found nothing supporting it', () => {
    const f = checkOpeningCitations(
      [claim({ claim: 'brings new people to Higher Impact regularly', finding: null, supported: false, why: 'No finding says the role brought anyone in.' })],
      FINDINGS, KARL_BRIDGE, NEUTRAL_QUESTION, 'Higher Impact Consulting Group',
    )
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('brings new people to Higher Impact regularly')
    expect(f[0]).toContain('which the findings do not support')
  })

  it('FAILS Nick: the verifier found nothing supporting it', () => {
    const f = checkOpeningCitations(
      [claim({ claim: 'needs to win new clients without a second income behind it', finding: null, supported: false, why: 'Nothing establishes the company finances.' })],
      FINDINGS, NICK_BRIDGE, NEUTRAL_QUESTION, 'The Operations Company',
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
  it('FAILS Karl on an EMPTY verdict, because the sentence names the firm', () => {
    const f = checkOpeningCitations([], FINDINGS, KARL_BRIDGE, NEUTRAL_QUESTION, 'Higher Impact Consulting Group')
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('an empty verdict is not a clean one')
  })

  it('FAILS Nick on an EMPTY verdict, because the sentence names the firm', () => {
    const f = checkOpeningCitations([], FINDINGS, NICK_BRIDGE, NEUTRAL_QUESTION, 'The Operations Company')
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('an empty verdict is not a clean one')
  })

  // ─── THE PASSING CONTROLS. Without these the gate could be rejecting everything. ─────

  it('PASSES a population statement on an empty verdict: it names nobody', () => {
    expect(
      checkOpeningCitations([], FINDINGS, POPULATION_BRIDGE, NEUTRAL_QUESTION, 'Higher Impact Consulting Group'),
    ).toEqual([])
  })

  it('PASSES a claim the verifier supported with a real finding', () => {
    expect(
      checkOpeningCitations(
        [claim({ claim: 'ended the Director of Coaching role in January 2025', finding: 1, supported: true })],
        FINDINGS,
        'You ended that role in January 2025.',
        NEUTRAL_QUESTION,
        'Higher Impact Consulting Group',
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
        'Higher Impact Consulting Group',
      ),
    ).toEqual([])
  })

  // ─── The citation must exist ─────────────────────────────────────────────────────────

  it('FAILS a citation to a finding that does not exist', () => {
    const f = checkOpeningCitations(
      [claim({ claim: 'something', finding: 9, supported: true })],
      FINDINGS, 'You did something.', NEUTRAL_QUESTION, 'Higher Impact Consulting Group',
    )
    expect(f).toHaveLength(1)
    expect(f[0]).toContain('does not exist')
    expect(f[0]).toContain('the findings have 2 lines')
  })

  /**
   * THE QUESTION IS CHECKED, which is the difference from the follow-up rules. Karl's real
   * question presupposes introductions that no finding establishes, inside a sentence ending
   * in a question mark.
   */
  it('FAILS a question that presupposes a fact no finding carries', () => {
    const f = checkOpeningCitations(
      [claim({ claim: 'those introductions', finding: null, supported: false, why: 'No finding establishes that introductions happened.' })],
      FINDINGS,
      POPULATION_BRIDGE,
      "Is finding new coaching clients to replace those introductions something you're working on?",
      'Higher Impact Consulting Group',
    )
    expect(f.some(x => x.includes('those introductions'))).toBe(true)
  })

  it('CONTROL: a neutral question that assumes nothing passes', () => {
    expect(
      checkOpeningCitations([], FINDINGS, POPULATION_BRIDGE, 'Worth a look?', 'Higher Impact Consulting Group'),
    ).toEqual([])
  })

  it('CONTROL: a null company name does not throw and does not fire the shortfall', () => {
    expect(checkOpeningCitations([], FINDINGS, POPULATION_BRIDGE, NEUTRAL_QUESTION, null)).toEqual([])
  })
})
