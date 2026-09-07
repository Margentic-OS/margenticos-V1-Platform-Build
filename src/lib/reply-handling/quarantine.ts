// Parking a reply we cannot attribute, and getting it back once we can.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE THREE OPERATIONS, AND WHY THEY LIVE TOGETHER
//
//   quarantineReply          the poller parks a reply with no resolvable campaign
//   replayQuarantinedReplies registering a campaign turns those rows into signals
//   applyQuarantineRetention 30-day redaction and 180-day deletion
//
// They share one invariant that is easy to break from any of the three: a row is
// resolved ONLY by a real signal write, and a row is removed ONLY by retention. Nothing
// else may set resolved_at, and nothing may delete a row to make a monitor go green.
//
// ADR-001 deferred: provider is recorded as a column rather than resolved through the
// capability registry, matching the rest of this directory. See the ADR-001 notes in
// process-reply.ts.

import type { Json } from '@/types/database'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import { logger } from '@/lib/logger'

const PROVIDER = 'instantly'
const SOURCE = 'instantly'

// Retention, decided before the table was created. See the migration header.
export const QUARANTINE_REDACT_AFTER_DAYS = 30
export const QUARANTINE_DELETE_AFTER_DAYS = 180

export interface QuarantineInput {
  providerEmailId: string
  providerCampaignId: string | null
  eaccount: string | null
  rawData: Json
  originalOutboundBody: string | null
}

export type QuarantineOutcome = 'parked' | 'already_held' | 'failed'

/**
 * Parks a reply that resolved to no campaign of ours.
 *
 * Idempotent on (provider, provider_email_id). The poller may see the same reply again
 * after a cursor rewind, and re-observation must not create a second row or reset the
 * ageing clock that MON-031 reports.
 */
export async function quarantineReply(
  supabase: ServiceRoleClient,
  input: QuarantineInput,
): Promise<QuarantineOutcome> {
  const nowISO = new Date().toISOString()

  const { error } = await supabase
    .from('unattributed_replies')
    .insert({
      provider: PROVIDER,
      provider_email_id: input.providerEmailId,
      provider_campaign_id: input.providerCampaignId,
      eaccount: input.eaccount,
      raw_data: input.rawData,
      original_outbound_body: input.originalOutboundBody,
      first_seen_at: nowISO,
      last_seen_at: nowISO,
    })

  if (!error) return 'parked'

  // 23505 is the idempotency key doing its job, not a failure. Refresh last_seen_at so
  // the row shows it is still being observed, and leave first_seen_at alone: the ageing
  // MON-031 reports is age since we FIRST could not attribute it, and touching it would
  // let a repeatedly-seen reply look permanently new.
  if (error.code === '23505') {
    const { error: touchError } = await supabase
      .from('unattributed_replies')
      .update({ last_seen_at: nowISO })
      .eq('provider', PROVIDER)
      .eq('provider_email_id', input.providerEmailId)

    if (touchError) {
      logger.warn('quarantine: could not refresh last_seen_at on an existing row', {
        provider_email_id: input.providerEmailId,
        error: touchError.message,
      })
    }
    return 'already_held'
  }

  logger.error('quarantine: failed to park an unattributable reply', {
    provider_email_id: input.providerEmailId,
    provider_campaign_id: input.providerCampaignId,
    error: error.message,
  })
  return 'failed'
}

export interface ReplayResult {
  replayed: number
  skipped: number
  unreplayable: number
  errors: number
}

/**
 * Turns quarantined replies for a newly registered campaign into real signals.
 *
 * Replay rather than re-fetch, deliberately. The stored raw_data is the exact object
 * writeSignal consumes, so nothing has to be asked of the provider, and the row survives
 * the campaign being deleted there. On 2026-08-28 a probe campaign was torn down within
 * the hour and its evidence became unrecoverable; that is the failure this avoids.
 */
export async function replayQuarantinedReplies(
  supabase: ServiceRoleClient,
  params: { providerCampaignId: string; organisationId: string; campaignId: string },
): Promise<ReplayResult> {
  const result: ReplayResult = { replayed: 0, skipped: 0, unreplayable: 0, errors: 0 }

  const { data: rows, error } = await supabase
    .from('unattributed_replies')
    .select('id, provider_email_id, raw_data, original_outbound_body, body_redacted_at')
    .eq('provider', PROVIDER)
    .eq('provider_campaign_id', params.providerCampaignId)
    .is('resolved_at', null)

  if (error) {
    logger.error('quarantine replay: could not read quarantined replies', {
      provider_campaign_id: params.providerCampaignId,
      error: error.message,
    })
    result.errors++
    return result
  }

  for (const row of rows ?? []) {
    // A redacted row has no payload left to replay. It stays unresolved on purpose, so
    // MON-031 keeps naming it and somebody answers it by hand. Marking it resolved here
    // would be the monitor healing by forgetting.
    if (row.body_redacted_at) {
      result.unreplayable++
      continue
    }

    const { data: inserted, error: signalError } = await supabase
      .from('signals')
      .insert({
        organisation_id: params.organisationId,
        campaign_id: params.campaignId,
        prospect_id: null,
        signal_type: 'reply_received',
        source: SOURCE,
        external_event_id: row.provider_email_id,
        raw_data: row.raw_data as Json,
        original_outbound_body: row.original_outbound_body,
      })
      .select('id')

    // 23505 means the signal already exists, which is a success for our purposes: the
    // reply is in the system. Resolve the quarantine row against it rather than leaving
    // a permanent duplicate alarm.
    if (signalError && signalError.code !== '23505') {
      logger.error('quarantine replay: signal insert failed, row left quarantined', {
        quarantine_id: row.id,
        provider_email_id: row.provider_email_id,
        error: signalError.message,
      })
      result.errors++
      continue
    }

    const signalId = signalError ? null : inserted?.[0]?.id ?? null

    const { error: resolveError } = await supabase
      .from('unattributed_replies')
      .update({ resolved_at: new Date().toISOString(), resolved_signal_id: signalId })
      .eq('id', row.id)

    if (resolveError) {
      // The signal exists and the quarantine row does not know it. Re-running replay is
      // safe (the signal insert dedupes), so this is recoverable rather than lost.
      logger.error('quarantine replay: signal written but row not marked resolved', {
        quarantine_id: row.id,
        error: resolveError.message,
      })
      result.errors++
      continue
    }

    if (signalError) result.skipped++
    else result.replayed++
  }

  if (result.replayed > 0 || result.unreplayable > 0) {
    logger.info('quarantine replay: complete', {
      provider_campaign_id: params.providerCampaignId,
      ...result,
    })
  }

  return result
}

export interface RetentionResult {
  redacted: number
  deleted: number
  errors: number
}

/**
 * Applies the retention rule.
 *
 * Redaction keeps the row and the campaign id, so MON-031 stays PROBLEM. A monitor that
 * went green because rows aged out would be healing by forgetting, which MON-028's own
 * advice text already bans for reply drafts.
 */
export async function applyQuarantineRetention(
  supabase: ServiceRoleClient,
  now: Date = new Date(),
): Promise<RetentionResult> {
  const result: RetentionResult = { redacted: 0, deleted: 0, errors: 0 }

  const redactBefore = new Date(now.getTime() - QUARANTINE_REDACT_AFTER_DAYS * 86400_000).toISOString()
  const deleteBefore = new Date(now.getTime() - QUARANTINE_DELETE_AFTER_DAYS * 86400_000).toISOString()

  // Delete first. A row past the delete horizon should not be redacted on its way out.
  const { data: deleted, error: deleteError } = await supabase
    .from('unattributed_replies')
    .delete()
    .lt('first_seen_at', deleteBefore)
    .select('id')

  if (deleteError) {
    logger.error('quarantine retention: delete sweep failed', { error: deleteError.message })
    result.errors++
  } else {
    result.deleted = deleted?.length ?? 0
  }

  const { data: redacted, error: redactError } = await supabase
    .from('unattributed_replies')
    .update({
      raw_data: null,
      original_outbound_body: null,
      body_redacted_at: now.toISOString(),
    })
    .lt('first_seen_at', redactBefore)
    .is('resolved_at', null)
    .is('body_redacted_at', null)
    .select('id')

  if (redactError) {
    logger.error('quarantine retention: redaction sweep failed', { error: redactError.message })
    result.errors++
  } else {
    result.redacted = redacted?.length ?? 0
  }

  if (result.redacted > 0 || result.deleted > 0) {
    logger.info('quarantine retention: applied', { ...result })
  }

  return result
}
