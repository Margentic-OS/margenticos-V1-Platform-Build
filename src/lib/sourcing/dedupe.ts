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

  // Initialise all candidates as 'new'; overwrite with verdicts as matches are found
  for (const candidate of candidates) {
    results.set(candidate.source_person_key, 'new')
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Suppression check first (compliance signal — must run before any duplicate check)
  // ─────────────────────────────────────────────────────────────────────────────

  const suppressed = await querySuppressedMatches(supabase, organisationId, candidates)
  for (const match of suppressed) {
    results.set(match.source_person_key, 'suppressed_match')
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Duplicate checks (in order: person_key, linkedin, email)
  // ─────────────────────────────────────────────────────────────────────────────

  // Only check candidates that haven't already matched suppression
  const unsuppressed = candidates.filter(c => !suppressed.some(s => s.source_person_key === c.source_person_key))

  // Check person_key duplicates
  const personKeyDupes = await queryPersonKeyDuplicates(supabase, organisationId, unsuppressed)
  for (const match of personKeyDupes) {
    // Only set if not already set (suppression takes precedence)
    if (results.get(match.source_person_key) === 'new') {
      results.set(match.source_person_key, 'duplicate_person_key')
    }
  }

  // Check LinkedIn URL duplicates (only candidates without person_key match)
  const noPersonKeyMatch = unsuppressed.filter(
    c => !personKeyDupes.some(d => d.source_person_key === c.source_person_key),
  )
  const linkedinDupes = await queryLinkedInDuplicates(supabase, organisationId, noPersonKeyMatch)
  for (const match of linkedinDupes) {
    if (results.get(match.source_person_key) === 'new') {
      results.set(match.source_person_key, 'duplicate_linkedin')
    }
  }

  // Check email duplicates (only candidates without person_key or LinkedIn match)
  const noLinkedInMatch = noPersonKeyMatch.filter(
    c => !linkedinDupes.some(d => d.source_person_key === c.source_person_key),
  )
  const emailDupes = await queryEmailDuplicates(supabase, organisationId, noLinkedInMatch)
  for (const match of emailDupes) {
    if (results.get(match.source_person_key) === 'new') {
      results.set(match.source_person_key, 'duplicate_email')
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// Query helpers: batched per dimension. Map query results back to candidates.
// ─────────────────────────────────────────────────────────────────────────────

async function querySuppressedMatches(
  supabase: SupabaseServiceClient,
  organisationId: string,
  candidates: ProspectCandidate[],
): Promise<DuplicateMatch[]> {
  // Build maps from candidate data to candidate for result mapping
  const personKeyToCandidate = new Map(
    candidates.filter(c => c.source_person_key).map(c => [c.source_person_key, c]),
  )
  const linkedinToCandidate = new Map(
    candidates
      .filter((c): c is typeof c & { linkedin_url: string } => c.linkedin_url !== null && c.linkedin_url !== undefined)
      .map(c => [normaliseLinkedInUrl(c.linkedin_url)!, c]),
  )
  const emailToCandidate = new Map(
    candidates
      .filter(c => c.email)
      .map(c => [(c.email || '').toLowerCase(), c]),
  )

  const matchedCandidateKeys = new Set<string>()
  const matches: DuplicateMatch[] = []

  // Query by person_key
  if (personKeyToCandidate.size) {
    const personKeys = Array.from(personKeyToCandidate.keys())
    const { data: pkMatches, error: pkError } = await supabase
      .from('prospects')
      .select('source_person_key')
      .eq('organisation_id', organisationId)
      .eq('suppressed', true)
      .in('source_person_key', personKeys)

    if (pkError) {
      logger.error('sourcing/dedupe: suppressed person_key query failed', {
        organisation_id: organisationId,
        error: pkError.message,
      })
    } else if (pkMatches) {
      for (const row of pkMatches) {
        const matchedDbKey = row.source_person_key as string
        const candidate = personKeyToCandidate.get(matchedDbKey)
        if (candidate && !matchedCandidateKeys.has(candidate.source_person_key)) {
          matches.push({ source_person_key: candidate.source_person_key, verdict: 'suppressed_match' })
          matchedCandidateKeys.add(candidate.source_person_key)
        }
      }
    }
  }

  // Query by normalised LinkedIn URL
  if (linkedinToCandidate.size) {
    const normalisedUrls = Array.from(linkedinToCandidate.keys())
    const { data: liMatches, error: liError } = await supabase
      .from('prospects')
      .select('linkedin_url_normalised')
      .eq('organisation_id', organisationId)
      .eq('suppressed', true)
      .in('linkedin_url_normalised', normalisedUrls)

    if (liError) {
      logger.error('sourcing/dedupe: suppressed linkedin query failed', {
        organisation_id: organisationId,
        error: liError.message,
      })
    } else if (liMatches) {
      for (const row of liMatches) {
        const normalisedUrl = row.linkedin_url_normalised as string
        const candidate = linkedinToCandidate.get(normalisedUrl)
        if (candidate && !matchedCandidateKeys.has(candidate.source_person_key)) {
          matches.push({ source_person_key: candidate.source_person_key, verdict: 'suppressed_match' })
          matchedCandidateKeys.add(candidate.source_person_key)
        }
      }
    }
  }

  // Query by email (case-insensitive)
  if (emailToCandidate.size) {
    const lowerEmails = Array.from(emailToCandidate.keys())
    const { data: emailMatches, error: emailError } = await supabase
      .from('prospects')
      .select('email')
      .eq('organisation_id', organisationId)
      .eq('suppressed', true)
      .in('email', lowerEmails)

    if (emailError) {
      logger.error('sourcing/dedupe: suppressed email query failed', {
        organisation_id: organisationId,
        error: emailError.message,
      })
    } else if (emailMatches) {
      for (const row of emailMatches) {
        const lowerEmail = ((row.email as string) || '').toLowerCase()
        const candidate = emailToCandidate.get(lowerEmail)
        if (candidate && !matchedCandidateKeys.has(candidate.source_person_key)) {
          matches.push({ source_person_key: candidate.source_person_key, verdict: 'suppressed_match' })
          matchedCandidateKeys.add(candidate.source_person_key)
        }
      }
    }
  }

  return matches
}

async function queryPersonKeyDuplicates(
  supabase: SupabaseServiceClient,
  organisationId: string,
  candidates: ProspectCandidate[],
): Promise<DuplicateMatch[]> {
  const candidatesByPersonKey = new Map(candidates.map(c => [c.source_person_key, c]))
  const personKeys = Array.from(candidatesByPersonKey.keys())
  if (!personKeys.length) return []

  const { data, error } = await supabase
    .from('prospects')
    .select('source_person_key')
    .eq('organisation_id', organisationId)
    .in('source_person_key', personKeys)
    .is('suppressed', false)

  if (error) {
    logger.error('sourcing/dedupe: person_key query failed', {
      organisation_id: organisationId,
      error: error.message,
    })
    return []
  }

  return (data || []).map(row => ({
    source_person_key: row.source_person_key as string,
    verdict: 'duplicate_person_key' as const,
  }))
}

async function queryLinkedInDuplicates(
  supabase: SupabaseServiceClient,
  organisationId: string,
  candidates: ProspectCandidate[],
): Promise<DuplicateMatch[]> {
  const linkedinToCandidate = new Map(
    candidates
      .filter((c): c is typeof c & { linkedin_url: string } => c.linkedin_url !== null && c.linkedin_url !== undefined)
      .map(c => [normaliseLinkedInUrl(c.linkedin_url)!, c]),
  )
  if (!linkedinToCandidate.size) return []

  const normalisedUrls = Array.from(linkedinToCandidate.keys())

  const { data, error } = await supabase
    .from('prospects')
    .select('linkedin_url_normalised')
    .eq('organisation_id', organisationId)
    .in('linkedin_url_normalised', normalisedUrls)
    .is('suppressed', false)

  if (error) {
    logger.error('sourcing/dedupe: linkedin query failed', {
      organisation_id: organisationId,
      error: error.message,
    })
    return []
  }

  return (data || []).map(row => {
    const normalisedUrl = row.linkedin_url_normalised as string
    const candidate = linkedinToCandidate.get(normalisedUrl)
    return {
      source_person_key: candidate!.source_person_key,
      verdict: 'duplicate_linkedin' as const,
    }
  })
}

async function queryEmailDuplicates(
  supabase: SupabaseServiceClient,
  organisationId: string,
  candidates: ProspectCandidate[],
): Promise<DuplicateMatch[]> {
  const emailToCandidate = new Map(
    candidates
      .filter(c => c.email)
      .map(c => [(c.email || '').toLowerCase(), c]),
  )
  if (!emailToCandidate.size) return []

  const lowerEmails = Array.from(emailToCandidate.keys())

  const { data, error } = await supabase
    .from('prospects')
    .select('email')
    .eq('organisation_id', organisationId)
    .in('email', lowerEmails)
    .is('suppressed', false)
    .not('email', 'is', null)

  if (error) {
    logger.error('sourcing/dedupe: email query failed', {
      organisation_id: organisationId,
      error: error.message,
    })
    return []
  }

  return (data || []).map(row => {
    const lowerEmail = ((row.email as string) || '').toLowerCase()
    const candidate = emailToCandidate.get(lowerEmail)
    return {
      source_person_key: candidate!.source_person_key,
      verdict: 'duplicate_email' as const,
    }
  })
}

// normaliseLinkedInUrl is imported from ./normalise-linkedin
// All sourcing code paths (test, dedupe, orchestrator) must use the same function
