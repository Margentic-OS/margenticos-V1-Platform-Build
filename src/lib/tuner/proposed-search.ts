// A search proposed from the WHOLE document, and the guard that keeps it honest.
//
// ─── WHY THIS TYPE EXISTS SEPARATELY FROM THE STORED SPEC ────────────────────
//
// The stored spec is what sourcing uses. This is what the tuner PROPOSES, and the two must
// not be the same shape, because a proposal carries something a spec never does: for every
// element, why it is there and whether the document stated it or the model inferred it.
//
// Nothing here is written to a client's spec. The proposal is stored on the tuning run for a
// person to read.
//
// ─── TRACEABILITY IS A FILTER, NOT A LABEL ───────────────────────────────────
//
// An element arrives with a reason. An element whose reason is missing or empty is DROPPED
// here rather than stored with a blank field, because a stored element with no reason is
// indistinguishable downstream from one that was justified, and the whole point of the
// reason is to be checkable.
//
// The failure this guards against is specific and has already happened: a misread sentence
// turned one client's strongest market into a rejection rule. Nothing caught it because
// nothing recorded what the rule was based on.

import { OMITTABLE_AXES, type OmittableAxis } from '@/lib/agents/icp-filter-spec'

/** Whether the document said it, or the model worked it out. Never collapsed into one. */
export type Basis = 'stated' | 'inferred'

export interface ProposedElement {
  /** The client's own words, or a value from the provider vocabulary layer. */
  value: string
  /** What in the document supports it. Non-empty by construction; see parseProposedSearch. */
  reason: string
  basis: Basis
}

export interface ProposedRange {
  min: number | null
  max: number | null
  reason: string
  basis: Basis
}

export interface ProposedOmission {
  axis: OmittableAxis
  reason: string
}

export interface ProposedSearch {
  categories: ProposedElement[]
  words: ProposedElement[]
  size: ProposedRange | null
  revenue: ProposedRange | null
  places: ProposedElement[]
  omit: ProposedOmission[]
  /** Elements dropped for having no traceable reason. Reported, never silently discarded. */
  droppedUntraceable: { axis: string; count: number }[]
}

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const asNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/**
 * `stated` unless the model explicitly said otherwise.
 *
 * DEFAULTS TO `inferred` ON ANYTHING UNRECOGNISED, which is the safe direction: marking a
 * guess as stated would let an unsupported element read as document-backed, and that is the
 * exact failure this file exists to prevent. Marking a stated element as inferred only makes
 * a reader look at it more closely.
 */
function asBasis(v: unknown): Basis {
  return v === 'stated' ? 'stated' : 'inferred'
}

function parseElements(raw: unknown, dropped: { axis: string; count: number }[], axis: string): ProposedElement[] {
  if (!Array.isArray(raw)) return []
  const out: ProposedElement[] = []
  let drops = 0
  for (const entry of raw as Record<string, unknown>[]) {
    const value = asText(entry?.value)
    const reason = asText(entry?.reason)
    if (!value) continue
    // THE TRACEABILITY FILTER. No reason, no proposal.
    if (!reason) { drops++; continue }
    out.push({ value, reason, basis: asBasis(entry?.basis) })
  }
  if (drops > 0) dropped.push({ axis, count: drops })
  // Deduplicate on value, keeping the first reason, so two runs that propose the same thing
  // twice store it once and a diff between proposals means something.
  const seen = new Set<string>()
  return out.filter(e => (seen.has(e.value.toLowerCase()) ? false : (seen.add(e.value.toLowerCase()), true)))
}

function parseRange(raw: unknown, dropped: { axis: string; count: number }[], axis: string): ProposedRange | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const min = asNum(r.min)
  const max = asNum(r.max)
  if (min === null && max === null) return null
  const reason = asText(r.reason)
  if (!reason) { dropped.push({ axis, count: 1 }); return null }
  // An inverted range is a misreading, not a narrow band. Dropped rather than swapped,
  // because swapping would silently produce a range the document never described.
  if (min !== null && max !== null && min > max) { dropped.push({ axis, count: 1 }); return null }
  return { min, max, reason, basis: asBasis(r.basis) }
}

function parseOmissions(raw: unknown, dropped: { axis: string; count: number }[]): ProposedOmission[] {
  if (!Array.isArray(raw)) return []
  const allowed = new Set<string>(OMITTABLE_AXES)
  const out: ProposedOmission[] = []
  let drops = 0
  for (const entry of raw as Record<string, unknown>[]) {
    const value = asText(entry?.value)
    const reason = asText(entry?.reason)
    // An axis outside the allowed list is not a smaller version of a valid omission. It is
    // a proposal to stop constraining on something that must always constrain, and the one
    // that matters is geography: omitting it would mean sourcing everywhere, including the
    // places the legal subtraction removes.
    if (!allowed.has(value) || !reason) { drops++; continue }
    out.push({ axis: value as OmittableAxis, reason })
  }
  if (drops > 0) dropped.push({ axis: 'omit', count: drops })
  return out
}

/**
 * Read the proposed search out of the single derivation call's response.
 *
 * Tolerant of absence: a response with no `search` key returns an empty proposal rather than
 * throwing, because this rides on a call whose primary job is the buyer criterion and a
 * tuning feature must never be able to break the spec derivation.
 */
export function parseProposedSearch(raw: unknown): ProposedSearch {
  const dropped: { axis: string; count: number }[] = []
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    categories: parseElements(s.categories, dropped, 'categories'),
    words: parseElements(s.words, dropped, 'words'),
    size: parseRange(s.size, dropped, 'size'),
    revenue: parseRange(s.revenue, dropped, 'revenue'),
    places: parseElements(s.places, dropped, 'places'),
    omit: parseOmissions(s.omit, dropped),
    droppedUntraceable: dropped,
  }
}

/** True when the proposal carries nothing usable, which the caller reports as a refusal. */
export function proposalIsEmpty(p: ProposedSearch): boolean {
  return p.categories.length === 0 && p.words.length === 0 && p.places.length === 0 &&
    p.size === null && p.revenue === null
}

/** How much of the proposal the document actually stated, as a figure an operator can read. */
export function statedShare(p: ProposedSearch): { stated: number; inferred: number; share: number | null } {
  const all: Basis[] = [
    ...p.categories.map(e => e.basis),
    ...p.words.map(e => e.basis),
    ...p.places.map(e => e.basis),
    ...(p.size ? [p.size.basis] : []),
    ...(p.revenue ? [p.revenue.basis] : []),
  ]
  const stated = all.filter(b => b === 'stated').length
  const inferred = all.length - stated
  return { stated, inferred, share: all.length > 0 ? stated / all.length : null }
}
