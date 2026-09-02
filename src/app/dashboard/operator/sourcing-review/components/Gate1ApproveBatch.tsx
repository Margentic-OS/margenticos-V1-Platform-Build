'use client'

// The approval screen.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT WAS WRONG, AND WHY IT WAS WORSE THAN IT LOOKED
//
// The server sent every pending prospect, the table rendered `prospects.slice(0, 50)`, and
// a footer read "Showing 50 of 100 prospects. Scroll to see more" with nowhere to scroll.
// The other 50 were fetched, shipped to the browser and thrown away by the slice.
//
// That was the visible half. The invisible half was the header checkbox and the Approve
// button, which BOTH acted on the full array rather than on the 50 rows on screen. So
// "select all" selected 50 rows the operator could not see, and "Approve all" approved
// them. Measured rather than read: the test in __tests__/Gate1ApproveBatch.test.tsx renders
// 100 prospects, counts the <tr> elements actually in the table, and counts the ids in the
// request body. Those two numbers were 50 and 100.
//
// It is now a real page boundary, and the two actions are separated and named for their
// scope: one says "this page", the other says how many it will approve in total and asks
// before doing it.

import { useState, useMemo } from 'react'
import Link from 'next/link'
import type { Database } from '@/types/database'

type Prospect = Database['public']['Tables']['prospects']['Row']

interface Gate1ApproveBatchProps {
  /** ONE PAGE of pending prospects. Not the batch. */
  prospects: Prospect[]
  /** Every pending prospect for this client, from a count rather than from an array length. */
  totalPending: number
  page: number
  pageSize: number
  organisationId: string
  organisationName: string
  icpSummary: {
    targetTitle?: string
    revenueRange?: string
  }
}

export function Gate1ApproveBatch({
  prospects,
  totalPending,
  page,
  pageSize,
  organisationId,
  organisationName,
  icpSummary,
}: Gate1ApproveBatchProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isApproving, setIsApproving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingAll, setConfirmingAll] = useState(false)

  const totalPages = Math.max(1, Math.ceil(totalPending / pageSize))
  const firstOnPage = totalPending === 0 ? 0 : (page - 1) * pageSize + 1
  const lastOnPage = (page - 1) * pageSize + prospects.length

  /**
   * Approve an explicit list of ids.
   *
   * NO IMPLICIT FALLBACK. This used to read "the selection, or everything if the selection
   * is empty", so a button labelled "Approve all" did two different things depending on
   * state the operator may not have been looking at. Each caller now says what it means.
   */
  const approve = async (idsToApprove: string[]) => {
    if (idsToApprove.length === 0) return

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

  /**
   * Approve every pending prospect, including those on other pages.
   *
   * Sends no ids. The route re-selects by organisation and status, so the action is defined
   * by a predicate rather than by whatever happened to be loaded in one browser tab. That is
   * also why it goes through a confirmation: it acts on rows the operator cannot see.
   */
  const approveEveryPending = async () => {
    setIsApproving(true)
    setError(null)
    try {
      const res = await fetch(`/api/operator/organisations/${organisationId}/approve-prospects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve_all_pending: true }),
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

  /** Selects THIS PAGE. It used to select every prospect the server had sent, seen or not. */
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

  if (totalPending === 0) {
    return (
      <div className="bg-white rounded-[10px] border border-border-card p-6 text-center">
        <p className="text-text-secondary text-sm mb-4">No prospects awaiting approval. Check back once the sourcing run is complete.</p>
        <Link
          href={`/dashboard/operator/sourcing-review?client=${organisationId}`}
          className="inline-block px-4 py-2 rounded-[6px] bg-[#F0ECE4] text-text-primary font-medium text-sm hover:bg-[#E8E2D8] transition-colors"
        >
          Back to pipeline
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Batch summary */}
      <div className="bg-white rounded-[10px] border border-border-card p-6">
        <h2 className="text-base font-medium text-text-primary mb-4">
          {totalPending} prospect{totalPending === 1 ? '' : 's'} pending approval
        </h2>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
          <div>
            <p className="text-xs uppercase font-normal tracking-[0.07em] text-text-secondary mb-1">
              Total pending
            </p>
            <p className="text-2xl font-medium text-text-primary">{totalPending}</p>
          </div>

          {emailVerifiedCount > 0 && (
            <div>
              <p className="text-xs uppercase font-normal tracking-[0.07em] text-text-secondary mb-1">
                Email verified, this page
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
          From the prospect search, with the client's filter specification applied. Ready to
          proceed to enrichment.
        </p>
      </div>

      {/* Prospects table */}
      <div className="bg-white rounded-[10px] border border-border-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#F0ECE4]">
              <tr>
                <th className="px-4 py-3 text-left">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedIds.size === prospects.length && prospects.length > 0}
                      onChange={toggleAll}
                      className="w-4 h-4"
                      aria-label={`Select all ${prospects.length} on this page`}
                    />
                    <span className="text-xs font-normal text-text-secondary whitespace-nowrap">
                      This page
                    </span>
                  </label>
                </th>
                <th className="px-4 py-3 text-left font-medium text-text-primary">Name</th>
                <th className="px-4 py-3 text-left font-medium text-text-primary">Email</th>
                <th className="px-4 py-3 text-left font-medium text-text-primary">Company</th>
                <th className="px-4 py-3 text-left font-medium text-text-primary">Role</th>
                <th className="px-4 py-3 text-left font-medium text-text-primary">LinkedIn</th>
                <th className="px-4 py-3 text-left font-medium text-text-primary">Email status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E8E2D8]">
              {/* NO SLICE. The server sends exactly one page; rendering a subset of what
                  was fetched is what made the count on screen a different number from the
                  count the button acted on. */}
              {prospects.map((prospect) => (
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
                  <td className="px-4 py-3 text-text-secondary text-sm">{prospect.job_title || '—'}</td>
                  <td className="px-4 py-3">
                    {prospect.linkedin_url ? (
                      <a href={prospect.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline text-xs">
                        Profile
                      </a>
                    ) : (
                      <span className="text-text-secondary text-xs">—</span>
                    )}
                  </td>
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

        {/* A real page boundary with real controls. This said "Scroll to see more" and
            there was nothing to scroll to: the rows did not exist in the document. */}
        {totalPending > 0 && (
          <div className="px-4 py-3 bg-[#F0ECE4] flex items-center justify-between text-xs text-text-secondary">
            <span>
              Showing {firstOnPage} to {lastOnPage} of {totalPending}
              {totalPages > 1 ? `, page ${page} of ${totalPages}` : ''}
            </span>
            {totalPages > 1 && (
              <span className="flex gap-2">
                {page > 1 && (
                  <Link
                    href={`/dashboard/operator/sourcing-review/approve?client=${organisationId}&page=${page - 1}`}
                    className="px-2 py-1 rounded-[4px] bg-white border border-border-card hover:bg-[#FAFAF8] transition-colors"
                  >
                    Previous
                  </Link>
                )}
                {page < totalPages && (
                  <Link
                    href={`/dashboard/operator/sourcing-review/approve?client=${organisationId}&page=${page + 1}`}
                    className="px-2 py-1 rounded-[4px] bg-white border border-border-card hover:bg-[#FAFAF8] transition-colors"
                  >
                    Next
                  </Link>
                )}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Warning */}
      <div className="bg-[#FEF7E6] rounded-[10px] border border-[#F0D080] p-4">
        <p className="text-sm font-medium text-[#7A4800] mb-1">
          Enrichment spends enrichment credits
        </p>
        <p className="text-xs text-[#7A4800] mb-3">
          Currently in test mode. No live API calls will be made. Activation of live enrichment requires a separate step.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-[#FDEEE8] rounded-[10px] border border-[#EFBCAA] p-4">
          <p className="text-sm font-medium text-[#8B2020]">Approval failed</p>
          <p className="text-xs text-[#8B2020]">{error}</p>
        </div>
      )}

      {/* ── ACTIONS, EACH NAMING ITS OWN SCOPE ──────────────────────────────────
          One button said "Approve all" and approved either the selection or everything,
          depending on state the operator was not necessarily looking at. There are now two,
          and each says how many rows it will touch. */}
      {confirmingAll ? (
        <div className="bg-[#FEF7E6] rounded-[10px] border border-[#F0D080] p-4 space-y-3">
          <p className="text-sm font-medium text-[#7A4800]">
            Approve all {totalPending} pending prospect{totalPending === 1 ? '' : 's'}?
          </p>
          <p className="text-xs text-[#7A4800]">
            This includes {Math.max(0, totalPending - prospects.length)} not shown on this
            page. Approving costs nothing on its own. The next step, enrich and tier, spends
            enrichment credits on every prospect approved here.
          </p>
          <div className="flex gap-3">
            <button
              onClick={approveEveryPending}
              disabled={isApproving}
              className="px-4 py-2 rounded-[6px] bg-[#1C3A2A] text-white font-medium text-sm hover:bg-[#152e21] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isApproving ? 'Approving...' : `Yes, approve ${totalPending}`}
            </button>
            <button
              onClick={() => setConfirmingAll(false)}
              disabled={isApproving}
              className="px-4 py-2 rounded-[6px] bg-[#F0ECE4] text-text-primary font-medium text-sm hover:bg-[#E8E2D8] transition-colors"
            >
              Go back
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => approve(Array.from(selectedIds))}
            disabled={isApproving || selectedIds.size === 0}
            className="px-4 py-2 rounded-[6px] bg-[#1C3A2A] text-white font-medium text-sm hover:bg-[#152e21] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isApproving
              ? 'Approving...'
              : `Approve ${selectedIds.size} selected`}
          </button>

          <button
            onClick={() => setConfirmingAll(true)}
            disabled={isApproving || totalPending === 0}
            className="px-4 py-2 rounded-[6px] bg-white text-[#1C3A2A] border border-[#BDDAB0] font-medium text-sm hover:bg-[#EBF5E6] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Approve all {totalPending} pending
          </button>

          <Link
            href={`/dashboard/operator/sourcing-review?client=${organisationId}`}
            className="px-4 py-2 rounded-[6px] bg-[#F0ECE4] text-text-primary font-medium text-sm hover:bg-[#E8E2D8] transition-colors"
          >
            Cancel
          </Link>
        </div>
      )}
    </div>
  )
}
