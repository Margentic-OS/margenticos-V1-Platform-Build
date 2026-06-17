// src/lib/metrics/get-client-visible-campaign-metrics.ts
//
// SINGLE CHOKEPOINT for all client-facing campaign metrics reads.
// ALL client views of campaign metrics must go through this function.
// Enforces org-scoping + client-safe metric filtering at the QUERY LAYER
// (explicit column SELECT, no diagnostic data fetched into client code).
//
// Per ADR-026 pattern: org-scoping gets RLS backstop; client-safe filtering
// is application-enforced only (chokepoint pattern).
//
// CRITICAL: This function MUST SELECT ONLY client-safe columns (not bounced_count,
// not any diagnostic field). The returned type excludes diagnostic fields. The
// query reflects this by selecting only health metrics. Runtime assertion in tests
// proves the returned object has no bouncedCount, confirming the query did not fetch it.

import { SupabaseClient } from '@supabase/supabase-js'
import { Database } from '@/types/database'

type SupabaseServiceClient = SupabaseClient<Database>

export interface ClientVisibleCampaignMetrics {
  sentCount: number
  repliedCount: number
  replyRate: number | null
  positiveReplyCount: number
  meetingCount: number
  hasData: boolean
}

/**
 * Fetches campaign metrics visible to a client.
 * SINGLE CHOKEPOINT: all client-facing campaign metric reads must use this function.
 *
 * Enforces both filters at the data layer:
 *   1. organisation_id = clientOrgId (org-scoping, backed by RLS)
 *   2. SELECT only client-safe columns (health metrics: sent, replied, open)
 *      NEVER SELECT: bounced_count, complaint_rate, mailbox_health
 *
 * Returns only health metrics. Never includes diagnostic fields.
 * The returned type cannot include bouncedCount, complaintRate, etc.
 */
export async function getClientVisibleCampaignMetrics(
  supabase: SupabaseServiceClient,
  clientOrgId: string
): Promise<ClientVisibleCampaignMetrics> {
  const [campaignsResult, positiveRepliesResult, meetingsResult] = await Promise.all([
    supabase
      .from('campaigns')
      .select('sent_count, replied_count')
      .eq('organisation_id', clientOrgId),

    supabase
      .from('signals')
      .select('*', { count: 'exact', head: true })
      .eq('organisation_id', clientOrgId)
      .eq('signal_type', 'positive_reply'),

    supabase
      .from('meetings')
      .select('*', { count: 'exact', head: true })
      .eq('organisation_id', clientOrgId),
  ])

  const campaigns = campaignsResult.data ?? []
  const sentCount = campaigns.reduce((sum, c) => sum + (c.sent_count ?? 0), 0)
  const repliedCount = campaigns.reduce((sum, c) => sum + (c.replied_count ?? 0), 0)
  const positiveReplyCount = positiveRepliesResult.count ?? 0
  const meetingCount = meetingsResult.count ?? 0

  const replyRate = sentCount > 0 ? (repliedCount / sentCount) * 100 : null

  return {
    sentCount,
    repliedCount,
    replyRate,
    positiveReplyCount,
    meetingCount,
    hasData: sentCount > 0,
  }
}

export interface AllCampaignMetrics extends ClientVisibleCampaignMetrics {
  bouncedCount: number
}

/**
 * Fetches ALL campaign metrics for an organisation (operator only, no filtering).
 * Returns all metrics including diagnostic data (bounce, complaint, mailbox health).
 * Used by the operator per-client view to monitor deliverability.
 */
export async function getAllCampaignMetricsForOrg(
  supabase: SupabaseServiceClient,
  orgId: string
): Promise<AllCampaignMetrics> {
  const [campaignsResult, positiveRepliesResult, meetingsResult] = await Promise.all([
    supabase
      .from('campaigns')
      .select('sent_count, replied_count, bounced_count')
      .eq('organisation_id', orgId),

    supabase
      .from('signals')
      .select('*', { count: 'exact', head: true })
      .eq('organisation_id', orgId)
      .eq('signal_type', 'positive_reply'),

    supabase
      .from('meetings')
      .select('*', { count: 'exact', head: true })
      .eq('organisation_id', orgId),
  ])

  const campaigns = campaignsResult.data ?? []
  const sentCount = campaigns.reduce((sum, c) => sum + (c.sent_count ?? 0), 0)
  const repliedCount = campaigns.reduce((sum, c) => sum + (c.replied_count ?? 0), 0)
  const bouncedCount = campaigns.reduce((sum, c) => sum + (c.bounced_count ?? 0), 0)
  const positiveReplyCount = positiveRepliesResult.count ?? 0
  const meetingCount = meetingsResult.count ?? 0

  const replyRate = sentCount > 0 ? (repliedCount / sentCount) * 100 : null

  return {
    sentCount,
    repliedCount,
    replyRate,
    positiveReplyCount,
    meetingCount,
    bouncedCount,
    hasData: sentCount > 0,
  }
}
