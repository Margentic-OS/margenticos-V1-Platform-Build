// Which strategy documents an intake answer feeds, and how a changed answer is recorded.
//
// SCOPE. This is the deliberately small first cut. It marks a document stale and stops there:
// nothing regenerates, nothing is republished, no client is emailed. Replacing approved copy
// with something the client has not seen is the failure this must not cause, so the flag is
// a signal to a human and never an action.
//
// THE MAP IS HARDCODED AND INCOMPLETE ON PURPOSE. It covers the answers whose meaning is
// unambiguous. Answers that plausibly feed several documents are LEFT OUT rather than guessed
// at, because a false stale flag trains the operator to ignore the flag, and an ignored flag
// is worse than no flag. Every omission is listed in NOT_MAPPED below with the reason, so the
// gap is visible instead of looking like completeness.
//
// This is field -> document. It is NOT the same thing as document -> document, which already
// exists in cascade/document-dependencies.ts and is applied by promote_strategy_doc_version.
// The two compose: an intake edit flags the documents named here, and if one of those is later
// regenerated and promoted, the existing SQL flags whatever is built from it.
//
// RULE ZERO: nothing here names an industry, sector, country, company or job title.

import type { StrategyDocType } from '@/lib/agents/cascade/document-dependencies'
import { SECTION_BY_FIELD_KEY } from '@/lib/intake/questions'

/**
 * Documents built directly from a given intake answer.
 *
 * Direct only. Downstream propagation is the SQL function's job, not this map's, and
 * duplicating it here would be a second copy of the dependency graph.
 */
export const DOCUMENTS_FED_BY_FIELD: Readonly<Record<string, readonly StrategyDocType[]>> = {
  // Who the client serves and what problem they solve: the prospect profile is built on it.
  company_what_you_do: ['icp'],
  clients_clone: ['icp'],
  clients_trigger: ['icp'],

  // How the client sounds. The voice guide is derived from how they write, nothing else.
  voice_style: ['tov'],
  voice_dislikes: ['tov'],

  // What the client sells and what makes them different: positioning rests on these.
  company_differentiators: ['positioning'],
  offer_deliverables: ['positioning'],
  offer_structure: ['positioning'],
}

/**
 * Answers deliberately NOT mapped, and why. Prose, so the reason survives the next reader.
 *
 * Listed as data rather than a comment so the test below can assert that every question the
 * form asks is either mapped or explicitly excused, which is what stops a NEW question being
 * silently unmapped.
 */
export const NOT_MAPPED: Readonly<Record<string, string>> = {
  company_name: 'Renders into documents but changes no reasoning in them.',
  company_url: 'Feeds website fetching, not document content directly.',
  company_currency: 'A display unit. Changing it does not change what any document argues.',
  company_revenue_range:
    "The client's own revenue. It anchors nothing in the prospect profile by design, so a " +
    'change to it should not flag that document. Mapping it would re-assert the link the ' +
    'prompt was just corrected to deny.',
  company_years_operating: 'Context for the agents, not a premise any document is built on.',
  clients_how_found: 'Channel history. Informs campaign choices rather than document content.',
  clients_what_tipped: 'Feeds messaging indirectly via positioning; too diffuse to flag cleanly.',
  clients_channel: 'As clients_how_found.',
  offer_price: 'Carried verbatim into client_pricing. A price change does not invalidate an argument.',
  offer_length: 'Engagement duration. No document reasons from it today.',
  assets_existing_positioning: 'Reference material the agent may or may not have drawn on.',
  assets_past_outreach: 'Reference material, as above.',
}

/**
 * Whether this save is an EDIT to an existing answer, as opposed to a first answer or a
 * no-op re-save.
 *
 * Extracted from the server action so it can be mutation-tested. Inline it was untestable,
 * and replacing it with `true` passed the whole suite while flagging documents on every
 * blur, because the form saves whether or not anything was typed.
 *
 * @param previous the stored answer, or null when no row existed
 *
 * A first answer returns false: no document was built without it, so nothing it feeds can
 * have been written on a different premise. Compared on trimmed values, because whitespace
 * is not a change of meaning and the stored value is trimmed for word counting anyway.
 */
export function isIntakeAnswerEdit(previous: string | null, next: string): boolean {
  if (previous === null) return false
  return previous.trim() !== next.trim()
}

/** Documents to flag when `fieldKey` changes. Empty for anything unmapped. */
export function documentsAffectedBy(fieldKey: string): readonly StrategyDocType[] {
  return DOCUMENTS_FED_BY_FIELD[fieldKey] ?? []
}

/**
 * The stale_reason value written when an intake answer changes.
 *
 * Prefixed and machine-readable so stale-documents.ts can tell this cause apart from the
 * document-to-document one, which writes NULL.
 */
export const INTAKE_STALE_PREFIX = 'intake_answer_changed:'

export function intakeStaleReason(fieldKey: string): string {
  return `${INTAKE_STALE_PREFIX}${fieldKey}`
}

export function isIntakeStaleReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(INTAKE_STALE_PREFIX)
}

// Every mapped and excused key must be a question the form actually asks. A key that is
// neither is a typo or a retired question, and both would silently never fire.
for (const key of [...Object.keys(DOCUMENTS_FED_BY_FIELD), ...Object.keys(NOT_MAPPED)]) {
  if (!(key in SECTION_BY_FIELD_KEY)) {
    throw new Error(`document-staleness: "${key}" is not a question the intake form asks`)
  }
}
