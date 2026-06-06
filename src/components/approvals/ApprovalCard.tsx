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

// Messaging — legacy format helpers
type SubjectLineOption = {
  subject_line: string
  subject_char_count?: number
  format_type?: string
  note?: string
}

type MessagingEmail = {
  day?: number
  angle?: string
  framework?: string
  body?: string
  word_count?: number
  subject_line_options?: SubjectLineOption[]
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
  what_outcome?: string
  what_outcome_they_get?: string
  how_this_firm_is_the_guide?: string
  spine?: string
}

type MessagingDoc = {
  core_message?: MessagingCoreMessage
  cold_email_sequence?: MessagingColdEmailSequence
  messaging_playbook?: MessagingDoc
}

// Messaging — new agent format (ADR-014 four-variant)
type MessagingEmailNew = {
  sequence_position: number
  subject_line: string | null
  subject_char_count: number
  body: string
  word_count: number
}

type FourVariantDoc = {
  variants: Record<string, { emails: MessagingEmailNew[] }>
}

// TOV — real schema from DRY RUN org
type TovCharacteristic = {
  characteristic?: string
  description?: string
  evidence?: string
}

type DoDontList = {
  do?: string[]
  dont?: string[]
}

type VocabularyDoc = {
  words_they_use?: string[]
  words_they_avoid?: string[]
  sentence_length?: string
  structural_patterns?: string[]
}

type WritingRule = {
  rule?: string
  why?: string
  example_violation?: string
  example_correct?: string
}

type WhatVoiceNeverDoes = {
  rule?: string
  evidence?: string
}

type BeforeAfterExample = {
  context?: string
  before?: string
  after?: string
}

type SentenceMechanics = {
  dominant_sentence_length?: string
  fragment_usage?: string
  punctuation_patterns?: string
  opening_move_pattern?: string
}

type TovDoc = {
  voice_summary?: string
  voice_style_note?: string
  voice_characteristics?: TovCharacteristic[]
  do_dont_list?: DoDontList
  vocabulary?: VocabularyDoc
  writing_rules?: WritingRule[]
  what_this_voice_never_does?: WhatVoiceNeverDoes[]
  before_after_examples?: BeforeAfterExample[]
  sentence_mechanics?: SentenceMechanics
}

// Positioning — real schema from DRY RUN org
type CompetitiveAlternative = {
  name?: string
  buyer_reasoning?: string
  limitation?: string
}

type UniqueAttribute = {
  what_it_is?: string
  client_outcome?: string
  why_competitors_cannot_claim_it?: string
}

type ValueTheme = {
  theme?: string
  for_whom?: string
  outcome_statement?: string
}

type BestFitCharacteristics = {
  must_haves?: string[]
  amplifiers?: string[]
  disqualifiers?: string[]
}

type AlternativeFrame = {
  frame?: string
  why_rejected?: string
}

type MarketCategory = {
  chosen_category?: string
  why_this_frame?: string
  alternative_frames_considered?: AlternativeFrame[]
}

type MoorePositioning = {
  full_positioning_statement?: string
  compressed_positioning_statement?: string
}

type CompetitiveLandscape = {
  white_space?: string
  direct_competitors?: string[]
  dominant_narrative?: string
}

type KeyMessages = {
  cold_outreach_hook?: string
  discovery_frame?: string
  objection_response?: string
}

type PositioningDoc = {
  positioning_summary?: string
  moore_positioning?: MoorePositioning
  market_category?: MarketCategory
  unique_attributes?: UniqueAttribute[]
  value_themes?: ValueTheme[]
  competitive_alternatives?: CompetitiveAlternative[]
  best_fit_characteristics?: BestFitCharacteristics
  competitive_landscape?: CompetitiveLandscape
  key_messages?: KeyMessages
}

// ICP — real schema: flat tier_1/tier_2/tier_3 keys (not an array)
type IcpCompanyProfile = {
  revenue_range?: string
  headcount?: string
  stage?: string
  industries?: string[]
  geography?: string
  business_model?: string
}

type IcpBuyerProfile = {
  title?: string
  seniority?: string
  day_to_day?: string
  identity?: string
}

type IcpForces = {
  push?: string[]
  pull?: string[]
  anxiety?: string[]
  habit?: string[]
}

type IcpTrigger = {
  trigger?: string
  evidence_to_find?: string[]
}

type IcpTierObject = {
  label?: string
  description?: string
  company_profile?: IcpCompanyProfile
  buyer_profile?: IcpBuyerProfile
  four_forces?: IcpForces
  triggers?: IcpTrigger[]
  switching_costs?: string[]
  disqualifiers?: string[]
}

type IcpDoc = {
  summary?: string
  jtbd_statement?: string
  tier_1?: IcpTierObject
  tier_2?: IcpTierObject
  tier_3?: IcpTierObject
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

// ─── Generic renderer + crash fallback ───────────────────────────────────────

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

// On any renderer crash: surface what renderGeneric can, then renderUnknownFields for the rest.
// A malformed or future-shaped payload renders ugly — it never takes down the approvals page.
function renderCrashFallback(parsed: unknown) {
  const raw = typeof parsed === 'string' ? parsed : JSON.stringify(parsed ?? '')
  const generic = renderGeneric(parsed, raw)
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const unknown = renderUnknownFields(parsed as Record<string, unknown>, new Set())
    if (unknown) {
      return <div className="space-y-3">{generic}{unknown}</div>
    }
  }
  return <div>{generic}</div>
}

// ─── Collapsible email section (legacy format) ────────────────────────────────

function EmailSection({ label, email }: { label: string; email: MessagingEmail }) {
  const [open, setOpen] = useState(false)

  const emailNum = label.replace('email_', 'Email ')
  const angle = email.angle ?? email.framework ?? ''

  const hasSubjectOptions =
    Array.isArray(email.subject_line_options) && email.subject_line_options.length > 0
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

function IcpTierCard({ tier }: { tier: IcpTierObject }) {
  const industries = tier.company_profile?.industries ?? []
  const disqualifiers = tier.disqualifiers ?? []

  return (
    <div className="bg-surface-content rounded-[8px] px-3 py-3 space-y-2.5">
      {tier.label && (
        <p className="text-xs font-medium text-text-primary">{tier.label}</p>
      )}
      {tier.description && (
        <p className="text-xs text-text-secondary leading-relaxed">{tier.description}</p>
      )}
      {tier.company_profile && (
        <div className="space-y-1.5">
          {tier.company_profile.revenue_range && (
            <div className="flex items-baseline gap-2">
              <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted shrink-0">Revenue</p>
              <p className="text-xs text-text-secondary">{tier.company_profile.revenue_range}</p>
            </div>
          )}
          {tier.company_profile.headcount && (
            <div className="flex items-baseline gap-2">
              <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted shrink-0">Headcount</p>
              <p className="text-xs text-text-secondary">{tier.company_profile.headcount}</p>
            </div>
          )}
          {industries.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Industries</p>
              <div className="flex flex-wrap gap-1">
                {industries.map((ind, i) => (
                  <span
                    key={i}
                    className="text-[11px] bg-surface-card border border-border-card rounded-[4px] px-1.5 py-0.5 text-text-secondary"
                  >
                    {ind}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {tier.buyer_profile?.title && (
        <div className="flex items-baseline gap-2">
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted shrink-0">Buyer</p>
          <p className="text-xs text-text-secondary">{tier.buyer_profile.title}</p>
        </div>
      )}
      {disqualifiers.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Disqualifiers</p>
          <ul className="space-y-0.5">
            {disqualifiers.map((d, i) => (
              <li
                key={i}
                className="flex items-start gap-1.5 text-xs text-[#8B2020] leading-relaxed"
              >
                <span className="shrink-0 text-[#8B2020]">·</span>
                {d}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ─── Document renderers ───────────────────────────────────────────────────────

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
            <div className="flex items-center justify-between px-4 py-3 bg-surface-content">
              <span className="text-[12px] font-medium text-text-primary">
                Email {email.sequence_position}
              </span>
              <span className="text-[10px] text-[#C8C3B8]">{email.word_count} words</span>
            </div>

            <div className="px-4 pt-3 pb-4 space-y-3 bg-surface-card">
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

function MessagingVariantsRenderer({ doc }: { doc: FourVariantDoc }) {
  const variantKeys = Object.keys(doc.variants).sort()
  const [activeVariant, setActiveVariant] = useState(variantKeys[0] ?? 'A')

  const activeEmails = doc.variants[activeVariant]?.emails ?? []

  return (
    <div className="space-y-4">
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

      {renderMessagingNew(activeEmails)}
    </div>
  )
}

function renderMessaging(parsed: unknown) {
  try {
    const asFourVariant = parsed as { variants?: Record<string, { emails: MessagingEmailNew[] }> }
    if (
      asFourVariant?.variants &&
      typeof asFourVariant.variants === 'object' &&
      Object.keys(asFourVariant.variants).length > 0
    ) {
      return <MessagingVariantsRenderer doc={asFourVariant as FourVariantDoc} />
    }

    const asNew = parsed as { emails?: MessagingEmailNew[] }
    if (Array.isArray(asNew?.emails) && asNew.emails.length > 0) {
      return renderMessagingNew(asNew.emails)
    }

    // Legacy format path
    const raw = parsed as MessagingDoc
    const doc: MessagingDoc = raw.messaging_playbook ?? raw
    const { core_message, cold_email_sequence } = doc

    const emailEntries = Object.entries(cold_email_sequence ?? {})
      .filter(([key]) => /^email_\d+/.test(key))
      .sort(([a], [b]) => {
        const n = (k: string) => parseInt(k.replace(/\D/g, ''), 10) || 0
        return n(a) - n(b)
      }) as [string, MessagingEmail][]

    const outcome = core_message?.what_outcome_they_get ?? core_message?.what_outcome

    return (
      <div className="space-y-5">
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
  } catch {
    return renderCrashFallback(parsed)
  }
}

function renderTov(parsed: unknown) {
  try {
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

        {doc.do_dont_list && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Do / Don't</p>
            <div className="grid grid-cols-2 gap-3">
              {(doc.do_dont_list.do ?? []).length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-[0.07em] text-[#3B6D11] mb-1.5">Do</p>
                  <ul className="space-y-1">
                    {doc.do_dont_list.do!.map((item, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs text-[#3B6D11] leading-relaxed">
                        <span className="shrink-0 mt-0.5">·</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(doc.do_dont_list.dont ?? []).length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-[0.07em] text-[#8B2020] mb-1.5">Don't</p>
                  <ul className="space-y-1">
                    {doc.do_dont_list.dont!.map((item, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs text-[#8B2020] leading-relaxed">
                        <span className="shrink-0 mt-0.5">·</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}

        {doc.vocabulary && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Vocabulary</p>
            <div className="grid grid-cols-2 gap-3 mb-2">
              {(doc.vocabulary.words_they_use ?? []).length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-[0.07em] text-[#3B6D11] mb-1.5">Use</p>
                  <div className="flex flex-wrap gap-1.5">
                    {doc.vocabulary.words_they_use!.map((w, i) => (
                      <span key={i} className="text-[11px] bg-[#EAF3DE] text-[#3B6D11] rounded-[4px] px-2 py-0.5">
                        {w}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {(doc.vocabulary.words_they_avoid ?? []).length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-[0.07em] text-[#8B2020] mb-1.5">Avoid</p>
                  <div className="flex flex-wrap gap-1.5">
                    {doc.vocabulary.words_they_avoid!.map((w, i) => (
                      <span key={i} className="text-[11px] bg-[#FDEEE8] text-[#8B2020] rounded-[4px] px-2 py-0.5">
                        {w}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {doc.vocabulary.sentence_length && (
              <p className="text-xs text-text-secondary leading-relaxed">{doc.vocabulary.sentence_length}</p>
            )}
          </div>
        )}

        {(doc.writing_rules ?? []).length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">
              Writing rules · {doc.writing_rules!.length}
            </p>
            <div className="space-y-2">
              {doc.writing_rules!.map((r, i) => (
                <div key={i} className="bg-surface-content rounded-[6px] px-3 py-2.5">
                  {r.rule && (
                    <p className="text-xs font-medium text-text-primary mb-1">{r.rule}</p>
                  )}
                  {r.why && (
                    <p className="text-xs text-text-secondary leading-relaxed mb-1.5">{r.why}</p>
                  )}
                  {(r.example_correct || r.example_violation) && (
                    <div className="space-y-1.5">
                      {r.example_violation && (
                        <div className="bg-[#FDEEE8] rounded-[4px] px-2 py-1.5">
                          <p className="text-[10px] uppercase tracking-[0.07em] text-[#8B2020] mb-0.5">Violation</p>
                          <p className="text-xs text-[#8B2020] italic leading-relaxed">"{r.example_violation}"</p>
                        </div>
                      )}
                      {r.example_correct && (
                        <div className="bg-[#EAF3DE] rounded-[4px] px-2 py-1.5">
                          <p className="text-[10px] uppercase tracking-[0.07em] text-[#3B6D11] mb-0.5">Correct</p>
                          <p className="text-xs text-[#3B6D11] italic leading-relaxed">"{r.example_correct}"</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {(doc.what_this_voice_never_does ?? []).length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">
              What this voice never does
            </p>
            <div className="space-y-2">
              {doc.what_this_voice_never_does!.map((item, i) => (
                <div key={i} className="bg-surface-content rounded-[6px] px-3 py-2.5">
                  {item.rule && (
                    <p className="text-xs font-medium text-[#8B2020] mb-1">{item.rule}</p>
                  )}
                  {item.evidence && (
                    <p className="text-xs text-text-secondary leading-relaxed italic">{item.evidence}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {(doc.before_after_examples ?? []).length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Before / After</p>
            <div className="space-y-3">
              {doc.before_after_examples!.map((ex, i) => (
                <div key={i} className="space-y-1.5">
                  {ex.context && (
                    <p className="text-[11px] text-text-muted italic px-1">{ex.context}</p>
                  )}
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
                </div>
              ))}
            </div>
          </div>
        )}

        {doc.sentence_mechanics && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Sentence mechanics</p>
            <div className="bg-surface-content rounded-[6px] px-3 py-2.5 space-y-2">
              {doc.sentence_mechanics.dominant_sentence_length && (
                <div>
                  <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-0.5">Sentence length</p>
                  <p className="text-xs text-text-primary">{doc.sentence_mechanics.dominant_sentence_length}</p>
                </div>
              )}
              {doc.sentence_mechanics.fragment_usage && (
                <div>
                  <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-0.5">Fragment usage</p>
                  <p className="text-xs text-text-primary">{doc.sentence_mechanics.fragment_usage}</p>
                </div>
              )}
              {doc.sentence_mechanics.punctuation_patterns && (
                <div>
                  <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-0.5">Punctuation</p>
                  <p className="text-xs text-text-primary">{doc.sentence_mechanics.punctuation_patterns}</p>
                </div>
              )}
              {doc.sentence_mechanics.opening_move_pattern && (
                <div>
                  <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-0.5">Opening pattern</p>
                  <p className="text-xs text-text-primary">{doc.sentence_mechanics.opening_move_pattern}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {renderUnknownFields(doc as Record<string, unknown>, handledKeys)}
      </div>
    )
  } catch {
    return renderCrashFallback(parsed)
  }
}

function renderPositioning(parsed: unknown) {
  try {
    const doc = parsed as PositioningDoc
    const handledKeys = new Set([
      'positioning_summary', 'moore_positioning', 'market_category', 'unique_attributes',
      'value_themes', 'competitive_alternatives', 'best_fit_characteristics',
      'competitive_landscape', 'key_messages',
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
            {doc.moore_positioning.compressed_positioning_statement && (
              <p className="text-xs text-text-primary leading-relaxed italic bg-surface-content rounded-[6px] px-3 py-2.5 mb-2">
                {doc.moore_positioning.compressed_positioning_statement}
              </p>
            )}
            {doc.moore_positioning.full_positioning_statement && (
              <p className="text-xs text-text-secondary leading-relaxed">
                {doc.moore_positioning.full_positioning_statement}
              </p>
            )}
          </div>
        )}

        {doc.market_category && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Market category</p>
            {doc.market_category.chosen_category && (
              <p className="text-xs font-medium text-text-primary mb-1.5">{doc.market_category.chosen_category}</p>
            )}
            {doc.market_category.why_this_frame && (
              <p className="text-xs text-text-secondary leading-relaxed mb-2">{doc.market_category.why_this_frame}</p>
            )}
            {(doc.market_category.alternative_frames_considered ?? []).length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1.5">
                  Alternatives considered
                </p>
                <div className="space-y-1.5">
                  {doc.market_category.alternative_frames_considered!.map((alt, i) => (
                    <div key={i} className="bg-surface-content rounded-[6px] px-3 py-2">
                      {alt.frame && (
                        <p className="text-xs font-medium text-text-primary mb-0.5">{alt.frame}</p>
                      )}
                      {alt.why_rejected && (
                        <p className="text-xs text-text-secondary leading-relaxed">{alt.why_rejected}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {(doc.unique_attributes ?? []).length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">
              Unique attributes · {doc.unique_attributes!.length}
            </p>
            <div className="space-y-2">
              {doc.unique_attributes!.map((attr, i) => (
                <div key={i} className="bg-surface-content rounded-[6px] px-3 py-2.5">
                  {attr.what_it_is && (
                    <p className="text-xs font-medium text-text-primary mb-1">{attr.what_it_is}</p>
                  )}
                  {attr.client_outcome && (
                    <p className="text-xs text-text-secondary leading-relaxed mb-1">{attr.client_outcome}</p>
                  )}
                  {attr.why_competitors_cannot_claim_it && (
                    <p className="text-[11px] text-text-muted leading-relaxed italic">
                      {attr.why_competitors_cannot_claim_it}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {(doc.value_themes ?? []).length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">
              Value themes · {doc.value_themes!.length}
            </p>
            <div className="space-y-2">
              {doc.value_themes!.map((vt, i) => (
                <div key={i} className="bg-surface-content rounded-[6px] px-3 py-2.5">
                  {vt.theme && (
                    <p className="text-xs font-medium text-text-primary mb-1">{vt.theme}</p>
                  )}
                  {vt.for_whom && (
                    <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">{vt.for_whom}</p>
                  )}
                  {vt.outcome_statement && (
                    <p className="text-xs text-text-secondary leading-relaxed">{vt.outcome_statement}</p>
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

        {doc.best_fit_characteristics && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Best fit characteristics</p>
            <div className="space-y-3">
              {(doc.best_fit_characteristics.must_haves ?? []).length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Must haves</p>
                  <ul className="space-y-0.5">
                    {doc.best_fit_characteristics.must_haves!.map((item, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs text-text-primary leading-relaxed">
                        <span className="shrink-0 text-text-muted mt-0.5">·</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(doc.best_fit_characteristics.amplifiers ?? []).length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Amplifiers</p>
                  <ul className="space-y-0.5">
                    {doc.best_fit_characteristics.amplifiers!.map((item, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs text-text-secondary leading-relaxed">
                        <span className="shrink-0 text-text-muted mt-0.5">·</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(doc.best_fit_characteristics.disqualifiers ?? []).length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Disqualifiers</p>
                  <ul className="space-y-0.5">
                    {doc.best_fit_characteristics.disqualifiers!.map((item, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs text-[#8B2020] leading-relaxed">
                        <span className="shrink-0 text-[#8B2020] mt-0.5">·</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}

        {doc.competitive_landscape && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Competitive landscape</p>
            {doc.competitive_landscape.dominant_narrative && (
              <div className="mb-2">
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Dominant narrative</p>
                <p className="text-xs text-text-secondary leading-relaxed">
                  {doc.competitive_landscape.dominant_narrative}
                </p>
              </div>
            )}
            {doc.competitive_landscape.white_space && (
              <div className="mb-2">
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">White space</p>
                <p className="text-xs text-text-secondary leading-relaxed">
                  {doc.competitive_landscape.white_space}
                </p>
              </div>
            )}
            {(doc.competitive_landscape.direct_competitors ?? []).length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Direct competitors</p>
                <ul className="space-y-0.5">
                  {doc.competitive_landscape.direct_competitors!.map((c, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-text-secondary leading-relaxed">
                      <span className="shrink-0 text-text-muted mt-0.5">·</span>
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {doc.key_messages && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Key messages</p>
            <div className="space-y-2">
              {doc.key_messages.cold_outreach_hook && (
                <div className="bg-surface-content rounded-[6px] px-3 py-2.5">
                  <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Cold outreach hook</p>
                  <p className="text-xs text-text-primary leading-relaxed">{doc.key_messages.cold_outreach_hook}</p>
                </div>
              )}
              {doc.key_messages.discovery_frame && (
                <div className="bg-surface-content rounded-[6px] px-3 py-2.5">
                  <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Discovery frame</p>
                  <p className="text-xs text-text-primary leading-relaxed">{doc.key_messages.discovery_frame}</p>
                </div>
              )}
              {doc.key_messages.objection_response && (
                <div className="bg-surface-content rounded-[6px] px-3 py-2.5">
                  <p className="text-[10px] uppercase tracking-[0.07em] text-text-muted mb-1">Objection response</p>
                  <p className="text-xs text-text-primary leading-relaxed">{doc.key_messages.objection_response}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {renderUnknownFields(doc as Record<string, unknown>, handledKeys)}
      </div>
    )
  } catch {
    return renderCrashFallback(parsed)
  }
}

function renderIcp(parsed: unknown) {
  try {
    const doc = parsed as IcpDoc
    const handledKeys = new Set(['summary', 'jtbd_statement', 'tier_1', 'tier_2', 'tier_3'])

    const tiers = [doc.tier_1, doc.tier_2, doc.tier_3].filter(
      (t): t is IcpTierObject => Boolean(t),
    )

    return (
      <div className="space-y-5">
        {doc.summary && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">ICP summary</p>
            <p className="text-xs text-text-primary leading-relaxed">{doc.summary}</p>
          </div>
        )}

        {doc.jtbd_statement && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">Job to be done</p>
            <p className="text-xs text-text-primary leading-relaxed italic">{doc.jtbd_statement}</p>
          </div>
        )}

        {tiers.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-2">
              Tiers · {tiers.length}
            </p>
            <div className="space-y-3">
              {tiers.map((tier, i) => (
                <IcpTierCard key={i} tier={tier} />
              ))}
            </div>
          </div>
        )}

        {renderUnknownFields(doc as Record<string, unknown>, handledKeys)}
      </div>
    )
  } catch {
    return renderCrashFallback(parsed)
  }
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
              {new Date(suggestion.created_at).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
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
