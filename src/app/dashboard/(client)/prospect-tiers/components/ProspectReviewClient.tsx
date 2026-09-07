'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { RosterGroup, RosterProspect } from '@/lib/dashboard/prospect-roster'
import { defaultGroupKey, formatDayLabel } from '@/lib/dashboard/prospect-roster'
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
  autoSanctionDate: string | null
  organisationId: string
}

export function ProspectReviewClient({
  groups,
  pendingCount,
  rosterCount,
  autoSanctionDate,
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
    const canRemove = groupIsTask && isPending(prospect)

    return (
      <div key={prospect.id} className="border-b border-gray-200 hover:bg-gray-50">
        <div className="px-6 py-4 flex items-center gap-6">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-gray-900 truncate">{fullName}</p>
            <p className="text-sm text-gray-600 truncate">{prospect.company_name || 'N/A'}</p>
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-sm text-gray-700 truncate">{prospect.job_title || 'N/A'}</p>
          </div>

          <div className="flex items-center gap-3 flex-shrink-0">
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
            <p className="text-sm text-gray-600 mt-2">
              {hasPending
                ? 'Remove anyone you would rather we not contact. We proceed with the rest.'
                : 'Everyone we are contacting on your behalf, grouped by when they joined the campaign.'}
            </p>
          </div>

          {hasPending && autoSanctionDate && (
            <div className="text-sm text-gray-600">
              Auto-approved on {formatDayLabel(autoSanctionDate)} if no action taken.
            </div>
          )}
        </div>
      </div>

      {/* Group tabs */}
      {groups.length > 1 && (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Prospect batches">
          {groups.map(group => {
            const active = group.key === selectedGroup?.key
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
                  {group.prospects.length}
                </span>
              </button>
            )
          })}
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
      {hasPending && (
        approvalState === 'done' ? (
          <div className="bg-green-50 rounded-lg border border-green-200 p-8 text-center">
            <p className="text-lg font-semibold text-green-900">Done. We will take it from here.</p>
            <p className="text-sm text-green-800 mt-2">Updating your list...</p>
          </div>
        ) : (
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
      )}

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
