'use client'

import { useState } from 'react'

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

interface Props {
  clientId: string
  docType: string
}

export function RegenerateButton({ clientId, docType }: Props) {
  const [state, setState] = useState<'idle' | 'confirming' | 'loading' | 'done' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [note, setNote] = useState('')

  async function handleConfirm() {
    setState('loading')
    setErrorMsg(null)

    const res = await fetch('/api/suggestions/regenerate', {
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
        New suggestion is being prepared, check back shortly.
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
            onClick={() => { setState('idle'); setErrorMsg(null); setNote('') }}
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
