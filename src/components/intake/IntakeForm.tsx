'use client'

// The intake questionnaire — all 5 sections, one page at a time.
// Auto-saves each field on blur. Checks word count on critical long-text fields.
// Currency selector dynamically updates revenue range options.
// Fully responsive — tested for iPhone Safari (inputs use 16px to prevent iOS zoom).
// See prd/sections/05-intake.md for the full question set and rules.

import { useState, useCallback, useTransition } from 'react'
import { saveIntakeResponse } from '@/app/intake/actions'

// ─── Types ───────────────────────────────────────────────────────────────────

type FieldType = 'short' | 'long' | 'select' | 'currency'

interface Question {
  fieldKey: string
  label: string
  isCritical: boolean
  type: FieldType
  options?: string[]
  getOptions?: (values: Record<string, string>) => string[]
  dictation?: boolean
}

interface Section {
  id: string
  title: string
  questions: Question[]
}

// ─── Currency helpers ────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS: Record<string, string> = { GBP: '£', EUR: '€', USD: '$' }

const revenueOptions = (values: Record<string, string>): string[] => {
  const sym = CURRENCY_SYMBOLS[values['company_currency']] ?? '£'
  return [
    `Under ${sym}100K`,
    `${sym}100K–${sym}300K`,
    `${sym}300K–${sym}600K`,
    `${sym}600K–${sym}1M`,
    `${sym}1M–${sym}2M`,
    `Over ${sym}2M`,
  ]
}

// ─── Question definitions ────────────────────────────────────────────────────

const SECTIONS: Section[] = [
  {
    id: 'company',
    title: 'Your business',
    questions: [
      {
        fieldKey: 'company_name',
        label: "What's your company name?",
        isCritical: true,
        type: 'short',
      },
      {
        fieldKey: 'company_url',
        label: "What's your website URL?",
        isCritical: false,
        type: 'short',
      },
      {
        fieldKey: 'company_currency',
        label: 'What currency do you work in?',
        isCritical: true,
        type: 'currency',
        options: ['GBP', 'EUR', 'USD'],
      },
      {
        fieldKey: 'company_revenue_range',
        label: "What's your current annual revenue range?",
        isCritical: true,
        type: 'select',
        getOptions: revenueOptions,
      },
      {
        fieldKey: 'company_what_you_do',
        label: 'Who do you help and what problem do you solve for them?',
        isCritical: true,
        type: 'long',
        dictation: true,
      },
      {
        fieldKey: 'company_years_operating',
        label: 'How long have you been operating?',
        isCritical: true,
        type: 'short',
      },
      {
        fieldKey: 'company_differentiators',
        label: "What makes your firm genuinely different from others who do what you do? Not the marketing answer — the real one.",
        isCritical: true,
        type: 'long',
        dictation: true,
      },
    ],
  },
  {
    id: 'clients',
    title: 'Your clients',
    questions: [
      {
        fieldKey: 'clients_clone',
        label: "Think about your single best client — the one you'd clone if you could. Describe them. Not their job title. What makes them different to work with? What do they believe or understand that most of your clients don't?",
        isCritical: true,
        type: 'long',
        dictation: true,
      },
      {
        fieldKey: 'clients_trigger',
        label: "When your best clients first came to you, what was happening in their business? What had changed, broken, or become urgent enough that they finally did something?",
        isCritical: true,
        type: 'long',
        dictation: true,
      },
      {
        fieldKey: 'clients_how_found',
        label: "Walk me through how your last best client found you. Start from the beginning — how did they first become aware you existed?",
        isCritical: true,
        type: 'long',
        dictation: true,
      },
      {
        fieldKey: 'clients_what_tipped',
        label: "What do you think actually tipped them toward working with you? Not the polished answer — the real one. Was there a specific conversation, a moment, something you said or showed them?",
        isCritical: true,
        type: 'long',
        dictation: true,
      },
      {
        fieldKey: 'clients_channel',
        label: "Do your best clients typically come from referrals, inbound, or outbound? What does that usually look like in practice?",
        isCritical: true,
        type: 'long',
      },
    ],
  },
  {
    id: 'offer',
    title: 'Your offer',
    questions: [
      {
        fieldKey: 'offer_structure',
        label: "How does your service actually work? What does a client buy and what does the engagement look like?",
        isCritical: true,
        type: 'long',
      },
      {
        fieldKey: 'offer_price',
        label: "What's the price point or range for your core offer?",
        isCritical: true,
        type: 'short',
      },
      {
        fieldKey: 'offer_length',
        label: 'How long does a typical engagement last?',
        isCritical: true,
        type: 'short',
      },
      {
        fieldKey: 'offer_deliverables',
        label: "What does a client actually get? Deliverables, outputs, access — what exists at the end that didn't before?",
        isCritical: true,
        type: 'long',
        dictation: true,
      },
    ],
  },
  {
    id: 'voice',
    title: 'Your voice',
    questions: [
      {
        fieldKey: 'voice_samples',
        label: "Paste 3–5 examples of how you write naturally. Emails, LinkedIn posts, messages to clients — the more unpolished the better. We're looking for your real voice, not your best work.",
        isCritical: true,
        type: 'long',
      },
      {
        fieldKey: 'voice_style',
        label: 'How would you describe your communication style in your own words?',
        isCritical: false,
        type: 'long',
      },
      {
        fieldKey: 'voice_dislikes',
        label: "Is there anything you hate seeing in business communication? Phrases, styles, tones that make you cringe.",
        isCritical: false,
        type: 'long',
      },
    ],
  },
  {
    id: 'assets',
    title: 'Existing assets',
    questions: [
      {
        fieldKey: 'assets_website',
        label: "What's your website URL? We'll read it as part of building your strategy.",
        isCritical: false,
        type: 'short',
      },
      {
        fieldKey: 'assets_existing_positioning',
        label: "Is there any positioning or messaging you currently use that you'd like us to know about? Could be a tagline, an about page, a pitch you've used.",
        isCritical: false,
        type: 'long',
      },
      {
        fieldKey: 'assets_past_outreach',
        label: "Have you tried outbound before? What worked and what didn't? Even partial attempts count.",
        isCritical: false,
        type: 'long',
      },
    ],
  },
]

const ALL_QUESTIONS = SECTIONS.flatMap(s => s.questions)
const CRITICAL_COUNT = ALL_QUESTIONS.filter(q => q.isCritical).length // 16
const THRESHOLD = Math.ceil(CRITICAL_COUNT * 0.8) // 13

// Shared input classes — 16px font size prevents iOS Safari from zooming on focus
const inputBase =
  'w-full px-3 py-3 text-[16px] sm:text-xs text-text-primary bg-surface-content border border-border-card rounded-[6px] focus:outline-none focus:border-brand-green-accent transition-colors'

// ─── Component ───────────────────────────────────────────────────────────────

interface IntakeFormProps {
  initialValues: Record<string, { value: string; wordCount: number }>
}

export default function IntakeForm({ initialValues }: IntakeFormProps) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(initialValues).map(([k, v]) => [k, v.value]))
  )
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set(Object.keys(initialValues)))
  const [shortAnswerKeys, setShortAnswerKeys] = useState<Set<string>>(new Set())
  const [activeSection, setActiveSection] = useState(SECTIONS[0].id)
  const [, startTransition] = useTransition()

  const criticalAnswered = ALL_QUESTIONS.filter(
    q => q.isCritical && (values[q.fieldKey] ?? '').trim().length > 0
  ).length

  const sectionFor = (fieldKey: string) =>
    SECTIONS.find(s => s.questions.some(q => q.fieldKey === fieldKey))?.id ?? ''

  const save = useCallback((question: Question, value: string) => {
    startTransition(async () => {
      const result = await saveIntakeResponse(
        question.fieldKey,
        question.label,
        value,
        question.isCritical,
        sectionFor(question.fieldKey)
      )
      if (result?.success) {
        setSavedKeys(prev => new Set(prev).add(question.fieldKey))
      }
    })
  }, [])

  const handleBlur = useCallback((question: Question) => {
    const value = values[question.fieldKey] ?? ''
    const trimmed = value.trim()

    if (question.isCritical && question.type === 'long') {
      const wordCount = trimmed.split(/\s+/).filter(Boolean).length
      if (trimmed && wordCount < 20) {
        setShortAnswerKeys(prev => new Set(prev).add(question.fieldKey))
      } else {
        setShortAnswerKeys(prev => {
          const next = new Set(prev)
          next.delete(question.fieldKey)
          return next
        })
      }
    }

    save(question, value)
  }, [values, save])

  const handleChange = useCallback((fieldKey: string, value: string) => {
    setValues(prev => ({ ...prev, [fieldKey]: value }))
    setSavedKeys(prev => {
      const next = new Set(prev)
      next.delete(fieldKey)
      return next
    })
  }, [])

  // Currency and select fields save immediately on change (no blur needed)
  const handleSelectChange = useCallback((question: Question, value: string) => {
    setValues(prev => ({ ...prev, [question.fieldKey]: value }))
    setSavedKeys(prev => {
      const next = new Set(prev)
      next.delete(question.fieldKey)
      return next
    })
    save(question, value)
  }, [save])

  const sectionComplete = (section: Section) =>
    section.questions
      .filter(q => q.isCritical)
      .every(q => (values[q.fieldKey] ?? '').trim().length > 0)

  const currentIndex = SECTIONS.findIndex(s => s.id === activeSection)

  return (
    <div className="min-h-screen bg-surface-shell">
      <div className="w-full max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12">

        {/* Header */}
        <div className="mb-8">
          <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-1">
            MargenticOS
          </p>
          <h1 className="text-[18px] font-medium text-text-primary mb-2">
            Tell us about your business
          </h1>
          <p className="text-xs text-text-secondary">
            {criticalAnswered >= THRESHOLD
              ? "You've answered enough to generate your strategy documents."
              : `Answer ${THRESHOLD - criticalAnswered} more ${THRESHOLD - criticalAnswered === 1 ? 'question' : 'questions'} to unlock document generation.`}
          </p>
        </div>

        {/* Dictation prompt */}
        <div className="mb-8 px-4 py-4 bg-surface-card border border-border-card rounded-[10px]">
          <p className="text-xs font-medium text-text-primary mb-2">Before you start</p>
          <p className="text-xs text-text-secondary leading-relaxed mb-3">
            The quality of your strategy documents depends entirely on what you put in here.
            Thin answers produce generic documents.
          </p>
          <p className="text-xs text-text-secondary leading-relaxed mb-3">
            If you can, speak your answers rather than type them — people say 3x more when
            talking than typing, and that extra detail is what makes the difference.
            We recommend <span className="text-text-primary">Wispr Flow</span> for Mac users:{' '}
            <span className="text-text-primary">wisprflow.ai</span>
          </p>
          <p className="text-xs text-text-secondary">
            Don&apos;t edit yourself. Raw and honest beats neat and vague every time.
          </p>
        </div>

        {/* Section nav */}
        <div className="flex gap-2 mb-6 flex-wrap">
          {SECTIONS.map(section => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={[
                'px-3 py-1.5 text-[11px] sm:text-[10px] font-medium rounded-[20px] border transition-colors min-h-[36px] touch-manipulation',
                activeSection === section.id
                  ? 'bg-brand-green text-[#F5F0E8] border-brand-green'
                  : sectionComplete(section)
                  ? 'bg-[#EBF5E6] text-[#2B5A1E] border-[#BDDAB0]'
                  : 'bg-surface-card text-text-secondary border-border-card',
              ].join(' ')}
            >
              {section.title}
              {sectionComplete(section) && activeSection !== section.id && ' ✓'}
            </button>
          ))}
        </div>

        {/* Active section */}
        {SECTIONS.map(section => (
          <div
            key={section.id}
            className={section.id === activeSection ? 'block' : 'hidden'}
          >
            <div className="space-y-4 sm:space-y-6">
              {section.questions.map(question => {
                const opts = question.getOptions
                  ? question.getOptions(values)
                  : question.options ?? []

                return (
                  <div
                    key={question.fieldKey}
                    className="bg-surface-card border border-border-card rounded-[10px] p-4 sm:p-5"
                  >
                    {/* Label */}
                    <label className="block text-xs font-medium text-text-primary mb-1 leading-relaxed">
                      {question.label}
                      {question.isCritical && (
                        <span className="ml-1 text-text-muted font-normal">*</span>
                      )}
                    </label>

                    {/* Dictation nudge */}
                    {question.dictation && (
                      <p className="text-[10px] text-text-muted mb-3">
                        Speak this one if you can — it&apos;ll take 60 seconds and give us much more to work with.
                      </p>
                    )}

                    {/* Short text */}
                    {question.type === 'short' && (
                      <input
                        type="text"
                        value={values[question.fieldKey] ?? ''}
                        onChange={e => handleChange(question.fieldKey, e.target.value)}
                        onBlur={() => handleBlur(question)}
                        className={inputBase}
                      />
                    )}

                    {/* Long text */}
                    {question.type === 'long' && (
                      <textarea
                        value={values[question.fieldKey] ?? ''}
                        onChange={e => handleChange(question.fieldKey, e.target.value)}
                        onBlur={() => handleBlur(question)}
                        rows={5}
                        className={`${inputBase} resize-none`}
                      />
                    )}

                    {/* Currency selector */}
                    {question.type === 'currency' && (
                      <div className="flex gap-2">
                        {opts.map(opt => (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => handleSelectChange(question, opt)}
                            className={[
                              'flex-1 py-2.5 text-xs font-medium rounded-[6px] border transition-colors min-h-[44px] touch-manipulation',
                              values[question.fieldKey] === opt
                                ? 'bg-brand-green text-[#F5F0E8] border-brand-green'
                                : 'bg-surface-content text-text-secondary border-border-card',
                            ].join(' ')}
                          >
                            {opt} {CURRENCY_SYMBOLS[opt]}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Standard select */}
                    {question.type === 'select' && (
                      <select
                        value={values[question.fieldKey] ?? ''}
                        onChange={e => handleSelectChange(question, e.target.value)}
                        className={inputBase}
                      >
                        <option value="">Select one</option>
                        {opts.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    )}

                    {/* Short answer follow-up */}
                    {shortAnswerKeys.has(question.fieldKey) && (
                      <div className="mt-3 px-3 py-2 bg-[#FEF7E6] border border-[#F0D080] rounded-[6px]">
                        <p className="text-xs text-[#7A4800]">
                          That&apos;s a short answer for a critical question — can you add a bit more? Even two or three more sentences will help.
                        </p>
                      </div>
                    )}

                    {/* Saved indicator */}
                    {savedKeys.has(question.fieldKey) && (values[question.fieldKey] ?? '').trim() && (
                      <p className="mt-1.5 text-[10px] text-text-muted">Saved</p>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Section navigation */}
            <div className="flex justify-between mt-6 sm:mt-8">
              {currentIndex > 0 ? (
                <button
                  onClick={() => setActiveSection(SECTIONS[currentIndex - 1].id)}
                  className="px-5 py-2.5 text-xs text-text-secondary border border-border-card rounded-[20px] min-h-[44px] touch-manipulation"
                >
                  Back
                </button>
              ) : <div />}

              {currentIndex < SECTIONS.length - 1 ? (
                <button
                  onClick={() => setActiveSection(SECTIONS[currentIndex + 1].id)}
                  className="px-5 py-2.5 text-xs font-medium text-[#F5F0E8] bg-brand-green rounded-[20px] hover:opacity-90 transition-opacity min-h-[44px] touch-manipulation"
                >
                  Next
                </button>
              ) : (
                <button
                  className="px-5 py-2.5 text-xs font-medium text-[#F5F0E8] bg-brand-green rounded-[20px] hover:opacity-90 transition-opacity min-h-[44px] touch-manipulation"
                >
                  Done
                </button>
              )}
            </div>
          </div>
        ))}

        {/* Footer */}
        <p className="mt-8 sm:mt-10 text-[10px] text-text-muted text-center">
          Your answers save automatically. You can come back and update them any time.
        </p>

      </div>
    </div>
  )
}
