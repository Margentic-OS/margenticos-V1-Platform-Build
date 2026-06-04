// Syncs a campaign's sequence shell on the outbound provider.
//
// The shell is a generic multi-step email sequence where each step's subject and
// body are Instantly template variables ({{m_subject_N}} / {{m_body_N}}). When a
// prospect is uploaded their per-lead composed content fills those variables, so
// every prospect in the campaign receives their own personalised copy at the exact
// position within the sequence they are at.
//
// ADR-001 compliance: the word "Instantly" appears only inside this handler.
// Callers use the capability name: outbound_sync_sequence_shell.
//
// Addendum-3 coherence rules:
//   • Copy-only revisions (no step count change) do NOT require re-sync — copy flows
//     through per-lead variables automatically on next upload.
//   • Structure changes (step count or delay changes) DO require re-sync.
//   • A campaign with already-uploaded leads may NOT be re-synced with a different
//     step count — block with guidance to register a new campaign.
//
// Addendum-4: read-campaign-first. We send a PATCH with ONLY the sequences field so
// no other campaign setting (schedule, limits, stop_on_reply, tracking) is overwritten.

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'
import { logger } from '@/lib/logger'
import { resolveInstantlyBaseUrl, summarizeResponseBody } from './constants'
import { getInstantlyApiKey, getInstantlyApiActive } from './auth'
import type { Database } from '@/types/database'
import type {
  CampaignDetailResponse,
  CampaignUpdateRequest,
  CampaignUpdateResponse,
  SequenceConfig,
  SequenceStep,
} from './types'
import {
  InstantlyFlagError,
  InstantlyNetworkError,
  InstantlyRateLimitError,
  InstantlyValidationError,
  InstantlyServerError,
  InstantlyApiError,
} from './types'
import type { MessagingContent } from '@/lib/composition/compose-sequence'

// ─── Default delay schedule ───────────────────────────────────────────────────
// Used when no delay is specified. Designed for cold email: step 1 sends on day 0,
// subsequent steps follow-up at 3-day intervals (common industry default).
// Operator can override via future per-campaign config — not in scope for this build.

function defaultDelays(stepCount: number): Array<{ delay: number; delay_unit: 'days' }> {
  return Array.from({ length: stepCount }, (_, i) => ({
    delay: i === 0 ? 0 : i * 3,
    delay_unit: 'days' as const,
  }))
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ShellSyncInput {
  organisationId: string
  /** The outbound provider's campaign UUID (campaigns.external_id). */
  campaignExternalId: string
  /** Our internal campaigns.id — used to read/write shell tracking columns. */
  campaignInternalId: string
  /** The segment this shell is for. Used to record shell_segment_id. */
  segmentId: string | null
  /** The approved Messaging doc for this segment. */
  messagingDoc: MessagingContent
  /** The strategy_documents.id for the approved Messaging doc used. */
  messagingDocId: string
}

export type ShellSyncResult =
  | { ok: true; stepCount: number; syncedAt: string }
  | { ok: false; reason: 'uploaded_leads_structure_change'; stepCount: number; existingStepCount: number }
  | { ok: false; reason: 'flag_disabled' }
  | { ok: false; reason: 'api_error'; error: string }

// ─── Step count helper ────────────────────────────────────────────────────────

export function getDocStepCount(messagingDoc: MessagingContent): number {
  if (messagingDoc.variants) {
    const firstKey = Object.keys(messagingDoc.variants)[0]
    return messagingDoc.variants[firstKey]?.emails?.length ?? 0
  }
  return messagingDoc.emails?.length ?? 0
}

// ─── Shell builder ────────────────────────────────────────────────────────────

function buildShellSequences(
  stepCount: number,
  delays: Array<{ delay: number; delay_unit: 'days' | 'hours' }>,
): SequenceConfig[] {
  const steps: SequenceStep[] = Array.from({ length: stepCount }, (_, i) => {
    const n = i + 1
    return {
      type: 'email',
      delay: delays[i]?.delay ?? i * 3,
      delay_unit: delays[i]?.delay_unit ?? 'days',
      enabled: true,
      variants: [
        {
          subject: `{{m_subject_${n}}}`,
          body: `<p>{{m_body_${n}}}</p>`,
          enabled: true,
        },
      ],
    }
  })

  return [{ steps }]
}

// ─── Supabase client ──────────────────────────────────────────────────────────

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('syncSequenceShell: missing Supabase env vars')
  return createSupabaseClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function syncSequenceShell(input: ShellSyncInput): Promise<ShellSyncResult> {
  const {
    organisationId,
    campaignExternalId,
    campaignInternalId,
    segmentId,
    messagingDoc,
    messagingDocId,
  } = input

  const apiKey = await getInstantlyApiKey(organisationId)
  const isActive = await getInstantlyApiActive()
  // Flag drives URL selection: flag off → mock server, flag on → production.
  const baseUrl = resolveInstantlyBaseUrl(isActive)

  const stepCount = getDocStepCount(messagingDoc)
  if (stepCount === 0) {
    return {
      ok: false,
      reason: 'api_error',
      error: 'Messaging document has no email steps — cannot build shell.',
    }
  }

  // Block: structure change on a campaign that already has uploaded leads (addendum-3).
  const supabase = getServiceClient()

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('shell_step_count')
    .eq('id', campaignInternalId)
    .eq('organisation_id', organisationId)
    .maybeSingle()

  if (campaign?.shell_step_count != null && campaign.shell_step_count !== stepCount) {
    // Check if any leads have been uploaded to this campaign.
    const { count: uploadedCount } = await supabase
      .from('prospects')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', organisationId)
      .eq('outbound_upload_status', 'uploaded')

    if ((uploadedCount ?? 0) > 0) {
      return {
        ok: false,
        reason: 'uploaded_leads_structure_change',
        stepCount,
        existingStepCount: campaign.shell_step_count,
      }
    }
  }

  // Build the partial PATCH body — sequences only (addendum-4).
  const delays = defaultDelays(stepCount)
  const sequences = buildShellSequences(stepCount, delays)
  const patchBody: CampaignUpdateRequest = { sequences }

  // PATCH the campaign on the outbound provider.
  let response: Response
  try {
    response = await fetch(`${baseUrl}/campaigns/${campaignExternalId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(patchBody),
    })
  } catch (err) {
    throw new InstantlyNetworkError(`syncSequenceShell: network error: ${String(err)}`)
  }

  if (response.status === 429) {
    throw new InstantlyRateLimitError('syncSequenceShell: rate limit hit — retry in a moment')
  }

  if (response.status === 400 || response.status === 422) {
    const body = await response.text().catch(() => '(unreadable)')
    throw new InstantlyValidationError(
      `syncSequenceShell: rejected (${response.status}): ${summarizeResponseBody(body, response.status)}`
    )
  }

  if (response.status >= 500) {
    const errMsg = `syncSequenceShell: transient outage (${response.status}) — try again`
    Sentry.captureException(new Error(errMsg), { level: 'warning' })
    throw new InstantlyServerError(errMsg)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable)')
    throw new InstantlyApiError(
      `syncSequenceShell: unexpected error (${response.status}): ${summarizeResponseBody(body, response.status)}`
    )
  }

  const syncedAt = new Date().toISOString()

  // Record the synced shell structure in our DB.
  const { error: updateError } = await supabase
    .from('campaigns')
    .update({
      shell_synced_at: syncedAt,
      shell_doc_id: messagingDocId,
      shell_step_count: stepCount,
      shell_delays: delays,
      shell_segment_id: segmentId,
      updated_at: syncedAt,
    })
    .eq('id', campaignInternalId)
    .eq('organisation_id', organisationId)

  if (updateError) {
    logger.warn('syncSequenceShell: shell synced on provider but DB update failed', {
      campaignInternalId,
      error: updateError.message,
    })
  }

  logger.info('syncSequenceShell: shell synced', {
    campaignExternalId,
    campaignInternalId,
    stepCount,
    segmentId,
    messagingDocId,
  })

  return { ok: true, stepCount, syncedAt }
}

// ─── Re-export CampaignDetailResponse for tests ───────────────────────────────
export type { CampaignDetailResponse, CampaignUpdateRequest, CampaignUpdateResponse }
