import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type { FilterSpecField, ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import { resolveActiveSourcingHandler } from '@/lib/sourcing/handler-registry'
import {
  diffSettings,
  type RemovedExclusion,
  type SettingsDiff,
} from '@/lib/sourcing/settings-diff'
import { TIERING_SPEC_FIELDS, type TieringSpecField } from '@/lib/sourcing/tier-classification'
import type { SourcingHandler } from '@/lib/sourcing/types'

// How a proposed change to a client's search settings becomes live, or is thrown away.
// ADR-061 rules 5 to 8.
//
// ─── THE ONE WAY IN ──────────────────────────────────────────────────────────
//
// `icp_filter_spec` on the active ICP row is what sourcing, tiering, the pre-enrichment
// gate and the research judge all read. After ADR-061 exactly one thing replaces it: an
// operator approving the proposal that sits beside it. This module is that approval.
//
// ─── WHAT IT REFUSES ─────────────────────────────────────────────────────────
//
//   changed_since_shown       the proposal, or the live settings it was compared with, is
//                             not the one the operator was shown. They decided about
//                             something else.
//   criterion_does_not_gate   the proposed buyer criterion would not be applied. A
//                             criterion that does not gate never becomes live.
//   exclusions_not_confirmed  the proposal stops applying an exclusion that is live, and
//                             that removal was not ticked. Named, never counted: on
//                             2026-09-30 two excluded titles were swapped for two others
//                             and the count did not move.
//   sourcing_in_progress      the approval would move the client's place in the search
//                             while a run is reading from the old place.
//   no_proposal, not_active, not_icp, not_found
//
// ─── WHAT AN APPROVAL DOES, AND WHAT DECIDES EACH PART ───────────────────────
//
//   settings, stamp     always: the proposal replaces the live settings, the proposal is
//                       cleared, and who and when are recorded.
//   the cursor          reset to zero ONLY when the request the sourcing handler builds
//                       from the new settings differs from the one it builds from the old.
//   removed prospects   re-queued for tiering ONLY when the change touches something
//                       tiering reads. This is the only thing that thaws a removal.
//
// All of it is written by ONE database function, in one transaction, which also re-checks
// that the row is still the one judged here. See
// supabase/migrations/20261001153000_icp_filter_spec_approve_reject.sql for why.
//
// ─── THE PANEL AND THE APPROVAL USE THE SAME PLAN ────────────────────────────
//
// planApproval is pure. The before-and-after panel calls it to SHOW what an approval would
// do, and the approval calls it to DO it. So the number on the screen and the thing that
// happens cannot come from two implementations.
//
// Never throws.

export const APPROVAL_REFUSALS = [
  'not_found',
  'not_icp',
  'not_active',
  'no_proposal',
  'changed_since_shown',
  'criterion_does_not_gate',
  'exclusions_not_confirmed',
  'sourcing_in_progress',
] as const
export type ApprovalRefusal = (typeof APPROVAL_REFUSALS)[number]

/** What the operator is told. One sentence each, and what to do about it. */
export const REFUSAL_MESSAGES = {
  not_found: 'That ICP version does not exist.',
  not_icp: 'That document is not an ICP, so it has no search settings.',
  not_active: 'A newer version of this ICP is live. Reload the page and review the proposal there.',
  no_proposal: 'There is no proposed change waiting on this ICP. Reload the page.',
  changed_since_shown:
    'The proposal or the live settings changed after this page was loaded. Reload and review it again.',
  criterion_does_not_gate:
    'The proposed buyer criterion would not be applied to anyone, so it cannot become live. ' +
    'Settle who the buyer is in the documents, which files a new proposal.',
  exclusions_not_confirmed:
    'This change stops applying one or more exclusions. Tick each one to confirm it before approving.',
  sourcing_in_progress:
    'A sourcing run is in progress for this client and this change moves their place in the ' +
    'search. Approve it when the run has finished.',
} as const satisfies Record<ApprovalRefusal, string>

/** The HTTP status each refusal answers with. Beside the messages so a new code needs both. */
export const REFUSAL_STATUS = {
  not_found: 404,
  not_icp: 400,
  not_active: 409,
  no_proposal: 409,
  changed_since_shown: 409,
  criterion_does_not_gate: 422,
  exclusions_not_confirmed: 422,
  sourcing_in_progress: 409,
} as const satisfies Record<ApprovalRefusal, number>

/** What the database functions may answer. Anything else is a failure, not a refusal. */
const DATABASE_REFUSALS: ReadonlySet<string> = new Set<ApprovalRefusal>([
  'not_found', 'not_icp', 'not_active', 'no_proposal', 'changed_since_shown', 'sourcing_in_progress',
])

// ─── Naming a removed exclusion, and the proposal itself ─────────────────────

/** The string a tick carries. One per removed exclusion, by where it was and what it was. */
export function exclusionKey(exclusion: Pick<RemovedExclusion, 'source' | 'value'>): string {
  return `${exclusion.source}:${exclusion.value}`
}

/**
 * Stable text for a JSON value: object keys sorted, so two readings of the same stored
 * value always produce the same text whatever order the keys arrived in.
 *
 * `sortLists` also sorts every array. That is right for comparing two provider requests,
 * where the order of a list of titles or codes changes nothing, and wrong for naming a
 * proposal, where the stored value is the thing being named.
 */
function stableText(value: unknown, sortLists: boolean): string {
  if (Array.isArray(value)) {
    const items = value.map(item => stableText(item, sortLists))
    if (sortLists) items.sort()
    return `[${items.join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).filter(key => record[key] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableText(record[key], sortLists)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * What "the proposal the operator was shown" means.
 *
 * It covers the LIVE settings as well as the proposal. The before-and-after is a
 * comparison, and it is wrong if either side has moved: the exclusions a proposal removes
 * are the ones present in the live settings.
 */
export function approvalFingerprint(live: ICPFilterSpec | null, proposed: ICPFilterSpec): string {
  return createHash('sha256').update(stableText({ live, proposed }, false)).digest('hex')
}

// ─── The plan ────────────────────────────────────────────────────────────────

export type CursorDecision =
  /** The handler builds the same request from both. The client keeps their place. */
  | { reset: false; why: 'request_unchanged' }
  /** The request differs, so the old offset indexes a result set nobody will read again. */
  | { reset: true; why: 'request_changed' }
  /** There were no settings before, so there is no place to keep. */
  | { reset: true; why: 'first_settings' }
  /** One of the two requests could not be built. Not knowing is not "unchanged". */
  | { reset: true; why: 'request_not_built'; detail: string }

export interface ApprovalPlan {
  fingerprint: string
  diff: SettingsDiff
  /** Whether the pre-enrichment gate and tiering would apply the proposed criterion. */
  criterion_gates: boolean
  cursor: CursorDecision
  /** The fields tiering reads that this change touches. Empty means nobody is re-queued. */
  requeue_fields: TieringSpecField[]
}

// Every field tiering reads must be one this module knows how to compare: the buyer
// criterion through the diff's own comparison, and the rest as filter fields. A field
// added to TIERING_SPEC_FIELDS that is neither makes this line a compile error, rather
// than a change to it silently never re-queuing anyone.
type _TieringFieldNotCompared = Exclude<TieringSpecField, FilterSpecField | 'buyer_criterion'>
const _everyTieringFieldIsCompared: [_TieringFieldNotCompared] extends [never] ? true : never = true
void _everyTieringFieldIsCompared

function decideCursor(
  live: ICPFilterSpec | null,
  proposed: ICPFilterSpec,
  handler: Pick<SourcingHandler, 'adapter'> | null,
): CursorDecision {
  if (!live) return { reset: true, why: 'first_settings' }
  if (!handler) {
    return { reset: true, why: 'request_not_built', detail: 'no sourcing handler is registered' }
  }
  try {
    // THE HANDLER'S OWN REQUEST BUILDER, so "did the query change" is answered by the code
    // that builds the query and not by a second opinion about which fields reach it. The
    // adapter returns the first page for any settings, so paging is equal on both sides by
    // construction, and lists are compared without regard to order.
    //
    // A CHANGE THAT TOUCHES ONLY POST-FILTERS KEEPS THE OFFSET. An excluded title or an
    // excluded keyword is applied to rows after they are fetched and is not part of the
    // request. So loosening one does not send the client back to re-read records that were
    // dropped under the stricter rule. Accepted in ADR-061 rule 8: re-reading from the top
    // would cost every record already consumed to recover a handful.
    const before = stableText(handler.adapter(live), true)
    const after = stableText(handler.adapter(proposed), true)
    return before === after
      ? { reset: false, why: 'request_unchanged' }
      : { reset: true, why: 'request_changed' }
  } catch (err) {
    return {
      reset: true,
      why: 'request_not_built',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * What approving this proposal would do. Pure: no database, no model.
 *
 * `handler` is the registered sourcing handler, or null when there is none.
 */
export function planApproval(
  live: ICPFilterSpec | null,
  proposed: ICPFilterSpec,
  handler: Pick<SourcingHandler, 'adapter'> | null,
): ApprovalPlan {
  const diff = diffSettings(live, proposed)
  return {
    fingerprint: approvalFingerprint(live, proposed),
    diff,
    criterion_gates: diff.criterion.gates_after,
    cursor: decideCursor(live, proposed, handler),
    requeue_fields: TIERING_SPEC_FIELDS.filter(field =>
      field === 'buyer_criterion'
        ? diff.criterion.changed
        : diff.field_changes.some(change => change.field === field),
    ),
  }
}

/** The removed exclusions that have no tick. Empty means the floor is met. */
export function unconfirmedRemovals(
  plan: ApprovalPlan,
  confirmedRemovals: readonly string[],
): RemovedExclusion[] {
  const ticked = new Set(confirmedRemovals)
  return plan.diff.removed_exclusions.filter(exclusion => !ticked.has(exclusionKey(exclusion)))
}

// ─── Reading the row ─────────────────────────────────────────────────────────

interface ProposalRow {
  organisation_id: string
  live: ICPFilterSpec | null
  proposed: ICPFilterSpec
}

type Refused = { outcome: 'refused'; refused: ApprovalRefusal; unconfirmed?: RemovedExclusion[] }
type Failed = { outcome: 'failed'; step: string; error: string }

function fail(fn: string, step: string, err: unknown, context: Record<string, unknown>): Failed {
  const error = err instanceof Error ? err.message : String(err)
  logger.error(`${fn}: ${step} failed`, {
    ...context,
    error,
    consequence: 'Nothing was written. The live search settings and the proposal are as they were.',
  })
  return { outcome: 'failed', step, error }
}

async function readProposalRow(
  supabase: SupabaseClient,
  documentId: string,
): Promise<{ row: ProposalRow } | Refused | { error: string }> {
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('id, organisation_id, document_type, status, icp_filter_spec, icp_filter_spec_proposed')
    .eq('id', documentId)
    .maybeSingle()
  if (error) return { error: error.message }
  if (!data) return { outcome: 'refused', refused: 'not_found' }
  if (data.document_type !== 'icp') return { outcome: 'refused', refused: 'not_icp' }
  if (data.status !== 'active') return { outcome: 'refused', refused: 'not_active' }
  if (!data.icp_filter_spec_proposed) return { outcome: 'refused', refused: 'no_proposal' }
  return {
    row: {
      organisation_id: data.organisation_id as string,
      live: (data.icp_filter_spec ?? null) as ICPFilterSpec | null,
      proposed: data.icp_filter_spec_proposed as ICPFilterSpec,
    },
  }
}

// ─── Approve ─────────────────────────────────────────────────────────────────

export interface ApproveInput {
  documentId: string
  /** The fingerprint the operator's page was rendered with. */
  fingerprint: string
  /** One exclusionKey per removed exclusion the operator ticked. */
  confirmedRemovals: readonly string[]
  /** The operator's users.id. */
  approvedBy: string
}

export type ApprovalOutcome =
  | {
      outcome: 'approved'
      organisation_id: string
      cursor_reset: boolean
      previous_offset: number | null
      requeued_count: number
    }
  | Refused
  | Failed

export async function approveIcpFilterSpecProposal(
  supabase: SupabaseClient,
  input: ApproveInput,
): Promise<ApprovalOutcome> {
  const fn = 'approveIcpFilterSpecProposal'
  const context: Record<string, unknown> = {
    document_id: input.documentId,
    approved_by: input.approvedBy,
  }

  try {
    const read = await readProposalRow(supabase, input.documentId)
    if ('error' in read) return fail(fn, 'read the proposal', read.error, context)
    if ('outcome' in read) return read
    const { row } = read
    context.organisation_id = row.organisation_id

    // A handler that cannot be resolved is not a reason to refuse an approval. It is a
    // reason not to trust the old offset, which is what planApproval does with null.
    let handler: SourcingHandler | null = null
    try {
      handler = await resolveActiveSourcingHandler(supabase)
    } catch (err) {
      logger.warn(`${fn}: no sourcing handler could be resolved, the cursor will be reset`, {
        ...context, error: err instanceof Error ? err.message : String(err),
      })
    }

    const plan = planApproval(row.live, row.proposed, handler)

    if (plan.fingerprint !== input.fingerprint) {
      return { outcome: 'refused', refused: 'changed_since_shown' }
    }

    // THE FLOORS. Checked here, where the settings are about to be written, and not only
    // on the screen: a request that never came from the panel meets the same two rules.
    if (!plan.criterion_gates) {
      logger.warn(`${fn}: refused, the proposed buyer criterion does not gate`, {
        ...context, status: plan.diff.criterion.status_after,
      })
      return { outcome: 'refused', refused: 'criterion_does_not_gate' }
    }

    const unconfirmed = unconfirmedRemovals(plan, input.confirmedRemovals)
    if (unconfirmed.length > 0) {
      logger.warn(`${fn}: refused, removed exclusions were not confirmed`, {
        ...context, unconfirmed_count: unconfirmed.length, unconfirmed,
      })
      return { outcome: 'refused', refused: 'exclusions_not_confirmed', unconfirmed }
    }

    const requeue = plan.requeue_fields.length > 0
    const { data, error } = await supabase.rpc('approve_icp_filter_spec_proposal', {
      p_document_id: input.documentId,
      p_expected_proposal: row.proposed,
      p_expected_live: row.live,
      p_approved_by: input.approvedBy,
      p_reset_cursor: plan.cursor.reset,
      p_requeue: requeue,
    })
    if (error) return fail(fn, 'write the approved settings', error.message, context)

    const result = (data ?? {}) as {
      applied?: boolean
      refused?: string
      organisation_id?: string
      cursor_reset?: boolean
      previous_offset?: number | null
      requeued_count?: number
    }
    if (result.applied !== true) {
      if (typeof result.refused === 'string' && DATABASE_REFUSALS.has(result.refused)) {
        logger.warn(`${fn}: refused by the database`, { ...context, refused: result.refused })
        return { outcome: 'refused', refused: result.refused as ApprovalRefusal }
      }
      return fail(fn, 'write the approved settings', `unexpected answer: ${JSON.stringify(data)}`, context)
    }

    const approved = {
      outcome: 'approved' as const,
      organisation_id: row.organisation_id,
      cursor_reset: result.cursor_reset === true,
      previous_offset: typeof result.previous_offset === 'number' ? result.previous_offset : null,
      requeued_count: typeof result.requeued_count === 'number' ? result.requeued_count : 0,
    }

    // AT WARN, with both counts, whether or not either is zero. ADR-037 required the
    // re-queue count to be loud because it commits the next tiering runs to real work and
    // each re-tiered survivor goes on to cost research money. The cursor is the same kind
    // of fact: a reset means the next sourcing run reads from the top.
    logger.warn(`${fn}: proposal approved, the live search settings changed`, {
      ...context,
      first_settings: row.live === null,
      changed_fields: plan.diff.field_changes.map(change => change.field),
      criterion_changed: plan.diff.criterion.changed,
      exclusions_removed: plan.diff.removed_exclusions.length,
      cursor_reset: approved.cursor_reset,
      cursor_decision: plan.cursor.why,
      previous_offset: approved.previous_offset,
      requeued_count: approved.requeued_count,
      requeue_fields: plan.requeue_fields,
    })
    return approved
  } catch (err) {
    return fail(fn, 'an unexpected step', err, context)
  }
}

// ─── Reject ──────────────────────────────────────────────────────────────────

export interface RejectInput {
  documentId: string
  fingerprint: string
  rejectedBy: string
}

export type RejectionOutcome =
  | { outcome: 'rejected'; organisation_id: string }
  | Refused
  | Failed

/**
 * Throw a proposal away. The live settings, the cursor and every prospect are untouched.
 *
 * IT DOES NOT MAKE THE DOCUMENT AND THE SEARCH AGREE. The ICP still says what it said, and
 * the live settings still do what they did. The next time the targeting fields are compared
 * (any new ICP version, or a save of the intake headcount or the revenue switch) they will
 * still differ, and a proposal will be filed again. To stop that, change the targeting
 * field back, which is itself the comparison running and finding nothing to propose.
 */
export async function rejectIcpFilterSpecProposal(
  supabase: SupabaseClient,
  input: RejectInput,
): Promise<RejectionOutcome> {
  const fn = 'rejectIcpFilterSpecProposal'
  const context: Record<string, unknown> = {
    document_id: input.documentId,
    rejected_by: input.rejectedBy,
  }

  try {
    const read = await readProposalRow(supabase, input.documentId)
    if ('error' in read) return fail(fn, 'read the proposal', read.error, context)
    if ('outcome' in read) return read
    const { row } = read
    context.organisation_id = row.organisation_id

    if (approvalFingerprint(row.live, row.proposed) !== input.fingerprint) {
      return { outcome: 'refused', refused: 'changed_since_shown' }
    }

    const { data, error } = await supabase.rpc('reject_icp_filter_spec_proposal', {
      p_document_id: input.documentId,
      p_expected_proposal: row.proposed,
    })
    if (error) return fail(fn, 'clear the proposal', error.message, context)

    const result = (data ?? {}) as { rejected?: boolean; refused?: string }
    if (result.rejected !== true) {
      if (typeof result.refused === 'string' && DATABASE_REFUSALS.has(result.refused)) {
        return { outcome: 'refused', refused: result.refused as ApprovalRefusal }
      }
      return fail(fn, 'clear the proposal', `unexpected answer: ${JSON.stringify(data)}`, context)
    }

    logger.warn(`${fn}: proposal rejected, the live search settings stand`, {
      ...context,
      consequence:
        'The ICP and the search still disagree. The next comparison of the targeting ' +
        'fields files a proposal again unless the document is changed back.',
    })
    return { outcome: 'rejected', organisation_id: row.organisation_id }
  } catch (err) {
    return fail(fn, 'an unexpected step', err, context)
  }
}
