import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import {
  planApproval,
  REFUSAL_MESSAGES,
  type CursorDecision,
} from '@/lib/sourcing/approve-icp-filter-spec'
import {
  describeRemovedExclusions,
  describeSettingsDiff,
  type DescribedChange,
  type ExclusionTick,
} from '@/lib/sourcing/describe-settings-diff'
import { resolveActiveSourcingHandler } from '@/lib/sourcing/handler-registry'
import {
  countMovements,
  fetchEnrichedProspects,
  REPLAY_STATES,
  replayTiering,
  type Movement,
  type ReplayState,
} from '@/lib/sourcing/tiering-replay'
import type { SourcingHandler } from '@/lib/sourcing/types'
import { createServiceRoleClient } from '@/lib/supabase/service-role'

// What the operator is shown before approving a change to a client's search settings.
// ADR-061 step 6: the before-and-after, and who would be re-tiered.
//
// ─── IT SHOWS THE APPROVAL'S OWN PLAN ────────────────────────────────────────
//
// Everything here comes from planApproval, the function the approve route runs. The
// fingerprint, the exclusions that need a tick, whether the criterion gates, whether the
// cursor resets and whether anyone is re-queued are that function's answers, read here and
// acted on there. The screen cannot promise something the approval then does not do,
// because there is one implementation of each.
//
// ─── WHO IS RE-TIERED, AND WHO ONLY LOOKS DIFFERENT ──────────────────────────
//
// An approval re-queues REMOVED prospects and nobody else (ADR-037's scope, kept by
// ADR-061). A prospect already in a tier keeps it, because re-tiering someone already
// published to a client is a different decision. So the replay is reported as two things,
// and they are not the same kind of fact:
//
//   requeued_outcome   what WILL happen. Removed prospects go back to tiering, and this is
//                      where the proposed settings put each one.
//   survivors_moved    what the new settings WOULD say about people who keep their tier.
//                      Nothing changes for them on approval. It is shown so that a change
//                      which quietly disowns part of the existing list is not approved
//                      blind.
//
// The survivors are compared replay against replay, the live settings and then the
// proposed ones, both run today. Comparing against the STORED tier instead would count
// every row whose stored verdict has drifted from today's code as if this change had
// moved it.
//
// ─── OPERATOR ONLY, DECIDED BEFORE ANY READ ──────────────────────────────────
//
// loadProposalPanelForViewer refuses a viewer who is not an operator before it builds a
// client or reads a row. A client's page load never selects the proposal column, so the
// proposal is absent from what a client receives and not merely unrendered.

export type RetierView =
  /** The change touches nothing tiering reads. Nobody is re-queued and nothing was replayed. */
  | { kind: 'none' }
  | {
      kind: 'replayed'
      /** Removed prospects that go back into the tiering queue on approval. */
      requeued: number
      /** Of those, removed before they were enriched. They go back to the buyer check. */
      requeued_not_enriched: number
      /** Where the proposed settings put the enriched ones. Every state listed, zeros included. */
      requeued_outcome: Array<{ to: Exclude<ReplayState, 'not_tiered'>; count: number }>
      /** People who keep their tier, and whom the proposed settings would judge differently. */
      survivors_moved: Movement[]
      /** Enriched prospects replayed. */
      judged: number
    }
  /** The replay could not be run. The approval itself is unaffected. */
  | { kind: 'unavailable'; reason: string }

export interface ProposalPanelView {
  document_id: string
  /** Sent back with Approve or Reject. Names the proposal AND the live settings shown. */
  fingerprint: string
  /** True when the client has no live settings yet. */
  first_settings: boolean
  /** Each changed setting, in plain words. Empty when the settings would do the same thing. */
  changes: DescribedChange[]
  /** One tick per exclusion the proposal stops applying. Approve needs all of them. */
  exclusions: ExclusionTick[]
  /** Reasons this proposal cannot be approved as it stands. Empty means it can. */
  blockers: string[]
  /** Set when a re-derived criterion did not gate and the live one was kept in its place. */
  criterion_held: { status: string; reason: string | null } | null
  cursor: CursorDecision
  retier: RetierView
}

type Row = {
  icp_filter_spec: ICPFilterSpec | null
  icp_filter_spec_proposed: ICPFilterSpec | null
  document_type: string
  status: string
}

async function buildRetierView(
  service: SupabaseClient,
  organisationId: string,
  live: ICPFilterSpec | null,
  proposed: ICPFilterSpec,
): Promise<RetierView> {
  try {
    // The same three conditions the approve function's re-queue uses. A count, so the
    // number on the screen is the number of rows that statement will touch.
    const { count, error } = await service
      .from('prospects')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', organisationId)
      .is('sourced_tier', null)
      .not('tiering_reason', 'is', null)
    if (error) throw new Error(`removed prospects could not be counted: ${error.message}`)
    if (typeof count !== 'number') throw new Error('removed prospects could not be counted: no count returned')

    const prospects = await fetchEnrichedProspects(service, organisationId)
    const after = await replayTiering(prospects, proposed, service)
    const before = live ? await replayTiering(prospects, live, service) : null

    const requeuedEnriched = after.filter(verdict => verdict.stored === 'removed')
    const outcome = REPLAY_STATES
      .filter((state): state is Exclude<ReplayState, 'not_tiered'> => state !== 'not_tiered')
      .map(to => ({ to, count: requeuedEnriched.filter(verdict => verdict.replayed === to).length }))

    const survivorPairs = after.flatMap((verdict, index) =>
      verdict.stored === 'removed' || verdict.stored === 'not_tiered'
        ? []
        : [{ from: before ? before[index].replayed : verdict.stored, to: verdict.replayed }],
    )

    return {
      kind: 'replayed',
      requeued: count,
      requeued_not_enriched: Math.max(0, count - requeuedEnriched.length),
      requeued_outcome: outcome,
      survivors_moved: countMovements(survivorPairs),
      judged: prospects.length,
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    logger.error('buildProposalPanel: the tiering replay could not be run', {
      organisation_id: organisationId,
      error: reason,
      consequence: 'The panel shows the change without the replay. Approving is unaffected.',
    })
    return { kind: 'unavailable', reason }
  }
}

/**
 * The panel for one ICP version, or null when nothing is waiting on it.
 *
 * `service` must be a service-role client: the handler registry and another
 * organisation's prospects are not readable through a client's session. THROWS when the
 * document cannot be read, so the caller can say the panel failed rather than show
 * "nothing pending".
 */
export async function buildProposalPanel(
  service: SupabaseClient,
  input: { organisationId: string; documentId: string },
): Promise<ProposalPanelView | null> {
  const { data, error } = await service
    .from('strategy_documents')
    .select('document_type, status, icp_filter_spec, icp_filter_spec_proposed')
    .eq('id', input.documentId)
    .eq('organisation_id', input.organisationId)
    .maybeSingle()
  if (error) throw new Error(`the proposal could not be read: ${error.message}`)

  const row = data as Row | null
  if (!row || row.document_type !== 'icp' || row.status !== 'active' || !row.icp_filter_spec_proposed) {
    return null
  }
  const live = row.icp_filter_spec ?? null
  const proposed = row.icp_filter_spec_proposed

  // Resolved exactly as the approval resolves it, so the cursor decision shown is the one
  // the approval will make.
  let handler: SourcingHandler | null = null
  try {
    handler = await resolveActiveSourcingHandler(service)
  } catch {
    handler = null
  }

  const plan = planApproval(live, proposed, handler)

  return {
    document_id: input.documentId,
    fingerprint: plan.fingerprint,
    first_settings: live === null,
    changes: describeSettingsDiff(plan.diff),
    exclusions: describeRemovedExclusions(plan.diff.removed_exclusions),
    blockers: plan.criterion_gates ? [] : [REFUSAL_MESSAGES.criterion_does_not_gate],
    criterion_held: proposed.criterion_held
      ? { status: proposed.criterion_held.rederived_status, reason: proposed.criterion_held.reason }
      : null,
    cursor: plan.cursor,
    retier: plan.requeue_fields.length === 0
      ? { kind: 'none' }
      : await buildRetierView(service, input.organisationId, live, proposed),
  }
}

export type ProposalPanelState =
  /** Not an operator, not the live ICP, or nothing is waiting. */
  | { state: 'none' }
  | { state: 'pending'; view: ProposalPanelView }
  /** Something may be waiting and it could not be read. Said on screen, never hidden. */
  | { state: 'failed' }

/**
 * The page's one call. Decides who may see a proposal before anything is read.
 *
 * NEVER THROWS. A page that cannot load the panel still has a document to show.
 */
export async function loadProposalPanelForViewer(viewer: {
  role: string | null
  docType: string
  docStatus: string | null
  organisationId: string
  documentId: string
}): Promise<ProposalPanelState> {
  if (viewer.role !== 'operator' || viewer.docType !== 'icp' || viewer.docStatus !== 'active') {
    return { state: 'none' }
  }
  try {
    const service = await createServiceRoleClient()
    const view = await buildProposalPanel(service, {
      organisationId: viewer.organisationId,
      documentId: viewer.documentId,
    })
    return view ? { state: 'pending', view } : { state: 'none' }
  } catch (err) {
    logger.error('loadProposalPanelForViewer: the proposal panel could not be loaded', {
      organisation_id: viewer.organisationId,
      document_id: viewer.documentId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { state: 'failed' }
  }
}
