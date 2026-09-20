'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { RosterGroup, RosterProspect } from '@/lib/dashboard/prospect-roster'
import { defaultGroupKey, formatDayLabel } from '@/lib/dashboard/prospect-roster'
import type { AutoApprovalNotice } from '@/lib/dashboard/auto-approval-notice'
import { RemovalReasonModal } from './RemovalReasonModal'
import { logger } from '@/lib/logger'

const REMOVAL_REASONS = [
  'Wrong industry',
  'Too small',
  'Competitor or conflict',
  'Already know them',
  'Just not right',
]

interface ProspectReviewClientProps {
  groups: RosterGroup[]
  pendingCount: number
  rosterCount: number
  /** What to say about automatic approval, if anything. See auto-approval-notice.ts. */
  autoApproval: AutoApprovalNotice
  organisationId: string
  /**
   * True when an operator is viewing this client-facing screen, including under
   * "View as client". It HIDES approve and remove. See canAct below.
   */
  viewerIsOperator: boolean
}

export function ProspectReviewClient({
  groups,
  pendingCount,
  rosterCount,
  autoApproval,
  viewerIsOperator,
}: ProspectReviewClientProps) {
  const router = useRouter()
  const [removals, setRemovals] = useState<Record<string, { reason: string; collapsed: boolean }>>({})
  const [approvalState, setApprovalState] = useState<'idle' | 'confirming' | 'processing' | 'done'>('idle')
  const [removingProspectId, setRemovingProspectId] = useState<string | null>(null)
  const [isRemovalLoading, setIsRemovalLoading] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(() => defaultGroupKey(groups))

  // Only a prospect still awaiting a decision can be removed, so this subtraction is over
  // one population rather than two. The previous version subtracted every removal from a
  // pending-only total, so removing an already-decided row drove the button below the
  // true count and could disable approval while prospects were still pending.
  const remainingCount = pendingCount - Object.keys(removals).length

  // AN OPERATOR MAY NOT APPROVE OR REJECT ON A CLIENT'S BEHALF. Decided 2026-09-08.
  // This screen is a client-facing handshake by design. An operator acting through a URL
  // parameter is a different capability, and it would need its own decision, its own audit
  // trail and its own attribution. It must not arrive as a side effect of a view mode.
  //
  // Hiding is the whole control at this layer, not a cosmetic one. The two write routes
  // still resolve the ACTOR's organisation rather than the one being viewed, so an operator
  // pressing these would have got a 404 from reject and a wrongly scoped approve-all. That
  // resolver defect is deliberately left in place and tracked; hiding the buttons is what
  // removes the live consequence. Do not "fix" those routes to honour ?client= without
  // reopening the decision above.
  const canAct = !viewerIsOperator

  const selectedGroup = groups.find(g => g.key === selectedKey) ?? groups[0]

  const isPending = (p: RosterProspect) => p.client_review_status === 'pending_review'

  const handleRemove = async (prospectId: string, reason: string) => {
    setIsRemovalLoading(true)

    try {
      const response = await fetch('/api/dashboard/client/prospects/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospect_id: prospectId, reason: reason || null }),
      })

      if (!response.ok) {
        const json = await response.json()
        throw new Error(json.error ?? `HTTP ${response.status}`)
      }

      setRemovals({
        ...removals,
        [prospectId]: { reason, collapsed: true },
      })
      setRemovingProspectId(null)
      setIsRemovalLoading(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('ProspectReviewClient: remove failed', { prospect_id: prospectId, error: msg })
      alert(`Failed to remove prospect: ${msg}`)
      setRemovingProspectId(null)
      setIsRemovalLoading(false)
    }
  }

  const handleUndo = (prospectId: string) => {
    const { [prospectId]: _removed, ...rest } = removals
    setRemovals(rest)
  }

  const handleApproveAll = async () => {
    if (approvalState !== 'confirming') {
      setApprovalState('confirming')
      return
    }

    setApprovalState('processing')
    try {
      const removedIds = Object.keys(removals)
      const response = await fetch('/api/dashboard/client/prospects/approve-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ removed_prospect_ids: removedIds }),
      })

      if (!response.ok) {
        const json = await response.json()
        throw new Error(json.error ?? `HTTP ${response.status}`)
      }

      setApprovalState('done')
      // The roster stays reachable after approval, so this refreshes into the read-only
      // state rather than navigating away from it.
      setTimeout(() => {
        router.refresh()
        setApprovalState('idle')
      }, 2000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('ProspectReviewClient: approve all failed', { error: msg })
      alert(`Failed to approve prospects: ${msg}`)
      setApprovalState('idle')
    }
  }

  const renderProspectRow = (prospect: RosterProspect, groupIsTask: boolean) => {
    const isRemoved = prospect.id in removals
    const removal = removals[prospect.id]

    if (isRemoved && removal.collapsed) {
      return (
        <div key={prospect.id} className="border-b border-gray-200 hover:bg-gray-50">
          <div className="px-6 py-3 flex items-center justify-between">
            <div className="text-sm text-gray-500">Removed ({removal.reason})</div>
            <button
              onClick={() => handleUndo(prospect.id)}
              className="text-xs text-blue-600 hover:text-blue-700 font-medium"
            >
              Undo
            </button>
          </div>
        </div>
      )
    }

    const firstName = prospect.first_name || ''
    const lastName = prospect.last_name || ''
    const fullName = `${firstName} ${lastName}`.trim() || 'Unknown'

    // Remove is offered only where it means something: a prospect still awaiting this
    // client's decision, inside a group that is still a task. Everything else is a record.
    const canRemove = canAct && groupIsTask && isPending(prospect)

    return (
      <div key={prospect.id} className="border-b border-gray-200 hover:bg-gray-50">
        {/* ── A GRID, NOT THREE FLEX CHILDREN ─────────────────────────────────
            The job title column started at a different horizontal position on every row,
            so the titles read as ragged down the list. The cause was the actions column:
            it was `flex-shrink-0`, so its width changed with how many icons a prospect
            happened to have and whether Remove was offered, and the two `flex-1` columns
            above absorbed the difference row by row.

            Fixed column widths make every row start its title in the same place. The
            titles themselves are untouched: they are the prospect's own words and
            normalising them would be rewriting the data to fit the layout. */}
        <div className="px-6 py-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_11rem] items-center gap-6">
          <div className="min-w-0">
            <p className="font-medium text-gray-900 truncate">{fullName}</p>
            <p className="text-sm text-gray-600 truncate">{prospect.company_name || 'N/A'}</p>
          </div>

          <div className="min-w-0">
            <p className="text-sm text-gray-700 truncate">{prospect.job_title || 'N/A'}</p>
          </div>

          <div className="flex items-center justify-end gap-3 min-w-0">
            {prospect.linkedin_url && (
              <a
                href={prospect.linkedin_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 hover:text-gray-600 transition-colors"
                title="LinkedIn profile"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z" />
                </svg>
              </a>
            )}
            {prospect.website_url && (
              <a
                href={prospect.website_url.startsWith('http') ? prospect.website_url : `https://${prospect.website_url}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 hover:text-gray-600 transition-colors"
                title="Website"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4m-4-6l6 6m0 0l-6 6m6-6H3" />
                </svg>
              </a>
            )}
            {canRemove && (
              <button
                onClick={() => setRemovingProspectId(prospect.id)}
                className="text-sm font-medium text-red-600 hover:text-red-700 whitespace-nowrap"
              >
                Remove
              </button>
            )}

            {/* ── WHY THERE IS NO REMOVE CONTROL ON THIS ROW ─────────────────
                A prospect who is on the list but cannot currently be emailed had no
                control and no explanation, which reads as a broken button rather than as
                a state.

                THEY ARE NOT HIDDEN INSTEAD, and that is a decision already on the record
                rather than one taken here: the roster is a permanent record of who is
                being contacted (Decisions Log 2026-09-07), and filtering on current
                sendability would erase the evidence that we mailed someone before a rule
                changed. See the header of prospect-roster.ts, which measures two such
                prospects on the live organisation.

                The wording says what it means for the CLIENT and nothing about our
                machinery: no verification verdict, no country, no operator action, no
                vendor. Those are all operator-facing facts and none of them is the
                client's to act on. */}
            {!isPending(prospect) && prospect.email_send_eligible !== true && (
              <span
                className="text-xs text-gray-500 whitespace-nowrap"
                title="We are not emailing this person at the moment, so there is nothing to remove."
              >
                Not being contacted
              </span>
            )}
          </div>
        </div>
      </div>
    )
  }

  const removingProspect = groups
    .flatMap(g => g.prospects)
    .find(p => p.id === removingProspectId)
  const removingProspectName = removingProspect
    ? `${(removingProspect.first_name || '').trim()} ${(removingProspect.last_name || '').trim()}`.trim() || 'this prospect'
    : 'this prospect'

  const hasPending = pendingCount > 0

  /**
   * The approve control, rendered at the TOP and the BOTTOM of the list.
   *
   * It existed only at the bottom, past every prospect. On a list of a hundred that is a
   * long scroll to reach the only control that finishes the task, and a client who has
   * decided after the first few rows still has to travel to act on it.
   *
   * ONE FUNCTION, TWO PLACEMENTS, so the two can never disagree about the count, the
   * disabled condition or the confirm step. Two copies of this markup would be two things
   * to keep in step by hand, which is the shape that put a stale date in the banner above.
   * `position` only varies the key and the spacing.
   */
  function approveControl(position: 'top' | 'bottom') {
    if (approvalState === 'done') {
      // The success state is rendered once, at the bottom, rather than twice. Two identical
      // "Done" panels on one screen reads as two separate things having happened.
      if (position === 'top') return null
      return (
        <div className="bg-green-50 rounded-lg border border-green-200 p-8 text-center">
          <p className="text-lg font-semibold text-green-900">Done. We will take it from here.</p>
          <p className="text-sm text-green-800 mt-2">Updating your list...</p>
        </div>
      )
    }

    return (
      <div className="flex justify-center">
        <button
          onClick={handleApproveAll}
          disabled={remainingCount === 0}
          className={`px-8 py-3 rounded font-semibold text-white transition-colors ${
            remainingCount === 0
              ? 'bg-gray-400 cursor-not-allowed'
              : approvalState === 'processing'
                ? 'bg-blue-400 cursor-wait'
                : approvalState === 'confirming'
                  ? 'bg-blue-700 hover:bg-blue-800'
                  : 'bg-blue-600 hover:bg-blue-700'
          }`}
        >
          {approvalState === 'processing'
            ? 'Approving...'
            : approvalState === 'confirming'
              ? `Confirm: approve ${remainingCount} remaining`
              : `Approve remaining ${remainingCount}`}
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header. Nothing here names an industry or a buyer type: this surface serves any
          B2B client, and the previous copy hardcoded one sector into the headline. */}
      <div className="bg-white rounded-lg border border-gray-200 p-8 shadow-sm">
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">
              {hasPending
                ? `${pendingCount} ${pendingCount === 1 ? 'person' : 'people'} ready for your review`
                : `${rosterCount} ${rosterCount === 1 ? 'person' : 'people'} in your campaign`}
            </h2>
            {/* The headline number counts across every group below, which nothing said.
                A client reading "49 people ready for your review" above tabs reading 35
                and 14 had no way to know whether those were the same 49. */}
            <p className="text-sm text-gray-600 mt-2">
              {!canAct
                ? 'Operator view. This is the client\u2019s screen exactly as they see it, without their decisions attached to your account.'
                : hasPending
                  ? 'Remove anyone you would rather we not contact. We proceed with the rest. This total covers every group below.'
                  : 'Everyone we are contacting on your behalf, grouped by when they joined the campaign. This total covers every group below.'}
            </p>
          </div>

          {/* ── AUTOMATIC APPROVAL, OR THE ABSENCE OF IT ──────────────────────
              This read "Auto-approved on 15 Aug 2026 if no action taken" on 17 September,
              a deadline five weeks in the past, because it was anchored on the first time
              anything in the tier had ever been published rather than on the batch in
              front of the client. A date is shown here only when it is genuinely in the
              future AND automatic approval can actually happen; otherwise the true
              position is stated with no date in it. See auto-approval-notice.ts. */}
          {hasPending && autoApproval.kind === 'scheduled' && (
            <div className="text-sm text-gray-600">
              If you do nothing, we will go ahead with everyone here on{' '}
              {formatDayLabel(autoApproval.onISO)}.
            </div>
          )}

          {hasPending && autoApproval.kind === 'no_automatic_approval' && (
            <div className="text-sm text-gray-600">
              These are waiting on you. We will not add anyone automatically, so they stay
              here until you approve them.
            </div>
          )}
        </div>
      </div>

      {/* The same control as the one at the foot of the list, so a decision made early does
          not require scrolling past everyone to act on it. */}
      {hasPending && canAct && approveControl('top')}

      {/* ── THE TABS, WITH THEIR NUMBERS EXPLAINED ────────────────────────────
          A row of dates each carrying a bare number, beside a headline carrying another
          number, beside a button carrying a third. Nothing said how any of them related,
          so a client could not tell whether the tab counts were subsets of the headline,
          alternatives to it, or something else.

          Three things are named now: what a tab IS (a day we added people), what its
          number counts (everyone in that group, not only the ones awaiting a decision),
          and which of them still need the client. The per-tab "N to review" only appears
          where there is something to review, so a tab that is purely a record stays
          quiet. */}
      {groups.length > 1 && (
        <div className="space-y-2">
          <p className="text-sm text-gray-600">
            Grouped by the day we added them to your campaign. Each number is everyone in
            that group; where a group still needs you, it says so.
          </p>
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Prospect batches">
            {groups.map(group => {
              const active = group.key === selectedGroup?.key
              const pendingInGroup = group.prospects.filter(isPending).length
              return (
                <button
                  key={group.key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSelectedKey(group.key)}
                  className={`px-4 py-2 rounded-full text-sm font-medium border transition-colors ${
                    active
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {group.label}
                  <span className={`ml-2 text-xs ${active ? 'text-gray-300' : 'text-gray-500'}`}>
                    {group.prospects.length} {group.prospects.length === 1 ? 'person' : 'people'}
                    {pendingInGroup > 0 ? `, ${pendingInGroup} to review` : ''}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {selectedGroup && (
        <>
          <p className="text-sm text-gray-600">{selectedGroup.subtitle}</p>

          <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
            <div>{selectedGroup.prospects.map(p => renderProspectRow(p, selectedGroup.isTask))}</div>
          </div>
        </>
      )}

      {/* Approval only exists while something is pending. Once approved this whole
          section is gone rather than disabled: the page is a record, not a dead task. */}
      {hasPending && !canAct && (
        <div className="bg-[#FEF7E6] rounded-[10px] border border-[#F0D080] p-4 text-center">
          <p className="text-sm text-[#7A4800]">
            {pendingCount} {pendingCount === 1 ? 'person is' : 'people are'} awaiting the
            client&rsquo;s approval. Only they can approve or remove.
          </p>
        </div>
      )}

      {hasPending && canAct && approveControl('bottom')}

      {removingProspectId && (
        <RemovalReasonModal
          prospectName={removingProspectName}
          reasons={REMOVAL_REASONS}
          isLoading={isRemovalLoading}
          onSelect={(reason: string) => handleRemove(removingProspectId, reason)}
          onCancel={() => setRemovingProspectId(null)}
        />
      )}
    </div>
  )
}
