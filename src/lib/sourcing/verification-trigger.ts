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
// Rate limit: read from integrations_registry at run time, NOT compiled in, and held by a
// PACER rather than by batch spacing. It was `const RATE_LIMIT_PER_MINUTE = 30` while
// `config.rate_limit_per_minute` sat on the registry row unread since 2026-09-04. See
// src/lib/sourcing/verification-pacing.ts for what the pacer does and why a flat sleep
// undershot the limit by whatever the probe cost.
// Daily limit: read from integrations_registry at run time, NOT compiled in. It was
// `const FREE_DAILY_LIMIT = 100`, the validator's free-tier allowance, and the account left
// that tier on 2026-09-01. See src/lib/sourcing/verification-limits.ts.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { myemailverifierHandler, type VerificationResult } from '@/lib/sourcing/handlers/adapter-myemailverifier'
import { checkSendEligibility, firstPassSendEligibility } from '@/lib/sourcing/send-eligibility-rules'
import {
  getDailyVerificationLimit,
  getVerificationRateLimit,
  FALLBACK_RATE_LIMIT_PER_MINUTE,
} from '@/lib/sourcing/verification-limits'
import {
  createPacer,
  pacedIntervalMs,
  probesWithinBudget,
  systemPacingClock,
  DEFAULT_RUN_BUDGET_MS,
  type PacingClock,
} from '@/lib/sourcing/verification-pacing'
import {
  selectPendingVerification,
  type VerificationThresholds,
} from '@/lib/sourcing/pending-verification'

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

/**
 * The three thresholds the pending-verification filter compares against, from the constants
 * above.
 *
 * EXPORTED, because the pipeline screen counts the same rows this sweep locks and must not
 * own a second copy of "6 hours" or "30 minutes". The durations stay here, beside the retry
 * policy they belong to; only the resolved moments travel.
 *
 * Computed per call, never cached. Both thresholds are relative to now, and a module-level
 * constant would freeze them at import time: a long-lived server process would then keep
 * asking about a window that stopped moving, which is a stale-marker bug rather than a
 * rounding one.
 */
export function verificationThresholds(): VerificationThresholds {
  return {
    staleThresholdISO: new Date(
      Date.now() - GREY_LISTED_RETRY_WINDOW_HOURS * 60 * 60 * 1000,
    ).toISOString(),
    // A lock older than this belonged to a run that died. Reclaiming it is safe because
    // verification is an idempotent lookup: the worst case of verifying the same address
    // twice is one wasted free-tier call, against the alternative of stranding it forever.
    staleLockThresholdISO: new Date(
      Date.now() - STALE_LOCK_THRESHOLD_MINUTES * 60 * 1000,
    ).toISOString(),
    maxRetryAttempts: MAX_RETRY_ATTEMPTS,
  }
}
/**
 * How many addresses one invocation may attempt, as a CEILING rather than as the plan.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS NO LONGER THE BINDING CONSTRAINT, AND THAT IS THE POINT
 *
 * It used to be 40, sized so that forty flat two-second sleeps fit inside a 300-second
 * route with room to spare. That made the BATCH SIZE the thing limiting throughput rather
 * than the provider: about 240 addresses an hour against an allowance of 1,800, with the
 * run finishing after roughly eighty seconds of a six-hundred-second period and the rest
 * of the window idle.
 *
 * What bounds a run now is the DEADLINE the caller passes and the daily budget, both of
 * which are real limits rather than a number picked to be safe. This constant survives as
 * the ceiling for a caller that passes no deadline at all, and it is DERIVED from the
 * default budget and the fallback pace so it cannot disagree with them: whatever a
 * full-length run could achieve, this permits, and no more.
 *
 * Derived, not written down, for the reason CLAUDE.md gives about literals that have to
 * track each other: a hand-maintained 108 here would silently stop matching the budget the
 * first time either number moved.
 */
export const DEFAULT_VERIFY_BATCH_SIZE = probesWithinBudget(
  DEFAULT_RUN_BUDGET_MS,
  pacedIntervalMs(FALLBACK_RATE_LIMIT_PER_MINUTE),
)

/**
 * The knobs a caller may set on one run. All optional; the defaults are production's.
 *
 * `deadlineAt` is an ABSOLUTE moment, not a duration, and that is deliberate. The cron route
 * computes it from the moment the REQUEST started, so the tiering pass that runs before this
 * function is charged against the same window. A duration would restart the clock here and
 * quietly grant the run whatever tiering had already spent.
 */
export interface VerifyBatchOptions {
  /** Stop before starting a probe at or after this moment. Absent means only the ceiling binds. */
  deadlineAt?: number
  /** Injected so a test can measure the achieved pace without spending the wall clock on it. */
  clock?: PacingClock
}

export interface VerificationRun {
  organisation_id: string
  batch_size: number
  total_verified: number
  send_eligible_count: number
  not_send_eligible_count: number
  grey_listed_retry_count: number
  failed_count: number
  verified_at: string
  // 'free_tier_exhausted' is a HISTORICAL NAME kept as-is because the verify-pending route
  // and its tests branch on the literal. It means "the daily budget is used up", whatever
  // tier the account is on. The budget itself is config, not the free tier. See
  // verification-limits.ts.
  status: 'success' | 'partial' | 'free_tier_exhausted' | 'failed'
  error_message?: string
  daily_verifications_used?: number
  /**
   * Prospects the country rule decided WITHOUT a probe. Each one is a probe not spent, out of
   * a daily budget that is finite and shared across every organisation.
   */
  skipped_excluded_country?: number
}

/**
 * THE RUN'S OWN VERDICT, DERIVED FROM WHAT IT ACTUALLY DID.
 *
 * ── THE DEFECT THIS EXISTS FOR ──
 *
 * `status` is initialised to 'success' and was only ever changed by the paths that return
 * EARLY: the budget check, the daily-limit check, and the outer catch. The per-prospect loop
 * catches its own errors and only increments `failed_count`, so a run in which EVERY probe
 * threw fell through to the end still reading 'success'.
 *
 * Measured 2026-09-15: a local run against a stale MyEmailVerifier key returned HTTP 401 on
 * all 29 addresses, wrote no verdict for any of them, and reported status 'success' with
 * failed_count 29 and total_verified 0.
 *
 * That is not cosmetic, because the SCHEDULED job reads this same field.
 * src/app/api/cron/verify-pending/route.ts computes `ok = run.status !== 'failed'` and uses
 * it for both the cron heartbeat and the Sentry check-in. A wholly failed sweep therefore
 * wrote a HEALTHY heartbeat and a GREEN check-in, and MON-002 had nothing to notice. This is
 * the same family as the monitor sweep whose loop was bounded by the shorter of two arrays:
 * a check that runs, reports success, and never reached the thing it was meant to protect.
 *
 * ── WHY DERIVED RATHER THAN ASSIGNED ──
 *
 * Assigning at each exit site is what failed the first time: the loop was one more exit that
 * nobody remembered. This reads the counters the run kept anyway, so a new exit path cannot
 * forget it, and the rule lives in one testable place instead of being spread across the
 * function. Exported so a test can mutation-prove it directly.
 */
export function deriveRunStatus(run: {
  total_verified: number
  failed_count: number
  status: VerificationRun['status']
}): VerificationRun['status'] {
  // A run that already reached a terminal verdict of its own keeps it. 'failed' is already
  // the worst answer, and 'free_tier_exhausted' is a BUDGET state the verify-pending route
  // branches on by literal, so it must survive.
  if (run.status === 'failed' || run.status === 'free_tier_exhausted') return run.status

  const attempted = run.total_verified + run.failed_count

  // Nothing was attempted. Having nothing to do is the normal resting state of this sweep,
  // not a fault, and reporting it as one would train the alarm to be ignored.
  if (attempted === 0) return run.status

  // Something was attempted and NOTHING succeeded. A failure whatever the cause, and this is
  // precisely the case that used to report success.
  if (run.total_verified === 0) return 'failed'

  // Some worked, some did not.
  if (run.failed_count > 0) return 'partial'

  return run.status
}

/**
 * Verify enriched prospects with independent email validator.
 * Independent of tiering (Amendment 1: parallel pass, not sequential gate).
 * Includes Grey-listed retry logic (Amendment 2).
 * Respects the daily verification budget read from the integrations registry.
 */
export async function verifyEnrichedBatch(
  supabase: SupabaseClient,
  organisationId: string,
  maxBatchSize: number = DEFAULT_VERIFY_BATCH_SIZE,
  options: VerifyBatchOptions = {},
): Promise<VerificationRun> {
  const clock = options.clock ?? systemPacingClock
  const deadlineAt = options.deadlineAt ?? null
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

    // THE LIMIT IS CONFIG, NOT A CONSTANT. Read after the usage count and before the cap,
    // so a change to the registry row takes effect on the very next sweep with no deploy.
    // The source is logged beside the value: a run that quietly fell back to the compiled
    // default and one that read a real config row must not look identical in the logs.
    const { limit: dailyLimit, source: limitSource, reason: limitReason } =
      await getDailyVerificationLimit(supabase)

    // THE PACE IS CONFIG TOO, read from the same row by the same function family. Read here
    // rather than at module load so raising the provider's allowance takes effect on the next
    // sweep with no deploy, which is the entire reason it is not a constant any more.
    const {
      limitPerMinute: rateLimitPerMinute,
      source: rateSource,
      reason: rateReason,
    } = await getVerificationRateLimit(supabase)

    const intervalMs = pacedIntervalMs(rateLimitPerMinute)

    const dailyUsed = dailyCount ?? 0
    const dailyRemaining = Math.max(0, dailyLimit - dailyUsed)

    logger.info('verification-trigger: daily budget check', {
      operation_id: operationId,
      daily_used: dailyUsed,
      daily_remaining: dailyRemaining,
      daily_limit: dailyLimit,
      daily_limit_source: limitSource,
      daily_limit_fallback_reason: limitReason,
      rate_limit_per_minute: rateLimitPerMinute,
      rate_limit_source: rateSource,
      rate_limit_fallback_reason: rateReason,
      paced_interval_ms: intervalMs,
    })

    if (dailyRemaining <= 0) {
      logger.info('verification-trigger: daily budget exhausted', {
        operation_id: operationId,
        organisation_id: organisationId,
        daily_limit: dailyLimit,
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

    // Cap batch size to daily remaining.
    //
    // KNOWN RESIDUAL, stated rather than hidden. dailyUsed counts prospects carrying a
    // verified_at, so a probe that CONSUMED quota and then failed is invisible to the next
    // run's count: there is no timestamped record of a failed call. Fixing that properly
    // needs a call-counter table, which is a separate change. What is fixed here is the
    // larger error, the per-organisation scoping, plus the in-run accounting below so a
    // single run cannot exceed its own budget by failing.
    // ── THREE CEILINGS, AND THE RUN TAKES THE SMALLEST ───────────────────────
    //
    //   maxBatchSize    what the caller permits at most.
    //   dailyRemaining  what the account's daily budget still allows.
    //   fitsInWindow    what the clock allows, at the paced interval, before the deadline.
    //
    // The third is new and is what turns a fixed forty into a run that uses its window. It
    // is computed from the time ACTUALLY LEFT rather than from the full budget, so the
    // tiering pass that ran before this function is already subtracted: a slow tiering pass
    // shortens this run instead of pushing it past the deadline.
    //
    // Selecting more rows than can be probed would be worse than useless. Every selected row
    // is LOCKED up front, so an over-long selection locks addresses this run will not reach,
    // and the next sweep declines to select them until the lock goes stale.
    const fitsInWindow = deadlineAt === null
      ? Number.POSITIVE_INFINITY
      : probesWithinBudget(deadlineAt - clock.now(), intervalMs)

    const cappedBatchSize = Math.min(maxBatchSize, dailyRemaining, fitsInWindow)

    // Out of time before selecting anything. Not a failure: the window closed, the rows keep
    // their unlocked state, and the next firing takes them. Returning early also avoids a
    // `.limit(0)` select, which PostgREST answers with every row rather than with none.
    if (cappedBatchSize <= 0) {
      logger.info('verification-trigger: no time left in this run to probe anything', {
        operation_id: operationId,
        organisation_id: organisationId,
        ms_to_deadline: deadlineAt === null ? null : deadlineAt - clock.now(),
      })
      verificationRun.daily_verifications_used = dailyUsed
      return verificationRun
    }

    // Select (a) unverified, (b) Grey-listed retryable.
    //
    // THE FILTER LIVES IN pending-verification.ts AND IS APPLIED, NOT RESTATED. It used to
    // be written out here and only here, which meant the operator screen could not show how
    // many prospects were waiting without writing the same condition a second time. One
    // definition, two callers: this sweep, and the count the pipeline screen renders.
    //
    // The tier gate moved with it, unchanged. excludeTierRejected, not requireTierPresent:
    // a prospect tiering has not reached yet is still worth verifying, and only a REJECTION
    // stops it. Verification quota is spent per address and the daily budget is finite, so
    // probing a prospect tiering has already rejected takes the day's budget away from one
    // that could actually be emailed. Measured 2026-09-01: 15 unsuppressed rejected rows in
    // the live organisation had all been verified.
    const lockableQuery = selectPendingVerification(
      supabase
        .from('prospects')
        // send_hold_at comes along so the country skip below reaches the same verdict the
        // write path would have: a held prospect reports its hold, not a country exclusion.
        .select('id, email, country, send_hold_at')
        .eq('organisation_id', organisationId),
      verificationThresholds(),
    )

    const { data: lockableProspects, error: lockError } = await lockableQuery
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
    //
    // Paced by SLOTS at fixed absolute moments, not by a flat sleep between calls. The old
    // `sleep(2000)` after each probe made the real cycle 2000ms PLUS however long the probe
    // took, so the achieved rate was the target minus the provider's latency and got further
    // under the limit the slower the provider was. See verification-pacing.ts.
    const pacer = createPacer(intervalMs, clock)

    // Probes ATTEMPTED by this run, successful or not. Every attempt spends quota, so this
    // is what the budget must be measured against — not total_verified, which counts only
    // the ones that came back.
    let probesAttempted = 0

    /** Decided by the country rule without a probe. Each one is quota left for someone mailable. */
    let skippedExcluded = 0

    for (let idx = 0; idx < lockableProspects.length; idx++) {
      const prospect = lockableProspects[idx]

      // ── THE COUNTRY RULE, BEFORE THE PROBE INSTEAD OF AFTER IT ──────────────
      //
      // checkSendEligibility decides that a prospect in an excluded country can never be
      // mailed. It ran on the RESULT of a probe already paid for, inside
      // recordVerificationResult, so quota went on addresses the platform will never use.
      // Run here it reaches the identical verdict from the identical inputs, and spends
      // nothing. The daily budget is finite and account-wide, so a probe not spent here is
      // one available to a prospect that can actually be emailed.
      //
      // THE SAME FUNCTIONS, not a copy of their rules: the country list, the alias matching,
      // the email-domain inference and the operator hold all stay where they were, so this
      // cannot drift from the verdict the write path would have recorded.
      const countryVerdict = checkSendEligibility(
        (prospect.country as string | null) ?? null,
        (prospect.email as string | null) ?? null,
      )
      if (!countryVerdict.is_eligible) {
        const sendEligibility = firstPassSendEligibility({
          heldAt: (prospect.send_hold_at as string | null) ?? null,
          country: countryVerdict,
          // No vendor was asked. False is not a claim about the address: the country rule has
          // already decided the outcome, and this only keeps the shape of the written verdict
          // identical to the one the probe path writes.
          vendorSendEligible: false,
        })
        await supabase
          .from('prospects')
          .update({
            email_send_eligible: sendEligibility.email_send_eligible,
            email_send_ineligible_reason: sendEligibility.email_send_ineligible_reason,
            verification_locked_at: null,
          })
          .eq('id', prospect.id as string)
          .eq('organisation_id', organisationId)
        heldLocks.delete(prospect.id as string)
        skippedExcluded++
        logger.info('verification-trigger: skipped, the country rule already decides it', {
          operation_id: operationId,
          prospect_id: prospect.id,
          reason: sendEligibility.email_send_ineligible_reason,
        })
        continue
      }

      // Stop before spending past the budget. The remaining prospects keep their locks
      // released below and are picked up by the next sweep.
      if (probesAttempted >= dailyRemaining) {
        logger.info('verification-trigger: stopping, daily budget reached mid-run', {
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

      // ── STOP IF THE NEXT SLOT FALLS OUTSIDE THE WINDOW ─────────────────────
      //
      // Asked BEFORE waiting, not after. A run that waited its way up to the deadline and
      // then abandoned the wait would spend the last slot of every window on nothing.
      //
      // The batch was already sized to fit, so this rarely fires. It is the backstop for the
      // case the sizing cannot predict: probes that ran slower than the interval, which push
      // the remaining slots later than the arithmetic at selection time assumed.
      if (deadlineAt !== null && pacer.nextSlotAt() >= deadlineAt) {
        logger.info('verification-trigger: stopping, the run is out of time', {
          operation_id: operationId,
          probes_attempted: probesAttempted,
          not_processed: lockableProspects.length - idx,
          ms_past_deadline: pacer.nextSlotAt() - deadlineAt,
        })
        verificationRun.status = 'partial'
        const unprocessed = lockableProspects.slice(idx).map(prospectRow => prospectRow.id as string)
        await supabase
          .from('prospects')
          .update({ verification_locked_at: null })
          .in('id', unprocessed)
          .eq('organisation_id', organisationId)
        for (const id of unprocessed) heldLocks.delete(id)
        break
      }

      // Wait for this probe's slot. A prospect the country rule already decided never reaches
      // here, so it consumes no slot: the old code slept two seconds after one of those as
      // well, waiting out a rate limit for a call it had not made.
      await pacer.awaitSlot()

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
    verificationRun.skipped_excluded_country = skippedExcluded

    // THE VERDICT IS DERIVED HERE, from what the run actually achieved, and nowhere else on
    // this path. See deriveRunStatus above for the 2026-09-15 measurement that motivated it.
    verificationRun.status = deriveRunStatus(verificationRun)

    // A downgrade needs to SAY WHY, because the heartbeat detail and the route's JSON both
    // render error_message and would otherwise report a bare 'failed' with no cause.
    if (verificationRun.status === 'failed' && !verificationRun.error_message) {
      verificationRun.error_message =
        `Every probe failed: ${verificationRun.failed_count} attempted, 0 verified. ` +
        'Check the verification provider credential and the provider status.'
    }

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
    .select('verification_attempt_count, send_hold_at')
    .eq('id', prospectId)
    .eq('organisation_id', organisationId)
    .maybeSingle()

  const newAttemptCount = (currentProspect?.verification_attempt_count ?? 0) + 1

  // Check send eligibility rules (country exclusions, etc.)
  const eligibilityCheck = checkSendEligibility(country, email)

  // ── AN OPERATOR HOLD SURVIVES RE-VERIFICATION ──
  //
  // THIS PATH IS WHY THE HOLD COLUMNS EXIST. The two lines below overwrite
  // email_send_eligible and email_send_ineligible_reason unconditionally, from the verdict
  // and the country rule alone. Three prospects (one AU, two CA) sat behind a hand-edited
  // `false` on a column this function rewrites from scratch, and the next re-verification of
  // any of them would have computed ELIGIBLE and written it, with nothing logging a
  // reversal, because from here it is simply the right answer from the evidence.
  //
  // NOTE FOR THE NEXT READER OF send-eligibility-resolver.ts, WHOSE HEADER IS WRONG ON THIS
  // POINT: it states that email_send_eligible "is only ever written from this one function".
  // It is not. This is a second writer, using the longhand the resolver was built to
  // replace, and it is the one the first pass actually runs. Routing this path through
  // resolveSendEligibility is the right fix and is deliberately NOT done here, because the
  // resolver applies the full two-pass disagreement rule and would change the verdict for
  // rows that are not held. That is a larger change than making a hold durable.
  const sendEligibility = firstPassSendEligibility({
    heldAt: (currentProspect?.send_hold_at as string | null) ?? null,
    country: eligibilityCheck,
    vendorSendEligible: result.send_eligible,
  })

  const { error } = await supabase
    .from('prospects')
    .update({
      independent_email_status: result.status,
      email_send_eligible: sendEligibility.email_send_eligible,
      email_send_ineligible_reason: sendEligibility.email_send_ineligible_reason,
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
