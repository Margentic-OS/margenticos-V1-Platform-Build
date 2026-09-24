// THE INSTRUCTIONS THAT TELL THE MODEL WHAT TO CHOOSE ON AND WHAT TO SAY ABOUT IT.
//
// THE LIMIT, STATED SO IT IS NOT OVER-TRUSTED: this proves the instruction is SENT, and
// nothing about whether the model obeys it. The ordering itself is enforced in code
// (rank-candidates.ts, selection-ordering.test.ts), which is what makes it binding under
// ADR-028; these lines exist so the model's own answers arrive in a shape the code can use.
//
// It also guards against the two ways this text could go missing without a failure anywhere
// else: the section being dropped in an edit, and Rule Zero, which would be broken by any
// client's own trigger text finding its way into a prompt that every client shares.

import { describe, it, expect } from 'vitest'
import { buildSynthesisPrompt } from '@/lib/agents/research/prompts/synthesis-prompt'

function ctx(withDimensions: boolean) {
  return {
    icpSummary: 'Test ICP summary.',
    positioningSummary: 'Test positioning.',
    tovSummary: 'Test tone of voice.',
    clientName: 'Test Client',
    buyerTitle: 'Founder',
    fitDimensions: withDimensions
      ? [{ key: 'revenue_band', label: 'Revenue band', required: true, establishable: true }]
      : [],
  } as unknown as Parameters<typeof buildSynthesisPrompt>[0]
}

for (const withDimensions of [true, false]) {
  const label = withDimensions ? 'with a fit dimension list' : 'without a fit dimension list'

  describe(`choosing instructions, ${label}`, () => {
    const prompt = buildSynthesisPrompt(ctx(withDimensions))

    // REWRITTEN 2026-09-24 with the decision itself. These four used to assert that the
    // prompt named a fixed order of criteria and told the model to apply it. Code now
    // decides only what is OUT, and the model chooses among what is left, so a prompt
    // stating a ranking as the answer would contradict the code. The claims below are the
    // new contract, at the same level and in the same file.
    it('tells the model the choice is ITS decision, not the ordering\'s', () => {
      expect(prompt).toMatch(/THIS IS YOURS TO DECIDE/)
      expect(prompt).toMatch(/IT IS INFORMATION, NOT THE\s+ANSWER/)
    })

    it('says what to choose ON: the strongest, most specific reason for this prospect', () => {
      expect(prompt).toMatch(/STRONGEST, MOST\s+SPECIFIC REASON/)
      expect(prompt).toMatch(/Not the most recent/)
    })

    it('says code has already removed what is unusable, so the model is not re-filtering', () => {
      expect(prompt).toMatch(/Code has already removed everything that is not usable/)
    })

    it('allows at most one supporting event, and bans summarising a feed', () => {
      expect(prompt).toMatch(/CONSIDER WHETHER A SECOND EVENT STRENGTHENS IT/)
      expect(prompt).toMatch(/point at the SAME reason/)
      expect(prompt).toMatch(/Never summarise a feed or several\s+posts as a pattern/)
      expect(prompt).toMatch(/"supporting_candidate_id"/)
    })

    it('says a reshare must be described as shared', () => {
      expect(prompt).toMatch(/RESHARE IS SOMETHING THEY AMPLIFIED, NOT SOMETHING THEY WROTE/)
      expect(prompt).toMatch(/Never write that they said, posted, wrote\s+or announced/)
    })

    it('says their OWN FIRM\'S reshare is their news and stays usable', () => {
      expect(prompt).toMatch(/RESHARE OF THEIR OWN FIRM'S ANNOUNCEMENT IS THEIR NEWS/)
      expect(prompt).toMatch(/"reshare_of_own_firm"/)
    })

    it('asks for matched_trigger as a NUMBER, which is what the code ranks on', () => {
      expect(prompt).toMatch(/"matched_trigger": null or the NUMBER of the trigger/)
    })

    it('asks for is_reshare', () => {
      expect(prompt).toMatch(/"is_reshare": true if the source post was marked RESHARE/)
    })

    it('asks for one plain sentence naming the choice, the runner-up and why', () => {
      expect(prompt).toMatch(/"selection_reason": "ONE PLAIN SENTENCE naming the candidate you chose, the runner-up, and why/)
    })

    it('tells it to give the actual reason, not a restatement of the rule', () => {
      expect(prompt).toMatch(/Say the ACTUAL reason it won, never a restatement of the rule/)
    })

    it('RULE ZERO: the triggers the model chooses on come from THIS client, not from here', () => {
      // The honest form of this check is not "no industry word appears in the prompt".
      // Words like headcount and hiring are legitimately here, in generic guidance about
      // what is and is not usable evidence, and a test banning them would fail on correct
      // text. What Rule Zero forbids is a trigger this file supplies on every client's
      // behalf, so the check is a comparison: the same prompt built for two different
      // clients differs by exactly their own trigger lists and by nothing else.
      const a = buildSynthesisPrompt({ ...ctx(withDimensions), triggers: [{ trigger: 'ALPHA_TRIGGER_TEXT', reason: 'ALPHA_REASON_TEXT' }] } as Parameters<typeof buildSynthesisPrompt>[0])
      const b = buildSynthesisPrompt({ ...ctx(withDimensions), triggers: [{ trigger: 'BETA_TRIGGER_TEXT', reason: 'BETA_REASON_TEXT' }] } as Parameters<typeof buildSynthesisPrompt>[0])

      expect(a).toContain('ALPHA_TRIGGER_TEXT')
      expect(a).toContain('ALPHA_REASON_TEXT')
      expect(b).toContain('BETA_TRIGGER_TEXT')
      expect(a).not.toContain('BETA_TRIGGER_TEXT')
      // And the ONLY difference between them is that text. Replacing one client's trigger
      // with the other's makes the two prompts identical, which is what "nothing
      // client-specific lives in the shared prompt" actually means.
      expect(a.replace(/ALPHA_TRIGGER_TEXT/g, 'X').replace(/ALPHA_REASON_TEXT/g, 'Y'))
        .toBe(b.replace(/BETA_TRIGGER_TEXT/g, 'X').replace(/BETA_REASON_TEXT/g, 'Y'))
    })
  })
}
