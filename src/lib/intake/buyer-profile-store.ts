// Reading and writing one organisation's buyer-targeting answers.
//
// Separated from the server action so the mapping between a database row and BuyerProfile can
// be tested without a Next.js request context. The action is a thin auth wrapper around this.
//
// WHY A COERCION LAYER AT ALL, when the columns are already typed. Because the row arrives
// from PostgREST as JSON, and a column that is NULL in the database or absent from the select
// arrives as null or undefined either way. Reading `row.target_countries.length` on a row that
// predates a column, or on a select that forgot it, is a runtime crash in a form. Coercing
// once here means every caller gets a complete BuyerProfile and no caller writes `?? []`.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  EMPTY_BUYER_PROFILE,
  normaliseCountries,
  normaliseList,
  normaliseSeniorityBands,
  type BuyerProfile,
} from '@/lib/intake/buyer-profile'

export const BUYER_PROFILE_TABLE = 'intake_buyer_profile'

/** Every column a read needs. Named once so a read cannot ask for a subset by accident. */
export const BUYER_PROFILE_COLUMNS =
  'target_countries, buyer_headcount_min, buyer_headcount_max, buyer_job_titles, ' +
  'buyer_seniority_bands, first_contact_role, signoff_required, signoff_role, disqualifiers'

/** A string array from whatever PostgREST returned, including null and a non-array. */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

/** An integer, or null for anything that is not one. Never NaN: NaN in a filter is silent. */
function integerOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  return null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * A database row as a complete BuyerProfile.
 *
 * Exported so the shape can be tested against a literal row without a database.
 */
export function rowToBuyerProfile(row: Record<string, unknown> | null | undefined): BuyerProfile {
  if (!row) return { ...EMPTY_BUYER_PROFILE }
  return {
    // DELIBERATELY NOT filtered against the country list on the way out, unlike the bands
    // below. A stored value that is not a country is one a client typed before this question
    // became a closed list, and hiding it on read would show them an unanswered question they
    // are certain they answered. Rendering it as a chip they can remove is the honest version,
    // and the write path stops it being stored again.
    target_countries: stringArray(row.target_countries),
    buyer_headcount_min: integerOrNull(row.buyer_headcount_min),
    buyer_headcount_max: integerOrNull(row.buyer_headcount_max),
    buyer_job_titles: stringArray(row.buyer_job_titles),
    // Validated against the provider's list on the way OUT as well as in. A band that stopped
    // being one since it was stored would otherwise reach a caller that assumes the type.
    buyer_seniority_bands: normaliseSeniorityBands(stringArray(row.buyer_seniority_bands)),
    first_contact_role: text(row.first_contact_role),
    signoff_required: typeof row.signoff_required === 'boolean' ? row.signoff_required : null,
    signoff_role: text(row.signoff_role),
    disqualifiers: stringArray(row.disqualifiers),
  }
}

/**
 * What gets written, given what the form submitted.
 *
 * Free-text lists are trimmed and deduplicated, countries are filtered to ones this platform
 * recognises, bands are filtered to ones the provider honours, and signoff_role is CLEARED when
 * sign-off is not required: leaving it would store an answer to a question the client has since
 * said does not apply, and a later reader cannot tell a stale answer from a current one.
 */
export function buyerProfileToRow(profile: BuyerProfile): Record<string, unknown> {
  const signoffRequired = profile.signoff_required
  return {
    // Countries are validated against the closed list, NOT merely trimmed. The control cannot
    // produce anything else, so this is the layer that holds when the request did not come
    // through the control: a server action is a public entry point and a browser is not the
    // only thing that can reach one. Same shape as the seniority bands on the line below.
    target_countries: normaliseCountries(profile.target_countries),
    buyer_headcount_min: profile.buyer_headcount_min,
    buyer_headcount_max: profile.buyer_headcount_max,
    buyer_job_titles: normaliseList(profile.buyer_job_titles),
    buyer_seniority_bands: normaliseSeniorityBands(profile.buyer_seniority_bands),
    first_contact_role: profile.first_contact_role.trim(),
    signoff_required: signoffRequired,
    signoff_role: signoffRequired === true ? profile.signoff_role.trim() : '',
    disqualifiers: normaliseList(profile.disqualifiers),
  }
}

/**
 * The fields whose stored value differs from the submitted one.
 *
 * Feeds the staleness flagging, which needs to know WHICH answer changed. Compared on the
 * normalised values, so re-saving the same list in the same order is not an edit. Arrays are
 * compared element by element rather than by reference.
 *
 * @param previous the stored answers, or NULL when this organisation has no row yet.
 *
 * Null returns nothing, deliberately, and this mirrors isIntakeAnswerEdit on the other intake
 * path: a FIRST answer is not an edit. No document was built without it, so nothing it feeds
 * can have been written on a different premise, and flagging one would send an operator to
 * regenerate a document on the strength of an answer that never had an older value. A false
 * flag teaches an operator to ignore flags, which costs more than the flag is worth.
 *
 * Passing EMPTY_BUYER_PROFILE instead of null reinstates exactly that bug, because an absent
 * row and a row of blank answers are then indistinguishable.
 */
export function changedBuyerProfileFields(
  previous: BuyerProfile | null,
  next: BuyerProfile,
): string[] {
  if (previous === null) return []

  const before = buyerProfileToRow(previous)
  const after = buyerProfileToRow(next)
  return Object.keys(after).filter(key => {
    const a = before[key]
    const b = after[key]
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length !== b.length || a.some((v, i) => v !== b[i])
    }
    return a !== b
  })
}

type AnyClient = Pick<SupabaseClient, 'from'>

/**
 * One organisation's answers, or NULL when they have no row at all.
 *
 * THE NULL IS THE POINT, and it is why this exists alongside readBuyerProfile. "No row" and
 * "a row of blank answers" are different states, and only the caller comparing an old value
 * with a new one cares about the difference. Collapsing them is what made a client's first
 * save flag their live documents. See changedBuyerProfileFields.
 *
 * ALWAYS FILTERED BY organisation_id even though RLS also constrains it. Agent isolation is
 * enforced at three levels and the application filter is one of them.
 */
export async function readBuyerProfileRow(
  client: AnyClient,
  organisationId: string,
): Promise<BuyerProfile | null> {
  const { data } = await (client
    .from(BUYER_PROFILE_TABLE) as unknown as {
      select: (cols: string) => {
        eq: (col: string, val: string) => {
          maybeSingle: () => Promise<{ data: Record<string, unknown> | null }>
        }
      }
    })
    .select(BUYER_PROFILE_COLUMNS)
    .eq('organisation_id', organisationId)
    .maybeSingle()

  return data ? rowToBuyerProfile(data) : null
}

/**
 * One organisation's answers, or an empty profile when they have none.
 *
 * What the FORM wants: it renders a control per field and has no use for the distinction
 * above. Anything deciding whether an answer changed wants readBuyerProfileRow instead.
 */
export async function readBuyerProfile(
  client: AnyClient,
  organisationId: string,
): Promise<BuyerProfile> {
  return (await readBuyerProfileRow(client, organisationId)) ?? { ...EMPTY_BUYER_PROFILE }
}

/**
 * Write the whole row.
 *
 * Upsert on organisation_id, which is the primary key, so a client saving for the first time
 * and a client editing take the same path.
 */
export async function writeBuyerProfile(
  client: AnyClient,
  organisationId: string,
  profile: BuyerProfile,
): Promise<{ error: unknown }> {
  const { error } = await (client
    .from(BUYER_PROFILE_TABLE) as unknown as {
      upsert: (
        values: Record<string, unknown>,
        options: { onConflict: string },
      ) => Promise<{ error: unknown }>
    })
    .upsert(
      { organisation_id: organisationId, ...buyerProfileToRow(profile) },
      { onConflict: 'organisation_id' },
    )

  return { error }
}
