// The synthesis prompt must tell the model to write its working once and its answer once.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS GUARDS AND WHY IT IS WORTH A FILE
//
// Measured 2026-09-14 on the first live batch: 28% of synthesis OUTPUT was restatement.
// The model wrote its analysis inside <reasoning>, closed the tag, and wrote the same
// analysis again under a "## Reasoning" heading (21.2% of output). In one of the two
// responses it also wrote the finished JSON inside its own working before writing it
// properly (6.8%). None of it is consumed: parseReasoningBlock takes only what is inside
// the tags, and extractJson slices from the first { after them. It is also what pushed
// three of 39 calls into the 16,000-token ceiling and forced it to 24,000.
//
// NO INSTRUCTION ASKED FOR THE SECOND COPY. Three silences invited it, and this file
// asserts that each is now closed:
//
//   1. the prompt never said the reasoning block is discarded
//   2. nothing constrained what may appear between </reasoning> and the JSON
//   3. nothing forbade writing the JSON inside the reasoning block
//
// ── WHY ASSERTING PROMPT TEXT IS LEGITIMATE HERE, GIVEN CLAUDE.md's WARNING ──
//
// CLAUDE.md warns that a test reading migration FILES proves history rather than present
// state, because migrations are append-only and a later one can undo the first. That does
// not apply here: the prompt is not append-only. buildSynthesisPrompt() returns the exact
// bytes sent to Anthropic on the next call, so asserting on its return value is asserting
// present state, not history.
//
// THE LIMIT, STATED SO IT IS NOT OVER-TRUSTED: this proves the instruction is SENT. It
// cannot prove the model OBEYS it. That is measured against output tokens on a real batch,
// and the measurement belongs in the ADR, not here. An instruction is advisory (ADR-028).

import { describe, it, expect } from 'vitest'
import { buildSynthesisPrompt } from '@/lib/agents/research/prompts/synthesis-prompt'

/** The minimum a prompt context needs. Both shapes are exercised below. */
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

describe('synthesis prompt: the working is written once and the answer once', () => {
  // BOTH BRANCHES. The OUTPUT FORMAT section interpolates ctx.fitDimensions in two places,
  // so a client with no dimension list takes different text through the same section. An
  // instruction that survives only one branch is half an instruction.
  for (const withDimensions of [true, false]) {
    const label = withDimensions ? 'with a fit dimension list' : 'without a fit dimension list'

    describe(label, () => {
      const prompt = buildSynthesisPrompt(ctx(withDimensions))

      it('says the reasoning block is discarded, so the model knows a second copy is wasted', () => {
        expect(prompt).toMatch(/strips it and throws it away/)
      })

      it('forbids writing the JSON inside the reasoning block', () => {
        expect(prompt).toMatch(/Do not write the JSON\s+inside it/)
      })

      it('says the next character after </reasoning> is the opening brace', () => {
        expect(prompt).toMatch(/After <\/reasoning> the very next character is the opening \{/)
      })

      it('names the exact restatement shapes that were observed, not a vague instruction', () => {
        // "## Reasoning" is named verbatim because that is the heading the model actually
        // used. A generic "be concise" would not have stopped it.
        expect(prompt).toContain('no "## Reasoning" section')
        expect(prompt).toMatch(/no restatement of the\s+analysis you have just done/)
      })

      it('still asks for the reasoning block itself, which is NOT what is being removed', () => {
        // The chain-of-thought is kept in full. Only the second copy goes. A change that
        // deleted the reasoning block would pass every assertion above and be a different,
        // much worse change.
        expect(prompt).toMatch(/reason through the research in a <reasoning> block/)
        expect(prompt).toContain('8. Qualification assessment')
      })

      it('still asks for the JSON', () => {
        expect(prompt).toMatch(/Output this exact JSON with no markdown fences/)
      })
    })
  }

  // THE ORDERING MATTERS AND IS EASY TO BREAK BY MOVING A PARAGRAPH. The instruction has
  // to sit between the numbered working items and the JSON schema. Placed above the items
  // it reads as being about something else; placed below the schema the model has already
  // emitted by the time it arrives.
  it('places the write-once instruction after the working items and before the JSON schema', () => {
    const prompt = buildSynthesisPrompt(ctx(true))
    const items    = prompt.indexOf('8. Qualification assessment')
    const writeOnce = prompt.indexOf('THE WORKING IS WRITTEN ONCE')
    const schema   = prompt.indexOf('Output this exact JSON')

    expect(items).toBeGreaterThan(-1)
    expect(writeOnce).toBeGreaterThan(items)
    expect(schema).toBeGreaterThan(writeOnce)
  })

  // GUARDS ITSELF against passing vacuously over an empty string, which is how a prompt
  // builder that silently returned '' would make every assertion above pass.
  it('the prompt builder returns substantial text in both branches', () => {
    expect(buildSynthesisPrompt(ctx(true)).length).toBeGreaterThan(5000)
    expect(buildSynthesisPrompt(ctx(false)).length).toBeGreaterThan(5000)
  })
})
