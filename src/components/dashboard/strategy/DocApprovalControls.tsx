'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { approvalSourceLabel } from '@/lib/dashboard/approval-source-label'

interface Props {
  docId: string
  clientApprovalStatus: string
  approvalSource: string | null
  changeSummary: string | null
  revisionNote: string | null
  isOperator: boolean
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

export function DocApprovalControls({
  docId,
  clientApprovalStatus,
  approvalSource,
  changeSummary,
  revisionNote,
  isOperator,
  hasPendingRevision = false,
}: Props) {
  const router = useRouter()
  const [changeFormOpen, setChangeFormOpen] = useState(false)
  const [loading, setLoading] = useState<'approving' | 'revising' | 'proceeding' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const prevDocIdRef = useRef(docId)

  // A revision creates a new document row with a new id. Reset UI state so the
  // fresh pending controls appear once the server re-renders with the new doc.
  useEffect(() => {
    if (prevDocIdRef.current !== docId) {
      prevDocIdRef.current = docId
      setLoading(null)
      setError(null)
      setChangeFormOpen(false)
      setNote('')
    }
  }, [docId])

  const isPending = clientApprovalStatus === 'pending'
  const busy = loading !== null

  async function handleApprove() {
    setError(null)
    setLoading('approving')
    const err = await postJson('/api/documents/approve', { document_id: docId })
    if (err) { setError(err); setLoading(null); return }
    router.refresh()
  }

  async function handleRevise() {
    if (!note.trim()) return
    setError(null)
    setLoading('revising')
    const err = await postJson('/api/documents/revise', { document_id: docId, note: note.trim() })
    if (err) { setError(err); setLoading(null); return }
    router.refresh()
  }

  async function handleProceed() {
    setError(null)
    setLoading('proceeding')
    const err = await postJson('/api/operator/documents/force-approve', { document_id: docId })
    if (err) { setError(err); setLoading(null); return }
    router.refresh()
  }

  return (
    <div className="mb-5 print:hidden">
      <div className="space-y-2">

        {/* What changed — shown on revised versions regardless of approval status */}
        {changeSummary && (
          <div className="bg-[#F5F2ED] border border-[#E8E3DC] rounded-[8px] px-4 py-3">
            <p className="text-[11px] font-medium text-text-secondary mb-1">What changed in this version</p>
            <p className="text-[12px] text-text-primary leading-relaxed">{changeSummary}</p>
            {revisionNote && (
              <p className="text-[11px] text-text-muted mt-1.5">
                Your note: &ldquo;{revisionNote}&rdquo;
              </p>
            )}
          </div>
        )}

        {/* Revision in progress: shown while the agent runs, hidden once staged */}
        {loading === 'revising' && !hasPendingRevision && (
          <div className="bg-surface-card border border-border-card rounded-[8px] px-4 py-3 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#C8A96E] animate-pulse shrink-0" />
            <p className="text-[12px] text-text-secondary">Revising your document…</p>
          </div>
        )}

        {hasPendingRevision ? (
          <>
            {/* Under review: client revision staged, awaiting operator approval */}
            <div className="bg-[#F5F2ED] border border-[#E8E3DC] rounded-[8px] px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#C8A96E] shrink-0" />
                <p className="text-[12px] text-text-secondary leading-relaxed">
                  Revision submitted. Your outbound team will review it before any changes go live.
                </p>
              </div>
            </div>

            {/* Operator Proceed remains available even while a revision is staged */}
            {isOperator && isPending && (
              <div className="flex items-center justify-end">
                <button
                  onClick={handleProceed}
                  disabled={busy}
                  className="text-[11px] text-text-muted hover:text-text-secondary transition-colors disabled:opacity-40"
                >
                  {loading === 'proceeding' ? 'Proceeding…' : 'Proceed without client approval →'}
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            {/* Pending approval: Approve + Request changes */}
            {isPending && loading !== 'revising' && (
              <>
                <div className="bg-surface-card border border-border-card rounded-[8px] px-4 py-3">
                  {changeFormOpen ? (
                    <div className="space-y-2.5">
                      <p className="text-[12px] font-medium text-text-primary">What would you like changed?</p>
                      <textarea
                        value={note}
                        onChange={e => setNote(e.target.value)}
                        placeholder="Describe what you'd like updated, e.g. the target company size, job titles, or tone."
                        rows={3}
                        className="w-full text-[12px] text-text-primary placeholder:text-text-muted bg-surface-content border border-border-card rounded-[6px] px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-[#1C3A2A] leading-relaxed"
                      />
                      {error && (
                        <p className="text-[11px] text-[#C0392B]">{error}</p>
                      )}
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
                  ) : (
                    <div className="flex items-center justify-between gap-4">
                      <p className="text-[12px] text-text-secondary leading-relaxed">
                        Review this document and approve it when you&apos;re ready, or let us know what you&apos;d like changed.
                      </p>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => { setError(null); setChangeFormOpen(true) }}
                          disabled={busy}
                          className="text-[11px] text-text-secondary border border-border-card hover:border-text-secondary rounded-[6px] px-3 py-1.5 transition-colors disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-[#1C3A2A] focus-visible:ring-offset-1"
                        >
                          Request changes
                        </button>
                        <button
                          onClick={handleApprove}
                          disabled={busy}
                          className="text-[11px] text-white bg-[#1C3A2A] hover:bg-[#152e21] px-3 py-1.5 rounded-[6px] disabled:opacity-50 transition-colors focus-visible:ring-2 focus-visible:ring-[#1C3A2A] focus-visible:ring-offset-1"
                        >
                          {loading === 'approving' ? 'Approving…' : 'Approve'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Approve / proceed errors shown outside the card */}
                {error && !changeFormOpen && (
                  <p className="text-[11px] text-[#C0392B] text-right">{error}</p>
                )}

                {/* Operator Proceed — must not render for normal clients */}
                {isOperator && (
                  <div className="flex items-center justify-end">
                    <button
                      onClick={handleProceed}
                      disabled={busy}
                      className="text-[11px] text-text-muted hover:text-text-secondary transition-colors disabled:opacity-40"
                    >
                      {loading === 'proceeding' ? 'Proceeding…' : 'Proceed without client approval →'}
                    </button>
                  </div>
                )}
              </>
            )}

            {/* Approved indicator */}
            {!isPending && (
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-brand-green-success shrink-0" />
                <span className="text-[12px] text-text-secondary">{approvalSourceLabel(approvalSource)}</span>
              </div>
            )}
          </>
        )}

      </div>
    </div>
  )
}
