import type { ServiceRoleClient } from '@/lib/supabase/service-role'
// src/lib/reply-handling/draft-orchestrator.ts
//
// Deterministic orchestrator for Tier 2 / Tier 3 reply drafting (ADR-018, ADR-019).
// Called from process-reply.ts for signals that are not Tier 1 auto-actioned.
//
// Does NOT handle Tier 1 signals — throws if a Tier 1 intent reaches it.
// Writes placeholder rows (manual_required, draft_failed) to reply_drafts for triage.
// The caller owns the action row update and markSignalProcessed calls.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import { logger } from '@/lib/logger'
import { findFaqMatches } from '@/lib/faq/matcher'
import { routeIntent } from './route-intent'
import { loadOrgContext } from './load-org-context'
import { draftReply, type FaqMatch as DrafterFaqMatch } from '@/lib/agents/reply-draft-agent'

type SupabaseServiceClient = ServiceRoleClient

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OrchestratorInput {
  signal: {
    id: string
    organisation_id: string
    campaign_id: string | null
    raw_data: Json
    original_outbound_body: string | null
  }
  classification: {
    intent: string
    confidence: number
    reasoning: string
  }
  prospectId: string | null
  supabase: SupabaseServiceClient
  // False when the organisation has no booking link, so process-reply could not send its
  // automatic booking reply and handed the reply here for an operator to answer instead.
  // Only an explicit false changes routing. Absent behaves exactly as before.
  bookingLinkSet?: boolean
}

export type OrchestratorResult =
  | { kind: 'drafted'; reply_draft_id: string; tier: 2 | 3 }
  | { kind: 'manual_required'; reply_draft_id: string; reason: string; tier: 2 | 3 }
  | { kind: 'draft_failed'; reply_draft_id: string; failure_count: number; tier: 2 | 3 }
  // log_only carries a draft id because it now writes a backstop row. See the branch below.
  | { kind: 'log_only'; reply_draft_id: string }

// Trigger draft_failed placeholder when this many agent_runs failures in 24 hours.
const DRAFT_FAILURE_CIRCUIT_BREAKER = 3

// ── Helpers ───────────────────────────────────────────────────────────────────

// Extracts plain-text body from Instantly's raw_data shape.
// Mirrors the extraction in process-reply.ts — must remain in sync.
function extractEmailBody(rawData: Json): string {
  const raw = rawData as Record<string, unknown>
  const bodyRaw = raw.body
  return (
    (typeof bodyRaw === 'object' && bodyRaw !== null
      ? (bodyRaw as Record<string, unknown>).text as string | undefined
      : typeof bodyRaw === 'string'
        ? bodyRaw
        : undefined) ?? ''
  )
}

async function insertDraftRow(
  supabase: SupabaseServiceClient,
  row: {
    organisation_id: string
    signal_id: string
    prospect_id: string | null
    intent: string
    tier: number
    status: string
    ai_draft_body: string | null
    draft_metadata: Json
  },
): Promise<string | null> {
  const { data, error } = await supabase
    .from('reply_drafts')
    .insert({
      organisation_id: row.organisation_id,
      signal_id: row.signal_id,
      prospect_id: row.prospect_id,
      intent: row.intent,
      tier: row.tier,
      status: row.status,
      ai_draft_body: row.ai_draft_body,
      draft_metadata: row.draft_metadata,
    })
    .select('id')
    .single()

  if (error) {
    logger.error('draft-orchestrator: failed to insert reply_drafts row', {
      signal_id: row.signal_id,
      status: row.status,
      error: error.message,
    })
    return null
  }

  return data.id
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function orchestrateDraft(input: OrchestratorInput): Promise<OrchestratorResult> {
  const { signal, classification, prospectId, supabase } = input
  const { intent, confidence, reasoning } = classification
  const emailBody = extractEmailBody(signal.raw_data)

  // ── 1. FAQ matching — errors propagate (no try/catch per ADR-018 addendum 3) ─
  const faqMatchResults = await findFaqMatches({
    organisationId: signal.organisation_id,
    questionText: emailBody,
    supabase,
    limit: 3,
    includePendingExtractions: false,
  })

  const faqMatchTopScore =
    faqMatchResults.length > 0 ? Math.max(...faqMatchResults.map((m) => m.score)) : null

  // ── 2. Route intent ───────────────────────────────────────────────────────
  const routed = routeIntent({ intent, confidence, faqMatchTopScore })

  // A high-confidence booking reply is Tier 1 only because process-reply answers it
  // automatically, and it can do that only with a booking link. Without one it arrives
  // here and is drafted for the operator as Tier 2, rather than thrown back as a caller
  // error. The throw below still fires for every other Tier 1 arrival.
  const routing =
    routed === 'tier_1_handled' && intent === 'positive_direct_booking' && input.bookingLinkSet === false
      ? 'tier_2'
      : routed

  // ── 3. Guard: Tier 1 throws; log_only returns immediately ─────────────────
  if (routing === 'tier_1_handled') {
    throw new Error(
      `orchestrateDraft called with a Tier 1 intent (${intent}) — caller error`,
    )
  }

  // ── log_only is the unroutable case, and it used to leave NOTHING for anyone to find ──
  //
  // routeIntent returns 'log_only' only for an intent it does not know. Reaching here means
  // the classifier produced a label the router has no rule for, which is precisely a reply
  // nobody has decided what to do with: a person has to look.
  //
  // What used to happen: an action row with action_taken 'log_only' and action_succeeded
  // TRUE, the signal marked processed, and no reply_drafts row. MON-028 watches reply_drafts,
  // so the reply was invisible to the only monitor that reports a reply waiting on a person.
  // MON-014 cannot see it either, because the signal IS processed, and MON-015 cannot,
  // because nothing failed. The operator notification does fire for this intent, but it fires
  // exactly once and the signal is then closed, so if that email is lost the reply is gone
  // with no second surface. That is the 'no backstop at all' case.
  //
  // A manual_required row fixes it with no new mechanism: MON-028 already counts
  // manual_required, the triage queue already renders it, and the ageing threshold already
  // applies. Tier 3 because that is this codebase's existing meaning of "a human writes it";
  // the CHECK constraint permits only 2 or 3, and manual_required requires a null body.
  //
  // THIS DOES NOT CHANGE WHICH INTENTS NEED A PERSON. opt_out and out_of_office never arrive
  // here at all: they route to tier_1_handled and the guard above throws on them. The set of
  // intents that produce a card is unchanged; what changes is that an intent which produced
  // NO card and NO monitor visibility now produces both.
  if (routing === 'log_only') {
    const draftId = await insertDraftRow(supabase, {
      organisation_id: signal.organisation_id,
      signal_id: signal.id,
      prospect_id: prospectId,
      intent,
      tier: 3,
      status: 'manual_required',
      draft_metadata: { reason: 'unroutable_intent', intent, confidence } as Json,
      ai_draft_body: null,
    })

    if (!draftId) {
      // Loud, and it throws. A failed insert here means the reply is back to being invisible,
      // and the caller's catch leaves the signal unprocessed so the next cron run retries
      // rather than closing it silently.
      throw new Error('log_only backstop row insert failed')
    }

    logger.warn('draft-orchestrator: unroutable intent — wrote a manual_required backstop row', {
      signal_id: signal.id,
      organisation_id: signal.organisation_id,
      intent,
      reply_draft_id: draftId,
      fix: 'routeIntent has no rule for this intent. Add one, or remove it from the classifier.',
    })

    return { kind: 'log_only', reply_draft_id: draftId }
  }

  const tier: 2 | 3 = routing === 'tier_2' ? 2 : 3

  // ── 4. Idempotency: existing reply_drafts row for this signal ─────────────
  const { data: existingDraft, error: idempotencyError } = await supabase
    .from('reply_drafts')
    .select('id, tier, status')
    .eq('signal_id', signal.id)
    .eq('organisation_id', signal.organisation_id)
    .maybeSingle()

  if (idempotencyError) {
    throw new Error(`reply_drafts idempotency check failed: ${idempotencyError.message}`)
  }

  if (existingDraft) {
    if (existingDraft.status === 'manual_required') {
      return {
        kind: 'manual_required',
        reply_draft_id: existingDraft.id,
        reason: 'idempotent_replay',
        tier: existingDraft.tier as 2 | 3,
      }
    }
    if (existingDraft.status === 'draft_failed') {
      return {
        kind: 'draft_failed',
        reply_draft_id: existingDraft.id,
        failure_count: 0,
        tier: existingDraft.tier as 2 | 3,
      }
    }
    return {
      kind: 'drafted',
      reply_draft_id: existingDraft.id,
      tier: existingDraft.tier as 2 | 3,
    }
  }

  // ── 5. Failure circuit breaker ────────────────────────────────────────────
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: recentFailures } = await (supabase as any)
    .from('agent_runs')
    .select('id')
    .eq('organisation_id', signal.organisation_id)
    .eq('agent_name', 'reply-draft-agent')
    .eq('status', 'failed')
    .gte('started_at', since24h)

  const recentFailureCount = Array.isArray(recentFailures) ? recentFailures.length : 0

  if (recentFailureCount >= DRAFT_FAILURE_CIRCUIT_BREAKER) {
    const draftId = await insertDraftRow(supabase, {
      organisation_id: signal.organisation_id,
      signal_id: signal.id,
      prospect_id: prospectId,
      intent,
      tier,
      status: 'draft_failed',
      ai_draft_body: null,
      draft_metadata: { failure_count: recentFailureCount } as Json,
    })
    if (!draftId) throw new Error('draft_failed row insert failed')
    return { kind: 'draft_failed', reply_draft_id: draftId, failure_count: recentFailureCount, tier }
  }

  // ── 6. Load org context ───────────────────────────────────────────────────
  const orgContext = await loadOrgContext(signal.organisation_id, supabase)

  if (!orgContext) {
    logger.warn('draft-orchestrator: org context missing — writing manual_required placeholder', {
      signal_id: signal.id,
      organisation_id: signal.organisation_id,
    })
    const draftId = await insertDraftRow(supabase, {
      organisation_id: signal.organisation_id,
      signal_id: signal.id,
      prospect_id: prospectId,
      intent,
      tier,
      status: 'manual_required',
      ai_draft_body: null,
      draft_metadata: { reason: 'org_context_missing' } as Json,
    })
    if (!draftId) throw new Error('manual_required (org_context) row insert failed')
    return { kind: 'manual_required', reply_draft_id: draftId, reason: 'org_context_missing', tier }
  }

  // ── 7. Outbound body check ────────────────────────────────────────────────
  const originalOutboundBody = signal.original_outbound_body?.trim() ?? ''

  if (!originalOutboundBody) {
    logger.warn(
      'draft-orchestrator: original_outbound_body missing — writing manual_required placeholder',
      { signal_id: signal.id, organisation_id: signal.organisation_id },
    )
    const draftId = await insertDraftRow(supabase, {
      organisation_id: signal.organisation_id,
      signal_id: signal.id,
      prospect_id: prospectId,
      intent,
      tier,
      status: 'manual_required',
      ai_draft_body: null,
      draft_metadata: { reason: 'original_outbound_not_captured' } as Json,
    })
    if (!draftId) throw new Error('manual_required (no_outbound_body) row insert failed')
    return {
      kind: 'manual_required',
      reply_draft_id: draftId,
      reason: 'original_outbound_not_captured',
      tier,
    }
  }

  // ── 8. Booking hint ───────────────────────────────────────────────────────
  const includeBookingHint = intent !== 'unclear'

  // ── 9. Map FAQ matches to drafter format ──────────────────────────────────
  // Drafter uses only approved FAQs (non-null faq_id).
  // Pending extraction matches serve the extraction agent, not the drafter.
  const drafterFaqMatches: DrafterFaqMatch[] = faqMatchResults
    .filter((m) => m.source === 'approved_faq' && m.faq_id !== null)
    .map((m) => ({
      faq_id: m.faq_id!,
      question_canonical: m.question_canonical,
      answer: m.answer,
      score: m.score,
    }))

  // ── 10. Call drafter ──────────────────────────────────────────────────────
  const draftResult = await draftReply({
    organisationId: signal.organisation_id,
    organisationName: orgContext.organisationName,
    senderFirstName: orgContext.senderFirstName,
    prospectReplyBody: emailBody,
    originalOutboundBody,
    classification: { intent, confidence, reasoning },
    tierHint: tier,
    orgContext: {
      tovDocument: orgContext.tovDocument,
      positioningDocument: orgContext.positioningDocument,
    },
    faqMatches: drafterFaqMatches,
    includeBookingHint,
    signalId: signal.id,
    prospectId,
    supabase,
  })

  // ── 11. Drafter returned null — leave signal unprocessed for retry ───────────
  if (!draftResult) {
    // Throw rather than return log_only — caller's catch leaves signal unprocessed; retries until circuit breaker above writes draft_failed for triage.
    logger.warn('draft-orchestrator: drafter returned null — signal left unprocessed for retry', {
      signal_id: signal.id,
      prospect_id: prospectId,
      organisation_id: signal.organisation_id,
    })
    throw new Error('draftReply returned null — transient failure, signal retryable')
  }

  // ── 12. Write reply_drafts pending row ────────────────────────────────────
  const draftMetadata: Json =
    draftResult.tier === 2
      ? ({
          faq_ids_used: draftResult.faq_ids_used,
          confidence_at_draft: draftResult.confidence_at_draft,
          prompt_version: draftResult.prompt_version,
        } as Json)
      : ({
          ambiguity_note: draftResult.ambiguity_note,
          alternative_directions: draftResult.alternative_directions,
          faq_ids_used: draftResult.faq_ids_used,
          downgraded_from_tier: draftResult.downgraded_from_tier,
          prompt_version: draftResult.prompt_version,
        } as Json)

  const draftId = await insertDraftRow(supabase, {
    organisation_id: signal.organisation_id,
    signal_id: signal.id,
    prospect_id: prospectId,
    intent,
    tier: draftResult.tier,
    status: 'pending',
    ai_draft_body: draftResult.draft_body,
    draft_metadata: draftMetadata,
  })

  if (!draftId) throw new Error('reply_drafts pending row insert failed')

  return { kind: 'drafted', reply_draft_id: draftId, tier: draftResult.tier }
}
