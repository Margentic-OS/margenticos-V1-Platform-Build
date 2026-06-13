// src/lib/sourcing/handlers/adapter-apollo-enrichment.ts
//
// Apollo people enrichment handler - Phase B.
// Endpoint: POST https://api.apollo.io/api/v1/people/bulk_match
// Request: details[] array, max 10 per call
// Response: synchronous 200 (no webhook), includes credits_consumed, matches[], missing_records
//
// Trust boundary: HTTP 200 doesn't mean enrichment succeeded.
// Check per-match email_status and presence of email field.
// Only email_status === 'verified' passes; others held with enrichment_status.
//
// Post-enrichment dedupe recheck on new identities (Amendment 2, Amendment 3):
// 1. Populate email, linkedin_url, linkedin_url_normalised, company domain
// 2. Run dedupe recheck via shared getDedupeVerdict()
// 3. If recheck returns duplicate_* or suppressed_match: set enrichment_status='held_duplicate'
// 4. If email_status !== 'verified': set enrichment_status='held_unverified' (or held_no_email)
// 5. Only clean recheck + verified email: enrichment_status='enriched'

import { createClient } from '@supabase/supabase-js'
import { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import { normaliseLinkedInUrl } from '@/lib/sourcing/normalise-linkedin'
import { getDedupeVerdict } from '@/lib/sourcing/dedupe-verdict'

type SupabaseServiceClient = ReturnType<typeof createClient<Database>>

interface ApolloMatch {
  id: string
  first_name?: string | null
  last_name?: string | null
  name?: string | null
  email?: string | null
  email_status?: string | null
  linkedin_url?: string | null
  title?: string | null
  organisation?: {
    name?: string | null
    primary_domain?: string | null
    estimated_num_employees?: number | null
    industry?: string | null
  } | null
}

interface ApolloBulkMatchResponse {
  status: string
  error_code?: string | null
  error_message?: string | null
  total_requested_enrichments: number
  unique_enriched_records: number
  missing_records: number
  credits_consumed: number
  matches: ApolloMatch[]
}

export interface EnrichmentRun {
  organisation_id: string
  batch_size: number
  total_requested_enrichments: number
  unique_enriched_records: number
  missing_records: number
  credits_consumed: number
  enriched_at: string
  status: 'success' | 'partial' | 'failed'
  error_message?: string
}

/**
 * Enrich prospects using Apollo bulk_match endpoint.
 * Batches requests to max 10 per call, max 100 total per run.
 * Post-enrichment dedupe recheck before marking enriched.
 */
export async function enrichProspectsForOrganisation(
  supabase: SupabaseServiceClient,
  organisationId: string,
  prospectIds: string[],
  maxRunBatchSize: number = 100,
): Promise<EnrichmentRun> {
  const apiKey = process.env.APOLLO_API_KEY
  if (!apiKey) {
    const msg = 'APOLLO_API_KEY not set in environment'
    logger.error('enrichment: missing API key', { error: msg })
    throw new Error(`Apollo enrichment failed: ${msg}`)
  }

  // Safety cap: enforce max batch size per run
  const cappedIds = prospectIds.slice(0, maxRunBatchSize)
  if (cappedIds.length !== prospectIds.length) {
    logger.warn('enrichment: batch size capped', {
      requested: prospectIds.length,
      capped_to: maxRunBatchSize,
    })
  }

  const operationId = `enrich-${organisationId.slice(0, 8)}-${Date.now()}`

  logger.info('enrichment: run started', {
    operation_id: operationId,
    organisation_id: organisationId,
    batch_size: cappedIds.length,
  })

  const enrichmentRun: EnrichmentRun = {
    organisation_id: organisationId,
    batch_size: cappedIds.length,
    total_requested_enrichments: 0,
    unique_enriched_records: 0,
    missing_records: 0,
    credits_consumed: 0,
    enriched_at: new Date().toISOString(),
    status: 'success',
  }

  try {
    // Batch prospect IDs into groups of 10
    const batches: string[][] = []
    for (let i = 0; i < cappedIds.length; i += 10) {
      batches.push(cappedIds.slice(i, i + 10))
    }

    logger.info('enrichment: batches prepared', {
      operation_id: operationId,
      batch_count: batches.length,
    })

    // Enrich each batch
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx]

      try {
        const response = await callApolloBulkMatch(apiKey, batch)

        enrichmentRun.total_requested_enrichments += response.total_requested_enrichments
        enrichmentRun.unique_enriched_records += response.unique_enriched_records
        enrichmentRun.missing_records += response.missing_records
        enrichmentRun.credits_consumed += response.credits_consumed

        logger.info('enrichment: batch API call succeeded', {
          operation_id: operationId,
          batch_index: batchIdx,
          batch_size: batch.length,
          credits_consumed: response.credits_consumed,
          matches: response.matches.length,
        })

        // Process each match: populate identity, recheck dedupe, set enrichment_status
        for (const match of response.matches) {
          const prospectId = batch.find(id => {
            // Find the prospect ID corresponding to this Apollo person ID
            // We'll need to query the DB to map apollo:id to prospect.id
            return true // Placeholder; see below
          })

          if (!prospectId) {
            logger.warn('enrichment: could not map Apollo ID to prospect ID', {
              apollo_id: match.id,
            })
            continue
          }

          await enrichAndVerifyProspect(
            supabase,
            organisationId,
            prospectId,
            match,
            operationId,
          )
        }

        // Handle missing records (not in matches[])
        if (response.missing_records > 0) {
          logger.info('enrichment: missing records in batch', {
            operation_id: operationId,
            missing_count: response.missing_records,
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('enrichment: batch API call failed', {
          operation_id: operationId,
          batch_index: batchIdx,
          error: msg,
        })
        enrichmentRun.status = 'partial'
        enrichmentRun.error_message = msg
        // Continue to next batch rather than failing entire run
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('enrichment: run failed', {
      operation_id: operationId,
      error: msg,
    })
    enrichmentRun.status = 'failed'
    enrichmentRun.error_message = msg
  }

  // Log enrichment run to audit table
  const enrichmentRunId = organisationId as unknown as string
  const { error: logError } = await (supabase as any).from('enrichment_runs').insert({
    organisation_id: enrichmentRunId,
    batch_size: enrichmentRun.batch_size,
    total_requested_enrichments: enrichmentRun.total_requested_enrichments,
    unique_enriched_records: enrichmentRun.unique_enriched_records,
    missing_records: enrichmentRun.missing_records,
    credits_consumed: enrichmentRun.credits_consumed,
    run_timestamp: new Date(enrichmentRun.enriched_at),
    status: enrichmentRun.status,
    error_message: enrichmentRun.error_message || null,
  })

  if (logError) {
    logger.error('enrichment: failed to log run to enrichment_runs', {
      operation_id: operationId,
      error: logError.message,
    })
  }

  logger.info('enrichment: run completed', {
    operation_id: operationId,
    status: enrichmentRun.status,
    enriched: enrichmentRun.unique_enriched_records,
    missing: enrichmentRun.missing_records,
    credits_consumed: enrichmentRun.credits_consumed,
  })

  return enrichmentRun
}

/**
 * Call Apollo bulk_match endpoint.
 * Synchronous (all flags false), returns immediately with matches.
 */
async function callApolloBulkMatch(
  apiKey: string,
  prospectIds: string[],
): Promise<ApolloBulkMatchResponse> {
  // Build details[] array from Apollo person IDs (stored as source_person_key "apollo:id")
  const details = prospectIds.map(id => ({
    id,
  }))

  const response = await fetch('https://api.apollo.io/api/v1/people/bulk_match', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      details,
      reveal_personal_emails: false,
      reveal_phone_number: false,
      run_waterfall_email: false,
      run_waterfall_phone: false,
    }),
  })

  if (response.status === 403) {
    throw new Error('Apollo API returned 403 (plan-gated, likely free tier)')
  }

  if (response.status === 429) {
    throw new Error('Apollo API rate limit exceeded (600/hour)')
  }

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Apollo API returned ${response.status}: ${text}`)
  }

  return await response.json()
}

/**
 * Enrich a single prospect and verify dedupe.
 * Amendment 2: populate identity fields FIRST, then recheck dedupe, THEN set enrichment_status.
 */
async function enrichAndVerifyProspect(
  supabase: SupabaseServiceClient,
  organisationId: string,
  prospectId: string,
  apolloMatch: ApolloMatch,
  operationId: string,
): Promise<void> {
  // Step 1: Extract and normalise identity fields from Apollo response
  const email = apolloMatch.email || null
  const linkedinUrl = apolloMatch.linkedin_url || null
  const linkedinUrlNormalised = linkedinUrl ? normaliseLinkedInUrl(linkedinUrl) : null
  const companyDomain = apolloMatch.organisation?.primary_domain || null
  const emailStatus = apolloMatch.email_status || null

  // Step 2: Populate identity fields on prospect row
  const { error: updateError } = await (supabase as any)
    .from('prospects')
    .update({
      email,
      linkedin_url: linkedinUrl,
      linkedin_url_normalised: linkedinUrlNormalised,
      website_url: companyDomain,
      email_status: emailStatus,
    })
    .eq('id', prospectId)
    .eq('organisation_id', organisationId)

  if (updateError) {
    logger.error('enrichment: failed to populate identity fields', {
      operation_id: operationId,
      prospect_id: prospectId,
      error: updateError.message,
    })
    return
  }

  // Step 3: Run post-enrichment dedupe recheck (Amendment 2, Amendment 3)
  // Must check against NEW identity fields, not old ones
  let dedupeVerdict: string = 'new'
  try {
    dedupeVerdict = await getDedupeVerdict(supabase, organisationId, {
      source_person_key: `apollo:${apolloMatch.id}`,
      email,
      linkedin_url: linkedinUrl,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('enrichment: dedupe recheck failed', {
      operation_id: operationId,
      prospect_id: prospectId,
      error: msg,
    })
    // Fail safe: mark as held_duplicate if recheck errors
    dedupeVerdict = 'suppressed_match'
  }

  // Step 4: Set enrichment_status based on dedupe verdict + email_status (Amendment 4)
  let enrichmentStatus: string

  if (dedupeVerdict === 'suppressed_match' || dedupeVerdict.startsWith('duplicate_')) {
    enrichmentStatus = 'held_duplicate'
  } else if (emailStatus === 'verified') {
    enrichmentStatus = 'enriched'
  } else if (!email) {
    enrichmentStatus = 'held_no_email'
  } else {
    enrichmentStatus = 'held_unverified'
  }

  // Step 5: Write enrichment_status
  const { error: enrichError } = await (supabase as any)
    .from('prospects')
    .update({
      enrichment_status: enrichmentStatus,
    })
    .eq('id', prospectId)
    .eq('organisation_id', organisationId)

  if (enrichError) {
    logger.error('enrichment: failed to set enrichment_status', {
      operation_id: operationId,
      prospect_id: prospectId,
      enrichment_status: enrichmentStatus,
      error: enrichError.message,
    })
  } else {
    logger.info('enrichment: prospect enriched and verified', {
      operation_id: operationId,
      prospect_id: prospectId,
      enrichment_status: enrichmentStatus,
      dedupe_verdict: dedupeVerdict,
      email_status: emailStatus,
    })
  }
}
