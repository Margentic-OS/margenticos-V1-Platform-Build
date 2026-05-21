'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { validateCampaign } from '@/lib/integrations/handlers/instantly/validateCampaign'
import { uploadLeads } from '@/lib/integrations/handlers/instantly/uploadLeads'
import type { ProspectForUpload } from '@/lib/integrations/handlers/instantly/types'

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

export type UploadLeadsResult =
  | { ok: true; created: number; duplicated: number; in_blocklist: number; invalid: number; incomplete: number; total_attempted: number }
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

  // Fetch pending prospects with their Instantly campaign UUID via join.
  // Filters: status=pending, campaign assigned, personalisation trigger present, email present.
  const { data: rows, error: fetchErr } = await supabase
    .from('prospects')
    .select('email, personalisation_trigger, first_name, last_name, company_name, role, campaigns!inner(external_id)')
    .eq('organisation_id', orgId)
    .eq('outbound_upload_status', 'pending')
    .not('campaign_id', 'is', null)
    .not('personalisation_trigger', 'is', null)
    .not('email', 'is', null)

  if (fetchErr) {
    return { ok: false, error: fetchErr.message }
  }

  if (!rows || rows.length === 0) {
    return { ok: true, created: 0, duplicated: 0, in_blocklist: 0, invalid: 0, incomplete: 0, total_attempted: 0 }
  }

  // Group by Instantly campaign UUID (external_id). Each campaign is uploaded as a separate batch.
  const byExternalId = new Map<string, ProspectForUpload[]>()
  for (const row of rows) {
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
    return { ok: false, error: 'No prospects have a valid Instantly campaign UUID assigned.' }
  }

  let created = 0, duplicated = 0, in_blocklist = 0, invalid = 0, incomplete = 0, total_attempted = 0

  for (const [campaignExternalId, leads] of byExternalId) {
    try {
      const result = await uploadLeads(orgId, campaignExternalId, leads)
      created += result.created_count
      duplicated += result.duplicated
      in_blocklist += result.in_blocklist
      invalid += result.invalid_email_count
      incomplete += result.incomplete_count
      total_attempted += leads.length
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  return { ok: true, created, duplicated, in_blocklist, invalid, incomplete, total_attempted }
}
