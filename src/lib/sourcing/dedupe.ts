// src/lib/sourcing/dedupe.ts
//
// Deduplication verdict engine for prospect sourcing.
// Given a batch of sourced candidates, determines per-candidate verdict:
//   'suppressed_match' = candidate matches a suppressed prospect (compliance signal)
//   'duplicate_person_key' = source identity already exists in system
//   'duplicate_linkedin' = normalised LinkedIn URL already exists
//   'duplicate_email' = email already exists (case-insensitive)
//   'new' = no match found, safe to ingest
//
// Verification runs in order of strictness: suppression first (compliance),
// then duplicates by identity (person key, LinkedIn, email).
//
// All queries are batched per dimension (4-5 total queries, not per-candidate),
// keyed by candidate.source_person_key which is always present on sourced candidates.
// Every query carries explicit organisation_id filter regardless of RLS context.

import { createClient } from '@supabase/supabase-js'
import { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import { normaliseLinkedInUrl } from './normalise-linkedin'
import { getDedupeVerdict } from './dedupe-verdict'

type SupabaseServiceClient = ReturnType<typeof createClient<Database>>

export type CandidateVerdict =
  | 'suppressed_match'
  | 'duplicate_person_key'
  | 'duplicate_linkedin'
  | 'duplicate_email'
  | 'new'

export interface ProspectCandidate {
  source_person_key: string // Always present: 'tool:external_id' format
  email?: string | null
  linkedin_url?: string | null
}

interface DuplicateMatch {
  source_person_key: string
  verdict: CandidateVerdict
}

export async function checkCandidates(
  supabase: SupabaseServiceClient,
  organisationId: string,
  candidates: ProspectCandidate[],
): Promise<Map<string, CandidateVerdict>> {
  const results = new Map<string, CandidateVerdict>()

  if (!candidates.length) return results

  // Check each candidate using shared verdict function
  for (const candidate of candidates) {
    const verdict = await getDedupeVerdict(supabase, organisationId, {
      source_person_key: candidate.source_person_key,
      email: candidate.email,
      linkedin_url: candidate.linkedin_url,
    })
    results.set(candidate.source_person_key, verdict)
  }

  logger.info('sourcing/dedupe: batch check complete', {
    organisation_id: organisationId,
    total: candidates.length,
    new: Array.from(results.values()).filter(v => v === 'new').length,
    suppressed: Array.from(results.values()).filter(v => v === 'suppressed_match').length,
    duplicate_person_key: Array.from(results.values()).filter(v => v === 'duplicate_person_key').length,
    duplicate_linkedin: Array.from(results.values()).filter(v => v === 'duplicate_linkedin').length,
    duplicate_email: Array.from(results.values()).filter(v => v === 'duplicate_email').length,
  })

  return results
}

// All sourcing code paths (test, dedupe, orchestrator) use getDedupeVerdict from dedupe-verdict.ts
// This ensures suppression-first ordering and matching rules are consistent across all callers.
