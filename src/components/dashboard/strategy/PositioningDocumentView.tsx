import type { Json } from '@/types/database'

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[14px] font-medium text-text-primary border-l-[3px] border-brand-green pl-3 mb-4">
      {children}
    </h3>
  )
}

function FieldBlock({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null
  return (
    <div>
      <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-1.5">
        {label}
      </p>
      <p className="text-[13px] text-text-primary leading-[1.65]">{value}</p>
    </div>
  )
}

function ListBlock({ label, items }: { label: string; items: string[] | undefined }) {
  if (!items || items.length === 0) return null
  return (
    <div>
      <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-1.5">
        {label}
      </p>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-text-muted shrink-0 mt-0.5">·</span>
            <span className="text-[13px] text-text-primary leading-relaxed">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

interface PositioningDoc {
  positioning_summary?: string
  core_message?: string
  moore_statement?: string
  target_customer?: string
  market_category?: string
  unique_value?: string
  competitive_alternatives?: Array<{
    name?: string
    buyer_reasoning?: string
    limitation?: string
  }>
  value_themes?: string[]
  key_messages?: string[]
  white_space?: string
  [key: string]: unknown
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
      doc.moore_statement ||
      doc.core_message ||
      doc.competitive_alternatives ||
      doc.key_messages)

  if (!hasStructured) {
    return <PlainTextView text={plainText} />
  }

  return (
    <div className="space-y-5">
      {/* Summary / core message */}
      {(doc.positioning_summary ?? doc.core_message) && (
        <div className="bg-[#EAF3DE] border border-[#C0DD97] rounded-[10px] p-5">
          <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-brand-green-success mb-2">
            Positioning summary
          </p>
          <p className="text-[14px] font-medium text-brand-green leading-relaxed">
            {doc.positioning_summary ?? doc.core_message}
          </p>
        </div>
      )}

      {/* Moore statement + core components */}
      {(doc.moore_statement || doc.target_customer || doc.market_category || doc.unique_value) && (
        <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
          <SectionHeading>Positioning statement</SectionHeading>
          <div className="space-y-4">
            {doc.moore_statement && (
              <div className="bg-surface-content rounded-[8px] px-4 py-3.5">
                <p className="text-[13px] text-text-primary leading-[1.65] italic">
                  &ldquo;{doc.moore_statement}&rdquo;
                </p>
              </div>
            )}
            <FieldBlock label="Target customer" value={doc.target_customer as string | undefined} />
            <FieldBlock label="Market category" value={doc.market_category as string | undefined} />
            <FieldBlock label="Unique value" value={doc.unique_value as string | undefined} />
          </div>
        </div>
      )}

      {/* Value themes */}
      {doc.value_themes && doc.value_themes.length > 0 && (
        <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
          <SectionHeading>Value themes</SectionHeading>
          <ListBlock label="" items={doc.value_themes} />
        </div>
      )}

      {/* Key messages */}
      {doc.key_messages && doc.key_messages.length > 0 && (
        <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
          <SectionHeading>Key messages</SectionHeading>
          <ListBlock label="" items={doc.key_messages} />
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
  )
}

function PlainTextView({ text }: { text: string | null }) {
  if (!text) {
    return (
      <div className="bg-surface-card border border-border-card rounded-[10px] p-6">
        <p className="text-[12px] text-text-secondary">
          Document content is being processed. Check back shortly.
        </p>
      </div>
    )
  }
  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-6">
      <p className="text-[13px] text-text-primary leading-[1.7] whitespace-pre-line">{text}</p>
    </div>
  )
}
