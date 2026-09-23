'use client'

// WHAT IS MOVING, ON THE SCREEN.
//
// Three steps that previously reported nothing between "started" and "finished":
//
//   VERIFICATION   showed nothing at all, ever. Not that a sweep exists, not how many are
//                  waiting, not when one last completed. A prospect queued behind another
//                  client and a prospect nothing would ever touch looked the same: absent.
//   ENRICHMENT     "Enriching..." then "Complete", with no numerator and no denominator.
//   RESEARCH       a queued message, then silence for a quarter of an hour, because on the
//                  batch path phase 1 finishes, phase 2 does not exist yet, and the only
//                  marker anything reads is written at the very end. Measured 2026-09-17:
//                  14 minutes 32 seconds with 62 prospects in flight and no queue row.
//
// THE FIRST FIX FOR RESEARCH LEFT THE FRONT OF THAT WINDOW DARK, and it is the part an
// operator meets first. Entries were counted through their open batch, and an entry has no
// batch until the sweep submits it. Measured 2026-09-21: phase 1 finished for 107 prospects
// at 18:06:17 and the first batch was created 18:08:01, with 7 waiting until 18:13:01. For
// all of it this panel rendered NOTHING, because every count was zero and the stage was
// idle. See awaitingSubmission in pipeline-progress.ts.
//
// EVERY NUMBER HERE COMES FROM THE SERVER, from pipeline-progress.ts, through the same poll
// that drives the cards. That is what makes it survive a page reload, which the button state
// it replaces did not: refreshing during a long step used to show the screen as it looks
// before the step starts.
//
// NO PROVIDER NAME AND NO STATUS CODE. The verification hold kinds are glossed in
// prospect-status.ts and the payload never carries a number to render.

import type { PipelineProgress } from '@/lib/operator/pipeline-progress'
import type { VerificationFailureMetrics } from '@/lib/operator/sourcing-metrics'
import { ENRICHMENT_PER_PRESS_LIMIT } from '@/lib/sourcing/enrichment-trigger'
import {
  VERIFICATION_HOLD_LABELS,
  type VerificationHoldKind,
} from '@/lib/operator/prospect-status'
import { describeMinutes } from '@/lib/operator/stage-estimates'

/**
 * "4 minutes ago", "2 hours ago".
 *
 * Relative rather than a clock time, because the question this answers is "is it still
 * running", and a reader should not have to subtract. Anything under a minute is "just now":
 * the sweep runs on a ten-minute schedule, so second-level precision would imply a
 * resolution the underlying fact does not have.
 */
export function timeAgo(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null

  const seconds = Math.round((now - then) / 1000)
  // A clock skew between the database and the browser can put a timestamp slightly ahead.
  // Reporting "in 3 seconds" would look broken; it is still, in every sense that matters,
  // just now.
  if (seconds < 60) return 'just now'

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`

  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * "in about 4 minutes", "in under a minute".
 *
 * THE COUNTERPART TO timeAgo ABOVE, and deliberately the same shape of answer. A reader
 * should not have to subtract in either direction, and the same rounding applies: the sweep
 * fires on a minute boundary, so second-level precision would imply a resolution the
 * underlying fact does not have.
 *
 * A moment already past reads as "any moment now" rather than as a negative. pg_cron and the
 * browser do not share a clock, and a firing that is a few seconds overdue by our reckoning
 * is not late in any sense an operator cares about.
 */
export function timeUntil(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null

  const seconds = Math.round((then - now) / 1000)
  if (seconds <= 30) return 'any moment now'
  if (seconds < 90) return 'in about a minute'

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `in about ${minutes} minutes`

  const hours = Math.round(minutes / 60)
  return `in about ${hours} hour${hours === 1 ? '' : 's'}`
}

/** One labelled line inside the panel. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 border-b border-[#F0ECE4] last:border-b-0">
      <span className="text-xs text-text-secondary">{label}</span>
      <span className="text-xs text-text-primary text-right">{children}</span>
    </div>
  )
}

/**
 * Verification: whether it is running, how many are outstanding, when it last completed.
 *
 * THE SWEEP TIME IS PLATFORM-WIDE AND THE COUNTS ARE NOT, and the wording says so. The sweep
 * does one organisation per invocation, oldest backlog first, so "it has not reached you yet"
 * and "it has stopped" are different states and only the sweep time separates them.
 */
function VerificationSection({
  verification,
  failures,
}: {
  verification: PipelineProgress['verification']
  failures: VerificationFailureMetrics
}) {
  const { waiting, inFlight, lastCompletedAt, sweepLastRanAt, nextRunAt, estimatedMinutesRemaining } = verification
  const finishEstimate = waiting > 0 ? describeMinutes(estimatedMinutesRemaining) : null
  const holds = Object.entries(failures.byKind) as Array<
    [VerificationHoldKind, { waiting: number; givenUp: number }]
  >

  // Nothing to say: none waiting, none running, none held up, and nothing ever verified.
  if (waiting === 0 && inFlight === 0 && holds.length === 0 && lastCompletedAt === null) {
    return null
  }

  return (
    <div>
      <p className="text-xs uppercase font-normal tracking-[0.07em] text-text-secondary mb-1">
        Email verification
      </p>

      <Row label="Being checked right now">
        {inFlight > 0
          ? <span className="font-medium">{inFlight}</span>
          : <span className="text-text-secondary">None</span>}
      </Row>

      <Row label="Waiting to be checked">
        {waiting > 0
          ? <span className="font-medium">{waiting}</span>
          : <span className="text-text-secondary">None</span>}
      </Row>

      {/* ── WHEN SOMETHING WILL ACTUALLY HAPPEN ────────────────────────────
          A backlog count on its own cannot separate "drains in ten minutes" from "drains
          tomorrow", and those call for different decisions. Both lines are omitted rather
          than guessed when the schedule or the provider pace could not be read: a confident
          time built on a default nobody chose is worse than no time. */}
      {nextRunAt && (
        <Row label="Next check runs">
          <span className="font-medium">{timeUntil(nextRunAt)}</span>
        </Row>
      )}

      {finishEstimate && (
        <Row label="Estimated to finish">
          <span className="font-medium">{finishEstimate}</span>
        </Row>
      )}

      <Row label="Last address checked">
        {lastCompletedAt
          ? timeAgo(lastCompletedAt)
          : <span className="text-text-secondary">Never</span>}
      </Row>

      {/* Named as platform-wide. A per-client time would report a healthy sweep as dead
          whenever another client was ahead of this one in the queue. */}
      <Row label="Checker last ran (all clients)">
        {sweepLastRanAt
          ? timeAgo(sweepLastRanAt)
          : <span className="text-text-secondary">Not recorded</span>}
      </Row>

      {/* ── THE ESTIMATE'S ASSUMPTION, SAID OUT LOUD ───────────────────────
          The checker takes ONE client per run, whoever has waited longest. The finish time
          above assumes this client is the one served each time, which is exact when only
          this client has work and optimistic when others do. Stating it is what keeps the
          number from being read as more than it is, and the same reasoning is why the row
          above is labelled as covering all clients. */}
      {finishEstimate && (
        <p className="mt-2 text-xs text-text-secondary">
          The checker takes one client per run, whoever has waited longest. That finish time
          assumes this client is served each run, so it is the soonest it could be rather
          than a promise.
        </p>
      )}

      {/* ── HELD UP, NOT FAILED ──────────────────────────────────────────────
          This block used to read "N prospects failed email verification, N on HTTP 429".
          Both halves were wrong. A rate limit is not a failure: the sweep waits and retries
          and the address verifies normally, so the old sentence described a dead prospect
          where there was a queued one. And a status code is something to look up rather
          than something to read.

          The two are split because they mean opposite things to an operator: one needs
          nothing done, the other will never move on its own. */}
      {holds.length > 0 && (
        <ul className="mt-2 space-y-1">
          {holds
            .sort((a, b) => (b[1].waiting + b[1].givenUp) - (a[1].waiting + a[1].givenUp))
            .map(([kind, counts]) => (
              <li key={kind} className="text-xs">
                {counts.waiting > 0 && (
                  <span className="text-[#7A4800]">
                    {counts.waiting} {VERIFICATION_HOLD_LABELS[kind]}, waiting to retry
                    automatically.{' '}
                  </span>
                )}
                {counts.givenUp > 0 && (
                  <span className="text-[#8B2020]">
                    {counts.givenUp} {VERIFICATION_HOLD_LABELS[kind]} and out of attempts, so
                    nothing will retry {counts.givenUp === 1 ? 'it' : 'them'} without being
                    asked.
                  </span>
                )}
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Enrichment: how many of how many, and how many presses that takes.
 *
 * ── WHY THE PRESS COUNT IS THE POINT ────────────────────────────────────────
 *
 * Enrichment is PRESSED, not scheduled, and one press stops after a fixed number however
 * many are waiting. Nothing on this screen has ever said so. An operator pressing with 240
 * waiting watched the count fall to 140 and had no way to tell whether that was the design,
 * a partial failure, or a spend cap they had hit. It is the design, and the screen now says
 * it BEFORE the press rather than leaving it to be inferred afterwards.
 *
 * "When does it next run" has no answer for the inline path, because the answer is "when you
 * press it". The queued path does have one, and only that path shows it.
 */
function EnrichmentSection({ enrichment }: { enrichment: PipelineProgress['enrichment'] }) {
  const { done, waiting, inFlight, pressPlan, queueNextRunAt } = enrichment
  if (waiting === 0 && inFlight === 0) return null

  const total = done + waiting

  return (
    <div>
      <p className="text-xs uppercase font-normal tracking-[0.07em] text-text-secondary mb-1">
        Enrichment
      </p>
      <Row label="Enriched so far">
        <span className="font-medium">{done}</span> of {total}
      </Row>
      <Row label="Still to enrich">
        <span className="font-medium">{waiting}</span>
      </Row>
      {inFlight > 0 && (
        <Row label="In the queue now">
          <span className="font-medium">{inFlight}</span>
        </Row>
      )}

      {/* Only on the queued path. On the inline path the work happens inside the press and
          there is no scheduled run to wait for, so naming one would be wrong. */}
      {inFlight > 0 && queueNextRunAt && (
        <Row label="Next queue run">
          <span className="font-medium">{timeUntil(queueNextRunAt)}</span>
        </Row>
      )}

      {pressPlan && pressPlan.pressesNeeded > 1 && (
        <Row label="Presses needed">
          <span className="font-medium">{pressPlan.pressesNeeded}</span>
        </Row>
      )}

      {/* ── WHAT ONE PRESS NOW DOES ────────────────────────────────────────────
          A press keeps going by itself until the backlog is clear, so for most clients there
          is nothing to warn about and this says so rather than staying silent: "it will take a
          while" is the thing an operator watching a slow press needs to know, and its absence
          is what made them reach for the button again.

          THE OLD COPY PROMISED FIVE PRESSES FOR 500 AND IS DELETED, not softened. It described
          a single-pass press that no longer exists. */}
      {pressPlan && pressPlan.remainingAfter === 0 && (
        <p className="mt-2 text-xs text-[#7A4800]">
          One press enriches all {pressPlan.thisPress}
          {pressPlan.passesThisPress > 1
            ? `, in ${pressPlan.passesThisPress} passes of up to ${ENRICHMENT_PER_PRESS_LIMIT}, so give it a moment.`
            : '.'}{' '}
          You do not need to press it again.
        </p>
      )}

      {/* The two cases a press still cannot finish: a backlog above the per-press ceiling, and
          a slow provider day that runs the request out of time. Only the first is predictable
          from here; the second is reported by the response after the fact. */}
      {pressPlan && pressPlan.remainingAfter > 0 && (
        <p className="mt-2 text-xs text-[#7A4800]">
          One press enriches up to {pressPlan.thisPress}, which leaves{' '}
          {pressPlan.remainingAfter} waiting, so this backlog needs{' '}
          {pressPlan.pressesNeeded} presses in total. Nothing is lost between them and no
          prospect is charged twice.
        </p>
      )}
    </div>
  )
}

/** The words for each research stage. One place, so the panel and any log agree. */
const RESEARCH_STAGE_LABELS: Record<
  Exclude<PipelineProgress['research']['stage'], 'idle'>,
  string
> = {
  fetching_sources: 'Reading the sources',
  // NAMED AS DONE-AND-WAITING, not as a fourth kind of working. The sources are gathered
  // and paid for; what is left is a scheduled send that has not come round yet.
  awaiting_submission: 'Sources done, waiting to be sent to the model',
  awaiting_model: 'Waiting for the model to come back',
  collecting: 'Writing the opening lines',
}

/**
 * Research: which stage, how many done, how many left.
 *
 * THE MIDDLE STAGE IS THE POINT OF THIS COMPONENT. On the batch path the synthesis goes to
 * the model as one batch at half price, and nothing is queued while it is there. That wait
 * was invisible and was read as a stall, repeatedly.
 */
function ResearchSection({ research }: { research: PipelineProgress['research'] }) {
  const {
    stage, fetchingSources, awaitingSubmission, awaitingModel, collecting, waveDone, waveTotal,
  } = research
  if (stage === 'idle') return null

  const left = fetchingSources + awaitingSubmission + awaitingModel + collecting

  return (
    <div>
      <p className="text-xs uppercase font-normal tracking-[0.07em] text-text-secondary mb-1">
        Research
      </p>

      <Row label="Stage">
        <span className="font-medium">{RESEARCH_STAGE_LABELS[stage]}</span>
      </Row>

      {/* Both numbers are null together when no wave is open, because "0 of 0 done" reads
          as failure rather than as nothing running. */}
      {waveDone !== null && waveTotal !== null && waveTotal > 0 && (
        <Row label="Done in this run">
          <span className="font-medium">{waveDone}</span> of {waveTotal}
        </Row>
      )}

      <Row label="Still to go">
        <span className="font-medium">{left}</span>
      </Row>

      {/* ── THE STAGE THAT USED TO TAKE THE WHOLE PANEL OFF THE SCREEN ────────
          Between phase 1 finishing and the sweep firing there is no queue row and no open
          batch, so every count read zero, the stage read idle, and the panel rendered
          nothing at all. An operator saw a screen that looked exactly like one where
          nothing had been started, while a hundred prospects sat with their sources bought.

          TWO FACTS, because one without the other still reads as a stall: what has
          finished, and when the next thing happens. The time is omitted rather than
          guessed when the schedule could not be read. */}
      {awaitingSubmission > 0 && (
        <p className="mt-2 text-xs text-text-secondary">
          The sources are gathered for {awaitingSubmission}{' '}
          {awaitingSubmission === 1 ? 'prospect' : 'prospects'} and nothing more is being
          bought for {awaitingSubmission === 1 ? 'it' : 'them'}. They go to the model on the
          next send
          {research.nextSubmissionRunAt
            ? `, ${timeUntil(research.nextSubmissionRunAt)}`
            : ''}
          . Nothing is queued until then and nothing has stalled.
        </p>
      )}

      {awaitingModel > 0 && (
        <p className="mt-2 text-xs text-text-secondary">
          {awaitingModel} {awaitingModel === 1 ? 'is' : 'are'} with the model now
          {research.oldestBatchSubmittedAt
            ? `, sent ${timeAgo(research.oldestBatchSubmittedAt)}`
            : ''}
          . Nothing is queued during this wait and nothing has stalled. It usually comes back
          within about fifteen minutes and can take up to a day.
        </p>
      )}
    </div>
  )
}

/**
 * The whole panel. Renders nothing at all when every step is quiet, so a client with no work
 * in flight does not gain an empty box.
 */
export function StageProgress({
  progress,
  failures,
}: {
  progress: PipelineProgress
  failures: VerificationFailureMetrics
}) {
  // ── EMPTINESS IS DECIDED FROM THE DATA, NOT FROM THE ELEMENTS ─────────────
  //
  // The first version of this held the three sections in variables and tested those. A JSX
  // element is an object and is ALWAYS truthy even when the component returns null, so the
  // guard never fired and a client with nothing in flight got an empty bordered box. Caught
  // by the test asserting an empty container; it is the same shape as every other check in
  // this codebase that ran and could not see what it was checking.
  const { verification: v, enrichment: e, research: r } = progress
  const hasVerification =
    v.waiting > 0 || v.inFlight > 0 || v.lastCompletedAt !== null ||
    Object.keys(failures.byKind).length > 0
  const hasEnrichment = e.waiting > 0 || e.inFlight > 0
  const hasResearch = r.stage !== 'idle'

  if (!hasVerification && !hasEnrichment && !hasResearch) return null

  return (
    <div className="mb-4 rounded-[8px] border border-border-card bg-[#FAFAF8] p-4 space-y-4">
      <VerificationSection verification={progress.verification} failures={failures} />
      <EnrichmentSection enrichment={progress.enrichment} />
      <ResearchSection research={progress.research} />
    </div>
  )
}
