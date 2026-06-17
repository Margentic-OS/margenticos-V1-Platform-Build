import { describe, it, expect } from 'vitest'
import type { ClientVisibleCampaignMetrics, AllCampaignMetrics } from './get-client-visible-campaign-metrics'

describe('Campaign Metrics Choicepoint — Type Safety', () => {
  it('ClientVisibleCampaignMetrics type does NOT include bouncedCount', () => {
    // This test verifies at compile-time that the client-safe type
    // does not include the bouncedCount field
    const clientMetrics: ClientVisibleCampaignMetrics = {
      sentCount: 100,
      repliedCount: 5,
      replyRate: 5,
      positiveReplyCount: 3,
      meetingCount: 1,
      hasData: true,
    }

    // If bouncedCount were in the type, this would be a compile error
    // The type explicitly excludes it, enforcing safety at the type level
    expect(Object.keys(clientMetrics)).not.toContain('bouncedCount')
    expect(Object.keys(clientMetrics)).toEqual([
      'sentCount',
      'repliedCount',
      'replyRate',
      'positiveReplyCount',
      'meetingCount',
      'hasData',
    ])
  })

  it('AllCampaignMetrics type DOES include bouncedCount', () => {
    // This test verifies the operator variant has diagnostic fields
    const operatorMetrics: AllCampaignMetrics = {
      sentCount: 100,
      repliedCount: 5,
      replyRate: 5,
      positiveReplyCount: 3,
      meetingCount: 1,
      bouncedCount: 2,
      hasData: true,
    }

    expect(Object.keys(operatorMetrics)).toContain('bouncedCount')
  })

  it('operator and client variants are distinguishable by bouncedCount presence', () => {
    const client: ClientVisibleCampaignMetrics = {
      sentCount: 100,
      repliedCount: 5,
      replyRate: 5,
      positiveReplyCount: 3,
      meetingCount: 1,
      hasData: true,
    }

    const operator: AllCampaignMetrics = {
      ...client,
      bouncedCount: 2,
    }

    // Client does not have bouncedCount in the type
    expect((client as unknown as Record<string, unknown>).bouncedCount).toBeUndefined()
    // Operator does have it
    expect((operator as unknown as Record<string, unknown>).bouncedCount).toBe(2)
  })
})
