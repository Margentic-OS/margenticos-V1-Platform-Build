'use client'

import { useState } from 'react'

export type PendingSuggestion = {
  id: string
  document_type: string
  field_path: string
  current_value: string | null
  suggested_value: string
  suggestion_reason: string | null
  organisations: { name: string } | { name: string }[] | null
}

const DOC_TYPE_LABELS: Record<string, string> = {
  icp: 'ICP',
  positioning: 'Positioning',
  tov: 'Tone of Voice',
  messaging: 'Messaging',
}

function formatFieldPath(path: string): string {
  const segment = path.split('.').pop() ?? path
  const spaced = segment.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function getClientName(org: PendingSuggestion['organisations']): string {
  if (!org) return 'Unknown client'
  if (Array.isArray(org)) return org[0]?.name ?? 'Unknown client'
  return org.name
}

type Props = {
  suggestion: PendingSuggestion
  onResolved: (id: string) => void
}

export default function ApprovalCard({ suggestion, onResolved }: Props) {
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleAction(action: 'approve' | 'reject') {
    setLoading(action)
    setError(null)

    const res = await fetch(`/api/suggestions/${suggestion.id}/${action}`, { method: 'POST' })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError((body as { error?: string }).error ?? 'Something went wrong. Try again.')
      setLoading(null)
      return
    }

    onResolved(suggestion.id)
  }

  const docLabel = DOC_TYPE_LABELS[suggestion.document_type] ?? suggestion.document_type
  const fieldLabel = formatFieldPath(suggestion.field_path)
  const clientName = getClientName(suggestion.organisations)
  const isLoading = loading !== null

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center px-2 py-0.5 rounded-[4px] bg-[#EAF3DE] text-[#3B6D11] text-[10px] font-medium">
            {docLabel}
          </span>
          <span className="text-[13px] font-medium text-text-primary">{fieldLabel}</span>
        </div>
        <span className="text-[10px] uppercase tracking-[0.07em] text-text-secondary shrink-0">
          {clientName}
        </span>
      </div>

      {/* Before / After */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1.5">Current</p>
          {suggestion.current_value ? (
            <p className="text-xs text-text-secondary leading-relaxed">{suggestion.current_value}</p>
          ) : (
            <p className="text-xs text-text-muted italic">Not yet set</p>
          )}
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1.5">Suggested</p>
          <p className="text-xs text-text-primary leading-relaxed">{suggestion.suggested_value}</p>
        </div>
      </div>

      {/* Agent reasoning */}
      {suggestion.suggestion_reason && (
        <div className="bg-surface-content rounded-[6px] px-3 py-2.5 mb-4">
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1">Agent reasoning</p>
          <p className="text-xs text-text-primary leading-relaxed">{suggestion.suggestion_reason}</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-xs text-[#8B2020] mb-3">{error}</p>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={() => handleAction('reject')}
          disabled={isLoading}
          className="px-3 py-1.5 rounded-[6px] text-xs text-text-secondary border border-border-card hover:bg-surface-content disabled:opacity-40 transition-colors"
        >
          {loading === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
        <button
          onClick={() => handleAction('approve')}
          disabled={isLoading}
          className="px-3 py-1.5 rounded-[6px] text-xs text-white bg-brand-green hover:bg-[#152e21] disabled:opacity-40 transition-colors"
        >
          {loading === 'approve' ? 'Approving…' : 'Approve'}
        </button>
      </div>
    </div>
  )
}
