// A retry must tell the model what it measured and what the target was.
//
// BEFORE THIS, A RETRY WAS TOLD NOTHING AT ALL. buildSingleVariantUserMessage took the
// angle and the taken-copy list and no failure detail, so each attempt was an independent
// sample from the same distribution rather than a correction. Measured 2026-08-28,
// variant B failed the Email 2 word gate four times running at 79, 68, 71 and 69 words.
// Four full API calls, and not one of those prompts mentioned a word count.
//
// The assertion is on NUMBERS, not on wording. "Email 2 is too long" is a direction the
// model has to guess against; "word count 74 is outside the 30 to 85 word range" names
// the measurement and the target.

import { describe, it, expect } from 'vitest'
import { buildPriorAttemptBlock, type ValidationViolation } from '../messaging-generation-agent'

describe('buildPriorAttemptBlock', () => {
  it('is empty when there is no prior attempt, so a first pass carries no block', () => {
    expect(buildPriorAttemptBlock([])).toBe('')
  })

  it('carries the measured value and the target verbatim', () => {
    const violations: ValidationViolation[] = [
      { email: 2, issue: 'word count 74 is outside the 30 to 85 word range' },
    ]
    const block = buildPriorAttemptBlock(violations)

    // The measured value and both band bounds survive into the prompt.
    expect(block).toContain('74')
    expect(block).toContain('30 to 85')
    expect(block).toContain('Email 2')
  })

  it('lists every violation, not just the first', () => {
    const violations: ValidationViolation[] = [
      { email: 2, issue: 'word count 86 is outside the 30 to 85 word range' },
      { email: 1, issue: 'body uses internal jargon "ICP"' },
      { email: 3, issue: 'word count 71 is longer than email 2 at 60 words' },
    ]
    const block = buildPriorAttemptBlock(violations)

    expect(block).toContain('86')
    expect(block).toContain('ICP')
    expect(block).toContain('71')
    expect(block).toContain('60')
  })

  it('tells the model to correct rather than restart, so passing content is not churned', () => {
    const block = buildPriorAttemptBlock([{ email: 2, issue: 'word count 90 is outside the 30 to 85 word range' }])
    expect(block.toLowerCase()).toContain('correction')
  })
})
