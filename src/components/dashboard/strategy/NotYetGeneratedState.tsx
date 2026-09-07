'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { DOCUMENT_META } from '@/lib/document-labels'
import type { DocumentType } from '@/types'

// ─── WHY THIS POLLS FOR AN OUTCOME AND NOT FOR A BOOLEAN, 2026-09-07 ─────────
//
// The poll used to ask "is a run in flight" and treat every false as success:
//
//   const isGenerating = await checkGenerationStatus()
//   if (!isGenerating) {
//     // Generation completed — clear polling and remain in generating state
//   }
//
// A failed run also stops being in flight. So when the 2026-09-05 tov run failed, this
// component cleared its interval, STAYED in 'generating', and went on showing
// "Generating your Tone of voice guide..." with a pulsing dot. Nothing re-renders the
// parent, which is a server component, so that was the final state until a manual reload.
//
// /api/generation-status now returns an outcome instead of a bit, and this reads it.

interface Props {
  docLabel: string
  docType: DocumentType
  clientId: string
  hasPendingSuggestion?: boolean
}

type State = 'idle' | 'pending' | 'generating' | 'failed' | 'stalled' | 'error'

type Outcome = 'generating' | 'succeeded' | 'failed' | 'stalled' | 'none'

interface StatusResponse {
  isGenerating?: boolean
  outcome?: Outcome
  latestRun?: { started_at: string } | null
}

// The agent's own guard is 240s and observed runs take 85 to 120s. Reaching this means
// nothing is coming, rather than that we gave up early.
const POLL_CEILING_MS = 6 * 60 * 1000

export function NotYetGeneratedState({ docLabel, docType, clientId, hasPendingSuggestion }: Props) {
  const router = useRouter()
  const [state, setState] = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)

  const desc = DOCUMENT_META[docType]?.desc ?? ''

  // Returns null when the status could not be read at all, which is NOT the same as
  // "nothing is running" and must not be treated as an outcome. The old version returned
  // false for a network error, so a blip read as completion.
  async function checkGenerationStatus(): Promise<StatusResponse | null> {
    try {
      const res = await fetch(`/api/generation-status?client_id=${encodeURIComponent(clientId)}&document_type=${encodeURIComponent(docType)}`)
      if (!res.ok) return null
      return (await res.json()) as StatusResponse
    } catch {
      return null
    }
  }

  // On mount or when props change, determine state: pending takes precedence, then check for generating
  useEffect(() => {
    const initState = async () => {
      // Pending suggestions take precedence over generation state
      if (hasPendingSuggestion) {
        setState('pending')
        // Stop polling if we were generating
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current)
          pollIntervalRef.current = null
        }
        return
      }

      // If no longer pending, reconnect to whatever the last run did. On a remount mid-run
      // this picks the generating state back up; on a remount after a failure it now shows
      // the failure instead of a spinner that never resolves.
      const status = await checkGenerationStatus()
      if (status?.outcome === 'generating') {
        setState('generating')
        startPolling(0)
      } else if (status?.outcome === 'failed') {
        setState('failed')
      } else if (status?.outcome === 'stalled') {
        setState('stalled')
      } else {
        setState('idle')
      }
    }
    initState()

    // Cleanup polling on unmount
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
      }
    }
  }, [clientId, docType, hasPendingSuggestion])

  function stopPolling() {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }

  // Poll every 5 seconds while generating.
  //
  // startedAfter ignores any run that predates this button press, because the status route
  // answers with the MOST RECENT run and that is usually a previous, completed one. Zero
  // means "accept whatever is there", used when reconnecting on mount to a run we did not
  // start ourselves.
  function startPolling(startedAfter: number) {
    stopPolling()
    const deadline = Date.now() + POLL_CEILING_MS

    pollIntervalRef.current = setInterval(async () => {
      if (Date.now() > deadline) {
        stopPolling()
        setState('stalled')
        return
      }

      const status = await checkGenerationStatus()
      // null means the status could not be read. Keep waiting: the deadline ends this,
      // not one failed request.
      if (!status) return

      const startedAt = status.latestRun?.started_at
      if (startedAfter > 0 && (!startedAt || new Date(startedAt).getTime() < startedAfter)) return

      if (status.outcome === 'succeeded') {
        stopPolling()
        // The parent is a server component and will not re-render on its own. Without this
        // the finished document does not appear until a manual reload, which is how a
        // successful run also looked like a hang.
        router.refresh()
        return
      }

      if (status.outcome === 'failed') {
        stopPolling()
        setState('failed')
        return
      }

      if (status.outcome === 'stalled') {
        stopPolling()
        setState('stalled')
      }
    }, 5000)
  }

  async function handleGenerate() {
    setErrorMsg(null)

    // Anchored before the request, so a previous completed run cannot be mistaken for
    // this one. Five seconds of slack for clock skew against the database.
    const startedAfter = Date.now() - 5000

    let res: Response
    try {
      res = await fetch('/api/suggestions/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, document_type: docType }),
      })
    } catch {
      setErrorMsg('Could not reach the server. Try again.')
      setState('error')
      return
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}) )) as { error?: string }
      setErrorMsg(body.error ?? 'Something went wrong. Try again.')
      setState('error')
      return
    }

    // Only set generating state AFTER successful response
    setState('generating')
    startPolling(startedAfter)
  }

  if (state === 'pending') {
    return (
      <div className="bg-surface-card border border-border-card rounded-[10px] p-8 text-center">
        <div className="w-10 h-10 rounded-full bg-[#F0ECE4] flex items-center justify-center mx-auto mb-4">
          <span className="w-1.5 h-1.5 rounded-full bg-[#C8A96E] animate-pulse" />
        </div>
        <p className="text-[12px] text-text-secondary">Your {docLabel} is being reviewed. It will appear here once approved.</p>
      </div>
    )
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

  // No agent error text here. The client cannot act on "Claude returned content that is
  // not valid JSON", and the route does not send it to them. What they need to know is
  // that it stopped, that nothing is broken at their end, and that somebody has been told.
  // The operator genuinely has been: the same failure writes an agent_runs row, sends the
  // operator alert, and any undelivered alert raises MON-030.
  if (state === 'failed' || state === 'stalled') {
    const headline = state === 'failed'
      ? `We could not finish your ${docLabel}.`
      : `Your ${docLabel} is taking longer than expected.`

    return (
      <div className="bg-surface-card border border-border-card rounded-[10px] p-8 text-center" data-testid="generation-failed">
        <div className="w-10 h-10 rounded-full bg-[#F7EDED] flex items-center justify-center mx-auto mb-4">
          <span className="w-3 h-3 rounded-full bg-[#C0392B]" />
        </div>
        <p className="text-[14px] font-medium text-text-primary mb-2">{headline}</p>
        <p className="text-[12px] text-text-secondary max-w-xs mx-auto leading-relaxed mb-4">
          Nothing you did caused this and nothing has been lost. We have been notified. You
          can try again, or leave it with us.
        </p>
        <button
          onClick={handleGenerate}
          className="text-[12px] text-white bg-[#1C3A2A] hover:bg-[#152e21] px-3 py-2 rounded-[6px] transition-colors"
          data-testid="retry-button"
        >
          Try again
        </button>
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
