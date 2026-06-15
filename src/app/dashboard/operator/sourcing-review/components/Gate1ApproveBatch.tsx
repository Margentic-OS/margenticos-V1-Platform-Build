'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import type { Database } from '@/types/database'

type Prospect = Database['public']['Tables']['prospects']['Row']

interface Gate1ApproveBatchProps {
  prospects: Prospect[]
  organisationId: string
  organisationName: string
  icpSummary: {
    targetTitle?: string
    revenueRange?: string
  }
}

export function Gate1ApproveBatch({
  prospects,
  organisationId,
  organisationName,
  icpSummary,
}: Gate1ApproveBatchProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isApproving, setIsApproving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const approveAll = async () => {
    const idsToApprove = Array.from(selectedIds).length > 0
      ? Array.from(selectedIds)
      : prospects.map(p => p.id)

    setIsApproving(true)
    setError(null)

    try {
      const res = await fetch(`/api/operator/organisations/${organisationId}/approve-prospects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospect_ids: idsToApprove }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Approval failed')
      }

      const { result } = await res.json()
      window.location.href = `/dashboard/operator/sourcing-review?client=${organisationId}&approved=${result.approved_count}`
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setIsApproving(false)
    }
  }

  const toggleAll = () => {
    if (selectedIds.size === prospects.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(prospects.map(p => p.id)))
    }
  }

  const toggleId = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setSelectedIds(next)
  }

  const emailVerifiedCount = useMemo(
    () => prospects.filter(p => p.email_status === 'verified').length,
    [prospects]
  )

  return (
    <div className="space-y-6">
      {/* Batch summary */}
      <div className="bg-white rounded-[10px] border border-border-card p-6">
        <h2 className="text-base font-medium text-text-primary mb-4">
          {prospects.length} prospects pending approval
        </h2>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
          <div>
            <p className="text-xs uppercase font-normal tracking-[0.07em] text-text-secondary mb-1">
              Total pending
            </p>
            <p className="text-2xl font-medium text-text-primary">{prospects.length}</p>
          </div>

          {emailVerifiedCount > 0 && (
            <div>
              <p className="text-xs uppercase font-normal tracking-[0.07em] text-text-secondary mb-1">
                Email verified
              </p>
              <p className="text-2xl font-medium text-text-primary">{emailVerifiedCount}</p>
            </div>
          )}

          {icpSummary.targetTitle && (
            <div>
              <p className="text-xs uppercase font-normal tracking-[0.07em] text-text-secondary mb-1">
                Target role
              </p>
              <p className="text-sm font-medium text-text-primary truncate">{icpSummary.targetTitle}</p>
            </div>
          )}

          {icpSummary.revenueRange && (
            <div>
              <p className="text-xs uppercase font-normal tracking-[0.07em] text-text-secondary mb-1">
                Revenue range
              </p>
              <p className="text-sm font-medium text-text-primary">{icpSummary.revenueRange}</p>
            </div>
          )}
        </div>

        <p className="text-xs text-text-secondary">
          From Apollo search with ICP filter applied. Ready to proceed to enrichment.
        </p>
      </div>

      {/* Prospects table */}
      <div className="bg-white rounded-[10px] border border-border-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#F0ECE4]">
              <tr>
                <th className="px-4 py-3 text-left">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === prospects.length && prospects.length > 0}
                    onChange={toggleAll}
                    className="w-4 h-4"
                  />
                </th>
                <th className="px-4 py-3 text-left font-medium text-text-primary">Name</th>
                <th className="px-4 py-3 text-left font-medium text-text-primary">Email</th>
                <th className="px-4 py-3 text-left font-medium text-text-primary">Company</th>
                <th className="px-4 py-3 text-left font-medium text-text-primary">Role</th>
                <th className="px-4 py-3 text-left font-medium text-text-primary">Email status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E8E2D8]">
              {prospects.slice(0, 50).map((prospect) => (
                <tr key={prospect.id} className="hover:bg-[#FAFAF8] transition-colors">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(prospect.id)}
                      onChange={() => toggleId(prospect.id)}
                      className="w-4 h-4"
                    />
                  </td>
                  <td className="px-4 py-3 text-text-primary">
                    {prospect.first_name} {prospect.last_name}
                  </td>
                  <td className="px-4 py-3 text-text-secondary font-mono text-xs">{prospect.email}</td>
                  <td className="px-4 py-3 text-text-primary">{prospect.company_name}</td>
                  <td className="px-4 py-3 text-text-secondary">{prospect.role || '—'}</td>
                  <td className="px-4 py-3">
                    {prospect.email_status === 'verified' ? (
                      <span className="inline-block px-2 py-0.5 rounded-sm text-xs font-medium bg-[#EBF5E6] text-[#3B6D11] border border-[#BDDAB0]">
                        Verified
                      </span>
                    ) : (
                      <span className="text-text-secondary text-xs">{prospect.email_status || 'unknown'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {prospects.length > 50 && (
          <div className="px-4 py-3 bg-[#F0ECE4] text-center text-xs text-text-secondary">
            Showing 50 of {prospects.length} prospects. Scroll to see more.
          </div>
        )}
      </div>

      {/* Warning */}
      <div className="bg-[#FEF7E6] rounded-[10px] border border-[#F0D080] p-4">
        <p className="text-sm font-medium text-[#7A4800] mb-1">
          Enrichment will consume Apollo credits
        </p>
        <p className="text-xs text-[#7A4800] mb-3">
          Currently in test mode — no live API calls will be made. Activation of live enrichment requires a separate step.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-[#FDEEE8] rounded-[10px] border border-[#EFBCAA] p-4">
          <p className="text-sm font-medium text-[#8B2020]">Approval failed</p>
          <p className="text-xs text-[#8B2020]">{error}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={approveAll}
          disabled={isApproving || prospects.length === 0}
          className="px-4 py-2 rounded-[6px] bg-[#1C3A2A] text-white font-medium text-sm hover:bg-[#152e21] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isApproving ? 'Approving...' : 'Approve all'}
        </button>

        <Link
          href={`/dashboard/operator/sourcing-review?client=${organisationId}`}
          className="px-4 py-2 rounded-[6px] bg-[#F0ECE4] text-text-primary font-medium text-sm hover:bg-[#E8E2D8] transition-colors"
        >
          Cancel
        </Link>
      </div>
    </div>
  )
}
