import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { ICP_AGENT_NAME } from '@/agents/icp-generation-agent'

// ─── Why this file was rewritten, 2026-09-08 ─────────────────────────────────
//
// It had TWO dead queries and has never once evaluated an ICP.
//
// QUERY ONE selected `id, document_type, content` from `document_suggestions`. There is no
// `content` column; the value lives in `suggested_value`. Verified live:
//
//     ERROR: 42703: column "content" does not exist
//
// So `fetchError` was always set, and the guard returned `{ valid: true }` from its
// fail-open branch on every call since it was written.
//
// QUERY TWO selected `id, created_at, status` from `agent_runs` filtered on `suggestion_id`
// and `document_type`. That table has none of those four columns: it is
// `id, organisation_id, agent_name, status, started_at, completed_at, duration_ms,
// output_summary, error_message`. Also verified live. It was unreachable only because query
// one returned first, so fixing query one alone would have surfaced a second failure
// immediately. Both had to go together or the gate would stay broken in a new way.
//
// WHAT IT WAS FOR. From the approve route: "ICPs must have a valid filter spec before they
// can be approved, otherwise sourcing downstream will fail." It also distinguished two
// operator-facing states, and neither message has ever been shown to anyone.
//
// ─── What changed in the logic, and why ──────────────────────────────────────
//
// THE SPEC IS READ FROM THE SUGGESTION'S suggested_value, which is where it actually is.
// `icp_filter_spec` is a top-level key of the generated ICP content. `persistIcpFilterSpec`
// later writes it to the `strategy_documents.icp_filter_spec` column, but that happens AFTER
// promotion, so at approval time the suggestion body is the only place it exists.
//
// THE "STILL GENERATING" CHECK NOW ASKS A QUESTION agent_runs CAN ANSWER. There is no
// suggestion_id on that table, so a run cannot be tied to a suggestion. What it does have is
// organisation_id, agent_name and started_at, which is enough for the question that actually
// matters: is an ICP agent running for THIS organisation right now. That is a slightly wider
// question than the original intended, and the widening is safe in the direction that
// matters, because it can only produce "wait a moment" where the truth was "regenerate". It
// never lets a spec-less ICP through.
//
// FAIL-OPEN IS RETAINED FOR A MISSING SUGGESTION AND ONLY FOR THAT. If the row cannot be
// read at all, the approve route's own pre-check has already 404'd, so reaching here with no
// row means something stranger is happening and blocking approval would be the wrong
// failure. A missing SPEC, by contrast, now fails closed, which is the entire point.

/** How long an ICP agent run may be in flight before we stop calling it "still generating". */
const GENERATION_THRESHOLD_MS = 10 * 60 * 1000

// The agent name is IMPORTED, never written out again here. Measured 2026-09-08: the live
// agent_runs table holds 'icp-generation', and the three plausible names a first draft of
// this file guessed ('icp-generation-agent', 'icp_generation_agent', 'icp-agent') were all
// wrong. A guard filtering on a name nothing writes matches zero rows and reports the
// reassuring answer for ever, which is the defect this whole file is being rewritten for.

export type IcpSpecValidation =
  | { valid: true }
  | { valid: false; reason: 'still_generating' | 'needs_regeneration' }

export async function validateIcpFilterSpec(
  supabase: SupabaseClient,
  suggestionId: string,
): Promise<IcpSpecValidation> {
  const { data: suggestion, error: fetchError } = await supabase
    .from('document_suggestions')
    .select('id, document_type, suggested_value, organisation_id')
    .eq('id', suggestionId)
    .single()

  if (fetchError || !suggestion) {
    // See the header: the approve route has already established the row exists. Blocking
    // here would turn a strange read failure into a stuck approval.
    logger.warn('validateIcpFilterSpec: suggestion could not be read, allowing approval', {
      suggestion_id: suggestionId,
      error: fetchError?.message ?? null,
    })
    return { valid: true }
  }

  if (suggestion.document_type !== 'icp') return { valid: true }

  if (hasFilterSpec(suggestion.suggested_value as string | null)) {
    logger.debug('validateIcpFilterSpec: filter spec present', { suggestion_id: suggestionId })
    return { valid: true }
  }

  // No spec. Distinguish "the agent is still working" from "this needs regenerating", so the
  // operator is told to wait or to act, rather than being told something vague.
  const { data: runs, error: runsError } = await supabase
    .from('agent_runs')
    .select('id, agent_name, started_at, status')
    .eq('organisation_id', suggestion.organisation_id)
    .eq('agent_name', ICP_AGENT_NAME)
    .order('started_at', { ascending: false })
    .limit(1)

  if (runsError) {
    // A failure to read agent_runs must not decide the outcome. The spec is genuinely
    // missing either way; only the WORDING of the operator's message is at stake, so fall
    // back to the actionable one rather than to silence.
    logger.warn('validateIcpFilterSpec: agent_runs read failed, defaulting to needs_regeneration', {
      suggestion_id: suggestionId,
      error: runsError.message,
    })
    return { valid: false, reason: 'needs_regeneration' }
  }

  const latest = runs?.[0]
  if (latest?.started_at) {
    const ageMs = Date.now() - new Date(latest.started_at as string).getTime()
    if (ageMs < GENERATION_THRESHOLD_MS && latest.status === 'running') {
      logger.info('validateIcpFilterSpec: ICP agent still running, spec not ready yet', {
        suggestion_id: suggestionId,
        organisation_id: suggestion.organisation_id,
        run_age_ms: ageMs,
      })
      return { valid: false, reason: 'still_generating' }
    }
  }

  logger.warn('validateIcpFilterSpec: filter spec missing, ICP needs regeneration', {
    suggestion_id: suggestionId,
    organisation_id: suggestion.organisation_id,
  })
  return { valid: false, reason: 'needs_regeneration' }
}

/**
 * True when the suggestion body carries a non-empty `icp_filter_spec`.
 *
 * Unparseable JSON counts as NO SPEC rather than throwing. `approve_document_suggestion`
 * casts the same string to jsonb and raises its own clear error, so the approval fails
 * either way; returning false here means the operator gets the spec message first, which is
 * wrong in wording but never wrong in outcome.
 */
function hasFilterSpec(suggestedValue: string | null): boolean {
  if (!suggestedValue) return false

  let parsed: unknown
  try {
    parsed = JSON.parse(suggestedValue)
  } catch {
    return false
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false

  const spec = (parsed as Record<string, unknown>)['icp_filter_spec']
  if (!spec || typeof spec !== 'object') return false

  // An empty object is not a spec. Without this, `icp_filter_spec: {}` would pass the gate
  // and fail at sourcing, which is exactly the outcome the gate exists to prevent.
  return Object.keys(spec as Record<string, unknown>).length > 0
}
