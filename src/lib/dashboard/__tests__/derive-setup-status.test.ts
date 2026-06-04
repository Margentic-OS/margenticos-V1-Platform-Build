import { describe, it, expect } from 'vitest'
import { deriveCampaignsStatus } from '../derive-setup-status'

describe('deriveCampaignsStatus', () => {
  it('returns pending when no campaigns are registered', () => {
    expect(deriveCampaignsStatus([], 0)).toBe('pending')
    expect(deriveCampaignsStatus([], 50)).toBe('pending')
  })

  it('returns in_progress when campaigns exist but no shell is synced', () => {
    const campaigns = [{ shell_synced_at: null }, { shell_synced_at: null }]
    expect(deriveCampaignsStatus(campaigns, 0)).toBe('in_progress')
    expect(deriveCampaignsStatus(campaigns, 100)).toBe('in_progress')
  })

  it('returns in_progress when shell is synced but no leads have been uploaded', () => {
    const campaigns = [{ shell_synced_at: '2026-06-01T10:00:00Z' }]
    expect(deriveCampaignsStatus(campaigns, 0)).toBe('in_progress')
  })

  it('returns complete when campaigns exist, shell is synced, and leads are uploaded', () => {
    const campaigns = [{ shell_synced_at: '2026-06-01T10:00:00Z' }]
    expect(deriveCampaignsStatus(campaigns, 1)).toBe('complete')
    expect(deriveCampaignsStatus(campaigns, 500)).toBe('complete')
  })

  it('returns complete when only one campaign has a synced shell', () => {
    const campaigns = [
      { shell_synced_at: null },
      { shell_synced_at: '2026-06-01T10:00:00Z' },
    ]
    expect(deriveCampaignsStatus(campaigns, 10)).toBe('complete')
  })

  // LinkedIn status is manual — deriveCampaignsStatus intentionally has no
  // knowledge of it. Verified by the function signature: it only accepts
  // campaign and upload data, never linkedin state.
  it('accepts no LinkedIn input — LinkedIn status is manual and not derived', () => {
    const fn = deriveCampaignsStatus
    expect(fn.length).toBe(2) // exactly 2 params: campaigns + uploadedCount
  })
})
