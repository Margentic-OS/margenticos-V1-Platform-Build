'use client'

import { useState } from 'react'

interface ArchiveButtonProps {
  orgId: string
  orgName: string
  isArchived: boolean
  onSuccess?: () => void
}

type State = 'idle' | 'confirming' | 'loading' | 'error'

export function ArchiveButton({ orgId, orgName, isArchived, onSuccess }: ArchiveButtonProps) {
  const [state, setState] = useState<State>('idle')
  const [error, setError] = useState<string | null>(null)

  async function handleConfirm() {
    setState('loading')
    setError(null)

    const action = isArchived ? 'unarchive' : 'archive'
    const res = await fetch(`/api/operator/organisations/${orgId}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      const errorMsg = body.error ?? `Failed to ${action} organisation`
      setError(errorMsg)
      setState('error')
      return
    }

    setState('idle')
    onSuccess?.()
  }

  const actionLabel = isArchived ? 'Unarchive' : 'Archive'
  const confirmMsg = isArchived
    ? `Unarchive ${orgName}? It will reappear in the main client list.`
    : `Archive ${orgName}? It will be hidden from the default view.`

  if (state === 'confirming' || state === 'loading' || state === 'error') {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {(state === 'confirming' || state === 'error') && (
          <p className="text-[11px] text-text-secondary leading-snug text-right max-w-[240px]">
            {state === 'error' ? error : confirmMsg}
          </p>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setState('idle')
              setError(null)
            }}
            disabled={state === 'loading'}
            className="text-[11px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={state === 'loading'}
            className={`text-[11px] text-white px-3 py-1 rounded-[6px] disabled:opacity-50 transition-colors ${
              isArchived
                ? 'bg-[#1C3A2A] hover:bg-[#152e21]'
                : 'bg-[#7a4800] hover:bg-[#6a3f00]'
            }`}
          >
            {state === 'loading' ? 'Processing…' : 'Confirm'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <button
      onClick={() => setState('confirming')}
      className={`text-[11px] ${
        isArchived
          ? 'text-brand-green-success hover:text-[#2E7D32]'
          : 'text-text-secondary hover:text-text-primary'
      } transition-colors`}
    >
      {actionLabel}
    </button>
  )
}
