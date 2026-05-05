// Shared utility for computing campaign performance metrics from the DB.
// Called by the Benchmarks page and the Pipeline page (reply rate card).
//
// ADR-001: No external API calls here. This utility reads from the DB only.
//          Instantly is called by the handler (campaign-analytics.ts) which
//          writes to campaigns. This utility reads the result.
//
// ADR-003: organisation_id = orgId filter on every query. No exceptions.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface CampaignMetrics {
  sentCount:           number
  replyCount:          number
  bounceCount:         number
  positiveReplyCount:  number
  meetingCount:        number
  // true when sentCount > 0 — callers should not render rate values when false
  hasData:             boolean
}

export async function computeCampaignMetrics(
  orgId: string,
  supabase: SupabaseClient
): Promise<CampaignMetrics> {
  const [campaignsResult, positiveRepliesResult, meetingsResult] = await Promise.all([
    // Sum sent/reply/bounce counts across all campaigns for this org
    supabase
      .from('campaigns')
      .select('sent_count, replied_count, bounced_count')
      .eq('organisation_id', orgId),

    // Positive reply count — signals table is the only source for this
    supabase
      .from('signals')
      .select('*', { count: 'exact', head: true })
      .eq('organisation_id', orgId)
      .eq('signal_type', 'positive_reply'),

    // Total meetings booked for this org
    supabase
      .from('meetings')
      .select('*', { count: 'exact', head: true })
      .eq('organisation_id', orgId),
  ])

  const campaigns = campaignsResult.data ?? []
  const sentCount    = campaigns.reduce((sum, c) => sum + (c.sent_count    ?? 0), 0)
  const replyCount   = campaigns.reduce((sum, c) => sum + (c.replied_count ?? 0), 0)
  const bounceCount  = campaigns.reduce((sum, c) => sum + (c.bounced_count ?? 0), 0)
  const positiveReplyCount = positiveRepliesResult.count ?? 0
  const meetingCount       = meetingsResult.count        ?? 0

  return {
    sentCount,
    replyCount,
    bounceCount,
    positiveReplyCount,
    meetingCount,
    hasData: sentCount > 0,
  }
}
