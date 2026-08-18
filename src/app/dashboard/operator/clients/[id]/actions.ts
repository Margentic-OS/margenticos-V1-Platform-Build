'use server'

import * as Sentry from '@sentry/nextjs'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { validateCampaign } from '@/lib/integrations/handlers/instantly/validateCampaign'
import { uploadLeads } from '@/lib/integrations/handlers/instantly/uploadLeads'
import { orderMailboxes } from '@/lib/integrations/handlers/instantly/orderMailboxes'
import { syncSequenceShell, getDocStepCount } from '@/lib/integrations/handlers/instantly/syncSequenceShell'
import { assertStrategyApproved } from '@/lib/approval/assertStrategyApproved'
import {
  fetchComposeDocs,
  composeSequence,
  getComposeServiceClient,
} from '@/lib/composition/compose-sequence'
import { composedToVariables, assertCompleteVariables } from '@/lib/composition/custom-variables'
import { logger } from '@/lib/logger'
import { sendTransactionalEmail } from '@/lib/email/send'
import type { ProspectForUpload, DfyOrderResult } from '@/lib/integrations/handlers/instantly/types'

export type SetupStatusField = 'campaigns' | 'linkedin'
export type SetupStatusValue = 'pending' | 'in_progress' | 'complete'

const VALID_SETUP_FIELDS: SetupStatusField[] = ['campaigns', 'linkedin']
const VALID_SETUP_VALUES: SetupStatusValue[] = ['pending', 'in_progress', 'complete']

export async function updateSetupStatus(
  orgId: string,
  field: SetupStatusField,
  value: SetupStatusValue,
): Promise<{ error?: string }> {
  if (!(VALID_SETUP_FIELDS as string[]).includes(field)) {
    return { error: `Invalid setup status field: ${field}` }
  }
  if (!(VALID_SETUP_VALUES as string[]).includes(value)) {
    return { error: `Invalid setup status value: ${value}` }
  }

  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  const { data: org, error: fetchErr } = await supabase
    .from('organisations')
    .select('setup_status')
    .eq('id', orgId)
    .maybeSingle()

  if (fetchErr || !org) {
    return { error: 'Organisation not found' }
  }

  const current = (org.setup_status as Record<string, string> | null) ?? {}
  const updated = { ...current, [field]: value }

  const { error: updateErr } = await supabase
    .from('organisations')
    .update({ setup_status: updated })
    .eq('id', orgId)

  if (updateErr) {
    return { error: updateErr.message }
  }

  return {}
}

// ── Campaign actions ──────────────────────────────────────────────────────────

export type CampaignCheckResult =
  | { ok: true; name: string; status: string; schedulingStatus: string | null }
  | { ok: false; error: string }

export async function checkCampaign(
  orgId: string,
  campaignUuid: string,
): Promise<CampaignCheckResult> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  const { data: existing } = await supabase
    .from('campaigns')
    .select('id')
    .eq('organisation_id', orgId)
    .eq('external_id', campaignUuid)
    .maybeSingle()

  if (existing) {
    return { ok: false, error: 'This campaign UUID is already registered for this client.' }
  }

  try {
    const result = await validateCampaign(orgId, campaignUuid)
    return { ok: true, ...result }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export type RegisterCampaignResult =
  | { ok: true; campaignId: string }
  | { ok: false; error: string }

export async function registerCampaign(
  orgId: string,
  campaignUuid: string,
  campaignName: string,
): Promise<RegisterCampaignResult> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  const { data: existing } = await supabase
    .from('campaigns')
    .select('id')
    .eq('organisation_id', orgId)
    .eq('external_id', campaignUuid)
    .maybeSingle()

  if (existing) {
    return { ok: false, error: 'This campaign UUID is already registered.' }
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('campaigns')
    .insert({
      organisation_id: orgId,
      external_id: campaignUuid,
      name: campaignName,
      campaign_type: 'cold_email',
      status: 'draft',
    })
    .select('id')
    .single()

  if (insertErr || !inserted) {
    return { ok: false, error: insertErr?.message ?? 'Insert failed' }
  }

  return { ok: true, campaignId: inserted.id }
}

// ── Lead upload actions ───────────────────────────────────────────────────────

export type CampaignOutcome =
  | { external_id: string; ok: true; created: number; duplicated: number; in_blocklist: number; invalid: number; incomplete: number; attempted: number }
  | { external_id: string; ok: false; error: string }

export type BlockedSegmentReason = {
  segmentId: string | null
  segmentName: string | null
  pendingDocs: string[]
}

export type ShellBlockedReason = {
  campaignExternalId: string
  reason: 'no_shell' | 'shell_out_of_sync'
  docStepCount: number
  shellStepCount: number | null
}

export type UploadLeadsResult =
  | {
      ok: true
      outcomes: CampaignOutcome[]
      hasPartialFailure: boolean
      blockedSegments: BlockedSegmentReason[]
      shellBlockedCampaigns: ShellBlockedReason[]
      compositionFailureCount: number
    }
  | { ok: false; error: string }

// Compose chunk size — processing in bounded batches keeps request duration finite.
// BACKLOG: upgrade to background job queue when volumes exceed ~50 leads/request.
const COMPOSE_CHUNK_SIZE = 50

type ProspectRow = {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  role: string | null
  segment_id: string | null
  campaigns: { id: string; external_id: string | null; shell_step_count: number | null; shell_segment_id: string | null } | null
}

export async function handleUploadLeads(orgId: string): Promise<UploadLeadsResult> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  return Sentry.withServerActionInstrumentation('handleUploadLeads', async (): Promise<UploadLeadsResult> => {
  let shouldReclaim = true
  let reclamIds = new Set<string>()

  try {

  // Resolve primary segment once.
  const { data: primarySeg } = await supabase
    .from('segments')
    .select('id')
    .eq('organisation_id', orgId)
    .eq('is_default', true)
    .maybeSingle()
  const primarySegmentId = primarySeg?.id ?? null

  // ── Reclaim stale uploading prospects (30-min stale-lock threshold) ────────
  // Prevents permanent stranding if a previous upload attempt crashed mid-process.
  // Note: This and the claim below are separate queries, not a single transaction.
  // The race window is narrowed but not fully eliminated. Safe at current scale
  // (single operator, no concurrent sends). Revisit if concurrent sends become possible.
  // See BACKLOG: "send claim race window on multi-operator scenario"
  const staleThresholdISO = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  await supabase
    .from('prospects')
    .update({ outbound_upload_status: 'pending' })
    .eq('organisation_id', orgId)
    .eq('outbound_upload_status', 'uploading')
    .lt('outbound_upload_attempted_at', staleThresholdISO)

  // ── Claim prospects for upload (compare-and-set via status transition) ────
  // Atomically transition pending→uploading. This is race-narrowed (not eliminated):
  // rejects check outbound_upload_status='pending', which is now 'uploading', so they fail.
  // Separate UPDATE+SELECT (not mutation.select with inner join) avoids silent failure
  // if campaigns join yields no matches.
  const nowISO = new Date().toISOString()
  const { data: claimedIds, error: claimError } = await supabase
    .from('prospects')
    .update({ outbound_upload_status: 'uploading', outbound_upload_attempted_at: nowISO })
    .eq('organisation_id', orgId)
    .eq('outbound_upload_status', 'pending')
    .not('email', 'is', null)
    .not('sourced_tier', 'is', null)             // Only send tiered prospects
    .eq('email_send_eligible', true)              // Send eligibility gate
    .eq('client_review_status', 'approved')       // Client gatekeeper
    .eq('suppressed', false)                       // Suppression gate
    .select('id')

  if (claimError) {
    return { ok: false, error: claimError.message }
  }

  // If no prospects claimed, return early (nothing to send).
  if (!claimedIds || claimedIds.length === 0) {
    return { ok: true, outcomes: [], hasPartialFailure: false, blockedSegments: [], shellBlockedCampaigns: [], compositionFailureCount: 0 }
  }

  const claimedIdSet = new Set(claimedIds.map(r => r.id))

  // ── Fetch claimed prospects ───────────────────────────────────────────────
  // Separate SELECT after claim guarantees we see what was actually claimed.
  // Campaigns are resolved by segment, not by join, because campaigns carry
  // shell_segment_id and prospects carry segment_id. Both NULL in the default
  // single-segment case; match null-safe: (prospect.segment_id IS NULL AND
  // campaigns.shell_segment_id IS NULL) OR (prospect.segment_id = campaigns.shell_segment_id).
  const { data: rawRows, error: fetchErr } = await supabase
    .from('prospects')
    .select('id, email, first_name, last_name, company_name, role, segment_id')
    .eq('organisation_id', orgId)
    .in('id', Array.from(claimedIdSet))

  if (fetchErr) {
    // Reclaim only the prospects claimed in this run (scope to prevent over-reclaim)
    await supabase
      .from('prospects')
      .update({ outbound_upload_status: 'pending' })
      .in('id', Array.from(claimedIdSet))

    return { ok: false, error: fetchErr.message }
  }

  if (!rawRows || rawRows.length === 0) {
    // No rows returned despite claim success — reclaim and return early
    await supabase
      .from('prospects')
      .update({ outbound_upload_status: 'pending' })
      .in('id', Array.from(claimedIdSet))

    return { ok: true, outcomes: [], hasPartialFailure: false, blockedSegments: [], shellBlockedCampaigns: [], compositionFailureCount: 0 }
  }

  const rows = rawRows as ProspectRow[]

  // Build segment → resolved segment map.
  const rawSegmentIds = new Set(rows.map(r => r.segment_id))
  const resolvedFromRaw = new Map<string | null, string | null>()
  for (const rawId of rawSegmentIds) {
    resolvedFromRaw.set(rawId, rawId ?? primarySegmentId)
  }

  reclamIds = claimedIdSet

  // Gate check + approved doc snapshot, one per resolved segment.
  // Snapshot is taken at gate-pass time — prevents mid-batch race if client revises mid-upload.
  const uniqueResolvedIds = new Set([...resolvedFromRaw.values()])
  const approvedResolvedIds = new Set<string | null>()
  const blockedSegments: BlockedSegmentReason[] = []
  const composeServiceClient = getComposeServiceClient()

  type SegmentEntry = { composeDocs: Awaited<ReturnType<typeof fetchComposeDocs>>; docStepCount: number }
  const segmentDocsMap = new Map<string | null, SegmentEntry>()

  for (const resolvedId of uniqueResolvedIds) {
    const check = await assertStrategyApproved(supabase, orgId, resolvedId)
    if (!check.approved) {
      let segmentName: string | null = null
      if (resolvedId) {
        const { data: seg } = await supabase.from('segments').select('name').eq('id', resolvedId).maybeSingle()
        segmentName = seg?.name ?? null
      }
      blockedSegments.push({ segmentId: resolvedId, segmentName, pendingDocs: check.pendingDocs })
      continue
    }

    // Gate passed — fetch doc snapshot. Failure here blocks only this segment.
    try {
      const composeDocs = await fetchComposeDocs(composeServiceClient, orgId, resolvedId)
      segmentDocsMap.set(resolvedId, { composeDocs, docStepCount: getDocStepCount(composeDocs.messagingDoc) })
      approvedResolvedIds.add(resolvedId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('handleUploadLeads: doc snapshot failed after gate pass', { orgId, resolvedId, error: message })
      let segmentName: string | null = null
      if (resolvedId) {
        const { data: seg } = await supabase.from('segments').select('name').eq('id', resolvedId).maybeSingle()
        segmentName = seg?.name ?? null
      }
      blockedSegments.push({
        segmentId: resolvedId,
        segmentName,
        pendingDocs: ['Messaging (snapshot failed after gate — re-try upload)'],
      })
    }
  }

  const approvedRows = rows.filter(row => approvedResolvedIds.has(resolvedFromRaw.get(row.segment_id) ?? null))

  if (approvedRows.length === 0) {
    return { ok: true, outcomes: [], hasPartialFailure: false, blockedSegments, shellBlockedCampaigns: [], compositionFailureCount: 0 }
  }  // Note: prospects remain claimed if returned here; reclaim happens in finally block

  // ── Campaign resolution by segment (null-safe matching) ────────────────────
  // Fetch all campaigns for this org. Match campaigns to prospects by segment:
  // If prospect.segment_id = campaigns.shell_segment_id (null-safe), link them.
  // Default case: both NULL. If prospect has no matching campaign, block it.
  // If prospect segment matches multiple campaigns, report ambiguity and block.
  const { data: allCampaigns, error: campaignFetchErr } = await supabase
    .from('campaigns')
    .select('id, external_id, shell_step_count, shell_segment_id')
    .eq('organisation_id', orgId)

  if (campaignFetchErr) {
    return {
      ok: false,
      error: `Campaign fetch failed: ${campaignFetchErr.message}`,
    }
  }

  // Build segment -> campaigns map for fast lookup
  const segmentToCampaigns = new Map<string | null, typeof allCampaigns>()
  for (const campaign of allCampaigns ?? []) {
    const segKey = campaign.shell_segment_id ?? null
    if (!segmentToCampaigns.has(segKey)) {
      segmentToCampaigns.set(segKey, [])
    }
    segmentToCampaigns.get(segKey)!.push(campaign)
  }

  // Validate each approved prospect has exactly one matching campaign
  const campaignBlockedReasons: Array<{ prospectId: string; reason: string }> = []
  const prospectToCampaign = new Map<string, (typeof allCampaigns)[0]>() // prospect.id -> campaign

  for (const row of approvedRows) {
    const resolvedSegmentId = resolvedFromRaw.get(row.segment_id) ?? null
    const matchingCampaigns = segmentToCampaigns.get(resolvedSegmentId) ?? []

    if (matchingCampaigns.length === 0) {
      campaignBlockedReasons.push({
        prospectId: row.id,
        reason: `No campaign configured for segment ${resolvedSegmentId ?? 'default'}. Register a campaign before uploading.`,
      })
    } else if (matchingCampaigns.length > 1) {
      campaignBlockedReasons.push({
        prospectId: row.id,
        reason: `Segment ${resolvedSegmentId ?? 'default'} has ${matchingCampaigns.length} campaigns. Ambiguous routing. Fix in campaign settings.`,
      })
    } else {
      prospectToCampaign.set(row.id, matchingCampaigns[0])
    }
  }

  // If any prospect cannot be routed to a campaign, block them and return
  if (campaignBlockedReasons.length > 0) {
    const blockedProspectIds = campaignBlockedReasons.map(r => r.prospectId)
    await supabase
      .from('prospects')
      .update({
        outbound_upload_status: 'failed',
        outbound_upload_error: 'campaign_resolution_failed: no matching campaign for this segment',
      })
      .in('id', blockedProspectIds)
      .eq('organisation_id', orgId)

    return {
      ok: false,
      error: `${campaignBlockedReasons.length} prospect(s) cannot be routed to campaigns. Check campaign and segment configuration.`,
    }
  }

  // Shell coherence check per campaign external_id.
  const shellBlockedCampaigns: ShellBlockedReason[] = []
  const shellBlockedExternalIds = new Set<string>()
  const seenExternalIds = new Set<string>()

  for (const row of approvedRows) {
    const externalId = row.campaigns?.external_id
    if (!externalId || seenExternalIds.has(externalId)) continue
    seenExternalIds.add(externalId)

    const resolvedId = resolvedFromRaw.get(row.segment_id) ?? null
    const segEntry = segmentDocsMap.get(resolvedId)
    if (!segEntry) continue

    const { docStepCount } = segEntry
    const shellStepCount = row.campaigns?.shell_step_count ?? null

    if (shellStepCount === null) {
      shellBlockedCampaigns.push({ campaignExternalId: externalId, reason: 'no_shell', docStepCount, shellStepCount: null })
      shellBlockedExternalIds.add(externalId)
    } else if (shellStepCount !== docStepCount) {
      shellBlockedCampaigns.push({ campaignExternalId: externalId, reason: 'shell_out_of_sync', docStepCount, shellStepCount })
      shellBlockedExternalIds.add(externalId)
    }
  }

  const shellApprovedRows = approvedRows.filter(row => {
    const externalId = row.campaigns?.external_id
    return externalId && !shellBlockedExternalIds.has(externalId)
  })

  if (shellApprovedRows.length === 0) {
    return { ok: true, outcomes: [], hasPartialFailure: false, blockedSegments, shellBlockedCampaigns, compositionFailureCount: 0 }
  }  // Note: prospects remain claimed if returned here; reclaim happens in finally block

  // Compose every approved prospect and build per-lead payloads.
  // Map: campaignExternalId → lead payloads (only fully-composed leads are added).
  const byExternalId = new Map<string, ProspectForUpload[]>()
  let compositionFailureCount = 0
  const now = new Date().toISOString()

  for (let i = 0; i < shellApprovedRows.length; i += COMPOSE_CHUNK_SIZE) {
    const chunk = shellApprovedRows.slice(i, i + COMPOSE_CHUNK_SIZE)

    await Promise.all(chunk.map(async row => {
      const campaign = prospectToCampaign.get(row.id)
      const externalId = campaign?.external_id
      if (!externalId || !row.email) return

      const resolvedId = resolvedFromRaw.get(row.segment_id) ?? null
      const segEntry = segmentDocsMap.get(resolvedId)
      if (!segEntry) return

      const { composeDocs, docStepCount } = segEntry

      try {
        const composed = await composeSequence({
          prospect_id: row.id,
          client_id: orgId,
          preloadedDocs: composeDocs,
        })

        const vars = composedToVariables(composed.emails, row.first_name ?? null)
        assertCompleteVariables(vars, docStepCount)

        const lead: ProspectForUpload = {
          email: row.email,
          first_name: row.first_name ?? undefined,
          last_name: row.last_name ?? undefined,
          company_name: row.company_name ?? undefined,
          job_title: row.role ?? undefined,
          custom_variables: vars,
        }

        if (!byExternalId.has(externalId)) byExternalId.set(externalId, [])
        byExternalId.get(externalId)!.push(lead)

      } catch (err) {
        // Fail closed: exclude this lead, mark it failed in DB.
        compositionFailureCount++
        const message = err instanceof Error ? err.message : String(err)
        logger.warn('handleUploadLeads: composition failed — prospect excluded', {
          prospect_id: row.id,
          email: row.email,
          error: message,
        })
        supabase
          .from('prospects')
          .update({
            outbound_upload_status: 'failed',
            outbound_upload_attempted_at: now,
            outbound_upload_error: `composition-failed: ${message.slice(0, 400)}`,
          })
          .eq('id', row.id)
          .eq('organisation_id', orgId)
          .then(({ error: dbErr }) => {
            if (dbErr) logger.warn('handleUploadLeads: could not write composition failure to DB', { prospect_id: row.id, error: dbErr.message })
          })
      }
    }))
  }

  if (byExternalId.size === 0) {
    return { ok: false, error: 'No prospects ready for composition. Check approval, shell sync, and campaign assignment.' }
  }  // Note: prospects remain claimed if returned here; reclaim happens in finally block

  // ── FINAL SAFETY CHECK: re-verify suppressed=false AND client_review_status != 'rejected' ─
  // A reject could have landed after claim but before upload. This is the last checkpoint
  // to prevent sending to a rejected prospect. Compliance-critical: must be impossible to send
  // to anyone the client explicitly rejected, even if reject landed between claim and upload.
  const { data: rejectedSinceUpload, error: rejectionCheckErr } = await supabase
    .from('prospects')
    .select('id')
    .eq('organisation_id', orgId)
    .in('id', Array.from(claimedIdSet))
    .or('suppressed.eq.true,client_review_status.eq.rejected')

  if (rejectionCheckErr) {
    // On check failure, reclaim and abort (fail closed)
    await supabase
      .from('prospects')
      .update({ outbound_upload_status: 'pending' })
      .in('id', Array.from(claimedIdSet))
    return { ok: false, error: `Final rejection check failed: ${rejectionCheckErr.message}` }
  }

  const rejectedIdSet = new Set((rejectedSinceUpload ?? []).map(r => r.id))

  // Filter out any prospects that were rejected after claim
  if (rejectedIdSet.size > 0) {
    logger.info('handleUploadLeads: prospects rejected after claim, excluding from send', {
      organisation_id: orgId,
      rejected_count: rejectedIdSet.size,
    })

    // Mark excluded prospects as failed (rejected after claim)
    await supabase
      .from('prospects')
      .update({
        outbound_upload_status: 'failed',
        outbound_upload_error: 'rejected-post-claim: client rejected prospect after send was initiated',
      })
      .in('id', Array.from(rejectedIdSet))

    // Build email→prospect_id map once (safe exclusion keyed on id, not email)
    // Avoids risk of removing wrong lead if emails duplicate or are null
    const emailToProspectId = new Map<string, string>(
      (rawRows ?? []).filter(r => r.email !== null).map(r => [r.email!, r.id])
    )

    // Remove rejected leads from byExternalId (by prospect id via email lookup)
    for (const [, leads] of byExternalId) {
      for (let i = leads.length - 1; i >= 0; i--) {
        const prospectId = emailToProspectId.get(leads[i].email)
        if (prospectId && rejectedIdSet.has(prospectId)) {
          leads.splice(i, 1)
        }
      }
    }
  }

  // If all leads were rejected, reclaim remaining and return early
  const remainingLeadsCount = Array.from(byExternalId.values()).reduce((sum, leads) => sum + leads.length, 0)
  if (remainingLeadsCount === 0) {
    // Reclaim only the non-rejected prospects
    const nonRejectedIds = Array.from(claimedIdSet).filter(id => !rejectedIdSet.has(id))
    if (nonRejectedIds.length > 0) {
      await supabase
        .from('prospects')
        .update({ outbound_upload_status: 'pending' })
        .in('id', nonRejectedIds)
    }
    return { ok: true, outcomes: [], hasPartialFailure: false, blockedSegments, shellBlockedCampaigns, compositionFailureCount }
  }

  // Upload to outbound provider — one batch per campaign.
  // Build external_id -> internal campaign ID map for writing after upload
  const externalIdToCampaignId = new Map<string, string>()
  for (const campaign of allCampaigns ?? []) {
    if (campaign.external_id) {
      externalIdToCampaignId.set(campaign.external_id, campaign.id)
    }
  }

  const outcomes: CampaignOutcome[] = []

  for (const [campaignExternalId, leads] of byExternalId) {
    try {
      const campaignId = externalIdToCampaignId.get(campaignExternalId)
      const result = await uploadLeads(orgId, campaignExternalId, leads, campaignId)
      outcomes.push({
        external_id: campaignExternalId,
        ok: true,
        created: result.created_count,
        duplicated: result.duplicated,
        in_blocklist: result.in_blocklist,
        invalid: result.invalid_email_count,
        incomplete: result.incomplete_count,
        attempted: leads.length,
      })
    } catch (err) {
      outcomes.push({
        external_id: campaignExternalId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Mark success path: prospects will be updated to 'uploaded', no reclaim needed
  shouldReclaim = false

  return {
    ok: true,
    outcomes,
    hasPartialFailure: outcomes.some(o => !o.ok),
    blockedSegments,
    shellBlockedCampaigns,
    compositionFailureCount,
  }

  } catch (err) {
    Sentry.captureException(err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    // ALWAYS reclaim prospects if the upload did not succeed
    if (shouldReclaim && reclamIds.size > 0) {
      const { error: reclaimErr } = await supabase
        .from('prospects')
        .update({ outbound_upload_status: 'pending' })
        .in('id', Array.from(reclamIds))

      if (reclaimErr) {
        logger.warn('handleUploadLeads: failed to reclaim prospects after upload failure', {
          organisation_id: orgId,
          claim_count: reclamIds.size,
          error: reclaimErr.message,
        })
      }
    }
  }
  }) // end withServerActionInstrumentation
}

// ── Shell sync action ─────────────────────────────────────────────────────────

export type ShellSyncActionResult =
  | { ok: true; stepCount: number; syncedAt: string }
  | { ok: false; error: string; blockedByUploadedLeads?: boolean }

export async function handleSyncSequenceShell(
  orgId: string,
  campaignInternalId: string,
  segmentId: string | null,
): Promise<ShellSyncActionResult> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  return Sentry.withServerActionInstrumentation('handleSyncSequenceShell', async (): Promise<ShellSyncActionResult> => {
  try {

  // Resolve segment.
  let resolvedSegmentId = segmentId
  if (!resolvedSegmentId) {
    const { data: primarySeg } = await supabase
      .from('segments')
      .select('id')
      .eq('organisation_id', orgId)
      .eq('is_default', true)
      .maybeSingle()
    resolvedSegmentId = primarySeg?.id ?? null
  }

  // Gate: all docs approved before syncing the shell.
  const check = await assertStrategyApproved(supabase, orgId, resolvedSegmentId)
  if (!check.approved) {
    return {
      ok: false,
      error: `Messaging document must be approved before syncing. Pending: ${check.pendingDocs.join(', ')}.`,
    }
  }

  // Fetch campaign external_id.
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('external_id')
    .eq('id', campaignInternalId)
    .eq('organisation_id', orgId)
    .maybeSingle()

  if (!campaign?.external_id) {
    return { ok: false, error: 'Campaign not found or has no external ID.' }
  }

  // Fetch approved Messaging doc content + id.
  const { data: messagingDocRow } = await supabase
    .from('strategy_documents')
    .select('id, content')
    .eq('organisation_id', orgId)
    .eq('document_type', 'messaging')
    .eq('status', 'active')
    .eq('client_approval_status', 'approved')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!messagingDocRow) {
    return { ok: false, error: 'No active + approved Messaging document found.' }
  }

  try {
    const result = await syncSequenceShell({
      organisationId: orgId,
      campaignExternalId: campaign.external_id,
      campaignInternalId,
      segmentId: resolvedSegmentId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messagingDoc: messagingDocRow.content as any,
      messagingDocId: messagingDocRow.id,
    })

    if (!result.ok) {
      if (result.reason === 'uploaded_leads_structure_change') {
        return {
          ok: false,
          blockedByUploadedLeads: true,
          error: `Cannot change step count from ${result.existingStepCount} to ${result.stepCount} on a campaign with uploaded leads. Register a new campaign for the new sequence structure.`,
        }
      }
      if (result.reason === 'flag_disabled') {
        return { ok: false, error: 'Outbound provider flag is disabled — enable in integrations settings.' }
      }
      return { ok: false, error: result.error }
    }

    return { ok: true, stepCount: result.stepCount, syncedAt: result.syncedAt }
  } catch (err) {
    Sentry.captureException(err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  } catch (err) {
    Sentry.captureException(err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  }) // end withServerActionInstrumentation
}

// ── DFY mailbox order actions ─────────────────────────────────────────────────

export type DfyQuoteResult =
  | { ok: true; order_is_valid: boolean; total_price: number | null }
  | { ok: false; error: string }

export type DfyOrderActionResult =
  | { ok: true; order_placed: boolean }
  | { ok: false; error: string }

export async function handleDfyQuote(orgId: string, domains: string[]): Promise<DfyQuoteResult> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  try {
    const result: DfyOrderResult = await orderMailboxes(orgId, domains, true)
    return { ok: true, order_is_valid: result.order_is_valid, total_price: result.total_price }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function handleDfyRealOrder(orgId: string, domains: string[]): Promise<DfyOrderActionResult> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  try {
    const result: DfyOrderResult = await orderMailboxes(orgId, domains, false)
    return { ok: true, order_placed: result.order_placed }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Warmup control ────────────────────────────────────────────────────────────

export async function updateWarmupStartedAt(
  orgId: string,
  warmupStartedAt: string | null
): Promise<{ error?: string }> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  const { error } = await supabase
    .from('organisations')
    .update({ warmup_started_at: warmupStartedAt })
    .eq('id', orgId)

  if (error) return { error: error.message }
  return {}
}

export async function updateWarmupCompletedAt(
  orgId: string,
  completed: boolean
): Promise<{ error?: string }> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!userRow || userRow.role !== 'operator') redirect('/dashboard')

  const warmupCompletedAt = completed ? new Date().toISOString() : null

  const { data: org, error: fetchError } = await supabase
    .from('organisations')
    .select('id, name')
    .eq('id', orgId)
    .single()

  if (fetchError || !org) {
    return { error: 'Organisation not found' }
  }

  const { error: updateError } = await supabase
    .from('organisations')
    .update({ warmup_completed_at: warmupCompletedAt })
    .eq('id', orgId)

  if (updateError) {
    return { error: updateError.message }
  }

  // Fire email if completing (not clearing)
  if (completed) {
    try {
      // Dedup via notifications_log
      const { error: logError } = await supabase
        .from('notifications_log')
        .insert({
          organisation_id: orgId,
          notification_type: 'warming_complete',
          subject_id: orgId,
        })

      if (logError && logError.code !== '23505') {
        // Log error but don't fail the completion
        logger.error('updateWarmupCompletedAt: failed to log notification', {
          organisation_id: orgId,
          error: logError.message,
        })
      } else if (!logError || logError.code === '23505') {
        // Send email if first time, skip if already sent
        if (!logError) {
          const { data: clientUser } = await supabase
            .from('users')
            .select('email')
            .eq('organisation_id', orgId)
            .eq('role', 'client')
            .single()

          if (clientUser?.email) {
            const { warmingCompleteTemplate, warmingCompleteSubject, warmingCompleteTemplateText } =
              await import('@/lib/email/templates/warming-complete')

            // Calculate send date: 1 day after confirmation (when warming_completed_at was set)
            // Tied to the actual confirmation time, not a fixed offset from warmup start
            const sendDateObj = new Date(warmupCompletedAt!)
            sendDateObj.setDate(sendDateObj.getDate() + 1)
            const sendDate = sendDateObj.toLocaleDateString('en-GB', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })

            await sendTransactionalEmail({
              to: clientUser.email,
              subject: warmingCompleteSubject(sendDate),
              html: warmingCompleteTemplate({ sendDate }),
              text: warmingCompleteTemplateText({ sendDate }),
            })

            logger.info('updateWarmupCompletedAt: warming_complete email sent', {
              organisation_id: orgId,
            })
          }
        }
      }
    } catch (err) {
      // Don't fail the update if email fails
      logger.error('updateWarmupCompletedAt: email send failed (non-blocking)', {
        organisation_id: orgId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {}
}
