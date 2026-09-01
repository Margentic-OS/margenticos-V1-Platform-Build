// src/lib/sourcing/verification-trigger.ts
//
// Email verification execution trigger for enriched prospects.
//
// Selection criteria (Amendment 2):
// (a) enriched rows where independent_email_status IS NULL (never verified)
// (b) enriched rows where independent_email_status='Grey-listed' AND
//     independent_verified_at < (now - 6 hours)
// AND, ACROSS BOTH, verification_attempt_count < MAX_RETRY_ATTEMPTS.
//
// The cap used to sit inside branch (b) only. Branch (a) had no bound at all, so a row whose
// probe threw stayed NULL and was re-selected every ten minutes for as long as it existed.
// Measured on 2026-09-01: 34 rows in one organisation, all carrying the same provider error,
// re-probed on every sweep with no state that could ever stop them.
//
// Lock pattern: verification_locked_at column, stale-reclaim after 30 minutes
// Rate limit: 30 emails per minute (enforced by batch spacing)
// Daily free limit: 100 verifications per day (Amendment 3, binding constraint)

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { myemailverifierHandler, type VerificationResult } from '@/lib/sourcing/handlers/adapter-myemailverifier'
import { checkSendEligibility } from '@/lib/sourcing/send-eligibility-rules'
import { excludeTierRejected } from '@/lib/sourcing/tier-verdict'

const STALE_LOCK_THRESHOLD_MINUTES = 30
const GREY_LISTED_RETRY_WINDOW_HOURS = 6
/**
 * How many times one address may be probed before it is left alone.
 *
 * Read here AND by the verify-pending cron route, which picks the organisation to serve.
 * Exported rather than duplicated: two copies of this number is the shape where the row
 * selector and the organisation selector drift apart and the sweep nominates an
 * organisation whose every row it will then decline to select.
 */
export const MAX_RETRY_ATTEMPTS = 3
const FREE_DAILY_LIMIT = 100
const RATE_LIMIT_PER_MINUTE = 30

/**
 * How many addresses one invocation attempts by default.
 *
 * SIZED AGAINST THE CLOCK, not the free tier. The loop sleeps 60000/RATE_LIMIT_PER_MINUTE =
 * 2s between addresses, so N addresses cost at least 2*(N-1) seconds of deliberate waiting
 * before any network time. The old default of 100 is ~198s of sleep plus up to 100 probes,
 * which cannot finish inside a 300s route.
 *
 * 40 is ~78s of sleep plus at most 40 * 20s of probe timeout in the pathological case. The
 * realistic case is well under half the budget, and anything not reached keeps its lock
 * released and is picked up by the next sweep.
 */
export const DEFAULT_VERIFY_BATCH_SIZE = 40

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
  maxBatchSize: number = DEFAULT_VERIFY_BATCH_SIZE,
): Promise<VerificationRun> {
  const operationId = `verify-${organisationId.slice(0, 8)}-${Date.now()}`

  // Every prospect this run has locked and not yet released. Each exit path removes its own
  // id; whatever is left when the outer catch fires is released there. Without this, a throw
  // anywhere after lock acquisition strands the entire remainder of the batch until the
  // stale reclaim, and before that reclaim existed, forever.
  const heldLocks = new Set<string>()

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
    // ── Step 1: Check daily free-tier usage ───────────────────────────────────
    //
    // THE QUOTA IS PER ACCOUNT, SO THE COUNT MUST BE TOO. This was scoped
    // `.eq('organisation_id', organisationId)` against a 100/day limit that belongs to the
    // MyEmailVerifier ACCOUNT, shared by every organisation on the platform. With one live
    // organisation that read correctly by accident. Five organisations already have prospect
    // rows, so the trigger for silent quota overrun is the SECOND organisation acquiring
    // enriched prospects — not the first paying client.
    //
    // The day boundary is UTC to match how the column is stored and how the vendor's own day
    // almost certainly rolls. setHours(0,0,0,0) used the SERVER's local midnight, which on a
    // machine outside UTC counts the wrong window entirely.
    const startOfDayUTC = new Date()
    startOfDayUTC.setUTCHours(0, 0, 0, 0)
    const todayISO = startOfDayUTC.toISOString()

    const { count: dailyCount, error: countError } = await supabase
      .from('prospects')
      .select('id', { count: 'exact', head: true })
      .gte('independent_verified_at', todayISO)
      .not('independent_email_status', 'is', null)

    if (countError) {
      logger.warn('verification-trigger: failed to count daily usage', {
        operation_id: operationId,
        error: countError.message,
      })
    }

    // A COUNT ERROR MUST NOT READ AS ZERO USED. The warning above is kept, but falling
    // through with `?? 0` told the run it had the entire day's quota free, which is the most
    // expensive possible guess. Treat an unreadable count as exhausted: verification is
    // resumable on the next sweep, an overrun is not.
    if (countError) {
      verificationRun.status = 'failed'
      verificationRun.error_message =
        `Could not read daily verification usage, so the free-tier budget is unknown: ${countError.message}`
      return verificationRun
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
    // AND, across both, verification_attempt_count < MAX_RETRY_ATTEMPTS

    const staleThresholdISO = new Date(
      Date.now() - GREY_LISTED_RETRY_WINDOW_HOURS * 60 * 60 * 1000,
    ).toISOString()

    // A lock older than this belonged to a run that died. Reclaiming it is safe because
    // verification is an idempotent lookup: the worst case of verifying the same address
    // twice is one wasted free-tier call, against the alternative of stranding it forever.
    const staleLockThresholdISO = new Date(
      Date.now() - STALE_LOCK_THRESHOLD_MINUTES * 60 * 1000,
    ).toISOString()

    // Cap batch size to daily remaining.
    //
    // KNOWN RESIDUAL, stated rather than hidden. dailyUsed counts prospects carrying a
    // verified_at, so a probe that CONSUMED quota and then failed is invisible to the next
    // run's count: there is no timestamped record of a failed call. Fixing that properly
    // needs a call-counter table, which is a separate change. What is fixed here is the
    // larger error, the per-organisation scoping, plus the in-run accounting below so a
    // single run cannot exceed its own budget by failing.
    const cappedBatchSize = Math.min(maxBatchSize, dailyRemaining)

    // Select (a) unverified, (b) Grey-listed retryable
    const lockableQuery = supabase
      .from('prospects')
      .select('id, email, country')
      .eq('organisation_id', organisationId)
      .eq('enrichment_status', 'enriched')
      .or(
        `independent_email_status.is.null,and(independent_email_status.eq.Grey-listed,independent_verified_at.lt.${staleThresholdISO})`,
      )
      // THE RETRY CAP, HOISTED OUT OF THE BRANCH IT USED TO LIVE IN.
      //
      // It was written inside the Grey-listed half of the .or() above, which left the
      // never-verified half unbounded: a row that fails on a provider error keeps a NULL
      // status, so it satisfied `independent_email_status.is.null` on every sweep, forever.
      // The counter was already being incremented on the failure path, and the comment there
      // says it exists precisely to stop this. It was written and never read.
      //
      // Chained filters are ANDed by PostgREST, so as its own filter the cap governs BOTH
      // branches and any branch added later. That is the point of putting it here rather than
      // repeating it inside each arm: a new arm cannot be written that escapes it.
      //
      // TERMINAL STATE. There is no new column and no new status string. A row that runs out
      // of attempts is already distinguishable from one that has never been tried:
      //   never attempted -> verification_attempt_count = 0, last_verification_error IS NULL
      //   given up on     -> verification_attempt_count >= MAX_RETRY_ATTEMPTS,
      //                      independent_email_status IS NULL, last_verification_error set
      // Checked live before relying on it: zero rows carry a NULL attempt count (the column
      // defaults to 0 and every writer reads-then-increments), and no row at count 0 carries
      // an error. A NULL count would be excluded by this filter, which is the one way this
      // could strand a never-tried row; the column default is what prevents it.
      .lt('verification_attempt_count', MAX_RETRY_ATTEMPTS)
      // THE STALE RECLAIM THE HEADER HAS ALWAYS PROMISED, and which did not exist.
      // STALE_LOCK_THRESHOLD_MINUTES was declared at the top of this file and referenced
      // nowhere in the repo, while the filter below read `.is(locked_at, null)` only. So a
      // prospect locked by a run that then died was unselectable FOREVER, with no recovery
      // path and nothing to say so.
      //
      // Chained filters are ANDed by PostgREST, so this reads:
      //   (never verified OR grey-listed and retryable) AND (unlocked OR lock gone stale)
      .or(`verification_locked_at.is.null,verification_locked_at.lt.${staleLockThresholdISO}`)

    // ── THE TIER GATE ────────────────────────────────────────────────────────
    //
    // Verification quota is spent per address and the free tier is 100 a day, so probing a
    // prospect tiering has already rejected takes the day's budget away from one that could
    // actually be emailed. Measured 2026-09-01: 15 unsuppressed rejected rows in the live
    // organisation had all been verified.
    //
    // excludeTierRejected, not requireTierPresent: a prospect tiering has not reached yet is
    // still worth verifying, and holding it back would make verification wait on tiering for
    // no reason. Only a REJECTION stops it. See src/lib/sourcing/tier-verdict.ts.
    const { data: lockableProspects, error: lockError } = await excludeTierRejected(lockableQuery)
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

    for (const id of prospectIds) heldLocks.add(id as string)

    logger.info('verification-trigger: lock acquired', {
      operation_id: operationId,
      organisation_id: organisationId,
      locked_count: prospectIds.length,
    })

    // ── Step 3: Verify each prospect ────────────────────────────────────────
    // Respect rate limit (30/minute): 1 email every 2 seconds
    const rateLimitDelayMs = (60 * 1000) / RATE_LIMIT_PER_MINUTE

    // Probes ATTEMPTED by this run, successful or not. Every attempt spends quota, so this
    // is what the budget must be measured against — not total_verified, which counts only
    // the ones that came back.
    let probesAttempted = 0

    for (let idx = 0; idx < lockableProspects.length; idx++) {
      const prospect = lockableProspects[idx]

      // Stop before spending past the budget. The remaining prospects keep their locks
      // released below and are picked up by the next sweep.
      if (probesAttempted >= dailyRemaining) {
        logger.info('verification-trigger: stopping, daily free tier reached mid-run', {
          operation_id: operationId,
          probes_attempted: probesAttempted,
          daily_remaining_at_start: dailyRemaining,
          not_processed: lockableProspects.length - idx,
        })
        verificationRun.status = 'partial'
        const unprocessed = lockableProspects.slice(idx).map(p => p.id as string)
        await supabase
          .from('prospects')
          .update({ verification_locked_at: null })
          .in('id', unprocessed)
          .eq('organisation_id', organisationId)
        for (const id of unprocessed) heldLocks.delete(id)
        break
      }

      if (!prospect.email) {
        logger.warn('verification-trigger: prospect has no email', {
          operation_id: operationId,
          prospect_id: prospect.id,
        })
        verificationRun.failed_count++
        // RELEASE. This path used to `continue` holding the lock, and a prospect with no
        // email never gets one from here, so it was locked permanently on every sweep.
        await releaseVerificationLock(supabase, organisationId, prospect.id, operationId)
        heldLocks.delete(prospect.id)
        continue
      }

      // Rate limit: sleep between requests
      if (idx > 0) {
        await new Promise(resolve => setTimeout(resolve, rateLimitDelayMs))
      }

      try {
        probesAttempted++
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

        // recordVerificationResult clears the lock on its own success path.
        heldLocks.delete(prospect.id)
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

        // RELEASE THE LOCK AND COUNT THE ATTEMPT, in one write.
        //
        // Both halves matter and neither was here. Without the release, any address whose
        // probe throws stays locked forever. Without the increment, adding the stale
        // reclaim above would have created a worse bug than the one it fixed: a
        // permanently bad address would be reclaimed every 30 minutes and re-probed
        // forever, burning the free tier on a call that cannot succeed. The retry cap at
        // MAX_RETRY_ATTEMPTS only bounds anything if failures actually count.
        const { data: current } = await supabase
          .from('prospects')
          .select('verification_attempt_count')
          .eq('id', prospect.id)
          .eq('organisation_id', organisationId)
          .maybeSingle()

        const { error: failWriteError } = await supabase
          .from('prospects')
          .update({
            last_verification_error: msg,
            verification_attempt_count: (current?.verification_attempt_count ?? 0) + 1,
            verification_locked_at: null,
          })
          .eq('id', prospect.id)
          .eq('organisation_id', organisationId)

        if (!failWriteError) heldLocks.delete(prospect.id)

        // A failed release is the one thing that reintroduces the permanent lock, so it is
        // logged at error rather than swallowed. The stale reclaim is the backstop.
        if (failWriteError) {
          logger.error('verification-trigger: could not release lock after a failed probe', {
            operation_id: operationId,
            prospect_id: prospect.id,
            error: failWriteError.message,
            consequence:
              'This prospect stays locked until the stale reclaim picks it up in ' +
              `${STALE_LOCK_THRESHOLD_MINUTES} minutes.`,
          })
        }
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

    // RELEASE WHATEVER THIS RUN STILL HOLDS. The per-prospect loop catches its own errors,
    // so reaching here means the failure was in selection, locking, or something outside the
    // loop entirely — and in the last case the whole remaining batch is still locked.
    if (heldLocks.size > 0) {
      logger.warn('verification-trigger: releasing locks held by a failed run', {
        operation_id: operationId,
        organisation_id: organisationId,
        held: heldLocks.size,
      })
      const { error: bulkReleaseError } = await supabase
        .from('prospects')
        .update({ verification_locked_at: null })
        .in('id', [...heldLocks])
        .eq('organisation_id', organisationId)
      if (bulkReleaseError) {
        logger.error('verification-trigger: bulk lock release failed', {
          operation_id: operationId,
          error: bulkReleaseError.message,
          consequence:
            `${heldLocks.size} prospect(s) stay locked until the stale reclaim picks them ` +
            `up in ${STALE_LOCK_THRESHOLD_MINUTES} minutes.`,
        })
      }
    }

    return verificationRun
  }
}

/**
 * Clear one prospect's verification lock.
 *
 * Separate from recordVerificationResult because the paths that need it MOST are the ones
 * that never reach a result: no email, a probe that threw, a run that died. Those were
 * exactly the paths that used to leave the lock set.
 */
async function releaseVerificationLock(
  supabase: SupabaseClient,
  organisationId: string,
  prospectId: string,
  operationId: string,
): Promise<void> {
  const { error } = await supabase
    .from('prospects')
    .update({ verification_locked_at: null })
    .eq('id', prospectId)
    .eq('organisation_id', organisationId)

  if (error) {
    logger.error('verification-trigger: lock release failed', {
      operation_id: operationId,
      prospect_id: prospectId,
      error: error.message,
      consequence:
        'This prospect stays locked until the stale reclaim picks it up in ' +
        `${STALE_LOCK_THRESHOLD_MINUTES} minutes.`,
    })
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
