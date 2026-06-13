// src/lib/sourcing/dedupe-verdict.ts
//
// Shared deduplication verdict logic for prospect sourcing and enrichment.
// Used by both checkCandidates (for new sourced candidates) and enrichment recheck
// (for enriched prospects with newly populated identity fields).
//
// Verdict order (first match wins):
//   1. Suppression match (person_key, linkedin, email) - compliance signal
//   2. Duplicate person_key (unsuppressed)
//   3. Duplicate linkedin (unsuppressed, no person_key match)
//   4. Duplicate email (unsuppressed, no person_key or linkedin match)
//   5. No match - 'new'
//
// CRITICAL: All queries carry explicit organisation_id filter even when RLS would catch it.

import { createClient } from '@supabase/supabase-js'
import { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import { normaliseLinkedInUrl } from './normalise-linkedin'

type SupabaseServiceClient = ReturnType<typeof createClient<Database>>

export type CandidateVerdict =
  | 'suppressed_match'
  | 'duplicate_person_key'
  | 'duplicate_linkedin'
  | 'duplicate_email'
  | 'new'

export interface DedupeVerdictInput {
  source_person_key: string // always present
  email?: string | null     // from enrichment or sourcing
  linkedin_url?: string | null // from enrichment or sourcing
}

/**
 * Get deduplication verdict for a single prospect identity.
 * Returns the first match found in order: suppression, person_key dup, linkedin dup, email dup, new.
 * Used by both initial sourcing dedupe and post-enrichment recheck.
 */
export async function getDedupeVerdict(
  supabase: SupabaseServiceClient,
  organisationId: string,
  input: DedupeVerdictInput,
): Promise<CandidateVerdict> {
  const { source_person_key, email, linkedin_url } = input
  const linkedin_url_normalised = linkedin_url ? normaliseLinkedInUrl(linkedin_url) : null

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Suppression check first (compliance signal - highest priority)
  // ─────────────────────────────────────────────────────────────────────────────

  // Check by person_key
  if (source_person_key) {
    const { data: pkMatch, error: pkError } = await supabase
      .from('prospects')
      .select('source_person_key')
      .eq('organisation_id', organisationId)
      .eq('suppressed', true)
      .eq('source_person_key', source_person_key)
      .maybeSingle()

    if (pkError) {
      logger.error('dedupe-verdict: suppressed person_key query failed', {
        organisation_id: organisationId,
        error: pkError.message,
      })
    } else if (pkMatch) {
      return 'suppressed_match'
    }
  }

  // Check by normalised LinkedIn URL
  if (linkedin_url_normalised) {
    const { data: liMatch, error: liError } = await supabase
      .from('prospects')
      .select('linkedin_url_normalised')
      .eq('organisation_id', organisationId)
      .eq('suppressed', true)
      .eq('linkedin_url_normalised', linkedin_url_normalised)
      .maybeSingle()

    if (liError) {
      logger.error('dedupe-verdict: suppressed linkedin query failed', {
        organisation_id: organisationId,
        error: liError.message,
      })
    } else if (liMatch) {
      return 'suppressed_match'
    }
  }

  // Check by email (case-insensitive)
  if (email) {
    const lowerEmail = email.toLowerCase()
    const { data: emailMatch, error: emailError } = await supabase
      .from('prospects')
      .select('email')
      .eq('organisation_id', organisationId)
      .eq('suppressed', true)
      .eq('email', lowerEmail)
      .maybeSingle()

    if (emailError) {
      logger.error('dedupe-verdict: suppressed email query failed', {
        organisation_id: organisationId,
        error: emailError.message,
      })
    } else if (emailMatch) {
      return 'suppressed_match'
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Duplicate checks (in order: person_key, linkedin, email)
  // ─────────────────────────────────────────────────────────────────────────────

  // Check person_key duplicate (unsuppressed)
  if (source_person_key) {
    const { data: pkDupe, error: pkError } = await supabase
      .from('prospects')
      .select('source_person_key')
      .eq('organisation_id', organisationId)
      .eq('source_person_key', source_person_key)
      .is('suppressed', false)
      .maybeSingle()

    if (pkError) {
      logger.error('dedupe-verdict: person_key duplicate query failed', {
        organisation_id: organisationId,
        error: pkError.message,
      })
    } else if (pkDupe) {
      return 'duplicate_person_key'
    }
  }

  // Check linkedin duplicate (unsuppressed, no person_key match already)
  if (linkedin_url_normalised) {
    const { data: liDupe, error: liError } = await supabase
      .from('prospects')
      .select('linkedin_url_normalised')
      .eq('organisation_id', organisationId)
      .eq('linkedin_url_normalised', linkedin_url_normalised)
      .is('suppressed', false)
      .maybeSingle()

    if (liError) {
      logger.error('dedupe-verdict: linkedin duplicate query failed', {
        organisation_id: organisationId,
        error: liError.message,
      })
    } else if (liDupe) {
      return 'duplicate_linkedin'
    }
  }

  // Check email duplicate (unsuppressed, no person_key or linkedin match already)
  if (email) {
    const lowerEmail = email.toLowerCase()
    const { data: emailDupe, error: emailError } = await supabase
      .from('prospects')
      .select('email')
      .eq('organisation_id', organisationId)
      .eq('email', lowerEmail)
      .is('suppressed', false)
      .not('email', 'is', null)
      .maybeSingle()

    if (emailError) {
      logger.error('dedupe-verdict: email duplicate query failed', {
        organisation_id: organisationId,
        error: emailError.message,
      })
    } else if (emailDupe) {
      return 'duplicate_email'
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. No match found
  // ─────────────────────────────────────────────────────────────────────────────

  return 'new'
}
