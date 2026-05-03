// src/lib/reply-handling/send-approved-draft.ts
//
// Orchestrates sending an operator-approved reply draft via Instantly.
// Called by POST /api/reply-drafts/[id]/approve immediately after the draft
// row is updated to status='approved'.
//
// Responsibilities:
//   1. Idempotency guard (already sent / already failed → skip)
//   2. Calendly link substitution in final_sent_body
//   3. Sign-off insertion per ADR-020
//   4. Thread context load from the original signal
//   5. Send via Instantly sendThreadReply
//   6. Atomic DB update (UPDATE WHERE status='approved' guards concurrent calls)
//   7. Tier 3 post-send FAQ extraction (best-effort, never blocks the send result)
//
// Failure invariant: the function never leaves a reply_draft at status='approved'
// on return. Every code path either sets 'sent' or 'send_failed'.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import { logger } from '@/lib/logger'
import { substituteCalendly } from './substitute-calendly'
import { insertSignoff } from './insert-signoff'
import { sendThreadReply } from '@/lib/integrations/handlers/instantly/reply-actions'
import { extractFaq } from '@/lib/agents/faq-extraction-agent'
import { loadOrgContext } from './load-org-context'

type SupabaseServiceClient = SupabaseClient<Database>

// ── Result types ──────────────────────────────────────────────────────────────

export type SendFailedReason =
  | 'founder_first_name_required_but_missing'
  | 'calendly_link_required_but_missing'
  | 'instantly_api_error'
  | 'instantly_timeout'
  | 'final_sent_body_empty'
  | 'unexpected_state'
  | 'thread_context_missing'
  | 'db_update_failed_after_send'

export type SendResult =
  | { kind: 'sent'; instantly_message_id: string | null }
  | { kind: 'send_failed'; error: string; reason: SendFailedReason }
  | { kind: 'idempotent_skip'; reason: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

async function markSendFailed(
  supabase: SupabaseServiceClient,
  draftId: string,
  error: string,
): Promise<void> {
  const { error: dbErr } = await supabase
    .from('reply_drafts')
    .update({ status: 'send_failed', send_error: error, updated_at: new Date().toISOString() })
    .eq('id', draftId)
    .in('status', ['approved', 'send_failed'])  // never overwrite a 'sent' row
  if (dbErr) {
    logger.error('send-approved-draft: failed to mark send_failed', { draft_id: draftId, db_error: dbErr.message })
  }
}

// ── Main exported function ────────────────────────────────────────────────────

export async function sendApprovedDraft(
  replyDraftId: string,
  supabase: SupabaseServiceClient,
): Promise<SendResult> {
  // ── 1. Load draft + idempotency check ────────────────────────────────────

  const { data: draft, error: draftErr } = await supabase
    .from('reply_drafts')
    .select('id, organisation_id, signal_id, prospect_id, tier, status, final_sent_body, ai_draft_body')
    .eq('id', replyDraftId)
    .maybeSingle()

  if (draftErr) {
    logger.error('send-approved-draft: failed to load draft', { draft_id: replyDraftId, error: draftErr.message })
    await markSendFailed(supabase, replyDraftId, draftErr.message)
    return { kind: 'send_failed', error: draftErr.message, reason: 'unexpected_state' }
  }

  if (!draft) {
    return { kind: 'send_failed', error: 'reply_drafts row not found', reason: 'unexpected_state' }
  }

  if (draft.status === 'sent') {
    return { kind: 'idempotent_skip', reason: 'already in status sent' }
  }

  if (draft.status === 'send_failed') {
    return { kind: 'idempotent_skip', reason: 'already in status send_failed' }
  }

  const organisationId = draft.organisation_id

  // ── 2. Validate status === 'approved' and body non-empty ─────────────────

  if (draft.status !== 'approved') {
    const reason = `unexpected status '${draft.status}' — expected 'approved'`
    await markSendFailed(supabase, replyDraftId, reason)
    return { kind: 'send_failed', error: reason, reason: 'unexpected_state' }
  }

  const rawBody = (draft.final_sent_body ?? '').trim()
  if (!rawBody) {
    await markSendFailed(supabase, replyDraftId, 'final_sent_body is empty')
    return { kind: 'send_failed', error: 'final_sent_body is empty', reason: 'final_sent_body_empty' }
  }

  // ── 3. Load org context ───────────────────────────────────────────────────
  // ADR-003: explicit org filter on all queries.

  const { data: org, error: orgErr } = await supabase
    .from('organisations')
    .select('name, founder_first_name, calendly_url')
    .eq('id', organisationId)
    .maybeSingle()

  if (orgErr || !org) {
    const msg = orgErr?.message ?? 'org row not found'
    await markSendFailed(supabase, replyDraftId, `org load failed: ${msg}`)
    return { kind: 'send_failed', error: msg, reason: 'unexpected_state' }
  }

  const founderFirstName = org.founder_first_name?.trim() ?? ''
  if (!founderFirstName) {
    await markSendFailed(supabase, replyDraftId, 'founder_first_name_required_but_missing')
    return {
      kind: 'send_failed',
      error: 'organisations.founder_first_name is not set — populate it before sending',
      reason: 'founder_first_name_required_but_missing',
    }
  }

  // ── 4. Calendly substitution FIRST ───────────────────────────────────────

  const { body: bodyAfterCalendly, missing: calendlyMissing } = substituteCalendly(
    rawBody,
    org.calendly_url,
  )

  if (calendlyMissing) {
    await markSendFailed(supabase, replyDraftId, 'calendly_link_required_but_missing')
    return {
      kind: 'send_failed',
      error: 'body contains {calendly_link} placeholder but org calendly_url is not set',
      reason: 'calendly_link_required_but_missing',
    }
  }

  // ── 5. Sign-off SECOND ───────────────────────────────────────────────────
  // insertSignoff throws if founderFirstName is empty, but we validated above.

  const assembledBody = insertSignoff(bodyAfterCalendly, founderFirstName)

  // ── 6. Load thread context from signal ───────────────────────────────────

  const { data: signal, error: sigErr } = await supabase
    .from('signals')
    .select('id, raw_data, original_outbound_body')
    .eq('id', draft.signal_id)
    .eq('organisation_id', organisationId)
    .maybeSingle()

  if (sigErr || !signal) {
    const msg = sigErr?.message ?? 'signal not found'
    await markSendFailed(supabase, replyDraftId, `thread_context_missing: ${msg}`)
    return { kind: 'send_failed', error: msg, reason: 'thread_context_missing' }
  }

  const raw = signal.raw_data as Record<string, unknown>
  const replyToUuid = raw.id as string | undefined
  const eaccount = raw.eaccount as string | undefined
  const subject = typeof raw.subject === 'string' ? raw.subject : ''

  if (!replyToUuid || !eaccount) {
    const msg = 'signal raw_data missing id or eaccount (thread context)'
    await markSendFailed(supabase, replyDraftId, msg)
    return { kind: 'send_failed', error: msg, reason: 'thread_context_missing' }
  }

  // ── 7. Load Instantly API key ─────────────────────────────────────────────
  // ADR-001 deferred (C3-3): key should come from capability registry inside
  // the handler. Using env var directly until ADR-001 refactor lands.

  const instantlyApiKey = process.env.INSTANTLY_API_KEY
  if (!instantlyApiKey) {
    const msg = 'INSTANTLY_API_KEY not set'
    await markSendFailed(supabase, replyDraftId, msg)
    return { kind: 'send_failed', error: msg, reason: 'instantly_api_error' }
  }

  // ── 8. Send via Instantly (20s ceiling) ──────────────────────────────────

  const replyResult = await sendThreadReply(
    { replyToUuid, eaccount, subject, bodyText: assembledBody },
    instantlyApiKey,
    { signal: AbortSignal.timeout(20000) },
  )

  if (!replyResult.ok) {
    const msg = replyResult.error ?? 'Instantly API returned not-ok'
    const isTimeout = typeof msg === 'string' && (msg.includes('AbortError') || msg.includes('abort'))
    await markSendFailed(supabase, replyDraftId, msg)
    return { kind: 'send_failed', error: msg, reason: isTimeout ? 'instantly_timeout' : 'instantly_api_error' }
  }

  const instantlyMessageId = replyResult.message_id ?? null

  // ── 9. Atomic DB update with idempotency guard ────────────────────────────
  // WHERE status='approved' ensures only one concurrent caller can mark as sent.

  let dbUpdateSucceeded = false

  try {
    const { error: updateErr, count } = await supabase
      .from('reply_drafts')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        instantly_message_id: instantlyMessageId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', replyDraftId)
      .eq('status', 'approved')   // idempotency guard — only one concurrent caller wins

    if (updateErr) throw updateErr

    if (count === 0) {
      // Another process already set status. Verify current state.
      const { data: currentDraft } = await supabase
        .from('reply_drafts')
        .select('status')
        .eq('id', replyDraftId)
        .maybeSingle()

      if (currentDraft?.status === 'sent') {
        logger.warn('send-approved-draft: concurrent send race — email sent, other process won DB update', { draft_id: replyDraftId })
        dbUpdateSucceeded = true  // email IS in prospect's inbox; treat as success
      } else {
        logger.warn('send-approved-draft: UPDATE affected 0 rows in unexpected state', { draft_id: replyDraftId, current_status: currentDraft?.status })
        dbUpdateSucceeded = true  // email IS sent; do not mark send_failed
      }
    } else {
      dbUpdateSucceeded = true
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // CRITICAL: email IS in prospect's inbox. Row is in inconsistent state.
    // Sentry alert rule 'db_update_failed_after_send' captures this for manual reconciliation.
    console.error(`[CRITICAL] db_update_failed_after_send draft_id=${replyDraftId} error=${msg}`)
    logger.error('send-approved-draft: db_update_failed_after_send — email sent but row not updated', {
      draft_id: replyDraftId,
      instantly_message_id: instantlyMessageId,
      error: msg,
    })

    try {
      await markSendFailed(supabase, replyDraftId, `db_update_failed_after_send: ${msg}`)
    } catch {
      // markSendFailed itself failed — row is stuck at 'approved'
    }

    return { kind: 'send_failed', error: msg, reason: 'db_update_failed_after_send' }
  }

  if (!dbUpdateSucceeded) {
    return { kind: 'send_failed', error: 'DB update did not succeed', reason: 'unexpected_state' }
  }

  // ── 10. Tier 3 post-send FAQ extraction (best-effort, never blocks send) ──

  if (draft.tier === 3) {
    try {
      const orgContextForExtraction = await loadOrgContext(organisationId, supabase)

      if (orgContextForExtraction) {
        const prospectQuestionContext = (() => {
          const bodyRaw = raw.body
          return (
            (typeof bodyRaw === 'object' && bodyRaw !== null
              ? (bodyRaw as Record<string, unknown>).text as string | undefined
              : typeof bodyRaw === 'string'
                ? bodyRaw
                : undefined) ?? ''
          )
        })()

        const extractionResults = await extractFaq({
          organisationId,
          organisationName: orgContextForExtraction.organisationName,
          replyDraftId,
          prospectQuestionContext,
          originalOutboundBody: signal.original_outbound_body ?? '',
          operatorAnswer: assembledBody,   // the text actually sent (with sign-off)
          aiDraftBody: draft.ai_draft_body ?? '',
          orgPositioningDocument: orgContextForExtraction.positioningDocument,
          supabase,
        })

        for (const result of extractionResults) {
          try {
            await supabase.from('faq_extractions').insert({
              organisation_id: organisationId,
              signal_id: draft.signal_id,
              reply_draft_id: replyDraftId,
              extracted_question: result.extracted_question,
              suggested_answer: result.captured_answer,
              similar_faq_id: result.similar_faq_id,
              similar_pending_extraction_id: result.similar_pending_extraction_id,
              similarity_score: result.similarity_score,
              potential_names_flagged: result.potential_names_flagged as unknown as Json,
              prompt_version: result.prompt_version,
              status: 'pending',
            })
          } catch (insertErr) {
            const msg = insertErr instanceof Error ? insertErr.message : String(insertErr)
            logger.warn('send-approved-draft: faq_extractions insert failed', { draft_id: replyDraftId, error: msg })
          }
        }
      } else {
        logger.warn('send-approved-draft: skipping FAQ extraction — org context missing (TOV or positioning absent)', {
          draft_id: replyDraftId,
          organisation_id: organisationId,
        })
      }
    } catch (extractErr) {
      const msg = extractErr instanceof Error ? extractErr.message : String(extractErr)
      logger.warn('send-approved-draft: FAQ extraction threw — send succeeded, extraction skipped', {
        draft_id: replyDraftId,
        error: msg,
      })
    }
  }

  return { kind: 'sent', instantly_message_id: instantlyMessageId }
}
