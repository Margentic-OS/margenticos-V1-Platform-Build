// Returns the id of an org's primary segment (is_default = true).
// Use this as the canonical fallback everywhere a segment_id must be resolved
// but is absent — agent routes, research synthesis, sequence composition.
// Returns null only if the org has no primary segment, which should not occur
// after the segments_is_default migration.

import type { SupabaseClient } from '@supabase/supabase-js'

export async function resolveOrgPrimarySegment(
  supabase: SupabaseClient,
  organisationId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('segments')
    .select('id')
    .eq('organisation_id', organisationId)
    .eq('is_default', true)
    .single()

  return data?.id ?? null
}
