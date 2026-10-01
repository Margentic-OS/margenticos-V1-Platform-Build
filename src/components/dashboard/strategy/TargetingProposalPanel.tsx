'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProposalPanelView, RetierView } from '@/lib/dashboard/targeting-proposal-view'
import type { CursorDecision } from '@/lib/sourcing/approve-icp-filter-spec'
import type { ReplayState } from '@/lib/sourcing/tiering-replay'

// The before-and-after for a proposed change to a client's search settings. ADR-061.
//
// Operator only. A targeting field changed, which filed a proposal BESIDE the live
// settings. Nothing about the search moves until Approve is pressed here, and Reject
// throws the proposal away.
//
// ─── WHAT THIS COMPONENT DECIDES: NOTHING ────────────────────────────────────
//
// Every fact on it arrives in `view`, computed on the server by the same plan the approve
// route runs. The component renders it and sends two things back: the fingerprint it was
// given, and the ticks. The route re-checks all of it. A browser that enabled the button
// early would still be refused.
//
// ─── RULE ZERO ───────────────────────────────────────────────────────────────
//
// Every string below is fixed copy. Nothing in this file names an industry, a job title,
// a seniority band, a country or a client. Those reach the screen only inside `view`,
// from that client's own settings.

const STATE_WORDS = {
  tier_1: 'tier 1',
  tier_2: 'tier 2',
  tier_3: 'tier 3',
  removed: 'removed',
  not_tiered: 'not yet tiered',
} as const satisfies Record<ReplayState, string>

const CURSOR_SENTENCES = {
  request_unchanged:
    'The search itself does not change, so this client keeps their place in it.',
  request_changed:
    'The search changes, so this client starts again from the first result. People already held are skipped as duplicates.',
  first_settings:
    'These are this client’s first search settings. Sourcing can start once they are approved.',
  request_not_built:
    'The old and new searches could not be compared, so this client starts again from the first result.',
} as const satisfies Record<CursorDecision['why'], string>

function people(count: number): string {
  return `${count} ${count === 1 ? 'prospect' : 'prospects'}`
}

function Retier({ retier }: { retier: RetierView }) {
  if (retier.kind === 'none') {
    return (
      <p className="text-[12px] text-text-secondary leading-relaxed">
        This change touches nothing tiering reads. Nobody is re-tiered.
      </p>
    )
  }

  if (retier.kind === 'unavailable') {
    return (
      <p className="text-[12px] text-[#9A5B13] leading-relaxed">
        The replay could not be run, so who would be re-tiered is not shown. Approving still
        puts removed prospects back into tiering.
      </p>
    )
  }

  const enriched = retier.requeued - retier.requeued_not_enriched
  const landing = retier.requeued_outcome.filter(outcome => outcome.count > 0)

  return (
    <div className="space-y-3">
      <div>
        <p className="text-[12px] text-text-primary leading-relaxed">
          {retier.requeued === 0
            ? 'No removed prospects to put back into tiering.'
            : `${people(retier.requeued)} removed earlier ${retier.requeued === 1 ? 'goes' : 'go'} back into tiering.`}
        </p>
        {enriched > 0 && (
          <ul className="mt-1.5 space-y-1">
            {landing.map(outcome => (
              <li key={outcome.to} className="text-[12px] text-text-secondary leading-relaxed">
                {outcome.to === 'removed'
                  ? `${outcome.count} would be removed again`
                  : `${outcome.count} would now be ${STATE_WORDS[outcome.to]}`}
              </li>
            ))}
          </ul>
        )}
        {retier.requeued_not_enriched > 0 && (
          <p className="text-[12px] text-text-secondary leading-relaxed mt-1">
            {retier.requeued_not_enriched} of them {retier.requeued_not_enriched === 1 ? 'was' : 'were'} removed
            before enrichment and {retier.requeued_not_enriched === 1 ? 'goes' : 'go'} back to the buyer check.
            Any that pass are enriched, which uses credits.
          </p>
        )}
      </div>

      <div>
        <p className="text-[12px] text-text-primary leading-relaxed">
          {retier.survivors_moved.length === 0
            ? 'Nobody already in a tier would be judged differently.'
            : 'People already in a tier keep it. The new settings would judge some of them differently:'}
        </p>
        {retier.survivors_moved.length > 0 && (
          <ul className="mt-1.5 space-y-1">
            {retier.survivors_moved.map(movement => (
              <li
                key={`${movement.from}-${movement.to}`}
                className="text-[12px] text-text-secondary leading-relaxed"
              >
                {movement.to === 'removed'
                  ? `${movement.count} in ${STATE_WORDS[movement.from]} would be removed`
                  : `${movement.count} in ${STATE_WORDS[movement.from]} would be ${STATE_WORDS[movement.to]}`}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-[11px] text-text-muted leading-relaxed">
        Replayed over {people(retier.judged)} with enrichment on file.
      </p>
    </div>
  )
}

export function TargetingProposalPanel({ view }: { view: ProposalPanelView }) {
  const router = useRouter()
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set())
  const [confirmingReject, setConfirmingReject] = useState(false)
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const allTicked = view.exclusions.every((_, index) => ticked.has(index))
  const canApprove = view.blockers.length === 0 && allTicked && busy === null

  function toggle(index: number) {
    setTicked(current => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  async function send(action: 'approve' | 'reject') {
    setError(null)
    setBusy(action)
    try {
      const res = await fetch(`/api/operator/icp-filter-spec/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          action === 'approve'
            ? {
                document_id: view.document_id,
                fingerprint: view.fingerprint,
                confirmed_removals: view.exclusions
                  .filter((_, index) => ticked.has(index))
                  .flatMap(exclusion => exclusion.keys),
              }
            : { document_id: view.document_id, fingerprint: view.fingerprint },
        ),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        setError(data.error ?? 'Something went wrong. Nothing was changed.')
        setBusy(null)
        return
      }
      setBusy(null)
      setConfirmingReject(false)
      router.refresh()
    } catch {
      setError('Could not reach the server. Nothing was changed.')
      setBusy(null)
    }
  }

  return (
    <section
      aria-label="Proposed change to the search settings"
      className="mb-4 bg-[#F7F5F0] border border-dashed border-border-card rounded-[10px] p-5 print:hidden"
    >
      <div className="flex items-center justify-between gap-3 mb-1">
        <h3 className="text-[13px] font-medium text-text-primary">
          {view.first_settings ? 'First search settings, waiting for approval' : 'Proposed change to the search'}
        </h3>
        <span className="text-[9px] font-medium text-text-secondary bg-[#F0ECE4] px-2 py-0.5 rounded-[4px] shrink-0">
          Not shown to the client
        </span>
      </div>
      <p className="text-[12px] text-text-secondary leading-relaxed mb-4">
        {view.first_settings
          ? 'This client has no search settings yet. Nothing is sourced until these are approved.'
          : 'A targeting field changed. The search keeps running on the current settings until this is approved.'}
      </p>

      <div className="space-y-4">
        <div>
          <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-2">
            What changes
          </p>
          {view.changes.length === 0 ? (
            <p className="text-[12px] text-text-secondary leading-relaxed">
              Nothing the search or tiering does would change.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {view.changes.map((change, index) => (
                <li key={index} className="text-[12px] text-text-primary leading-relaxed">
                  <span className="font-medium">{change.label}:</span> {change.detail}
                </li>
              ))}
            </ul>
          )}
          {view.criterion_held && (
            <p className="text-[12px] text-[#9A5B13] leading-relaxed mt-2">
              The buyer criterion was derived again and came back {view.criterion_held.status.replace(/_/g, ' ')},
              which would not be applied to anyone. The current criterion is kept in this proposal.
              {view.criterion_held.reason ? ` Reason given: ${view.criterion_held.reason}` : ''}
            </p>
          )}
        </div>

        <div>
          <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-2">
            Place in the search
          </p>
          <p className="text-[12px] text-text-primary leading-relaxed">
            {CURSOR_SENTENCES[view.cursor.why]}
          </p>
        </div>

        <div>
          <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-2">
            Who would be re-tiered
          </p>
          <Retier retier={view.retier} />
        </div>

        {view.exclusions.length > 0 && (
          <div>
            <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-2">
              Exclusions this removes
            </p>
            <p className="text-[12px] text-text-secondary leading-relaxed mb-2">
              Tick each one to confirm it. Approve stays off until all are ticked.
            </p>
            <ul className="space-y-1.5">
              {view.exclusions.map((exclusion, index) => (
                <li key={index}>
                  <label className="flex items-start gap-2 text-[12px] text-text-primary leading-relaxed cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ticked.has(index)}
                      onChange={() => toggle(index)}
                      disabled={busy !== null}
                      className="mt-[3px]"
                    />
                    <span>{exclusion.label}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        {view.blockers.length > 0 && (
          <div role="alert" className="border border-[#EFBCAA] bg-[#FDEEE8] rounded-[8px] px-4 py-3">
            <p className="text-[12px] font-medium text-text-primary mb-1">This cannot be approved as it stands</p>
            {view.blockers.map((blocker, index) => (
              <p key={index} className="text-[12px] text-text-secondary leading-relaxed">{blocker}</p>
            ))}
          </div>
        )}

        {error && (
          <p role="alert" className="text-[12px] text-[#C0392B] leading-relaxed">{error}</p>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => send('approve')}
            disabled={!canApprove}
            className="text-[11px] text-white bg-[#1C3A2A] hover:bg-[#152e21] px-3 py-1.5 rounded-[6px] disabled:opacity-40 transition-colors focus-visible:ring-2 focus-visible:ring-[#1C3A2A] focus-visible:ring-offset-1"
          >
            {busy === 'approve' ? 'Approving…' : 'Approve change'}
          </button>

          {confirmingReject ? (
            <>
              <button
                onClick={() => send('reject')}
                disabled={busy !== null}
                className="text-[11px] text-white bg-[#C0392B] hover:bg-[#a93226] px-3 py-1.5 rounded-[6px] disabled:opacity-40 transition-colors"
              >
                {busy === 'reject' ? 'Rejecting…' : 'Confirm reject'}
              </button>
              <button
                onClick={() => setConfirmingReject(false)}
                disabled={busy !== null}
                className="text-[11px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => { setConfirmingReject(true); setError(null) }}
              disabled={busy !== null}
              className="text-[11px] text-text-secondary border border-border-card hover:border-text-secondary rounded-[6px] px-3 py-1.5 transition-colors disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-[#1C3A2A] focus-visible:ring-offset-1"
            >
              Reject
            </button>
          )}
        </div>

        {confirmingReject && (
          <p className="text-[11px] text-text-muted leading-relaxed">
            Rejecting leaves the search exactly as it is. The ICP will still say something different,
            so change the targeting field back or this proposal is filed again at the next edit.
          </p>
        )}
      </div>
    </section>
  )
}

/** Shown when a proposal may be waiting and could not be read. Never fails silently. */
export function TargetingProposalUnavailable() {
  return (
    <div
      role="alert"
      className="mb-4 border border-[#EFBCAA] bg-[#FDEEE8] rounded-[10px] px-5 py-4 print:hidden"
    >
      <p className="text-[12px] font-medium text-text-primary mb-1">
        The search settings could not be checked for a proposed change
      </p>
      <p className="text-[12px] text-text-secondary leading-relaxed">
        A change may be waiting for approval. Refresh to try again. The search keeps running on
        the current settings either way.
      </p>
    </div>
  )
}
