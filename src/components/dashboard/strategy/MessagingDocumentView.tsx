'use client'

import { useState } from 'react'
import type { Json } from '@/types/database'

// New agent format: { emails: EmailRecord[] }
interface EmailRecord {
  sequence_position: number
  subject_line: string | null
  subject_char_count?: number
  body: string
  word_count: number
}

// Old agent format fallback (pre-current agent)
interface LegacyEmail {
  day?: number
  angle?: string
  framework?: string
  body?: string
  word_count?: number
  subject_line_options?: Array<{ subject_line: string; subject_char_count?: number }>
  subject_line?: string
}

interface MessagingContent {
  emails?: EmailRecord[]
  // Legacy format keys
  core_message?: Record<string, unknown>
  cold_email_sequence?: Record<string, LegacyEmail>
  messaging_playbook?: {
    cold_email_sequence?: Record<string, LegacyEmail>
    core_message?: Record<string, unknown>
  }
}

// ─── Email section labels ────────────────────────────────────────────────────

const EMAIL_SEQUENCE_LABELS: Record<number, string> = {
  1: 'First touch',
  2: 'Follow-up 1',
  3: 'Follow-up 2',
  4: 'Breakup',
}

// ─── Collapsible email section ────────────────────────────────────────────────

function EmailSection({ email, index }: { email: EmailRecord; index: number }) {
  const [open, setOpen] = useState(index === 0)

  const position = email.sequence_position ?? index + 1
  const seqLabel = EMAIL_SEQUENCE_LABELS[position] ?? `Email ${position}`
  const isThreaded = !email.subject_line

  return (
    <div className="border border-border-card rounded-[10px] overflow-hidden">
      {/* Header — always visible */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-start justify-between px-5 py-4 bg-surface-content hover:bg-[#EDE6D8] transition-colors text-left"
        aria-expanded={open}
      >
        <div className="flex flex-col gap-1 min-w-0 pr-4">
          <div className="flex items-center gap-2.5">
            <span className="text-[12px] font-medium text-text-primary">
              Email {position}
            </span>
            <span className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary">
              {seqLabel}
            </span>
            {isThreaded && (
              <span className="text-[10px] text-text-muted">· threads under Email 1</span>
            )}
          </div>
          {!open && email.subject_line && (
            <span className="text-[11px] text-text-secondary truncate">
              &ldquo;{email.subject_line}&rdquo;
            </span>
          )}
          {!open && !email.subject_line && email.body && (
            <span className="text-[11px] text-text-muted truncate">
              {email.body.split('\n')[0]?.slice(0, 80)}…
            </span>
          )}
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          <span className="text-[10px] text-text-muted tabular-nums">
            {email.word_count}w
          </span>
          <span className="text-[10px] text-text-muted">{open ? '▲' : '▼'}</span>
        </div>
      </button>

      {/* Expanded body */}
      {open && (
        <div className="px-5 pt-4 pb-5 space-y-4 bg-surface-card">
          {/* Subject line (Email 1 only) */}
          {email.subject_line && (
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary">
                  Subject line
                </p>
                {email.subject_char_count != null && email.subject_char_count > 0 && (
                  <span className="text-[10px] text-text-muted tabular-nums">
                    {email.subject_char_count} chars
                  </span>
                )}
              </div>
              <p className="text-[13px] font-medium text-text-primary leading-snug">
                {email.subject_line}
              </p>
            </div>
          )}

          {isThreaded && (
            <p className="text-[10px] text-text-muted italic">
              No separate subject — threads under Email 1 in the inbox.
            </p>
          )}

          {/* Body */}
          {email.body && (
            <div>
              <div className="flex items-baseline justify-between mb-2">
                <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary">
                  Body
                </p>
                <span className="text-[10px] text-text-muted tabular-nums">
                  {email.word_count} words
                </span>
              </div>
              <div className="bg-surface-content rounded-[8px] px-4 py-3.5">
                <p className="text-[12px] text-text-primary leading-[1.7] whitespace-pre-line">
                  {email.body}
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Legacy email section (old format fallback) ──────────────────────────────

function LegacyEmailSection({ label, email, index }: { label: string; email: LegacyEmail; index: number }) {
  const [open, setOpen] = useState(index === 0)

  const emailNum = label.replace('email_', 'Email ')
  const hasSubjectOptions = Array.isArray(email.subject_line_options) && email.subject_line_options.length > 0
  const firstSubject = hasSubjectOptions ? email.subject_line_options![0]?.subject_line : null
  const isThreaded = !hasSubjectOptions

  return (
    <div className="border border-border-card rounded-[10px] overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-start justify-between px-5 py-4 bg-surface-content hover:bg-[#EDE6D8] transition-colors text-left"
        aria-expanded={open}
      >
        <div className="flex flex-col gap-1 min-w-0 pr-4">
          <div className="flex items-center gap-2.5">
            <span className="text-[12px] font-medium text-text-primary">{emailNum}</span>
            {email.day !== undefined && (
              <span className="text-[10px] uppercase tracking-[0.07em] text-text-secondary">
                Day {email.day}
              </span>
            )}
            {isThreaded && (
              <span className="text-[10px] text-text-muted">· threads under Email 1</span>
            )}
          </div>
          {!open && (email.angle ?? email.framework) && (
            <span className="text-[11px] text-text-secondary truncate">
              {email.angle ?? email.framework}
            </span>
          )}
          {!open && firstSubject && (
            <span className="text-[11px] text-text-muted truncate">&ldquo;{firstSubject}&rdquo;</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {email.word_count != null && (
            <span className="text-[10px] text-text-muted tabular-nums">{email.word_count}w</span>
          )}
          <span className="text-[10px] text-text-muted">{open ? '▲' : '▼'}</span>
        </div>
      </button>

      {open && (
        <div className="px-5 pt-4 pb-5 space-y-4 bg-surface-card">
          {hasSubjectOptions && (
            <div>
              <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">
                Subject line options
              </p>
              <ul className="space-y-1.5">
                {email.subject_line_options!.map((opt, i) => (
                  <li key={i} className="flex items-baseline gap-2">
                    <span className="text-text-muted shrink-0">·</span>
                    <span className="text-[12px] text-text-primary">{opt.subject_line}</span>
                    {opt.subject_char_count != null && (
                      <span className="text-[10px] text-text-muted shrink-0">{opt.subject_char_count} chars</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {email.body && (
            <div>
              <div className="flex items-baseline justify-between mb-2">
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary">Body</p>
                {email.word_count != null && (
                  <span className="text-[10px] text-text-muted">{email.word_count} words</span>
                )}
              </div>
              <div className="bg-surface-content rounded-[8px] px-4 py-3.5">
                <p className="text-[12px] text-text-primary leading-[1.7] whitespace-pre-line">
                  {email.body}
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Core message block (legacy format) ──────────────────────────────────────

function CoreMessageBlock({ coreMessage }: { coreMessage: Record<string, unknown> }) {
  const who = coreMessage.who_specifically as string | undefined
  const outcome = (coreMessage.what_outcome_they_get ?? coreMessage.what_outcome) as string | undefined
  const how = coreMessage.how_this_firm_is_the_guide as string | undefined
  const spine = coreMessage.spine as string | undefined

  if (!who && !outcome && !how && !spine) return null

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-5 mb-5">
      <h3 className="text-[14px] font-medium text-text-primary border-l-[3px] border-brand-green pl-3 mb-4">
        Core message
      </h3>
      <div className="space-y-3.5">
        {who && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1">Who</p>
            <p className="text-[13px] text-text-primary leading-relaxed">{who}</p>
          </div>
        )}
        {outcome && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1">Outcome</p>
            <p className="text-[13px] text-text-primary leading-relaxed">{outcome}</p>
          </div>
        )}
        {how && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1">How</p>
            <p className="text-[13px] text-text-primary leading-relaxed">{how}</p>
          </div>
        )}
        {spine && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1">Spine</p>
            <p className="text-[13px] text-text-primary leading-relaxed italic">&ldquo;{spine}&rdquo;</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface MessagingDocumentViewProps {
  content: Json
}

export function MessagingDocumentView({ content }: MessagingDocumentViewProps) {
  const raw = content as MessagingContent

  // ADR-012: approve_document_suggestion unwraps { emails: [...] } and stores
  // the bare array as content. Normalise it before the object-based checks below.
  const directArray = Array.isArray(content) ? (content as unknown as EmailRecord[]) : null

  // Unwrap messaging_playbook wrapper if present (old format)
  const doc: MessagingContent = raw.messaging_playbook ?? raw

  // New format: { emails: [...] }
  const newFormatEmails = directArray ?? doc.emails

  // Old format: { cold_email_sequence: { email_1: {...}, ... } }
  const legacySequence = doc.cold_email_sequence
  const legacyEmailEntries = legacySequence
    ? Object.entries(legacySequence)
        .filter(([key]) => /^email_\d+/.test(key))
        .sort(([a], [b]) => {
          const n = (k: string) => parseInt(k.replace(/\D/g, ''), 10) || 0
          return n(a) - n(b)
        }) as [string, LegacyEmail][]
    : []

  const hasNewFormat = Array.isArray(newFormatEmails) && newFormatEmails.length > 0
  const hasLegacyFormat = legacyEmailEntries.length > 0

  if (!hasNewFormat && !hasLegacyFormat) {
    return (
      <div className="bg-surface-card border border-border-card rounded-[10px] p-6">
        <p className="text-[12px] text-text-secondary">
          Messaging document content is not in a recognised format. Contact support.
        </p>
      </div>
    )
  }

  if (hasNewFormat) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[14px] font-medium text-text-primary border-l-[3px] border-brand-green pl-3">
            Email sequence
          </h3>
          <span className="text-[11px] text-text-secondary">
            {newFormatEmails!.length} emails
          </span>
        </div>
        {newFormatEmails!.map((email, i) => (
          <EmailSection key={email.sequence_position ?? i} email={email} index={i} />
        ))}
      </div>
    )
  }

  // Legacy format
  return (
    <div className="space-y-5">
      {doc.core_message && (
        <CoreMessageBlock coreMessage={doc.core_message} />
      )}
      <div className="space-y-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[14px] font-medium text-text-primary border-l-[3px] border-brand-green pl-3">
            Email sequence
          </h3>
          <span className="text-[11px] text-text-secondary">
            {legacyEmailEntries.length} emails
          </span>
        </div>
        {legacyEmailEntries.map(([key, email], i) => (
          <LegacyEmailSection key={key} label={key} email={email} index={i} />
        ))}
      </div>
    </div>
  )
}
