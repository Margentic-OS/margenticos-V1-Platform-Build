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

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProspectContext } from './types'

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
  const { data: prospect, error: fetchError } = await supabase
    .from('prospects')
    .select('id, first_name, last_name, company_name, role, email, linkedin_url, website_url, organisation_id, segment_id, variant_id, apollo_enrichment_data')
    .eq('id', prospect_id)
    .eq('organisation_id', client_id)
    .single()

  if (fetchError || !prospect) {
    throw new Error(`Prospect not found: ${prospect_id} for client ${client_id}`)
  }

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

  return {
    ctx: {
      id:              prospect.id,
      organisation_id: prospect.organisation_id,
      segment_id:      segmentId,
      first_name:      prospect.first_name,
      last_name:       prospect.last_name,
      company_name:    prospect.company_name,
      role:            prospect.role,
      email:           prospect.email,
      linkedin_url:    prospect.linkedin_url,
      website_url:     prospect.website_url,
    },
    extras: {
      apollo_enrichment_data: prospect.apollo_enrichment_data as Record<string, unknown> | null,
      variant_id:             prospect.variant_id as string | null,
    },
  }
}
