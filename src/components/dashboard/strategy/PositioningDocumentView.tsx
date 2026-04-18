import type { Json } from '@/types/database'

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[14px] font-medium text-text-primary border-l-[3px] border-brand-green pl-3 mb-4">
      {children}
    </h3>
  )
}

interface MoorePositioning {
  compressed_positioning_statement?: string
  full_positioning_statement?: string
}

interface UniqueAttribute {
  // New schema fields
  what_it_is?: string
  why_competitors_cannot_claim_it?: string
  client_outcome?: string
  // Legacy schema fields — retained for backward compat with pre-existing approved documents
  attribute?: string
  why_alternatives_lack_it?: string
  verifiable_signal?: string
}

interface MarketCategory {
  chosen_category?: string
  why_this_frame?: string
  alternative_frames_considered?: Array<{
    frame?: string
    why_rejected?: string
  }>
}

interface KeyMessages {
  discovery_frame?: string
  cold_outreach_hook?: string
  objection_response?: string
}

interface ValueTheme {
  theme?: string
  for_whom?: string
  outcome_statement?: string
}

interface PositioningDoc {
  positioning_summary?: string
  core_message?: string
  // New schema: object with compressed + full versions
  moore_positioning?: MoorePositioning
  // Legacy schema: single string — retained for backward compat with pre-existing approved documents
  moore_statement?: string
  unique_attributes?: UniqueAttribute[]
  target_customer?: string | null
  market_category?: MarketCategory | string | null
  unique_value?: string | null
  competitive_alternatives?: Array<{
    name?: string
    buyer_reasoning?: string
    limitation?: string
  }>
  value_themes?: ValueTheme[] | string[]
  key_messages?: KeyMessages | string[]
  white_space?: string | null
  [key: string]: unknown
}

function parseMarketCategory(raw: PositioningDoc['market_category']): MarketCategory | null {
  if (!raw) return null
  if (typeof raw === 'string') return { chosen_category: raw }
  return raw
}

function parseKeyMessages(raw: PositioningDoc['key_messages']): KeyMessages | null {
  if (!raw || Array.isArray(raw)) return null
  return raw
}

function parseValueThemes(raw: PositioningDoc['value_themes']): ValueTheme[] {
  if (!raw || !Array.isArray(raw)) return []
  return raw.map(item => (typeof item === 'string' ? { theme: item } : item))
}

interface PositioningDocumentViewProps {
  content: Json
  plainText: string | null
}

export function PositioningDocumentView({ content, plainText }: PositioningDocumentViewProps) {
  const doc = content as PositioningDoc

  const hasStructured =
    doc &&
    (doc.positioning_summary ||
      doc.moore_positioning ||
      doc.moore_statement ||
      doc.core_message ||
      doc.market_category ||
      doc.competitive_alternatives ||
      doc.key_messages)

  if (!hasStructured) {
    return <PlainTextView text={plainText} />
  }

  const summary = doc.positioning_summary ?? doc.core_message
  const marketCategory = parseMarketCategory(doc.market_category)
  const keyMessages = parseKeyMessages(doc.key_messages)
  const valueThemes = parseValueThemes(doc.value_themes)

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-5 max-w-[960px]">

      {/* Left column — main content */}
      <div className="space-y-5">

        {/* Moore positioning — new schema: compressed + full */}
        {doc.moore_positioning && (
          <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
            <SectionHeading>Positioning statement</SectionHeading>
            {doc.moore_positioning.compressed_positioning_statement && (
              <div className="bg-[#EAF3DE] border border-[#C0DD97] rounded-[8px] px-4 py-3.5 mb-4">
                <p className="text-[10px] uppercase tracking-[0.07em] text-brand-green-success mb-2">
                  Core positioning
                </p>
                <p className="text-[13px] font-medium text-brand-green leading-[1.65] italic">
                  &ldquo;{doc.moore_positioning.compressed_positioning_statement}&rdquo;
                </p>
              </div>
            )}
            {doc.moore_positioning.full_positioning_statement && (
              <div className="bg-surface-content rounded-[8px] px-4 py-3.5">
                <p className="text-[12px] text-text-primary leading-[1.65]">
                  {doc.moore_positioning.full_positioning_statement}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Moore statement — legacy schema: single string */}
        {!doc.moore_positioning && doc.moore_statement && (
          <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
            <SectionHeading>Positioning statement</SectionHeading>
            <div className="bg-surface-content rounded-[8px] px-4 py-3.5">
              <p className="text-[13px] text-text-primary leading-[1.65] italic">
                &ldquo;{doc.moore_statement}&rdquo;
              </p>
            </div>
          </div>
        )}

        {/* Unique attributes */}
        {doc.unique_attributes && doc.unique_attributes.length > 0 && (
          <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
            <SectionHeading>Unique attributes</SectionHeading>
            <div className="space-y-4">
              {doc.unique_attributes.map((attr, i) => {
                // Support both new field names and legacy field names
                const label = attr.what_it_is ?? attr.attribute
                const differentiation = attr.why_competitors_cannot_claim_it ?? attr.why_alternatives_lack_it
                const outcome = attr.client_outcome ?? attr.verifiable_signal
                return (
                  <div key={i} className="bg-surface-content rounded-[8px] px-4 py-3.5">
                    {label && (
                      <p className="text-[12px] font-medium text-text-primary mb-2">{label}</p>
                    )}
                    {differentiation && (
                      <div className="mb-2">
                        <p className="text-[9px] uppercase tracking-[0.07em] text-text-muted mb-1">
                          Why competitors cannot claim it
                        </p>
                        <p className="text-[11px] text-text-secondary leading-relaxed">
                          {differentiation}
                        </p>
                      </div>
                    )}
                    {outcome && (
                      <div>
                        <p className="text-[9px] uppercase tracking-[0.07em] text-text-muted mb-1">
                          Client outcome
                        </p>
                        <p className="text-[11px] text-text-primary leading-relaxed">{outcome}</p>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Market category */}
        {marketCategory && (
          <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
            <SectionHeading>Market category</SectionHeading>
            {marketCategory.chosen_category && (
              <div className="bg-surface-content rounded-[8px] px-4 py-3.5 mb-4">
                <p className="text-[13px] font-medium text-text-primary">
                  {marketCategory.chosen_category}
                </p>
              </div>
            )}
            {marketCategory.why_this_frame && (
              <div className="mb-4">
                <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-1.5">
                  Why this frame
                </p>
                <p className="text-[12px] text-text-primary leading-relaxed">
                  {marketCategory.why_this_frame}
                </p>
              </div>
            )}
            {marketCategory.alternative_frames_considered &&
              marketCategory.alternative_frames_considered.length > 0 && (
                <div>
                  <p className="text-[10px] uppercase tracking-[0.07em] text-text-secondary mb-3">
                    Frames considered and rejected
                  </p>
                  <div className="space-y-3">
                    {marketCategory.alternative_frames_considered.map((alt, i) => (
                      <div key={i} className="bg-[#FDEEE8] rounded-[8px] px-4 py-3">
                        {alt.frame && (
                          <p className="text-[12px] font-medium text-[#8B2020] mb-1">{alt.frame}</p>
                        )}
                        {alt.why_rejected && (
                          <p className="text-[11px] text-[#8B2020] leading-relaxed">
                            {alt.why_rejected}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
          </div>
        )}

        {/* Competitive alternatives */}
        {doc.competitive_alternatives && doc.competitive_alternatives.length > 0 && (
          <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
            <SectionHeading>Competitive landscape</SectionHeading>
            <div className="space-y-4">
              {doc.competitive_alternatives.map((alt, i) => (
                <div key={i} className="bg-surface-content rounded-[8px] px-4 py-3.5">
                  {alt.name && (
                    <p className="text-[12px] font-medium text-text-primary mb-1">{alt.name}</p>
                  )}
                  {alt.buyer_reasoning && (
                    <p className="text-[12px] text-text-secondary leading-relaxed mb-1.5">
                      {alt.buyer_reasoning}
                    </p>
                  )}
                  {alt.limitation && (
                    <p className="text-[11px] text-[#8B2020] leading-relaxed">{alt.limitation}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* White space */}
        {doc.white_space && (
          <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
            <SectionHeading>White space opportunity</SectionHeading>
            <p className="text-[13px] text-text-primary leading-[1.65]">{doc.white_space}</p>
          </div>
        )}
      </div>

      {/* Right column — summary panel */}
      <div className="space-y-4">

        {/* Positioning summary */}
        {summary && (
          <div className="bg-[#EAF3DE] border border-[#C0DD97] rounded-[10px] p-5">
            <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-brand-green-success mb-2">
              Positioning summary
            </p>
            <p className="text-[13px] font-medium text-brand-green leading-relaxed">{summary}</p>
          </div>
        )}

        {/* Key messages */}
        {keyMessages && (
          <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
            <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-3">
              Key messages
            </p>
            <div className="space-y-3.5">
              {keyMessages.cold_outreach_hook && (
                <div>
                  <p className="text-[9px] uppercase tracking-[0.07em] text-text-muted mb-1">Hook</p>
                  <p className="text-[12px] text-text-primary leading-relaxed italic">
                    &ldquo;{keyMessages.cold_outreach_hook}&rdquo;
                  </p>
                </div>
              )}
              {keyMessages.discovery_frame && (
                <div>
                  <p className="text-[9px] uppercase tracking-[0.07em] text-text-muted mb-1">
                    Discovery
                  </p>
                  <p className="text-[12px] text-text-primary leading-relaxed">
                    {keyMessages.discovery_frame}
                  </p>
                </div>
              )}
              {keyMessages.objection_response && (
                <div>
                  <p className="text-[9px] uppercase tracking-[0.07em] text-text-muted mb-1">
                    Objection
                  </p>
                  <p className="text-[12px] text-text-primary leading-relaxed">
                    {keyMessages.objection_response}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Value themes */}
        {valueThemes.length > 0 && (
          <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
            <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-3">
              Value themes · {valueThemes.length}
            </p>
            <ul className="space-y-2.5">
              {valueThemes.map((vt, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-text-muted shrink-0 mt-0.5">·</span>
                  <p className="text-[12px] text-text-primary leading-relaxed">{vt.theme}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

function PlainTextView({ text }: { text: string | null }) {
  if (!text) {
    return (
      <div className="bg-surface-card border border-border-card rounded-[10px] p-6 max-w-[640px]">
        <p className="text-[12px] text-text-secondary">
          Document content is being processed. Check back shortly.
        </p>
      </div>
    )
  }
  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-6 max-w-[640px]">
      <p className="text-[13px] text-text-primary leading-[1.7] whitespace-pre-line">{text}</p>
    </div>
  )
}
