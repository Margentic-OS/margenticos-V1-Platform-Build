import type { ServiceRoleClient } from '@/lib/supabase/service-role'
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
import * as Sentry from '@sentry/nextjs'
import { Database, Json } from '@/types/database'
import { logger } from '@/lib/logger'
import { classifyReply } from '@/lib/agents/reply-classifier'
// ADR-001 deferred (C3-2): sendThreadReply is still imported by vendor name; needs
// capability-based dispatch — BACKLOG "ADR-001 channel/source agnosticism — pending decision".
// The SUPPRESSION half of this file no longer is: it goes through can_suppress_contact.
import {
  sendThreadReply,
} from '@/lib/integrations/handlers/instantly/reply-actions'
import { getInstantlyApiActive } from '@/lib/integrations/handlers/instantly/auth'
import { resolveInstantlyBaseUrl } from '@/lib/integrations/handlers/instantly/constants'
import {
  suppressProspectAtProvider,
  suppressAddressAtProvider,
} from '@/lib/suppression/provider-suppression'
import { orchestrateDraft } from './draft-orchestrator'
import { sendOperatorReplyNotification } from '@/lib/notifications/send-operator-reply-notification'

type SupabaseServiceClient = ServiceRoleClient

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
// Sign-off: founder first name only per ADR-020.
// If founderFirstName is empty, returns null — caller must treat as send_failed.

function buildCalendlyReplyBody(
  prospectFirstName: string | null,
  founderFirstName: string,
  calendlyUrl: string,
): string | null {
  if (!founderFirstName.trim()) return null

  const firstName = prospectFirstName?.trim() || 'there'
  const separator = calendlyUrl.includes('?') ? '&' : '?'
  const taggedUrl = `${calendlyUrl}${separator}utm_source=reply&utm_medium=email`

  return [
    `Hi ${firstName},`,
    '',
    `Great to hear from you. Grab a slot that works: ${taggedUrl}`,
    '',
    founderFirstName.trim(),
  ].join('\n')
}

// ── Provider lead resolution ─────────────────────────────────────────────────
//
// REMOVED 2026-09-04, and the reason is worth keeping.
//
// resolveInstantlyLeadId lived here. It read raw.lead_id off the reply, and where that was
// absent it asked the provider for leads matching the address with `limit: 1` and took
// items[0]. If the address existed as more than one lead it suppressed ONE and left the
// rest sending, and no caller could tell the difference. The provider's own list endpoint
// carries a distinct_contacts flag whose whole purpose is collapsing duplicates of one
// address, which is the provider stating that duplicates are an expected state.
//
// Both jobs now belong to the can_suppress_contact capability:
//   findLeadIds  pages the address lookup to exhaustion and returns EVERY match
//   stopLead     writes, then reads the lead back before reporting success
//
// The stored outbound_lead_id from upload is used as well, not instead: it is the
// authoritative id for the campaign we uploaded into, and the address sweep is what catches
// a lead created outside our uploads. raw.lead_id is no longer consulted, because the
// address sweep finds that same lead and finds its duplicates too.

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
  actionRowId: string | null,
  update: {
    action_succeeded: boolean
    action_taken?: string
    tier_assigned?: number
    action_payload?: Json | null
    scheduled_resume_at?: string | null
    action_error?: string | null
    instantly_response?: Json | null
  },
): Promise<void> {
  if (!actionRowId) {
    logger.error('process-reply: updateActionRow called with null id — this is a bug', { update })
    return
  }
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
  baseUrl: string,
  isActive: boolean,
  signal: {
    id: string
    organisation_id: string
    campaign_id: string | null
    raw_data: Json
    original_outbound_body: string | null
    created_at: string
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

  // ── Archived org gate — do not process signals for archived organisations ──

  const { data: archiveCheckOrg } = await supabase
    .from('organisations')
    .select('id, archived_at')
    .eq('id', signal.organisation_id)
    .single()

  if (archiveCheckOrg?.archived_at) {
    // Org is archived — record the gate action but don't process the signal.
    // action_succeeded=true because this is not a failure, just a legitimate skip.
    await insertActionRow(supabase, {
      organisation_id: signal.organisation_id,
      signal_id: signalId,
      prospect_id: null,
      campaign_id: signal.campaign_id,
      classified_intent: null,
      classification_confidence: null,
      classification_reasoning: null,
      tier_assigned: null,
      action_taken: 'org_archived',
      action_payload: null,
      action_succeeded: true,
      attempt_number: 1,
    })
    logger.info('process-reply: org archived, signal skipped', {
      signal_id: signalId,
      organisation_id: signal.organisation_id,
      archived_at: archiveCheckOrg.archived_at,
    })
    await markSignalProcessed(supabase, signalId)
    return 'processed'
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
  // The suppression path needs both: the stored provider lead id is the authoritative one
  // for the campaign we uploaded into, and the row's own address is what the duplicate
  // sweep searches on. Reading them here avoids a second fetch inside the dispatch.
  let prospectEmail: string | null = null
  let prospectLeadId: string | null = null

  if (fromEmail?.trim()) {
    const { data: prospect } = await supabase
      .from('prospects')
      .select('id, first_name, suppressed, email, outbound_lead_id')
      .eq('organisation_id', signal.organisation_id)
      .ilike('email', fromEmail)
      .maybeSingle()

    if (prospect) {
      // ── Store the link on the signal, not just in this local ──────────────
      //
      // signals.prospect_id was written exactly once, by the poller, hardcoded to NULL with
      // the note that prospect linkage is a downstream concern. Downstream is here, and it
      // resolved the prospect into a local variable and never wrote it back, so the column
      // was NULL on every signal row in production while reply_handling_actions carried the
      // answer. "Who replied" was unanswerable from the signals table alone.
      //
      // BEFORE the suppressed check below, deliberately. That check returns early, and the
      // prospect is just as identified on that path: linking only the paths that continue
      // would leave exactly the rows an operator is most likely to be investigating unlinked.
      //
      // Best-effort on purpose: this is a link for later reads, and failing to store it must
      // never stop the reply being handled. The action row is the durable record of the act.
      const { error: linkError } = await supabase
        .from('signals')
        .update({ prospect_id: prospect.id })
        .eq('id', signalId)
        .eq('organisation_id', signal.organisation_id)

      if (linkError) {
        logger.warn('process-reply: could not store prospect link on signal', {
          signal_id: signalId,
          error: linkError.message,
        })
      }

      if (prospect.suppressed) {
        logger.info('process-reply: prospect already suppressed', { signal_id: signalId, prospect_id: prospect.id })
        await markSignalProcessed(supabase, signalId)
        return 'skipped'
      }
      prospectId = prospect.id
      prospectFirstName = prospect.first_name
      prospectEmail = prospect.email
      prospectLeadId = prospect.outbound_lead_id
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
    .select('name, calendly_url, founder_first_name')
    .eq('id', signal.organisation_id)
    .maybeSingle() as { data: { name: string; calendly_url: string | null; founder_first_name: string | null } | null }

  const calendlyUrl = org?.calendly_url ?? null
  const founderFirstName = org?.founder_first_name?.trim() ?? ''

  // ── Classify — always pass subject for OOO detection ─────────────────────

  // ADR-001 deferred (C3-4 cont.): body.text and eaccount are Instantly V2 field names — BACKLOG "ADR-001 channel/source agnosticism — pending decision"
  const bodyRaw = raw.body
  const emailBody: string =
    (typeof bodyRaw === 'object' && bodyRaw !== null
      ? (bodyRaw as Record<string, unknown>).text as string | undefined
      : typeof bodyRaw === 'string' ? bodyRaw : undefined) ?? ''

  if (!emailBody.trim()) {
    logger.warn('process-reply: empty reply body — skipping classifier', { signal_id: signalId })
    await insertActionRow(supabase, {
      organisation_id: signal.organisation_id,
      signal_id: signalId,
      prospect_id: prospectId,
      campaign_id: signal.campaign_id,
      classified_intent: 'unclear',
      classification_confidence: null,
      classification_reasoning: 'empty body, classifier skipped',
      tier_assigned: 2,
      action_taken: 'log_only',
      action_payload: { reason: 'empty body, classifier skipped' } as Json,
      action_succeeded: null,
      attempt_number: attemptNumber,
    })
    await markSignalProcessed(supabase, signalId)
    return 'processed'
  }

  // Normalise subject: pass undefined rather than empty string or non-string so the
  // classifier's subject? ternary omits it from the prompt cleanly.
  const subject = typeof raw.subject === 'string' && raw.subject.trim()
    ? raw.subject
    : undefined

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

  // ── Tell the OPERATOR a reply needs actioning, on every qualifying reply ───────
  //
  // Excludes: opt_out, out_of_office, unclear. Those three are handled without a person:
  // an opt-out suppresses, an out-of-office pauses, and unclear is logged. Nothing waits
  // on the operator, so notifying would train them to ignore the alert.
  // Includes: positive_direct_booking, positive_passive, information_request_*, objection_mild
  //
  // This replaces a CLIENT email that fired once per organisation for ever. The client's
  // dashboard is the right surface for their replies and it already exists; the operator
  // is the one who has to act and was receiving nothing at all.
  if (!['opt_out', 'out_of_office', 'unclear'].includes(intent)) {
    await sendOperatorReplyNotification({
      supabase,
      organisationId: signal.organisation_id,
      signalId: signalId,          // the dedup key: one notification per reply event
      prospectId: prospectId,
      classifiedIntent: intent,
      signalCreatedAt: signal.created_at,  // backfill guard: only fire for new events
    })
  }

  // ── Write action row before acting (Tier 1 only — idempotency guard on send_reply/suppress) ──
  // For the orchestrator path (actionTaken === 'log_only'), the row is written AFTER
  // orchestrateDraft returns. A throw therefore leaves no row and the signal retries
  // on the next cron run without a false-positive idempotency hit.

  let actionRowId: string | null = null
  if (actionTaken !== 'log_only') {
    actionRowId = await insertActionRow(supabase, {
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
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  if (actionTaken === 'suppress') {
    // ── DB suppression FIRST, then the provider ───────────────────────────────
    //
    // Order matters. If the provider call went first and the database write then failed,
    // the person would be stopped at the provider while our record still said they may be
    // mailed. That is the failure in the safe direction, but it is still a disagreement,
    // and the reconciliation sweep would have nothing to compare against.
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
    } else {
      // An explicit opt-out from an address with no prospect row. The database half cannot
      // be applied at all, so the provider call below is the ONLY thing standing between
      // this person and the rest of the sequence.
      logger.error('process-reply: opt_out signal — prospect not found in DB, DB suppression skipped', {
        signal_id: signalId,
        from_email: fromEmail,
      })
    }

    // ── The provider ──────────────────────────────────────────────────────────
    //
    // ═══════════════════════════════════════════════════════════════════════════
    // A SUPPRESSION THAT DID NOT REACH THE PROVIDER IS A FAILURE. FIXED 2026-09-04.
    //
    // What stood here reported SUCCESS when no lead id could be resolved:
    //
    //     suppressResult = { ok: true, error: undefined, raw: undefined }
    //
    // The reasoning written beside it was that the database is authoritative, so the
    // prospect is safe on the database alone. That is true for FUTURE uploads, which
    // findBlockedProspects gates, and it is false for the sequence already in flight,
    // which is the only thing this call can stop. So the one case where the call mattered
    // most was the one recorded as a success: the action row said succeeded, the signal was
    // marked processed, and the retry never happened.
    //
    // This is validate-one-thing-return-another, the shape CLAUDE.md records from the
    // opt-out footer that was validated and then discarded by a return-value bug. A check
    // ran, a different value was returned, and the run reported success.
    //
    // Now: no lead resolved is a failure, a provider error is a failure, and a write the
    // read-back cannot confirm is a failure. Only 'not_required' is a clean pass without a
    // provider call, and it means the provider genuinely holds nothing for this person.
    // ═══════════════════════════════════════════════════════════════════════════
    const suppression = prospectId
      ? await suppressProspectAtProvider(supabase, {
          id: prospectId,
          organisation_id: signal.organisation_id,
          email: prospectEmail ?? fromEmail ?? null,
          outbound_lead_id: prospectLeadId,
        })
      : fromEmail
        ? await suppressAddressAtProvider(supabase, signal.organisation_id, fromEmail)
        : {
            status: 'failed' as const,
            stoppedLeadIds: [],
            error:
              'opt-out signal carries neither a prospect row nor an address, so nothing ' +
              'can be stopped anywhere',
          }

    const suppressionOk = suppression.status !== 'failed'

    await updateActionRow(supabase, actionRowId, {
      action_succeeded: suppressionOk,
      action_payload: {
        provider_lead_ids: suppression.stoppedLeadIds,
        provider_suppression_status: suppression.status,
        lead_email: fromEmail,
      } as Json,
      action_error: suppression.error,
    })

    if (suppressionOk) {
      await markSignalProcessed(supabase, signalId)
      return 'processed'
    }

    // Left unprocessed so it retries. The database suppression above already stands, so a
    // retry re-attempts only the provider half, which is idempotent.
    logger.error('process-reply: the provider was not told about an opt-out', {
      signal_id: signalId,
      prospect_id: prospectId,
      error: suppression.error,
    })
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

    // ADR-020: sign-off is founder first name. Fail loud if not set.
    if (!founderFirstName) {
      logger.error('process-reply: founder_first_name not set — cannot build Calendly reply', {
        signal_id: signalId,
        organisation_id: signal.organisation_id,
        fix: "UPDATE organisations SET founder_first_name = '<name>' WHERE id = '<org_id>'",
      })
      await updateActionRow(supabase, actionRowId, {
        action_succeeded: false,
        action_error: 'founder_first_name_required_but_missing',
      })
      return 'error'
    }

    const bodyText = buildCalendlyReplyBody(prospectFirstName, founderFirstName, calendlyUrl)
    if (!bodyText) {
      // buildCalendlyReplyBody returns null only if founderFirstName is empty — guarded above.
      logger.error('process-reply: buildCalendlyReplyBody returned null unexpectedly', { signal_id: signalId })
      await updateActionRow(supabase, actionRowId, {
        action_succeeded: false,
        action_error: 'founder_first_name_required_but_missing',
      })
      return 'error'
    }

    const replySubject = (raw.subject as string | undefined) ?? ''

    const replyResult = await sendThreadReply(
      { replyToUuid, eaccount, subject: replySubject, bodyText },
      instantlyApiKey,
      baseUrl,
      isActive,
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
        const { error: updateError } = await supabase
          .from('prospects')
          .update({ qualification_status: 'replied_positive', updated_at: new Date().toISOString() })
          .eq('id', prospectId)

        if (updateError) {
          logger.error('process-reply: failed to update qualification_status', {
            signal_id: signalId,
            prospect_id: prospectId,
            error: updateError.message,
            error_code: updateError.code,
          })
          Sentry.captureException(updateError, {
            tags: { component: 'reply-handler', action: 'qualification_status_update' },
            extra: { signal_id: signalId, prospect_id: prospectId },
          })
          await Sentry.flush(2000)
        }
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

  // Phase 2: orchestrate draft for all non-Tier-1 intents.
  // Action row is written here, after orchestrateDraft returns, with the correct
  // action_taken and tier values. A throw in orchestrateDraft leaves no row so
  // the next cron run retries cleanly (no false-positive idempotency hit).
  try {
    const orchResult = await orchestrateDraft({
      signal: {
        id: signal.id,
        organisation_id: signal.organisation_id,
        campaign_id: signal.campaign_id,
        raw_data: signal.raw_data,
        original_outbound_body: signal.original_outbound_body,
      },
      classification: { intent, confidence, reasoning },
      prospectId,
      supabase,
    })

    let orchActionTaken: string
    let orchTierAssigned: number
    let orchActionPayload: Json
    if (orchResult.kind === 'log_only') {
      const logPayload: Record<string, unknown> = { intent, confidence }
      if (intent === 'positive_direct_booking') {
        logPayload.reason = `confidence ${confidence} below threshold ${POSITIVE_BOOKING_CONFIDENCE_THRESHOLD}`
      }
      orchActionTaken = 'log_only'
      orchTierAssigned = tierAssigned
      orchActionPayload = logPayload as Json
    } else {
      orchActionTaken = orchResult.kind
      orchTierAssigned = orchResult.tier
      orchActionPayload = orchResult as Json
    }

    await insertActionRow(supabase, {
      organisation_id: signal.organisation_id,
      signal_id: signalId,
      prospect_id: prospectId,
      campaign_id: signal.campaign_id,
      classified_intent: intent,
      classification_confidence: confidence,
      classification_reasoning: reasoning,
      tier_assigned: orchTierAssigned,
      action_taken: orchActionTaken,
      action_succeeded: true,
      action_payload: orchActionPayload,
      attempt_number: attemptNumber,
    })

    await markSignalProcessed(supabase, signalId)
    return 'processed'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // No action row was written — signal stays unprocessed and retries on the next cron run.
    logger.error('process-reply: orchestrateDraft threw — signal will retry', { signal_id: signalId, error: msg })
    return 'error'
  }
}

// ── Batch runner ──────────────────────────────────────────────────────────────

// ADR-001 deferred (C3-3 cont.): processReplies(supabase, instantlyApiKey) — key should flow via handler, not caller — BACKLOG "ADR-001 channel/source agnosticism — pending decision"
export async function processReplies(
  supabase: SupabaseServiceClient,
  instantlyApiKey: string,
): Promise<ProcessResult> {
  const isActive = await getInstantlyApiActive()
  const baseUrl = resolveInstantlyBaseUrl(isActive)
  const result: ProcessResult = { processed: 0, skipped: 0, errors: 0 }

  const { data: signals, error: fetchError } = await supabase
    .from('signals')
    .select('id, organisation_id, campaign_id, raw_data, original_outbound_body, created_at')
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
      const outcome = await processOneSignal(supabase, instantlyApiKey, baseUrl, isActive, signal)
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
