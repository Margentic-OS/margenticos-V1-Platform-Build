/**
 * Field ownership enforcement for prospect enrichment.
 *
 * Enrichment handlers return data for multiple field categories.
 * This module enforces strict field ownership: only enrichment-owned fields
 * are written to the database. Non-owned fields are stripped before update.
 *
 * Enrichment-owned fields (safe to write):
 *   email, linkedin_url, linkedin_url_normalised, website_url,
 *   email_status, company_headcount, company_industry, country
 *
 * Sourced fields (NEVER touched by enrichment):
 *   first_name, last_name, job_title, company_name
 *
 * This enforcement exists at the write path, not just in handlers,
 * to prevent regression if a handler is modified incorrectly in the future.
 */

export const ENRICHMENT_OWNED_FIELDS = [
  'email',
  'linkedin_url',
  'linkedin_url_normalised',
  'website_url',
  'email_status',
  'company_headcount',
  'company_industry',
  'country',
] as const

export const SOURCED_FIELDS = [
  'first_name',
  'last_name',
  'job_title',
  'company_name',
] as const

export type EnrichmentOwnedField = (typeof ENRICHMENT_OWNED_FIELDS)[number]
export type SourcedField = (typeof SOURCED_FIELDS)[number]

/**
 * Strip non-owned fields from an enrichment update payload.
 * Returns only enrichment-owned fields that are present in the input.
 *
 * This is a defensive operation: enrichment handlers should only return
 * owned fields anyway, but this ensures a handler bug can't corrupt sourced data.
 */
export function stripNonOwnedFields(
  payload: Record<string, any>,
): Record<string, any> {
  const ownershipSet = new Set(ENRICHMENT_OWNED_FIELDS)
  const result: Record<string, any> = {}

  for (const [key, value] of Object.entries(payload)) {
    if (ownershipSet.has(key as EnrichmentOwnedField)) {
      result[key] = value
    }
  }

  return result
}

/**
 * Verify that a payload contains NO sourced fields.
 * Used in tests to prove field ownership is being enforced.
 *
 * Returns { valid: true } if payload contains only owned fields.
 * Returns { valid: false, violations: [...] } if sourced fields are present.
 */
export function verifyNoSourcedFields(
  payload: Record<string, any>,
): { valid: boolean; violations: SourcedField[] } {
  const violations = SOURCED_FIELDS.filter(
    field => field in payload && payload[field] !== undefined,
  ) as SourcedField[]

  return {
    valid: violations.length === 0,
    violations,
  }
}
