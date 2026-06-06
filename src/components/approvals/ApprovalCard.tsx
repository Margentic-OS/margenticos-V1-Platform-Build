'use client'

import { useState } from 'react'

// ─── Shared types ─────────────────────────────────────────────────────────────

export type PendingSuggestion = {
  id: string
  organisation_id: string
  document_type: string
  field_path: string
  current_value: string | null
  suggested_value: string
  suggestion_reason: string | null
  created_at: string | null
  organisations: { name: string } | { name: string }[] | null
}

// ─── Document-specific types ──────────────────────────────────────────────────

// Subject line can be a plain string or an object with metadata
type SubjectLineOption = {
  subject_line: string
  subject_char_count?: number
  format_type?: string
  note?: string
}

type MessagingEmail = {
  day?: number
  angle?: string        // newer format
  framework?: string    // older format fallback
  body?: string
  word_count?: number
  // Email 1: subject_line_options is an array of objects
  subject_line_options?: SubjectLineOption[]
  // Email 2+: threaded, subject_line is a direct empty string
  subject_line?: string
}

type SequenceOverview = {
  total_emails?: number
  cadence?: string
  send_window?: string
  threading_rules?: string
}

type MessagingColdEmailSequence = {
  sequence_overview?: SequenceOverview
  [key: string]: MessagingEmail | SequenceOverview | undefined
}

type MessagingCoreMessage = {
  who_specifically?: string
  what_outcome?: string           // older format
  what_outcome_they_get?: string  // newer format
  how_this_firm_is_the_guide?: string
  spine?: string
}

type MessagingDoc = {
  core_message?: MessagingCoreMessage
  cold_email_sequence?: MessagingColdEmailSequence
  messaging_playbook?: MessagingDoc  // wrapper present on some generations
}

type TovCharacteristic = {
  characteristic?: string
  description?: string
  evidence?: string
}

type DoDontItem = {
  do?: string
  dont?: string
}

type VocabularyDoc = {
  preferred?: string[]
  avoid?: string[]
}

type BeforeAfterExample = {
  before?: string
  after?: string
  note?: string
}

type SentenceMechanics = {
  avg_sentence_length?: string
  punctuation_rules?: string
  paragraph_length?: string
}

type TovDoc = {
  voice_summary?: string
  voice_style_note?: string
  voice_characteristics?: TovCharacteristic[]
  do_dont_list?: DoDontItem[]
  vocabulary?: VocabularyDoc
  writing_rules?: string[]
  what_this_voice_never_does?: string[]
  before_after_examples?: BeforeAfterExample[]
  sentence_mechanics?: SentenceMechanics
}

type CompetitiveAlternative = {
  name?: string
  buyer_reasoning?: string
  limitation?: string
}

type ValueTheme = {
  theme?: string
  proof_points?: string[]
}

type KeyMessage = {
  audience?: string
  message?: string
  proof_point?: string
}

type PositioningDoc = {
  positioning_summary?: string
  moore_positioning?: string
  market_category?: string
  unique_attributes?: string[]
  value_themes?: ValueTheme[]
  competitive_alternatives?: CompetitiveAlternative[]
  key_messages?: KeyMessage[]
  best_fit_characteristics?: string[]
  competitive_landscape?: string
}

type IcpTier = {
  tier?: string
  firmographics?: string
  industry_focus?: string
  company_size?: string
  job_titles?: string[]
  pain_indicators?: string[]
  growth_signals?: string[]
  tech_signals?: string[]
  psychographics?: string
  why_now?: string
  disqualifiers?: string[]
}

type IcpDoc = {
  icp_summary?: string
  positioning_note?: string
  tiers?: IcpTier[]
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

// Amendment 7: renders any field not explicitly handled by a typed renderer as key: value.
function renderUnknownFields(obj: Record<string, unknown>, handledKeys: Set<string>) {
  function fmtVal(val: unknown): string {
    if (val === null || val === undefined) return ''
    if (typeof val === 'string') return val
    if (typeof val === 'number' || typeof val === 'boolean') return String(val)
    if (Array.isArray(val)) return val.map(fmtVal).filter(Boolean).join(', ')
    return JSON.stringify(val)
  }

  const entries = Object.entries(obj)
    .filter(([k]) => !handledKeys.has(k))
    .map(([k, v]) => [k, fmtVal(v)] as const)
    .filter(([, v]) => v)

  if (entries.length === 0) return null

  return (
    <div className="space-y-3 pt-2 border-t border-border-card">
      {entries.map(([key, val]) => (
        <div key={key}>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">
            {key.replace(/_/g, ' ')}
          </p>
          <p className="text-xs text-text-secondary leading-relaxed">{val}</p>
        </div>
      ))}
    </div>
  )
}

// Extracts a plain string from a subject_line_option (object or legacy string)
function extractSubjectLine(opt: SubjectLineOption | unknown): string {
  if (typeof opt === 'string') return opt
  if (typeof opt === 'object' && opt !== null && 'subject_line' in opt) {
    return String((opt as SubjectLineOption).subject_line)
  }
  return ''
}

function extractCharCount(opt: SubjectLineOption | unknown): number | null {
  if (typeof opt === 'object' && opt !== null && 'subject_char_count' in opt) {
    const n = (opt as SubjectLineOption).subject_char_count
    return typeof n === 'number' ? n : null
  }
  return null
}

// ─── Collapsible email section ────────────────────────────────────────────────

function EmailSection({ label, email }: { label: string; email: MessagingEmail }) {
  const [open, setOpen] = useState(false)

  const emailNum = label.replace('email_', 'Email ')
  const angle = email.angle ?? email.framework ?? ''

  const hasSubjectOptions =
    Array.isArray(email.subject_line_options) && email.subject_line_options.length > 0

  // For threaded emails (email 2+), subject_line is a direct empty string
  const isThreaded = !hasSubjectOptions

  const previewSubject = hasSubjectOptions
    ? extractSubjectLine(email.subject_line_options![0])
    : null

  return (
    <div className="border border-border-card rounded-[8px] overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-start justify-between px-4 py-3 bg-surface-content hover:bg-[#EDE6D8] transition-colors text-left"
      >
        <div className="flex flex-col gap-0.5 min-w-0 pr-3">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-text-primary">{emailNum}</span>
            {email.day !== undefined && (
              <span className="text-[10px] uppercase tracking-[0.07em] text-text-secondary">
                Day {email.day}
              </span>
            )}
            {isThreaded && (
              <span className="text-[10px] text-text-muted">Threads under email 1</span>
            )}
          </div>
          {angle && (
            <span className="text-[11px] text-text-secondary truncate">{angle}</span>
          )}
          {!open && previewSubject && (
            <span className="text-[11px] text-text-muted truncate">"{previewSubject}"</span>
          )}
        </div>
        <span className="text-text-muted text-[10px] shrink-0 mt-0.5">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-4 pt-3 pb-4 space-y-4 bg-surface-card">
          {/* Subject line options (email 1 — array of objects) */}
          {hasSubjectOptions && (
            <div>
              <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1.5">
                Subject line options
              </p>
              <ul className="space-y-1.5">
                {email.subject_line_options!.map((opt, i) => {
                  const text = extractSubjectLine(opt)
                  const chars = extractCharCount(opt)
                  if (!text) return null
                  return (
                    <li key={i} className="flex items-baseline gap-2">
                      <span className="text-text-muted shrink-0">·</span>
                      <span className="text-xs text-text-primary">{text}</span>
                      {chars !== null && (
                        <span className="text-[10px] text-text-muted shrink-0">{chars} chars</span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {/* Body */}
          {email.body && (
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary">Body</p>
                {email.word_count && (
                  <span className="text-[10px] text-text-muted">{email.word_count} words</span>
                )}
              </div>
              <p className="text-xs text-text-primary leading-relaxed whitespace-pre-line bg-surface-content rounded-[6px] px-3 py-2.5">
                {email.body}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── ICP tier card ────────────────────────────────────────────────────────────

function IcpTierCard({ tier }: { tier: IcpTier }) {
  const listFields = [
    { label: 'Job titles', items: tier.job_titles ?? [] },
    { label: 'Pain indicators', items: tier.pain_indicators ?? [] },
    { label: 'Growth signals', items: tier.growth_signals ?? [] },
    { label: 'Tech signals', items: tier.tech_signals ?? [] },
    { label: 'Disqualifiers', items: tier.disqualifiers ?? [] },
  ].filter(f => f.items.length > 0)

  return (
    <div className="bg-surface-content rounded-[8px] px-3 py-3 space-y-2.5">
      {tier.tier && (
        <p className="text-xs font-medium text-text-primary">{tier.tier}</p>
      )}
      {tier.firmographics && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Firmographics</p>
          <p className="text-xs text-text-secondary leading-relaxed">{tier.firmographics}</p>
        </div>
      )}
      {tier.industry_focus && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Industry</p>
          <p className="text-xs text-text-secondary leading-relaxed">{tier.industry_focus}</p>
        </div>
      )}
      {tier.company_size && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Company size</p>
          <p className="text-xs text-text-secondary leading-relaxed">{tier.company_size}</p>
        </div>
      )}
      {listFields.map(({ label, items }) => (
        <div key={label}>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">{label}</p>
          <ul className="space-y-0.5">
            {items.map((item, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-text-secondary leading-relaxed">
                <span className="shrink-0 text-text-muted">·</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {tier.psychographics && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Psychographics</p>
          <p className="text-xs text-text-secondary leading-relaxed">{tier.psychographics}</p>
        </div>
      )}
      {tier.why_now && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Why now</p>
          <p className="text-xs text-text-secondary leading-relaxed">{tier.why_now}</p>
        </div>
      )}
    </div>
  )
}

// ─── Document renderers ───────────────────────────────────────────────────────

// New agent format: flat emails array with sequence_position, subject_line, body, word_count
type MessagingEmailNew = {
  sequence_position: number
  subject_line: string | null
  subject_char_count: number
  body: string
  word_count: number
}

// Four-variant format: { variants: { A: { emails: [...] }, B: {...}, C: {...}, D: {...} } }
type FourVariantDoc = {
  variants: Record<string, { emails: MessagingEmailNew[] }>
}

function renderMessagingNew(emails: MessagingEmailNew[]) {
  const sorted = [...emails].sort((a, b) => a.sequence_position - b.sequence_position)

  return (
    <div className="space-y-4">
      <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary">
        Email sequence · {sorted.length} emails
      </p>
      <div className="space-y-4">
        {sorted.map(email => (
          <div
            key={email.sequence_position}
            className="border border-[#E8E2D8] rounded-[10px] overflow-hidden"
          >
            {/* Email header */}
            <div className="flex items-center justify-between px-4 py-3 bg-surface-content">
              <span className="text-[12px] font-medium text-text-primary">
                Email {email.sequence_position}
              </span>
              <span className="text-[10px] text-[#C8C3B8]">{email.word_count} words</span>
            </div>

            <div className="px-4 pt-3 pb-4 space-y-3 bg-surface-card">
              {/* Subject line */}
              <div>
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1">
                  Subject
                </p>
                {email.subject_line ? (
                  <p className="text-xs font-mono text-text-primary bg-surface-content rounded-[4px] px-2 py-1 inline-block">
                    {email.subject_line}
                  </p>
                ) : (
                  <p className="text-xs text-[#9A9488] italic">threaded — no subject</p>
                )}
              </div>

              {/* Body */}
              <div>
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1.5">
                  Body
                </p>
                <p className="text-xs text-text-primary leading-relaxed whitespace-pre-wrap bg-surface-content rounded-[6px] px-3 py-2.5">
                  {email.body}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// Four-variant tab renderer (ADR-014 Option E).
// Tabs labelled A / B / C / D — active tab shows that variant's 4 emails.
// Approve/Reject act on the whole suggestion, not individual variants.
function MessagingVariantsRenderer({ doc }: { doc: FourVariantDoc }) {
  const variantKeys = Object.keys(doc.variants).sort()
  const [activeVariant, setActiveVariant] = useState(variantKeys[0] ?? 'A')

  const activeEmails = doc.variants[activeVariant]?.emails ?? []

  return (
    <div className="space-y-4">
      {/* Eyebrow + tab row */}
      <div>
        <p className="text-[10px] uppercase tracking-[0.07em] text-[#9A9488] mb-2">
          Sequence variants · {variantKeys.length} options
        </p>
        <div className="flex gap-2 flex-wrap">
          {variantKeys.map(key => (
            <button
              key={key}
              onClick={() => setActiveVariant(key)}
              className={[
                'px-3 py-1.5 rounded-[6px] text-[11px] font-medium transition-colors',
                activeVariant === key
                  ? 'bg-[#1C3A2A] text-[#F5F0E8]'
                  : 'bg-[#F8F4EE] border border-[#E8E2D8] text-[#9A9488] hover:text-[#1A1916]',
              ].join(' ')}
            >
              Variant {key}
            </button>
          ))}
        </div>
      </div>

      {/* Active variant's emails */}
      {renderMessagingNew(activeEmails)}
    </div>
  )
}

function renderMessaging(parsed: unknown) {
  // Four-variant format (ADR-014): { variants: { A: { emails: [...] }, B: {...}, ... } }
  const asFourVariant = parsed as { variants?: Record<string, { emails: MessagingEmailNew[] }> }
  if (
    asFourVariant?.variants &&
    typeof asFourVariant.variants === 'object' &&
    Object.keys(asFourVariant.variants).length > 0
  ) {
    return <MessagingVariantsRenderer doc={asFourVariant as FourVariantDoc} />
  }

  // Single-sequence new agent format: { emails: [...] }
  const asNew = parsed as { emails?: MessagingEmailNew[] }
  if (Array.isArray(asNew?.emails) && asNew.emails.length > 0) {
    return renderMessagingNew(asNew.emails)
  }

  // Old format path — unchanged
  const raw = parsed as MessagingDoc
  // Unwrap messaging_playbook wrapper if present
  const doc: MessagingDoc = raw.messaging_playbook ?? raw
  const { core_message, cold_email_sequence } = doc

  // Filter to email_N keys only — skip sequence_overview and any other metadata
  const emailEntries = Object.entries(cold_email_sequence ?? {})
    .filter(([key]) => /^email_\d+/.test(key))
    .sort(([a], [b]) => {
      const n = (k: string) => parseInt(k.replace(/\D/g, ''), 10) || 0
      return n(a) - n(b)
    }) as [string, MessagingEmail][]

  const outcome = core_message?.what_outcome_they_get ?? core_message?.what_outcome

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
                <p className="text-xs text-text-primary leading-relaxed">
                  {core_message.who_specifically}
                </p>
              </div>
            )}
            {outcome && (
              <div>
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Outcome</p>
                <p className="text-xs text-text-primary leading-relaxed">{outcome}</p>
              </div>
            )}
            {core_message.how_this_firm_is_the_guide && (
              <div>
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">How</p>
                <p className="text-xs text-text-primary leading-relaxed">
                  {core_message.how_this_firm_is_the_guide}
                </p>
              </div>
            )}
            {core_message.spine && (
              <div>
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Spine</p>
                <p className="text-xs text-text-primary leading-relaxed italic">
                  "{core_message.spine}"
                </p>
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
  const handledKeys = new Set([
    'voice_summary', 'voice_style_note', 'voice_characteristics',
    'do_dont_list', 'vocabulary', 'writing_rules', 'what_this_voice_never_does',
    'before_after_examples', 'sentence_mechanics',
  ])

  return (
    <div className="space-y-5">
      {doc.voice_summary && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Voice summary</p>
          <p className="text-xs text-text-primary leading-relaxed">{doc.voice_summary}</p>
        </div>
      )}

      {doc.voice_style_note && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Voice style note</p>
          <p className="text-xs text-text-primary leading-relaxed">{doc.voice_style_note}</p>
        </div>
      )}

      {(doc.voice_characteristics ?? []).length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">
            Voice characteristics · {doc.voice_characteristics!.length}
          </p>
          <div className="space-y-2">
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

      {(doc.do_dont_list ?? []).length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Do / Don't</p>
          <div className="space-y-1.5">
            {doc.do_dont_list!.map((item, i) => (
              <div key={i} className="grid grid-cols-2 gap-3">
                {item.do && (
                  <div className="bg-[#EAF3DE] rounded-[6px] px-2.5 py-2">
                    <p className="text-[10px] uppercase tracking-[0.07em] text-[#3B6D11] mb-0.5">Do</p>
                    <p className="text-xs text-[#3B6D11] leading-relaxed">{item.do}</p>
                  </div>
                )}
                {item.dont && (
                  <div className="bg-[#FDEEE8] rounded-[6px] px-2.5 py-2">
                    <p className="text-[10px] uppercase tracking-[0.07em] text-[#8B2020] mb-0.5">Don't</p>
                    <p className="text-xs text-[#8B2020] leading-relaxed">{item.dont}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {doc.vocabulary && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Vocabulary</p>
          <div className="grid grid-cols-2 gap-3">
            {(doc.vocabulary.preferred?.length ?? 0) > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-[0.07em] text-[#3B6D11] mb-1.5">Preferred</p>
                <div className="flex flex-wrap gap-1.5">
                  {doc.vocabulary.preferred!.map((w, i) => (
                    <span key={i} className="text-[11px] bg-[#EAF3DE] text-[#3B6D11] rounded-[4px] px-2 py-0.5">{w}</span>
                  ))}
                </div>
              </div>
            )}
            {(doc.vocabulary.avoid?.length ?? 0) > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-[0.07em] text-[#8B2020] mb-1.5">Avoid</p>
                <div className="flex flex-wrap gap-1.5">
                  {doc.vocabulary.avoid!.map((w, i) => (
                    <span key={i} className="text-[11px] bg-[#FDEEE8] text-[#8B2020] rounded-[4px] px-2 py-0.5">{w}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {(doc.writing_rules ?? []).length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Writing rules</p>
          <ul className="space-y-1">
            {doc.writing_rules!.map((rule, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-text-primary leading-relaxed">
                <span className="shrink-0 text-text-muted mt-0.5">·</span>
                {rule}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(doc.what_this_voice_never_does ?? []).length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">What this voice never does</p>
          <ul className="space-y-1">
            {doc.what_this_voice_never_does!.map((item, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-[#8B2020] leading-relaxed">
                <span className="shrink-0 text-[#8B2020] mt-0.5">·</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(doc.before_after_examples ?? []).length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Before / After examples</p>
          <div className="space-y-3">
            {doc.before_after_examples!.map((ex, i) => (
              <div key={i} className="space-y-1.5">
                {ex.before && (
                  <div className="bg-[#FDEEE8] rounded-[6px] px-3 py-2">
                    <p className="text-[10px] uppercase tracking-[0.07em] text-[#8B2020] mb-0.5">Before</p>
                    <p className="text-xs text-[#8B2020] leading-relaxed italic">"{ex.before}"</p>
                  </div>
                )}
                {ex.after && (
                  <div className="bg-[#EAF3DE] rounded-[6px] px-3 py-2">
                    <p className="text-[10px] uppercase tracking-[0.07em] text-[#3B6D11] mb-0.5">After</p>
                    <p className="text-xs text-[#3B6D11] leading-relaxed italic">"{ex.after}"</p>
                  </div>
                )}
                {ex.note && (
                  <p className="text-[11px] text-text-muted italic px-1">{ex.note}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {doc.sentence_mechanics && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Sentence mechanics</p>
          <div className="bg-surface-content rounded-[6px] px-3 py-2.5 space-y-2">
            {doc.sentence_mechanics.avg_sentence_length && (
              <div>
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-0.5">Avg sentence length</p>
                <p className="text-xs text-text-primary">{doc.sentence_mechanics.avg_sentence_length}</p>
              </div>
            )}
            {doc.sentence_mechanics.punctuation_rules && (
              <div>
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-0.5">Punctuation rules</p>
                <p className="text-xs text-text-primary">{doc.sentence_mechanics.punctuation_rules}</p>
              </div>
            )}
            {doc.sentence_mechanics.paragraph_length && (
              <div>
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-0.5">Paragraph length</p>
                <p className="text-xs text-text-primary">{doc.sentence_mechanics.paragraph_length}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {renderUnknownFields(doc as Record<string, unknown>, handledKeys)}
    </div>
  )
}

function renderPositioning(parsed: unknown) {
  const doc = parsed as PositioningDoc
  const handledKeys = new Set([
    'positioning_summary', 'moore_positioning', 'market_category', 'unique_attributes',
    'value_themes', 'competitive_alternatives', 'key_messages', 'best_fit_characteristics',
    'competitive_landscape',
  ])

  return (
    <div className="space-y-5">
      {doc.positioning_summary && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Positioning summary</p>
          <p className="text-xs text-text-primary leading-relaxed">{doc.positioning_summary}</p>
        </div>
      )}

      {doc.moore_positioning && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Geoffrey Moore statement</p>
          <p className="text-xs text-text-primary leading-relaxed italic bg-surface-content rounded-[6px] px-3 py-2.5">
            {doc.moore_positioning}
          </p>
        </div>
      )}

      {doc.market_category && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Market category</p>
          <p className="text-xs text-text-primary">{doc.market_category}</p>
        </div>
      )}

      {(doc.unique_attributes ?? []).length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Unique attributes</p>
          <ul className="space-y-1">
            {doc.unique_attributes!.map((attr, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-text-primary leading-relaxed">
                <span className="shrink-0 text-text-muted mt-0.5">·</span>
                {attr}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(doc.value_themes ?? []).length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">
            Value themes · {doc.value_themes!.length}
          </p>
          <div className="space-y-2">
            {doc.value_themes!.map((theme, i) => (
              <div key={i} className="bg-surface-content rounded-[6px] px-3 py-2.5">
                {theme.theme && (
                  <p className="text-xs font-medium text-text-primary mb-1">{theme.theme}</p>
                )}
                {(theme.proof_points ?? []).length > 0 && (
                  <ul className="space-y-0.5">
                    {theme.proof_points!.map((pp, j) => (
                      <li key={j} className="flex items-start gap-1.5 text-xs text-text-secondary leading-relaxed">
                        <span className="shrink-0 text-text-muted">·</span>
                        {pp}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

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

      {(doc.key_messages ?? []).length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">
            Key messages · {doc.key_messages!.length}
          </p>
          <div className="space-y-2">
            {doc.key_messages!.map((msg, i) => (
              <div key={i} className="bg-surface-content rounded-[6px] px-3 py-2.5">
                {msg.audience && (
                  <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">{msg.audience}</p>
                )}
                {msg.message && (
                  <p className="text-xs text-text-primary leading-relaxed mb-1">{msg.message}</p>
                )}
                {msg.proof_point && (
                  <p className="text-[11px] text-text-secondary italic leading-relaxed">{msg.proof_point}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {(doc.best_fit_characteristics ?? []).length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Best fit characteristics</p>
          <ul className="space-y-1">
            {doc.best_fit_characteristics!.map((char, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-text-primary leading-relaxed">
                <span className="shrink-0 text-text-muted mt-0.5">·</span>
                {char}
              </li>
            ))}
          </ul>
        </div>
      )}

      {doc.competitive_landscape && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Competitive landscape</p>
          <p className="text-xs text-text-primary leading-relaxed">{doc.competitive_landscape}</p>
        </div>
      )}

      {renderUnknownFields(doc as Record<string, unknown>, handledKeys)}
    </div>
  )
}

function renderIcp(parsed: unknown) {
  const doc = parsed as IcpDoc
  const handledKeys = new Set(['icp_summary', 'positioning_note', 'tiers'])

  return (
    <div className="space-y-5">
      {doc.icp_summary && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">ICP summary</p>
          <p className="text-xs text-text-primary leading-relaxed">{doc.icp_summary}</p>
        </div>
      )}

      {(doc.tiers ?? []).length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">
            Tiers · {doc.tiers!.length}
          </p>
          <div className="space-y-3">
            {doc.tiers!.map((tier, i) => (
              <IcpTierCard key={i} tier={tier} />
            ))}
          </div>
        </div>
      )}

      {doc.positioning_note && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Positioning note</p>
          <p className="text-xs text-text-primary leading-relaxed italic">{doc.positioning_note}</p>
        </div>
      )}

      {renderUnknownFields(doc as Record<string, unknown>, handledKeys)}
    </div>
  )
}

function renderGeneric(parsed: unknown, raw: string) {
  if (parsed === null) {
    return <p className="text-xs text-text-primary leading-relaxed whitespace-pre-line">{raw}</p>
  }
  if (typeof parsed === 'string') {
    return <p className="text-xs text-text-primary leading-relaxed">{parsed}</p>
  }
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
  if (docType === 'icp') return renderIcp(parsed)
  return renderGeneric(parsed, raw)
}

// ─── Main component ───────────────────────────────────────────────────────────

type Props = {
  suggestion: PendingSuggestion
  onResolved: (id: string) => void
}

export default function ApprovalCard({ suggestion, onResolved }: Props) {
  const [loading, setLoading] = useState<'approve' | 'reject' | 'regenerate' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [rejectionReason, setRejectionReason] = useState('')
  const [confirmedMessage, setConfirmedMessage] = useState<string | null>(null)

  async function handleApprove() {
    setLoading('approve')
    setError(null)
    const res = await fetch(`/api/suggestions/${suggestion.id}/approve`, { method: 'POST' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError((body as { error?: string }).error ?? 'Something went wrong. Try again.')
      setLoading(null)
      return
    }
    onResolved(suggestion.id)
  }

  async function handleConfirmReject() {
    setLoading('reject')
    setError(null)
    const res = await fetch(`/api/suggestions/${suggestion.id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rejection_reason: rejectionReason }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError((body as { error?: string }).error ?? 'Something went wrong. Try again.')
      setLoading(null)
      return
    }
    onResolved(suggestion.id)
  }

  async function handleRejectAndRegenerate() {
    setLoading('regenerate')
    setError(null)
    const res = await fetch('/api/suggestions/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        suggestion_id: suggestion.id,
        client_id: suggestion.organisation_id,
        document_type: suggestion.document_type,
        rejection_reason: rejectionReason,
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError((body as { error?: string }).error ?? 'Something went wrong. Try again.')
      setLoading(null)
      return
    }
    setConfirmedMessage('Rejected. New suggestion generating — check back shortly.')
    setTimeout(() => onResolved(suggestion.id), 3000)
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
        <div className="flex items-center gap-3">
          {suggestion.created_at && (
            <span className="text-[10px] text-text-muted">
              {new Date(suggestion.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
          )}
          <span className="text-[10px] uppercase tracking-[0.07em] text-text-secondary">
            {clientName}
          </span>
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Agent reasoning */}
        {suggestion.suggestion_reason && (
          <div className="bg-[#FEF7E6] border border-[#F0D080] rounded-[6px] px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.07em] text-[#7A4800] mb-1">
              Agent reasoning
            </p>
            <p className="text-xs text-[#7A4800] leading-relaxed">{suggestion.suggestion_reason}</p>
          </div>
        )}

        {/* Field-level: side-by-side before/after */}
        {!isFullDocument && suggestion.current_value && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1.5">
                Current
              </p>
              <p className="text-xs text-text-secondary leading-relaxed">
                {suggestion.current_value}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1.5">
                Suggested
              </p>
              <div className="text-xs text-text-primary leading-relaxed">
                {renderSuggestedContent(suggestion.document_type, suggestion.suggested_value)}
              </div>
            </div>
          </div>
        )}

        {/* Full document or new field (no current value) */}
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

        {/* Post-regenerate confirmation message */}
        {confirmedMessage && (
          <p className="text-xs text-[#7A4800] bg-[#FEF7E6] border border-[#F0D080] rounded-[6px] px-3 py-2">
            {confirmedMessage}
          </p>
        )}

        {/* Inline rejection form */}
        {showRejectForm && !confirmedMessage && (
          <div className="bg-[#FEF7E6] border border-[#F0D080] rounded-[8px] px-4 py-3 space-y-3">
            <p className="text-[11px] text-[#7A4800] font-medium">Reason for rejection (optional)</p>
            <input
              type="text"
              value={rejectionReason}
              onChange={e => setRejectionReason(e.target.value)}
              placeholder="e.g. tone is off, variant B opener too salesy"
              disabled={isLoading}
              className="w-full bg-white border border-[#E8E2D8] rounded-[10px] px-3 py-2 text-[12px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-[#A8D4B8] disabled:opacity-50"
            />
            <div className="flex items-center gap-2.5">
              <button
                onClick={handleConfirmReject}
                disabled={isLoading}
                className="flex-1 py-2 rounded-full text-[12px] font-medium text-text-primary bg-white border border-[#C8C3B8] hover:border-[#EFBCAA] hover:text-[#8B2020] disabled:opacity-40 transition-colors"
              >
                {loading === 'reject' ? 'Rejecting…' : 'Confirm rejection'}
              </button>
              <button
                onClick={handleRejectAndRegenerate}
                disabled={isLoading}
                className="flex-1 py-2 rounded-full text-[12px] font-medium text-white bg-[#1C3A2A] hover:bg-[#152e21] disabled:opacity-40 transition-colors"
              >
                {loading === 'regenerate' ? 'Queuing…' : 'Reject and regenerate →'}
              </button>
            </div>
          </div>
        )}

        {/* Actions */}
        {!showRejectForm && !confirmedMessage && (
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={() => setShowRejectForm(true)}
              disabled={isLoading}
              className="flex-1 py-2.5 rounded-full text-sm font-medium text-text-primary border border-border-card hover:bg-[#FDEEE8] hover:border-[#EFBCAA] hover:text-[#8B2020] disabled:opacity-40 transition-colors"
            >
              Reject
            </button>
            <button
              onClick={handleApprove}
              disabled={isLoading}
              className="flex-1 py-2.5 rounded-full text-sm font-medium text-white bg-brand-green hover:bg-[#152e21] disabled:opacity-40 transition-colors"
            >
              {loading === 'approve' ? 'Approving…' : 'Approve →'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
