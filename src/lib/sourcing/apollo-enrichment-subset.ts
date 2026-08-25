// What we keep from an Apollo bulk_match response, and what we refuse to keep.
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS IS A DATA MINIMISATION BOUNDARY, NOT A CONVENIENCE MAPPER
//
// bulk_match returns 33 top-level fields and 39 organization fields. We parsed 13 of
// those 72 and discarded the rest, including employment_history, which produces 38 of
// research's 40 Apollo wins. So research bought the same person again to get it.
//
// The obvious fix is to store the whole payload. WE DO NOT, and the reason is not
// tidiness. The payload carries street_address, raw_address, postal_code, city, state,
// formatted_address, phone, photo_url, and personal facebook/twitter/github URLs, plus an
// emails array inside every employment_history entry. Those are home addresses and
// personal phone numbers for people who have never heard of us.
//
// We email the UK and Ireland. UK GDPR data minimisation requires keeping what the
// purpose needs, not everything the vendor returns, and a prospect's home address is not
// defensible for sending a cold email.
//
// So this module is an ALLOW-LIST, never a denylist-filtered copy. A field Apollo adds
// tomorrow is dropped by default rather than silently stored, which is the only safe
// direction for a boundary like this.
//
// COUNTRY IS NOT IN HERE ON PURPOSE. It is written as a first-class column so a
// jurisdiction gate can query it directly rather than digging through jsonb. See
// adapter-apollo-enrichment.

/** Person-level fields we keep. Anything not listed is dropped. */
export const APOLLO_PERSON_KEEP = [
  'employment_history',   // sanitised per entry, see below
  'seniority',
  'departments',
  'subdepartments',
  'functions',
  'headline',
  'organization_id',
] as const

/** Organization-level fields we keep. Anything not listed is dropped. */
export const APOLLO_ORG_KEEP = [
  'organization_headcount_six_month_growth',
  'organization_headcount_twelve_month_growth',
  'organization_headcount_twenty_four_month_growth',
  'founded_year',
  'organization_revenue',
  'industries',
  'secondary_industries',
  'naics_codes',
  'sic_codes',
  'keywords',
  'linkedin_uid',
  'linkedin_url',
  'website_url',
  'id',
] as const

/**
 * Fields that must NEVER appear in stored enrichment data, at any nesting level.
 *
 * Enforced by assertNoForbiddenFields below and asserted in tests. This list exists so
 * the prohibition is executable rather than a comment someone can miss: an allow-list
 * protects against fields we forgot, and this protects against an allow-list edited
 * carelessly.
 */
export const APOLLO_FORBIDDEN_FIELDS = [
  'street_address',
  'raw_address',
  'postal_code',
  'city',
  'state',
  'formatted_address',
  'phone',
  'photo_url',
  'facebook_url',
  'twitter_url',
  'github_url',
  'personal_emails',
  'emails',
] as const

/** Per-entry employment_history fields we keep. `emails` and `raw_address` are dropped. */
export const APOLLO_EMPLOYMENT_KEEP = [
  'title',
  'organization_name',
  'organization_id',
  'start_date',
  'end_date',
  'current',
  'description',
  'kind',
] as const

type Rec = Record<string, unknown>

function pick(source: Rec | null | undefined, keys: readonly string[]): Rec {
  if (!source || typeof source !== 'object') return {}
  const out: Rec = {}
  for (const k of keys) {
    if (k in source && source[k] !== undefined) out[k] = source[k]
  }
  return out
}

/**
 * Reduce a bulk_match person object to the fields we are allowed to keep.
 *
 * Returns null when nothing survives, so an empty object is never stored as if it were
 * data. Never throws: this runs after the credit is spent, and an exception here would
 * abort a batch at the point the caller is trying to record what it bought.
 */
export function buildApolloEnrichmentSubset(match: Rec | null | undefined): Rec | null {
  try {
    if (!match || typeof match !== 'object') return null

    const person = pick(match, APOLLO_PERSON_KEEP)

    // employment_history is the field this whole change exists for, and it is also the
    // one carrying nested personal data. Each entry is rebuilt from the allow-list rather
    // than copied and stripped, so a new nested field cannot ride along.
    if (Array.isArray(match.employment_history)) {
      person.employment_history = (match.employment_history as Rec[])
        .filter(e => e && typeof e === 'object')
        .map(e => pick(e, APOLLO_EMPLOYMENT_KEEP))
    } else {
      delete person.employment_history
    }

    const org = pick(match.organization as Rec | undefined, APOLLO_ORG_KEEP)
    if (Object.keys(org).length > 0) person.organization = org

    if (Object.keys(person).length === 0) return null

    // Belt and braces. The allow-lists should make this unreachable; if it ever fires,
    // an allow-list has been edited to include something it must not.
    assertNoForbiddenFields(person)
    return person
  } catch {
    // A subset we cannot build safely is not stored. Losing the enrichment detail is
    // recoverable; storing a home address is not.
    return null
  }
}

/**
 * Throw if any forbidden field name appears anywhere in the structure.
 *
 * Recursive, because the risk is nested: employment_history entries carry `emails`, and
 * an organization object could carry `street_address`.
 */
export function assertNoForbiddenFields(value: unknown, path = 'root'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoForbiddenFields(v, `${path}[${i}]`))
    return
  }
  if (!value || typeof value !== 'object') return

  for (const [key, child] of Object.entries(value as Rec)) {
    if ((APOLLO_FORBIDDEN_FIELDS as readonly string[]).includes(key)) {
      throw new Error(
        `Forbidden field "${key}" at ${path}.${key} in Apollo enrichment data. ` +
        'This field carries personal data we have no purpose for and must never be stored.',
      )
    }
    assertNoForbiddenFields(child, `${path}.${key}`)
  }
}
