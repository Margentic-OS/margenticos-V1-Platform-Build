// Turning a proposed search into a request the provider will actually honour.
//
// ─── THE STEP THAT WAS MISSING ───────────────────────────────────────────────
//
// Without this the loop could measure the search a client already has and describe a better
// one, and never find out whether the better one was better. A proposal that is never run is
// an opinion.
//
// ─── WHY IT STARTS FROM THE CURRENT REQUEST AND OVERLAYS ─────────────────────
//
// A proposal names the parts it wants to change. Everything it does not name stays exactly
// as the client's stored search has it, and that is deliberate in both directions:
//
//   it cannot silently drop a constraint by failing to mention it, which is how a candidate
//   would score well by quietly searching wider than the client asked
//
//   the two searches then differ ONLY in what the proposal named, so a difference in the
//   measurement is attributable to the proposal rather than to everything else moving
//
// ─── WHAT IT REFUSES TO TRANSLATE ────────────────────────────────────────────
//
// Categories and places arrive in the client's own words, and this module has no table that
// turns a phrase into a provider category or a country code: those tables live in the
// handler layer and are keyed on canonical names, not on prose. Rather than guess, an
// untranslatable element is REPORTED as untranslatable and the axis is left as the client's
// stored search has it. A guessed translation would produce a candidate that measures well
// for a reason nobody could name.

import { keepHonourableBands } from '@/lib/sourcing/handlers/provider-seniority'
import { ALL_EXCLUDED_COUNTRIES } from '@/lib/sourcing/geography-exclusion'
import { OMITTED_AXIS_TARGET } from '@/lib/sourcing/handlers/adapter-apollo'
import type { ProposedSearch } from '@/lib/tuner/proposed-search'

/** One change the candidate makes to the client's current search. */
export interface AppliedChange {
  axis: string
  /** What the request carried before, rendered for a person. */
  before: string
  /** What it carries now. */
  after: string
  /** The proposal's own reason, carried through so the plan explains itself. */
  reason: string
}

export interface CandidateRequest {
  request: Record<string, unknown>
  applied: AppliedChange[]
  /** Elements this module could not turn into a provider value, with why. */
  untranslated: { axis: string; value: string; why: string }[]
}

const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

const render = (v: unknown): string =>
  v === undefined ? '(not sent)' : Array.isArray(v) ? `[${v.join(', ')}]` : JSON.stringify(v)

/**
 * Build the candidate.
 *
 * `current` is the request the client's stored search produces, already built and validated
 * by the handler. This overlays the proposal on top of it.
 */
export function proposalToRequest(
  current: Record<string, unknown>,
  proposal: ProposedSearch,
): CandidateRequest {
  const request: Record<string, unknown> = { ...current }
  const applied: AppliedChange[] = []
  const untranslated: { axis: string; value: string; why: string }[] = []

  // Which request parameters each axis touched, so a contradictory axis can be put back
  // exactly as it was. Tracked rather than inferred: an axis is free to move more than one
  // key, and guessing the mapping afterwards is how a revert leaves half a change behind.
  const keysTouchedByAxis = new Map<string, Set<string>>()

  const change = (axis: string, key: string, next: unknown, reason: string) => {
    const before = render(request[key])
    if (next === undefined) delete request[key]
    else request[key] = next
    const after = render(request[key])
    if (before !== after) {
      applied.push({ axis, before, after, reason })
      const keys = keysTouchedByAxis.get(axis) ?? new Set<string>()
      keys.add(key)
      keysTouchedByAxis.set(axis, keys)
    }
  }

  // ── Words. The one axis that translates cleanly ──
  //
  // A descriptive word is sent to the provider as written, so the client's own vocabulary
  // reaches the query with nothing in between to get wrong. This is why the word layer is
  // where a whole-document derivation can actually change a search today: the category and
  // country axes both need a table this module does not own.
  if (proposal.words.length > 0) {
    change('search_word', 'q_organization_keyword_tags', proposal.words.map(w => w.value),
      proposal.words.map(w => w.reason).join(' | '))
  }

  // ── Size and revenue. Numbers, so no vocabulary is involved ──
  if (proposal.size && (proposal.size.min !== null || proposal.size.max !== null)) {
    const min = proposal.size.min ?? 1
    const max = proposal.size.max ?? 100_000
    change('headcount_band', 'organization_num_employees_ranges', [`${min},${max}`], proposal.size.reason)
  }
  if (proposal.revenue && (proposal.revenue.min !== null || proposal.revenue.max !== null)) {
    change('company_revenue', 'revenue_range', {
      ...(proposal.revenue.min !== null ? { min: proposal.revenue.min } : {}),
      ...(proposal.revenue.max !== null ? { max: proposal.revenue.max } : {}),
    }, proposal.revenue.reason)
  }

  // ── Categories and places: reported, not guessed ──
  for (const c of proposal.categories) {
    untranslated.push({
      axis: 'categories', value: c.value,
      why: 'No table in this layer turns a phrase into a provider category. The handler owns ' +
        'that translation and it is keyed on canonical names, not prose. The category axis is ' +
        "left as the client's stored search has it.",
    })
  }
  for (const p of proposal.places) {
    // A place that names an excluded country must not even be reported as a near miss, and
    // it is certainly never applied. The legal subtraction is not a preference.
    const looksExcluded = [...ALL_EXCLUDED_COUNTRIES].some(
      code => p.value.toUpperCase() === code || p.value.toUpperCase().startsWith(code + ' '),
    )
    untranslated.push({
      axis: 'places', value: p.value,
      why: looksExcluded
        ? 'Names a country the legal subtraction removes. Refused outright, not translated.'
        : 'No table in this layer turns a place phrase into a provider location. Geography is ' +
          "left as the client's stored search has it, which is also the safe direction: the " +
          'stored value has already been through the legal subtraction.',
    })
  }

  // ── Deliberate omissions ──
  //
  // An omitted axis is sent as ABSENT, which is the provider's own "no constraint", rather
  // than as an empty array which some parameters read as "match nothing". Measured: for all
  // three live clients, sending every seniority band returns exactly the population of
  // sending none, so omitting that axis is a real and sometimes correct proposal.
  for (const o of proposal.omit) {
    // The handler's own map, not a copy: see OMITTED_AXIS_TARGET in adapter-apollo.ts.
    const target = OMITTED_AXIS_TARGET[o.axis]
    if (target === 'post_filter') {
      untranslated.push({ axis: 'omit', value: o.axis, why: 'Not an axis this handler sends.' })
      continue
    }
    change(o.axis, target, undefined, o.reason)
  }

  // ── The seniority bands the same call derived ──
  //
  // Filtered through the provider's own list, because a value the model invents is one the
  // provider drops silently, and a silently dropped filter is indistinguishable from one
  // that worked.
  const bands = keepHonourableBands(arr(request.person_seniorities))
  if (bands.length !== arr(request.person_seniorities).length) {
    change('seniority', 'person_seniorities', bands.length > 0 ? bands : undefined,
      'Values outside the provider vocabulary were dropped before being sent.')
  }

  // ── A CONTRADICTORY AXIS IS COLLAPSED, NEVER APPLIED IN ORDER ──────────────
  //
  // A proposal may name the same axis twice and say two different things about it. MEASURED
  // 2026-09-09 on a live client: it asked for a revenue band AND asked for revenue to be
  // omitted, in one proposal. Both were applied, in the order this file happens to run them,
  // so the omission won and the band was silently discarded.
  //
  // THE PROBLEM IS NOT WHICH ONE WON. It is that the ORDER OF THE CODE decided, and the code
  // order carries no meaning at all: reordering two blocks here would have changed a client's
  // candidate search without a word of the proposal changing. Nothing in the applied list
  // said a contradiction had happened either, so the plan read as two ordinary changes.
  //
  // So a repeated axis is put back exactly as the client's stored search had it, and the
  // contradiction is reported. That is the same direction categories and places already take:
  // where this layer cannot know what was meant, it changes nothing and says so. Picking a
  // winner here would be this module resolving a disagreement it has no information about.
  const timesPerAxis = new Map<string, number>()
  for (const c of applied) timesPerAxis.set(c.axis, (timesPerAxis.get(c.axis) ?? 0) + 1)

  const contradictory = [...timesPerAxis.entries()].filter(([, n]) => n > 1).map(([axis]) => axis)
  for (const axis of contradictory) {
    for (const key of keysTouchedByAxis.get(axis) ?? []) {
      // Restored from `current`, not from the first recorded `before`: `before` is a rendered
      // string for display and cannot be turned back into the value it described.
      if (key in current) request[key] = current[key]
      else delete request[key]
    }
    const said = applied.filter(c => c.axis === axis)
    untranslated.push({
      axis, value: said.map(c => c.after).join(' AND ALSO '),
      why:
        `The proposal named this axis ${said.length} times and asked for different things ` +
        'each time. Applying them in sequence would let the order of this file decide, which ' +
        "means nothing, so the axis is left as the client's stored search has it.",
    })
  }
  const collapsed = applied.filter(c => !contradictory.includes(c.axis))

  return { request, applied: collapsed, untranslated }
}

/** A one-line description of the candidate, for the run report. */
export function describeCandidate(candidate: CandidateRequest): string {
  if (candidate.applied.length === 0) {
    return 'The proposal changed nothing this layer can send: ' +
      `${candidate.untranslated.length} element(s) could not be translated into a provider value.`
  }
  return candidate.applied.map(c => `${c.axis}: ${c.before} -> ${c.after}`).join('; ')
}
