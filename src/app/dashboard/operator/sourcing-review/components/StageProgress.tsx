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
// EVERY NUMBER HERE COMES FROM THE SERVER, from pipeline-progress.ts, through the same poll
// that drives the cards. That is what makes it survive a page reload, which the button state
// it replaces did not: refreshing during a long step used to show the screen as it looks
// before the step starts.
//
// NO PROVIDER NAME AND NO STATUS CODE. The verification hold kinds are glossed in
// prospect-status.ts and the payload never carries a number to render.

import type { PipelineProgress } from '@/lib/operator/pipeline-progress'
import type { VerificationFailureMetrics } from '@/lib/operator/sourcing-metrics'
import {
  VERIFICATION_HOLD_LABELS,
  type VerificationHoldKind,
} from '@/lib/operator/prospect-status'

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
  const { waiting, inFlight, lastCompletedAt, sweepLastRanAt } = verification
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

/** Enrichment: how many of how many, rather than a spinner and then a tick. */
function EnrichmentSection({ enrichment }: { enrichment: PipelineProgress['enrichment'] }) {
  const { done, waiting, inFlight } = enrichment
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
    </div>
  )
}

/** The words for each research stage. One place, so the panel and any log agree. */
const RESEARCH_STAGE_LABELS: Record<
  Exclude<PipelineProgress['research']['stage'], 'idle'>,
  string
> = {
  fetching_sources: 'Reading the sources',
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
  const { stage, fetchingSources, awaitingModel, collecting, waveDone, waveTotal } = research
  if (stage === 'idle') return null

  const left = fetchingSources + awaitingModel + collecting

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
  const verification = <VerificationSection verification={progress.verification} failures={failures} />
  const enrichment = <EnrichmentSection enrichment={progress.enrichment} />
  const research = <ResearchSection research={progress.research} />

  if (!verification && !enrichment && !research) return null

  return (
    <div className="mb-4 rounded-[8px] border border-border-card bg-[#FAFAF8] p-4 space-y-4">
      {verification}
      {enrichment}
      {research}
    </div>
  )
}
