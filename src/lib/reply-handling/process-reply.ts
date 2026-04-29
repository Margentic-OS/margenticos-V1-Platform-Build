// src/lib/reply-handling/process-reply.ts
//
// Stateless reply processor. Called by /api/cron/process-replies on each cron tick.
// Fetches up to 20 unprocessed reply_received signals and processes each sequentially.
//
// Concurrent-run safety:
//   SELECT FOR UPDATE SKIP LOCKED cannot protect this processor. Postgres row locks are held
//   only for the duration of a transaction — the lock releases when the fetch query commits,
//   before any API calls run, so it provides no actual protection across the network boundary.
//   Concurrent-run safety relies instead on:
//     (a) Cron design: 55s timeout < 5min interval — overlap is impossible by design.
//     (b) Write-before-act: action row check (idempotency) prevents duplicate sends on the
//         rare case of a manual trigger + cron overlap.
//
// Idempotency per signal (checked at start of each run):
//   Any terminal action row (suppress/ooo_log/send_reply/log_only/permanently_failed) found
//   → signal is considered handled; mark processed and skip.
//   send_reply with action_succeeded = null → previous run was interrupted mid-call; mark
//   processed and warn — do not retry to avoid duplicate email.
//   send_reply with action_succeeded = false → API failed; mark processed and warn — requires
//   manual review rather than automated retry (risk of duplicate send on retry).
//   3+ classifier_failed rows → write permanently_failed; mark processed; stop retrying.
//
// Type assertions (as any) on reply_handling_actions and organisations.calendly_url resolve
// automatically after the reply-handling migration is applied and `supabase gen types` is run.

import { SupabaseClient } from '@supabase/supabase-js'
import { Database, Json } from '@/types/database'
import { logger } from '@/lib/logger'
import { classifyReply } from '@/lib/agents/reply-classifier'
// ADR-001 deferred (C3-2): handler imported by vendor name; needs capability-based dispatch — BACKLOG "ADR-001 channel/source agnosticism — pending decision"
import {
  suppressLead,
  sendThreadReply,
} from '@/lib/integrations/handlers/instantly/reply-actions'

type SupabaseServiceClient = SupabaseClient<Database>

const CLASSIFIER_RETRY_LIMIT = 3
const POSITIVE_BOOKING_CONFIDENCE_THRESHOLD = 0.90
const BATCH_SIZE = 20

export interface ProcessResult {
  processed: number
  skipped: number
  errors: number
}

// ── OOO return date parser ────────────────────────────────────────────────────
// Deterministic regex — ADR-018: no LLM for pattern-matchable text.
// Returns ISO timestamptz string if a plausible future date is found, null otherwise.

const OOO_DATE_PATTERNS: RegExp[] = [
  /(?:back|return(?:ing)?|available|in the office)\s+(?:on\s+)?([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?)/i,
  /until\s+([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?)/i,
  /(?:return(?:ing)?|back)\s+(?:on\s+)?(\d{1,2}[\\/\-.]\d{1,2}[\\/\-.]\d{2,4})/i,
]

function parseOooReturnDate(body: string): string | null {
  for (const pattern of OOO_DATE_PATTERNS) {
    const match = body.match(pattern)
    if (!match?.[1]) continue

    const parsed = new Date(match[1])
    if (isNaN(parsed.getTime())) continue

    const now = new Date()
    const sixMonthsOut = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000)

    if (parsed <= now || parsed > sixMonthsOut) continue

    return parsed.toISOString()
  }
  return null
}

// ── Calendly reply body ───────────────────────────────────────────────────────
// Hardcoded template — no LLM needed, no scrubAITells needed (not generated copy).
// Sign-off: "[Org Name] Team" per CLAUDE.md reply handling spec.

function buildCalendlyReplyBody(
  prospectFirstName: string | null,
  orgName: string,
  calendlyUrl: string,
): string {
  const firstName = prospectFirstName?.trim() || 'there'
  const separator = calendlyUrl.includes('?') ? '&' : '?'
  const taggedUrl = `${calendlyUrl}${separator}utm_source=reply&utm_medium=email`

  return [
    `Hi ${firstName},`,
    '',
    `Great to hear from you. Grab a slot that works: ${taggedUrl}`,
    '',
    `${orgName} Team`,
  ].join('\n')
}

// ── Instantly lead ID resolver ────────────────────────────────────────────────
// Looks up the Instantly lead UUID by email — needed for suppressLead().
// The reply email object may carry this as `lead_id` or `from_address_id`.
// If neither is present, falls back to a POST /leads/list lookup by email.
// ADR-001 deferred (C3-1): Instantly API called directly inside processor; belongs in handler — BACKLOG "ADR-001 channel/source agnosticism — pending decision"

async function resolveInstantlyLeadId(
  raw: Record<string, unknown>,
  apiKey: string,
  fromEmail: string,
): Promise<string | null> {
  const fromRaw = (raw.lead_id ?? raw.from_address_id) as string | undefined
  if (fromRaw) return fromRaw

  // Fallback: look up by email
  try {
    const response = await fetch('https://api.instantly.ai/api/v2/leads/list', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: fromEmail, limit: 1 }),
    })
    if (!response.ok) return null
    const json = await response.json().catch(() => null)
    const items = (Array.isArray(json) ? json : json?.items) as Array<{ id: string }> | undefined
    return items?.[0]?.id ?? null
  } catch {
    return null
  }
}

// ── Idempotency check ─────────────────────────────────────────────────────────

interface ExistingActionSummary {
  classifierFailedCount: number
  terminalAction: { action_taken: string; action_succeeded: boolean | null } | null
}

async function getExistingActionSummary(
  supabase: SupabaseServiceClient,
  signalId: string,
): Promise<ExistingActionSummary | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rows, error } = await (supabase as any)
    .from('reply_handling_actions')
    .select('action_taken, action_succeeded')
    .eq('signal_id', signalId)

  if (error) {
    logger.error('process-reply: failed to fetch existing action rows', { signal_id: signalId, error: error.message })
    return null
  }

  let classifierFailedCount = 0
  let terminalAction: ExistingActionSummary['terminalAction'] = null

  for (const row of (rows ?? []) as Array<{ action_taken: string; action_succeeded: boolean | null }>) {
    if (row.action_taken === 'classifier_failed') {
      classifierFailedCount++
    } else {
      // Any non-classifier row is terminal — take the first one found.
      terminalAction ??= row
    }
  }

  return { classifierFailedCount, terminalAction }
}

// ── Action row helpers ────────────────────────────────────────────────────────

interface ActionRowBase {
  organisation_id: string
  signal_id: string
  prospect_id: string | null
  campaign_id: string | null
  classified_intent: string | null
  classification_confidence: number | null
  classification_reasoning: string | null
  tier_assigned: number | null
  action_taken: string
  action_payload?: Json | null
  scheduled_resume_at?: string | null
  action_succeeded?: boolean | null
  instantly_response?: Json | null
  attempt_number: number
}

async function insertActionRow(
  supabase: SupabaseServiceClient,
  row: ActionRowBase,
): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from('reply_handling_actions')
    .insert({ ...row, updated_at: new Date().toISOString() })
    .select('id')
    .maybeSingle()

  if (error) {
    logger.error('process-reply: failed to insert action row', { signal_id: row.signal_id, error: error.message })
    return null
  }
  return (data as { id: string } | null)?.id ?? null
}

async function updateActionRow(
  supabase: SupabaseServiceClient,
  actionRowId: string,
  update: {
    action_succeeded: boolean
    action_payload?: Json | null
    scheduled_resume_at?: string | null
    action_error?: string | null
    instantly_response?: Json | null
  },
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('reply_handling_actions')
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq('id', actionRowId)

  if (error) {
    logger.error('process-reply: failed to update action row', { action_row_id: actionRowId, error: error.message })
  }
}

async function markSignalProcessed(
  supabase: SupabaseServiceClient,
  signalId: string,
): Promise<void> {
  const { error } = await supabase
    .from('signals')
    .update({ processed: true, processed_at: new Date().toISOString() })
    .eq('id', signalId)

  if (error) {
    logger.error('process-reply: failed to mark signal processed', { signal_id: signalId, error: error.message })
  }
}

// ── Single signal processor ───────────────────────────────────────────────────

// ADR-001 deferred (C3-3): instantlyApiKey should be resolved inside handler via getCredential(capability), not passed as a named primitive — BACKLOG "ADR-001 channel/source agnosticism — pending decision"
async function processOneSignal(
  supabase: SupabaseServiceClient,
  instantlyApiKey: string,
  signal: {
    id: string
    organisation_id: string
    campaign_id: string | null
    raw_data: Json
  },
): Promise<'processed' | 'skipped' | 'error'> {
  const raw = signal.raw_data as Record<string, unknown>
  const signalId = signal.id

  // ── Idempotency check ─────────────────────────────────────────────────────

  const existing = await getExistingActionSummary(supabase, signalId)

  if (existing === null) {
    // DB error reading prior action rows — safer to abort than risk reprocessing a handled signal.
    return 'error'
  }

  if (existing.terminalAction) {
    const { action_taken, action_succeeded } = existing.terminalAction
    if (action_taken === 'send_reply' && action_succeeded === null) {
      logger.warn('process-reply: send_reply interrupted mid-call — marking processed, manual review needed', { signal_id: signalId })
    } else if (action_taken === 'send_reply' && action_succeeded === false) {
      logger.warn('process-reply: send_reply API failed on previous run — marking processed, manual review needed', { signal_id: signalId })
    } else if (action_taken === 'suppress' && action_succeeded === false) {
      // DB suppression was applied on the previous run, but Instantly-side suppression failed.
      // The prospect cannot receive future MargenticOS sends (DB is authoritative), but their
      // lt_interest_status in Instantly was not updated. Verify manually in Instantly.
      logger.warn('process-reply: Instantly-side suppression failed on previous run — DB suppression applied, Instantly lead status not updated, manual review needed', { signal_id: signalId })
    } else {
      logger.info('process-reply: signal already handled', { signal_id: signalId, action_taken, action_succeeded })
    }
    await markSignalProcessed(supabase, signalId)
    return 'skipped'
  }

  // ── Retry limit check ─────────────────────────────────────────────────────

  const attemptNumber = existing.classifierFailedCount + 1

  if (existing.classifierFailedCount >= CLASSIFIER_RETRY_LIMIT) {
    logger.warn('process-reply: classifier retry limit reached', {
      signal_id: signalId,
      failed_attempts: existing.classifierFailedCount,
    })
    await insertActionRow(supabase, {
      organisation_id: signal.organisation_id,
      signal_id: signalId,
      prospect_id: null,
      campaign_id: signal.campaign_id,
      classified_intent: null,
      classification_confidence: null,
      classification_reasoning: null,
      tier_assigned: null,
      action_taken: 'permanently_failed',
      action_payload: { reason: `classifier_failed ${existing.classifierFailedCount} times` } as Json,
      action_succeeded: null,
      attempt_number: attemptNumber,
    })
    await markSignalProcessed(supabase, signalId)
    return 'processed'
  }

  // ── Resolve prospect ──────────────────────────────────────────────────────

  // ADR-001 deferred (C3-4): field names are Instantly V2–specific; needs source-aware extractors keyed by signal.source — BACKLOG "ADR-001 channel/source agnosticism — pending decision"
  const fromEmail = (
    raw.from_address_email ?? (raw.from as Record<string, unknown>)?.address
  ) as string | undefined

  let prospectId: string | null = null
  let prospectFirstName: string | null = null

  if (fromEmail) {
    const { data: prospect } = await supabase
      .from('prospects')
      .select('id, first_name, suppressed')
      .eq('organisation_id', signal.organisation_id)
      .ilike('email', fromEmail)
      .maybeSingle()

    if (prospect) {
      if (prospect.suppressed) {
        logger.info('process-reply: prospect already suppressed', { signal_id: signalId, prospect_id: prospect.id })
        await markSignalProcessed(supabase, signalId)
        return 'skipped'
      }
      prospectId = prospect.id
      prospectFirstName = prospect.first_name
    } else {
      logger.warn('process-reply: no prospect matched from_address_email', { signal_id: signalId, from_email: fromEmail })
    }
  } else {
    logger.warn('process-reply: raw_data has no from_address_email', { signal_id: signalId })
  }

  // ── Fetch org (name + calendly_url) ──────────────────────────────────────
  // calendly_url added by 20260429_reply_handling.sql — not in generated types until applied.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: org } = await (supabase as any)
    .from('organisations')
    .select('name, calendly_url')
    .eq('id', signal.organisation_id)
    .maybeSingle() as { data: { name: string; calendly_url: string | null } | null }

  const orgName = org?.name ?? 'The Team'
  const calendlyUrl = org?.calendly_url ?? null

  // ── Classify — always pass subject for OOO detection ─────────────────────

  // ADR-001 deferred (C3-4 cont.): body.text and eaccount are Instantly V2 field names — BACKLOG "ADR-001 channel/source agnosticism — pending decision"
  const bodyRaw = raw.body
  const emailBody: string =
    (typeof bodyRaw === 'object' && bodyRaw !== null
      ? (bodyRaw as Record<string, unknown>).text as string | undefined
      : typeof bodyRaw === 'string' ? bodyRaw : undefined) ?? ''

  const subject = raw.subject as string | undefined

  const classification = await classifyReply(emailBody, subject)

  if (!classification) {
    logger.error('process-reply: classification failed', { signal_id: signalId, attempt: attemptNumber })
    await insertActionRow(supabase, {
      organisation_id: signal.organisation_id,
      signal_id: signalId,
      prospect_id: prospectId,
      campaign_id: signal.campaign_id,
      classified_intent: null,
      classification_confidence: null,
      classification_reasoning: null,
      tier_assigned: null,
      action_taken: 'classifier_failed',
      action_payload: { error_message: 'Haiku returned null' } as Json,
      action_succeeded: null,
      attempt_number: attemptNumber,
    })
    return 'error'
    // Signal stays unprocessed — will be retried on next cron run up to CLASSIFIER_RETRY_LIMIT.
  }

  const { intent, confidence, reasoning } = classification

  // ── Determine action ──────────────────────────────────────────────────────

  let actionTaken: string
  if (intent === 'opt_out') {
    actionTaken = 'suppress'
  } else if (intent === 'out_of_office') {
    actionTaken = 'ooo_log'
  } else if (intent === 'positive_direct_booking' && confidence >= POSITIVE_BOOKING_CONFIDENCE_THRESHOLD) {
    actionTaken = 'send_reply'
  } else {
    actionTaken = 'log_only'
  }

  const tierAssigned = ['suppress', 'ooo_log', 'send_reply'].includes(actionTaken) ? 1 : 2

  // ── Write action row before acting (idempotency guard on send_reply) ──────

  const actionRowId = await insertActionRow(supabase, {
    organisation_id: signal.organisation_id,
    signal_id: signalId,
    prospect_id: prospectId,
    campaign_id: signal.campaign_id,
    classified_intent: intent,
    classification_confidence: confidence,
    classification_reasoning: reasoning,
    tier_assigned: tierAssigned,
    action_taken: actionTaken,
    action_succeeded: null,
    attempt_number: attemptNumber,
  })

  if (!actionRowId) {
    // Cannot proceed without write-before-act guard in place.
    return 'error'
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  if (actionTaken === 'suppress') {
    const leadInstantlyId = fromEmail
      ? await resolveInstantlyLeadId(raw, instantlyApiKey, fromEmail)
      : null

    let suppressResult: { ok: boolean; error: string | undefined; raw: unknown } = {
      ok: false,
      error: 'no lead ID resolved',
      raw: undefined,
    }

    if (leadInstantlyId) {
      const r = await suppressLead(leadInstantlyId, instantlyApiKey)
      suppressResult = { ok: r.ok, error: r.error, raw: r.raw }
    } else {
      logger.warn('process-reply: could not resolve Instantly lead ID — DB suppression only', {
        signal_id: signalId,
        from_email: fromEmail,
      })
      // DB suppression is authoritative — prospect cannot receive any future MargenticOS
      // communication once prospects.suppressed = true. Instantly-side suppression
      // (lt_interest_status = -1) is best-effort secondary protection. If the lead ID
      // can't be resolved, log the warning and proceed; the prospect is safe via DB alone.
      suppressResult = { ok: true, error: undefined, raw: undefined }
    }

    // DB suppression is idempotent — always set even if Instantly call failed.
    if (!prospectId) {
      // Explicit opt-out with no prospect record — DB suppression cannot be applied.
      // Instantly-side suppression is the only protection. If that also failed, this
      // prospect has no suppression at all. Surfaces as error for immediate operator review.
      logger.error('process-reply: opt_out signal — prospect not found in DB, DB suppression skipped', {
        signal_id: signalId,
        from_email: fromEmail,
        instantly_suppressed: !!leadInstantlyId,
      })
    }
    if (prospectId) {
      await supabase
        .from('prospects')
        .update({
          suppressed: true,
          suppressed_at: new Date().toISOString(),
          suppression_reason: 'explicit_opt_out',
          updated_at: new Date().toISOString(),
        })
        .eq('id', prospectId)
    }

    await updateActionRow(supabase, actionRowId, {
      action_succeeded: suppressResult.ok,
      action_payload: {
        instantly_lead_id: leadInstantlyId,
        lead_email: fromEmail,
        instantly_skipped: !leadInstantlyId,
      } as Json,
      action_error: suppressResult.ok ? null : String(suppressResult.error),
      instantly_response: suppressResult.raw as Json ?? null,
    })

    if (suppressResult.ok) {
      await markSignalProcessed(supabase, signalId)
      return 'processed'
    }

    // Instantly call failed — leave unprocessed so it retries, but DB suppression already applied.
    logger.error('process-reply: suppressLead API failed', { signal_id: signalId, error: suppressResult.error })
    return 'error'
  }

  if (actionTaken === 'ooo_log') {
    const returnDate = parseOooReturnDate(emailBody)
    await updateActionRow(supabase, actionRowId, {
      action_succeeded: true,
      action_payload: {
        instantly_handled: true,
        date_parse_attempted: true,
        date_found: returnDate !== null,
        parsed_return_date: returnDate,
      } as Json,
      scheduled_resume_at: returnDate,
    })
    await markSignalProcessed(supabase, signalId)
    logger.info('process-reply: OOO logged', { signal_id: signalId, return_date: returnDate, date_found: returnDate !== null })
    return 'processed'
  }

  if (actionTaken === 'send_reply') {
    if (!calendlyUrl) {
      logger.error('process-reply: no calendly_url set for org — cannot send reply', {
        signal_id: signalId,
        organisation_id: signal.organisation_id,
        fix: "UPDATE organisations SET calendly_url = '<url>' WHERE id = '<org_id>'",
      })
      await updateActionRow(supabase, actionRowId, {
        action_succeeded: false,
        action_error: 'org calendly_url not set',
      })
      return 'error'
    }

    const replyToUuid = raw.id as string | undefined
    const eaccount = raw.eaccount as string | undefined

    if (!replyToUuid || !eaccount) {
      logger.error('process-reply: raw_data missing id or eaccount for thread reply', { signal_id: signalId })
      await updateActionRow(supabase, actionRowId, {
        action_succeeded: false,
        action_error: 'raw_data missing reply_to_uuid or eaccount',
      })
      return 'error'
    }

    const bodyText = buildCalendlyReplyBody(prospectFirstName, orgName, calendlyUrl)
    const replySubject = (raw.subject as string | undefined) ?? ''

    const replyResult = await sendThreadReply(
      { replyToUuid, eaccount, subject: replySubject, bodyText },
      instantlyApiKey,
    )

    await updateActionRow(supabase, actionRowId, {
      action_succeeded: replyResult.ok,
      action_payload: { reply_body: bodyText, calendar_link: calendlyUrl } as Json,
      action_error: replyResult.ok ? null : replyResult.error,
      instantly_response: replyResult.raw as Json ?? null,
    })

    if (replyResult.ok) {
      // Mark prospect as having replied positively.
      if (prospectId) {
        await supabase
          .from('prospects')
          .update({ qualification_status: 'replied_positive', updated_at: new Date().toISOString() })
          .eq('id', prospectId)
      }
      await markSignalProcessed(supabase, signalId)
      logger.info('process-reply: Calendly reply sent', { signal_id: signalId, prospect_id: prospectId })
      return 'processed'
    }

    logger.error('process-reply: sendThreadReply failed', { signal_id: signalId, error: replyResult.error })
    return 'error'
    // Signal stays unprocessed — but existing send_reply row (action_succeeded=false) will
    // be caught by the idempotency check on next run and marked processed for manual review.
  }

  // log_only — all other intents in Phase 1
  const logPayload: Record<string, unknown> = { intent, confidence }
  if (intent === 'positive_direct_booking') {
    logPayload.reason = `confidence ${confidence} below threshold ${POSITIVE_BOOKING_CONFIDENCE_THRESHOLD}`
  }

  await updateActionRow(supabase, actionRowId, {
    action_succeeded: true,
    action_payload: logPayload as Json,
  })
  await markSignalProcessed(supabase, signalId)
  return 'processed'
}

// ── Batch runner ──────────────────────────────────────────────────────────────

// ADR-001 deferred (C3-3 cont.): processReplies(supabase, instantlyApiKey) — key should flow via handler, not caller — BACKLOG "ADR-001 channel/source agnosticism — pending decision"
export async function processReplies(
  supabase: SupabaseServiceClient,
  instantlyApiKey: string,
): Promise<ProcessResult> {
  const result: ProcessResult = { processed: 0, skipped: 0, errors: 0 }

  const { data: signals, error: fetchError } = await supabase
    .from('signals')
    .select('id, organisation_id, campaign_id, raw_data')
    .eq('signal_type', 'reply_received')
    .eq('processed', false)
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE)

  if (fetchError) {
    logger.error('process-reply: failed to fetch signals', { error: fetchError.message })
    result.errors++
    return result
  }

  if (!signals || signals.length === 0) {
    logger.info('process-reply: no unprocessed reply signals')
    return result
  }

  logger.info('process-reply: batch start', { count: signals.length })

  for (const signal of signals) {
    try {
      const outcome = await processOneSignal(supabase, instantlyApiKey, signal)
      if (outcome === 'processed') result.processed++
      else if (outcome === 'skipped') result.skipped++
      else result.errors++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('process-reply: processOneSignal threw unexpectedly', { signal_id: signal.id, error: msg })
      result.errors++
    }
  }

  logger.info('process-reply: batch complete', { ...result })
  return result
}
