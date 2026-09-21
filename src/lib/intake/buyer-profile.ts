// The five buyer-targeting intake questions, their typed shape, and the one place their
// wording lives.
//
// ─── WHY THIS IS NOT IN questions.ts ─────────────────────────────────────────
//
// SECTIONS in questions.ts is not merely a list of questions. Anything added to it is
// AUTOMATICALLY handed to four document-generation agents: mergeIntakeWithQuestions walks
// ALL_QUESTIONS, and each agent renders every entry into its prompt as "Q: <label> / A:
// <answer>". So a question added there starts changing generated documents the moment a
// client answers it, without a line of agent code being touched.
//
// These five answers are collected ahead of the work that consumes them. Nothing reads them
// yet, and a document written against an answer nothing was designed to use is a change to
// document generation by accident. Keeping them out of SECTIONS is what makes "collect now,
// wire later" actually true rather than merely intended.
//
// It is also why none of these is part of the completeness gate. See CRITICALITY below.
//
// The precedent is already in questions.ts: TYPED_VOICE_SAMPLES_FIELD_KEY is a field the form
// collects and SECTIONS does not contain. This is the same idea with a typed store behind it.
//
// ─── CRITICALITY, AND WHY NONE OF THESE IS CRITICAL ──────────────────────────
//
// `isCritical` in questions.ts does one job: it builds the denominator of the completeness
// ratio that gates DOCUMENT DISPATCH at /api/intake/complete. Marking a question critical is
// therefore a statement that document generation should not proceed without it.
//
// Nothing generated reads these answers, so that statement would be false today. Worse, it
// would be actively harmful: with 15 critical questions and a 0.8 ratio, adding five more
// moves the bar from 12/15 to 16/20, and every organisation sitting at 15/15 drops to 15/20
// and is refused a dispatch it already qualified for. Measured on the live database
// 2026-09-20: four of five organisations sit at exactly 15 of 15.
//
// These five are not less important than the questions in SECTIONS. They are the targeting
// spine. But criticality here means "block generation", not "matters", and the session that
// makes them matter to a generated artefact is the session that should reconsider it.
//
// ─── RULE ZERO ───────────────────────────────────────────────────────────────
//
// No label, help text, placeholder, comment or default in this file names an industry, a job
// title, a country, a sector or a company. The questions are deliberately written without an
// example, because an example in a targeting question is an instruction.

import {
  PROVIDER_SENIORITY_BANDS,
  isProviderSeniorityBand,
  type ProviderSeniorityBand,
} from '@/lib/sourcing/handlers/provider-seniority'
import { findCountryOption, selectableCountries } from '@/lib/sourcing/country-code'

// ─── The typed row ───────────────────────────────────────────────────────────

/**
 * One organisation's answers, in the shape a consumer reads them.
 *
 * Two integers and three string arrays, matching the columns one for one. Nothing here is
 * encoded into text and nothing needs parsing, which is the entire reason this is a table of
 * its own rather than rows in the EAV store.
 */
export interface BuyerProfile {
  /**
   * Q1. One country per entry, chosen from COUNTRY_OPTIONS, in the order they added them.
   *
   * WAS FREE TEXT AND IS NOT ANY MORE. The first client to answer this typed three countries
   * into one entry, and the stored value was a single string naming all three, which resolves
   * to no country at all. See COUNTRY_OPTIONS.
   */
  target_countries: string[]
  /** Q2. Both set or both null. The database CHECK forbids answering only half of it. */
  buyer_headcount_min: number | null
  buyer_headcount_max: number | null
  /** Q3. One title per entry. */
  buyer_job_titles: string[]
  /** Q3, second half. Provider tokens, validated against the one list of them. */
  buyer_seniority_bands: ProviderSeniorityBand[]
  /**
   * Q4. NO LONGER COLLECTED. The question that wrote it was deleted, not the column.
   *
   * It asked "who should we email first", which is the question the job titles field already
   * asks, and the one person who has answered this form could not tell the two apart. The
   * field stays on the interface so a row that already holds a value round-trips through the
   * form unchanged rather than being blanked by a save the client did not intend. Whether to
   * drop the column is a decision with live data behind it and is not this session's to make.
   */
  first_contact_role: string
  /** Q4. null is "not answered", which is not the same state as false. */
  signoff_required: boolean | null
  /** Q4. Only meaningful when signoff_required is true. */
  signoff_role: string
  /** Q5. */
  disqualifiers: string[]
}

export const EMPTY_BUYER_PROFILE: BuyerProfile = {
  target_countries: [],
  buyer_headcount_min: null,
  buyer_headcount_max: null,
  buyer_job_titles: [],
  buyer_seniority_bands: [],
  first_contact_role: '',
  signoff_required: null,
  signoff_role: '',
  disqualifiers: [],
}

// ─── Field keys ──────────────────────────────────────────────────────────────

/**
 * Every field this module stores, named once.
 *
 * DERIVED FROM EMPTY_BUYER_PROFILE rather than written out a second time, so a column added
 * to the interface without a staleness entry fails the staleness test instead of being
 * silently absent from it. Two hand-maintained lists that must agree is the parallel-array
 * defect, and this is exactly where it would appear.
 */
export const BUYER_PROFILE_FIELD_KEYS: readonly (keyof BuyerProfile)[] =
  Object.keys(EMPTY_BUYER_PROFILE) as (keyof BuyerProfile)[]

// ─── Seniority options ───────────────────────────────────────────────────────

/**
 * Display text for each band the provider accepts.
 *
 * TYPED AS A TOTAL RECORD WITH NO `as` CAST, deliberately. That makes an incomplete literal a
 * COMPILE ERROR, which is the notification that the provider's list has changed and this
 * control needs a label for the new band. Casting it would switch off exactly the check that
 * matters here. The tokens themselves are never retyped: the option VALUES come from
 * PROVIDER_SENIORITY_BANDS, and this map only supplies wording for a human.
 */
const SENIORITY_LABELS: Record<ProviderSeniorityBand, string> = {
  owner: 'Owner',
  founder: 'Founder',
  c_suite: 'C-suite',
  partner: 'Partner',
  vp: 'VP',
  head: 'Head',
  director: 'Director',
  manager: 'Manager',
  senior: 'Senior',
  entry: 'Entry level',
  intern: 'Intern',
}

export interface SeniorityOption {
  value: ProviderSeniorityBand
  label: string
}

/**
 * The options the multi-select offers, in the provider's own documented order.
 *
 * Built by mapping PROVIDER_SENIORITY_BANDS, so this is the provider's list and not a copy of
 * it: a band added, removed or reordered there changes this with no edit here.
 */
export const SENIORITY_OPTIONS: readonly SeniorityOption[] = PROVIDER_SENIORITY_BANDS.map(
  band => ({ value: band, label: SENIORITY_LABELS[band] }),
)

// ─── Country options ─────────────────────────────────────────────────────────

/**
 * The countries a client can choose, derived from the platform's own alias table.
 *
 * ─── WHY THIS IS A CLOSED LIST AND NOT A TEXT BOX ────────────────────────────
 *
 * The first real client to answer this question typed three countries into one entry. What
 * was stored was one string naming all three, and the whole point of a text[] column is that
 * its length is the number of answers. That value is not merely untidy: nothing downstream can
 * read it. toIso2CountryCode resolves one country name, and the geography derivation REFUSES
 * anything that does not resolve, so a combined string would stop a filter-spec derivation
 * days later, attached to a sourcing run rather than to the form that produced it.
 *
 * A closed list makes the bad value unrepresentable rather than merely discouraged. There is
 * no keystroke that puts a comma-separated string into one entry, because there is no
 * keystroke that puts anything into an entry: a client picks, and each pick is one entry.
 *
 * ─── WHY THE NAME IS STORED AND NOT THE CODE ─────────────────────────────────
 *
 * Both are canonical and either would resolve. The name is stored because two live consumers
 * read this value as WORDS rather than as an identifier: it is interpolated into the ICP
 * prompt as the binding value of company_profile.geography, which lands in a document a client
 * reads, and a single stated country becomes the geography term appended to a web search
 * query. A two-letter code is worse at both jobs and better at neither, since the code is one
 * function call away wherever a comparison needs it.
 *
 * RULE ZERO: this names countries, and a country list is not a client assumption. It is the
 * platform's existing jurisdiction vocabulary, read from the one module that owns it, offered
 * whole and unranked. No entry here is preferred, defaulted or suggested.
 */
export const COUNTRY_OPTIONS = selectableCountries()

/**
 * Keep only entries that name a country this platform recognises, in canonical spelling.
 *
 * Mirrors normaliseSeniorityBands exactly, and for the same reason: the control can no longer
 * produce anything else, so a value that is not a country arrived from a stale row or from a
 * request that did not come through the form, and neither is a reason to store something the
 * geography derivation will refuse. Deduplicated BY CODE rather than by string, so two
 * spellings of one country cannot both survive.
 *
 * DROPPING IS DELIBERATE, AND IT IS THE NARROWER HARM. Preserving an unresolvable value keeps
 * a string nothing can read and that stops a derivation; dropping it leaves the question
 * visibly unanswered, which is a state the form already knows how to show and a client can
 * fix. The one existing row holding such a value is repaired directly rather than by this
 * function, because a silent repair on read is indistinguishable from data loss.
 */
export function normaliseCountries(values: readonly string[]): string[] {
  const byCode = new Map<string, string>()
  for (const raw of values) {
    const option = findCountryOption(raw)
    if (!option) continue
    if (byCode.has(option.code)) continue
    byCode.set(option.code, option.name)
  }
  return [...byCode.values()]
}

// ─── Question wording ────────────────────────────────────────────────────────

export interface BuyerProfileQuestion {
  /** Anchors the rendered control and names the field in a test. Not a database key. */
  id: string
  label: string
  helpText?: string
}

/**
 * The wording, held as data so the form and the tests read the same strings rather than each
 * carrying their own copy of them.
 */
export const BUYER_PROFILE_QUESTIONS = {
  countries: {
    id: 'target_countries',
    label: 'Which countries should we contact people in?',
    helpText:
      'We source leads only from the countries you name here, and nowhere else. Name ' +
      'anywhere you have won work before, and anywhere you would be happy to take a ' +
      'meeting from even if you have not worked there yet.',
  },
  headcount: {
    id: 'buyer_headcount',
    label: "How many staff does your buyer's company usually have?",
    helpText: 'This is what we filter the list on. Give the real range even if it is wide.',
  },
  jobTitles: {
    id: 'buyer_job_titles',
    label: 'What job titles does your buyer hold?',
  },
  seniority: {
    id: 'buyer_seniority_bands',
    label: 'Seniority we will target',
  },
  // WHERE "WHO SHOULD WE EMAIL FIRST?" USED TO BE.
  //
  // Deleted, not reworded. It asked the same thing as the job titles question above it in
  // different words, and the first person to answer this form could not tell what it wanted.
  // Two questions competing to collect one answer get two answers that disagree, and nothing
  // downstream can tell which of them the client meant.
  //
  // What was worth keeping is the SECOND half of it, which asks something no other question
  // asks: whether the buyer can act alone. That now hangs off the buyer already described
  // rather than introducing a person of its own.
  signoffRequired: {
    id: 'signoff_required',
    label: 'Can the person you just described approve this spend on their own?',
  },
  signoffRole: {
    id: 'signoff_role',
    label: 'Whose?',
    helpText:
      'We will not email that person. It changes how the emails are written, because your ' +
      'buyer has to make the case internally.',
  },
  disqualifiers: {
    id: 'disqualifiers',
    label:
      'What would make you sit in a booked meeting and think, this was a waste of my time?',
    helpText:
      'Whatever you put here becomes a rule we apply before a name ever reaches you.',
  },
} as const satisfies Record<string, BuyerProfileQuestion>

// ─── The two sign-off answers ────────────────────────────────────────────────

/**
 * The answers to the sign-off question, each carrying the value it stores.
 *
 * ─── THE POLARITY IS INVERTED FROM THE QUESTION IT REPLACED, AND THAT IS THE POINT ───
 *
 * The old question asked whether sign-off IS needed, so "yes" meant true. This one asks
 * whether the buyer can approve ALONE, so "yes" means signoff_required is FALSE. The storage
 * did not change and deliberately was not changed: signoff_required still means what it says,
 * and every existing row still reads correctly.
 *
 * That inversion is exactly the kind of thing a component expresses as two onClick handlers
 * with a hand-written boolean in each, where getting one backwards is invisible on screen and
 * silently flips what the prompt is told about this client. So the pairing is DATA, asserted
 * in a test that names both directions, and the component reads it rather than restating it.
 */
export interface SignoffAnswer {
  label: string
  /** What selecting this answer stores in signoff_required. */
  signoffRequired: boolean
}

export const SIGNOFF_ANSWERS: readonly SignoffAnswer[] = [
  { label: 'Yes', signoffRequired: false },
  { label: "They need someone else's sign-off", signoffRequired: true },
]

// ─── The shape of a list, said out loud ──────────────────────────────────────

/**
 * The line shown above every list the client adds to.
 *
 * ─── WHY A SENTENCE AND NOT A BETTER BUTTON ──────────────────────────────────
 *
 * A single empty text box looks exactly like a box that takes the whole answer, because that
 * is what a single empty text box is everywhere else in this form. "Add another" sat BELOW it
 * and was read, reasonably, as an afterthought for people with more to say rather than as the
 * shape of the control. The first client to meet it typed three answers into the one box.
 *
 * So the shape is stated before the first row rather than implied after it, the rows are
 * numbered so that one row visibly means one answer, and the button names what it produces.
 * None of the three works alone: a number on a single row is just a decoration, and a sentence
 * above a control that still looks like a paragraph box is a sentence that loses.
 *
 * RULE ZERO: names no industry, title, sector, country or company, and gives no example of
 * what to put in a row. It describes the control, not the answer.
 */
export const LIST_INPUT_HINT = 'One per row. Add a row for each one.'

// ─── Normalisation ───────────────────────────────────────────────────────────

/**
 * Trim each entry, drop the empty ones, and remove case-insensitive duplicates while keeping
 * the client's own casing and their ordering.
 *
 * A repeater produces blank rows as a matter of course: the client adds an entry, thinks
 * better of it, and leaves it empty. Storing those makes a list whose length is not the number
 * of answers, and length is the first thing any consumer will read.
 */
export function normaliseList(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

/**
 * Keep only bands the provider will honour, in the provider's order.
 *
 * Mirrors keepHonourableBands in the handler rather than trusting whatever the browser posted.
 * A value that is not a band would be silently dropped by the provider later, and a silently
 * dropped filter is indistinguishable from one that worked.
 */
export function normaliseSeniorityBands(values: readonly unknown[]): ProviderSeniorityBand[] {
  const seen = new Set<string>()
  for (const value of values) {
    if (isProviderSeniorityBand(value)) seen.add(value)
  }
  return PROVIDER_SENIORITY_BANDS.filter(band => seen.has(band))
}

export interface HeadcountResult {
  min: number | null
  max: number | null
  error: string | null
}

/**
 * The two integers, or a reason they are not usable.
 *
 * Both empty is a valid unanswered state and not an error: this question does not gate
 * anything, so a client who skips it is not doing something wrong. Everything else the
 * database CHECK would reject is caught here first, so the client sees a sentence rather than
 * a constraint violation.
 */
export function parseHeadcount(minRaw: string, maxRaw: string): HeadcountResult {
  const min = minRaw.trim()
  const max = maxRaw.trim()

  if (!min && !max) return { min: null, max: null, error: null }
  if (!min || !max) {
    return { min: null, max: null, error: 'Give both a lower and an upper number.' }
  }

  // Reject anything that is not a plain whole number. Number() alone accepts '1e3', ' 12 '
  // and '0x10', and a headcount arriving as 4096 because someone typed hex is the kind of
  // value that is never questioned once it is in a filter.
  if (!/^\d+$/.test(min) || !/^\d+$/.test(max)) {
    return { min: null, max: null, error: 'Use whole numbers only.' }
  }

  const minN = Number(min)
  const maxN = Number(max)

  if (minN < 1) return { min: null, max: null, error: 'A company has at least one person.' }
  if (maxN < minN) {
    return { min: null, max: null, error: 'The upper number must not be below the lower one.' }
  }
  return { min: minN, max: maxN, error: null }
}
