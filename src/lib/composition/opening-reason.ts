// A personalised Email 1 is sent only if it was held to one of the client's approved
// trigger reasons, as they read today.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE RULE (operator note 5 on the second reading, 2026-10-01; ADR-065)
//
// A personalised opening says what an event means for the reader, and what it means is the
// reason the client approved for that kind of event. Research holds every opening it
// writes to that sentence, and records which sentence on the prospect
// (prospects.trigger_data.judge.approved_reason).
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A CHECK AT UPLOAD
//
// An Email 1 is a frozen verdict: it is written once and nothing re-reads it when a rule
// changes (ADR-034). So a rule held only where openings are WRITTEN reaches no opening
// already on file, and those are exactly the ones waiting to be uploaded on the day the
// rule arrives.
//
// The first attempt put the check in the follow-up backfill, on the argument that every
// held prospect passes through it. A review found the hole: a prospect that already holds
// a follow-up written against today's Email 1 is skipped by the backfill before any check,
// satisfies the upload's thread rule, and ships. A rule about what may be SENT belongs
// where sending is decided.
//
// So this is a verdict the upload reads, beside the thread rule. Pure and free: it compares
// what is recorded on the prospect with the client's trigger list. It makes no model call
// and reads no copy. The backfill reads the same verdict first, so it never pays to write
// follow-ups for an opening the upload would hold anyway.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT A HOLD MEANS HERE
//
// The opening was written before the rule, or for a reason the client has since reworded
// or removed, or at a time when the client had no approved reasons at all. None of those
// is fixed by a backfill. The prospect's research is run again, which writes a new Email 1
// under the rule and its follow-ups with it.
//
// A client with NO approved reason on any trigger cannot be held to one, and is not: the
// rule is not applied to that client, exactly as research does not apply it.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { TriggerWithReason } from '@/lib/agents/research/approved-reason'

/** The reason code recorded on a prospect held by this rule. */
export const OPENING_WITHOUT_APPROVED_REASON = 'opening_without_approved_reason'

export type OpeningReasonVerdict =
  | { ok: true; why: 'not_personalised' | 'client_has_no_approved_reasons' }
  | { ok: true; why: 'held_to_a_current_reason'; reason: string }
  | { ok: false; why: 'written_before_the_rule' | 'reason_since_changed' | 'not_held_to_a_reason' }

const clean = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

/**
 * `judge` is prospects.trigger_data.judge: the record of the writer run that produced the
 * stored Email 1. `triggers` is the client's trigger list as it reads today.
 */
export function openingReasonVerdict(input: {
  tier: 'research' | 'firm_fact' | 'template'
  judge: unknown
  triggers: ReadonlyArray<TriggerWithReason>
}): OpeningReasonVerdict {
  if (input.tier !== 'research') return { ok: true, why: 'not_personalised' }
  const current = input.triggers.map(t => clean(t.reason)).filter(Boolean)
  if (current.length === 0) return { ok: true, why: 'client_has_no_approved_reasons' }

  const recorded = (input.judge && typeof input.judge === 'object'
    ? (input.judge as { approved_reason?: unknown }).approved_reason
    : undefined) as { state?: unknown; reason?: unknown } | undefined
  if (!recorded || typeof recorded !== 'object') return { ok: false, why: 'written_before_the_rule' }
  if (recorded.state !== 'approved') return { ok: false, why: 'not_held_to_a_reason' }
  const reason = clean(recorded.reason)
  if (!reason || !current.includes(reason)) return { ok: false, why: 'reason_since_changed' }
  return { ok: true, why: 'held_to_a_current_reason', reason }
}

const HOLD_WORDING: Record<Extract<OpeningReasonVerdict, { ok: false }>['why'], string> = {
  written_before_the_rule: 'it was written before openings were held to an approved trigger reason',
  reason_since_changed: 'the approved reason it was held to has since been reworded or removed',
  not_held_to_a_reason: 'it was written when this client had no approved trigger reason to hold it to',
}

/** One sentence for the prospect's row and the operator. */
export function describeReasonHold(verdict: Extract<OpeningReasonVerdict, { ok: false }>): string {
  return (
    `${OPENING_WITHOUT_APPROVED_REASON}: Email 1 is personalised and ${HOLD_WORDING[verdict.why]}. ` +
    'Not sent. The follow-up backfill cannot fix this: run this prospect\'s research again, ' +
    'which writes a new Email 1 and its follow-ups together.'
  )
}

/**
 * The client's triggers and their approved reasons, from the active ICP for a segment.
 *
 * A CHECKED read, on purpose. The research path's loader treats a failed documents read as
 * "no documents", which for this rule would mean "this client has no approved reasons",
 * which switches the rule off. A gate must not read its own failure as permission, so a
 * failed read is returned as a failure and the caller stops.
 *
 * The same row choice the research loader makes: the ICP for the segment, else any active
 * ICP; a prospect with no segment uses the default segment's.
 */
export async function loadTriggersChecked(
  supabase: SupabaseClient,
  organisationId: string,
  segmentId: string | null,
): Promise<{ ok: true; triggers: TriggerWithReason[] } | { ok: false; error: string }> {
  let resolved = segmentId
  if (!resolved) {
    const { data, error } = await supabase
      .from('segments')
      .select('id')
      .eq('organisation_id', organisationId)
      .eq('is_default', true)
      .maybeSingle()
    if (error) return { ok: false, error: `could not read the default segment: ${error.message}` }
    resolved = (data?.id as string | undefined) ?? null
  }
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('content, segment_id')
    .eq('organisation_id', organisationId)
    .eq('status', 'active')
    .eq('document_type', 'icp')
    .order('created_at', { ascending: false })
  if (error) return { ok: false, error: `could not read the client's ICP: ${error.message}` }
  const rows = (data ?? []) as Array<{ content: unknown; segment_id: string | null }>
  const row = rows.find(r => r.segment_id === resolved) ?? rows[0]
  const tier1 = ((row?.content ?? {}) as { tier_1?: { triggers?: unknown } }).tier_1
  const raw = Array.isArray(tier1?.triggers) ? tier1.triggers : []
  const triggers = raw
    .map(t => typeof t === 'string'
      ? { trigger: t, reason: '' }
      : { trigger: clean((t as { trigger?: unknown } | null)?.trigger), reason: clean((t as { reason?: unknown } | null)?.reason) })
    .filter(t => t.trigger.trim().length > 0)
  return { ok: true, triggers }
}
