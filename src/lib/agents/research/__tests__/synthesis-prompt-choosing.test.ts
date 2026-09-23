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

    it('says list position is not the thing to choose on', () => {
      expect(prompt).toMatch(/do not simply take the earliest-listed one/i)
    })

    it('names all four criteria, in order', () => {
      const recency  = prompt.indexOf('THE MORE RECENT EVENT')
      const specific = prompt.indexOf('THE MORE SPECIFIC ONE')
      const reason   = prompt.indexOf('MORE DIRECTLY GIVES THIS PERSON A REASON')
      const position = prompt.indexOf('Trigger list position, and only to break a tie')
      expect(recency).toBeGreaterThan(-1)
      expect(specific).toBeGreaterThan(recency)
      expect(reason).toBeGreaterThan(specific)
      expect(position).toBeGreaterThan(reason)
    })

    it('says an undated candidate ranks below every dated one', () => {
      expect(prompt).toMatch(/undated candidate ranks below every dated one/i)
    })

    it('says a reshare ranks below their own post and must be described as shared', () => {
      // \s+ ACROSS EVERY GAP. The prompt is a hard-wrapped template literal, so any of
      // these phrases can straddle a newline: the first draft of this test failed on
      // "Never write\nthat they said", which is the prompt being correct and the regex
      // being wrong about whitespace.
      expect(prompt).toMatch(/RESHARE\s+RANKS\s+BELOW\s+THE\s+PROSPECT'S\s+OWN\s+POST/)
      expect(prompt).toMatch(/the\s+observation\s+must\s+say\s+they\s+SHARED\s+it/)
      expect(prompt).toMatch(/Never\s+write\s+that\s+they\s+said,\s+posted,\s+wrote\s+or\s+announced/)
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
      const a = buildSynthesisPrompt({ ...ctx(withDimensions), triggers: ['ALPHA_TRIGGER_TEXT'] } as Parameters<typeof buildSynthesisPrompt>[0])
      const b = buildSynthesisPrompt({ ...ctx(withDimensions), triggers: ['BETA_TRIGGER_TEXT'] } as Parameters<typeof buildSynthesisPrompt>[0])

      expect(a).toContain('ALPHA_TRIGGER_TEXT')
      expect(b).toContain('BETA_TRIGGER_TEXT')
      expect(a).not.toContain('BETA_TRIGGER_TEXT')
      // And the ONLY difference between them is that text. Replacing one client's trigger
      // with the other's makes the two prompts identical, which is what "nothing
      // client-specific lives in the shared prompt" actually means.
      expect(a.replace(/ALPHA_TRIGGER_TEXT/g, 'X')).toBe(b.replace(/BETA_TRIGGER_TEXT/g, 'X'))
    })
  })
}
