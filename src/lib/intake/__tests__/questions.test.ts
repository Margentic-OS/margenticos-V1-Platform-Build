import { describe, it, expect } from 'vitest'
import {
  ALL_QUESTIONS,
  CRITICAL_QUESTIONS,
  criticalCompleteness,
  mergeIntakeWithQuestions,
  reconcileRevenueRange,
} from '@/lib/intake/questions'

describe('completeness is measured against the question set', () => {
  // THE DEFECT THIS PINS. Completeness used to be answered-rows / rows-that-exist. A row only
  // exists once a client has been shown the question, so a question added after they finished
  // their intake was missing from BOTH halves and they stayed at 100% on a question they had
  // never been asked. One organisation carries two such fields today.
  it('counts a question with no row at all against the client', () => {
    const everyCriticalAnswered = CRITICAL_QUESTIONS.map(q => ({
      field_key: q.fieldKey,
      response_value: 'answered',
    }))

    expect(criticalCompleteness(everyCriticalAnswered).ratio).toBe(1)

    // Drop one row entirely, exactly as a client predating that question would have.
    const oneNeverAsked = everyCriticalAnswered.slice(1)
    const result = criticalCompleteness(oneNeverAsked)

    expect(result.critical).toBe(CRITICAL_QUESTIONS.length)
    expect(result.answered).toBe(CRITICAL_QUESTIONS.length - 1)
    expect(result.ratio).toBeLessThan(1)
  })

  it('does not let rows for retired questions inflate the denominator', () => {
    const rows = [
      ...CRITICAL_QUESTIONS.map(q => ({ field_key: q.fieldKey, response_value: 'answered' })),
      { field_key: 'a_question_the_form_no_longer_asks', response_value: 'x', is_critical: true },
    ]
    expect(criticalCompleteness(rows).critical).toBe(CRITICAL_QUESTIONS.length)
  })
})

describe('merging stored rows with the question set', () => {
  it('presents an unasked question as an unanswered one so the agent can see it', () => {
    const merged = mergeIntakeWithQuestions([])
    expect(merged).toHaveLength(ALL_QUESTIONS.length)
    expect(merged.every(r => r.response_value === null)).toBe(true)
    expect(merged.every(r => r.never_presented)).toBe(true)
  })

  it('marks a stored blank answer differently from a question never presented', () => {
    const key = ALL_QUESTIONS[0].fieldKey
    const merged = mergeIntakeWithQuestions([{ field_key: key, response_value: '' }])
    expect(merged.find(r => r.field_key === key)?.never_presented).toBe(false)
    expect(merged.find(r => r.field_key !== key)?.never_presented).toBe(true)
  })

  // Retired questions keep their answers in the table, and those answers are the client's own
  // words. A merge that dropped them would quietly shrink what every agent is given.
  it('keeps an answered row whose question the form has retired', () => {
    const merged = mergeIntakeWithQuestions([
      { field_key: 'retired_question', response_value: 'real client words', field_label: 'Old Q' },
    ])
    const kept = merged.find(r => r.field_key === 'retired_question')
    expect(kept?.response_value).toBe('real client words')
    expect(kept?.is_critical).toBe(false)
  })

  it('drops a retired question that was never answered', () => {
    const merged = mergeIntakeWithQuestions([{ field_key: 'retired_question', response_value: '' }])
    expect(merged.find(r => r.field_key === 'retired_question')).toBeUndefined()
  })
})

describe('revenue range reconciliation on a currency change', () => {
  // Both of these are real stored values. Neither matches any option the form offers, so the
  // select showed the placeholder while the row kept the old answer.
  it('re-symbolises a band whose currency no longer matches', () => {
    expect(reconcileRevenueRange('Under £100K', 'EUR')).toBe('Under €100K')
  })

  it('recognises a stored band written with a different dash', () => {
    expect(reconcileRevenueRange('£600K–£1M', 'EUR')).toBe('€600K - €1M')
  })

  it('clears an answer that is not a band the form has ever offered', () => {
    expect(reconcileRevenueRange('roughly two million', 'EUR')).toBe('')
  })

  it('never returns the stored value unchanged when the currency changes', () => {
    expect(reconcileRevenueRange('Over €2M', 'GBP')).not.toBe('Over €2M')
  })
})
