import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

// ════════════════════════════════════════════════════════════════════════════
// THIS GATE CANNOT DO WHAT IT WAS BUILT TO DO, AND THE REASON IS ORDERING.
//
// It was written to block approval of an ICP that has no filter spec, because
// "sourcing downstream will fail" without one. That is a real risk. The check is still
// impossible, and measuring production is what showed it.
//
// THE FILTER SPEC IS CREATED BY APPROVAL. `persistIcpFilterSpec` runs AFTER
// `promote_strategy_doc_version` (approve route, inside after(); auto-approve cron; revise
// route; revert route). It reads the PROMOTED document, derives the spec, and writes it to
// `strategy_documents.icp_filter_spec`, a COLUMN. So at the moment this gate runs, the spec
// does not exist and cannot exist. Refusing on its absence would refuse every ICP, always.
//
// MEASURED ON PRODUCTION 2026-09-08, and each of these is why the belief was wrong:
//
//   0 of 24  ICP documents carry `icp_filter_spec` anywhere inside `content`
//   0 of 25  ICP suggestions carry it inside `suggested_value`
//   10 of 24 ICP documents have the COLUMN populated, all written post-promotion
//
// ════════════════════════════════════════════════════════════════════════════
// HOW THE ORIGINAL VERSION HID THIS FOR MONTHS, AND HOW THE REWRITE ALMOST SHIPPED IT
//
// The original selected `id, document_type, content` from `document_suggestions`. There is
// no `content` column, so every call errored 42703 and returned `{ valid: true }` from its
// fail-open branch. The gate never ran. Its fail-open was, entirely by accident, the only
// behaviour under which ICP approval worked at all.
//
// The rewrite fixed both dead queries and read the spec from `suggested_value`, where the
// comment said it lived. Its twelve tests passed, including a fake that throws on columns
// the real table does not have. THE FIXTURES WERE STILL WRONG: they put `icp_filter_spec`
// inside `suggested_value` because that is what the code expected, which is the same mistake
// the old fixtures made with `content`, one level further in. A fake that rejects unknown
// COLUMNS still cannot reject an unknown SHAPE inside a column it accepts.
//
// It was caught by running the real function against the 25 real production suggestions and
// getting 25 refusals and 0 allowances. A test suite cannot tell you that a number should
// not be 25. Only production can.
//
// ════════════════════════════════════════════════════════════════════════════
// WHAT THIS FUNCTION DOES NOW, AND WHY IT IS DELIBERATELY NOT A GATE
//
// It allows every approval, and it says so out loud. It is retained rather than deleted
// only because deleting it is an architectural decision that belongs to the operator, and
// the two call sites read better with an explicit "nothing is gated here, and here is why"
// than with a silent removal.
//
// IT MUST NOT BE LEFT LIKE THIS INDEFINITELY. A function named `validate...` that always
// returns valid is the shape CLAUDE.md records for the monitor that exists and is silent: it
// reads on the call site as protection and is not. Either it grows into a real preflight
// over what derivation NEEDS (which is knowable before promotion, unlike the spec itself), or
// the post-promotion path learns to flag a document whose derivation failed, or this file and
// both call sites go. See the Backlog row.
//
// The 14 ICP documents with no spec column are the evidence that the underlying risk is real
// and currently uncontrolled: 2 of them are ACTIVE. Nothing warned anyone.

/** Always `{ valid: true }` today. Kept as a discriminated union so a real gate can return a reason later. */
export type IcpSpecValidation =
  | { valid: true }
  | { valid: false; reason: 'still_generating' | 'needs_regeneration' }

export async function validateIcpFilterSpec(
  supabase: SupabaseClient,
  suggestionId: string,
): Promise<IcpSpecValidation> {
  // The read is kept, and it uses REAL columns, so it no longer errors 42703 on every call.
  // Its only purpose is the log line below: it records, per approval, that nothing was
  // gated, so the absence of a gate is visible in the logs rather than inferred from code.
  const { data: suggestion, error } = await supabase
    .from('document_suggestions')
    .select('id, document_type, organisation_id')
    .eq('id', suggestionId)
    .single()

  if (error || !suggestion) return { valid: true }
  if (suggestion.document_type !== 'icp') return { valid: true }

  logger.info(
    'ICP approval was not gated on a filter spec: the spec is derived AFTER promotion by ' +
    'persistIcpFilterSpec, so it cannot exist at approval time. If sourcing later has ' +
    'nothing to search on, that is where to look.',
    { suggestion_id: suggestionId, organisation_id: suggestion.organisation_id },
  )

  return { valid: true }
}
