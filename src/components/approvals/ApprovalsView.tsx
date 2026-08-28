'use client'

import { useState } from 'react'
import Link from 'next/link'
import ApprovalCard, { type PendingSuggestion } from './ApprovalCard'

// A pending suggestion plus the operator note that caused it to be regenerated.
//
// The note is carried HERE rather than on PendingSuggestion because it is not a column on
// the suggestion: it lives on the row this one replaced. See
// src/lib/approvals/driving-rejection-note.ts.
export type QueuedSuggestion = PendingSuggestion & {
  driving_rejection_note: string | null
  driving_rejection_at: string | null
}

type Props = {
  initialSuggestions: QueuedSuggestion[]
  filteredClientId?: string | null
}

export default function ApprovalsView({ initialSuggestions, filteredClientId }: Props) {
  const [suggestions, setSuggestions] = useState(initialSuggestions)

  function handleResolved(id: string) {
    setSuggestions(prev => prev.filter(s => s.id !== id))
  }

  const count = suggestions.length
  const filteredClient = suggestions.length > 0
    ? Array.isArray(suggestions[0]?.organisations)
      ? suggestions[0].organisations[0]?.name
      : (suggestions[0]?.organisations as any)?.name
    : null

  return (
    <div className="min-h-screen bg-surface-shell p-6">
      <div className="max-w-3xl mx-auto">
        {/* Page header */}
        <div className="mb-6">
          <p className="text-[10px] uppercase tracking-[0.09em] text-text-secondary mb-1">Operator</p>
          <h1 className="text-lg font-medium text-text-primary">Approvals</h1>
          <p className="text-xs text-text-secondary mt-1">
            {count > 0
              ? `${count} document suggestion${count === 1 ? '' : 's'} pending review`
              : 'No suggestions pending'}
          </p>
        </div>

        {/* Client filter indicator — shown when filtered */}
        {filteredClientId && filteredClient && (
          <div className="flex items-center justify-between gap-3 bg-[#E3F2FD] border border-[#90CAF9] rounded-[10px] px-4 py-3 mb-5">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
              <p className="text-xs text-[#1565C0]">
                Filtered to <span className="font-medium">{filteredClient}</span>
              </p>
            </div>
            <Link
              href="/dashboard/operator/approvals"
              className="text-xs font-medium text-[#1565C0] hover:underline"
            >
              Clear filter
            </Link>
          </div>
        )}

        {/* Amber summary banner — only when there are pending items */}
        {count > 0 && (
          <div className="flex items-center gap-3 bg-[#FEF7E6] border border-[#F0D080] rounded-[10px] px-4 py-3 mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-amber shrink-0" />
            <p className="text-xs text-[#7A4800]">
              {count} suggestion{count === 1 ? '' : 's'} waiting — review and approve to update the relevant strategy document.
            </p>
          </div>
        )}

        {/* Suggestions list */}
        {count > 0 ? (
          <div className="flex flex-col gap-4">
            {suggestions.map(s => (
              <div key={s.id} className="flex flex-col gap-2">
                {/* The note the operator wrote when rejecting the version this replaces.
                    Shown above the card so the instruction is read before the answer to it. */}
                {s.driving_rejection_note && (
                  <div className="bg-surface-content border border-border-card rounded-[10px] px-4 py-3">
                    <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1">
                      Regenerated after your rejection note
                      {s.driving_rejection_at && (
                        <span className="normal-case tracking-normal">
                          {' '}
                          &middot; {new Date(s.driving_rejection_at).toLocaleString('en-GB', {
                            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                          })}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-text-primary leading-relaxed">{s.driving_rejection_note}</p>
                  </div>
                )}
                <ApprovalCard suggestion={s} onResolved={handleResolved} />
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-surface-card border border-border-card rounded-[10px] px-6 py-8 text-center">
            <p className="text-[13px] font-medium text-text-primary mb-1">Documents are reviewed and up to date</p>
            <p className="text-xs text-text-secondary leading-relaxed max-w-sm mx-auto">
              New suggestions will appear here when agents identify improvements from campaign signals.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
