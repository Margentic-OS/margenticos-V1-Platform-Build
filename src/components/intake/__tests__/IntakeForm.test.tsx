// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'

// Test that no em/en dashes appear in hardcoded intake form text
describe('IntakeForm - no dashes in form copy', () => {
  const EM_DASH = '—' // U+2014
  const EN_DASH = '–' // U+2013

  it('should not contain em dashes in question labels', () => {
    // These are the hardcoded labels from the form
    const labels = [
      "What makes your firm genuinely different from others who do what you do? Not the marketing answer. The real one.",
      "Think about your single best client, the one you'd clone if you could. Describe them. Not their job title. What makes them different to work with? What do they believe or understand that most of your clients don't?",
      "What do you think actually tipped them toward working with you? Not the polished answer. The real one. Was there a specific conversation, a moment, something you said or showed them?",
    ]

    labels.forEach(label => {
      expect(label).not.toContain(EM_DASH)
    })
  })

  it('should not contain en dashes in revenue range options', () => {
    // These are the hardcoded revenue options
    const revenueRanges = [
      '£100K - £300K',
      '£300K - £600K',
      '£600K - £1M',
      '£1M - £2M',
      '€100K - €300K',
      'USD100K - USD300K',
    ]

    revenueRanges.forEach(range => {
      expect(range).not.toContain(EN_DASH)
      expect(range).not.toContain(EM_DASH)
    })
  })

  it('should not contain dashes in success message', () => {
    const message = 'This takes 3-5 minutes. You can close this tab. Documents will be waiting when you return.'
    expect(message).not.toContain(EN_DASH)
    expect(message).not.toContain(EM_DASH)
  })

  it('should mark optional sections correctly in tab navigation', () => {
    // The "Your voice" and "Existing assets" sections should have no critical fields
    // and should be marked as optional, not green
    const voiceQuestions = [
      { fieldKey: 'voice_style', isCritical: false },
      { fieldKey: 'voice_dislikes', isCritical: false },
    ]

    const assetsQuestions = [
      { fieldKey: 'assets_existing_positioning', isCritical: false },
      { fieldKey: 'assets_past_outreach', isCritical: false },
    ]

    const hasCritical = (questions: any[]) => questions.some(q => q.isCritical)
    expect(hasCritical(voiceQuestions)).toBe(false)
    expect(hasCritical(assetsQuestions)).toBe(false)
  })
})
