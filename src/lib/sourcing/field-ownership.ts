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

// Sourced fields that enrichment can populate if currently NULL (FILL-IF-NULL pattern)
// Enrichment can backfill these fields, but must never overwrite a non-null value
export const FILL_IF_NULL_FIELDS = ['last_name'] as const
export type FillIfNullField = (typeof FILL_IF_NULL_FIELDS)[number]

export type EnrichmentOwnedField = (typeof ENRICHMENT_OWNED_FIELDS)[number]
export type SourcedField = (typeof SOURCED_FIELDS)[number]

/**
 * Strip non-owned fields from an enrichment update payload.
 * Returns only enrichment-owned fields and approved FILL-IF-NULL fields.
 *
 * This is a defensive operation: enrichment handlers should only return
 * owned fields anyway, but this ensures a handler bug can't corrupt sourced data.
 * However, FILL-IF-NULL fields that have been selected via applyFillIfNullLogic
 * are allowed to pass through.
 */
export function stripNonOwnedFields(
  payload: Record<string, any>,
): Record<string, any> {
  const ownershipSet = new Set(ENRICHMENT_OWNED_FIELDS)
  const fillIfNullSet = new Set(FILL_IF_NULL_FIELDS)
  const result: Record<string, any> = {}

  for (const [key, value] of Object.entries(payload)) {
    if (ownershipSet.has(key as EnrichmentOwnedField)) {
      result[key] = value
    } else if (fillIfNullSet.has(key as FillIfNullField) && value !== undefined && value !== null) {
      // Include FILL-IF-NULL fields only if they have non-null values (already passed the FILL-IF-NULL check)
      result[key] = value
    }
  }

  return result
}

/**
 * Apply FILL-IF-NULL logic to enrichment payload.
 * Allows enrichment to populate sourced fields (like last_name) only if they are currently NULL.
 *
 * This function compares the enrichment payload against current prospect values and:
 * - Includes fill-if-null fields from the payload IF the prospect's current value is NULL
 * - Excludes fill-if-null fields IF the prospect already has a non-null value
 *
 * @param payload - Raw enrichment payload (may include last_name, etc)
 * @param currentProspect - Current prospect data from database
 * @returns Payload with fill-if-null fields filtered based on current values
 */
export function applyFillIfNullLogic(
  payload: Record<string, any>,
  currentProspect: Record<string, any>,
): Record<string, any> {
  const result = { ...payload }
  const fillIfNullSet = new Set(FILL_IF_NULL_FIELDS)

  for (const field of FILL_IF_NULL_FIELDS) {
    const payloadValue = payload[field]
    const currentValue = currentProspect[field]

    // If payload has a value for this field, only include it if current value is NULL
    if (field in payload && payloadValue !== undefined && payloadValue !== null) {
      if (currentValue !== null && currentValue !== undefined) {
        // Current value is not null: exclude from update (don't overwrite)
        delete result[field]
      }
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
