import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

// ════════════════════════════════════════════════════════════════════════════
// THIS IS NOT A GATE. IT RECORDS THAT THERE ISN'T ONE.
//
// It was `validateIcpFilterSpec` and it returned `{ valid: true }` unconditionally. Renamed
// 2026-09-08 because a function called `validate...` that always returns valid reads on the
// call site as protection and is not, which is the CLAUDE.md monitor-that-is-silent shape:
// a check that exists and never fires looks exactly like a check that keeps passing.
//
// The name, the void return and the absence of a verdict type are all deliberate. There is
// nothing for a caller to branch on, so no caller can accidentally treat this as a decision.
//
// ─── Why the gate it replaced cannot exist ──────────────────────────────────
//
// It was built to block approval of an ICP with no filter spec, because sourcing downstream
// fails without one. That risk is real. THE CHECK IS IMPOSSIBLE, because of ordering.
//
// `persistIcpFilterSpec` runs AFTER `promote_strategy_doc_version` (approve route, inside
// after(); auto-approve cron; revise route; revert route). It reads the PROMOTED document,
// derives the spec, and writes it to `strategy_documents.icp_filter_spec`, a COLUMN. The spec
// is created BY approval. At the moment a pre-approval gate runs it does not exist and cannot.
//
// MEASURED ON PRODUCTION 2026-09-08:
//
//   0 of 25  ICP suggestions carry a spec in `suggested_value`
//   0 of 24  ICP documents carry one inside `content`
//   10 of 24 have the COLUMN populated, all written post-promotion
//   14 have none at all, and 2 of those are ACTIVE
//
// ─── The two ways this hid ──────────────────────────────────────────────────
//
// The original selected `id, document_type, content` from `document_suggestions`. There is no
// `content` column, so every call errored 42703 and returned valid from its fail-open branch.
// That accidental fail-open was the only reason ICP approval ever worked.
//
// The rewrite fixed both dead queries and read the spec from `suggested_value`, where the old
// comment said it lived. Twelve tests passed, including a fake that throws on columns the real
// table does not have. THE FIXTURES WERE STILL WRONG, one level further in: they put the spec
// inside `suggested_value` because that is what the code expected. A fake that rejects an
// unknown COLUMN cannot reject an unknown SHAPE inside a column it accepts. Running the real
// function over all 25 real suggestions returned 25 refusals and 0 allowances, which is a
// total outage, and no test could have said that 25 was the wrong number.
//
// ─── What replaces it, and where that is tracked ────────────────────────────
//
// A post-promotion flag, decided 2026-09-08: `persistIcpFilterSpec` already knows when
// derivation fails and currently only logs. It should mark the document so an operator sees
// that a live ICP cannot produce prospects. That covers revise and revert as well as approve,
// which a pre-approval gate never did. NOT BUILT HERE. See the Backlog rows for the flag and
// for the 14 documents that already have no spec.

/**
 * Records that an ICP approval passed through without a filter-spec check.
 *
 * Returns nothing. There is no verdict, and callers must not branch on this.
 *
 * The read exists only so the log line can name the organisation. It uses real columns, so
 * unlike its predecessor it does not error 42703 on every call. If it fails, nothing happens:
 * a log line is not worth failing an operator's approval over.
 */
export async function logUngatedIcpApproval(
  supabase: SupabaseClient,
  suggestionId: string,
): Promise<void> {
  const { data: suggestion, error } = await supabase
    .from('document_suggestions')
    .select('id, document_type, organisation_id')
    .eq('id', suggestionId)
    .single()

  if (error || !suggestion) return
  if (suggestion.document_type !== 'icp') return

  logger.info(
    'ICP approved without a filter-spec check: the spec is derived AFTER promotion by ' +
    'persistIcpFilterSpec, so it cannot exist at approval time. If sourcing later has ' +
    'nothing to search on, that is where to look.',
    { suggestion_id: suggestionId, organisation_id: suggestion.organisation_id },
  )
}
