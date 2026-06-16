'use client'

import type { ClientVisibleReply, ClientVisibleIntent } from '@/lib/reply-handling/get-client-visible-replies'

const INTENT_LABELS: Record<ClientVisibleIntent, string> = {
  positive_direct_booking: 'Ready to book',
  positive_passive: 'Interested',
  information_request_generic: 'Asking about details',
  information_request_commercial: 'Asking about pricing',
  objection_mild: 'Interested but hesitant',
}

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
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function ReplyCard({ reply }: { reply: ClientVisibleReply }) {
  const prospectName = reply.prospect.first_name
    ? `${reply.prospect.first_name} ${reply.prospect.last_name || ''}`.trim()
    : reply.prospect.email || 'Unknown prospect'

  const company = reply.prospect.company_name || ''
  const label = INTENT_LABELS[reply.classified_intent]
  const timeAgo = formatDate(reply.created_at)

  return (
    <div className="bg-white border border-[#E8E2D8] rounded-[10px] p-5">
      {/* Header: prospect info + label */}
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-medium text-primary-text">
            {prospectName}
          </p>
          {company && (
            <p className="text-[11px] text-secondary-text mt-0.5">
              {company}
            </p>
          )}
        </div>
        <span className="inline-block px-2 py-1 bg-light-green rounded text-[10px] text-primary-text font-medium whitespace-nowrap">
          {label}
        </span>
      </div>

      {/* Subject line */}
      {reply.reply_subject && (
        <p className="text-[11px] text-secondary-text mb-2">
          <span className="font-medium">Subject:</span> {reply.reply_subject}
        </p>
      )}

      {/* Reply snippet */}
      <p className="text-[12px] leading-relaxed text-primary-text mb-3 text-pretty">
        {reply.reply_body_snippet}
      </p>

      {/* Footer: timestamp */}
      <p className="text-[10px] text-secondary-text">
        {timeAgo}
      </p>
    </div>
  )
}
