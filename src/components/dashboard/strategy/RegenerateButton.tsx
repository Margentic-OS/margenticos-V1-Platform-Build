'use client'

import { useState } from 'react'

interface Props {
  clientId: string
  docType: string
}

export function RegenerateButton({ clientId, docType }: Props) {
  const [state, setState] = useState<'idle' | 'confirming' | 'loading' | 'done' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  async function handleConfirm() {
    setState('loading')
    setErrorMsg(null)

    const res = await fetch('/api/suggestions/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, document_type: docType }),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      setErrorMsg(body.error ?? 'Something went wrong. Try again.')
      setState('error')
      return
    }

    setState('done')
  }

  if (state === 'done') {
    return (
      <p className="text-[11px] text-[#7A4800]">
        New suggestion generating — check back shortly.
      </p>
    )
  }

  if (state === 'confirming' || state === 'loading' || state === 'error') {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {(state === 'confirming' || state === 'error') && (
          <p className="text-[11px] text-text-secondary leading-snug text-right max-w-[240px]">
            {state === 'error' && errorMsg
              ? errorMsg
              : 'This will generate a new suggestion for your review. Your current document stays active until you approve the update.'}
          </p>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setState('idle'); setErrorMsg(null) }}
            disabled={state === 'loading'}
            className="text-[11px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={state === 'loading'}
            className="text-[11px] text-white bg-[#1C3A2A] hover:bg-[#152e21] px-3 py-1 rounded-[6px] disabled:opacity-50 transition-colors"
          >
            {state === 'loading' ? 'Queuing…' : 'Confirm'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <button
      onClick={() => setState('confirming')}
      className="text-[11px] text-text-secondary hover:text-text-primary transition-colors"
    >
      Regenerate
    </button>
  )
}
