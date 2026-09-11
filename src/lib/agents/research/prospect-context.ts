// Loading the prospect a research run is about, and resolving its segment.
//
// EXTRACTED, NOT REWRITTEN. This is a byte-for-byte move of the block that opened
// runProspectResearchAgentV2, and that function now calls it. The batch path's phase 1
// calls the same function.
//
// The reason it is shared rather than copied is the failure family this build keeps
// hitting: two lists, two arrays, two implementations that must agree with nothing
// enforcing it. Segment resolution has a side effect (it STAMPS prospects.segment_id
// when it was null), so two copies would not merely drift in what they return, they
// would drift in what they write.
//
// The evidence grader reads prospects too, and must not write. It uses readProspectContext,
// which shares the column list and the mapping below and never stamps a segment.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProspectContext } from './types'
import { companyFactsFromRow } from './company-facts'

/**
 * The prospect columns a research run and the evidence grader read. One list for both.
 * company_headcount and company_industry are for the fit judge (see company-facts.ts).
 */
export const PROSPECT_CONTEXT_COLUMNS =
  'id, first_name, last_name, company_name, role, job_title, email, linkedin_url, website_url, organisation_id, segment_id, variant_id, apollo_enrichment_data, company_headcount, company_industry'

/** The prospect row columns a research run needs, beyond what ProspectContext carries. */
export interface ProspectRowExtras {
  /**
   * Apollo's stored enrichment subset. Research serves Apollo FROM THIS ROW when it is
   * present, and only calls the API when it is absent: enrichment already bought this
   * person, and calling people/match again bought them a second time. About 113
   * duplicate paid calls per 244 researched prospects before that changed.
   */
  apollo_enrichment_data: Record<string, unknown> | null
  /**
   * The variant this prospect is assigned to, or null when composition has not run.
   * Read, never written, here: assignment stays composition's job.
   */
  variant_id: string | null
}

export interface LoadedProspect {
  ctx: ProspectContext
  extras: ProspectRowExtras
}

/** Build the context from a row read with PROSPECT_CONTEXT_COLUMNS. Pure. */
export function prospectContextFromRow(prospect: Record<string, any>, segmentId: string | null): LoadedProspect {
  return {
    ctx: {
      id:              prospect.id,
      organisation_id: prospect.organisation_id,
      segment_id:      segmentId,
      first_name:      prospect.first_name,
      last_name:       prospect.last_name,
      company_name:    prospect.company_name,
      role:            prospect.role,
      job_title:       prospect.job_title,
      email:           prospect.email,
      linkedin_url:    prospect.linkedin_url,
      website_url:     prospect.website_url,
      company:         companyFactsFromRow(prospect as never),
    },
    extras: {
      apollo_enrichment_data: prospect.apollo_enrichment_data as Record<string, unknown> | null,
      variant_id:             prospect.variant_id as string | null,
    },
  }
}

async function readRow(supabase: SupabaseClient, prospect_id: string, client_id: string) {
  const { data: prospect, error: fetchError } = await supabase
    .from('prospects')
    .select(PROSPECT_CONTEXT_COLUMNS)
    .eq('id', prospect_id)
    .eq('organisation_id', client_id)
    .single()

  if (fetchError || !prospect) {
    throw new Error(`Prospect not found: ${prospect_id} for client ${client_id}`)
  }
  return prospect as Record<string, any>
}

/**
 * Read a prospect WITHOUT resolving or stamping its segment. For readers that must not write,
 * such as the evidence grader. The segment is whatever the row holds, possibly null.
 */
export async function readProspectContext(
  supabase: SupabaseClient,
  prospect_id: string,
  client_id: string,
): Promise<LoadedProspect> {
  const prospect = await readRow(supabase, prospect_id, client_id)
  return prospectContextFromRow(prospect, (prospect.segment_id as string | null) ?? null)
}

/**
 * Load a prospect, resolve its segment, and stamp the segment when it was missing.
 *
 * Agent isolation, per CLAUDE.md: client_id is required and every query filters on it.
 *
 * Throws when the prospect does not exist for this client. That is the correct
 * behaviour for both callers: there is no useful run to do, and returning null would
 * push the same throw one level up in two places.
 */
export async function loadProspectContext(
  supabase: SupabaseClient,
  prospect_id: string,
  client_id: string,
): Promise<LoadedProspect> {
  const prospect = await readRow(supabase, prospect_id, client_id)

  // If segment_id is null (prospect created before backfill or outside the sourcing
  // path), stamp it with the org's primary segment now. This ensures every prospect has
  // a segment before research and compose run.
  let segmentId: string | null = prospect.segment_id ?? null
  if (!segmentId) {
    const { data: primarySeg } = await supabase
      .from('segments')
      .select('id')
      .eq('organisation_id', client_id)
      .eq('is_default', true)
      .single()
    segmentId = primarySeg?.id ?? null
    if (segmentId) {
      await supabase
        .from('prospects')
        .update({ segment_id: segmentId })
        .eq('id', prospect_id)
        .eq('organisation_id', client_id)
    }
  }

  return prospectContextFromRow(prospect, segmentId)
}
