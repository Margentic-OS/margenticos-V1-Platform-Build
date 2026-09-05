// THE CANONICAL INTAKE QUESTION SET. One list, imported by everything that needs to know
// what the form asks.
//
// It used to live inside IntakeForm.tsx, which meant the form knew the question set and
// nothing on the server did. Completeness was then computed on the server as
// "answered rows / rows that exist", and a row only exists once the client has been shown
// the question and saved an answer. So a question ADDED to the form after a client
// finished their intake was absent from the numerator AND the denominator, and that client
// stayed at 100% complete for a question they had never been asked. The agents were never
// told the question existed either, because they too only ever saw rows.
//
// That is the parallel-array shape from CLAUDE.md wearing different clothes: two lists (the
// questions the form asks, and the rows a client happens to have) that have to agree, with
// nothing keeping them in step. The fix is the same in kind: derive from ONE list. The
// denominator is now a property of this file, not of any client's data.
//
// Note this module is deliberately free of React and of `use client`, so both the client
// component and server routes can import it.

// ─── Types ───────────────────────────────────────────────────────────────────

export type FieldType = 'short' | 'long' | 'select' | 'currency'

export interface Question {
  fieldKey: string
  label: string
  helpText?: string
  isCritical: boolean
  type: FieldType
  options?: string[]
  getOptions?: (values: Record<string, string>) => string[]
  dictation?: boolean
}

export interface Section {
  id: string
  title: string
  questions: Question[]
}

// ─── Currency helpers ────────────────────────────────────────────────────────

export const CURRENCY_SYMBOLS: Record<string, string> = { GBP: '£', EUR: '€', USD: '$' }

export const revenueOptions = (values: Record<string, string>): string[] => {
  const sym = CURRENCY_SYMBOLS[values['company_currency']] ?? '£'
  return [
    `Under ${sym}100K`,
    `${sym}100K - ${sym}300K`,
    `${sym}300K - ${sym}600K`,
    `${sym}600K - ${sym}1M`,
    `${sym}1M - ${sym}2M`,
    `Over ${sym}2M`,
  ]
}

// ─── Question definitions ────────────────────────────────────────────────────

export const SECTIONS: Section[] = [
  {
    id: 'company',
    title: 'Your business',
    questions: [
      {
        fieldKey: 'company_name',
        label: "What's your company name?",
        isCritical: true,
        type: 'short',
      },
      {
        fieldKey: 'company_url',
        label: "What's your website URL?",
        isCritical: false,
        type: 'short',
      },
      {
        fieldKey: 'company_currency',
        label: 'What currency do you work in?',
        isCritical: true,
        type: 'currency',
        options: ['GBP', 'EUR', 'USD'],
      },
      {
        fieldKey: 'company_revenue_range',
        label: "What's your current annual revenue range?",
        isCritical: true,
        type: 'select',
        getOptions: revenueOptions,
      },
      {
        fieldKey: 'company_what_you_do',
        label: 'Who do you help and what problem do you solve for them?',
        isCritical: true,
        type: 'long',
        dictation: true,
      },
      {
        fieldKey: 'company_years_operating',
        label: 'How long have you been operating?',
        isCritical: true,
        type: 'short',
      },
      {
        fieldKey: 'company_differentiators',
        label: "What makes your firm genuinely different from others who do what you do? Not the marketing answer. The real one.",
        isCritical: true,
        type: 'long',
        dictation: true,
      },
    ],
  },
  {
    id: 'clients',
    title: 'Your clients',
    questions: [
      {
        fieldKey: 'clients_clone',
        label: "Think about your single best client, the one you'd clone if you could. Describe them. Not their job title. What makes them different to work with? What do they believe or understand that most of your clients don't?",
        isCritical: true,
        type: 'long',
        dictation: true,
      },
      {
        fieldKey: 'clients_trigger',
        label: "When your best clients first came to you, what was happening in their business? What had changed, broken, or become urgent enough that they finally did something?",
        isCritical: true,
        type: 'long',
        dictation: true,
      },
      {
        fieldKey: 'clients_how_found',
        label: "Walk me through how your last best client found you. Start from the beginning — how did they first become aware you existed?",
        isCritical: true,
        type: 'long',
        dictation: true,
      },
      {
        fieldKey: 'clients_what_tipped',
        label: "What do you think actually tipped them toward working with you? Not the polished answer. The real one. Was there a specific conversation, a moment, something you said or showed them?",
        isCritical: true,
        type: 'long',
        dictation: true,
      },
      {
        fieldKey: 'clients_channel',
        label: "Do your best clients typically come from referrals, inbound, or outbound? What does that usually look like in practice?",
        isCritical: true,
        type: 'long',
      },
    ],
  },
  {
    id: 'offer',
    title: 'Your offer',
    questions: [
      {
        fieldKey: 'offer_structure',
        label: "How does your service actually work? What does a client buy and what does the engagement look like?",
        isCritical: true,
        type: 'long',
      },
      {
        fieldKey: 'offer_price',
        label: "What's the price point or range for your core offer?",
        isCritical: true,
        type: 'short',
      },
      {
        fieldKey: 'offer_length',
        label: 'How long does a typical engagement last?',
        isCritical: true,
        type: 'short',
      },
      {
        fieldKey: 'offer_deliverables',
        label: "What does a client actually get? Deliverables, outputs, access — what exists at the end that didn't before?",
        isCritical: true,
        type: 'long',
        dictation: true,
      },
    ],
  },
  {
    id: 'voice',
    title: 'Your voice',
    questions: [
      {
        fieldKey: 'voice_style',
        label: 'How would you describe your communication style in your own words?',
        isCritical: false,
        type: 'long',
      },
      {
        fieldKey: 'voice_dislikes',
        label: "Is there anything you hate seeing in business communication? Phrases, styles, tones that make you cringe.",
        isCritical: false,
        type: 'long',
      },
    ],
  },
  {
    id: 'assets',
    title: 'Existing assets',
    questions: [
      {
        fieldKey: 'assets_existing_positioning',
        label: "Is there any positioning or messaging you currently use that you'd like us to know about? Could be a tagline, an about page, a pitch you've used.",
        isCritical: false,
        type: 'long',
      },
      {
        fieldKey: 'assets_past_outreach',
        label: "Have you tried outbound before? What worked and what didn't? Even partial attempts count.",
        isCritical: false,
        type: 'long',
      },
    ],
  },
]

export const ALL_QUESTIONS = SECTIONS.flatMap(s => s.questions)
export const CRITICAL_COUNT = ALL_QUESTIONS.filter(q => q.isCritical).length // 15 (voice_samples removed — file upload is canonical)
export const THRESHOLD = Math.ceil(CRITICAL_COUNT * 0.8) // 12

export const CRITICAL_QUESTIONS = ALL_QUESTIONS.filter(q => q.isCritical)

export const SECTION_BY_FIELD_KEY: Record<string, string> = Object.fromEntries(
  SECTIONS.flatMap(s => s.questions.map(q => [q.fieldKey, s.id])),
)

// ─── Answers the form stores that are NOT questions in SECTIONS ───────────────
//
// SECTIONS is not the whole of what the form asks, and anything treating it as such is
// wrong in a way that is invisible. The voice section offers upload-or-paste as a tabbed
// control hand-written in IntakeForm; the paste tab stores a real answer under the key
// below, and it appears in no section.
//
// IT MUST NOT BE MOVED INTO SECTIONS. IntakeForm builds its inputs by mapping over
// SECTIONS, so a question added there would render a SECOND input for a field that
// already has one. The field is unregistered by necessity, not by oversight.
//
// Declared here so the two directions of checking can both see it: mergeIntakeWithQuestions
// carries it to the agents through its retired branch, and document-staleness can map it
// without its own guard reading it as a typo. A key in neither this list nor SECTIONS is
// still a typo and still throws.
export const TYPED_VOICE_SAMPLES_FIELD_KEY = 'voice_typed_samples'

export const UNREGISTERED_FORM_FIELD_KEYS: readonly string[] = [
  TYPED_VOICE_SAMPLES_FIELD_KEY,
]

// ─── Server-side shapes ───────────────────────────────────────────────────────

// The subset of an intake_responses row this module reasons about. Deliberately narrow so
// callers can pass their own wider row type without a cast.
export interface StoredIntakeRow {
  field_key: string
  field_label?: string | null
  response_value: string | null
  section?: string | null
  is_critical?: boolean | null
}

export interface MergedIntakeRow {
  field_key: string
  field_label: string
  response_value: string | null
  section: string
  is_critical: boolean
  /** True when the form asks this question and the client has no row for it at all. */
  never_presented: boolean
}

const answered = (v: string | null | undefined): boolean => (v ?? '').trim().length > 0

/**
 * Completeness over the questions the FORM ASKS, not over the rows a client happens to have.
 *
 * `critical` is a constant (the number of critical questions in this file), so adding a
 * question lowers every existing client's completeness immediately, which is the whole point:
 * it is how an unanswered new question becomes visible instead of silently reading as 100%.
 */
export function criticalCompleteness(rows: StoredIntakeRow[]): {
  answered: number
  critical: number
  ratio: number
} {
  const byKey = new Map(rows.map(r => [r.field_key, r]))
  const answeredCount = CRITICAL_QUESTIONS.filter(q => answered(byKey.get(q.fieldKey)?.response_value)).length
  return {
    answered: answeredCount,
    critical: CRITICAL_QUESTIONS.length,
    ratio: CRITICAL_QUESTIONS.length > 0 ? answeredCount / CRITICAL_QUESTIONS.length : 0,
  }
}

/**
 * Every question the form asks, each carrying whatever the client stored for it, PLUS any
 * stored row for a question the form no longer asks.
 *
 * Both halves matter. The first is what makes an unasked question visible to an agent: a
 * question with no row becomes a row with a null answer, so the existing
 * "CRITICAL — NOT ANSWERED" marker fires on it the same way it fires on a blank answer.
 * The second is what stops this merge DELETING data: questions get retired from the form
 * while their answers stay in the table, and those answers are still the client's own words.
 * Dropping them here would quietly shrink what every agent is given.
 */
export function mergeIntakeWithQuestions(rows: StoredIntakeRow[]): MergedIntakeRow[] {
  const byKey = new Map(rows.map(r => [r.field_key, r]))

  const asked: MergedIntakeRow[] = ALL_QUESTIONS.map(q => {
    const row = byKey.get(q.fieldKey)
    return {
      field_key: q.fieldKey,
      // The form's current wording wins: if a question was reworded, the stored label is
      // the old question, and showing an agent the old wording beside a new answer misleads.
      field_label: q.label,
      response_value: row?.response_value ?? null,
      section: SECTION_BY_FIELD_KEY[q.fieldKey] ?? '',
      is_critical: q.isCritical,
      never_presented: row === undefined,
    }
  })

  const retired: MergedIntakeRow[] = rows
    .filter(r => !(r.field_key in SECTION_BY_FIELD_KEY))
    .filter(r => answered(r.response_value))
    .map(r => ({
      field_key: r.field_key,
      field_label: r.field_label ?? r.field_key,
      response_value: r.response_value,
      section: r.section ?? 'other',
      // A retired question cannot be a gate on completeness, so it never carries the flag.
      is_critical: false,
      never_presented: false,
    }))

  return [...asked, ...retired]
}

// ─── Revenue range reconciliation ─────────────────────────────────────────────
//
// The revenue options are built from the chosen currency, so changing the currency replaces
// every option string. A stored answer carrying the old symbol then matches no option, and a
// <select> whose value matches no option shows the placeholder. The client saw "Select one",
// the row still held the old answer, and nothing reconciled the two: the form looked
// unanswered while the agents were handed a revenue band in a currency the client no longer
// uses.
//
// The bands are positionally identical across currencies (only the symbol differs), so the
// band a client picked survives a currency change and only the symbol needs replacing.

const REVENUE_BAND_COUNT = revenueOptions({}).length

// Dash variants and spacing differ between what the form offered at the time and what is
// stored, so compare on a normalised form. A stored "£600K–£1M" (en dash, no spaces) is the
// same answer as the option "£600K - £1M" and must not be thrown away as unrecognisable.
const normaliseBand = (s: string): string =>
  s.toLowerCase().replace(/[‐-―-]/g, '-').replace(/\s+/g, '')

/**
 * The revenue answer to store once the currency becomes `nextCurrency`.
 *
 * Returns the same band re-symbolised where the stored answer is recognisable as one of the
 * bands under ANY supported currency, and '' where it is not. Never returns the stored value
 * unchanged: leaving it is what produced a row whose symbol contradicted the currency field.
 */
export function reconcileRevenueRange(storedValue: string, nextCurrency: string): string {
  const stored = normaliseBand(storedValue ?? '')
  if (!stored) return ''

  const next = revenueOptions({ company_currency: nextCurrency })

  for (const currency of Object.keys(CURRENCY_SYMBOLS)) {
    const index = revenueOptions({ company_currency: currency }).findIndex(
      opt => normaliseBand(opt) === stored,
    )
    if (index >= 0) return next[index] ?? ''
  }

  // Not a band this form has ever offered under any currency. Clearing is the honest result:
  // the client is asked again rather than being left with an answer the form cannot display.
  return ''
}

// Guards the assumption above that every currency yields the same number of bands, so a
// future edit adding a band to one currency and not another cannot silently drop answers.
if (
  Object.keys(CURRENCY_SYMBOLS).some(
    c => revenueOptions({ company_currency: c }).length !== REVENUE_BAND_COUNT,
  )
) {
  throw new Error('intake questions: revenue band count differs between currencies')
}

// The two field keys the reconciliation above binds together, named once so the component
// does not carry string literals that could drift from this file's question definitions.
export const CURRENCY_FIELD_KEY = 'company_currency'
export const REVENUE_FIELD_KEY = 'company_revenue_range'

// Fail at import time if either key stops existing in the question set.
for (const key of [CURRENCY_FIELD_KEY, REVENUE_FIELD_KEY]) {
  if (!(key in SECTION_BY_FIELD_KEY)) {
    throw new Error(`intake questions: expected question "${key}" to exist`)
  }
}
