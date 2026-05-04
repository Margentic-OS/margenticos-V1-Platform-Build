'use client'

// Triage queue — polls GET /api/reply-drafts every 30s and renders all cards.
// Polling is paused when the tab is not visible to avoid wasted DB calls.
// Per-row textarea state is tracked client-side so polling never wipes an edit.

import { useCallback, useEffect, useRef, useState } from 'react'
import { DraftCard, type CardInFlightState } from './DraftCard'
import { DraftCardSkeleton } from './DraftCardSkeleton'
import { EmptyState } from './EmptyState'
import type { TriageDraftItem } from './types'

const POLL_INTERVAL_MS = 30_000

// ── Per-card client state ──────────────────────────────────────────────────────

interface CardState {
  textareaValue: string
  touched: boolean            // true once operator has typed anything
  inFlight: CardInFlightState
  actionError: string | null
}

function initialCardState(draft: TriageDraftItem): CardState {
  return {
    textareaValue: draft.ai_draft_body ?? '',
    touched: false,
    inFlight: 'idle',
    actionError: null,
  }
}

// ── Component ──────────────────────────────────────────────────────────────────

export function TriageQueue() {
  const [drafts, setDrafts] = useState<TriageDraftItem[]>([])
  const [cardStates, setCardStates] = useState<Record<string, CardState>>({})
  const [initialLoading, setInitialLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Track which draft IDs we have already shown so we can init card state for new arrivals.
  const knownIds = useRef(new Set<string>())
  // Mirror of cardStates for use inside fetchDrafts without adding it as a dependency.
  const cardStatesRef = useRef<Record<string, CardState>>({})

  const fetchDrafts = useCallback(async () => {
    try {
      const res = await fetch('/api/reply-drafts', { credentials: 'same-origin' })
      if (!res.ok) {
        setFetchError(`Could not load queue (${res.status}).`)
        return
      }
      const json = await res.json() as { drafts: TriageDraftItem[] }
      const incoming = json.drafts ?? []

      // Snapshot before state updates so in-flight check uses a consistent view.
      const snapshot = cardStatesRef.current

      // Merge card states: preserve touched rows, refresh untouched, init new arrivals.
      setCardStates(prevStates => {
        const next: Record<string, CardState> = {}
        for (const draft of incoming) {
          if (prevStates[draft.id]?.touched) {
            // Operator has edited this row — preserve their textarea value.
            next[draft.id] = prevStates[draft.id]
          } else if (prevStates[draft.id]) {
            // Row exists but not touched — refresh textarea to match latest ai_draft_body.
            next[draft.id] = {
              ...prevStates[draft.id],
              textareaValue: draft.ai_draft_body ?? '',
            }
          } else {
            // New row — initialise from server data.
            next[draft.id] = initialCardState(draft)
            knownIds.current.add(draft.id)
          }
        }
        return next
      })

      // Skip rows the operator is actively acting on to avoid a race where the
      // action completed but this poll fired before the row left the server response.
      const inFlightIds = new Set(
        Object.entries(snapshot)
          .filter(([, s]) => s.inFlight !== 'idle')
          .map(([id]) => id)
      )
      setDrafts(incoming.filter(d => !inFlightIds.has(d.id)))

      setFetchError(null)
    } catch {
      setFetchError('Lost connection to the queue. Will retry shortly.')
    } finally {
      setInitialLoading(false)
    }
  }, [])

  // Keep ref in sync so fetchDrafts can read current card states without a dependency.
  useEffect(() => { cardStatesRef.current = cardStates }, [cardStates])

  // Mount + polling effect.
  useEffect(() => {
    fetchDrafts()

    const tick = () => {
      if (document.visibilityState === 'visible') fetchDrafts()
    }

    const interval = setInterval(tick, POLL_INTERVAL_MS)

    // Resume immediately on tab becoming visible.
    document.addEventListener('visibilitychange', tick)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [fetchDrafts])

  // ── Card state helpers ───────────────────────────────────────────────────────

  function updateCardState(draftId: string, patch: Partial<CardState>) {
    setCardStates(prev => ({
      ...prev,
      [draftId]: { ...prev[draftId], ...patch },
    }))
  }

  function handleTextareaChange(draftId: string, value: string) {
    updateCardState(draftId, { textareaValue: value, touched: true, actionError: null })
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function handleApprove(draftId: string, finalBody: string, edited: boolean) {
    updateCardState(draftId, { inFlight: 'approving', actionError: null })

    try {
      const res = await fetch(`/api/reply-drafts/${draftId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ final_body: finalBody, edited }),
      })

      const json = await res.json() as Record<string, unknown>

      if (!res.ok) {
        const msg = typeof json.error === 'string' ? json.error : `Approval failed (${res.status}).`
        updateCardState(draftId, { inFlight: 'idle', actionError: msg })
        return
      }

      // 200 with status='send_failed' means the send itself failed after approval.
      if (json.status === 'send_failed') {
        const reason = typeof json.error === 'string' ? json.error : 'Instantly returned an error.'
        updateCardState(draftId, {
          inFlight: 'idle',
          actionError: `Send failed: ${reason}`,
        })
        // Refetch so the row updates to send_failed status in the list.
        await fetchDrafts()
        return
      }

      // Success (sent or idempotent_skip) — remove the row from the queue.
      setDrafts(prev => prev.filter(d => d.id !== draftId))
      setCardStates(prev => {
        const next = { ...prev }
        delete next[draftId]
        return next
      })
    } catch {
      updateCardState(draftId, { inFlight: 'idle', actionError: 'Connection error — please try again.' })
    }
  }

  async function handleReject(draftId: string) {
    updateCardState(draftId, { inFlight: 'rejecting', actionError: null })

    try {
      const res = await fetch(`/api/reply-drafts/${draftId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({}),
      })

      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as Record<string, unknown>
        const msg = typeof json.error === 'string' ? json.error : `Rejection failed (${res.status}).`
        updateCardState(draftId, { inFlight: 'idle', actionError: msg })
        return
      }

      // Remove the row from the queue.
      setDrafts(prev => prev.filter(d => d.id !== draftId))
      setCardStates(prev => {
        const next = { ...prev }
        delete next[draftId]
        return next
      })
    } catch {
      updateCardState(draftId, { inFlight: 'idle', actionError: 'Connection error — please try again.' })
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  if (initialLoading) {
    return (
      <div className="flex flex-col gap-4 px-7 py-6">
        <DraftCardSkeleton />
        <DraftCardSkeleton />
        <DraftCardSkeleton />
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="px-7 py-6">
        <div className="bg-[#FDEEE8] border border-[#EFBCAA] rounded-[10px] px-5 py-4">
          <p className="text-[13px] font-medium text-[#8B2020] mb-1">Queue unavailable</p>
          <p className="text-[12px] text-[#8B2020]">{fetchError}</p>
        </div>
      </div>
    )
  }

  if (drafts.length === 0) {
    return <EmptyState />
  }

  return (
    <div className="flex flex-col gap-4 px-7 py-6">
      {drafts.map(draft => {
        const state = cardStates[draft.id] ?? initialCardState(draft)
        return (
          <DraftCard
            key={draft.id}
            draft={draft}
            callbacks={{ onApprove: handleApprove, onReject: handleReject }}
            textareaValue={state.textareaValue}
            onTextareaChange={handleTextareaChange}
            inFlight={state.inFlight}
            actionError={state.actionError}
          />
        )
      })}
    </div>
  )
}
