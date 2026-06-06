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
  try {

  // Resolve primary segment once.
  const { data: primarySeg } = await supabase
    .from('segments')
    .select('id')
    .eq('organisation_id', orgId)
    .eq('is_default', true)
    .maybeSingle()
  const primarySegmentId = primarySeg?.id ?? null

  // Fetch pending prospects including id (for composeSequence) and campaign shell state.
  const { data: rawRows, error: fetchErr } = await supabase
    .from('prospects')
    .select('id, email, first_name, last_name, company_name, role, segment_id, campaigns!inner(id, external_id, shell_step_count, shell_segment_id)')
    .eq('organisation_id', orgId)
    .eq('outbound_upload_status', 'pending')
    .not('campaign_id', 'is', null)
    .not('email', 'is', null)

  if (fetchErr) {
    return { ok: false, error: fetchErr.message }
  }

  if (!rawRows || rawRows.length === 0) {
    return { ok: true, outcomes: [], hasPartialFailure: false, blockedSegments: [], shellBlockedCampaigns: [], compositionFailureCount: 0 }
  }

  const rows = rawRows as ProspectRow[]

  // Build segment → resolved segment map.
  const rawSegmentIds = new Set(rows.map(r => r.segment_id))
  const resolvedFromRaw = new Map<string | null, string | null>()
  for (const rawId of rawSegmentIds) {
    resolvedFromRaw.set(rawId, rawId ?? primarySegmentId)
  }

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
  }

  // Compose every approved prospect and build per-lead payloads.
  // Map: campaignExternalId → lead payloads (only fully-composed leads are added).
  const byExternalId = new Map<string, ProspectForUpload[]>()
  let compositionFailureCount = 0
  const now = new Date().toISOString()

  for (let i = 0; i < shellApprovedRows.length; i += COMPOSE_CHUNK_SIZE) {
    const chunk = shellApprovedRows.slice(i, i + COMPOSE_CHUNK_SIZE)

    await Promise.all(chunk.map(async row => {
      const externalId = row.campaigns?.external_id
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
    return { ok: true, outcomes: [], hasPartialFailure: false, blockedSegments, shellBlockedCampaigns, compositionFailureCount }
  }

  // Upload to outbound provider — one batch per campaign.
  const outcomes: CampaignOutcome[] = []

  for (const [campaignExternalId, leads] of byExternalId) {
    try {
      const result = await uploadLeads(orgId, campaignExternalId, leads)
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
