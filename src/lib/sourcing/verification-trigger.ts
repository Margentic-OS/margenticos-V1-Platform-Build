// src/lib/sourcing/verification-trigger.ts
//
// Email verification execution trigger for enriched prospects.
//
// Selection criteria (Amendment 2):
// (a) enriched rows where independent_email_status IS NULL (never verified)
// (b) enriched rows where independent_email_status='Grey-listed' AND
//     independent_verified_at < (now - 6 hours) AND
//     verification_attempt_count < 3 (re-verifiable within retry window)
//
// Lock pattern: verification_locked_at column, stale-reclaim after 30 minutes
// Rate limit: 30 emails per minute (enforced by batch spacing)
// Daily free limit: 100 verifications per day (Amendment 3, binding constraint)

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { myemailverifierHandler, type VerificationResult } from '@/lib/sourcing/handlers/adapter-myemailverifier'
import { checkSendEligibility } from '@/lib/sourcing/send-eligibility-rules'

const STALE_LOCK_THRESHOLD_MINUTES = 30
const GREY_LISTED_RETRY_WINDOW_HOURS = 6
const MAX_RETRY_ATTEMPTS = 3
const FREE_DAILY_LIMIT = 100
const RATE_LIMIT_PER_MINUTE = 30

export interface VerificationRun {
  organisation_id: string
  batch_size: number
  total_verified: number
  send_eligible_count: number
  not_send_eligible_count: number
  grey_listed_retry_count: number
  failed_count: number
  verified_at: string
  status: 'success' | 'partial' | 'free_tier_exhausted' | 'failed'
  error_message?: string
  daily_verifications_used?: number
}

/**
 * Verify enriched prospects with independent email validator.
 * Independent of tiering (Amendment 1: parallel pass, not sequential gate).
 * Includes Grey-listed retry logic (Amendment 2).
 * Respects daily free-tier limit (Amendment 3).
 */
export async function verifyEnrichedBatch(
  supabase: SupabaseClient,
  organisationId: string,
  maxBatchSize: number = 100,
): Promise<VerificationRun> {
  const operationId = `verify-${organisationId.slice(0, 8)}-${Date.now()}`

  logger.info('verification-trigger: run started', {
    operation_id: operationId,
    organisation_id: organisationId,
    max_batch_size: maxBatchSize,
  })

  const verificationRun: VerificationRun = {
    organisation_id: organisationId,
    batch_size: 0,
    total_verified: 0,
    send_eligible_count: 0,
    not_send_eligible_count: 0,
    grey_listed_retry_count: 0,
    failed_count: 0,
    verified_at: new Date().toISOString(),
    status: 'success',
  }

  try {
    // ── Step 1: Check daily free-tier usage (Amendment 3) ─────────────────────
    // Query how many verifications have been run today (organisation-wide)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayISO = today.toISOString()

    const { count: dailyCount, error: countError } = await supabase
      .from('prospects')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', organisationId)
      .gte('independent_verified_at', todayISO)
      .not('independent_email_status', 'is', null)

    if (countError) {
      logger.warn('verification-trigger: failed to count daily usage', {
        operation_id: operationId,
        error: countError.message,
      })
    }

    const dailyUsed = dailyCount ?? 0
    const dailyRemaining = Math.max(0, FREE_DAILY_LIMIT - dailyUsed)

    logger.info('verification-trigger: daily free-tier check', {
      operation_id: operationId,
      daily_used: dailyUsed,
      daily_remaining: dailyRemaining,
      free_daily_limit: FREE_DAILY_LIMIT,
    })

    if (dailyRemaining <= 0) {
      logger.info('verification-trigger: daily free-tier exhausted', {
        operation_id: operationId,
        organisation_id: organisationId,
      })
      verificationRun.status = 'free_tier_exhausted'
      verificationRun.daily_verifications_used = dailyUsed
      return verificationRun
    }

    // ── Step 2: Acquire lock on unverified enriched prospects ─────────────────
    // Selection criteria (Amendment 2):
    // (a) enriched rows where independent_email_status IS NULL
    // (b) enriched rows where independent_email_status='Grey-listed'
    //     AND independent_verified_at < (now - 6 hours)
    //     AND verification_attempt_count < 3

    const staleThresholdISO = new Date(
      Date.now() - GREY_LISTED_RETRY_WINDOW_HOURS * 60 * 60 * 1000,
    ).toISOString()

    // Cap batch size to daily remaining
    const cappedBatchSize = Math.min(maxBatchSize, dailyRemaining)

    // Select (a) unverified, (b) Grey-listed retryable
    const { data: lockableProspects, error: lockError } = await supabase
      .from('prospects')
      .select('id, email, country')
      .eq('organisation_id', organisationId)
      .eq('enrichment_status', 'enriched')
      .or(
        `independent_email_status.is.null,and(independent_email_status.eq.Grey-listed,independent_verified_at.lt.${staleThresholdISO},verification_attempt_count.lt.${MAX_RETRY_ATTEMPTS})`,
      )
      .is('verification_locked_at', null)
      .limit(cappedBatchSize)

    if (lockError) {
      logger.error('verification-trigger: lock select failed', {
        operation_id: operationId,
        organisation_id: organisationId,
        error: lockError.message,
      })
      throw new Error(`Failed to select lockable prospects: ${lockError.message}`)
    }

    if (!lockableProspects || lockableProspects.length === 0) {
      logger.info('verification-trigger: no lockable prospects found', {
        operation_id: operationId,
        organisation_id: organisationId,
      })
      verificationRun.daily_verifications_used = dailyUsed
      return verificationRun
    }

    const prospectIds = lockableProspects.map(p => p.id)

    logger.info('verification-trigger: lockable prospects selected', {
      operation_id: operationId,
      organisation_id: organisationId,
      selected_count: prospectIds.length,
    })

    // Acquire lock atomically on selected prospects
    const { error: updateLockError } = await supabase
      .from('prospects')
      .update({ verification_locked_at: new Date().toISOString() })
      .in('id', prospectIds)
      .eq('organisation_id', organisationId)

    if (updateLockError) {
      logger.error('verification-trigger: lock acquisition failed', {
        operation_id: operationId,
        organisation_id: organisationId,
        error: updateLockError.message,
      })
      throw new Error(`Failed to acquire lock: ${updateLockError.message}`)
    }

    logger.info('verification-trigger: lock acquired', {
      operation_id: operationId,
      organisation_id: organisationId,
      locked_count: prospectIds.length,
    })

    // ── Step 3: Verify each prospect ────────────────────────────────────────
    // Respect rate limit (30/minute): 1 email every 2 seconds
    const rateLimitDelayMs = (60 * 1000) / RATE_LIMIT_PER_MINUTE

    for (let idx = 0; idx < lockableProspects.length; idx++) {
      const prospect = lockableProspects[idx]

      if (!prospect.email) {
        logger.warn('verification-trigger: prospect has no email', {
          operation_id: operationId,
          prospect_id: prospect.id,
        })
        verificationRun.failed_count++
        continue
      }

      // Rate limit: sleep between requests
      if (idx > 0) {
        await new Promise(resolve => setTimeout(resolve, rateLimitDelayMs))
      }

      try {
        const result = await myemailverifierHandler.execute(prospect.email)
        await recordVerificationResult(supabase, organisationId, prospect.id, result, operationId, prospect.country, prospect.email)

        if (result.send_eligible) {
          verificationRun.send_eligible_count++
        } else {
          verificationRun.not_send_eligible_count++
        }

        if (result.status === 'Grey-listed') {
          verificationRun.grey_listed_retry_count++
        }

        verificationRun.total_verified++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('verification-trigger: verification failed', {
          operation_id: operationId,
          prospect_id: prospect.id,
          email: prospect.email,
          error: msg,
        })
        verificationRun.failed_count++

        // Record error on prospect
        await supabase
          .from('prospects')
          .update({ last_verification_error: msg })
          .eq('id', prospect.id)
          .eq('organisation_id', organisationId)
      }
    }

    verificationRun.batch_size = prospectIds.length
    verificationRun.daily_verifications_used = dailyUsed + verificationRun.total_verified

    logger.info('verification-trigger: run completed', {
      operation_id: operationId,
      organisation_id: organisationId,
      status: verificationRun.status,
      total_verified: verificationRun.total_verified,
      send_eligible: verificationRun.send_eligible_count,
      not_eligible: verificationRun.not_send_eligible_count,
      grey_listed_retries: verificationRun.grey_listed_retry_count,
      failed: verificationRun.failed_count,
      daily_used: verificationRun.daily_verifications_used,
    })

    return verificationRun
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('verification-trigger: run failed', {
      operation_id: operationId,
      organisation_id: organisationId,
      error: msg,
    })
    verificationRun.status = 'failed'
    verificationRun.error_message = msg
    return verificationRun
  }
}

/**
 * Record verification result on a single prospect.
 * Updates: independent_email_status, email_send_eligible, email_send_ineligible_reason,
 *          independent_verified_at, verification_attempt_count, verification_provider,
 *          verification_locked_at
 *
 * Also checks send eligibility rules (country exclusions) and sets reason if ineligible.
 */
async function recordVerificationResult(
  supabase: SupabaseClient,
  organisationId: string,
  prospectId: string,
  result: VerificationResult,
  operationId: string,
  country: string | null,
  email: string | null,
): Promise<void> {
  // Increment attempt count if this is a retry
  const { data: currentProspect } = await supabase
    .from('prospects')
    .select('verification_attempt_count')
    .eq('id', prospectId)
    .eq('organisation_id', organisationId)
    .maybeSingle()

  const newAttemptCount = (currentProspect?.verification_attempt_count ?? 0) + 1

  // Check send eligibility rules (country exclusions, etc.)
  const eligibilityCheck = checkSendEligibility(country, email)

  const { error } = await supabase
    .from('prospects')
    .update({
      independent_email_status: result.status,
      email_send_eligible: eligibilityCheck.is_eligible && result.send_eligible,
      email_send_ineligible_reason: eligibilityCheck.reason,
      independent_verified_at: result.verified_at,
      verification_attempt_count: newAttemptCount,
      verification_provider: 'myemailverifier',
      verification_locked_at: null, // Release lock
      last_verification_error: null, // Clear error
    })
    .eq('id', prospectId)
    .eq('organisation_id', organisationId)

  if (error) {
    logger.error('verification-trigger: failed to record verification result', {
      operation_id: operationId,
      prospect_id: prospectId,
      email: result.email,
      error: error.message,
    })
  } else {
    logger.info('verification-trigger: prospect verified and updated', {
      operation_id: operationId,
      prospect_id: prospectId,
      email: result.email,
      status: result.status,
      send_eligible: result.send_eligible,
      attempt_count: newAttemptCount,
    })
  }
}
