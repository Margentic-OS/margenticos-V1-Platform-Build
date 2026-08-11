'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Prospect } from '@/lib/prospect-tiers-data'
import { RemovalReasonPicker } from './RemovalReasonPicker'
import { logger } from '@/lib/logger'

const REMOVAL_REASONS = [
  'Wrong industry',
  'Too small',
  'Competitor or conflict',
  'Already know them',
  'Just not right',
]

interface ProspectWithTier extends Prospect {
  tier: 'tier_1' | 'tier_2' | 'tier_3'
}

interface ProspectReviewClientProps {
  prospects: ProspectWithTier[]
  pendingCount: number
  autoSanctionDate: string | null
  organisationId: string
}

export function ProspectReviewClient({
  prospects,
  pendingCount,
  autoSanctionDate,
  organisationId,
}: ProspectReviewClientProps) {
  const router = useRouter()
  const [removals, setRemovals] = useState<Record<string, { reason: string; collapsed: boolean }>>({})
  const [approvalState, setApprovalState] = useState<'idle' | 'confirming' | 'processing' | 'done'>('idle')
  const [activeReasonPicker, setActiveReasonPicker] = useState<string | null>(null)

  const remainingCount = pendingCount - Object.keys(removals).length

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  const handleRemove = async (prospectId: string, reason: string) => {
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
      setActiveReasonPicker(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('ProspectReviewClient: remove failed', { prospect_id: prospectId, error: msg })
      alert(`Failed to remove prospect: ${msg}`)
      setActiveReasonPicker(null)
    }
  }

  const handleUndo = (prospectId: string) => {
    const { [prospectId]: _, ...rest } = removals
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
      setTimeout(() => {
        router.push('/dashboard')
      }, 2000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('ProspectReviewClient: approve all failed', { error: msg })
      alert(`Failed to approve prospects: ${msg}`)
      setApprovalState('idle')
    }
  }

  const renderProspectRow = (prospect: ProspectWithTier) => {
    const isRemoved = prospect.id in removals
    const removal = removals[prospect.id]

    if (isRemoved && removal.collapsed) {
      return (
        <div key={prospect.id} className="border-b border-gray-200 hover:bg-gray-50">
          <div className="px-6 py-3 flex items-center justify-between">
            <div className="text-sm text-gray-500">
              Removed ({removal.reason})
            </div>
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

    if (isRemoved && !removal.collapsed) {
      return null
    }

    const firstName = prospect.first_name || ''
    const lastName = prospect.last_name || ''
    const fullName = `${firstName} ${lastName}`.trim() || 'Unknown'

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

          <div className="flex items-center gap-3 flex-shrink-0 relative">
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

            {activeReasonPicker === prospect.id ? (
              <RemovalReasonPicker
                reasons={REMOVAL_REASONS}
                onSelect={(reason) => handleRemove(prospect.id, reason)}
                onCancel={() => setActiveReasonPicker(null)}
              />
            ) : (
              <button
                onClick={() => setActiveReasonPicker(prospect.id)}
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

  return (
    <div className="space-y-6">
      {/* Batch Card Header */}
      <div className="bg-white rounded-lg border border-gray-200 p-8 shadow-sm">
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">
              {prospects.length} founder{prospects.length !== 1 ? 's' : ''} of consulting firms ready for your review
            </h2>
            <p className="text-sm text-gray-600 mt-2">
              Remove anyone you would rather we not contact. We proceed with the rest.
            </p>
          </div>

          {autoSanctionDate && (
            <div className="text-sm text-gray-600">
              Auto-approved on {formatDate(autoSanctionDate)} if no action taken.
            </div>
          )}
        </div>
      </div>

      {/* Prospects Table (single continuous list, no tier headers) */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div>{prospects.map(p => renderProspectRow(p))}</div>
      </div>

      {/* Approval Section */}
      {approvalState === 'done' ? (
        <div className="bg-green-50 rounded-lg border border-green-200 p-8 text-center">
          <p className="text-lg font-semibold text-green-900">Done. We will take it from here.</p>
          <p className="text-sm text-green-800 mt-2">Redirecting to dashboard...</p>
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
      )}
    </div>
  )
}
