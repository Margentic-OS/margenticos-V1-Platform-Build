import type { Json } from '@/types/database'

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[14px] font-medium text-text-primary border-l-[3px] border-brand-green pl-3 mb-4">
      {children}
    </h3>
  )
}

interface TovVocabulary {
  words_they_use?: string[]
  words_to_avoid?: string[]
  structural_patterns?: string[]
}

interface TovCharacteristic {
  characteristic?: string
  description?: string
  evidence?: string
}

interface TovWritingRule {
  rule?: string
  description?: string
  example?: string
}

interface TovDoDontItem {
  do?: string
  dont?: string
  context?: string
}

interface TovBeforeAfter {
  before?: string
  after?: string
  note?: string
}

interface TovDoc {
  voice_summary?: string
  voice_style_note?: string
  voice_characteristics?: TovCharacteristic[]
  vocabulary?: TovVocabulary
  writing_rules?: TovWritingRule[]
  do_dont_list?: TovDoDontItem[]
  before_after_examples?: TovBeforeAfter[]
  [key: string]: unknown
}

interface TovDocumentViewProps {
  content: Json
  plainText: string | null
}

export function TovDocumentView({ content, plainText }: TovDocumentViewProps) {
  const doc = content as TovDoc

  const hasStructured =
    doc &&
    (doc.voice_summary ||
      doc.voice_characteristics?.length ||
      doc.vocabulary ||
      doc.writing_rules?.length)

  if (!hasStructured) {
    return <PlainTextView text={plainText} />
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-5 max-w-[960px]">

      {/* Left column — main content */}
      <div className="space-y-5">

        {/* Voice characteristics */}
        {doc.voice_characteristics && doc.voice_characteristics.length > 0 && (
          <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
            <SectionHeading>
              Voice characteristics · {doc.voice_characteristics.length}
            </SectionHeading>
            <div className="space-y-3.5">
              {doc.voice_characteristics.map((c, i) => (
                <div key={i} className="bg-surface-content rounded-[8px] px-4 py-3.5">
                  {c.characteristic && (
                    <p className="text-[12px] font-medium text-text-primary mb-1">
                      {c.characteristic}
                    </p>
                  )}
                  {c.description && (
                    <p className="text-[12px] text-text-secondary leading-relaxed mb-1.5">
                      {c.description}
                    </p>
                  )}
                  {c.evidence && (
                    <p className="text-[11px] text-text-muted italic leading-relaxed">
                      &ldquo;{c.evidence}&rdquo;
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Writing rules */}
        {doc.writing_rules && doc.writing_rules.length > 0 && (
          <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
            <SectionHeading>Writing rules</SectionHeading>
            <div className="space-y-3.5">
              {doc.writing_rules.map((rule, i) => (
                <div key={i} className="bg-surface-content rounded-[8px] px-4 py-3.5">
                  {rule.rule && (
                    <p className="text-[12px] font-medium text-text-primary mb-1">{rule.rule}</p>
                  )}
                  {rule.description && (
                    <p className="text-[12px] text-text-secondary leading-relaxed mb-1.5">
                      {rule.description}
                    </p>
                  )}
                  {rule.example && (
                    <p className="text-[11px] text-text-muted italic leading-relaxed">
                      e.g. {rule.example}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Before / after examples */}
        {doc.before_after_examples && doc.before_after_examples.length > 0 && (
          <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
            <SectionHeading>Before / after examples</SectionHeading>
            <div className="space-y-4">
              {doc.before_after_examples.map((ex, i) => (
                <div key={i}>
                  <div className="grid grid-cols-2 gap-3">
                    {ex.before && (
                      <div className="bg-[#FDEEE8] rounded-[8px] px-3 py-2.5">
                        <p className="text-[9px] uppercase tracking-[0.07em] text-[#8B2020] mb-1">
                          Before
                        </p>
                        <p className="text-[12px] text-[#8B2020] leading-relaxed">{ex.before}</p>
                      </div>
                    )}
                    {ex.after && (
                      <div className="bg-[#EAF3DE] rounded-[8px] px-3 py-2.5">
                        <p className="text-[9px] uppercase tracking-[0.07em] text-brand-green-success mb-1">
                          After
                        </p>
                        <p className="text-[12px] text-brand-green leading-relaxed">{ex.after}</p>
                      </div>
                    )}
                  </div>
                  {ex.note && (
                    <p className="text-[10px] text-text-muted mt-1.5">{ex.note}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Do / don't list */}
        {doc.do_dont_list && doc.do_dont_list.length > 0 && (
          <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
            <SectionHeading>Do / don&apos;t</SectionHeading>
            <div className="space-y-3">
              {doc.do_dont_list.map((item, i) => (
                <div key={i} className="grid grid-cols-2 gap-3">
                  {item.do && (
                    <div className="flex gap-2">
                      <span className="text-brand-green-success font-medium shrink-0 mt-0.5">✓</span>
                      <p className="text-[12px] text-text-primary leading-relaxed">{item.do}</p>
                    </div>
                  )}
                  {item.dont && (
                    <div className="flex gap-2">
                      <span className="text-[#8B2020] font-medium shrink-0 mt-0.5">✗</span>
                      <p className="text-[12px] text-text-primary leading-relaxed">{item.dont}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Right column — summary + vocabulary */}
      <div className="space-y-4">

        {/* Voice summary */}
        {doc.voice_summary && (
          <div className="bg-[#EAF3DE] border border-[#C0DD97] rounded-[10px] p-5">
            <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-brand-green-success mb-2">
              Voice summary
            </p>
            <p className="text-[13px] font-medium text-brand-green leading-relaxed">
              {doc.voice_summary}
            </p>
          </div>
        )}

        {/* Style note */}
        {doc.voice_style_note && (
          <div className="bg-[#FEF7E6] border border-[#F0D080] rounded-[10px] p-4">
            <p className="text-[10px] uppercase tracking-[0.07em] text-[#7A4800] mb-1">Style note</p>
            <p className="text-[12px] text-[#7A4800] leading-relaxed">{doc.voice_style_note}</p>
          </div>
        )}

        {/* Vocabulary */}
        {doc.vocabulary && (
          <div className="bg-surface-card border border-border-card rounded-[10px] p-5">
            <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-4">
              Vocabulary
            </p>
            <div className="space-y-4">
              {doc.vocabulary.words_they_use && doc.vocabulary.words_they_use.length > 0 && (
                <div>
                  <p className="text-[9px] uppercase tracking-[0.07em] text-text-muted mb-2">
                    Use
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {doc.vocabulary.words_they_use.map((word, i) => (
                      <span
                        key={i}
                        className="text-[11px] font-medium text-brand-green bg-[#EAF3DE] px-2 py-0.5 rounded-full"
                      >
                        {word}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {doc.vocabulary.words_to_avoid && doc.vocabulary.words_to_avoid.length > 0 && (
                <div>
                  <p className="text-[9px] uppercase tracking-[0.07em] text-text-muted mb-2">
                    Avoid
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {doc.vocabulary.words_to_avoid.map((word, i) => (
                      <span
                        key={i}
                        className="text-[11px] font-medium text-[#8B2020] bg-[#FDEEE8] px-2 py-0.5 rounded-full"
                      >
                        {word}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {doc.vocabulary.structural_patterns &&
                doc.vocabulary.structural_patterns.length > 0 && (
                  <div>
                    <p className="text-[9px] uppercase tracking-[0.07em] text-text-muted mb-1.5">
                      Patterns
                    </p>
                    <ul className="space-y-1">
                      {doc.vocabulary.structural_patterns.map((p, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="text-text-muted shrink-0 mt-0.5">·</span>
                          <span className="text-[12px] text-text-primary leading-relaxed">{p}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
            </div>
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
