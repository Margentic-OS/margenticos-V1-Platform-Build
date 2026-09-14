// A client's fit dimensions, the judge's reading of each, and the grade computed from them.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THE GRADE IS NOT THE JUDGE'S
//
// Given byte-identical input at temperature 0, the fit judge disagreed with itself on 8 of 20
// prospects (measured 2026-09-11). In 3 of those 8 its three checks came back identical both
// times: the facts it read were stable and the final word was not. So the final word is taken
// away from it. The judge now reads each dimension and quotes the words that show it, and the
// fixed rules in gradeFromDimensions turn those readings into a grade, the same way every time.
//
// WHY THE DIMENSIONS ARE FIXED PER CLIENT
//
// Which conditions a client's profile names, and which of them research can ever show, used
// to be re-decided inside every judge call. They are now decided once, when the profile is
// approved (src/agents/fit-dimensions-agent.ts), and stored on the filter spec. Nothing in
// this file names a market, a buyer, a figure or a company: every dimension comes from one
// client's own profile.
//
// Deterministic code throughout (ADR-018). No model call, no database, no clock.

import type { IcpFit } from './types'

export const DIMENSION_RESULTS = ['match', 'miss', 'unknown', 'unestablished'] as const
export type DimensionResult = typeof DIMENSION_RESULTS[number]

export const DIMENSION_ROLES = ['required', 'supporting'] as const
export type DimensionRole = typeof DIMENSION_ROLES[number]

export interface FitDimension {
  /** Stable identifier in lower snake case. The judge answers under it. */
  key: string
  /** What must be true of a prospect, phrased so that meeting it is good for fit. */
  statement: string
  /** The words of the client's profile it was read from, verbatim. */
  source: string
  /** required: a prospect who fails it is not a fit. supporting: typical of a fit, not a condition. */
  role: DimensionRole
  /** Settled at approval: will the research this platform gathers usually show it either way? */
  establishable: boolean
}

/** The set stored on the filter spec, with what produced it. */
export interface FitDimensionSet {
  dimensions: FitDimension[]
  derived_at: string
  model: string
}

export interface DimensionReading {
  /** What the judge answered, or unknown when it gave no answer the code can read. */
  judged: DimensionResult
  /** The quotation exactly as the judge gave it, or null. */
  evidence: string | null
  /** Whether that quotation was found in the material the judge was shown. */
  quote_found: boolean
  /** What the grade counts. See countedResult for the only ways it differs from judged. */
  counted: DimensionResult
}

export type DimensionReadings = Record<string, DimensionReading>

/** A profile names a handful of conditions. More than this is a list, not a profile. */
export const MAX_DIMENSIONS = 10

/** Shorter than this, a quotation proves nothing about which passage it came from. */
export const MIN_QUOTE_CHARS = 8

const KEY_PATTERN = /^[a-z][a-z0-9_]{1,47}$/

// ─── Checking a list ──────────────────────────────────────────────────────────

export type CheckedDimensions =
  | { ok: true; dimensions: FitDimension[] }
  | { ok: false; reason: string }

/**
 * A list of dimensions read strictly: every field present and well formed, keys unique, and at
 * least one dimension the research can establish. A list with none could never grade anyone,
 * because every prospect would come out cannot_tell.
 */
export function checkFitDimensions(raw: unknown): CheckedDimensions {
  const fail = (reason: string): CheckedDimensions => ({ ok: false, reason })
  if (!Array.isArray(raw)) return fail('the dimensions are not a list')
  if (raw.length === 0) return fail('the list is empty')
  if (raw.length > MAX_DIMENSIONS) return fail(`the list holds ${raw.length} dimensions, more than ${MAX_DIMENSIONS}`)

  const seen = new Set<string>()
  const dimensions: FitDimension[] = []
  for (const [i, entry] of raw.entries()) {
    const at = `dimension ${i + 1}`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail(`${at} is not an object`)
    const e = entry as Record<string, unknown>
    const key = typeof e.key === 'string' ? e.key.trim() : ''
    if (!KEY_PATTERN.test(key)) return fail(`${at} has key ${JSON.stringify(e.key ?? null)}, which is not lower snake case`)
    if (seen.has(key)) return fail(`key ${key} appears twice`)
    seen.add(key)
    const statement = typeof e.statement === 'string' ? e.statement.trim() : ''
    if (!statement) return fail(`${key} has no statement`)
    const source = typeof e.source === 'string' ? e.source.trim() : ''
    if (!source) return fail(`${key} has no source`)
    const role = DIMENSION_ROLES.find(r => r === e.role)
    if (!role) return fail(`${key} has role ${JSON.stringify(e.role ?? null)}, not required or supporting`)
    if (typeof e.establishable !== 'boolean') return fail(`${key} does not say whether research can establish it`)
    dimensions.push({ key, statement, source, role, establishable: e.establishable })
  }

  if (!dimensions.some(d => d.establishable)) {
    return fail('no dimension is one the research can establish, so no prospect could ever be graded')
  }
  return { ok: true, dimensions }
}

/**
 * The dimensions stored on a filter spec. null with no problem when the spec has none, which is
 * every spec approved before this existed. null WITH a problem when something is stored and
 * does not read, so the caller can say so rather than quietly grading without it.
 */
export function readStoredFitDimensions(stored: unknown): { dimensions: FitDimension[] | null; problem: string | null } {
  if (stored === undefined || stored === null) return { dimensions: null, problem: null }
  const checked = checkFitDimensions((stored as { dimensions?: unknown }).dimensions)
  return checked.ok
    ? { dimensions: checked.dimensions, problem: null }
    : { dimensions: null, problem: checked.reason }
}

// ─── Quotations ───────────────────────────────────────────────────────────────

/** Case, curly quotes and runs of whitespace are not differences a quotation should fail on. */
export function normaliseForQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

// Quote marks, a trailing full stop or an ellipsis at either END are how a quotation is
// presented, not part of it. An ellipsis in the MIDDLE is two passages joined, and fails.
const PRESENTATION_EDGES = /^(?:["'\s]|\.{3}|…)+|(?:["'\s.,;:]|\.{3}|…)+$/g

/**
 * True when the quotation appears, as one continuous passage, in the material.
 *
 * This is what makes a match or a miss evidence rather than an assertion: the judge must
 * point at words it was actually shown. A paraphrase, a summary, or a passage stitched from
 * two places is not found, and the reading it supported counts as unknown.
 */
export function quoteFound(quote: string | null, material: string): boolean {
  if (!quote) return false
  const needle = normaliseForQuote(quote).replace(PRESENTATION_EDGES, '')
  if (needle.length < MIN_QUOTE_CHARS) return false
  return normaliseForQuote(material).includes(needle)
}

// ─── Reading the judge's answer ───────────────────────────────────────────────

/**
 * What the grade counts for one dimension. Two rules, and nothing else:
 *
 * 1. A match or a miss stands only on a quotation found in the material. Without one it is
 *    unknown. "Anything without evidence counts as unknown."
 * 2. Whether research can establish the dimension was settled at approval and is not the
 *    judge's to revisit. On a dimension research can establish, an answer of unestablished is
 *    unknown. On one it usually cannot, silence is expected and counts as unestablished.
 */
export function countedResult(dimension: FitDimension, judged: DimensionResult, quoteOk: boolean): DimensionResult {
  const evidenced: DimensionResult = (judged === 'match' || judged === 'miss') && !quoteOk ? 'unknown' : judged
  if (dimension.establishable) return evidenced === 'unestablished' ? 'unknown' : evidenced
  return evidenced === 'unknown' ? 'unestablished' : evidenced
}

/**
 * The judge's reading of every dimension on the list. A dimension it did not answer, or
 * answered with something outside DIMENSION_RESULTS, reads as unknown. Keys it invented are
 * ignored: only the client's own list is read.
 */
export function readDimensionAnswers(raw: unknown, dimensions: FitDimension[], material: string): DimensionReadings {
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  return Object.fromEntries(dimensions.map(d => {
    const answer = given[d.key] && typeof given[d.key] === 'object' ? given[d.key] as Record<string, unknown> : null
    const judged = DIMENSION_RESULTS.find(r => r === answer?.result) ?? 'unknown'
    const evidence = typeof answer?.evidence === 'string' && answer.evidence.trim() ? answer.evidence.trim() : null
    const found = quoteFound(evidence, material)
    return [d.key, { judged, evidence, quote_found: found, counted: countedResult(d, judged, found) }]
  }))
}

// ─── The grade ────────────────────────────────────────────────────────────────

export interface DimensionGrade {
  icp_fit: IcpFit
  icp_fit_missing: string | null
  icp_fit_unestablished: string[]
}

/**
 * The grade, from the counted readings, by fixed rules applied in this order:
 *
 *   weak         a required dimension is a miss
 *   cannot_tell  a required dimension research can establish is unknown,
 *                or no dimension research can establish is a match
 *   strong       every dimension research can establish is a match
 *   moderate     otherwise: every required one matched, and a supporting one missed or
 *                was not shown
 *
 * A dimension research usually cannot establish never makes a prospect cannot_tell. It counts
 * only when the material did show it, and then only a miss on a required one moves the grade.
 */
export function gradeFromDimensions(dimensions: FitDimension[], readings: DimensionReadings): DimensionGrade {
  const counted = (d: FitDimension): DimensionResult => readings[d.key]?.counted ?? 'unknown'
  const icp_fit_unestablished = dimensions.filter(d => counted(d) === 'unestablished').map(d => d.statement)
  const establishable = dimensions.filter(d => d.establishable)
  const grade = (icp_fit: IcpFit, icp_fit_missing: string | null = null): DimensionGrade =>
    ({ icp_fit, icp_fit_missing, icp_fit_unestablished })

  if (dimensions.some(d => d.role === 'required' && counted(d) === 'miss')) return grade('weak')

  const notShown = establishable.filter(d => d.role === 'required' && counted(d) === 'unknown')
  if (notShown.length > 0) {
    return grade('cannot_tell', `Not shown either way: ${notShown.map(d => d.statement).join('; ')}`)
  }
  if (!establishable.some(d => counted(d) === 'match')) {
    return grade('cannot_tell', 'No dimension the research can establish was shown to match.')
  }

  if (establishable.every(d => counted(d) === 'match')) return grade('strong')
  return grade('moderate')
}

// ─── How the judge is shown the list ──────────────────────────────────────────

/** One dimension per bullet, with its key, whether it is required, and whether research can show it. */
export function formatFitDimensions(dimensions: FitDimension[]): string {
  return dimensions.map(d =>
    `  • ${d.key}: ${d.statement}\n` +
    `    ${d.role === 'required' ? 'Required' : 'Supporting'}. ` +
    `${d.establishable ? 'The research can establish this.' : 'The research usually cannot establish this.'}`,
  ).join('\n')
}
