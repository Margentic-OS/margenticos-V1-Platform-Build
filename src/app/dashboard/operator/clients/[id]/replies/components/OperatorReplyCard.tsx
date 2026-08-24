'use client'

import type { OperatorVisibleReply } from '@/lib/reply-handling/get-client-visible-replies'

// Labels for all 8 intents (not just the 5 visible to clients)
const ALL_INTENT_LABELS: Record<string, string> = {
  positive_direct_booking: 'Ready to book',
  positive_passive: 'Interested',
  information_request_generic: 'Asking about details',
  information_request_commercial: 'Asking about pricing',
  objection_mild: 'Soft objection',
  opt_out: 'Opted out',
  out_of_office: 'Out of office',
  unclear: 'Unclear',
}

// Which intents are client-visible (green); which are hidden (orange/grey for operator view)
const CLIENT_VISIBLE_INTENTS = new Set([
  'positive_direct_booking',
  'positive_passive',
  'information_request_generic',
  'information_request_commercial',
  'objection_mild',
])

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

export function OperatorReplyCard({ reply }: { reply: OperatorVisibleReply }) {
  const prospectName = reply.prospect.first_name
    ? `${reply.prospect.first_name} ${reply.prospect.last_name || ''}`.trim()
    : reply.prospect.email || 'Unknown prospect'

  const company = reply.prospect.company_name || ''
  const label = ALL_INTENT_LABELS[reply.classified_intent] || reply.classified_intent
  const timeAgo = formatDate(reply.created_at)
  const isClientVisible = CLIENT_VISIBLE_INTENTS.has(reply.classified_intent)

  // Styling depends on visibility to clients
  const badgeClass = isClientVisible
    ? 'bg-light-green text-primary-text'
    : 'bg-[#F0ECE4] text-secondary-text'

  return (
    <div className="bg-white border border-[#E8E2D8] rounded-[10px] p-5">
      {/* Header: prospect info + label + visibility indicator */}
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
        <div className="flex items-center gap-2">
          <span className={`inline-block px-2 py-1 rounded text-[10px] font-medium whitespace-nowrap ${badgeClass}`}>
            {label}
          </span>
          {!isClientVisible && (
            <span className="text-[9px] text-secondary-text font-medium">
              Hidden
            </span>
          )}
        </div>
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

      {/* Footer: timestamp + action taken */}
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-secondary-text">
          {timeAgo}
        </p>
        {reply.action_taken && (
          <p className="text-[10px] text-secondary-text">
            Action: {reply.action_taken}
          </p>
        )}
      </div>
    </div>
  )
}
