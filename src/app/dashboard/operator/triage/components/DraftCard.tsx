'use client'

import { useEffect, useRef, useState } from 'react'
import { TierBadge } from './TierBadge'
import { intentLabel } from '@/lib/intent-labels'
import type { TriageDraftItem } from './types'

// ── Per-card client state ──────────────────────────────────────────────────────

export type CardInFlightState = 'idle' | 'approving' | 'rejecting'

export interface DraftCardCallbacks {
  onApprove: (draftId: string, finalBody: string, edited: boolean) => Promise<void>
  onReject: (draftId: string) => Promise<void>
}

interface DraftCardProps {
  draft: TriageDraftItem
  callbacks: DraftCardCallbacks
  // When the polling refresh brings in a new version of this draft while the
  // operator has touched the textarea, the parent should NOT pass the new
  // ai_draft_body. The parent tracks touched state; this component is controlled.
  textareaValue: string
  onTextareaChange: (draftId: string, value: string) => void
  inFlight: CardInFlightState
  actionError: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatAge(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function prospectDisplay(draft: TriageDraftItem): { name: string; handle: string | null } {
  const p = draft.prospect
  if (!p) return { name: 'Unknown prospect', handle: null }
  const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Unknown prospect'
  const handle = p.email ?? p.linkedin_url ?? null
  return { name, handle }
}

// Send-progress bar that animates from 0 → 100% over ~10 seconds while a send is in flight.
function SendProgressBar({ active }: { active: boolean }) {
  const [width, setWidth] = useState(0)

  useEffect(() => {
    if (!active) { setWidth(0); return }
    // Small delay so the bar starts visibly before the transition kicks in.
    const t = setTimeout(() => setWidth(95), 50)
    return () => clearTimeout(t)
  }, [active])

  if (!active) return null

  return (
    <div className="mt-2 h-[3px] w-full bg-[#F0ECE4] rounded-[2px] overflow-hidden">
      <div
        className="h-full bg-brand-green rounded-[2px] transition-all ease-linear"
        style={{ width: `${width}%`, transitionDuration: '9500ms' }}
      />
    </div>
  )
}

// ── ReadOnly body display (prospect reply / original outbound) ──────────────

function ReadOnlyBody({ label, body, missing }: { label: string; body: string | null; missing?: string }) {
  return (
    <div>
      <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-1.5">
        {label}
      </p>
      {body ? (
        <div className="bg-[#F8F4EE] border border-border-card rounded-[6px] px-3.5 py-3 text-[12px] text-text-primary leading-relaxed whitespace-pre-wrap">
          {body}
        </div>
      ) : (
        <div className="bg-[#F8F4EE] border border-border-card rounded-[6px] px-3.5 py-3 text-[12px] text-text-secondary italic">
          {missing ?? 'Not available.'}
        </div>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function DraftCard({
  draft,
  callbacks,
  textareaValue,
  onTextareaChange,
  inFlight,
  actionError,
}: DraftCardProps) {
  const { name: prospectName, handle: prospectHandle } = prospectDisplay(draft)
  const isApproving = inFlight === 'approving'
  const isRejecting = inFlight === 'rejecting'
  const anyInFlight = inFlight !== 'idle'

  const isTier3 = draft.tier === 3
  const isSendFailed = draft.status === 'send_failed'
  const isOperatorAuthored = draft.status === 'manual_required' || draft.status === 'draft_failed'

  const initialBody = draft.ai_draft_body ?? ''
  const edited = textareaValue !== initialBody

  // Border and background tint differ by tier.
  const cardBorder = isTier3 ? 'border-[#F0D080]' : 'border-border-card'
  const cardBg = 'bg-surface-card'

  const labelText = intentLabel(draft.intent)

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-resize textarea on value change.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [textareaValue])

  async function handleApprove() {
    if (anyInFlight || !textareaValue.trim()) return
    await callbacks.onApprove(draft.id, textareaValue, edited)
  }

  async function handleReject() {
    if (anyInFlight) return
    await callbacks.onReject(draft.id)
  }

  return (
    <article className={`${cardBg} border ${cardBorder} rounded-[10px] p-[22px]`}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <p className="text-[13px] font-medium text-text-primary leading-snug">{prospectName}</p>
          {prospectHandle && (
            <p className="text-[11px] text-text-secondary mt-0.5">{prospectHandle}</p>
          )}
          {!draft.prospect && (
            <p className="text-[11px] text-text-muted mt-0.5">
              Signal {draft.signal_id.slice(0, 8)}…
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <TierBadge tier={draft.tier} />
          {labelText ? (
            <span className="text-[11px] text-text-secondary">{labelText}</span>
          ) : (
            <span className="text-[11px] text-text-secondary font-mono">{draft.intent}</span>
          )}
        </div>
      </div>

      {/* ── Meta row ───────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 mb-5">
        <span className="text-[10px] text-text-muted">{formatAge(draft.created_at)}</span>
        {isSendFailed && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#FDEEE8] border border-[#EFBCAA]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#8B2020] shrink-0" />
            <span className="text-[10px] font-medium text-[#8B2020]">Send failed</span>
          </span>
        )}
        {isOperatorAuthored && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#FEF7E6] border border-[#F0D080]">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-amber shrink-0" />
            <span className="text-[10px] font-medium text-[#7A4800]">
              {draft.status === 'manual_required' ? 'No draft — write manually' : 'Draft failed — write manually'}
            </span>
          </span>
        )}
      </div>

      {/* ── Content area ───────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 mb-5">

        {/* Prospect's reply */}
        <ReadOnlyBody
          label="Their reply"
          body={draft.signal_reply_body}
          missing="Reply body wasn't captured. Check the thread in Instantly directly."
        />

        {/* Original outbound email */}
        <ReadOnlyBody
          label="What we sent them"
          body={draft.original_outbound_body}
          missing="Original outbound body wasn't captured. Check Instantly thread directly."
        />

        {/* Send failure detail — shown on send_failed rows only */}
        {isSendFailed && draft.send_error && (
          <div className="bg-[#FDEEE8] border border-[#EFBCAA] rounded-[6px] px-3.5 py-3">
            <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-[#8B2020] mb-1">
              Send error
            </p>
            <p className="text-[12px] text-[#8B2020] font-mono leading-relaxed break-all">
              {draft.send_error}
            </p>
            <p className="text-[11px] text-text-secondary mt-2">
              Reject this draft to remove it from the queue, then reply directly in Instantly.
            </p>
          </div>
        )}

        {/* FAQ context — Tier 2 only */}
        {draft.tier === 2 && draft.faqs.length > 0 && (
          <div>
            <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-2">
              FAQs used in this draft
            </p>
            <ul className="flex flex-col gap-2">
              {draft.faqs.map(faq => (
                <li key={faq.id} className="bg-[#F8F4EE] border border-border-card rounded-[6px] px-3.5 py-2.5">
                  <p className="text-[11px] font-medium text-text-primary mb-1">{faq.question_canonical}</p>
                  <p className="text-[11px] text-text-secondary leading-relaxed">{faq.answer}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Draft body — editable textarea */}
        {!isSendFailed && (
          <div>
            <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-1.5">
              {isOperatorAuthored ? 'Your reply' : 'Draft reply'}
            </p>

            {/* Tier 3 rewrite warning */}
            {isTier3 && !isOperatorAuthored && (
              <div className="bg-[#FEF7E6] border border-[#F0D080] rounded-t-[6px] px-3.5 py-2 text-[11px] font-medium text-[#7A4800]">
                Starting point only — rewrite before sending.
              </div>
            )}

            {isOperatorAuthored && (
              <div className="bg-[#F8F4EE] border border-border-card rounded-t-[6px] px-3.5 py-2 text-[11px] text-text-secondary">
                No draft was generated. Write your reply below.
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={textareaValue}
              onChange={e => onTextareaChange(draft.id, e.target.value)}
              disabled={anyInFlight}
              rows={6}
              placeholder={isOperatorAuthored ? 'Write your reply here…' : ''}
              className={[
                'w-full text-[12px] text-text-primary leading-relaxed',
                'px-3.5 py-3 resize-none overflow-hidden',
                'border border-border-card border-t-0 bg-white',
                'focus:outline-none focus:border-[#A8D4B8] focus:ring-1 focus:ring-[#A8D4B8]',
                'disabled:opacity-60',
                (isTier3 || isOperatorAuthored) ? 'rounded-b-[6px]' : 'rounded-[6px]',
              ].join(' ')}
            />
          </div>
        )}
      </div>

      {/* ── Action row ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1">
          {/* Action error message */}
          {actionError && (
            <p className="text-[11px] text-[#8B2020] leading-snug">{actionError}</p>
          )}
          {/* Send progress bar — visible during approve in-flight */}
          <SendProgressBar active={isApproving} />
          {isApproving && (
            <p className="text-[10px] text-text-secondary mt-1.5">Sending… usually under 10 seconds.</p>
          )}
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {/* Reject button — available on all statuses including send_failed */}
          <button
            onClick={handleReject}
            disabled={anyInFlight}
            className="px-3.5 py-1.5 rounded-[6px] bg-white border border-border-card text-[12px] font-medium text-text-secondary hover:text-text-primary hover:border-[#D8D2C8] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRejecting ? 'Rejecting…' : 'Reject'}
          </button>

          {/* Approve button — not shown on send_failed rows (terminal state) */}
          {!isSendFailed && (
            <button
              onClick={handleApprove}
              disabled={anyInFlight || !textareaValue.trim()}
              className={[
                'px-3.5 py-1.5 rounded-[6px] text-[12px] font-medium transition-colors',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                isTier3
                  ? 'bg-[#FEF7E6] border border-[#F0D080] text-[#7A4800] hover:bg-[#FAEEDA]'
                  : 'bg-brand-green text-[#F5F0E8] hover:bg-[#244030]',
              ].join(' ')}
            >
              {isApproving
                ? 'Sending…'
                : isTier3
                  ? 'Edit and approve'
                  : 'Approve'}
            </button>
          )}
        </div>
      </div>
    </article>
  )
}
