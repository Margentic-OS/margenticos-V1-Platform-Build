'use client'

import Link from 'next/link'

interface ProspectApprovalStatusProps {
  pendingCount: number
  approvedCount: number
  showReviewLink?: boolean
  clientParam?: string | null
}

export function ProspectApprovalStatus({
  pendingCount,
  approvedCount,
  showReviewLink = true,
  clientParam,
}: ProspectApprovalStatusProps) {
  console.log('[ProspectApprovalStatus] Render debug:', { pendingCount, approvedCount, showReviewLink })
  const hasApproved = approvedCount > 0 || pendingCount === 0

  if (pendingCount > 0) {
    // Pending review state
    console.log('[ProspectApprovalStatus] Rendering PENDING state')
    return (
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 mb-6">
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">
              Your first prospect list is ready
            </h3>
            <p className="text-sm text-gray-600">
              {pendingCount} contact{pendingCount !== 1 ? 's' : ''} waiting for your review
            </p>
          </div>
          {showReviewLink && (
            <Link
              href={clientParam ? `/dashboard/prospect-tiers?client=${clientParam}` : '/dashboard/prospect-tiers'}
              className="ml-6 px-4 py-2 rounded font-semibold text-white bg-blue-600 hover:bg-blue-700 transition-colors whitespace-nowrap text-sm"
            >
              Review now
            </Link>
          )}
        </div>
      </div>
    )
  }

  if (hasApproved && approvedCount > 0) {
    // Approved state
    console.log('[ProspectApprovalStatus] Rendering APPROVED state with', approvedCount, 'contacts')
    return (
      <div className="bg-green-50 rounded-lg border border-green-200 shadow-sm p-6 mb-6">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-green-200 flex items-center justify-center shrink-0">
            <svg className="w-6 h-6 text-green-700" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-green-900 mb-1">
              Your prospects are approved
            </h3>
            <p className="text-sm text-green-800">
              {approvedCount} contact{approvedCount !== 1 ? 's' : ''} approved. Outreach is being prepared.
            </p>
          </div>
        </div>
      </div>
    )
  }

  console.log('[ProspectApprovalStatus] Returning null - no conditions matched. hasApproved:', hasApproved)
  return null
}
