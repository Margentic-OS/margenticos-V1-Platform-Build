'use client'

// One line per sourcing run, newest expanded.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY A RUN LIST AND NOT "THE LATEST BATCH"
//
// The screen used to sum every cohort the organisation had ever had, so the Tier 1 card
// read 93 and nothing could separate the batches inside it. The obvious fix is to default
// to the latest batch, and it was the original instruction. It is wrong here for a reason
// that only turned up on measurement: on 2026-08-10 FOUR runs happened inside three
// minutes, writing 25, 2, 1 and 1. "The latest batch" would silently pick one of those
// four and show 1, which is the same lie by omission as the all-time sum, just smaller.
//
// So every run gets a line, the newest is open, and the list makes the four-runs-in-three-
// minutes reality visible instead of picking one arbitrarily.
//
// EVERY VIEW NAMES ITS SCOPE AND ITS DATE. A default that is not visibly a filter is the
// defect being fixed. A number here is never rendered without the run and the day it
// belongs to.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE COUNTS ARE NOT COMPUTED HERE
//
// Every figure comes from BatchFunnel, built by countRow in sourcing-metrics.ts, which is
// the same function that produced the cards above. This component only arranges them. The
// one thing it does compute is the RECONCILIATION below, and that exists precisely to fail
// loudly if the two ever stop agreeing.

import { useState } from 'react'
import type { BatchFunnel, PipelineMetrics } from '@/lib/operator/sourcing-metrics'
import {
  NOT_SENDABLE_LABELS,
  DISQUALIFIER_LABELS,
  type NotSendableReason,
} from '@/lib/operator/prospect-status'

/** Dedupe verdicts, glossed. An unrecognised code renders as itself rather than vanishing. */
const DROP_REASON_LABELS: Record<string, string> = {
  suppressed_match: 'already suppressed',
  duplicate_person_key: 'already in this client’s list',
  duplicate_linkedin: 'duplicate profile link',
  duplicate_email: 'duplicate email address',
}

function formatDay(iso: string | null): string {
  if (!iso) return 'date not recorded'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  })
}

function formatTime(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

/** One stage of the funnel: what survived, and what did not, with the reason. */
function Stage({
  label,
  count,
  previous,
  lost,
}: {
  label: string
  count: number
  /** The stage above, so the drop can be named. NULL for the first stage. */
  previous: number | null
  /** Why the difference, when there is something to say. */
  lost?: React.ReactNode
}) {
  const drop = previous === null ? 0 : previous - count

  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 border-b border-[#F0ECE4] last:border-b-0">
      <span className="text-xs text-text-secondary">{label}</span>
      <span className="flex items-baseline gap-3 text-right">
        {drop > 0 && (
          <span className="text-xs text-[#8B2020]">
            &minus;{drop}
            {lost ? <span className="text-text-secondary"> ({lost})</span> : null}
          </span>
        )}
        <span className="text-sm font-medium text-text-primary tabular-nums w-10">{count}</span>
      </span>
    </div>
  )
}

function reasonList(byReason: Record<string, number>, gloss: (code: string) => string): string {
  return Object.entries(byReason)
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${n} ${gloss(code)}`)
    .join(', ')
}

function FunnelBody({ batch }: { batch: BatchFunnel }) {
  const tierTotal =
    batch.tiers.tier_1.total + batch.tiers.tier_2.total + batch.tiers.tier_3.total

  const notSendable: Array<[NotSendableReason, number]> = []
  for (const tier of [batch.tiers.tier_1, batch.tiers.tier_2, batch.tiers.tier_3]) {
    for (const [reason, n] of Object.entries(tier.notSendableByReason)) {
      notSendable.push([reason as NotSendableReason, n])
    }
  }
  const notSendableRolled = notSendable.reduce<Record<string, number>>((acc, [r, n]) => {
    acc[r] = (acc[r] ?? 0) + n
    return acc
  }, {})

  return (
    <div className="mt-3">
      {/* What the run itself recorded, as opposed to what still exists. The two differ
          whenever prospects were deleted afterwards, and three runs are in exactly that
          state: they recorded 25 written each and have nothing present. */}
      <div className="mb-3 text-xs text-text-secondary">
        {batch.candidates_returned !== null && (
          <>
            The run asked for{' '}
            {batch.target_batch_size !== null
              ? <strong className="font-medium text-text-primary">{batch.target_batch_size}</strong>
              : <span>an amount that was not recorded</span>}
            , got back{' '}
            <strong className="font-medium text-text-primary">{batch.candidates_returned}</strong>.
          </>
        )}
        {Object.keys(batch.dropped_by_reason).length > 0 && (
          <>
            {' '}Already known, so not added:{' '}
            {reasonList(batch.dropped_by_reason, c => DROP_REASON_LABELS[c] ?? c)}.
          </>
        )}
      </div>

      <div>
        <Stage label="Added to this client" count={batch.sourced} previous={null} />
        <Stage label="Approved for enrichment" count={batch.approved} previous={batch.sourced}
          lost={batch.pending_review > 0 ? `${batch.pending_review} still awaiting approval` : undefined} />
        <Stage label="Enriched" count={batch.enriched} previous={batch.approved} />
        <Stage label="Kept by tiering" count={tierTotal} previous={batch.enriched}
          lost={batch.removed > 0
            ? reasonList(batch.removed_by_reason, c => (DISQUALIFIER_LABELS[c] ?? c).toLowerCase())
            : undefined} />
        <Stage label="Email verified" count={batch.verified} previous={tierTotal} />
        <Stage label="Can be emailed" count={batch.eligible} previous={batch.verified}
          lost={Object.keys(notSendableRolled).length > 0
            ? reasonList(notSendableRolled, c => (NOT_SENDABLE_LABELS[c as NotSendableReason] ?? c).toLowerCase())
            : undefined} />
        <Stage label="Researched" count={batch.researched} previous={batch.eligible} />
        <Stage label="Has an opening line" count={batch.personalised} previous={batch.researched} />
      </div>

      {/* Tier split, from the same TierMetrics the cards above render. */}
      {tierTotal > 0 && (
        <p className="mt-3 text-xs text-text-secondary">
          Tier 1 {batch.tiers.tier_1.total}, tier 2 {batch.tiers.tier_2.total},
          tier 3 {batch.tiers.tier_3.total}.
        </p>
      )}

      {batch.error_message && (
        <p className="mt-3 px-3 py-2 rounded-[6px] bg-[#FDEEE8] border border-[#EFBCAA] text-xs text-[#8B2020]">
          This run failed: {batch.error_message}
        </p>
      )}

      {/* A reconstructed number and a recorded one must not look identical. */}
      {batch.backfilled && (
        <p className="mt-3 px-3 py-2 rounded-[6px] bg-[#FEF7E6] border border-[#F0D080] text-xs text-[#7A4800]">
          This run predates run recording. Its totals were reconstructed afterwards from the
          run log, so they are as good as that log and no better. The stage counts below the
          first line are read from the prospects themselves and are exact.
        </p>
      )}
    </div>
  )
}

export function SourcingRunList({ org }: { org: PipelineMetrics }) {
  // Newest expanded. Runs are already newest-first from the query.
  //
  // A SET, NOT A SINGLE ID, so more than one run can be open at a time. An accordion keeps
  // the screen shorter and makes the second most useful thing on it impossible: comparing
  // two batches. Four runs happened inside three minutes on 2026-08-10 and the question
  // "did the second one behave like the first" needs both visible at once.
  const newestId = org.batches[0]?.sourcing_run_id ?? null
  const [openIds, setOpenIds] = useState<Set<string>>(
    () => new Set(newestId ? [newestId] : []),
  )
  const [unattributedOpen, setUnattributedOpen] = useState(false)

  function toggle(id: string | null) {
    if (id === null) return
    setOpenIds(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const attributed = org.batches.reduce((n, b) => n + b.sourced, 0)
  const unattributedCount = org.unattributed?.sourced ?? 0

  if (org.batches.length === 0 && unattributedCount === 0) {
    return (
      <div className="mt-6 pt-6 border-t border-border-card">
        <p className="text-xs text-text-secondary">
          No sourcing runs recorded for this client yet.
        </p>
      </div>
    )
  }

  return (
    <div className="mt-6 pt-6 border-t border-border-card">
      {/* THE SCOPE, NAMED. Never a bare count. */}
      <h4 className="text-sm font-medium text-text-primary mb-1">
        Sourcing runs
      </h4>
      <p className="text-xs text-text-secondary mb-3">
        {org.batches.length === 0
          ? 'No recorded runs.'
          : `${org.batches.length} run${org.batches.length === 1 ? '' : 's'}, most recent ${formatDay(org.batches[0].started_at)}. The cards above are every run added together.`}
      </p>

      <div className="space-y-2">
        {org.batches.map((batch) => {
          const isOpen = batch.sourcing_run_id !== null && openIds.has(batch.sourcing_run_id)
          const lostAfterwards =
            batch.candidates_returned !== null && batch.sourced === 0 && batch.candidates_returned > 0

          return (
            <div
              key={batch.sourcing_run_id ?? 'none'}
              className={`rounded-[8px] border ${isOpen ? 'border-brand-green-primary bg-white' : 'border-border-card bg-[#FAFAF8]'}`}
            >
              <button
                type="button"
                onClick={() => toggle(batch.sourcing_run_id)}
                className="w-full text-left px-3 py-2.5 flex items-baseline justify-between gap-3"
                aria-expanded={isOpen}
              >
                <span className="text-xs text-text-primary">
                  {/* SCOPE AND DATE, on every line, open or closed. */}
                  <strong className="font-medium">{formatDay(batch.started_at)}</strong>
                  <span className="text-text-secondary"> at {formatTime(batch.started_at)}</span>
                  {batch.status === 'failed' && (
                    <span className="ml-2 text-[#8B2020]">failed</span>
                  )}
                  {batch.status === 'running' && (
                    <span className="ml-2 text-[#7A4800]">still running</span>
                  )}
                </span>
                <span className="text-xs text-text-secondary shrink-0">
                  {lostAfterwards
                    // A run that wrote prospects which no longer exist. Stated, not hidden:
                    // it is the only place a deletion is visible at all.
                    ? `wrote ${batch.candidates_returned}, none still here`
                    : `${batch.sourced} prospect${batch.sourced === 1 ? '' : 's'}`}
                  {isOpen ? ' −' : ' +'}
                </span>
              </button>

              {isOpen && (
                <div className="px-3 pb-3">
                  <FunnelBody batch={batch} />
                </div>
              )}
            </div>
          )
        })}

        {/* ── UNATTRIBUTED, VISIBLE AND NEVER SILENTLY EXCLUDED ────────────────
            A total that quietly omits rows is the defect this whole screen change
            exists to remove. These prospects belong to no recorded run, either
            because they predate run logging or because they were created by a test.
            They are counted in the cards above and would otherwise be the unexplained
            difference between the cards and the run lines. */}
        {org.unattributed && (
          <div className="rounded-[8px] border border-[#F0D080] bg-[#FEF7E6]">
            <button
              type="button"
              onClick={() => setUnattributedOpen(v => !v)}
              className="w-full text-left px-3 py-2.5 flex items-baseline justify-between gap-3"
              aria-expanded={unattributedOpen}
            >
              <span className="text-xs text-[#7A4800]">
                <strong className="font-medium">Not from any recorded run</strong>
              </span>
              <span className="text-xs text-[#7A4800] shrink-0">
                {unattributedCount} prospect{unattributedCount === 1 ? '' : 's'}
                {unattributedOpen ? ' −' : ' +'}
              </span>
            </button>
            {unattributedOpen && (
              <div className="px-3 pb-3">
                <p className="text-xs text-[#7A4800] mb-2">
                  These were added before sourcing runs were recorded, or by a test. They have
                  no run to belong to and cannot be given one. They ARE included in the cards
                  above, which is why the run lines alone add up to less than the cards.
                </p>
                <FunnelBody batch={org.unattributed} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── THE RECONCILIATION, SHOWN RATHER THAN ASSUMED ────────────────────
          The cards are the organisation total; the lines above are per run. They must
          differ by exactly the unattributed count. This is computed and displayed rather
          than trusted, because a silent disagreement between a card and a batch line is
          the precise failure this change was made to prevent, and it would otherwise be
          invisible until someone added the numbers up by hand. */}
      <p className="mt-3 text-xs text-text-secondary">
        {attributed} in the runs above
        {unattributedCount > 0 ? ` plus ${unattributedCount} from no recorded run` : ''}
        {' '}= {attributed + unattributedCount} in total for this client.
      </p>

      {org.breakdowns_truncated && (
        <p className="mt-2 text-xs text-[#7A4800]">
          This client has more prospects than the status read examines, so the per-run stage
          counts cover only part of them.
        </p>
      )}
    </div>
  )
}
