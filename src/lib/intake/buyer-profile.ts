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

// ─── The typed row ───────────────────────────────────────────────────────────

/**
 * One organisation's answers, in the shape a consumer reads them.
 *
 * Two integers and three string arrays, matching the columns one for one. Nothing here is
 * encoded into text and nothing needs parsing, which is the entire reason this is a table of
 * its own rather than rows in the EAV store.
 */
export interface BuyerProfile {
  /** Q1. One country per entry, the client's own wording, in the order they added them. */
  target_countries: string[]
  /** Q2. Both set or both null. The database CHECK forbids answering only half of it. */
  buyer_headcount_min: number | null
  buyer_headcount_max: number | null
  /** Q3. One title per entry. */
  buyer_job_titles: string[]
  /** Q3, second half. Provider tokens, validated against the one list of them. */
  buyer_seniority_bands: ProviderSeniorityBand[]
  /** Q4. Who receives the email. */
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
  firstContact: {
    id: 'first_contact_role',
    label: 'Who should we email first?',
    helpText: 'This is who receives the email. Not necessarily who signs the cheque.',
  },
  signoffRequired: {
    id: 'signoff_required',
    label: "Does that person need someone else's sign-off to buy?",
  },
  signoffRole: {
    id: 'signoff_role',
    label: 'Who?',
    helpText:
      'We will not email them. Knowing they exist changes how the emails are written, ' +
      'because your buyer has to sell it internally.',
  },
  disqualifiers: {
    id: 'disqualifiers',
    label: 'Who fits everything above and you would still turn away?',
    helpText:
      'For example: already has someone doing this, in a sector you avoid, at a stage ' +
      'where they will not buy, or anyone at a competitor. These become rules we apply ' +
      'before you ever see the name.',
  },
} as const satisfies Record<string, BuyerProfileQuestion>

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
