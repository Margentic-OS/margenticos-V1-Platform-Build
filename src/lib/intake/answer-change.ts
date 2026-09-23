// One changed intake answer, in the shape the operator notification renders.
//
// ─── WHY THIS IS NOT IN EITHER SERVER ACTION ─────────────────────────────────
//
// Two save paths produce the same event. saveIntakeResponse already holds a field key, a
// label and two strings, so it needs almost nothing. saveBuyerProfile holds two typed
// BuyerProfile objects and a list of keys, and turning those into "from what to what"
// needs a formatter. Writing that formatter inside the action would put the rendering rules
// in one of the two callers and leave the other free to disagree with it, which is the
// parallel-code shape flag-stale-documents.ts was extracted to end.
//
// ─── THE RENDERING RULE THAT IS LOAD-BEARING ─────────────────────────────────
//
// NOTHING HERE MAY EVER EMIT THE LITERAL WORDS "null", "undefined" OR "NaN".
//
// That is not a style preference. validateEmailContent in src/lib/email/send.ts REFUSES any
// email containing those tokens, for operator mail as much as customer mail, because they
// are how a template handed a missing variable announces itself. The rendering checks are
// the half of that validator the operator audience is deliberately NOT exempt from.
//
// BuyerProfile is full of real nulls that are not bugs: buyer_headcount_min is null until
// answered, and signoff_required is `boolean | null` where null means "not answered" and is
// a different state from false. String(null) is "null", so the obvious formatter would
// produce an email the validator throws away, and the operator would never learn that a
// client had changed an answer. Every null is therefore spelled out in words below.
//
// KNOWN LIMIT, recorded rather than papered over: a client whose own free-text answer
// contains the word "null", "undefined" or "NaN" still produces an email the validator
// refuses. It fails CLOSED and LOUDLY. The send is recorded in email_delivery_failures and
// MON-030 reads that table on every sweep, and the document flagging has already happened by
// then, so the flag is not lost with the mail. Neutralising the client's own words inside a
// quote would be worse: it would make the operator read something the client did not write.

import type { BuyerProfile } from '@/lib/intake/buyer-profile'
import { BUYER_PROFILE_FIELD_KEYS } from '@/lib/intake/buyer-profile'
import { buyerProfileToRow } from '@/lib/intake/buyer-profile-store'

/** One answer that moved, already rendered for a human. */
export interface IntakeAnswerChange {
  /** The stored key. Carried for the log line, never shown in the email. */
  fieldKey: string
  /** What the client was asked, in words. */
  fieldLabel: string
  /** What the answer was before this save. Never the empty string. */
  previous: string
  /** What it is now. Never the empty string. */
  next: string
}

/**
 * The longest a quoted answer may be in the notification.
 *
 * The email exists to tell the operator WHAT MOVED, not to reproduce the document. Two long
 * answers at full length make a mail nobody reads, and the operator has a link to the real
 * thing. Truncation is marked so a reader can never mistake a cut answer for a short one.
 */
export const ANSWER_EXCERPT_LIMIT = 300

/** What an answer with no content is called, so the email never renders an empty quote. */
export const BLANK_ANSWER = '(blank)'

/** What an unanswered typed field is called. Never the word null. See the header. */
export const UNANSWERED = '(not answered)'

/**
 * A free-text answer as the email should show it.
 *
 * Trimmed, because the stored value is trimmed for word counting anyway and leading
 * whitespace is not a change a human should be asked to read.
 */
export function renderAnswerValue(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return BLANK_ANSWER
  if (trimmed.length <= ANSWER_EXCERPT_LIMIT) return trimmed
  return `${trimmed.slice(0, ANSWER_EXCERPT_LIMIT)}... (truncated)`
}

/**
 * One buyer-profile column as the email should show it.
 *
 * Takes `unknown` on purpose. The values come from buyerProfileToRow, whose return type is
 * Record<string, unknown>, and a per-key switch would be a second list to keep in step with
 * BuyerProfile. Handling the four shapes the table actually holds covers every column, and a
 * column of a NEW shape falls through to UNANSWERED rather than to String(value), which is
 * the safe direction: a vague email beats one the validator refuses.
 */
export function renderBuyerProfileValue(value: unknown): string {
  if (value === null || value === undefined) return UNANSWERED
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    return items.length > 0 ? renderAnswerValue(items.join(', ')) : '(none)'
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : UNANSWERED
  if (typeof value === 'string') return renderAnswerValue(value)
  return UNANSWERED
}

/**
 * Operator-facing names for the buyer-targeting columns.
 *
 * SHORT, and deliberately not the question wording in BUYER_PROFILE_QUESTIONS. Those are the
 * sentences a client reads in a form, one of which is the single word "Whose?", which names
 * nothing on its own in a list of changes. This map is also keyed by COLUMN, and the form's
 * questions are not: one question collects both halves of the headcount range, and
 * first_contact_role has no question at all any more.
 *
 * RULE ZERO: no label here names an industry, a job title, a country, a sector or a company.
 */
export const BUYER_PROFILE_FIELD_LABELS: Record<keyof BuyerProfile, string> = {
  target_countries: 'Countries we may contact people in',
  buyer_headcount_min: 'Buyer company size, lower bound',
  buyer_headcount_max: 'Buyer company size, upper bound',
  buyer_job_titles: 'Job titles the buyer holds',
  buyer_seniority_bands: 'Seniority we target',
  // The question that wrote this was deleted, and the column was not. A stored value can
  // still move through a round trip of the form, so it can still appear here, and an
  // operator seeing it should know why it is not on the form they are looking at.
  first_contact_role: 'First contact role (question retired)',
  signoff_required: 'Buyer can approve the spend alone',
  signoff_role: 'Whose sign-off is needed',
  disqualifiers: 'What would make a booked meeting a waste of time',
}

/**
 * The changed buyer-profile answers, rendered.
 *
 * @param changedFieldKeys what changedBuyerProfileFields returned. Passed in rather than
 *        recomputed so the email and the staleness flagging can never disagree about which
 *        answers moved: there is one comparison, and both consume its result.
 *
 * Reads the NORMALISED values, via buyerProfileToRow, because that is what the comparison
 * ran on. Rendering the raw submission instead would let the email show "from X to X" for a
 * change that was real only before normalisation, and hide one that was real only after it.
 */
export function buyerProfileAnswerChanges(
  previous: BuyerProfile,
  next: BuyerProfile,
  changedFieldKeys: readonly string[],
): IntakeAnswerChange[] {
  const before = buyerProfileToRow(previous)
  const after = buyerProfileToRow(next)

  return changedFieldKeys.map(key => ({
    fieldKey: key,
    fieldLabel: BUYER_PROFILE_FIELD_LABELS[key as keyof BuyerProfile] ?? key,
    previous: renderBuyerProfileValue(before[key]),
    next: renderBuyerProfileValue(after[key]),
  }))
}

// Every column BuyerProfile declares must have a label here. A column added to the interface
// without one would otherwise fall through to its raw database key in an email, which is the
// silent-drift shape BUYER_PROFILE_FIELD_KEYS is itself derived to prevent one level up.
for (const key of BUYER_PROFILE_FIELD_KEYS) {
  if (!BUYER_PROFILE_FIELD_LABELS[key]) {
    throw new Error(`answer-change: buyer-profile column "${key}" has no operator label`)
  }
}
