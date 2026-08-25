/**
 * Field ownership enforcement for prospect enrichment.
 *
 * Enrichment handlers return data for multiple field categories.
 * This module enforces strict field ownership: only enrichment-owned fields
 * are written to the database. Non-owned fields are stripped before update.
 *
 * Enrichment-owned fields (safe to write):
 *   email, linkedin_url, linkedin_url_normalised, website_url,
 *   email_status, company_headcount, company_industry, country,
 *   apollo_enrichment_data
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
  // Added 2026-08-24. The named subset of the Apollo bulk_match response we already paid
  // for. Enrichment-owned because enrichment is the only thing that buys it. Its SHAPE is
  // governed by the allow-list in apollo-enrichment-subset.ts, not by this list.
  'apollo_enrichment_data',
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
 *
 * Allows enrichment to populate a sourced field (currently only last_name) ONLY when we
 * can positively see that the prospect's current value is NULL.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ABSENT IS "UNKNOWN, DO NOT WRITE". IT IS NOT "NULL, SAFE TO WRITE".
 *
 * This is the whole point of the function and it was wrong until 2026-08-24. The guard
 * read:
 *
 *     if (currentValue !== null && currentValue !== undefined) delete result[field]
 *
 * so `undefined` fell through and the write proceeded. undefined does not mean the field
 * is empty. It means we do not know what it is, and there are three ways to get it:
 *
 *   1. The caller passed no record at all. adapter-apollo-enrichment does
 *      `applyFillIfNullLogic(payload, currentProspect || {})`, and currentProspect is
 *      null whenever the prospect SELECT failed. That SELECT logs and continues rather
 *      than aborting, so a transient database error silently became consent to overwrite.
 *   2. The record was fetched but that column was not selected.
 *   3. The record exists and genuinely has no such key.
 *
 * In all three the honest reading is the same: we cannot see the current value, so we
 * must not overwrite it. Apollo's last_name is a match guess, and the prospect's existing
 * surname came from sourcing where a human approved it. Replacing a real surname with a
 * guess because a SELECT failed is silent data corruption: nothing errors, nothing logs,
 * and the wrong name goes out on the next send.
 *
 * FIXED AT THE CLASS, NOT AT THE ROUTE. The obvious patch was to make the enrichment
 * handler abort when the SELECT fails. That fixes one caller. This fixes every caller,
 * including ones written later that pass a partial record for reasons of their own.
 *
 * THE ONLY CASE THAT PERMITS A WRITE: the record is present, the key exists on it, and
 * its value is exactly null. Everything else is refused.
 *
 * @param payload         Raw enrichment payload (may include last_name, etc)
 * @param currentProspect Current prospect data. null, undefined, or a record missing the
 *                        key all mean UNKNOWN and block the fill.
 * @returns Payload with fill-if-null fields filtered based on current values
 */
export function applyFillIfNullLogic(
  payload: Record<string, any>,
  currentProspect: Record<string, any> | null | undefined,
): Record<string, any> {
  const result = { ...payload }

  for (const field of FILL_IF_NULL_FIELDS) {
    const payloadValue = payload[field]

    // Nothing offered for this field, so there is nothing to decide.
    if (!(field in payload) || payloadValue === undefined || payloadValue === null) continue

    // UNKNOWN: no record, or the record cannot tell us about this field. Refuse.
    if (
      currentProspect === null ||
      currentProspect === undefined ||
      !(field in currentProspect) ||
      currentProspect[field] === undefined
    ) {
      delete result[field]
      continue
    }

    // KNOWN and non-null: a real value exists and enrichment must never overwrite it.
    if (currentProspect[field] !== null) {
      delete result[field]
    }

    // KNOWN and exactly null: the only case that permits the fill.
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
