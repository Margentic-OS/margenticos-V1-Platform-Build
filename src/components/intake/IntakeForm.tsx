'use client'

// The intake questionnaire — all 5 sections on one page.
// Auto-saves each field on blur. Checks word count on critical long-text fields.
// See prd/sections/05-intake.md for the full question set and rules.

import { useState, useCallback, useTransition } from 'react'
import { saveIntakeResponse } from '@/app/intake/actions'

// ─── Question definitions ────────────────────────────────────────────────────

type FieldType = 'short' | 'long' | 'select'

interface Question {
  fieldKey: string
  label: string
  isCritical: boolean
  type: FieldType
  options?: string[]
  dictation?: boolean
}

interface Section {
  id: string
  title: string
  questions: Question[]
}

const SECTIONS: Section[] = [
  {
    id: 'company',
    title: 'Your business',
    questions: [
      {
        fieldKey: 'company_name',
        label: "What's your company name and website URL?",
        isCritical: true,
        type: 'short',
      },
      {
        fieldKey: 'company_what_you_do',
        label: "What does your business do — in plain English, not your website version?",
        isCritical: true,
        type: 'long',
        dictation: true,
      },
      {
        fieldKey: 'company_years_operating',
        label: "How long have you been operating?",
        isCritical: true,
        type: 'short',
      },
      {
        fieldKey: 'company_revenue_range',
        label: "What's your current annual revenue range?",
        isCritical: true,
        type: 'select',
        options: ['Under £100K', '£100K–£300K', '£300K–£600K', '£600K–£1M', '£1M–£2M', 'Over £2M'],
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
        label: "What exactly are you selling? Describe the service or engagement structure as you'd explain it to someone who's never heard of you.",
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
        label: "How long does a typical engagement last?",
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

const CRITICAL_COUNT = SECTIONS.flatMap(s => s.questions).filter(q => q.isCritical).length // 15
const THRESHOLD = Math.ceil(CRITICAL_COUNT * 0.8) // 12

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

  const criticalAnswered = SECTIONS
    .flatMap(s => s.questions)
    .filter(q => q.isCritical && (values[q.fieldKey] ?? '').trim().split(/\s+/).filter(Boolean).length >= 1)
    .length

  const handleBlur = useCallback((question: Question) => {
    const value = values[question.fieldKey] ?? ''
    const trimmed = value.trim()

    // Check word count for critical long-text fields
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

    // Auto-save on blur
    startTransition(async () => {
      const result = await saveIntakeResponse(
        question.fieldKey,
        question.label,
        value,
        question.isCritical,
        SECTIONS.find(s => s.questions.some(q => q.fieldKey === question.fieldKey))?.id ?? ''
      )
      if (result?.success) {
        setSavedKeys(prev => new Set(prev).add(question.fieldKey))
      }
    })
  }, [values])

  const handleChange = useCallback((fieldKey: string, value: string) => {
    setValues(prev => ({ ...prev, [fieldKey]: value }))
    // Clear saved indicator when user edits again
    setSavedKeys(prev => {
      const next = new Set(prev)
      next.delete(fieldKey)
      return next
    })
  }, [])

  const sectionComplete = (section: Section) =>
    section.questions
      .filter(q => q.isCritical)
      .every(q => (values[q.fieldKey] ?? '').trim().length > 0)

  return (
    <div className="min-h-screen bg-surface-shell">
      <div className="max-w-2xl mx-auto px-6 py-12">

        {/* Header */}
        <div className="mb-10">
          <p className="text-[10px] font-normal uppercase tracking-[0.07em] text-text-secondary mb-1">
            MargenticOS
          </p>
          <h1 className="text-[18px] font-medium text-text-primary mb-2">
            Tell us about your business
          </h1>
          <p className="text-xs text-text-secondary">
            {criticalAnswered >= THRESHOLD
              ? `You've answered enough to generate your strategy documents.`
              : `Answer ${THRESHOLD - criticalAnswered} more ${THRESHOLD - criticalAnswered === 1 ? 'question' : 'questions'} to unlock document generation.`}
          </p>
        </div>

        {/* Dictation prompt */}
        <div className="mb-8 px-4 py-4 bg-surface-card border border-border-card rounded-[10px]">
          <p className="text-xs text-text-primary font-medium mb-1">A note before you start</p>
          <p className="text-xs text-text-secondary leading-relaxed">
            These questions are designed to get the real story — not the polished version.
            Your answers will be better if you speak them rather than type them.{' '}
            <span className="text-text-primary">On your phone:</span> tap the microphone icon on your keyboard.{' '}
            <span className="text-text-primary">On desktop:</span> right-click any text field and look for voice input.
            Raw and honest beats neat and vague every time.
          </p>
        </div>

        {/* Section nav */}
        <div className="flex gap-2 mb-8 flex-wrap">
          {SECTIONS.map(section => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={[
                'px-3 py-1 text-[10px] font-medium rounded-[20px] border transition-colors',
                activeSection === section.id
                  ? 'bg-brand-green text-[#F5F0E8] border-brand-green'
                  : sectionComplete(section)
                  ? 'bg-[#EBF5E6] text-[#2B5A1E] border-[#BDDAB0]'
                  : 'bg-surface-card text-text-secondary border-border-card hover:border-brand-green-accent',
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
            <div className="space-y-6">
              {section.questions.map(question => (
                <div key={question.fieldKey} className="bg-surface-card border border-border-card rounded-[10px] p-5">

                  {/* Label */}
                  <label className="block text-xs font-medium text-text-primary mb-1 leading-relaxed">
                    {question.label}
                    {question.isCritical && (
                      <span className="ml-1 text-[#9A9488] font-normal">*</span>
                    )}
                  </label>

                  {/* Dictation nudge */}
                  {question.dictation && (
                    <p className="text-[10px] text-text-muted mb-3">
                      Speak this one if you can — it&apos;ll take 60 seconds and give us much more to work with.
                    </p>
                  )}

                  {/* Input */}
                  {question.type === 'short' && (
                    <input
                      type="text"
                      value={values[question.fieldKey] ?? ''}
                      onChange={e => handleChange(question.fieldKey, e.target.value)}
                      onBlur={() => handleBlur(question)}
                      className="w-full px-3 py-2 text-xs text-text-primary bg-surface-content border border-border-card rounded-[6px] placeholder:text-text-muted focus:outline-none focus:border-brand-green-accent transition-colors"
                    />
                  )}

                  {question.type === 'long' && (
                    <textarea
                      value={values[question.fieldKey] ?? ''}
                      onChange={e => handleChange(question.fieldKey, e.target.value)}
                      onBlur={() => handleBlur(question)}
                      rows={5}
                      className="w-full px-3 py-2 text-xs text-text-primary bg-surface-content border border-border-card rounded-[6px] placeholder:text-text-muted focus:outline-none focus:border-brand-green-accent transition-colors resize-none"
                    />
                  )}

                  {question.type === 'select' && (
                    <select
                      value={values[question.fieldKey] ?? ''}
                      onChange={e => {
                        handleChange(question.fieldKey, e.target.value)
                      }}
                      onBlur={() => handleBlur(question)}
                      className="w-full px-3 py-2 text-xs text-text-primary bg-surface-content border border-border-card rounded-[6px] focus:outline-none focus:border-brand-green-accent transition-colors"
                    >
                      <option value="">Select one</option>
                      {question.options?.map(opt => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  )}

                  {/* Short answer follow-up prompt */}
                  {shortAnswerKeys.has(question.fieldKey) && (
                    <div className="mt-3 px-3 py-2 bg-[#FEF7E6] border border-[#F0D080] rounded-[6px]">
                      <p className="text-[11px] text-[#7A4800]">
                        That&apos;s a short answer for a critical question — can you add a bit more? Even two or three more sentences will help.
                      </p>
                    </div>
                  )}

                  {/* Saved indicator */}
                  {savedKeys.has(question.fieldKey) && (values[question.fieldKey] ?? '').trim() && (
                    <p className="mt-1.5 text-[10px] text-text-muted">Saved</p>
                  )}

                </div>
              ))}
            </div>

            {/* Section navigation */}
            <div className="flex justify-between mt-8">
              {SECTIONS.findIndex(s => s.id === section.id) > 0 ? (
                <button
                  onClick={() => setActiveSection(SECTIONS[SECTIONS.findIndex(s => s.id === section.id) - 1].id)}
                  className="px-4 py-2 text-xs text-text-secondary border border-border-card rounded-[20px] hover:border-brand-green-accent transition-colors"
                >
                  Back
                </button>
              ) : <div />}

              {SECTIONS.findIndex(s => s.id === section.id) < SECTIONS.length - 1 && (
                <button
                  onClick={() => setActiveSection(SECTIONS[SECTIONS.findIndex(s => s.id === section.id) + 1].id)}
                  className="px-4 py-2 text-xs font-medium text-[#F5F0E8] bg-brand-green rounded-[20px] hover:opacity-90 transition-opacity"
                >
                  Next
                </button>
              )}

              {SECTIONS.findIndex(s => s.id === section.id) === SECTIONS.length - 1 && (
                <button
                  onClick={() => {/* submit handled — all saves are auto */}}
                  className="px-4 py-2 text-xs font-medium text-[#F5F0E8] bg-brand-green rounded-[20px] hover:opacity-90 transition-opacity"
                >
                  Done
                </button>
              )}
            </div>
          </div>
        ))}

        {/* Footer note */}
        <p className="mt-10 text-[10px] text-text-muted text-center">
          Your answers save automatically. You can come back and update them any time.
        </p>

      </div>
    </div>
  )
}
