'use client'

import { useState } from 'react'
import { logger } from '@/lib/logger'

interface TierData {
  tier: 'tier_1' | 'tier_2' | 'tier_3'
  tier_created_at: string | null
  total_count: number
  rejected_count: number
  sample_prospects: Array<{
    id: string
    first_name: string | null
    last_name: string | null
    company_name: string | null
    // job_title is the populated column (written by sourcing). role is only written by
    // the research agent and is NULL for sourced prospects — kept as a fallback.
    job_title: string | null
    role: string | null
    personalisation_trigger: string | null
    client_review_status: string | null
  }>
  tier_sanction_status: 'pending_review' | 'sanctioned_by_client' | 'sanctioned_auto' | 'partially_rejected'
  is_auto_sanctioned: boolean
  is_auto_sanctioned_now: boolean
  auto_sanction_at: string
  tier_is_locked: boolean
}

interface TierCardProps {
  tier: TierData
  tierLabel: string
  organisationId: string
}

export function TierCard({ tier, tierLabel, organisationId }: TierCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [rejectingProspectId, setRejectingProspectId] = useState<string | null>(null)
  const [expandedRejectId, setExpandedRejectId] = useState<string | null>(null)
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({})

  const getStatusBadgeColor = () => {
    switch (tier.tier_sanction_status) {
      case 'pending_review':
        return 'bg-blue-100 text-blue-800 border border-blue-300'
      case 'sanctioned_by_client':
      case 'sanctioned_auto':
        return 'bg-green-100 text-green-800 border border-green-300'
      case 'partially_rejected':
        return 'bg-orange-100 text-orange-800 border border-orange-300'
      default:
        return 'bg-gray-100 text-gray-800 border border-gray-300'
    }
  }

  const getStatusLabel = () => {
    if (tier.tier_is_locked) {
      return 'Locked (Sending)'
    }
    switch (tier.tier_sanction_status) {
      case 'pending_review':
        return 'Pending Review'
      case 'sanctioned_by_client':
        return 'Sanctioned'
      case 'sanctioned_auto':
        return 'Auto-Approved'
      case 'partially_rejected':
        return 'Partially Reviewed'
      default:
        return 'Unknown'
    }
  }

  const getStatusMessage = () => {
    if (tier.tier_is_locked) {
      return 'This tier is sending now. You can\'t modify it. Contact support if you need to make changes.'
    }

    if (tier.tier_sanction_status === 'sanctioned_auto') {
      return `We automatically approved this tier on ${new Date(tier.auto_sanction_at).toLocaleDateString()} to stay on schedule. You can still remove prospects you don't want — just click 'Review & Remove' below.`
    }

    if (tier.tier_sanction_status === 'partially_rejected') {
      return `You've removed ${tier.rejected_count} prospect${tier.rejected_count !== 1 ? 's' : ''}. The rest are approved.`
    }

    if (tier.auto_sanction_at) {
      const daysUntilAuto = Math.max(
        0,
        Math.ceil(
          (new Date(tier.auto_sanction_at).getTime() - new Date().getTime()) /
            (24 * 60 * 60 * 1000)
        )
      )
      if (daysUntilAuto > 0) {
        return `Awaiting your approval. Auto-approves in ${daysUntilAuto} day${daysUntilAuto !== 1 ? 's' : ''}.`
      }
    }

    return 'Awaiting your approval.'
  }

  const handleSanction = async () => {
    if (tier.tier_is_locked || isProcessing) return

    setIsProcessing(true)
    try {
      const response = await fetch(
        `/api/dashboard/client/prospect-tiers/${tier.tier}/sanction`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }
      )

      if (!response.ok) {
        const json = await response.json()
        throw new Error(json.error ?? `HTTP ${response.status}`)
      }

      // Refresh page to show updated state
      window.location.reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('TierCard: sanction failed', {
        tier: tier.tier,
        error: msg,
      })
      alert(`Failed to sanction tier: ${msg}`)
    } finally {
      setIsProcessing(false)
    }
  }

  const handleReject = async (prospectId: string) => {
    if (tier.tier_is_locked || rejectingProspectId) return

    const reason = rejectReasons[prospectId] || ''

    setRejectingProspectId(prospectId)
    try {
      const response = await fetch(
        `/api/dashboard/client/prospects/${prospectId}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason || null }),
        }
      )

      if (!response.ok) {
        const json = await response.json()
        if (response.status === 409) {
          alert('This prospect is already sending; cannot reject.')
        } else {
          throw new Error(json.error ?? `HTTP ${response.status}`)
        }
        return
      }

      // Refresh page to show updated state
      window.location.reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('TierCard: reject failed', {
        tier: tier.tier,
        prospect_id: prospectId,
        error: msg,
      })
      alert(`Failed to reject prospect: ${msg}`)
    } finally {
      setRejectingProspectId(null)
    }
  }

  const prospectName = (p: TierData['sample_prospects'][0]) => {
    const first = p.first_name || ''
    const last = p.last_name || ''
    return `${first} ${last}`.trim() || '(Unknown)'
  }

  const canActionOnTier = !tier.tier_is_locked && tier.tier_sanction_status === 'pending_review'
  const canActionOnProspects = !tier.tier_is_locked

  return (
    <div className="border border-gray-200 rounded-lg bg-white shadow-sm">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-gray-900">{tierLabel}</h3>
            <p className="text-sm text-gray-600 mt-1">
              {tier.total_count} prospect{tier.total_count !== 1 ? 's' : ''}
              {tier.rejected_count > 0 && ` (${tier.rejected_count} removed)`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`inline-block px-3 py-1 rounded text-sm font-medium ${getStatusBadgeColor()}`}>
              {getStatusLabel()}
            </span>
            {tier.tier_is_locked && (
              <span className="text-gray-400">🔒</span>
            )}
          </div>
        </div>

        {/* Status message */}
        <p className="text-sm text-gray-600 mt-3">{getStatusMessage()}</p>
      </div>

      {/* Sample Table */}
      {tier.sample_prospects.length > 0 && (
        <div className="px-6 py-4 border-b border-gray-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left font-medium text-gray-700 pb-2">Name</th>
                <th className="text-left font-medium text-gray-700 pb-2">Company</th>
                <th className="text-left font-medium text-gray-700 pb-2">Role</th>
                <th className="text-left font-medium text-gray-700 pb-2">Trigger</th>
              </tr>
            </thead>
            <tbody>
              {tier.sample_prospects.map((prospect) => (
                <tr key={prospect.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-3 pr-4">{prospectName(prospect)}</td>
                  <td className="py-3 pr-4 text-gray-600">{prospect.company_name || '—'}</td>
                  <td className="py-3 pr-4 text-gray-600">{prospect.job_title || prospect.role || '—'}</td>
                  <td className="py-3 pr-4 text-gray-600 truncate" title={prospect.personalisation_trigger || undefined}>
                    {prospect.personalisation_trigger ? prospect.personalisation_trigger.slice(0, 40) + (prospect.personalisation_trigger.length > 40 ? '…' : '') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Expandable Review Section */}
      {canActionOnProspects && (
        <div className="px-6 py-4">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="inline-flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-700"
          >
            {isExpanded ? '▼' : '▶'} Review & Remove Prospects
          </button>

          {isExpanded && (
            <div className="mt-4 space-y-4 border-t border-gray-200 pt-4">
              {tier.sample_prospects.map((prospect) => (
                <div key={prospect.id} className="border border-gray-200 rounded p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <p className="font-medium text-gray-900">{prospectName(prospect)}</p>
                      <p className="text-sm text-gray-600">{prospect.company_name} • {prospect.job_title || prospect.role}</p>
                      {prospect.personalisation_trigger && (
                        <p className="text-sm text-gray-600 mt-2">{prospect.personalisation_trigger}</p>
                      )}
                    </div>
                  </div>

                  {/* Reject form */}
                  {expandedRejectId === prospect.id ? (
                    <div className="mt-4 pt-4 border-t border-gray-200 space-y-3">
                      <textarea
                        value={rejectReasons[prospect.id] || ''}
                        onChange={(e) =>
                          setRejectReasons({
                            ...rejectReasons,
                            [prospect.id]: e.target.value.slice(0, 200),
                          })
                        }
                        placeholder="Why are you rejecting this prospect? (optional, max 200 chars)"
                        className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                        rows={2}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleReject(prospect.id)}
                          disabled={rejectingProspectId === prospect.id}
                          className="px-3 py-2 bg-red-50 text-red-600 border border-red-200 rounded text-sm font-medium hover:bg-red-100 disabled:opacity-50"
                        >
                          {rejectingProspectId === prospect.id ? 'Rejecting…' : 'Confirm Reject'}
                        </button>
                        <button
                          onClick={() => setExpandedRejectId(null)}
                          disabled={rejectingProspectId === prospect.id}
                          className="px-3 py-2 text-gray-600 hover:bg-gray-100 rounded text-sm disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                      <p className="text-xs text-gray-500">
                        {(rejectReasons[prospect.id] || '').length}/200 characters
                      </p>
                    </div>
                  ) : (
                    <div className="mt-3 pt-3 border-t border-gray-200">
                      <button
                        onClick={() => setExpandedRejectId(prospect.id)}
                        disabled={tier.tier_is_locked}
                        className="text-sm font-medium text-red-600 hover:text-red-700 disabled:text-gray-400"
                      >
                        Remove This Prospect
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Action Buttons */}
      <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex gap-3">
        {canActionOnTier && (
          <button
            onClick={handleSanction}
            disabled={isProcessing}
            className="px-4 py-2 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {isProcessing ? 'Approving…' : 'Approve This Tier'}
          </button>
        )}
        {tier.tier_is_locked && (
          <p className="text-sm text-gray-600 self-center">
            This tier is locked because sending has started.
          </p>
        )}
      </div>
    </div>
  )
}
