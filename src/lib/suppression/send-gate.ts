// src/lib/suppression/send-gate.ts
//
// The one chokepoint that decides whether a prospect may be sent to.
//
// TWO INDEPENDENT GATES, ONE FUNCTION.
//
// Gate 1 — prospects.suppressed / client_review_status (per organisation).
//   Pre-existing and unchanged. It already carries four distinct meanings that have
//   nothing to do with email deliverability:
//     client_rejected     the client rejected this prospect in the dashboard
//     research agent      the research agent auto-disqualified them
//     explicit_opt_out    they replied asking to be removed
//     dedupe              sourcing blocked them against a suppressed row
//   It is NOT derived from gate 2, and gate 2 is not derived from it. Deriving either
//   from the other would destroy four working behaviours to save one query.
//
// Gate 2 — suppressed_emails (global).
//   New. Bounced and unsubscribed addresses observed in ANY client's campaign.
//   See ./suppression-list.ts for why global and how to narrow it later.
//
// Two sources of truth for one decision is the failure class this build has produced
// four times. So both gates are checked HERE and only here. No call site checks one
// without the other, and no call site re-implements either.
//
// Fails closed. If either query errors, this returns ok:false and the caller must
// abort the send. An unknown suppression list is never treated as an empty one.
//
// SCOPE: this governs FUTURE uploads only. It does not stop an in-flight sequence.
// The can_send_email provider halts a bounced lead on its own side, which is where the
// bounce was observed in the first place.

import { SupabaseClient } from '@supabase/supabase-js'
import { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import { lookupSuppressedEmails, normaliseEmail } from './suppression-list'

type SupabaseServiceClient = SupabaseClient<Database>

export interface GateCandidate {
  id: string
  email: string | null
}

// Why a prospect was blocked. Distinguished because the two gates mean different
// things operationally: prospect_suppressed and client_rejected are that client's
// decision, globally_suppressed is a dead or opted-out mailbox.
export type BlockReason = 'prospect_suppressed' | 'client_rejected' | 'globally_suppressed'

export type SendGateResult =
  | { ok: true; blocked: Map<string, BlockReason> }
  | { ok: false; error: string }

/**
 * Given prospects already selected for send, return the ones that must not be sent to.
 *
 * @param orgId  the sending organisation. Scopes gate 1. Gate 2 is global by policy,
 *               and that policy lives in lookupSuppressedEmails, not here.
 */
export async function findBlockedProspects(
  supabase: SupabaseServiceClient,
  orgId: string,
  candidates: readonly GateCandidate[]
): Promise<SendGateResult> {
  const blocked = new Map<string, BlockReason>()

  if (candidates.length === 0) return { ok: true, blocked }

  // ── Gate 1: per-organisation suppression and client rejection ───────────────
  const { data: suppressedRows, error: gateOneError } = await supabase
    .from('prospects')
    .select('id, suppressed, client_review_status')
    .eq('organisation_id', orgId)
    .in('id', candidates.map(c => c.id))
    .or('suppressed.eq.true,client_review_status.eq.rejected')

  if (gateOneError) {
    logger.error('send gate: per-organisation suppression check failed', {
      organisation_id: orgId,
      candidate_count: candidates.length,
      error: gateOneError.message,
    })
    return { ok: false, error: `prospect suppression check failed: ${gateOneError.message}` }
  }

  for (const row of suppressedRows ?? []) {
    // suppressed wins the label when both are true: it is the broader statement.
    blocked.set(row.id, row.suppressed ? 'prospect_suppressed' : 'client_rejected')
  }

  // ── Gate 2: global bounce / unsubscribe list ────────────────────────────────
  const emails = candidates
    .map(c => c.email)
    .filter((e): e is string => e !== null && e.trim().length > 0)

  const lookup = await lookupSuppressedEmails(supabase, emails)

  if (!lookup.ok) {
    logger.error('send gate: global suppression check failed', {
      organisation_id: orgId,
      candidate_count: candidates.length,
      error: lookup.error,
    })
    return { ok: false, error: `global suppression check failed: ${lookup.error}` }
  }

  for (const candidate of candidates) {
    if (!candidate.email) continue
    if (blocked.has(candidate.id)) continue // already blocked by gate 1; keep that reason
    if (lookup.suppressed.has(normaliseEmail(candidate.email))) {
      blocked.set(candidate.id, 'globally_suppressed')
    }
  }

  if (blocked.size > 0) {
    logger.info('send gate: prospects blocked', {
      organisation_id: orgId,
      candidate_count: candidates.length,
      blocked_count: blocked.size,
      globally_suppressed: Array.from(blocked.values()).filter(r => r === 'globally_suppressed').length,
    })
  }

  return { ok: true, blocked }
}
