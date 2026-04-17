'use client'

import { useState } from 'react'

// ─── Shared types ─────────────────────────────────────────────────────────────

export type PendingSuggestion = {
  id: string
  document_type: string
  field_path: string
  current_value: string | null
  suggested_value: string
  suggestion_reason: string | null
  organisations: { name: string } | { name: string }[] | null
}

// ─── Document-specific types ──────────────────────────────────────────────────

type EmailTemplate = {
  body?: string
  word_count?: number
  cta_type?: string
  trigger_filled?: string
}

type MessagingEmail = {
  day?: number
  framework?: string
  word_limit?: number
  subject_line_options?: string[]
  template?: EmailTemplate
  worked_example?: EmailTemplate
}

type MessagingDoc = {
  core_message?: {
    who_specifically?: string
    what_outcome?: string
    how_this_firm_is_the_guide?: string
  }
  cold_email_sequence?: Record<string, MessagingEmail>
  messaging_playbook?: MessagingDoc
}

type TovCharacteristic = {
  characteristic?: string
  description?: string
  evidence?: string
}

type TovDoc = {
  voice_summary?: string
  voice_characteristics?: TovCharacteristic[]
}

type CompetitiveAlternative = {
  name?: string
  buyer_reasoning?: string
  limitation?: string
}

type PositioningDoc = {
  positioning_summary?: string
  competitive_alternatives?: CompetitiveAlternative[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DOC_TYPE_LABELS: Record<string, string> = {
  icp: 'ICP',
  positioning: 'Positioning',
  tov: 'Tone of Voice',
  messaging: 'Messaging',
}

function formatFieldPath(path: string): string {
  if (path === 'full_document') return 'Full document'
  const segment = path.split('.').pop() ?? path
  const spaced = segment.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function getClientName(org: PendingSuggestion['organisations']): string {
  if (!org) return 'Unknown client'
  if (Array.isArray(org)) return org[0]?.name ?? 'Unknown client'
  return org.name
}

function parseSuggestedValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ─── Collapsible email section ────────────────────────────────────────────────

function EmailSection({ label, email }: { label: string; email: MessagingEmail }) {
  const [open, setOpen] = useState(false)
  const emailNum = label.replace('email_', 'Email ')
  const firstSubject = email.subject_line_options?.[0]

  return (
    <div className="border border-border-card rounded-[8px] overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-start justify-between px-4 py-3 bg-surface-content hover:bg-[#EDE6D8] transition-colors text-left"
      >
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-text-primary">{emailNum}</span>
            {email.day !== undefined && (
              <span className="text-[10px] uppercase tracking-[0.07em] text-text-secondary">
                Day {email.day}
              </span>
            )}
          </div>
          {email.framework && (
            <span className="text-[11px] text-text-secondary truncate">{email.framework}</span>
          )}
          {!open && firstSubject && (
            <span className="text-[11px] text-text-muted truncate">"{firstSubject}"</span>
          )}
        </div>
        <span className="text-text-muted text-[10px] shrink-0 mt-0.5 ml-3">
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div className="px-4 pt-3 pb-4 space-y-4 bg-surface-card">
          {/* Subject lines */}
          {(email.subject_line_options ?? []).length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1.5">
                Subject line options
              </p>
              <ul className="space-y-1">
                {email.subject_line_options!.map((s, i) => (
                  <li key={i} className="text-xs text-text-primary">
                    <span className="text-text-muted mr-1.5">·</span>{s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Template body */}
          {email.template?.body && (
            <div>
              <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1.5">
                Template
              </p>
              <p className="text-xs text-text-primary leading-relaxed whitespace-pre-line bg-surface-content rounded-[6px] px-3 py-2.5">
                {email.template.body}
              </p>
              {email.template.word_count && (
                <p className="text-[10px] text-text-muted mt-1">{email.template.word_count} words · {email.template.cta_type ?? ''} CTA</p>
              )}
            </div>
          )}

          {/* Worked example */}
          {email.worked_example?.body && (
            <div>
              <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1.5">
                Worked example
              </p>
              <p className="text-xs text-text-secondary leading-relaxed whitespace-pre-line bg-surface-content rounded-[6px] px-3 py-2.5">
                {email.worked_example.body}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Document renderers ───────────────────────────────────────────────────────

function renderMessaging(parsed: unknown) {
  const raw = parsed as MessagingDoc
  // Handle optional messaging_playbook wrapper
  const doc: MessagingDoc = raw.messaging_playbook ?? raw
  const { core_message, cold_email_sequence } = doc

  const emailEntries = Object.entries(cold_email_sequence ?? {}).sort(([a], [b]) => {
    const n = (k: string) => parseInt(k.replace(/\D/g, ''), 10) || 0
    return n(a) - n(b)
  })

  return (
    <div className="space-y-5">
      {/* Core message */}
      {core_message && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">
            Core message
          </p>
          <div className="space-y-3">
            {core_message.who_specifically && (
              <div>
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Who</p>
                <p className="text-xs text-text-primary leading-relaxed">{core_message.who_specifically}</p>
              </div>
            )}
            {core_message.what_outcome && (
              <div>
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Outcome</p>
                <p className="text-xs text-text-primary leading-relaxed">{core_message.what_outcome}</p>
              </div>
            )}
            {core_message.how_this_firm_is_the_guide && (
              <div>
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">How</p>
                <p className="text-xs text-text-primary leading-relaxed">{core_message.how_this_firm_is_the_guide}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Email sequence */}
      {emailEntries.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">
            Email sequence · {emailEntries.length} emails
          </p>
          <div className="space-y-2">
            {emailEntries.map(([key, email]) => (
              <EmailSection key={key} label={key} email={email} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function renderTov(parsed: unknown) {
  const doc = parsed as TovDoc

  return (
    <div className="space-y-5">
      {/* Voice summary */}
      {doc.voice_summary && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">
            Voice summary
          </p>
          <p className="text-xs text-text-primary leading-relaxed">{doc.voice_summary}</p>
        </div>
      )}

      {/* Voice characteristics */}
      {(doc.voice_characteristics ?? []).length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">
            Voice characteristics · {doc.voice_characteristics!.length}
          </p>
          <div className="space-y-3">
            {doc.voice_characteristics!.map((c, i) => (
              <div key={i} className="bg-surface-content rounded-[6px] px-3 py-2.5">
                {c.characteristic && (
                  <p className="text-xs font-medium text-text-primary mb-1">{c.characteristic}</p>
                )}
                {c.description && (
                  <p className="text-xs text-text-secondary leading-relaxed mb-1.5">{c.description}</p>
                )}
                {c.evidence && (
                  <p className="text-[11px] text-text-muted italic leading-relaxed">{c.evidence}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function renderPositioning(parsed: unknown) {
  const doc = parsed as PositioningDoc

  return (
    <div className="space-y-5">
      {/* Positioning summary */}
      {doc.positioning_summary && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">
            Positioning summary
          </p>
          <p className="text-xs text-text-primary leading-relaxed">{doc.positioning_summary}</p>
        </div>
      )}

      {/* Competitive alternatives */}
      {(doc.competitive_alternatives ?? []).length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">
            Competitive alternatives · {doc.competitive_alternatives!.length}
          </p>
          <div className="space-y-2">
            {doc.competitive_alternatives!.map((alt, i) => (
              <div key={i} className="bg-surface-content rounded-[6px] px-3 py-2.5">
                {alt.name && (
                  <p className="text-xs font-medium text-text-primary mb-1">{alt.name}</p>
                )}
                {alt.buyer_reasoning && (
                  <p className="text-xs text-text-secondary leading-relaxed mb-1">{alt.buyer_reasoning}</p>
                )}
                {alt.limitation && (
                  <p className="text-[11px] text-[#8B2020] leading-relaxed">{alt.limitation}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function renderGeneric(parsed: unknown, raw: string) {
  // Flat string or unparseable — just render as text
  if (parsed === null) {
    return <p className="text-xs text-text-primary leading-relaxed whitespace-pre-line">{raw}</p>
  }

  // Simple string value after parse (e.g. a JSON-encoded string)
  if (typeof parsed === 'string') {
    return <p className="text-xs text-text-primary leading-relaxed">{parsed}</p>
  }

  // Object — render top-level string fields as labelled blocks
  if (typeof parsed === 'object' && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      ([, v]) => typeof v === 'string' || typeof v === 'number'
    )
    if (entries.length > 0) {
      return (
        <div className="space-y-3">
          {entries.map(([key, val]) => (
            <div key={key}>
              <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1">
                {key.replace(/_/g, ' ')}
              </p>
              <p className="text-xs text-text-primary leading-relaxed">{String(val)}</p>
            </div>
          ))}
        </div>
      )
    }
  }

  // Fallback: something complex we didn't anticipate — show a neutral message
  return (
    <p className="text-xs text-text-secondary italic">
      Content generated — approve to apply it to the strategy document.
    </p>
  )
}

function renderSuggestedContent(docType: string, raw: string) {
  const parsed = parseSuggestedValue(raw)

  if (docType === 'messaging') return renderMessaging(parsed)
  if (docType === 'tov') return renderTov(parsed)
  if (docType === 'positioning') return renderPositioning(parsed)

  return renderGeneric(parsed, raw)
}

// ─── Main component ───────────────────────────────────────────────────────────

type Props = {
  suggestion: PendingSuggestion
  onResolved: (id: string) => void
}

export default function ApprovalCard({ suggestion, onResolved }: Props) {
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleAction(action: 'approve' | 'reject') {
    setLoading(action)
    setError(null)

    const res = await fetch(`/api/suggestions/${suggestion.id}/${action}`, { method: 'POST' })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError((body as { error?: string }).error ?? 'Something went wrong. Try again.')
      setLoading(null)
      return
    }

    onResolved(suggestion.id)
  }

  const docLabel = DOC_TYPE_LABELS[suggestion.document_type] ?? suggestion.document_type
  const fieldLabel = formatFieldPath(suggestion.field_path)
  const clientName = getClientName(suggestion.organisations)
  const isFullDocument = suggestion.field_path === 'full_document'
  const isLoading = loading !== null

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] overflow-hidden">
      {/* Card header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border-card">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center px-2 py-0.5 rounded-[4px] bg-[#EAF3DE] text-[#3B6D11] text-[10px] font-medium">
            {docLabel}
          </span>
          <span className="text-[13px] font-medium text-text-primary">{fieldLabel}</span>
        </div>
        <span className="text-[10px] uppercase tracking-[0.07em] text-text-secondary">
          {clientName}
        </span>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Agent reasoning */}
        {suggestion.suggestion_reason && (
          <div className="bg-[#FEF7E6] border border-[#F0D080] rounded-[6px] px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.07em] text-[#7A4800] mb-1">Agent reasoning</p>
            <p className="text-xs text-[#7A4800] leading-relaxed">{suggestion.suggestion_reason}</p>
          </div>
        )}

        {/* Before/after for field-level suggestions */}
        {!isFullDocument && suggestion.current_value && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1.5">Current</p>
              <p className="text-xs text-text-secondary leading-relaxed">{suggestion.current_value}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1.5">Suggested</p>
              <div className="text-xs text-text-primary leading-relaxed">
                {renderSuggestedContent(suggestion.document_type, suggestion.suggested_value)}
              </div>
            </div>
          </div>
        )}

        {/* Full document content */}
        {(isFullDocument || !suggestion.current_value) && (
          <div>
            {suggestion.current_value && (
              <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">
                Replacing existing document
              </p>
            )}
            {renderSuggestedContent(suggestion.document_type, suggestion.suggested_value)}
          </div>
        )}

        {/* Error */}
        {error && (
          <p className="text-xs text-[#8B2020] bg-[#FDEEE8] border border-[#EFBCAA] rounded-[6px] px-3 py-2">
            {error}
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={() => handleAction('reject')}
            disabled={isLoading}
            className="flex-1 py-2.5 rounded-full text-sm font-medium text-text-primary border border-border-card hover:bg-[#FDEEE8] hover:border-[#EFBCAA] hover:text-[#8B2020] disabled:opacity-40 transition-colors"
          >
            {loading === 'reject' ? 'Rejecting…' : 'Reject'}
          </button>
          <button
            onClick={() => handleAction('approve')}
            disabled={isLoading}
            className="flex-1 py-2.5 rounded-full text-sm font-medium text-white bg-brand-green hover:bg-[#152e21] disabled:opacity-40 transition-colors"
          >
            {loading === 'approve' ? 'Approving…' : 'Approve →'}
          </button>
        </div>
      </div>
    </div>
  )
}
