'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

// What a client can do with a live strategy document.
//
// ─── WHAT WAS REMOVED HERE, 2026-09-03 ───────────────────────────────────────
//
// An Approve button, a pending state the client had to clear, and an operator
// "Proceed without client approval" escape hatch. Client approval on strategy
// documents is removed: the conversation with the operator is the approval. ADR-039.
//
// What is left is the one control that was never approval: asking for a change. A
// client reading a document and saying what is wrong with it is the useful half, and
// it is unaffected by whether anyone had to click Approve first.

interface Props {
  docId: string
  changeSummary: string | null
  revisionNote: string | null
  hasPendingRevision?: boolean
}

async function postJson(url: string, body: Record<string, string>): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string }
      return data.error ?? 'Something went wrong. Try again.'
    }
    return null
  } catch {
    return 'Could not reach the server. Check your connection and try again.'
  }
}

export function DocumentRevisionControls({
  docId,
  changeSummary,
  revisionNote,
  hasPendingRevision = false,
}: Props) {
  const router = useRouter()
  const [changeFormOpen, setChangeFormOpen] = useState(false)
  const [loading, setLoading] = useState<'revising' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const prevDocIdRef = useRef(docId)

  // A revision creates a new document row with a new id. Reset UI state so the
  // fresh controls appear once the server re-renders with the new doc.
  useEffect(() => {
    if (prevDocIdRef.current !== docId) {
      prevDocIdRef.current = docId
      setLoading(null)
      setError(null)
      setChangeFormOpen(false)
      setNote('')
    }
  }, [docId])

  const busy = loading !== null

  async function handleRevise() {
    if (!note.trim()) return
    setError(null)
    setLoading('revising')
    const err = await postJson('/api/documents/revise', { document_id: docId, note: note.trim() })
    if (err) { setError(err); setLoading(null); return }
    router.refresh()
  }

  const changeForm = (
    <div className="space-y-2.5">
      <p className="text-[12px] font-medium text-text-primary">What would you like changed?</p>
      <textarea
        value={note}
        onChange={e => setNote(e.target.value)}
        placeholder="Describe what you would like updated, and where in the document it is."
        rows={3}
        className="w-full text-[12px] text-text-primary placeholder:text-text-muted bg-surface-content border border-border-card rounded-[6px] px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-[#1C3A2A] leading-relaxed"
      />
      {error && <p className="text-[11px] text-[#C0392B]">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={() => { setChangeFormOpen(false); setNote(''); setError(null) }}
          disabled={busy}
          className="text-[11px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          onClick={handleRevise}
          disabled={!note.trim() || busy}
          className="text-[11px] text-white bg-[#1C3A2A] hover:bg-[#152e21] px-3 py-1.5 rounded-[6px] disabled:opacity-40 transition-colors"
        >
          Submit changes
        </button>
      </div>
    </div>
  )

  return (
    <div className="mb-5 print:hidden">
      <div className="space-y-2">

        {/* What changed — shown on any version that recorded a summary */}
        {changeSummary && (
          <div className="bg-[#F5F2ED] border border-[#E8E3DC] rounded-[8px] px-4 py-3">
            <p className="text-[11px] font-medium text-text-secondary mb-1">What changed in this version</p>
            <p className="text-[12px] text-text-primary leading-relaxed">{changeSummary}</p>
            {revisionNote && (
              <p className="text-[11px] text-text-muted mt-1.5">
                The note behind it: &ldquo;{revisionNote}&rdquo;
              </p>
            )}
          </div>
        )}

        {loading === 'revising' && !hasPendingRevision && (
          <div className="bg-surface-card border border-border-card rounded-[8px] px-4 py-3 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#C8A96E] animate-pulse shrink-0" />
            <p className="text-[12px] text-text-secondary">Revising your document…</p>
          </div>
        )}

        {hasPendingRevision ? (
          <div className="bg-[#F5F2ED] border border-[#E8E3DC] rounded-[8px] px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-[#C8A96E] shrink-0" />
              <p className="text-[12px] text-text-secondary leading-relaxed">
                Revision submitted. Your outbound team will review it before any changes go live.
              </p>
            </div>
          </div>
        ) : (
          loading !== 'revising' && (
            <div className="bg-surface-card border border-border-card rounded-[8px] px-4 py-3">
              {changeFormOpen ? changeForm : (
                <div className="flex items-center justify-between gap-4">
                  <p className="text-[12px] text-text-secondary leading-relaxed">
                    This is the version we are working from. Tell us if anything should change.
                  </p>
                  <button
                    onClick={() => { setError(null); setChangeFormOpen(true) }}
                    disabled={busy}
                    className="text-[11px] text-text-secondary border border-border-card hover:border-text-secondary rounded-[6px] px-3 py-1.5 transition-colors disabled:opacity-40 shrink-0 focus-visible:ring-2 focus-visible:ring-[#1C3A2A] focus-visible:ring-offset-1"
                  >
                    Request an update
                  </button>
                </div>
              )}
            </div>
          )
        )}

        {error && !changeFormOpen && (
          <p className="text-[11px] text-[#C0392B] text-right">{error}</p>
        )}

      </div>
    </div>
  )
}
