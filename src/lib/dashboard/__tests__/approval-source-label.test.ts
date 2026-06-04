import { describe, it, expect } from 'vitest'
import { approvalSourceLabel } from '../approval-source-label'

describe('approvalSourceLabel', () => {
  it('client approval shows "Approved by you"', () => {
    expect(approvalSourceLabel('client')).toBe('Approved by you')
  })

  it('operator approval shows "Approved by MargenticOS"', () => {
    expect(approvalSourceLabel('operator')).toBe('Approved by MargenticOS')
  })

  it('auto-approval shows "Auto-approved after the review window"', () => {
    expect(approvalSourceLabel('auto')).toBe('Auto-approved after the review window')
  })

  it('null source falls back to "Approved"', () => {
    expect(approvalSourceLabel(null)).toBe('Approved')
  })

  it('unknown source falls back to "Approved"', () => {
    expect(approvalSourceLabel('unknown')).toBe('Approved')
  })
})
