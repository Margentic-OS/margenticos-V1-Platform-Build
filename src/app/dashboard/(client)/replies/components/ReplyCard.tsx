'use client'

import { useState } from 'react'
import type { ClientVisibleReply } from '@/lib/reply-handling/get-client-visible-replies'

// TWO badges. Never five.
//
// This card used to render one of five labels: "Ready to book", "Interested", "Asking
// about details", "Asking about pricing", "Interested but hesitant". Those are the five
// classifier intents wearing a friendly coat, and a client is never shown how we
// classified their prospect. The badge now comes from whether a meeting exists, which is
// a fact about the world rather than a judgement about a person.
const BADGE_LABELS: Record<ClientVisibleReply['badge'], string> = {
  interested: 'Interested',
  meeting_booked: 'Meeting booked',
}

function formatTimeAgo(isoString: string): string {
  const date = new Date(isoString)
  const diffMs = Date.now() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function formatSentAt(isoString: string): string {
  const date = new Date(isoString)
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatMeetingDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function ReplyCard({ reply }: { reply: ClientVisibleReply }) {
  // The prompting email is collapsed by default. It is context for reading the reply, not
  // the thing the client came to read.
  const [promptingOpen, setPromptingOpen] = useState(false)

  const { prospect } = reply
  const fullName = [prospect.first_name, prospect.last_name].filter(Boolean).join(' ').trim()
  const displayName = fullName || prospect.company_name || prospect.email || 'Prospect'

  // Title and company on one line, and the line disappears entirely rather than rendering
  // a stray separator when only one of them is known.
  //
  // The company is dropped from this line when it is already serving as the heading,
  // which happens for a prospect whose name we do not have. Printing it twice, once large
  // and once small, reads as a rendering fault.
  const companyInRoleLine = displayName === prospect.company_name ? null : prospect.company_name
  const roleLine = [prospect.job_title, companyInRoleLine].filter(Boolean).join(', ')

  const isMeeting = reply.badge === 'meeting_booked'

  return (
    <article className="bg-surface-card border border-border-card rounded-[10px] p-5">
      {/* Who replied, when, and what came of it */}
      <header className="flex items-start justify-between gap-4 mb-4">
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-text-primary">{displayName}</p>
          {roleLine && (
            <p className="text-[11px] text-text-secondary mt-0.5">{roleLine}</p>
          )}
          <p className="text-[10px] text-text-muted mt-1">
            Replied {formatTimeAgo(reply.received_at)}
          </p>
        </div>
        <span className={[
          'flex items-center gap-1.5 px-2 py-1 rounded-full shrink-0',
          isMeeting ? 'bg-[#EBF5E6]' : 'bg-[#F0ECE4]',
        ].join(' ')}>
          <span className={[
            'w-1.5 h-1.5 rounded-full',
            isMeeting ? 'bg-brand-green-success' : 'bg-brand-green-accent',
          ].join(' ')} />
          <span className={[
            'text-[10px] font-medium whitespace-nowrap',
            isMeeting ? 'text-brand-green-success' : 'text-text-primary',
          ].join(' ')}>
            {BADGE_LABELS[reply.badge]}
          </span>
        </span>
      </header>

      {/* Their reply, verbatim. Not summarised, not truncated, not paraphrased. */}
      <section className="mb-4">
        {reply.reply_subject && (
          <p className="text-[11px] text-text-secondary mb-1.5">
            <span className="font-medium">Subject:</span> {reply.reply_subject}
          </p>
        )}
        <blockquote className="border-l-2 border-border-card pl-3">
          <p className="text-[12px] leading-relaxed text-text-primary whitespace-pre-line text-pretty">
            {reply.reply_body || 'This reply arrived with no message body.'}
          </p>
        </blockquote>
      </section>

      {/* The email of ours that prompted it. Collapsed: context, not content. */}
      {reply.prompting_email && (
        <section className="mb-4">
          <button
            type="button"
            onClick={() => setPromptingOpen(o => !o)}
            aria-expanded={promptingOpen}
            className="flex items-center gap-1.5 text-[11px] text-text-secondary hover:text-text-primary transition-colors"
          >
            <svg
              width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true"
              className={promptingOpen ? 'rotate-90 transition-transform' : 'transition-transform'}
            >
              <path d="M2 1L6 4L2 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {promptingOpen ? 'Hide the email they replied to' : 'Show the email they replied to'}
          </button>
          {promptingOpen && (
            <div className="mt-2 bg-[#F7F4EE] rounded-[6px] p-3">
              <p className="text-[11px] leading-relaxed text-text-secondary whitespace-pre-line">
                {reply.prompting_email}
              </p>
            </div>
          )}
        </section>
      )}

      {/* What went out from their domain, in their founder's name. Read-only, and shown
          only once it has actually been sent. */}
      {reply.sent_on_their_behalf && (
        <section className="border-t border-border-card pt-4">
          <div className="flex items-baseline justify-between gap-3 mb-1.5">
            <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary">
              Sent on your behalf
            </p>
            <p className="text-[10px] text-text-muted shrink-0">
              {formatSentAt(reply.sent_on_their_behalf.sent_at)}
            </p>
          </div>
          <div className="bg-[#F1F5EE] rounded-[6px] p-3">
            <p className="text-[12px] leading-relaxed text-text-primary whitespace-pre-line text-pretty">
              {reply.sent_on_their_behalf.body}
            </p>
          </div>
        </section>
      )}

      {/* The meeting, when there is one. */}
      {isMeeting && (
        <section className="border-t border-border-card pt-3 mt-4">
          <p className="text-[11px] text-text-primary">
            {reply.meeting?.scheduled_for
              ? `Meeting booked for ${formatMeetingDate(reply.meeting.scheduled_for)}`
              : 'Meeting booked. The date is still being confirmed.'}
          </p>
          <p className="text-[10px] text-text-muted mt-0.5">
            Attendance is confirmed after the meeting date.
          </p>
        </section>
      )}
    </article>
  )
}
