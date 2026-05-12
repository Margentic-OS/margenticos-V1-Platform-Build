'use client'

import { useState } from 'react'
import type { ExtractionItem, FaqListItem } from './types'

export type ExtractionInFlight = 'idle' | 'approving_new' | 'approving_merge' | 'rejecting'

export interface ExtractionCardCallbacks {
  onApproveNew: (extraction: ExtractionItem) => Promise<void>
  onApproveMerge: (extraction: ExtractionItem, targetFaqId: string) => Promise<void>
  onReject: (extraction: ExtractionItem) => Promise<void>
}

interface ExtractionCardProps {
  extraction: ExtractionItem
  faqs: FaqListItem[]
  callbacks: ExtractionCardCallbacks
  inFlight: ExtractionInFlight
  actionError: string | null
}

function formatAge(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function ReadOnlyBlock({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-1.5">
        {label}
      </p>
      <div className="bg-[#F8F4EE] border border-border-card rounded-[6px] px-3.5 py-3 text-[12px] text-text-primary leading-relaxed whitespace-pre-wrap">
        {body}
      </div>
    </div>
  )
}

export function ExtractionCard({
  extraction,
  faqs,
  callbacks,
  inFlight,
  actionError,
}: ExtractionCardProps) {
  const anyInFlight = inFlight !== 'idle'
  const [mergeTargetId, setMergeTargetId] = useState<string>(
    extraction.similar_faq_id ?? ''
  )

  const hasSimilar = Boolean(extraction.similar_faq_id && extraction.similar_faq_question)
  const approvedFaqs = faqs.filter(f => f.status === 'approved')

  async function handleApproveNew() {
    if (anyInFlight) return
    await callbacks.onApproveNew(extraction)
  }

  async function handleApproveMerge() {
    if (anyInFlight || !mergeTargetId) return
    await callbacks.onApproveMerge(extraction, mergeTargetId)
  }

  async function handleReject() {
    if (anyInFlight) return
    await callbacks.onReject(extraction)
  }

  return (
    <article className="bg-surface-card border border-border-card rounded-[10px] p-[22px]">

      {/* ── Header ─────────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-1">
            New extraction
          </p>
          <p className="text-[11px] text-text-muted">{formatAge(extraction.created_at)}</p>
        </div>
        {extraction.similarity_score !== null && (
          <span className="text-[10px] text-text-secondary shrink-0">
            {Math.round(extraction.similarity_score * 100)}% match
          </span>
        )}
      </div>

      {/* ── Name flag warning ─────────────────────────────────────────────────── */}
      {extraction.potential_names_flagged.length > 0 && (
        <div className="bg-[#FEF7E6] border border-[#F0D080] rounded-[6px] px-3.5 py-2.5 mb-4">
          <p className="text-[10px] font-medium uppercase tracking-[0.07em] text-[#7A4800] mb-1">
            Possible names detected
          </p>
          <p className="text-[11px] text-[#7A4800] leading-relaxed">
            {extraction.potential_names_flagged.join(', ')}
          </p>
          <p className="text-[10px] text-[#7A4800] mt-1 opacity-80">
            Review the question below before approving — edit it after adding to the KB if needed.
          </p>
        </div>
      )}

      {/* ── Content ───────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 mb-5">
        <ReadOnlyBlock label="Extracted question" body={extraction.extracted_question} />
        <ReadOnlyBlock label="Suggested answer" body={extraction.suggested_answer} />

        {/* Similar FAQ context — shown when similarity detected */}
        {hasSimilar && (
          <div className="bg-[#FEF7E6] border border-[#F0D080] rounded-[6px] px-3.5 py-3">
            <p className="text-[10px] font-medium uppercase tracking-[0.07em] text-[#7A4800] mb-1.5">
              Similar existing FAQ
            </p>
            <p className="text-[12px] text-[#7A4800] leading-relaxed">
              {extraction.similar_faq_question}
            </p>
          </div>
        )}
      </div>

      {/* ── Merge target selector ─────────────────────────────────────────────── */}
      {approvedFaqs.length > 0 && (
        <div className="mb-5">
          <label
            htmlFor={`merge-target-${extraction.id}`}
            className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-1.5 block"
          >
            Merge into existing FAQ (optional)
          </label>
          <select
            id={`merge-target-${extraction.id}`}
            value={mergeTargetId}
            onChange={e => setMergeTargetId(e.target.value)}
            disabled={anyInFlight}
            className="w-full text-[12px] text-text-primary bg-white border border-border-card rounded-[6px] px-3 py-2 focus:outline-none focus:border-[#A8D4B8] focus:ring-1 focus:ring-[#A8D4B8] disabled:opacity-60"
          >
            <option value="">— Select an existing FAQ —</option>
            {approvedFaqs.map(faq => (
              <option key={faq.id} value={faq.id}>
                {faq.question_canonical}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* ── Action error ──────────────────────────────────────────────────────── */}
      {actionError && (
        <p className="text-[11px] text-[#8B2020] mb-3 leading-snug">{actionError}</p>
      )}

      {/* ── Actions ───────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={handleReject}
          disabled={anyInFlight}
          aria-label="Reject this extraction"
          className="px-3.5 py-1.5 rounded-[6px] bg-white border border-border-card text-[12px] font-medium text-text-secondary hover:text-text-primary hover:border-[#D8D2C8] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {inFlight === 'rejecting' ? 'Rejecting…' : 'Reject'}
        </button>

        <div className="flex items-center gap-2.5">
          {mergeTargetId ? (
            <button
              onClick={handleApproveMerge}
              disabled={anyInFlight}
              aria-label="Approve and merge into selected FAQ"
              className="px-3.5 py-1.5 rounded-[6px] text-[12px] font-medium bg-[#FEF7E6] border border-[#F0D080] text-[#7A4800] hover:bg-[#FAEEDA] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {inFlight === 'approving_merge' ? 'Merging…' : 'Approve and merge'}
            </button>
          ) : (
            <button
              onClick={handleApproveNew}
              disabled={anyInFlight}
              aria-label="Approve as new FAQ"
              className="px-3.5 py-1.5 rounded-[6px] text-[12px] font-medium bg-brand-green text-[#F5F0E8] hover:bg-[#244030] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {inFlight === 'approving_new' ? 'Adding…' : 'Approve as new FAQ'}
            </button>
          )}
        </div>
      </div>
    </article>
  )
}
