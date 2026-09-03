import type { ServiceRoleClient } from '@/lib/supabase/service-role'
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
import { stripNonOwnedFields, applyFillIfNullLogic } from '@/lib/sourcing/field-ownership'
import { buildApolloEnrichmentSubset } from '@/lib/sourcing/apollo-enrichment-subset'
import { shouldUseMockEnrichment } from '@/lib/sourcing/enrichment-mode'
import { CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'
import { toIso2CountryCode } from '@/lib/sourcing/country-code'

type SupabaseServiceClient = ServiceRoleClient

interface ApolloMatch {
  id: string
  first_name?: string | null
  last_name?: string | null
  name?: string | null
  email?: string | null
  email_status?: string | null
  linkedin_url?: string | null
  title?: string | null
  /**
   * The person's country. Parsed since 2026-08-24.
   *
   * It was in ENRICHMENT_OWNED_FIELDS from the start and never parsed here, so the write
   * path was permitted to populate a column we never collected. country is NULL on every
   * prospect row, and that is why two German companies were emailed against a standing
   * exclusion rule in the C0 send. Written as a FIRST-CLASS COLUMN, not into the jsonb,
   * so a jurisdiction gate can query it directly.
   */
  country?: string | null
  organization?: {
    name?: string | null
    primary_domain?: string | null
    estimated_num_employees?: number | null
    industry?: string | null
  } | null
  /**
   * Everything else bulk_match returns. Deliberately untyped: it is not read field by
   * field here, it is handed to buildApolloEnrichmentSubset, which decides what may be
   * kept from an explicit allow-list. Typing it would invite someone to reach into a
   * field the allow-list has not approved.
   */
  [key: string]: unknown
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
 * In test mode, draws mock industries from client's approved ICP spec.
 */
export async function enrichProspectsForOrganisation(
  supabase: SupabaseServiceClient,
  organisationId: string,
  prospectIds: string[],
  maxRunBatchSize: number = 100,
): Promise<EnrichmentRun> {
  const apiKey = process.env.APOLLO_API_KEY

  // Mode is determined by explicit DB flag, not environment inference
  const isTestMode = await shouldUseMockEnrichment(supabase, organisationId)

  if (!isTestMode && !apiKey) {
    const msg = 'APOLLO_API_KEY not set in environment (required for live enrichment)'
    logger.error('enrichment: missing API key for live mode', { error: msg })
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
    // Fetch test-mode industries from the client's live ICP (if test mode)
    let testModeIndustries: string[] = []
    if (isTestMode) {
      const { data: icpDoc } = await (supabase as any)
        .from('strategy_documents')
        .select('icp_filter_spec')
        .eq('organisation_id', organisationId)
        .eq('document_type', 'icp')
        .eq('status', 'active')
        .single()

      if (icpDoc?.icp_filter_spec?.industries && Array.isArray(icpDoc.icp_filter_spec.industries)) {
        testModeIndustries = icpDoc.icp_filter_spec.industries
      }
    }

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
        // Load prospect rows for this batch to map source_person_key to prospect.id
        const batchSourcePersonKeys = batch.map(apolloId => `apollo:${apolloId}`)
        const { data: prospectRows, error: prospectError } = await (supabase as any)
          .from('prospects')
          .select('id, source_person_key')
          .eq('organisation_id', organisationId)
          .in('source_person_key', batchSourcePersonKeys)

        if (prospectError) {
          throw new Error(`Failed to load prospect rows for batch: ${prospectError.message}`)
        }

        // Build Map from source_person_key to prospect.id
        const keyToProspectId = new Map<string, string>()
        if (prospectRows) {
          for (const row of prospectRows) {
            keyToProspectId.set(row.source_person_key, row.id)
          }
        }

        const response = await callApolloBulkMatch(apiKey || '', batch, isTestMode, testModeIndustries)

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

        // ── The money is gone as of callApolloBulkMatch above. ─────────────────
        // Everything below can throw, and until 2026-08-23 every one of those failure
        // paths left enrichment_status NULL, which is exactly the state the trigger
        // re-selects once the 30-minute lock goes stale. Aug 10 2026: 303 enrichments
        // requested across 12 runs against 29 people, 141 credits, 4.86 each.
        //
        // So the floor is written FIRST, before the per-match loop and before anything
        // that can fail. recordBatchSpend never throws; a floor that could abort the
        // batch would reintroduce the hole it exists to close.
        await recordBatchSpend(
          supabase,
          organisationId,
          batchSourcePersonKeys,
          response.credits_consumed,
          operationId,
        )

        // Process each match: populate identity, recheck dedupe, set enrichment_status
        // This REFINES the floor written above. It no longer has to create the status.
        const returnedApolloIds = new Set<string>()
        for (const match of response.matches) {
          const sourcePersonKey = `apollo:${match.id}`
          returnedApolloIds.add(match.id)
          const prospectId = keyToProspectId.get(sourcePersonKey)

          if (!prospectId) {
            logger.warn('enrichment: could not map Apollo ID to prospect ID', {
              apollo_id: match.id,
              source_person_key: sourcePersonKey,
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

        // Handle unreturned records: mark as held_missing
        const unreportedSourceKeys = batchSourcePersonKeys.filter(
          key => !returnedApolloIds.has(key.replace('apollo:', '')),
        )
        if (unreportedSourceKeys.length > 0) {
          logger.info('enrichment: marking unreturned prospects as held_missing', {
            operation_id: operationId,
            unreturned_count: unreportedSourceKeys.length,
          })

          const unreportedProspectIds = unreportedSourceKeys
            .map(key => keyToProspectId.get(key))
            .filter((id): id is string => id !== undefined)

          if (unreportedProspectIds.length > 0) {
            // Scoped to rows still resting on the floor this batch just wrote. Without the
            // predicate this UPDATE overwrites ANY status, including an 'enriched' verdict
            // from an earlier run: Apollo answering under its own canonical person id makes
            // every key we sent look unreturned, and a good prospect gets demoted to
            // held_missing on a re-run. Caught by the mapping-miss test in
            // enrichment-credit-guard.test.ts, which failed on exactly that before this line.
            const { error: missingError } = await (supabase as any)
              .from('prospects')
              .update({ enrichment_status: 'held_missing' })
              .eq('organisation_id', organisationId)
              .in('id', unreportedProspectIds)
              .eq('enrichment_status', 'held_incomplete')

            if (missingError) {
              logger.error('enrichment: failed to mark unreturned prospects as held_missing', {
                operation_id: operationId,
                error: missingError.message,
              })
            }
          }
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
 * Generate deterministic test-mode mock response with ICP-plausible enrichment data.
 *
 * CRITICAL: Mock only returns enrichment-owned fields (email, company_industry, company_headcount).
 * It must NOT include title or company_name (those are sourced fields, must never be written).
 *
 * Mock values are ICP-plausible:
 * - company_headcount: 2-19 (founder-led consulting range)
 * - company_industry: drawn from client's approved ICP spec industries (or canonical if empty)
 * - email: .mock.invalid (visibly fake, deterministic)
 */
function generateTestModeResponse(apolloIds: string[], specIndustries: string[] = []): ApolloBulkMatchResponse {
  const firstNames = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Henry', 'Iris', 'Jack']
  const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez']
  // Use spec industries if provided, fall back to canonical
  const industries = specIndustries.length > 0 ? specIndustries : CANONICAL_INDUSTRIES

  const matches: ApolloMatch[] = apolloIds.map((id, idx) => {
    const firstName = firstNames[idx % firstNames.length]
    const lastName = lastNames[(idx + 1) % lastNames.length]
    const industry = industries[(idx + 2) % industries.length]

    // ICP-plausible headcount: founder-led consulting is typically 2-19 employees
    const headcount = 2 + (idx % 18)

    // Generate a simple hash from Apollo ID for uniqueness
    let hash = 0
    for (let i = 0; i < id.length; i++) {
      const char = id.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    const hashStr = Math.abs(hash).toString(36).substring(0, 6)
    const emailLocal = `${firstName.toLowerCase()}_${String(idx).padStart(3, '0')}_${hashStr}`

    return {
      id,
      first_name: firstName,
      last_name: lastName,
      name: `${firstName} ${lastName}`,
      email: `${emailLocal}@mock.invalid`,
      email_status: 'verified',
      linkedin_url: `https://mock.invalid/in/${emailLocal}`,
      // CRITICALLY: no title field (enrichment does NOT write job titles)

      // ── The mock did not match the real response shape until 2026-08-24 ──
      //
      // It returned 8 fields. A live bulk_match probe on that date returned 33 top-level
      // fields and 39 organization fields. A mock narrower than the API cannot exercise
      // the code that reads the API, so country and employment_history were untestable
      // without spending a credit, and country in particular is the field whose absence
      // let two German companies into the C0 send.
      //
      // The additions below use the EXACT field names the live probe returned. Values are
      // obviously fake. The forbidden fields are included ON PURPOSE so the data
      // minimisation boundary is exercised against a payload that actually contains the
      // things it must strip: a mock with nothing to strip proves nothing.
      country: idx % 5 === 0 ? 'Germany' : 'United Kingdom',
      seniority: 'founder',
      departments: ['operations'],
      subdepartments: ['operations'],
      functions: ['operations'],
      headline: `Founder at Test Company ${idx + 1}`,
      organization_id: `mock-org-${idx + 1}`,
      employment_history: [{
        title: 'Founder', organization_name: `Test Company ${idx + 1}`,
        organization_id: `mock-org-${idx + 1}`, start_date: '2016-10-01',
        end_date: null, current: true, kind: 'employment',
        description: 'Runs the firm.',
        // Forbidden. Must never reach apollo_enrichment_data.
        emails: [`${emailLocal}@personal.mock.invalid`],
        raw_address: '12 Mock Lane, Mocktown',
      }],
      // Forbidden, person level. Must never reach apollo_enrichment_data.
      street_address: '12 Mock Lane', city: 'Mocktown', state: 'Mockshire',
      postal_code: 'MO1 1CK', formatted_address: '12 Mock Lane, Mocktown MO1 1CK',
      phone: '+44 7700 900000', photo_url: 'https://mock.invalid/photo.jpg',
      facebook_url: 'https://mock.invalid/fb', twitter_url: 'https://mock.invalid/x',
      github_url: 'https://mock.invalid/gh',

      organization: {
        name: `Test Company ${idx + 1}`,
        primary_domain: `testco${idx + 1}.mock.invalid`,
        estimated_num_employees: headcount, // Plausible range 2-19
        industry, // Canonical industry
        id: `mock-org-${idx + 1}`,
        founded_year: 2016,
        organization_revenue: 1_000_000,
        organization_headcount_six_month_growth: 11,
        organization_headcount_twelve_month_growth: 24,
        organization_headcount_twenty_four_month_growth: 40,
        industries: ['consulting'],
        secondary_industries: ['software'],
        naics_codes: ['541611'],
        sic_codes: ['8742'],
        keywords: ['operations'],
        linkedin_uid: `mock-uid-${idx + 1}`,
        linkedin_url: `https://mock.invalid/company/testco${idx + 1}`,
        website_url: `https://testco${idx + 1}.mock.invalid`,
        // Forbidden, org level.
        street_address: '1 Mock Park', city: 'Mocktown', phone: '+44 20 7000 0000',
      },
    }
  })

  return {
    status: 'success',
    error_code: null,
    error_message: null,
    total_requested_enrichments: apolloIds.length,
    unique_enriched_records: apolloIds.length,
    missing_records: 0,
    credits_consumed: 0,
    matches,
  }
}

/**
 * Call Apollo bulk_match endpoint.
 * Synchronous (all flags false), returns immediately with matches.
 * In test mode, returns deterministic fake data with mock.invalid email addresses.
 */
async function callApolloBulkMatch(
  apiKey: string,
  prospectIds: string[],
  isTestMode: boolean = false,
  testModeIndustries: string[] = [],
): Promise<ApolloBulkMatchResponse> {
  if (isTestMode) {
    return generateTestModeResponse(prospectIds, testModeIndustries)
  }

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
 * Record what a returned bulk_match batch cost us, BEFORE anything that can fail.
 *
 * Two writes, in this order:
 *
 *  1. THE STATUS FLOOR. Every prospect in the batch still sitting at NULL gets
 *     'held_incomplete'. Scoped with .is('enrichment_status', null) so a verdict from an
 *     earlier run is never downgraded. enrichAndVerifyProspect overwrites this with the
 *     real outcome moments later; the floor only has to survive the gap.
 *
 *  2. THE CREDIT STAMP, when Apollo reported a non-zero charge. This is what
 *     enrichment-trigger reads to refuse a second purchase of the same person.
 *
 * KEYED ON source_person_key, NOT on the keyToProspectId map. That map is the prime
 * suspect for the Aug 10 loop: Apollo can answer with its own canonical person id, and
 * every id it returns that we did not send misses the map and skips the prospect
 * entirely. Both writes here use the keys we SENT, so they land whatever Apollo calls
 * the person in its reply.
 *
 * WHY THE STAMP COVERS THE WHOLE BATCH. credits_consumed arrives per batch, not per
 * record, so when a batch is charged less than in full we cannot tell which records
 * inside it were the billed ones. Marking all of them over-marks in that case, and
 * over-marking is the safe direction: the cost is that a prospect needs an explicit
 * re-enrichment to be retried, which is not a feature today. Under-marking is what
 * spends money twice. Prospects Apollo returned nothing for are separately set to
 * 'held_missing' below, which is terminal too, so the over-marking changes no outcome.
 *
 * NEVER THROWS. This runs after the credit is spent and before the refinement loop. An
 * exception here would abort the batch at precisely the point the whole function exists
 * to protect, so both failures are logged and swallowed.
 */
async function recordBatchSpend(
  supabase: SupabaseServiceClient,
  organisationId: string,
  batchSourcePersonKeys: string[],
  creditsConsumed: number,
  operationId: string,
): Promise<void> {
  try {
    const { error: floorError } = await (supabase as any)
      .from('prospects')
      .update({ enrichment_status: 'held_incomplete' })
      .eq('organisation_id', organisationId)
      .in('source_person_key', batchSourcePersonKeys)
      .is('enrichment_status', null)

    if (floorError) {
      logger.error('enrichment: failed to write terminal status floor after paying', {
        operation_id: operationId,
        batch_size: batchSourcePersonKeys.length,
        error: floorError.message,
      })
    }

    if (creditsConsumed > 0) {
      const { error: stampError } = await (supabase as any)
        .from('prospects')
        .update({ enrichment_credit_consumed_at: new Date().toISOString() })
        .eq('organisation_id', organisationId)
        .in('source_person_key', batchSourcePersonKeys)
        .is('enrichment_credit_consumed_at', null)

      if (stampError) {
        logger.error('enrichment: failed to stamp credit consumption', {
          operation_id: operationId,
          credits_consumed: creditsConsumed,
          error: stampError.message,
        })
      }
    }

    logger.info('enrichment: batch spend recorded', {
      operation_id: operationId,
      batch_size: batchSourcePersonKeys.length,
      credits_consumed: creditsConsumed,
      credit_stamped: creditsConsumed > 0,
    })
  } catch (err) {
    logger.error('enrichment: recordBatchSpend threw, batch continues', {
      operation_id: operationId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Enrich a single prospect and verify dedupe.
 * Amendment 2: populate identity fields FIRST, then recheck dedupe, THEN set enrichment_status.
 * Amendment 5 (2026-06-15): populate firmographics (headcount, industry, title) for tiering.
 */
async function enrichAndVerifyProspect(
  supabase: SupabaseServiceClient,
  organisationId: string,
  prospectId: string,
  apolloMatch: ApolloMatch,
  operationId: string,
): Promise<void> {
  // Step 1: Load current prospect to enable FILL-IF-NULL logic
  const { data: currentProspect, error: fetchError } = await (supabase as any)
    .from('prospects')
    .select('last_name')
    .eq('id', prospectId)
    .eq('organisation_id', organisationId)
    .single()

  if (fetchError) {
    logger.warn('enrichment: could not load current prospect for FILL-IF-NULL check', {
      operation_id: operationId,
      prospect_id: prospectId,
      error: fetchError.message,
    })
  }

  // Step 2: Extract and normalise identity fields from Apollo response
  const email = apolloMatch.email || null
  const linkedinUrl = apolloMatch.linkedin_url || null
  const linkedinUrlNormalised = linkedinUrl ? normaliseLinkedInUrl(linkedinUrl) : null
  const companyDomain = apolloMatch.organization?.primary_domain || null
  const emailStatus = apolloMatch.email_status || null

  // Step 2b: Extract ENRICHMENT-OWNED firmographic fields (all nullable, Apollo may not return them)
  // CRITICAL: Enrichment owns company_headcount and company_industry ONLY
  // Do NOT write job_title or company_name — those are sourced fields and must not be overwritten
  const companyHeadcount = apolloMatch.organization?.estimated_num_employees || null
  const companyIndustry = apolloMatch.organization?.industry || null

  // FIRST-CLASS COLUMN, not jsonb. A jurisdiction gate has to be able to filter on this
  // in a WHERE clause. Enrichment already owns the field; it simply was never parsed.
  //
  // TRANSLATED TO CANONICAL ISO-2 HERE, because the handler owns its vendor's vocabulary
  // (CLAUDE.md) and because writing it raw is what broke the DE exclusion. Apollo returns
  // "Germany"; send-eligibility-rules.ts matches 'DE'; the two never met, and two German
  // prospects were mailed as a result. See src/lib/sourcing/country-code.ts for the full
  // account. A WHERE clause on this column is only meaningful if one vocabulary reaches it.
  const country = toIso2CountryCode(apolloMatch.country)

  // The subset of everything else we already paid for. An ALLOW-LIST decides the shape:
  // no addresses, no phone, no personal social URLs, no nested emails. See
  // apollo-enrichment-subset.ts for why the whole payload is not stored.
  const apolloEnrichmentData = buildApolloEnrichmentSubset(apolloMatch as Record<string, unknown>)

  // Step 2c: Include last_name from Apollo for FILL-IF-NULL logic
  // last_name is a sourced field but can be populated if currently NULL
  const lastName = apolloMatch.last_name || null

  // Step 3: Build enrichment update payload including potential fill-if-null fields
  const enrichmentUpdatePayload = {
    email,
    linkedin_url: linkedinUrl,
    linkedin_url_normalised: linkedinUrlNormalised,
    website_url: companyDomain,
    email_status: emailStatus,
    company_headcount: companyHeadcount,
    company_industry: companyIndustry,
    country,
    apollo_enrichment_data: apolloEnrichmentData,
    last_name: lastName, // Include for FILL-IF-NULL logic
  }

  // Step 4: Apply FILL-IF-NULL logic (only populate last_name if currently NULL)
  const fillIfNullApplied = applyFillIfNullLogic(
    enrichmentUpdatePayload,
    currentProspect || {},
  )

  // Step 5: Strip any non-owned fields from the payload (defense against handler bugs)
  const safeUpdatePayload = stripNonOwnedFields(fillIfNullApplied)

  const { error: updateError } = await (supabase as any)
    .from('prospects')
    .update(safeUpdatePayload)
    .eq('id', prospectId)
    .eq('organisation_id', organisationId)

  if (updateError) {
    logger.error('enrichment: failed to populate identity and firmographic fields', {
      operation_id: operationId,
      prospect_id: prospectId,
      error: updateError.message,
    })
    return
  }

  // Step 6: Run post-enrichment dedupe recheck (Amendment 2, Amendment 3)
  // Must check against NEW identity fields, not old ones
  // For re-enrichment: exclude this prospect from person_key duplicate checks (don't flag self as dup)
  let dedupeVerdict: string = 'new'
  try {
    dedupeVerdict = await getDedupeVerdict(supabase, organisationId, {
      source_person_key: `apollo:${apolloMatch.id}`,
      email,
      linkedin_url: linkedinUrl,
      exclude_prospect_id: prospectId,
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

  // Step 7: Set enrichment_status based on dedupe verdict + email_status (Amendment 4)
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

  // Step 8: Write enrichment_status
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
