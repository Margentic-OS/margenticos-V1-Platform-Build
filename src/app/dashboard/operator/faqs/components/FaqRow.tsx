'use client'

import { useState } from 'react'
import type { FaqListItem } from './types'

interface FaqRowProps {
  faq: FaqListItem
  onSave: (faqId: string, answer: string) => Promise<void>
  onArchive: (faqId: string) => Promise<void>
  onRestore: (faqId: string) => Promise<void>
}

export function FaqRow({ faq, onSave, onArchive, onRestore }: FaqRowProps) {
  const [editing, setEditing] = useState(false)
  const [draftAnswer, setDraftAnswer] = useState(faq.answer)
  const [saving, setSaving] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isArchived = faq.status === 'archived'

  async function handleSave() {
    if (saving || !draftAnswer.trim()) return
    setSaving(true)
    setError(null)
    try {
      await onSave(faq.id, draftAnswer)
      setEditing(false)
    } catch {
      setError('Failed to save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  function handleCancel() {
    setDraftAnswer(faq.answer)
    setEditing(false)
    setError(null)
  }

  async function handleArchive() {
    if (archiving) return
    setArchiving(true)
    setError(null)
    try {
      await onArchive(faq.id)
    } catch {
      setError('Failed to archive. Try again.')
      setArchiving(false)
    }
  }

  async function handleRestore() {
    if (archiving) return
    setArchiving(true)
    setError(null)
    try {
      await onRestore(faq.id)
    } catch {
      setError('Failed to restore. Try again.')
      setArchiving(false)
    }
  }

  return (
    <div className={`border-b border-border-card last:border-b-0 py-4 ${isArchived ? 'opacity-60' : ''}`}>
      {/* Question row */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-text-primary leading-snug">
            {faq.question_canonical}
          </p>
          {faq.question_variants.length > 0 && (
            <p className="text-[10px] text-text-muted mt-0.5">
              {faq.question_variants.length} variant{faq.question_variants.length !== 1 ? 's' : ''}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isArchived ? (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#F0EBE3] text-text-secondary border border-border-card">
              Archived
            </span>
          ) : (
            <span className="text-[10px] text-text-muted">
              Used {faq.times_used}×
            </span>
          )}
        </div>
      </div>

      {/* Answer display / edit */}
      {editing ? (
        <div className="mt-2">
          <textarea
            value={draftAnswer}
            onChange={e => setDraftAnswer(e.target.value)}
            disabled={saving}
            rows={4}
            aria-label={`Edit answer for: ${faq.question_canonical}`}
            className="w-full text-[12px] text-text-primary leading-relaxed px-3 py-2.5 border border-border-card rounded-[6px] bg-white resize-none focus:outline-none focus:border-[#A8D4B8] focus:ring-1 focus:ring-[#A8D4B8] disabled:opacity-60"
          />
          {error && <p className="text-[11px] text-[#8B2020] mt-1">{error}</p>}
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={handleSave}
              disabled={saving || !draftAnswer.trim()}
              className="px-3 py-1.5 rounded-[6px] bg-brand-green text-[#F5F0E8] text-[12px] font-medium hover:bg-[#244030] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={handleCancel}
              disabled={saving}
              className="px-3 py-1.5 rounded-[6px] bg-white border border-border-card text-[12px] font-medium text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-1">
          <p className="text-[12px] text-text-secondary leading-relaxed line-clamp-3">
            {faq.answer}
          </p>
          {error && <p className="text-[11px] text-[#8B2020] mt-1">{error}</p>}
          <div className="flex items-center gap-3 mt-2">
            {!isArchived && (
              <button
                onClick={() => setEditing(true)}
                className="text-[11px] text-text-secondary hover:text-text-primary transition-colors"
              >
                Edit answer
              </button>
            )}
            {isArchived ? (
              <button
                onClick={handleRestore}
                disabled={archiving}
                className="text-[11px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
              >
                {archiving ? 'Restoring…' : 'Restore'}
              </button>
            ) : (
              <button
                onClick={handleArchive}
                disabled={archiving}
                className="text-[11px] text-text-muted hover:text-[#8B2020] transition-colors disabled:opacity-50"
              >
                {archiving ? 'Archiving…' : 'Archive'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
