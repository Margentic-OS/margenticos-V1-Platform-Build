// What a client may see of their buyer criterion, and what only an operator may.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A SEPARATE MODULE AND NOT A CONDITION IN THE PAGE
//
// Two rules live here and both fail closed. A condition inlined in a JSX branch cannot
// be tested without rendering a page, and both of these are the kind of rule that has to
// keep being true after the next person edits the layout around it.
//
// ─── RULE 1: THE CRITERION IS SHOWN ONLY FROM THE LIVE DOCUMENT ──────────────
//
// RLS DOES NOT ENFORCE THIS. Read live on 2026-09-03, the client policy on
// strategy_documents admits status in ('active', 'approved', 'archived'), because a
// client can read their own version history. So a component handed an archived row
// would happily render a criterion the organisation no longer targets by.
//
// This check is what makes the criterion follow the live document and nothing else.
//
// WHAT THIS CHECK USED TO BE. Until 2026-09-03 it also required
// client_approval_status = 'approved', to cover a window where promote_strategy_doc_version
// made a document live while marking it unapproved. Client approval is gone and so is
// that window: a document is live because an operator produced it. See ADR-047.

// ─── RULE 2: ONLY A CRITERION THAT IS ACTUALLY IN FORCE ──────────────────────
//
// A criterion whose status is `unsettled` or `out_of_band` does NOT gate anything: the
// enrichment path fails open and contacts everyone. Showing a client a sentence saying
// "this is who we contact" while contacting everyone would be false, and specifically
// false in the reassuring direction. Nothing is better than wrong here.
//
// ─── WHAT THE CLIENT NEVER RECEIVES ──────────────────────────────────────────
//
// The fragment list. It is a list of job-title words, and putting it in front of a client
// invites them to treat it as an editable filter, which is precisely the behaviour the
// plain-English statement exists to replace. It is stripped HERE, at the boundary, so it
// is absent from the payload rather than merely unrendered by a component.

export interface ClientBuyerCriterion {
  statement: string
  evidence: string[]
}

export interface OperatorBuyerCriterion extends ClientBuyerCriterion {
  status: string
  accept: Array<{ fragment: string; rank: string }>
  reject: string[]
  sanityNote: string | null
  unsettledReason: string | null
  /** False when the parent document is not the live one. */
  visibleToClient: boolean
}

/** The document fields this decision depends on. Nothing else is read. */
export interface CriterionSourceDoc {
  status: string | null
  icp_filter_spec: unknown
}

interface RawCriterion {
  status?: unknown
  statement?: unknown
  evidence?: unknown
  accept?: unknown
  reject?: unknown
  sanity?: { note?: unknown } | null
  unsettled_reason?: unknown
}

function readCriterion(spec: unknown): RawCriterion | null {
  if (!spec || typeof spec !== 'object') return null
  const c = (spec as Record<string, unknown>).buyer_criterion
  if (!c || typeof c !== 'object') return null
  return c as RawCriterion
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function textList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(text).filter((v): v is string => v !== null)
    : []
}

/** True only when the parent document is the live one, not an archived version. */
export function parentIsLive(doc: CriterionSourceDoc): boolean {
  return doc.status === 'active'
}

/**
 * What the client may see. Null means render nothing.
 *
 * Returns null when the parent ICP is not the live document, when the criterion is not
 * in force, or when there is no statement to show. Every one of those is "show nothing",
 * never "show a partial version".
 */
export function selectClientBuyerCriterion(
  doc: CriterionSourceDoc,
): ClientBuyerCriterion | null {
  if (!parentIsLive(doc)) return null

  const raw = readCriterion(doc.icp_filter_spec)
  if (!raw) return null

  // Only a criterion that is actually gating. See RULE 2 above.
  if (raw.status !== 'derived') return null

  const statement = text(raw.statement)
  if (!statement) return null

  return { statement, evidence: textList(raw.evidence) }
}

/**
 * What an operator may see, including the fragment list and why it is or is not visible
 * to the client. Not gated on liveness: the operator's job is to look at it BEFORE the
 * client does, which is the entire reason the statement exists.
 */
export function selectOperatorBuyerCriterion(
  doc: CriterionSourceDoc,
): OperatorBuyerCriterion | null {
  const raw = readCriterion(doc.icp_filter_spec)
  if (!raw) return null

  const accept = Array.isArray(raw.accept)
    ? raw.accept
        .map(entry => {
          if (!entry || typeof entry !== 'object') return null
          const e = entry as Record<string, unknown>
          const fragment = text(e.fragment)
          const rank = text(e.rank)
          return fragment && rank ? { fragment, rank } : null
        })
        .filter((v): v is { fragment: string; rank: string } => v !== null)
    : []

  return {
    statement: text(raw.statement) ?? '',
    evidence: textList(raw.evidence),
    status: text(raw.status) ?? 'unknown',
    accept,
    reject: textList(raw.reject),
    sanityNote: text(raw.sanity?.note),
    unsettledReason: text(raw.unsettled_reason),
    visibleToClient: selectClientBuyerCriterion(doc) !== null,
  }
}
