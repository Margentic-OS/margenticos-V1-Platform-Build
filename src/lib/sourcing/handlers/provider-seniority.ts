// The sourcing provider's own seniority vocabulary.
//
// ─── WHY THIS IS A SEPARATE MODULE AND WHY IT LIVES HERE ─────────────────────
//
// These strings are PROVIDER VOCABULARY. They are the values one sourcing tool accepts on
// its seniority parameter, in that tool's own spelling, and they mean whatever that tool
// says they mean. They are not a description of anybody's buyer.
//
// CLAUDE.md puts vocabulary like this in the handler layer and nowhere else, for the same
// reason the industry-code table and the country table live beside it: everything upstream
// of a handler speaks the client's language or a canonical one, and only the handler knows
// what the tool wants to hear. This list used to be written into the filter-spec TYPE,
// upstream of every handler, which is that rule inverted.
//
// It is its own file rather than an export from the adapter because the spec module needs
// the type and the adapter already imports the spec module. Putting it in the adapter would
// close a circular import, and a circular import in this repository has already passed
// `tsc --noEmit` and the whole vitest suite and failed only `npm run build`.
//
// ─── WHAT MUST NEVER HAPPEN HERE ─────────────────────────────────────────────
//
// Nothing in this file may decide which of these bands a client gets. The moment a rule
// appears here that picks a subset, this becomes the defect it was written to remove: a
// buyer-type assumption applied to every client. This file's whole job is to say what the
// provider will accept. Which of them describe one client's buyer is a reading of that
// client's own documents, and it is made per client, once, by the agent that reads them.

/**
 * Every seniority value the sourcing provider accepts.
 *
 * ORDERED AS THE PROVIDER DOCUMENTS THEM, not ranked. There is no seniority ladder here
 * and there must not be one: a ladder would encode an opinion about which levels matter,
 * which is the judgement that belongs to the client's own documents.
 *
 * MEASURED 2026-09-08 against the live provider, each value sent alone: every one of these
 * returns a distinct, plausible count on a real client's search. None is silently ignored,
 * which matters because this provider drops an unrecognised value rather than erroring.
 */
export const PROVIDER_SENIORITY_BANDS = [
  'owner',
  'founder',
  'c_suite',
  'partner',
  'vp',
  'head',
  'director',
  'manager',
  'senior',
  'entry',
  'intern',
] as const

export type ProviderSeniorityBand = (typeof PROVIDER_SENIORITY_BANDS)[number]

/** Membership test, so callers validate against the one list rather than a copy of it. */
export function isProviderSeniorityBand(value: unknown): value is ProviderSeniorityBand {
  return typeof value === 'string' &&
    (PROVIDER_SENIORITY_BANDS as readonly string[]).includes(value)
}

/**
 * Keep only values the provider will actually honour, in the provider's own order.
 *
 * ─── WHY IT FILTERS RATHER THAN THROWS ───────────────────────────────────────
 *
 * The input comes from a model reading a client's documents. A value it invents is a value
 * the provider would silently drop, and a silently dropped value is indistinguishable from
 * a filter that worked. Filtering here turns that into something countable: the caller can
 * compare what it asked for against what survived and refuse on the difference.
 *
 * Deduplicated and reordered deterministically, so two runs that derive the same set store
 * the same array and a diff between two specs means something.
 */
export function keepHonourableBands(values: readonly unknown[]): ProviderSeniorityBand[] {
  const seen = new Set<string>()
  for (const value of values) {
    if (isProviderSeniorityBand(value)) seen.add(value)
  }
  return PROVIDER_SENIORITY_BANDS.filter(band => seen.has(band))
}
