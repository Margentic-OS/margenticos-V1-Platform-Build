// Flagging the live strategy documents built from an intake answer that just changed.
//
// ONE IMPLEMENTATION, TWO CALLERS. The buyer-targeting answers live in their own typed table
// and the rest live in intake_responses, so there are two save actions. There is only one
// flagging rule, and it was written out twice: two copies of the same UPDATE, which is the
// parallel-code shape this codebase keeps paying for. They are one function now.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE SERVICE-ROLE CLIENT, AND WHY THAT IS NOT A PRIVILEGE ESCALATION
//
// This runs inside an action a CLIENT triggers, and it writes to strategy_documents, which
// a client may only read. Handing a client-triggered path the service-role key is worth
// being nervous about, so the safety argument is written down rather than assumed:
//
//   organisationId is NEVER taken from the request. Both callers derive it server-side by
//   asking Supabase Auth who the caller is and then reading that user's own row:
//
//     const { data: { user } } = await supabase.auth.getUser()
//     .from('users').select('organisation_id').eq('id', user.id)
//
//   Neither server action accepts an organisation in its arguments, and BuyerProfile has no
//   such field, so there is nothing a caller could put one in. A client cannot name another
//   organisation because they are never asked for one.
//
// The .eq('organisation_id', ...) filter below is therefore the second of the three
// isolation levels, not the only one, and it is applied to a value the caller cannot reach.
// Enforced by cross-organisation tests in __tests__/flag-stale-documents.live.test.ts.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT IS THE SERVICE-ROLE CLIENT AT ALL
//
// Because the session client silently does nothing. strategy_documents has exactly two RLS
// policies: operators get ALL commands, and clients get a SELECT-ONLY policy. An UPDATE run
// as a client therefore matches zero rows. The GRANT is present, so PostgREST does not raise
// `permission denied`, it returns success having changed nothing.
//
// Measured 2026-09-21: across the whole production database, over 72 documents and since the
// mechanism shipped on 2026-09-04, the number of documents this has ever flagged was ZERO.
// Both copies of it had been dead since the day they were written, and the operator was
// never told that any client's answers had moved underneath a live document.
//
// This is the fifth recurrence of session-client-where-service-client-was-needed in this
// codebase; see service-role.ts for the brand that exists because of the other four.
//
// MARKS ONLY. Nothing regenerates and nothing is republished: a live document keeps its
// content and a human decides what to do. Replacing copy the client has already seen with
// something they have not is the failure this must never cause.
//
// IT RETURNS WHAT IT FLAGGED, and that is not decoration. The operator notification sent
// alongside this has to name the documents that are now possibly out of date, and the only
// thing that knows which those are is the code that flagged them. Recomputing the list from
// documentsAffectedBy() at the call site would be a SECOND answer to the same question: it
// would name documents that were already stale, and documents that exist for no such client,
// because it cannot see the read this function does. Two derivations of one fact is the
// parallel-list shape this file's own header was written to end.

import type { StrategyDocType } from '@/lib/agents/cascade/document-dependencies'
import { documentsAffectedBy, intakeStaleReason } from '@/lib/intake/document-staleness'
import { logger } from '@/lib/logger'
import { createServiceRoleClient, type ServiceRoleClient } from '@/lib/supabase/service-role'

/**
 * Flag the live documents fed by each answer that changed.
 *
 * Exported separately from the wrapper below so a test can hand it a client of its choosing.
 * That is what makes the privilege question testable: passing a session client here must
 * fail, and there is a live test that proves it does.
 *
 * @param changedFieldKeys the answers that CHANGED. A first answer must not appear here:
 *                         no document was built without it, so nothing it feeds can have
 *                         been written on a different premise. Both callers decide that
 *                         before calling, because only they can see the previous value.
 *
 * @returns the document types this call actually moved from live to stale, in the order they
 *          were flagged. EMPTY IS THE COMMON CASE and does not mean failure: the document may
 *          already have been stale, or may not exist for this organisation yet. A caller
 *          reporting to a human must say "nothing was newly flagged" rather than treating an
 *          empty list as an error.
 */
export async function flagDocumentsStaleForIntakeEdit(
  service: ServiceRoleClient,
  organisationId: string,
  changedFieldKeys: readonly string[],
): Promise<StrategyDocType[]> {
  // A document already flagged by an earlier field in THIS save must not be counted as a
  // candidate for a later one. Without this, saving two answers that feed the same document
  // makes the second one read as a refusal: the first set is_stale, so the second matches
  // nothing, and the zero-row alarm below would fire on correct behaviour. First cause wins,
  // which is also why the existing reason is left alone.
  const flaggedInThisSave = new Set<string>()

  for (const fieldKey of changedFieldKeys) {
    const affected = documentsAffectedBy(fieldKey).filter(t => !flaggedInThisSave.has(t))
    if (affected.length === 0) continue

    try {
      // Read the candidates BEFORE writing. A zero-row UPDATE has two causes that look
      // identical from the outside: nothing needed flagging, or the write was refused. That
      // ambiguity is the entire reason this went unnoticed, so it is resolved here rather
      // than guessed at: if this read finds rows and the UPDATE changes none, it is a
      // refusal and it is logged as an error.
      const { data: candidates, error: readError } = await service
        .from('strategy_documents')
        .select('id, document_type')
        .eq('organisation_id', organisationId) // explicit isolation filter
        .eq('status', 'active')
        .in('document_type', affected)
        .is('is_stale', false)

      if (readError) {
        logger.error('intake edit: could not read the documents to flag stale', {
          organisation_id: organisationId, fieldKey, affected, error: readError,
          consequence: 'The answer is saved. The documents built from it are NOT flagged, ' +
            'so the operator will not be told they may be out of date.',
        })
        continue
      }

      // Nothing to flag. Not a fault: the document may already be stale from an earlier
      // edit, or may not exist yet. Deliberately silent, so the alarm below stays meaningful.
      if (!candidates || candidates.length === 0) continue

      const { error, count } = await service
        .from('strategy_documents')
        .update(
          { is_stale: true, stale_reason: intakeStaleReason(fieldKey) },
          { count: 'exact' },
        )
        .eq('organisation_id', organisationId) // explicit isolation filter
        .eq('status', 'active')
        .in('document_type', affected)
        .is('is_stale', false)

      if (error) {
        logger.error('intake edit: could not flag documents stale', {
          organisation_id: organisationId, fieldKey, affected, error,
          consequence: 'The answer is saved. The documents built from it are NOT flagged, ' +
            'so the operator will not be told they may be out of date.',
        })
        continue
      }

      if ((count ?? 0) === 0) {
        // THE ALARM THAT WAS MISSING. The read above found documents to flag and the write
        // changed none of them, which is what a silently refused write looks like. It is the
        // one line that would have caught the original fault on the day it shipped.
        logger.error('intake edit: expected to flag documents stale and changed nothing', {
          organisation_id: organisationId, fieldKey, affected,
          expected: candidates.length,
          consequence: 'The write was accepted and changed no rows. The usual cause is a ' +
            'client without UPDATE on strategy_documents, which RLS refuses silently.',
        })
        continue
      }

      for (const row of candidates) flaggedInThisSave.add(row.document_type)

      logger.info('intake edit: flagged documents stale', {
        organisation_id: organisationId, fieldKey, affected,
        expected: candidates.length, flagged: count,
      })
    } catch (err) {
      logger.error('intake edit: threw while flagging documents stale', {
        organisation_id: organisationId, fieldKey, error: String(err),
      })
    }
  }

  // The set is already exactly "what this call flagged": every branch above that did NOT
  // flag something continues without adding to it, including the two error paths and the
  // zero-row alarm. So a document that failed to flag is never reported as flagged.
  return [...flaggedInThisSave] as StrategyDocType[]
}

/**
 * The same thing, building its own service-role client. What the server actions call.
 *
 * NEVER THROWS. The client's answer is already saved by the time this runs, and losing a
 * flag is a smaller harm than failing a save that succeeded.
 *
 * It builds the client rather than accepting one so that no call site can hand it a session
 * client by mistake. That is belt and braces over the ServiceRoleClient brand, which already
 * makes doing so a compile error.
 *
 * @returns what was flagged, or an empty list when nothing was. A caller cannot tell a
 *          "nothing needed flagging" from a "the service-role client could not be built"
 *          from the return value alone, and deliberately so: both mean the notification
 *          must not claim a document was flagged. The difference is in the log.
 */
export async function flagDocumentsStaleForIntakeEditSafely(
  organisationId: string,
  changedFieldKeys: readonly string[],
): Promise<StrategyDocType[]> {
  if (changedFieldKeys.length === 0) return []

  try {
    const service = await createServiceRoleClient()
    return await flagDocumentsStaleForIntakeEdit(service, organisationId, changedFieldKeys)
  } catch (err) {
    // createServiceRoleClient throws when SUPABASE_SERVICE_ROLE_KEY is absent. Per-field
    // failures are already caught inside, so reaching here means no field was attempted.
    logger.error('intake edit: could not flag documents stale at all', {
      organisation_id: organisationId, changedFieldKeys, error: String(err),
      consequence: 'The answers are saved and NO document was flagged.',
    })
    return []
  }
}
