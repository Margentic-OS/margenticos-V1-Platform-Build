'use client'

import { useState } from 'react'
import { DOCUMENT_META } from '@/lib/document-labels'
import type { DocumentType } from '@/types'

interface Props {
  docLabel: string
  docType: DocumentType
  clientId: string
}

export function NotYetGeneratedState({ docLabel, docType, clientId }: Props) {
  const [state, setState] = useState<'idle' | 'generating' | 'done' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const desc = DOCUMENT_META[docType]?.desc ?? ''

  async function handleGenerate() {
    setState('generating')
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
      <div className="bg-surface-card border border-border-card rounded-[10px] p-8 text-center">
        <div className="w-10 h-10 rounded-full bg-[#F0ECE4] flex items-center justify-center mx-auto mb-4">
          <span className="w-1.5 h-1.5 rounded-full bg-[#C8A96E] animate-pulse" />
        </div>
        <p className="text-[12px] text-text-secondary">Generating your {docLabel}…</p>
      </div>
    )
  }

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-8 text-center">
      <div className="w-10 h-10 rounded-full bg-[#F0ECE4] flex items-center justify-center mx-auto mb-4">
        <span className="w-3 h-3 rounded-full bg-text-muted" />
      </div>
      <p className="text-[14px] font-medium text-text-primary mb-2">{docLabel} not yet ready</p>
      <p className="text-[12px] text-text-secondary max-w-xs mx-auto leading-relaxed mb-4">
        {desc ? `${desc}. ` : ''}Generate your first {docLabel} or request an update once your strategy is approved.
      </p>
      <div className="flex items-center justify-center gap-2">
        <button
          onClick={handleGenerate}
          disabled={state === 'generating'}
          className="text-[12px] text-white bg-[#1C3A2A] hover:bg-[#152e21] px-3 py-2 rounded-[6px] disabled:opacity-50 transition-colors"
          data-testid="generate-button"
        >
          {state === 'generating' ? 'Generating…' : `Generate ${docLabel}`}
        </button>
        {state === 'error' && (
          <p className="text-[11px] text-[#C0392B]">{errorMsg}</p>
        )}
      </div>
    </div>
  )
}
