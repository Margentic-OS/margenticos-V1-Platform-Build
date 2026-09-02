'use client'

// The pipeline review cards.
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS POLLS. THAT IS THE POINT OF THE COMPONENT NOW.
//
// Every number here used to come from a React Server Component, which runs once, during
// the request that produced the HTML. There was no subscription, no interval and no
// revalidation, so the screen showed the state of the world at the moment it was opened
// and never corrected itself. Observed seven times in one session, twice on controls that
// spend money: "Awaiting approval 0" beside 100 pending prospects, a research pool
// reported as 14 when it was 31, "Nothing to research" twice while jobs ran normally.
//
// It seeds from the server render, then re-reads /api/operator/sourcing-metrics, which
// calls the SAME function the server render called. A first paint and a poll cannot
// disagree, because there is only one place the numbers are computed.
//
// The mechanics match TriageQueue and FaqCurationView rather than inventing a third
// pattern: 30s interval, ticks only when the tab is visible, immediate tick when it
// becomes visible again, and refs that guarantee exactly one interval and one listener
// however many times the effect runs.
//
// WHY 30 SECONDS. The queue worker is driven by pg_cron on a one-minute schedule, so
// polling faster than the thing being watched buys nothing and costs invocations. For
// scale: that cron already POSTs this deployment 1,440 times a day at up to 280 seconds
// each. One or two operator tabs at 2 requests a minute is not the expensive thing here.
//
// A FAILED POLL KEEPS THE LAST GOOD NUMBERS AND SAYS SO. Rendering zeros on a fetch error
// would reproduce the exact defect this fixes: "0 awaiting approval" is how an operator
// reads "the work is done", and it must never be how they read "we could not look".

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { EnrichAndTierButton } from './EnrichAndTierButton'
import { SourceProspectsButton } from './SourceProspectsButton'
import { ResearchProspectsButton } from './ResearchProspectsButton'
import type { PipelineMetrics, TierMetrics } from '@/lib/operator/sourcing-metrics'
import {
  NOT_SENDABLE_LABELS,
  DISQUALIFIER_LABELS,
  type NotSendableReason,
} from '@/lib/operator/prospect-status'

const POLL_INTERVAL_MS = 30_000

interface PipelineOverviewProps {
  /** The server render's numbers. Seeds the first paint, then the poll takes over. */
  metrics: PipelineMetrics[]
  selectedClientId?: string | null
  /**
   * Ceiling the sourcing entry point enforces. Passed in rather than imported: this is a
   * client component, and importing from sourcing-entry would pull the orchestrator, the
   * Apollo handler and the service-role client into the browser bundle.
   */
  sourcingMaxBatchSize: number
}

/**
 * One tier's card.
 *
 * SHOWS TWO NUMBERS, NOT ONE. The headline is how many prospects tiering kept; underneath is
 * how many of those can actually be emailed. A card reading "Tier 1: 93" when 73 are
 * mailable is not a rounding error, it is the number a campaign gets planned around, and it
 * was wrong by 20 on production the day this was written.
 *
 * The reasons are glossed from prospect-status.ts and never rendered as raw codes: the
 * stored values name countries.
 */
function TierCard({
  label,
  tier,
  labelColor,
  cardClass,
}: {
  label: string
  tier: TierMetrics
  labelColor: string
  cardClass: string
}) {
  const notSendable = tier.total - tier.sendable
  const reasons = Object.entries(tier.notSendableByReason) as Array<[NotSendableReason, number]>

  return (
    <div className={cardClass}>
      <p className={`text-xs uppercase font-normal tracking-[0.07em] ${labelColor} mb-2`}>
        {label}
      </p>
      <p className="text-2xl font-medium text-text-primary">{tier.total}</p>

      {tier.total > 0 && (
        <p className="text-xs text-text-secondary mt-1">
          {tier.sendable} can be emailed
          {notSendable > 0 ? `, ${notSendable} cannot` : ''}
        </p>
      )}

      {reasons.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {reasons
            .sort((a, b) => b[1] - a[1])
            .map(([reason, count]) => (
              <li key={reason} className="text-xs text-text-secondary">
                {count} {NOT_SENDABLE_LABELS[reason].toLowerCase()}
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}

export function PipelineOverview({
  metrics: seedMetrics,
  selectedClientId,
  sourcingMaxBatchSize,
}: PipelineOverviewProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const currentClient = searchParams.get('client')

  const [metrics, setMetrics] = useState<PipelineMetrics[]>(seedMetrics)
  const [staleSince, setStaleSince] = useState<string | null>(null)

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const visibilityTickRef = useRef<(() => void) | null>(null)

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch('/api/operator/sourcing-metrics', { credentials: 'same-origin' })
      if (res.status === 401) { router.push('/login'); return }
      if (res.status === 403) {
        setStaleSince('Your account no longer has operator permissions.')
        return
      }
      if (!res.ok) {
        setStaleSince(`Could not refresh the counts (${res.status}). Showing the last good figures.`)
        return
      }
      const json = await res.json() as { metrics: PipelineMetrics[] }
      // The whole payload is replaced rather than merged. There is no local edit state on
      // this screen to preserve, and merging would be a second place for the numbers to be
      // decided.
      setMetrics(json.metrics ?? [])
      setStaleSince(null)
    } catch {
      setStaleSince('Lost connection. Showing the last good figures.')
    }
  }, [router])

  useEffect(() => {
    // Clear any stale interval and listener before creating new ones, guarding against
    // App Router soft-navigation re-mounts that skip the cleanup phase.
    if (intervalRef.current !== null) clearInterval(intervalRef.current)
    if (visibilityTickRef.current !== null) {
      document.removeEventListener('visibilitychange', visibilityTickRef.current)
    }

    // NO FETCH ON MOUNT. The server render just produced these numbers from the same
    // function; fetching immediately would spend a request to learn what the page already
    // knows. The first poll is one interval away.
    const tick = () => {
      if (document.visibilityState === 'visible') fetchMetrics()
    }

    intervalRef.current = setInterval(tick, POLL_INTERVAL_MS)
    visibilityTickRef.current = tick
    document.addEventListener('visibilitychange', tick)

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      if (visibilityTickRef.current !== null) {
        document.removeEventListener('visibilitychange', visibilityTickRef.current)
        visibilityTickRef.current = null
      }
    }
  }, [fetchMetrics])

  if (metrics.length === 0) {
    return (
      <div className="bg-white rounded-[10px] border border-border-card p-6 text-center">
        <p className="text-text-secondary text-sm">No prospects sourced yet. Once a sourcing run completes, prospects awaiting your approval will appear here.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Never rendered as zeros. See the header: a count we could not read and a count
          that is genuinely zero must not look the same. */}
      {staleSince && (
        <div className="px-3 py-2 rounded-[6px] bg-[#FEF7E6] border border-[#F0D080] text-xs text-[#7A4800]">
          {staleSince}
        </div>
      )}

      {metrics.map((org) => {
        const isSelected = currentClient === org.organisation_id || selectedClientId === org.organisation_id
        const enrichedCount = org.tiers.tier_1.total + org.tiers.tier_2.total + org.tiers.tier_3.total

        return (
          <div
            key={org.organisation_id}
            className={`rounded-[10px] border p-6 transition-colors ${
              isSelected
                ? 'border-brand-green-primary bg-white'
                : 'border-border-card bg-white hover:bg-[#FAFAF8]'
            }`}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-medium text-text-primary">
                {org.organisation_name}
              </h3>
              {isSelected && (
                <span className="text-xs font-medium px-2 py-1 rounded-full bg-[#EBF5E6] text-[#3B6D11] border border-[#BDDAB0]">
                  Selected
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              {/* Pending review stage */}
              <div className="bg-[#FAEEDA] rounded-[8px] p-3 border border-[#F0D080]">
                <p className="text-xs uppercase font-normal tracking-[0.07em] text-[#7A4800] mb-2">
                  Awaiting approval
                </p>
                <p className="text-2xl font-medium text-text-primary">
                  {org.pending_review_count}
                </p>
              </div>

              {/* Enriching stage */}
              {org.approved_unenriched_count > 0 && (
                <div className="bg-[#FEF7E6] rounded-[8px] p-3 border border-[#F0D080]">
                  <p className="text-xs uppercase font-normal tracking-[0.07em] text-[#7A4800] mb-2">
                    Enriching
                  </p>
                  <p className="text-2xl font-medium text-text-primary">
                    {org.approved_unenriched_count}
                  </p>
                </div>
              )}

              {/* The three tiers, from one component so they cannot drift apart. */}
              {enrichedCount > 0 && (
                <TierCard
                  label="Tier 1"
                  tier={org.tiers.tier_1}
                  labelColor="text-[#3B6D11]"
                  cardClass="bg-[#EBF5E6] rounded-[8px] p-3 border border-[#BDDAB0]"
                />
              )}

              {enrichedCount > 0 && (
                <TierCard
                  label="Tier 2"
                  tier={org.tiers.tier_2}
                  labelColor="text-[#5D7F23]"
                  cardClass="bg-[#EAF3DE] rounded-[8px] p-3 border border-[#C0DD97]"
                />
              )}

              {enrichedCount > 0 && (
                <TierCard
                  label="Tier 3"
                  tier={org.tiers.tier_3}
                  labelColor="text-[#9A9488]"
                  cardClass="bg-[#F0ECE4] rounded-[8px] p-3"
                />
              )}

              {/* Removed. Shown beside the tiers because the tier counts on their own
                  are survivors, and a batch that lost most of itself looks identical
                  to a small batch that did not. */}
              {org.removed_count > 0 && (
                <div className="bg-[#FDEEE8] rounded-[8px] p-3 border border-[#EFBCAA]">
                  <p className="text-xs uppercase font-normal tracking-[0.07em] text-[#8B2020] mb-2">
                    Removed
                  </p>
                  <p className="text-2xl font-medium text-text-primary">
                    {org.removed_count}
                  </p>
                  {/* WHICH disqualifier, not just how many. The count alone says a filter
                      ran; it does not say whether the filter is behaving. An unrecognised
                      code renders as itself rather than vanishing. */}
                  <ul className="mt-1 space-y-0.5">
                    {Object.entries(org.removed_by_reason)
                      .sort((a, b) => b[1] - a[1])
                      .map(([code, count]) => (
                        <li key={code} className="text-xs text-text-secondary">
                          {count} {(DISQUALIFIER_LABELS[code] ?? code).toLowerCase()}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </div>

            {/* ── VERIFICATION THAT FAILED ──────────────────────────────────────
                Previously visible NOWHERE in the product. A third of a cohort sat on
                provider 403 and 429 responses for ninety minutes and the screen showed
                nothing at all: the prospects simply never appeared downstream, which reads
                as "still working" rather than "stopped".

                The provider is not named. The stored error text contains a vendor name and
                rendering the column would put it on screen; only the status survives. See
                prospect-status.ts. */}
            {org.verification_failures.count > 0 && (
              <div className="mb-4 px-3 py-2 rounded-[6px] bg-[#FDEEE8] border border-[#EFBCAA] text-xs text-[#8B2020]">
                <p className="font-medium mb-0.5">
                  {org.verification_failures.count} prospect
                  {org.verification_failures.count === 1 ? '' : 's'} failed email verification
                </p>
                <p>
                  {Object.entries(org.verification_failures.byStatus)
                    .sort((a, b) => b[1] - a[1])
                    .map(([status, count]) =>
                      status === 'unknown'
                        ? `${count} with no status recorded`
                        : `${count} on HTTP ${status}`)
                    .join(', ')}
                  .
                  {org.verification_failures.givenUp > 0 && (
                    <>
                      {' '}
                      {org.verification_failures.givenUp} have used every attempt, so nothing
                      will retry them without being asked.
                    </>
                  )}
                </p>
              </div>
            )}

            {/* The breakdowns above are of a sample. Said out loud, because a truncated
                explanation that does not announce itself reads as a complete one. */}
            {org.breakdowns_truncated && (
              <div className="mb-4 px-3 py-2 rounded-[6px] bg-[#FEF7E6] border border-[#F0D080] text-xs text-[#7A4800]">
                This client has more prospects than the status read examines, so the
                sendable, removal and verification breakdowns above cover only part of them.
                The headline counts are complete.
              </div>
            )}

            {/* Run the pipeline: source, then research. Both run inside one request and
                refuse a batch too large to finish, so neither needs a queue yet. */}
            <div className="space-y-3 mb-6 pb-6 border-b border-border-card">
              <SourceProspectsButton
                organisationId={org.organisation_id}
                maxBatchSize={sourcingMaxBatchSize}
              />
              <ResearchProspectsButton
                organisationId={org.organisation_id}
                verdict={org.research}
              />
            </div>

            {/* Action buttons */}
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {/* ── NAMED BY WHAT IT DOES, WITH ITS COUNT ─────────────────────
                    This said "Review pending" and the one below said "Review quality".
                    Two buttons starting with the same verb, neither naming its action,
                    and an operator could not tell which one approved prospects. This is
                    the approval step: it is where prospects are approved for enrichment,
                    so it says so, and it carries the number it will act on. */}
                {org.pending_review_count > 0 && (
                  <Link
                    href={`/dashboard/operator/sourcing-review/approve?client=${org.organisation_id}`}
                    className="text-sm font-medium px-3 py-1.5 rounded-[6px] bg-[#1C3A2A] text-white hover:bg-[#152e21] transition-colors"
                  >
                    Approve {org.pending_review_count} prospect{org.pending_review_count === 1 ? '' : 's'}
                  </Link>
                )}

                {org.approved_unenriched_count > 0 && (
                  <>
                    <EnrichAndTierButton organisationId={org.organisation_id} />
                  </>
                )}

                {/* Reachable when everything was removed, not only when something
                    survived. Gating this on enrichedCount alone hid the quality screen
                    in exactly the case where its removal breakdown is the only thing
                    that explains where the batch went. */}
                {/* The other step, named for the decision it leads to. Publishing for
                    client review happens on that screen and nothing on this one said so. */}
                {(enrichedCount > 0 || org.removed_count > 0) && (
                  <Link
                    href={`/dashboard/operator/sourcing-review/review?client=${org.organisation_id}`}
                    className="text-sm font-medium px-3 py-1.5 rounded-[6px] bg-[#1C3A2A] text-white hover:bg-[#152e21] transition-colors"
                  >
                    {enrichedCount > 0
                      ? `Check ${enrichedCount} and publish for the client`
                      : 'See why all were removed'}
                  </Link>
                )}

                {org.pending_review_count === 0 && org.approved_unenriched_count === 0 && enrichedCount === 0 && org.removed_count === 0 && (
                  <span className="text-xs text-text-secondary">No prospects to review.</span>
                )}
              </div>

              {/* Spend & dormant warning */}
              {org.approved_unenriched_count > 0 && (
                <div className="text-xs text-[#7A4800] bg-[#FEF7E6] px-3 py-2 rounded-[6px] border border-[#F0D080]">
                  <p className="font-medium mb-0.5">Enrich and tier spends enrichment credits</p>
                  <p>Currently in test mode. No live API calls will be made yet.</p>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
