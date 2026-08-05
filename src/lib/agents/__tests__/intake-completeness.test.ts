import { describe, it, expect } from 'vitest'

// Test intake completeness calculation to ensure percentage and display format agree
describe('Intake completeness calculation', () => {
  interface IntakeRow {
    is_critical: boolean
    response_value: string | null
  }

  const calculateCompleteness = (intake: IntakeRow[]) => {
    const criticalRows = intake.filter(r => r.is_critical)
    const answeredRows = criticalRows.filter(r => r.response_value && r.response_value.trim().length > 0)
    const completeness = criticalRows.length > 0
      ? Math.round((answeredRows.length / criticalRows.length) * 100)
      : 0
    return { completeness, answeredCount: answeredRows.length, totalCount: criticalRows.length }
  }

  it('should calculate 100% when all critical fields are answered', () => {
    const intake: IntakeRow[] = Array.from({ length: 20 }, () => ({
      is_critical: true,
      response_value: 'answered',
    }))

    const { completeness, answeredCount, totalCount } = calculateCompleteness(intake)

    expect(completeness).toBe(100)
    expect(answeredCount).toBe(20)
    expect(totalCount).toBe(20)
  })

  it('should match percentage with display denominator', () => {
    // Scenario: 20 critical answered, 1 optional not answered
    const intake: IntakeRow[] = [
      ...Array.from({ length: 20 }, () => ({
        is_critical: true,
        response_value: 'answered',
      })),
      {
        is_critical: false,
        response_value: null,
      },
    ]

    const { completeness, answeredCount, totalCount } = calculateCompleteness(intake)

    // Display should show 100% (20/20 required)
    expect(completeness).toBe(100)
    expect(answeredCount).toBe(20)
    expect(totalCount).toBe(20)
    // NOT (20/21)
    expect(totalCount).not.toBe(21)
  })

  it('should calculate correct percentage for partial completion', () => {
    // Scenario: 15 answered out of 20 critical
    const intake: IntakeRow[] = [
      ...Array.from({ length: 15 }, () => ({
        is_critical: true,
        response_value: 'answered',
      })),
      ...Array.from({ length: 5 }, () => ({
        is_critical: true,
        response_value: null,
      })),
    ]

    const { completeness, answeredCount, totalCount } = calculateCompleteness(intake)

    expect(completeness).toBe(75)
    expect(answeredCount).toBe(15)
    expect(totalCount).toBe(20)
  })

  it('should ignore optional fields in calculation', () => {
    const intake: IntakeRow[] = [
      ...Array.from({ length: 15 }, () => ({
        is_critical: true,
        response_value: 'answered',
      })),
      ...Array.from({ length: 5 }, () => ({
        is_critical: true,
        response_value: null,
      })),
      ...Array.from({ length: 10 }, () => ({
        is_critical: false,
        response_value: 'answered',
      })),
    ]

    const { completeness, answeredCount, totalCount } = calculateCompleteness(intake)

    // Should only count critical fields
    expect(completeness).toBe(75)
    expect(answeredCount).toBe(15)
    expect(totalCount).toBe(20)
    // Optional fields (10) should NOT be included
    expect(totalCount).not.toBe(30)
  })

  it('should return 0% when no critical fields are answered', () => {
    const intake: IntakeRow[] = Array.from({ length: 20 }, () => ({
      is_critical: true,
      response_value: null,
    }))

    const { completeness, answeredCount, totalCount } = calculateCompleteness(intake)

    expect(completeness).toBe(0)
    expect(answeredCount).toBe(0)
    expect(totalCount).toBe(20)
  })

  it('should handle empty intake', () => {
    const intake: IntakeRow[] = []

    const { completeness, answeredCount, totalCount } = calculateCompleteness(intake)

    expect(completeness).toBe(0)
    expect(answeredCount).toBe(0)
    expect(totalCount).toBe(0)
  })

  it('should trim whitespace when checking if field is answered', () => {
    const intake: IntakeRow[] = [
      { is_critical: true, response_value: '   ' }, // just whitespace
      { is_critical: true, response_value: 'text' },
    ]

    const { completeness, answeredCount, totalCount } = calculateCompleteness(intake)

    // Only the second one counts as answered
    expect(completeness).toBe(50)
    expect(answeredCount).toBe(1)
    expect(totalCount).toBe(2)
  })
})
