// src/lib/sourcing/second-pass-trigger.ts
//
// Paid second-pass verification for the catch-all and unknown segment.
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS IS A SIBLING OF verification-trigger.ts, NOT A COPY OF IT
//
// The first-pass trigger shipped on 2026-08-25 carrying five bugs that were fixed the same
// day. Copying it would have reproduced all five, so each is reimplemented here deliberately
// and named where it appears:
//
//   1. LOCK LIFECYCLE. The lock used to be set before work and cleared only on success, so
//      any crash stranded the batch permanently. Here: heldLocks, releaseSecondPassLock,
//      and a stale reclaim in the selection.
//   2. ATTEMPT COUNTING ON FAILURE. A stale reclaim without this is worse than the bug it
//      fixes: a permanently bad address gets re-probed forever. The retry cap only binds if
//      failures count. Here it matters MORE, because every re-probe spends money.
//   3. PROBE TIMEOUT. Verification is an SMTP probe behind HTTP and hangs as long as the far
//      end holds the socket. In adapter-bouncer.ts.
//   4. BATCH SIZED AGAINST THE CLOCK, not against the quota.
//   5. maxDuration = 300 on the route.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IS DIFFERENT, AND WHY
//
// THE CALLS COST MONEY. The first pass is free up to 100/day, so its worst case is a wasted
// call. This vendor is $8 per 1,000. Three things follow:
//
//   - The budget is counted from a LEDGER of attempts, not from verdicts on prospects. A
//     probe that spent money and then failed writes no verdict, so counting verdicts
//     undercounts spend by exactly the failures. That is a stated residual of the first pass
//     and is not acceptable here.
//   - The ledger row is written BEFORE the call.
//   - There is a hard daily cap, and an unreadable count fails CLOSED.
//
// NO RATE-LIMIT SLEEP. The first pass sleeps 2s per address for a 30/minute limit. This
// vendor allows 1,000/minute, so the sleep would be pure latency. The binding constraint here
// is the probe timeout, not the rate limit, and the batch size is set against that instead.

// KNOWN AND ACCEPTED: this file imports a vendor handler BY NAME rather than resolving it
// through the capability registry. That is leak L3 in the catch-all handover, and the
// handover is explicit about not fixing it here: src/lib/handlers/capability.ts has an empty
// handler map, zero callers, a signature that does not match the map, and all 14
// integrations_registry rows read connection_status = 'disconnected'. Every other integration
// in this repo bypasses it the same way. Closing that gap is a deliberate repo-wide change,
// not a rider on this build. What IS fixed here is the part that costs today: no vendor
// VOCABULARY reaches shared code, because each handler owns its own map and
// verification-verdict.ts only holds the wiring.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { bouncerHandler, BOUNCER_PROVIDER_KEY, type SecondPassResult } from '@/lib/sourcing/handlers/adapter-bouncer'
import { resolveSendEligibility, type SendEligibilityDecision } from '@/lib/sourcing/send-eligibility-resolver'
import { toCanonicalVerdict, SECOND_PASS_WORTH_PAYING_FOR } from '@/lib/sourcing/verification-verdict'

const STALE_LOCK_THRESHOLD_MINUTES = 30
const MAX_SECOND_PASS_ATTEMPTS = 2

/**
 * Hard ceiling on paid calls per UTC day, across the whole ACCOUNT.
 *
 * PER ACCOUNT, NOT PER ORGANISATION, and that is the bug the first pass shipped with: its
 * quota check was scoped to one organisation against a limit belonging to the vendor
 * account, which read correctly only because exactly one organisation had prospects.
 *
 * 200 is $1.60/day at $8 per 1,000. Set against the size of the problem rather than the
 * budget: the entire live backlog is 11 addresses, so this is roughly 18x headroom and
 * exists to bound a runaway loop, not to ration normal work. Raise it when a real backlog
 * justifies it, and note that credits do not expire, so unspent headroom is not lost.
 */
export const SECOND_PASS_DAILY_CALL_LIMIT = 200

/**
 * How many addresses one invocation attempts.
 *
 * SIZED AGAINST THE CLOCK. There is no rate-limit sleep, so the only floor on wall-clock
 * time is the probe timeout: 20 addresses x 20s of worst-case timeout is 400s, which does
 * not fit a 300s route, and 12 x 20s = 240s does with room for the surrounding queries.
 *
 * The realistic case is far faster, and anything not reached keeps its lock released and is
 * picked up by the next sweep 30 minutes later. The first pass learned this the hard way: a
 * default of 100 could not finish inside its own route.
 */
export const DEFAULT_SECOND_PASS_BATCH_SIZE = 12

export interface SecondPassRun {
  organisation_id: string
  batch_size: number
  total_verified: number
  /** Prospects that became SEND-ELIGIBLE. Not the same as "the vendor said deliverable". */
  recovered_count: number
  still_unusable_count: number
  failed_count: number
  calls_spent: number
  verified_at: string
  status: 'success' | 'partial' | 'budget_exhausted' | 'failed'
  error_message?: string
  daily_calls_used?: number
}

/** The prospect columns this trigger reads. */
interface SecondPassCandidate {
  id: string
  email: string | null
  country: string | null
  independent_email_status: string | null
  verification_provider: string | null
}

export async function runSecondPassBatch(
  supabase: SupabaseClient,
  organisationId: string,
  maxBatchSize: number = DEFAULT_SECOND_PASS_BATCH_SIZE,
): Promise<SecondPassRun> {
  const operationId = `second-pass-${organisationId.slice(0, 8)}-${Date.now()}`

  // Every prospect this run has locked and not yet released. Each exit path removes its own
  // id; whatever remains when the outer catch fires is released there.
  const heldLocks = new Set<string>()

  const run: SecondPassRun = {
    organisation_id: organisationId,
    batch_size: 0,
    total_verified: 0,
    recovered_count: 0,
    still_unusable_count: 0,
    failed_count: 0,
    calls_spent: 0,
    verified_at: new Date().toISOString(),
    status: 'success',
  }

  logger.info('second-pass: run started', {
    operation_id: operationId,
    organisation_id: organisationId,
    max_batch_size: maxBatchSize,
  })

  try {
    // ── Step 1: Budget, counted from the LEDGER and scoped to the ACCOUNT ─────────────
    const startOfDayUTC = new Date()
    startOfDayUTC.setUTCHours(0, 0, 0, 0)

    const { count: dailyCount, error: countError } = await supabase
      .from('verification_calls')
      .select('id', { count: 'exact', head: true })
      .eq('provider', BOUNCER_PROVIDER_KEY)
      .gte('requested_at', startOfDayUTC.toISOString())

    // AN UNREADABLE COUNT MUST NOT READ AS ZERO SPENT. Falling through with `?? 0` would
    // tell the run it had the entire day's budget free, which is the most expensive possible
    // guess. The work is resumable on the next sweep; an overspend is not.
    if (countError) {
      logger.error('second-pass: could not read daily call count, failing closed', {
        operation_id: operationId,
        error: countError.message,
      })
      run.status = 'failed'
      run.error_message =
        `Could not read the daily paid-call count, so the budget is unknown: ${countError.message}`
      return run
    }

    const dailyUsed = dailyCount ?? 0
    const dailyRemaining = Math.max(0, SECOND_PASS_DAILY_CALL_LIMIT - dailyUsed)

    logger.info('second-pass: budget check', {
      operation_id: operationId,
      daily_used: dailyUsed,
      daily_remaining: dailyRemaining,
      daily_limit: SECOND_PASS_DAILY_CALL_LIMIT,
    })

    if (dailyRemaining <= 0) {
      run.status = 'budget_exhausted'
      run.daily_calls_used = dailyUsed
      logger.info('second-pass: daily paid-call budget exhausted', {
        operation_id: operationId,
        organisation_id: organisationId,
      })
      return run
    }

    // ── Step 2: Select and lock ──────────────────────────────────────────────────────
    const staleLockThresholdISO = new Date(
      Date.now() - STALE_LOCK_THRESHOLD_MINUTES * 60 * 1000,
    ).toISOString()

    const cappedBatchSize = Math.min(maxBatchSize, dailyRemaining)

    const { data: candidates, error: selectError } = await supabase
      .from('prospects')
      .select('id, email, country, independent_email_status, verification_provider')
      .eq('organisation_id', organisationId)
      .eq('suppressed', false)
      .not('email', 'is', null)
      // The first pass reached a verdict it cannot confirm. SECOND_PASS_WORTH_PAYING_FOR is
      // derived from the vendor translation map rather than typed out here, so vendor
      // spellings live in one module. See verification-verdict.ts for why 'Grey-listed' is
      // excluded: it still has free retries pending, and paying for it would answer a
      // question that was about to answer itself.
      .in('independent_email_status', SECOND_PASS_WORTH_PAYING_FOR as string[])
      // Never second-passed. A prospect that already has a verdict here is done: this pass
      // does not re-probe a resolved address, because unlike the free first pass every
      // re-probe costs money and the answer does not change.
      .is('second_pass_status', null)
      .lt('second_pass_attempt_count', MAX_SECOND_PASS_ATTEMPTS)
      // Unlocked, or the lock has gone stale because the run holding it died. Chained
      // filters are ANDed by PostgREST.
      .or(`second_pass_locked_at.is.null,second_pass_locked_at.lt.${staleLockThresholdISO}`)
      .limit(cappedBatchSize)

    if (selectError) {
      logger.error('second-pass: candidate select failed', {
        operation_id: operationId,
        organisation_id: organisationId,
        error: selectError.message,
      })
      throw new Error(`Failed to select second-pass candidates: ${selectError.message}`)
    }

    if (!candidates || candidates.length === 0) {
      logger.info('second-pass: no candidates', {
        operation_id: operationId,
        organisation_id: organisationId,
      })
      run.daily_calls_used = dailyUsed
      return run
    }

    const prospects = candidates as SecondPassCandidate[]
    const prospectIds = prospects.map(p => p.id)

    const { error: lockError } = await supabase
      .from('prospects')
      .update({ second_pass_locked_at: new Date().toISOString() })
      .in('id', prospectIds)
      .eq('organisation_id', organisationId)

    if (lockError) {
      logger.error('second-pass: lock acquisition failed', {
        operation_id: operationId,
        organisation_id: organisationId,
        error: lockError.message,
      })
      throw new Error(`Failed to acquire second-pass lock: ${lockError.message}`)
    }

    for (const id of prospectIds) heldLocks.add(id)
    run.batch_size = prospectIds.length

    logger.info('second-pass: locked candidates', {
      operation_id: operationId,
      organisation_id: organisationId,
      locked_count: prospectIds.length,
    })

    // ── Step 3: Probe each address ───────────────────────────────────────────────────
    for (let idx = 0; idx < prospects.length; idx++) {
      const prospect = prospects[idx]

      // Stop before spending past the budget. Remaining prospects get their locks released
      // and are picked up by the next sweep.
      if (run.calls_spent >= dailyRemaining) {
        logger.info('second-pass: stopping, budget reached mid-run', {
          operation_id: operationId,
          calls_spent: run.calls_spent,
          not_processed: prospects.length - idx,
        })
        run.status = 'partial'
        const unprocessed = prospects.slice(idx).map(p => p.id)
        await supabase
          .from('prospects')
          .update({ second_pass_locked_at: null })
          .in('id', unprocessed)
          .eq('organisation_id', organisationId)
        for (const id of unprocessed) heldLocks.delete(id)
        break
      }

      if (!prospect.email) {
        // Cannot happen given the .not('email','is',null) filter, but a prospect with no
        // email would otherwise hold its lock forever. That exact path was a shipped bug in
        // the first pass.
        run.failed_count++
        await releaseSecondPassLock(supabase, organisationId, prospect.id, operationId)
        heldLocks.delete(prospect.id)
        continue
      }

      // THE LEDGER ROW GOES IN BEFORE THE CALL. A row written afterwards cannot record a
      // call that spent money and then failed, and that is the case the budget exists to
      // count.
      const callId = await openLedgerEntry(supabase, organisationId, prospect.id, operationId)
      run.calls_spent++

      try {
        const result = await bouncerHandler.execute(prospect.email)

        await closeLedgerEntry(supabase, callId, 'ok', result.verdict, result.score, null, operationId)
        const decision = await recordSecondPassResult(supabase, organisationId, prospect, result, operationId)

        // COUNTED ON THE OUTCOME, NOT THE VERDICT. An operator reads "recovered 3" in the
        // heartbeat as "three more prospects I can mail", so it has to mean exactly that.
        // A deliverable verdict on a jurisdiction-excluded address is a verdict we paid for
        // and cannot use, and counting it here would overstate the return on the spend.
        if (decision.eligible) run.recovered_count++
        else run.still_unusable_count++

        // recordSecondPassResult clears the lock on its own success path.
        heldLocks.delete(prospect.id)
        run.total_verified++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('second-pass: probe failed', {
          operation_id: operationId,
          prospect_id: prospect.id,
          email: prospect.email,
          error: msg,
        })
        run.failed_count++

        await closeLedgerEntry(supabase, callId, 'failed', null, null, msg, operationId)

        // RELEASE THE LOCK AND COUNT THE ATTEMPT, in one write. Neither half is optional.
        // Without the release, a thrown probe locks the address forever. Without the
        // increment, the stale reclaim above re-probes a permanently bad address every 30
        // minutes and BILLS FOR EACH ONE. MAX_SECOND_PASS_ATTEMPTS only bounds anything if
        // failures actually count.
        const { data: current } = await supabase
          .from('prospects')
          .select('second_pass_attempt_count')
          .eq('id', prospect.id)
          .eq('organisation_id', organisationId)
          .maybeSingle()

        const { error: failWriteError } = await supabase
          .from('prospects')
          .update({
            second_pass_error: msg,
            second_pass_attempt_count: (current?.second_pass_attempt_count ?? 0) + 1,
            second_pass_locked_at: null,
          })
          .eq('id', prospect.id)
          .eq('organisation_id', organisationId)

        if (!failWriteError) {
          heldLocks.delete(prospect.id)
        } else {
          logger.error('second-pass: could not release lock after a failed probe', {
            operation_id: operationId,
            prospect_id: prospect.id,
            error: failWriteError.message,
            consequence:
              'This prospect stays locked until the stale reclaim picks it up in ' +
              `${STALE_LOCK_THRESHOLD_MINUTES} minutes. Its attempt count did not increment, ` +
              'so it will be re-probed and re-billed.',
          })
        }
      }
    }

    run.daily_calls_used = dailyUsed + run.calls_spent

    logger.info('second-pass: run complete', {
      operation_id: operationId,
      organisation_id: organisationId,
      status: run.status,
      total_verified: run.total_verified,
      recovered: run.recovered_count,
      still_unusable: run.still_unusable_count,
      failed: run.failed_count,
      calls_spent: run.calls_spent,
      daily_used: run.daily_calls_used,
    })

    return run
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('second-pass: run failed', {
      operation_id: operationId,
      organisation_id: organisationId,
      error: msg,
    })
    run.status = 'failed'
    run.error_message = msg

    // Release whatever this run still holds. The per-prospect loop catches its own errors,
    // so reaching here means the failure was in selection or locking, and in the latter case
    // the whole remaining batch is still locked.
    if (heldLocks.size > 0) {
      const { error: bulkReleaseError } = await supabase
        .from('prospects')
        .update({ second_pass_locked_at: null })
        .in('id', [...heldLocks])
        .eq('organisation_id', organisationId)
      if (bulkReleaseError) {
        logger.error('second-pass: bulk lock release failed', {
          operation_id: operationId,
          error: bulkReleaseError.message,
          consequence:
            `${heldLocks.size} prospect(s) stay locked until the stale reclaim picks them up ` +
            `in ${STALE_LOCK_THRESHOLD_MINUTES} minutes.`,
        })
      }
    }

    return run
  }
}

/** Clear one prospect's second-pass lock. Used by the paths that never reach a result. */
async function releaseSecondPassLock(
  supabase: SupabaseClient,
  organisationId: string,
  prospectId: string,
  operationId: string,
): Promise<void> {
  const { error } = await supabase
    .from('prospects')
    .update({ second_pass_locked_at: null })
    .eq('id', prospectId)
    .eq('organisation_id', organisationId)

  if (error) {
    logger.error('second-pass: lock release failed', {
      operation_id: operationId,
      prospect_id: prospectId,
      error: error.message,
    })
  }
}

/**
 * Record that a paid call is ABOUT to be made. Returns the ledger row id, or null.
 *
 * A NULL RETURN DOES NOT ABORT THE PROBE, and that is a deliberate trade-off rather than an
 * oversight. If the ledger insert fails, the choice is between skipping the address (the
 * backlog stalls on a bookkeeping failure) and probing it uncounted (the day's budget is
 * off by one). The budget has 18x headroom over the entire live backlog, so being off by a
 * few is recoverable and stalling is not. It is logged at error so the undercount is
 * visible rather than silent.
 */
async function openLedgerEntry(
  supabase: SupabaseClient,
  organisationId: string,
  prospectId: string,
  operationId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('verification_calls')
    .insert({
      organisation_id: organisationId,
      prospect_id: prospectId,
      provider: BOUNCER_PROVIDER_KEY,
      outcome: 'attempted',
    })
    .select('id')
    .maybeSingle()

  if (error) {
    logger.error('second-pass: could not open a ledger entry for a paid call', {
      operation_id: operationId,
      prospect_id: prospectId,
      error: error.message,
      consequence: 'This paid call will not be counted against the daily budget.',
    })
    return null
  }

  return (data?.id as string | undefined) ?? null
}

/** Close a ledger entry with the outcome. Best effort: the attempt is already recorded. */
async function closeLedgerEntry(
  supabase: SupabaseClient,
  callId: string | null,
  outcome: 'ok' | 'failed',
  verdict: string | null,
  score: number | null,
  error: string | null,
  operationId: string,
): Promise<void> {
  if (!callId) return

  const { error: updateError } = await supabase
    .from('verification_calls')
    .update({
      completed_at: new Date().toISOString(),
      outcome,
      verdict,
      score,
      error: error?.slice(0, 500) ?? null,
    })
    .eq('id', callId)

  if (updateError) {
    // The row still exists with outcome 'attempted', so the BUDGET is unaffected. Only the
    // outcome detail is lost, which is why this is a warning and not an error.
    logger.warn('second-pass: could not close a ledger entry', {
      operation_id: operationId,
      call_id: callId,
      error: updateError.message,
    })
  }
}

/**
 * Write the second-pass verdict and re-resolve send eligibility.
 *
 * email_send_eligible IS RECOMPUTED HERE, THROUGH THE SHARED RESOLVER, never assembled
 * inline. The first pass materialised it from an expression written out longhand in its own
 * trigger, with half the policy living inside a vendor handler. Copying that shape would
 * have produced two policies that agree today and drift later. Both passes now call
 * resolveSendEligibility and neither knows the rule.
 */
async function recordSecondPassResult(
  supabase: SupabaseClient,
  organisationId: string,
  prospect: SecondPassCandidate,
  result: SecondPassResult,
  operationId: string,
): Promise<SendEligibilityDecision> {
  const { data: current } = await supabase
    .from('prospects')
    .select('second_pass_attempt_count')
    .eq('id', prospect.id)
    .eq('organisation_id', organisationId)
    .maybeSingle()

  const decision = resolveSendEligibility({
    country: prospect.country,
    email: prospect.email,
    firstPass: toCanonicalVerdict(
      prospect.verification_provider,
      prospect.independent_email_status,
    ),
    secondPass: result.verdict,
  })

  const { error } = await supabase
    .from('prospects')
    .update({
      second_pass_status: result.raw_status,
      second_pass_reason: result.reason,
      second_pass_score: result.score,
      // OUR provider key, not result.provider. result.provider is the vendor's detection of
      // the prospect's MAIL HOST (google, outlook), which is a different fact and is logged
      // below rather than stored: it was useful as evidence when validating the approach and
      // is not read by anything.
      second_pass_provider: BOUNCER_PROVIDER_KEY,
      second_pass_accept_all: result.accept_all,
      second_pass_verified_at: result.verified_at,
      second_pass_attempt_count: (current?.second_pass_attempt_count ?? 0) + 1,
      second_pass_locked_at: null,
      second_pass_error: null,
      email_send_eligible: decision.eligible,
      email_send_ineligible_reason: decision.ineligibleReason,
    })
    .eq('id', prospect.id)
    .eq('organisation_id', organisationId)

  if (error) {
    logger.error('second-pass: failed to record result', {
      operation_id: operationId,
      prospect_id: prospect.id,
      error: error.message,
      consequence:
        'A paid call was made and its answer was not stored. The ledger records the spend. ' +
        'The prospect keeps its lock until the stale reclaim releases it.',
    })
    return decision
  }

  logger.info('second-pass: prospect resolved', {
    operation_id: operationId,
    prospect_id: prospect.id,
    first_pass: prospect.independent_email_status,
    second_pass: result.raw_status,
    score: result.score,
    accept_all: result.accept_all,
    mail_host: result.provider,
    now_send_eligible: decision.eligible,
    detail: decision.detail,
  })

  return decision
}
