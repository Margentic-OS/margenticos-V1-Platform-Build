'use client'

import { useState } from 'react'
import ApprovalCard, { type PendingSuggestion } from './ApprovalCard'

type Props = {
  initialSuggestions: PendingSuggestion[]
}

export default function ApprovalsView({ initialSuggestions }: Props) {
  const [suggestions, setSuggestions] = useState(initialSuggestions)

  function handleResolved(id: string) {
    setSuggestions(prev => prev.filter(s => s.id !== id))
  }

  const count = suggestions.length

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
              <ApprovalCard key={s.id} suggestion={s} onResolved={handleResolved} />
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
