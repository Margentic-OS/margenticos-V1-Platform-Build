'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { validateCampaign } from '@/lib/integrations/handlers/instantly/validateCampaign'
import { uploadLeads } from '@/lib/integrations/handlers/instantly/uploadLeads'
import { orderMailboxes } from '@/lib/integrations/handlers/instantly/orderMailboxes'
import { INSTANTLY_DFY_ALLOWED_TLDS } from '@/lib/integrations/handlers/instantly/constants'
import { assertStrategyApproved } from '@/lib/approval/assertStrategyApproved'
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

  // Duplicate check before touching the Instantly API
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

  // Final duplicate check — guards against races between checkCampaign and this call
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

export type UploadLeadsResult =
  | { ok: true; outcomes: CampaignOutcome[]; hasPartialFailure: boolean; blockedSegments: BlockedSegmentReason[] }
  | { ok: false; error: string }

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

  // Resolve the primary segment once — used to map null-segment prospects to a real segment.
  const { data: primarySeg } = await supabase
    .from('segments')
    .select('id')
    .eq('organisation_id', orgId)
    .eq('is_default', true)
    .maybeSingle()
  const primarySegmentId = primarySeg?.id ?? null

  // Fetch pending prospects with segment_id included for approval gating.
  // Filters: status=pending, campaign assigned, personalisation trigger present, email present.
  const { data: rows, error: fetchErr } = await supabase
    .from('prospects')
    .select('email, personalisation_trigger, first_name, last_name, company_name, role, segment_id, campaigns!inner(external_id)')
    .eq('organisation_id', orgId)
    .eq('outbound_upload_status', 'pending')
    .not('campaign_id', 'is', null)
    .not('personalisation_trigger', 'is', null)
    .not('email', 'is', null)

  if (fetchErr) {
    return { ok: false, error: fetchErr.message }
  }

  if (!rows || rows.length === 0) {
    return { ok: true, outcomes: [], hasPartialFailure: false, blockedSegments: [] }
  }

  // Build a map from each raw segment_id in this batch to its resolved segment_id.
  // NULL-segment prospects resolve to the primary segment (matching compose-sequence logic).
  const rawSegmentIds = new Set(rows.map(r => r.segment_id))
  const resolvedFromRaw = new Map<string | null, string | null>()
  for (const rawId of rawSegmentIds) {
    resolvedFromRaw.set(rawId, rawId ?? primarySegmentId)
  }

  // Check approval for each unique resolved segment.
  // Per-segment independence: an unapproved segment blocks only its own prospects.
  const uniqueResolvedIds = new Set([...resolvedFromRaw.values()])
  const approvedResolvedIds = new Set<string | null>()
  const blockedSegments: BlockedSegmentReason[] = []

  for (const resolvedId of uniqueResolvedIds) {
    const check = await assertStrategyApproved(supabase, orgId, resolvedId)
    if (check.approved) {
      approvedResolvedIds.add(resolvedId)
    } else {
      // Fetch the segment name for the operator-facing reason message.
      let segmentName: string | null = null
      if (resolvedId) {
        const { data: seg } = await supabase
          .from('segments')
          .select('name')
          .eq('id', resolvedId)
          .maybeSingle()
        segmentName = seg?.name ?? null
      }
      blockedSegments.push({ segmentId: resolvedId, segmentName, pendingDocs: check.pendingDocs })
    }
  }

  // Filter prospects to only those whose resolved segment is approved.
  const approvedRows = rows.filter(row => {
    const resolvedId = resolvedFromRaw.get(row.segment_id) ?? null
    return approvedResolvedIds.has(resolvedId)
  })

  if (approvedRows.length === 0) {
    // All prospects held by the gate — nothing to upload this run.
    return { ok: true, outcomes: [], hasPartialFailure: false, blockedSegments }
  }

  // Group approved prospects by Instantly campaign UUID. Each campaign is a separate batch.
  const byExternalId = new Map<string, ProspectForUpload[]>()
  for (const row of approvedRows) {
    const campaign = row.campaigns as { external_id: string | null } | null
    const externalId = campaign?.external_id
    if (!externalId || !row.email) continue
    if (!byExternalId.has(externalId)) byExternalId.set(externalId, [])
    byExternalId.get(externalId)!.push({
      email: row.email,
      personalization: row.personalisation_trigger ?? undefined,
      first_name: row.first_name ?? undefined,
      last_name: row.last_name ?? undefined,
      company_name: row.company_name ?? undefined,
      job_title: row.role ?? undefined,
    })
  }

  if (byExternalId.size === 0) {
    return { ok: false, error: 'No approved prospects have a valid Instantly campaign UUID assigned.' }
  }

  // Run all campaign uploads, collecting per-campaign outcomes.
  // One campaign failing does not abort the others — partial success is reported, not swallowed.
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
  }
}

// ── DFY mailbox order actions ─────────────────────────────────────────────────

export type DfyQuoteResult =
  | { ok: true; order_is_valid: boolean; total_price: number | null }
  | { ok: false; error: string }

export type DfyOrderActionResult =
  | { ok: true; order_placed: boolean }
  | { ok: false; error: string }

export { INSTANTLY_DFY_ALLOWED_TLDS }

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
