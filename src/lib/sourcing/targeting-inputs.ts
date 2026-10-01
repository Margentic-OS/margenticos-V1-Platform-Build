// The targeting fields: the ONE list of things whose change may change who is sourced.
//
// ─── WHY THIS EXISTS (ADR-061) ───────────────────────────────────────────────
//
// Until ADR-061 every ICP promotion rebuilt the search settings, whatever the edit was. On
// 2026-09-30 an edit to two trigger reasons added a job title and a seniority band to one
// client's search, switched that client's buyer criterion off, and removed 62 prospects
// within five minutes. Nothing asked whether the edit had touched targeting, because
// nothing in the codebase said what "targeting" was.
//
// This module says it. A field listed here is a targeting field. Everything else in an ICP
// document is prose: triggers and their reasons, the job-to-be-done statement, the summary,
// labels and descriptions. A change to prose must never reach the search.
//
// ─── WHY IT IS ONE FUNCTION AND NOT A LIST OF PATHS ──────────────────────────
//
// A list of field names kept beside the code that reads them is the parallel-array shape
// CLAUDE.md warns about: the derivation starts reading a new field, the list is not
// updated, and an edit to that field silently stops counting as a targeting change.
//
// So the list is a TYPE. `targetingInputs()` returns a `TargetingInputs`, the deterministic
// derivation and the geography derivation accept only its `document` half, and reading a
// field that is not on these interfaces does not compile. The list cannot fall behind the
// code that reads it, because the code can only read what the list names.
//
// ─── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
//
//   tier 3            the disqualifier tier. No derivation reads it.
//   triggers          timing and motive. They decide what research looks for, never who
//                     is sourced.
//   stage, business   on the company profile, and read by the fit dimensions, but they do
//   model, summary    not reach the search. An edit to only these does not rebuild the fit
//                     dimensions. ADR-061 records that as an accepted cost.
//
// The buyer criterion's model call still reads every document in full when it runs. That
// is safe: what DECIDES whether it runs is this list, and what it produces waits for the
// operator's approval.
//
// Nothing here names an industry, a role, a country or a vendor, and nothing here may.

/** The company-side targeting fields of one tier. Verbatim from the document. */
export interface TargetingCompanyProfile {
  industries: string[]
  /** Prose. Parsed into a range by the derivation unless the client typed one into intake. */
  headcount: string | null
  /** Prose. Parsed into a band by the derivation. */
  revenue_range: string | null
  /** Prose. Read by the geography derivation and by nothing else. */
  geography?: string | null
}

/** Who the buyer is, as the document states it. */
export interface TargetingBuyerProfile {
  title: string | null
  seniority: string | null
}

export interface TargetingTier {
  company_profile: TargetingCompanyProfile
  buyer_profile: TargetingBuyerProfile
  /** A targeting field by Doug's decision of 2026-09-30. */
  disqualifiers: string[]
}

/** The document half: tiers 1 and 2, and only the fields above. */
export interface TargetingDocument {
  tier_1: TargetingTier
  tier_2: TargetingTier
}

export interface TargetingHeadcount {
  min: number
  max: number
}

/**
 * Everything that may change the search settings, and nothing that may not.
 *
 * Stored inside the settings it produced (`icp_filter_spec.targeting_inputs`), so that the
 * next promotion can ask one question: are these still the inputs?
 */
export interface TargetingInputs {
  document: TargetingDocument
  /** The staff-count pair the client typed into intake. Null when they have not. */
  stated_headcount: TargetingHeadcount | null
  /** The organisation's revenue-filter switch. */
  revenue_filter_enabled: boolean
}

/** The two inputs that live outside the ICP document. */
export interface OutsideDocumentInputs {
  statedHeadcount?: { min: number; max: number } | null
  revenueFilterEnabled?: boolean | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// VERBATIM, NOT NORMALISED. A string is copied exactly as the document holds it: no trim, no
// case folding, no sorting. The derivation has always read these values raw, so copying them
// raw is what makes "derived from the projection" identical to "derived from the document".
// The cost is that a whitespace-only edit to a targeting field counts as a change. That is
// the safe direction: it files a proposal nobody needed, where normalising would risk
// swallowing an edit somebody meant.
function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function pickTier(tier: unknown): TargetingTier {
  const t = isRecord(tier) ? tier : {}
  const company = isRecord(t.company_profile) ? t.company_profile : {}
  const buyer = isRecord(t.buyer_profile) ? t.buyer_profile : {}
  return {
    company_profile: {
      industries: stringList(company.industries),
      headcount: text(company.headcount),
      revenue_range: text(company.revenue_range),
      geography: text(company.geography),
    },
    buyer_profile: { title: text(buyer.title), seniority: text(buyer.seniority) },
    disqualifiers: stringList(t.disqualifiers),
  }
}

/**
 * A stated staff-count pair, or null for anything that is not a usable one.
 *
 * THE ONE DEFINITION. `deriveFilterSpec` uses this to decide whether the intake answer or
 * the document prose supplies the headcount, and `targetingInputs` uses it to decide what
 * to store. Two copies of this rule would let a pair the derivation ignores count as a
 * targeting change, or the reverse.
 *
 * Repeats conditions the form and a database CHECK already enforce, deliberately: the value
 * arrives through a row read, and a row written before the CHECK existed, a hand-edited
 * one, or a fake in a test reaches here in any shape at all.
 */
export function usableHeadcountPair(
  stated: { min: number; max: number } | null | undefined,
): TargetingHeadcount | null {
  if (!stated) return null
  const { min, max } = stated
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null
  if (min < 1 || max < min) return null
  return { min, max }
}

/**
 * Project an ICP document, and the two inputs outside it, onto the targeting fields.
 *
 * Total: any shape of document produces a `TargetingInputs`. A missing tier is an empty
 * tier, which the derivation then refuses loudly, as it always has.
 *
 * Takes `unknown` on purpose. The document arrives from a jsonb column, and typing the
 * parameter as the full document type would invite this function to trust a shape nobody
 * has checked.
 */
export function targetingInputs(
  icpContent: unknown,
  outside: OutsideDocumentInputs = {},
): TargetingInputs {
  const doc = isRecord(icpContent) ? icpContent : {}
  return {
    document: { tier_1: pickTier(doc.tier_1), tier_2: pickTier(doc.tier_2) },
    stated_headcount: usableHeadcountPair(outside.statedHeadcount),
    revenue_filter_enabled: outside.revenueFilterEnabled === true,
  }
}

/**
 * Read a stored snapshot back, or null when it is not one.
 *
 * NULL MEANS "CANNOT TELL", AND THE CALLER MUST TREAT THAT AS CHANGED. Settings written
 * before this existed carry no snapshot, and a hand-edited row can carry anything. Reading
 * either as "unchanged" would be the one failure this module exists to prevent: the search
 * and the document disagreeing with nothing saying so.
 */
export function readStoredTargetingInputs(value: unknown): TargetingInputs | null {
  if (!isRecord(value)) return null
  if (!isRecord(value.document)) return null
  if (!isRecord(value.document.tier_1) || !isRecord(value.document.tier_2)) return null
  if (typeof value.revenue_filter_enabled !== 'boolean') return null
  const stated = value.stated_headcount
  if (stated !== null && !isRecord(stated)) return null
  const pair = stated === null
    ? null
    : usableHeadcountPair({ min: stated.min as number, max: stated.max as number })
  if (stated !== null && pair === null) return null
  // Re-projected rather than cast, so a stored snapshot carrying an extra key, or a tier
  // missing one, is compared in exactly the shape a fresh projection would have.
  return {
    document: {
      tier_1: pickTier(value.document.tier_1),
      tier_2: pickTier(value.document.tier_2),
    },
    stated_headcount: pair,
    revenue_filter_enabled: value.revenue_filter_enabled,
  }
}

/** Which parts of the settings a change obliges the caller to rebuild. */
export interface TargetingChange {
  /** False only when every targeting field is identical. */
  changed: boolean
  /** Every leaf that differs, dotted, in a stable order. Empty when nothing changed. */
  paths: string[]
  /** A geography field changed, so the geography derivation must run. */
  geography: boolean
  /** A buyer profile or a disqualifier changed, so the buyer criterion must run. */
  buyer: boolean
  /** Any field in the document changed, so the fit dimensions must be rebuilt. */
  document: boolean
  /** The stated headcount or the revenue switch changed. */
  outside: boolean
  /**
   * True when there was nothing usable to compare against. Everything is then rebuilt, and
   * `paths` is empty because no path was compared.
   */
  unknown_before: boolean
}

// Leaves are compared as whole values. A list is ONE leaf, ordered: reordering it counts as
// a change, for the same reason strings are not trimmed.
function leaves(value: unknown, prefix: string, out: Map<string, string>): void {
  if (isRecord(value)) {
    for (const key of Object.keys(value).sort()) {
      leaves(value[key], prefix ? `${prefix}.${key}` : key, out)
    }
    return
  }
  // undefined and null are the same leaf: both mean the document did not state it.
  out.set(prefix, JSON.stringify(value ?? null))
}

/**
 * Compare the inputs stored with the live settings against the current ones.
 *
 * `before` null is "cannot tell", which is reported as changed with every rebuild flag
 * set. See readStoredTargetingInputs.
 */
export function compareTargetingInputs(
  before: TargetingInputs | null | undefined,
  after: TargetingInputs,
): TargetingChange {
  if (!before) {
    return {
      changed: true, paths: [], geography: true, buyer: true, document: true, outside: true,
      unknown_before: true,
    }
  }
  const a = new Map<string, string>()
  const b = new Map<string, string>()
  leaves(before, '', a)
  leaves(after, '', b)
  const paths = [...new Set([...a.keys(), ...b.keys()])]
    .filter(path => a.get(path) !== b.get(path))
    .sort()

  const inDocument = (path: string) => path.startsWith('document.')
  return {
    changed: paths.length > 0,
    paths,
    geography: paths.some(p => inDocument(p) && p.endsWith('.company_profile.geography')),
    buyer: paths.some(p => inDocument(p) && (p.includes('.buyer_profile.') || p.endsWith('.disqualifiers'))),
    document: paths.some(inDocument),
    outside: paths.some(p => !inDocument(p)),
    unknown_before: false,
  }
}
