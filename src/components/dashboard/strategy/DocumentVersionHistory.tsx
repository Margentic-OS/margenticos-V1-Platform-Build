'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { DescribedVersion } from '@/lib/dashboard/version-history'

// One document on screen, always the current one, with a line saying it changed and
// when. "View previous" opens the full list. Never two documents side by side: comparing
// them is not the job, knowing what happened and being able to put it back is.
//
// ─── WHY THE MESSAGING WARNING IS WORDED THE WAY IT IS ───────────────────────
//
// Restoring a messaging version changes the copy every email composed AFTER that moment
// is built from. It does not reach emails already composed, and it cannot: those are
// uploaded to the sending provider as substituted variables, and a prospect is composed
// once and never again. Campaigns already running continue exactly as they are.
//
// So the notice says what restore does and what it does not. Implying a clean undo would
// be the more comfortable copy and the more expensive mistake.

interface Props {
  versions: DescribedVersion[]
  /** Restore is operator-only. A client's route to a change is Request an update. */
  canRestore: boolean
  /** Messaging carries a warning the other three do not need. */
  isMessaging: boolean
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

export function DocumentVersionHistory({ versions, canRestore, isMessaging }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const live = versions.find(v => v.isLive)
  const previous = versions.filter(v => !v.isLive)

  async function handleRestore(id: string) {
    setError(null)
    setRestoringId(id)
    try {
      const res = await fetch('/api/documents/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: id }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        setError(data.error ?? 'Something went wrong. Try again.')
        setRestoringId(null)
        return
      }
      setConfirmingId(null)
      setRestoringId(null)
      setOpen(false)
      router.refresh()
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
      setRestoringId(null)
    }
  }

  if (!live) return null

  return (
    <div className="mb-4 print:hidden">
      <div className="flex items-center justify-between gap-4">
        <p className="text-[11px] text-text-muted">
          {live.label}, updated {formatDate(live.createdAt)}
        </p>
        {previous.length > 0 && (
          <button
            onClick={() => { setOpen(o => !o); setError(null); setConfirmingId(null) }}
            aria-expanded={open}
            className="text-[11px] text-text-secondary hover:text-text-primary transition-colors shrink-0 focus-visible:ring-2 focus-visible:ring-[#1C3A2A] focus-visible:ring-offset-1 rounded-[4px]"
          >
            {open ? 'Hide previous versions' : `View previous (${previous.length})`}
          </button>
        )}
      </div>

      {open && (
        <div className="mt-3 border border-border-card rounded-[8px] overflow-hidden">
          {isMessaging && canRestore && (
            <div className="bg-[#F5F2ED] border-b border-[#E8E3DC] px-4 py-3">
              <p className="text-[11px] text-text-secondary leading-relaxed">
                Restoring changes the emails composed from this point on. Emails already
                written or already sent are not rewritten, and campaigns already running
                continue exactly as they are.
              </p>
            </div>
          )}

          <ul className="divide-y divide-border-card">
            {versions.map(v => (
              <li key={v.id} className="px-4 py-3 bg-surface-card">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[12px] font-medium text-text-primary">
                      {v.label}
                      {v.isLive && (
                        <span className="ml-2 text-[10px] font-normal text-text-muted uppercase tracking-[0.06em]">
                          Current
                        </span>
                      )}
                    </p>
                    <p className="text-[11px] text-text-muted mt-0.5">{formatDate(v.createdAt)}</p>
                    <p
                      className={
                        v.hasRecordedReason
                          ? 'text-[12px] text-text-primary leading-relaxed mt-1.5'
                          : 'text-[12px] text-text-secondary italic leading-relaxed mt-1.5'
                      }
                    >
                      {v.description}
                    </p>
                  </div>

                  {canRestore && !v.isLive && (
                    <div className="shrink-0">
                      {confirmingId === v.id ? (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setConfirmingId(null)}
                            disabled={restoringId !== null}
                            className="text-[11px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => handleRestore(v.id)}
                            disabled={restoringId !== null}
                            className="text-[11px] text-white bg-[#1C3A2A] hover:bg-[#152e21] px-3 py-1.5 rounded-[6px] disabled:opacity-40 transition-colors"
                          >
                            {restoringId === v.id ? 'Restoring…' : 'Confirm restore'}
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setConfirmingId(v.id); setError(null) }}
                          disabled={restoringId !== null}
                          className="text-[11px] text-text-secondary border border-border-card hover:border-text-secondary rounded-[6px] px-3 py-1.5 transition-colors disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-[#1C3A2A] focus-visible:ring-offset-1"
                        >
                          Restore this version
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {error && (
            <p className="text-[11px] text-[#C0392B] px-4 py-2 bg-surface-card border-t border-border-card">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
