'use client'

import { useState } from 'react'
import type { OperatorReply } from '@/lib/reply-handling/get-operator-replies'

function formatDate(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })
}

// Draft status drives the only colour on the card that means "look at this".
function draftStatusClass(status: string): string {
  if (status === 'sent') return 'bg-light-green text-primary-text'
  if (status === 'send_failed') return 'bg-[rgba(200,40,40,0.10)] text-[#8A1F1F]'
  if (status === 'pending') return 'bg-[rgba(239,159,39,0.12)] text-[#7A4800]'
  return 'bg-[#F0ECE4] text-secondary-text'
}

export function OperatorReplyCard({ reply }: { reply: OperatorReply }) {
  const [showContext, setShowContext] = useState(false)

  const prospectName = reply.prospect.first_name
    ? `${reply.prospect.first_name} ${reply.prospect.last_name || ''}`.trim()
    : reply.prospect.email || 'Unknown prospect'

  const company = reply.prospect.company_name || ''
  const timeAgo = formatDate(reply.received_at)
  const { draft } = reply

  const hasContext = Boolean(reply.prompting_email || draft)

  return (
    <div className="bg-white border border-[#E8E2D8] rounded-[10px] p-5">
      {/* Header: who replied, and how sure we were about what they meant */}
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-primary-text">{prospectName}</p>
          <p className="text-[12px] text-secondary-text mt-0.5">
            {[company, reply.prospect.job_title].filter(Boolean).join(' · ')}
          </p>
          {reply.prospect.email && (
            <p className="text-[11px] text-secondary-text mt-0.5">{reply.prospect.email}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-[11px] text-secondary-text">{timeAgo}</span>
          <span className="text-[10px] text-secondary-text">
            {Math.round(reply.confidence * 100)}% confident
          </span>
        </div>
      </div>

      {reply.reply_subject && (
        <p className="text-[12px] text-secondary-text mb-2">
          <span className="font-medium">Subject:</span> {reply.reply_subject}
        </p>
      )}

      {/* The reply itself, verbatim and complete. Newlines preserved: what the operator
          has to act on is often in the last line, and this used to be cut at 300 chars. */}
      <p className="text-[13px] leading-relaxed text-primary-text whitespace-pre-wrap text-pretty">
        {reply.reply_body || <span className="text-secondary-text italic">No body captured</span>}
      </p>

      {/* Footer: what the system did about it */}
      <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-[#F0ECE4] flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-secondary-text">
            Action: {reply.action_taken}
            {reply.action_succeeded === false && (
              <span className="text-[#8A1F1F] font-medium"> (failed)</span>
            )}
          </span>
          {draft && (
            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${draftStatusClass(draft.status)}`}>
              Tier {draft.tier} draft: {draft.status}
            </span>
          )}
        </div>
        {hasContext && (
          <button
            type="button"
            onClick={() => setShowContext(v => !v)}
            aria-expanded={showContext}
            className="text-[11px] font-medium text-secondary-text hover:text-primary-text transition-colors"
          >
            {showContext ? 'Hide context' : 'Show context'}
          </button>
        )}
      </div>

      {showContext && (
        <div className="mt-3 space-y-3">
          {reply.prompting_email && (
            <div className="bg-[#FAF8F4] border border-[#F0ECE4] rounded-[8px] p-3">
              <p className="text-[10px] font-medium uppercase tracking-[0.06em] text-secondary-text mb-1.5">
                What we sent them
              </p>
              <p className="text-[12px] leading-relaxed text-secondary-text whitespace-pre-wrap">
                {reply.prompting_email}
              </p>
            </div>
          )}
          {draft && (draft.ai_draft_body || draft.final_sent_body) && (
            <div className="bg-[#FAF8F4] border border-[#F0ECE4] rounded-[8px] p-3">
              <p className="text-[10px] font-medium uppercase tracking-[0.06em] text-secondary-text mb-1.5">
                {draft.final_sent_body ? 'What went back' : 'Drafted reply, not sent'}
              </p>
              <p className="text-[12px] leading-relaxed text-secondary-text whitespace-pre-wrap">
                {draft.final_sent_body ?? draft.ai_draft_body}
              </p>
              {draft.send_error && (
                <p className="text-[11px] text-[#8A1F1F] mt-2">Send error: {draft.send_error}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
