// Shared logic for fetching client prospect tiers data
// Used by both the page (direct call) and API route (wrapped endpoint)

import { createClient as createServiceClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type { Database } from '@/types/database'

const TIER_ORDER = ['tier_1', 'tier_2', 'tier_3'] as const
const AUTO_SANCTION_DAYS = 4

export interface Prospect {
  id: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  job_title: string | null
  linkedin_url: string | null
  website_url: string | null
  client_review_status: string | null
  client_review_reason: string | null
  // The batch a prospect entered the campaign with. The roster groups on this, so a
  // prospect that becomes sendable later joins whichever batch actually uploads it.
  outbound_upload_attempted_at: string | null
  email_send_eligible: boolean | null
}

export interface TierData {
  tier: typeof TIER_ORDER[number]
  tier_created_at: string | null
  total_count: number
  rejected_count: number
  prospects: Prospect[]
  tier_sanction_status: 'pending_review' | 'sanctioned_by_client' | 'sanctioned_auto' | 'partially_rejected'
  is_auto_sanctioned: boolean
  is_auto_sanctioned_now: boolean
  auto_sanction_at: string
  tier_is_locked: boolean
}

async function getTierData(
  adminClient: ReturnType<typeof createServiceClient<Database>>,
  orgId: string,
  tier: typeof TIER_ORDER[number],
): Promise<TierData> {
  const { data: tierPublishedData, error: tierPublishedError } = await adminClient
    .from('prospects')
    .select('tier_published_at')
    .eq('organisation_id', orgId)
    .eq('sourced_tier', tier)
    .eq('suppressed', false)
    .not('tier_published_at', 'is', null)
    .order('tier_published_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (tierPublishedError) {
    logger.error('getTierData: failed to fetch tier published date', {
      organisation_id: orgId,
      tier,
      error: tierPublishedError.message,
    })
    throw tierPublishedError
  }

  const tierPublishedAt = tierPublishedData?.tier_published_at ?? null
  const now = new Date()
  const autoSanctionDate = tierPublishedAt
    ? new Date(new Date(tierPublishedAt).getTime() + AUTO_SANCTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
    : null
  const isAutoSanctioned = tierPublishedAt ? new Date(tierPublishedAt).getTime() < now.getTime() - AUTO_SANCTION_DAYS * 24 * 60 * 60 * 1000 : false

  const { data: tierCreatedData, error: tierCreatedError } = await adminClient
    .from('prospects')
    .select('created_at')
    .eq('organisation_id', orgId)
    .eq('sourced_tier', tier)
    .eq('suppressed', false)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (tierCreatedError) {
    logger.warn('getTierData: failed to fetch tier created date', {
      organisation_id: orgId,
      tier,
      error: tierCreatedError.message,
    })
  }

  const tierCreatedAt = tierCreatedData?.created_at ?? null

  const { data: sendingData, error: sendingError } = await adminClient
    .from('prospects')
    .select('id')
    .eq('organisation_id', orgId)
    .eq('sourced_tier', tier)
    .or('outbound_upload_status.eq.uploaded,outbound_upload_status.eq.uploading')
    .limit(1)

  if (sendingError) {
    logger.error('getTierData: failed to check if tier is locked', {
      organisation_id: orgId,
      tier,
      error: sendingError.message,
    })
    throw sendingError
  }

  const tierIsLocked = (sendingData ?? []).length > 0

  if (isAutoSanctioned && !tierIsLocked && tierPublishedAt) {
    const { error: autoSanctionError } = await adminClient
      .from('prospects')
      .update({
        client_review_status: 'approved',
        client_review_auto_approved_at: now.toISOString(),
      })
      .eq('organisation_id', orgId)
      .eq('sourced_tier', tier)
      .not('tier_published_at', 'is', null)
      .in('client_review_status', [null, 'pending_review'])
      .eq('suppressed', false)
      .is('client_review_auto_approved_at', null)

    if (autoSanctionError) {
      logger.warn('getTierData: auto-sanction write failed (non-blocking)', {
        organisation_id: orgId,
        tier,
        error: autoSanctionError.message,
      })
    } else {
      logger.info('getTierData: auto-sanctioned tier', {
        organisation_id: orgId,
        tier,
        timestamp: now.toISOString(),
      })
    }
  }

  const { data: countsData, error: countsError } = await adminClient
    .from('prospects')
    .select('client_review_status', { count: 'exact' })
    .eq('organisation_id', orgId)
    .eq('sourced_tier', tier)
    .not('tier_published_at', 'is', null)
    .eq('suppressed', false)

  if (countsError) {
    logger.error('getTierData: failed to fetch prospect counts', {
      organisation_id: orgId,
      tier,
      error: countsError.message,
    })
    throw countsError
  }

  const statusCounts = countsData ?? []
  const totalCount = statusCounts.length
  const approvedCount = statusCounts.filter(p => p.client_review_status === 'approved').length
  const rejectedCount = statusCounts.filter(p => p.client_review_status === 'rejected').length
  const pendingCount = statusCounts.filter(p => p.client_review_status === null || p.client_review_status === 'pending_review').length

  let tierSanctionStatus: TierData['tier_sanction_status'] = 'pending_review'
  if (pendingCount === 0) {
    if (rejectedCount === 0) {
      tierSanctionStatus = isAutoSanctioned ? 'sanctioned_auto' : 'sanctioned_by_client'
    } else if (approvedCount > 0) {
      tierSanctionStatus = 'partially_rejected'
    }
  } else if (rejectedCount > 0) {
    tierSanctionStatus = 'partially_rejected'
  }

  const { data: prospectData, error: prospectError } = await adminClient
    .from('prospects')
    .select('id, first_name, last_name, company_name, job_title, linkedin_url, website_url, client_review_status, client_review_reason, outbound_upload_attempted_at, email_send_eligible')
    .eq('organisation_id', orgId)
    .eq('sourced_tier', tier)
    .not('tier_published_at', 'is', null)
    .eq('suppressed', false)
    .order('id', { ascending: true })

  if (prospectError) {
    logger.error('getTierData: failed to fetch prospects', {
      organisation_id: orgId,
      tier,
      error: prospectError.message,
    })
    throw prospectError
  }

  const prospects = (prospectData ?? []).map(p => ({
    id: p.id,
    first_name: p.first_name,
    last_name: p.last_name,
    company_name: p.company_name,
    job_title: p.job_title,
    linkedin_url: p.linkedin_url,
    website_url: p.website_url,
    client_review_status: p.client_review_status,
    client_review_reason: p.client_review_reason,
    outbound_upload_attempted_at: p.outbound_upload_attempted_at,
    email_send_eligible: p.email_send_eligible,
  }))

  return {
    tier,
    tier_created_at: tierCreatedAt,
    total_count: totalCount,
    rejected_count: rejectedCount,
    prospects,
    tier_sanction_status: tierSanctionStatus,
    is_auto_sanctioned: isAutoSanctioned,
    is_auto_sanctioned_now: isAutoSanctioned && !tierIsLocked,
    auto_sanction_at: autoSanctionDate ?? new Date().toISOString(),
    tier_is_locked: tierIsLocked,
  }
}

/**
 * Main entry point: fetch the prospect tiers for ONE organisation.
 *
 * The caller is responsible for having resolved clientOrgId through the session client
 * (resolveViewingOrg). This function trusts that id and scopes every query to it.
 *
 * IT MUST NOT RESOLVE THE ORGANISATION ITSELF. It used to read users.organisation_id here,
 * which made it a SECOND resolver that disagreed with the one the page header uses. Under
 * an operator's "View as client" the header named the organisation from ?client= while
 * this function read the operator's OWN organisation_id, and because every query below
 * runs through a service-role client, RLS never caught the mismatch.
 *
 * Measured 2026-09-08: doug@margenticos.com is pinned to "ARCHIVE 2026-04 do not use",
 * which holds 12 prospects and none tiered, so the live organisation's roster of 103
 * rendered as "No prospects yet" on a URL that named the live organisation.
 *
 * Same class as the sidebar fix in c9b04f2, which fixed one resolver and left this one.
 */
export async function getClientProspectTiers(
  clientOrgId: string,
): Promise<TierData[]> {
  // Create admin client to bypass RLS
  const adminClient = createServiceClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  // Fetch tier data in parallel
  const tierDataArray = await Promise.all(
    TIER_ORDER.map(tier => getTierData(adminClient, clientOrgId, tier))
  )

  return tierDataArray
}
