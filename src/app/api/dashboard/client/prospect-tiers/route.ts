import { createClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { redirect } from 'next/navigation'
import { logger } from '@/lib/logger'
import type { Database } from '@/types/database'

const TIER_ORDER = ['tier_1', 'tier_2', 'tier_3'] as const
const AUTO_SANCTION_DAYS = 4

interface TierData {
  tier: typeof TIER_ORDER[number]
  tier_created_at: string | null
  total_count: number
  rejected_count: number
  sample_prospects: Array<{
    id: string
    first_name: string | null
    last_name: string | null
    company_name: string | null
    role: string | null
    personalisation_trigger: string | null
    client_review_status: string | null
  }>
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
  // ── 1. Get tier published date (anchor for auto-sanction clock) ──────────
  // If tier_published_at is NULL, the tier hasn't been published yet (client can't see it)
  // Auto-sanction clock starts from tier_published_at, not tier_created_at
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

  // ── 1b. Get tier created date (first prospect in tier) ────────────────────
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

  // ── 2. Check if tier is locked (durable: any prospect reached 'uploaded') ───
  // Lock persists across stale-lock reclaim because 'uploaded' is terminal.
  // 'uploading' is transient but also blocks during in-flight sends.
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

  // ── 3. Apply lazy-write auto-sanction if needed ──────────────────────────
  // Only auto-sanction if tier has been published (tier_published_at IS NOT NULL)
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
      .is('client_review_auto_approved_at', null) // Idempotent: only once

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

  // ── 4. Get counts (only published tiers visible to client) ───────────────
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

  const prospects = countsData ?? []
  const totalCount = prospects.length
  const approvedCount = prospects.filter(p => p.client_review_status === 'approved').length
  const rejectedCount = prospects.filter(p => p.client_review_status === 'rejected').length
  const pendingCount = prospects.filter(p => p.client_review_status === null || p.client_review_status === 'pending_review').length

  // ── 5. Determine tier sanction status ─────────────────────────────────────
  let tierSanctionStatus: TierData['tier_sanction_status'] = 'pending_review'
  if (pendingCount === 0) {
    if (rejectedCount === 0) {
      // All approved — was it auto or manual?
      tierSanctionStatus = isAutoSanctioned ? 'sanctioned_auto' : 'sanctioned_by_client'
    } else if (approvedCount > 0) {
      tierSanctionStatus = 'partially_rejected'
    }
  } else if (rejectedCount > 0) {
    tierSanctionStatus = 'partially_rejected'
  }

  // ── 6. Sample 5 prospects (stable order by id, published only) ───────────
  const { data: sampleData, error: sampleError } = await adminClient
    .from('prospects')
    .select('id, first_name, last_name, company_name, role, personalisation_trigger, client_review_status')
    .eq('organisation_id', orgId)
    .eq('sourced_tier', tier)
    .not('tier_published_at', 'is', null)
    .in('client_review_status', [null, 'pending_review'])
    .eq('suppressed', false)
    .order('id', { ascending: true })
    .limit(5)

  if (sampleError) {
    logger.error('getTierData: failed to fetch sample prospects', {
      organisation_id: orgId,
      tier,
      error: sampleError.message,
    })
    throw sampleError
  }

  const sampleProspects = (sampleData ?? []).map(p => ({
    id: p.id,
    first_name: p.first_name,
    last_name: p.last_name,
    company_name: p.company_name,
    role: p.role,
    personalisation_trigger: p.personalisation_trigger,
    client_review_status: p.client_review_status,
  }))

  return {
    tier,
    tier_created_at: tierCreatedAt,
    total_count: totalCount,
    rejected_count: rejectedCount,
    sample_prospects: sampleProspects,
    tier_sanction_status: tierSanctionStatus,
    is_auto_sanctioned: isAutoSanctioned,
    is_auto_sanctioned_now: isAutoSanctioned && !tierIsLocked, // True if just auto-sanctioned on this read
    auto_sanction_at: autoSanctionDate ?? new Date().toISOString(),
    tier_is_locked: tierIsLocked,
  }
}

export async function GET() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Fetch user's organisation_id
    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('organisation_id')
      .eq('id', user.id)
      .single()

    if (userError || !userRow?.organisation_id) {
      return Response.json({ error: 'Organisation not found for user' }, { status: 404 })
    }

    const organisationId = userRow.organisation_id

    // Create admin client to bypass RLS (clients must see their own org's prospects)
    const adminClient = createServiceClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // Fetch tier data in parallel
    const tierDataArray = await Promise.all(
      TIER_ORDER.map(tier => getTierData(adminClient, organisationId, tier))
    )

    return Response.json({
      ok: true,
      tiers: tierDataArray,
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger.error('prospect-tiers GET: failed', {
      user_id: user.id,
      error: errorMsg,
    })
    return Response.json(
      { error: `Failed to fetch tiers: ${errorMsg}` },
      { status: 500 }
    )
  }
}
