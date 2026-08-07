'use client'

import { useState, useEffect, useRef } from 'react'
import { DOCUMENT_META } from '@/lib/document-labels'
import type { DocumentType } from '@/types'

interface Props {
  docLabel: string
  docType: DocumentType
  clientId: string
}

type State = 'idle' | 'generating' | 'error'

export function NotYetGeneratedState({ docLabel, docType, clientId }: Props) {
  const [state, setState] = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)

  const desc = DOCUMENT_META[docType]?.desc ?? ''

  // Check if there's an active generation run for this org+doctype
  async function checkGenerationStatus(): Promise<boolean> {
    try {
      const res = await fetch(`/api/generation-status?client_id=${encodeURIComponent(clientId)}&document_type=${encodeURIComponent(docType)}`)
      if (!res.ok) return false

      const data = (await res.json()) as { isGenerating?: boolean }
      return data.isGenerating === true
    } catch {
      return false
    }
  }

  // On mount, check if a generation is already in progress (reconnect to real state)
  useEffect(() => {
    const initState = async () => {
      const isGenerating = await checkGenerationStatus()
      if (isGenerating) {
        setState('generating')
        startPolling()
      }
    }
    initState()

    // Cleanup polling on unmount
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
      }
    }
  }, [clientId, docType])

  // Poll every 5 seconds while generating
  function startPolling() {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
    }

    pollIntervalRef.current = setInterval(async () => {
      const isGenerating = await checkGenerationStatus()
      if (!isGenerating) {
        // Generation completed — clear polling and remain in generating state
        // so the parent can detect the completion and re-render with the new document
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current)
          pollIntervalRef.current = null
        }
      }
    }, 5000)
  }

  async function handleGenerate() {
    setErrorMsg(null)

    const res = await fetch('/api/suggestions/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, document_type: docType }),
    })

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}) )) as { error?: string }
      setErrorMsg(body.error ?? 'Something went wrong. Try again.')
      setState('error')
      return
    }

    // Only set generating state AFTER successful response
    setState('generating')
    startPolling()
  }

  if (state === 'generating') {
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
          className="text-[12px] text-white bg-[#1C3A2A] hover:bg-[#152e21] px-3 py-2 rounded-[6px] transition-colors"
          data-testid="generate-button"
        >
          Generate {docLabel}
        </button>
        {state === 'error' && (
          <p className="text-[11px] text-[#C0392B]">{errorMsg}</p>
        )}
      </div>
    </div>
  )
}
