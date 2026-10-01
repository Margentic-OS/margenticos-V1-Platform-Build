// What changes between a client's live search settings and a proposed set. ADR-061.
//
// Pure. No database, no model, no sourcing handler. It answers three questions an approval
// has to be able to answer before it is allowed to happen:
//
//   1. What would the search ask for that it does not ask for today, and the reverse?
//   2. Which exclusions would stop applying? An exclusion may only be removed by a person
//      who was shown that it is being removed.
//   3. Would the buyer criterion still gate? A criterion that does not gate never becomes
//      live.
//
// ─── WHY EXCLUSIONS ARE COUNTED BY VALUE AND NEVER BY NUMBER ─────────────────
//
// On 2026-09-30 a re-derivation swapped two excluded job titles for two different ones. The
// count did not move. A rule of the form "the list may not get shorter" passes that, and
// two exclusions the client relied on stopped applying. So every exclusion present before
// and absent after is reported by name, whatever happened to the length of the list.
//
// ─── WHAT IT COMPARES, AND WHERE THAT LIST COMES FROM ────────────────────────
//
// Every field in FILTER_SPEC_FIELDS, which is the single list of constraints a sourcing
// handler is expected to honour. It is iterated, not copied, so a field added there is
// compared here with nothing to remember. Three metadata fields are also read, because they
// change what the settings DO: the buyer criterion, the switched-off axes, and the fit
// dimensions. The rest of the metadata is prose about the settings and is ignored.
//
// It does NOT say whether the provider request changes. That question belongs to the
// handler that builds the request, and is asked where the cursor is decided.

import {
  FILTER_SPEC_FIELDS,
  type FilterSpecField,
  type ICPFilterSpec,
  type OmittableAxis,
} from '@/lib/agents/icp-filter-spec'
import { evaluateBuyerCriterion, type BuyerCriterion } from '@/lib/sourcing/buyer-criterion'

/**
 * The filter fields that EXCLUDE.
 *
 * Written out rather than derived from the field names, because "ends in _excluded" is a
 * naming habit and not a rule. The test beside this file checks the two against each other
 * in both directions, so a new exclusion field cannot be added without landing here.
 */
export const EXCLUSION_FIELDS = [
  'job_titles_excluded',
  'industries_excluded',
  'keywords_excluded',
] as const satisfies readonly FilterSpecField[]
export type ExclusionField = (typeof EXCLUSION_FIELDS)[number]

/** Where a removed exclusion was. The criterion's reject list is enforced separately. */
export type ExclusionSource = ExclusionField | 'buyer_criterion.reject'

export interface RemovedExclusion {
  source: ExclusionSource
  value: string
  /**
   * `removed`: the entry is gone from the list.
   * `axis_switched_off`: the entry may still be listed, and the whole axis no longer applies.
   */
  how: 'removed' | 'axis_switched_off'
}

export interface ListFieldChange {
  field: FilterSpecField
  kind: 'list'
  added: string[]
  removed: string[]
}

export interface ValueFieldChange {
  field: FilterSpecField
  kind: 'value'
  before: number | null
  after: number | null
}

export type FieldChange = ListFieldChange | ValueFieldChange

export type CriterionStatus = BuyerCriterion['status'] | 'absent'

export interface CriterionChange {
  status_before: CriterionStatus
  status_after: CriterionStatus
  /** Whether the gate applies the criterion. Asked of the real gate, not re-derived here. */
  gates_before: boolean
  gates_after: boolean
  accept_added: string[]
  accept_removed: string[]
  /** Fragments accepted before and after, whose rank moved. */
  rank_changed: string[]
  reject_added: string[]
  reject_removed: string[]
  changed: boolean
}

export interface SettingsDiff {
  /** False only when nothing the settings DO has changed. */
  changed: boolean
  field_changes: FieldChange[]
  axes_switched_off: OmittableAxis[]
  axes_switched_on: OmittableAxis[]
  removed_exclusions: RemovedExclusion[]
  criterion: CriterionChange
  /** The research judge's conditions differ. Never affects who is sourced. */
  fit_dimensions_changed: boolean
}

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function asValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** In `a` and not in `b`, in `a`'s order, each once. Order within a list is never a change. */
function missingFrom(a: readonly string[], b: readonly string[]): string[] {
  const have = new Set(b)
  return [...new Set(a)].filter(v => !have.has(v))
}

// THE REAL GATE, with a probe title, which is how the pre-enrichment gate itself asks. A
// second copy of "status is derived and the accept list is not empty" would agree with the
// gate until the day the gate changed.
function gates(criterion: BuyerCriterion | null | undefined): boolean {
  return evaluateBuyerCriterion(criterion, 'x').decision !== 'no_criterion'
}

function diffCriterion(
  before: BuyerCriterion | null | undefined,
  after: BuyerCriterion | null | undefined,
): CriterionChange {
  const acceptBefore = new Map((before?.accept ?? []).map(e => [e.fragment, e.rank]))
  const acceptAfter = new Map((after?.accept ?? []).map(e => [e.fragment, e.rank]))
  const result: CriterionChange = {
    status_before: before?.status ?? 'absent',
    status_after: after?.status ?? 'absent',
    gates_before: gates(before),
    gates_after: gates(after),
    accept_added: missingFrom([...acceptAfter.keys()], [...acceptBefore.keys()]),
    accept_removed: missingFrom([...acceptBefore.keys()], [...acceptAfter.keys()]),
    rank_changed: [...acceptBefore.keys()].filter(
      fragment => acceptAfter.has(fragment) && acceptAfter.get(fragment) !== acceptBefore.get(fragment),
    ),
    reject_added: missingFrom(after?.reject ?? [], before?.reject ?? []),
    reject_removed: missingFrom(before?.reject ?? [], after?.reject ?? []),
    changed: false,
  }
  result.changed =
    result.status_before !== result.status_after ||
    result.gates_before !== result.gates_after ||
    result.accept_added.length > 0 ||
    result.accept_removed.length > 0 ||
    result.rank_changed.length > 0 ||
    result.reject_added.length > 0 ||
    result.reject_removed.length > 0
  return result
}

/**
 * Compare a proposed set of settings with the live one.
 *
 * `live` null means the client has no settings yet. Everything proposed is then an
 * addition, and nothing can have been removed.
 */
export function diffSettings(live: ICPFilterSpec | null | undefined, proposed: ICPFilterSpec): SettingsDiff {
  const before = (live ?? {}) as Record<string, unknown>
  const after = proposed as unknown as Record<string, unknown>

  const fieldChanges: FieldChange[] = []
  for (const field of FILTER_SPEC_FIELDS) {
    if (Array.isArray(before[field]) || Array.isArray(after[field])) {
      const added = missingFrom(asList(after[field]), asList(before[field]))
      const removed = missingFrom(asList(before[field]), asList(after[field]))
      if (added.length > 0 || removed.length > 0) {
        fieldChanges.push({ field, kind: 'list', added, removed })
      }
    } else {
      const was = asValue(before[field])
      const now = asValue(after[field])
      if (was !== now) fieldChanges.push({ field, kind: 'value', before: was, after: now })
    }
  }

  const offBefore = asList(before.omitted_axes) as OmittableAxis[]
  const offAfter = asList(after.omitted_axes) as OmittableAxis[]
  const switchedOff = missingFrom(offAfter, offBefore) as OmittableAxis[]
  const switchedOn = missingFrom(offBefore, offAfter) as OmittableAxis[]

  const removedExclusions: RemovedExclusion[] = []
  for (const field of EXCLUSION_FIELDS) {
    const was = asList(before[field])
    // An axis switched off stops applying EVERY entry on it, including the ones still
    // listed. Reporting only the entries that left the list would let a whole exclusion
    // axis be turned off with nothing to tick.
    if ((switchedOff as string[]).includes(field)) {
      for (const value of new Set(was)) {
        removedExclusions.push({ source: field, value, how: 'axis_switched_off' })
      }
      continue
    }
    for (const value of missingFrom(was, asList(after[field]))) {
      removedExclusions.push({ source: field, value, how: 'removed' })
    }
  }

  const criterion = diffCriterion(live?.buyer_criterion, proposed.buyer_criterion)
  for (const value of criterion.reject_removed) {
    removedExclusions.push({ source: 'buyer_criterion.reject', value, how: 'removed' })
  }

  // Compared on the dimensions alone. `derived_at` and `model` change on every derivation,
  // and a re-derivation that returned the same conditions has changed nothing.
  const fitDimensionsChanged =
    JSON.stringify(live?.fit_dimensions?.dimensions ?? null) !==
    JSON.stringify(proposed.fit_dimensions?.dimensions ?? null)

  return {
    changed:
      fieldChanges.length > 0 ||
      switchedOff.length > 0 ||
      switchedOn.length > 0 ||
      criterion.changed ||
      fitDimensionsChanged,
    field_changes: fieldChanges,
    axes_switched_off: switchedOff,
    axes_switched_on: switchedOn,
    removed_exclusions: removedExclusions,
    criterion,
    fit_dimensions_changed: fitDimensionsChanged,
  }
}
