'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'

// The operator's regenerate control, with the note box that decides whether the
// regeneration is aimed at anything.
//
// ─── WHY THE NOTE IS HERE ────────────────────────────────────────────────────
//
// Until 2026-09-03 this button posted client_id and document_type and nothing else. The
// only place an operator could type a note was the approvals queue, on "Reject and
// regenerate". With client approval on documents removed, regenerating from the document
// page is the primary loop, and without a note every regeneration was a reroll: same
// inputs, same prompt, and whatever the model happened to produce that time.
//
// The note travels as regeneration_notes.operator_note and is interpolated into the
// agent's user message by buildRegenerationNotesBlock. See ADR-038, which exists because
// the operator's note once reached a database column and never reached the agent.
//
// It is OPTIONAL. Regenerating with no note is still a legitimate thing to want, and
// forcing a sentence out of somebody produces "please redo it", which is worse than
// nothing because it looks like an instruction.
//
// ─── WHY IT POLLS, ADDED 2026-09-07 ──────────────────────────────────────────
//
// This button used to call setState('done') the moment the POST returned, and show
// "New suggestion is being prepared, check back shortly". The route returns 202 and runs
// the agent in after(), so that 202 means THE REQUEST WAS ACCEPTED. It says nothing about
// whether a suggestion was ever produced.
//
// 'done' was terminal. No timer, no polling, no subscription, and the parent page is a
// server component with no revalidate that never reads agent_runs. So on 2026-09-05, when
// the tov agent failed after 100 seconds, the sentence stayed on screen until the operator
// reloaded, and on reload there was nothing to say the attempt had failed at all.
//
// A message that cannot become false is not a status. This one now reports what actually
// happened to the run.

interface Props {
  clientId: string
  docType: string
}

type State =
  | 'idle'
  | 'confirming'
  | 'loading'
  | 'waiting'   // accepted, agent in flight
  | 'done'      // a suggestion exists
  | 'failed'    // the run failed, and we can say why
  | 'stalled'   // no verdict inside the window
  | 'error'     // the POST itself was rejected

const POLL_INTERVAL_MS = 3000

// Runs observed on this document type take 85 to 120 seconds, and the agent's own guard is
// 240s. Six minutes is comfortably past both, so reaching it means no verdict is coming
// rather than that we were impatient.
const POLL_CEILING_MS = 6 * 60 * 1000

interface StatusResponse {
  outcome?: 'generating' | 'succeeded' | 'failed' | 'stalled' | 'none'
  latestRun?: { started_at: string; error_message?: string | null } | null
}

export function RegenerateButton({ clientId, docType }: Props) {
  const router = useRouter()
  const [state, setState] = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const pollRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  // THE ANCHOR, AND WHY IT IS NOT OPTIONAL.
  //
  // The route returns 202 before the agent has necessarily written its agent_runs row, and
  // /api/generation-status answers with the MOST RECENT run for this org and document type.
  // Poll too early and that is the PREVIOUS run, which on this page has usually completed.
  // Without this the button would report the last regeneration's success as this one's,
  // instantly, and be wrong in the most convincing way available.
  //
  // Five seconds of slack absorbs clock skew between this browser and the database.
  function startPolling(startedAfter: number) {
    stopPolling()
    const deadline = Date.now() + POLL_CEILING_MS

    pollRef.current = setInterval(async () => {
      if (Date.now() > deadline) {
        stopPolling()
        setState('stalled')
        return
      }

      let body: StatusResponse
      try {
        const res = await fetch(
          `/api/generation-status?client_id=${encodeURIComponent(clientId)}&document_type=${encodeURIComponent(docType)}`,
        )
        if (!res.ok) return // transient. The deadline is what ends this, not one bad response.
        body = (await res.json()) as StatusResponse
      } catch {
        return
      }

      // Ignore any run that predates the button press. Still ours to wait for.
      const startedAt = body.latestRun?.started_at
      if (!startedAt || new Date(startedAt).getTime() < startedAfter) return

      if (body.outcome === 'succeeded') {
        stopPolling()
        setState('done')
        // The page is a server component. Without this the new suggestion does not appear
        // until the operator reloads by hand, which is most of the original complaint.
        router.refresh()
        return
      }

      if (body.outcome === 'failed') {
        stopPolling()
        setErrorMsg(body.latestRun?.error_message ?? 'The agent run failed.')
        setState('failed')
        return
      }

      if (body.outcome === 'stalled') {
        stopPolling()
        setState('stalled')
      }
    }, POLL_INTERVAL_MS)
  }

  async function handleConfirm() {
    setState('loading')
    setErrorMsg(null)

    const startedAfter = Date.now() - 5000

    let res: Response
    try {
      res = await fetch('/api/suggestions/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          document_type: docType,
          // Omitted entirely when blank, so a run with no note is byte-identical to one
          // from before this field existed.
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      })
    } catch {
      setErrorMsg('Could not reach the server. Try again.')
      setState('error')
      return
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string; message?: string }
      setErrorMsg(body.error ?? body.message ?? 'Something went wrong. Try again.')
      setState('error')
      return
    }

    setState('waiting')
    startPolling(startedAfter)
  }

  function reset() {
    stopPolling()
    setState('idle')
    setErrorMsg(null)
    setNote('')
  }

  if (state === 'done') {
    return (
      <div className="flex flex-col items-end gap-1">
        <p className="text-[11px] text-[#1C3A2A]">New version ready. It is on this page now.</p>
        <button onClick={reset} className="text-[11px] text-text-secondary hover:text-text-primary transition-colors">
          Regenerate again
        </button>
      </div>
    )
  }

  if (state === 'failed' || state === 'stalled') {
    // The document is untouched either way. Saying so is the difference between an
    // operator who retries and one who goes looking for damage.
    const headline = state === 'failed'
      ? 'That regeneration failed. The current version is unchanged.'
      : 'No result after six minutes. The current version is unchanged.'

    return (
      <div className="flex flex-col items-end gap-1 max-w-[320px]">
        <p className="text-[11px] text-[#7A2020] text-right leading-snug">{headline}</p>
        {errorMsg && (
          <p className="text-[10px] text-text-muted text-right leading-snug font-mono break-all">
            {errorMsg}
          </p>
        )}
        <button onClick={reset} className="text-[11px] text-text-secondary hover:text-text-primary transition-colors">
          Try again
        </button>
      </div>
    )
  }

  if (state === 'waiting') {
    return (
      <p className="text-[11px] text-[#7A4800]">
        Generating the new version. This usually takes about two minutes.
      </p>
    )
  }

  if (state === 'confirming' || state === 'loading' || state === 'error') {
    return (
      <div className="flex flex-col items-end gap-2 w-full max-w-[320px]">
        {/* Kept mounted while loading, disabled rather than unmounted, so the note the
            operator just wrote does not vanish the moment they press Regenerate. If the
            request fails they need to see what they typed. */}
        <>
            <p className="text-[11px] text-text-secondary leading-snug text-right">
              {state === 'error' && errorMsg
                ? errorMsg
                : 'This generates a new version for review. The current document stays live until the new one is approved.'}
            </p>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="What should change this time? Optional, and the more specific the better."
              rows={3}
              disabled={state === 'loading'}
              aria-label="Note for this regeneration"
              className="w-full text-[12px] text-text-primary placeholder:text-text-muted bg-surface-content border border-border-card rounded-[6px] px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-[#1C3A2A] leading-relaxed disabled:opacity-40"
            />
        </>
        <div className="flex items-center gap-2">
          <button
            onClick={reset}
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
            {state === 'loading' ? 'Queuing…' : 'Regenerate'}
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
