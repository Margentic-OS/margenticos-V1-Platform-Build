'use client'

// The intake questionnaire — all 5 sections, one page at a time.
// Auto-saves each field on blur. Checks word count on critical long-text fields.
// Currency selector dynamically updates revenue range options.
// Fully responsive — tested for iPhone Safari (inputs use 16px to prevent iOS zoom).
// See prd/sections/05-intake.md for the full question set and rules.

import { useState, useCallback, useTransition, useRef } from 'react'
import Link from 'next/link'
import { saveIntakeResponse } from '@/app/intake/actions'
import type { IntakeFileRecord } from '@/app/intake/actions'
import FileUploadSection from './FileUploadSection'

// Question definitions live in src/lib/intake/questions.ts so the server can import the
// same list. See that file for why the denominator must not come from stored rows.
import {
  SECTIONS,
  ALL_QUESTIONS,
  CRITICAL_COUNT,
  THRESHOLD,
  CURRENCY_SYMBOLS,
  CURRENCY_FIELD_KEY,
  REVENUE_FIELD_KEY,
  reconcileRevenueRange,
  type Question,
  type Section,
} from '@/lib/intake/questions'

// Shared input classes — 16px font size prevents iOS Safari from zooming on focus
const inputBase =
  'w-full px-3 py-3 text-[16px] sm:text-xs text-text-primary bg-surface-content border border-border-card rounded-[6px] focus:outline-none focus:border-brand-green-accent transition-colors'

// ─── Component ───────────────────────────────────────────────────────────────

interface IntakeFormProps {
  initialValues: Record<string, { value: string; wordCount: number }>
  initialFiles: IntakeFileRecord[]
}

export default function IntakeForm({ initialValues, initialFiles }: IntakeFormProps) {
  // If the client already crossed the threshold in a previous session, start in
  // succeeded state so the button shows "Continue to dashboard" immediately.
  const initialCriticalAnswered = ALL_QUESTIONS.filter(
    q => q.isCritical && (initialValues[q.fieldKey]?.value ?? '').trim().length > 0
  ).length
  const alreadyDispatched = initialCriticalAnswered >= THRESHOLD

  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(initialValues).map(([k, v]) => [k, v.value]))
  )
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set(Object.keys(initialValues)))
  const [shortAnswerKeys, setShortAnswerKeys] = useState<Set<string>>(new Set())
  const [activeSection, setActiveSection] = useState(SECTIONS[0].id)
  const [, startTransition] = useTransition()
  const [dispatchStatus, setDispatchStatus] = useState<'idle' | 'pending' | 'succeeded' | 'failed'>(
    alreadyDispatched ? 'succeeded' : 'idle'
  )
  const [voiceTab, setVoiceTab] = useState<'upload' | 'type'>('upload')
  const hasDispatchedRef = useRef(alreadyDispatched)

  // Called by the "Generate my strategy documents" button only.
  // The server route has its own idempotency guard (agents_dispatched_at).
  function fireDispatch() {
    if (hasDispatchedRef.current) return
    hasDispatchedRef.current = true
    setDispatchStatus('pending')
    fetch('/api/intake/complete', { method: 'POST' })
      .then(res => {
        if (res.ok) {
          setDispatchStatus('succeeded')
        } else {
          hasDispatchedRef.current = false
          setDispatchStatus('failed')
        }
      })
      .catch(() => {
        hasDispatchedRef.current = false
        setDispatchStatus('failed')
      })
  }

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

  const triggerWebsiteFetch = useCallback((url: string) => {
    const trimmed = url.trim()
    if (!trimmed) return
    // Fire-and-forget — fetch runs server-side, result visible on next agent run.
    fetch('/api/intake/website/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: trimmed }),
    }).catch(() => {
      // Non-fatal — agents proceed with whatever was fetched previously.
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

    if (question.fieldKey === 'company_url') {
      triggerWebsiteFetch(value)
    }
  }, [values, save, triggerWebsiteFetch])

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
    const newValues = { ...values, [question.fieldKey]: value }
    setValues(newValues)
    setSavedKeys(prev => {
      const next = new Set(prev)
      next.delete(question.fieldKey)
      return next
    })
    save(question, value)

    // Changing the currency rebuilds the revenue options, so the stored revenue answer
    // carries a symbol that no longer appears in the list. The <select> then falls back to
    // the placeholder while the row keeps the old answer, which is how a row ends up saying
    // one currency and its revenue band another. Re-symbolise the same band where the answer
    // is recognisable, and clear it where it is not, saving either way so the stored value
    // and what the client sees cannot disagree.
    if (question.fieldKey === CURRENCY_FIELD_KEY) {
      const revenueQuestion = ALL_QUESTIONS.find(q => q.fieldKey === REVENUE_FIELD_KEY)
      if (!revenueQuestion) return
      const stored = values[REVENUE_FIELD_KEY] ?? ''
      if (!stored) return
      const reconciled = reconcileRevenueRange(stored, value)
      if (reconciled === stored) return
      setValues(prev => ({ ...prev, [REVENUE_FIELD_KEY]: reconciled }))
      setSavedKeys(prev => {
        const next = new Set(prev)
        next.delete(REVENUE_FIELD_KEY)
        return next
      })
      save(revenueQuestion, reconciled)
    }
  }, [save, values])

  const sectionComplete = (section: Section) =>
    section.questions
      .filter(q => q.isCritical)
      .every(q => (values[q.fieldKey] ?? '').trim().length > 0)

  const sectionHasCriticalFields = (section: Section) =>
    section.questions.some(q => q.isCritical)

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
            We recommend using a dictation tool to make this easier.
          </p>
          <p className="text-xs text-text-secondary">
            Don&apos;t edit yourself. Raw and honest beats neat and vague every time.
          </p>
        </div>

        {/* Section nav */}
        <div className="flex gap-2 mb-6 flex-wrap">
          {SECTIONS.map(section => {
            const hasCritical = sectionHasCriticalFields(section)
            const isComplete = sectionComplete(section)
            return (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={[
                  'px-3 py-1.5 text-[11px] sm:text-[10px] font-medium rounded-[20px] border transition-colors min-h-[44px] touch-manipulation',
                  activeSection === section.id
                    ? 'bg-brand-green text-[#F5F0E8] border-brand-green'
                    : !hasCritical
                    ? 'bg-[#F0ECE4] text-[#9A9488] border-[#E8E2D8]'
                    : isComplete
                    ? 'bg-[#EBF5E6] text-[#2B5A1E] border-[#BDDAB0]'
                    : 'bg-surface-card text-text-secondary border-border-card',
                ].join(' ')}
              >
                <span>{section.title}</span>
                {!hasCritical && activeSection !== section.id && (
                  <span className="ml-1.5 text-[9px] font-normal text-[#9A9488]">Optional</span>
                )}
                {hasCritical && isComplete && activeSection !== section.id && ' ✓'}
              </button>
            )
          })}
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

                    {/* Help text */}
                    {question.helpText && (
                      <p className="text-[11px] text-text-muted mb-2 leading-relaxed">
                        {question.helpText}
                      </p>
                    )}

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

            {/* Voice samples — upload or type, voice section only */}
            {section.id === 'voice' && (
              <div className="mt-4 sm:mt-6">
                <p className="text-xs font-medium text-text-primary mb-1">
                  Voice samples
                  <span className="ml-1.5 text-[10px] font-normal text-text-muted">(optional)</span>
                </p>
                <p className="text-[11px] text-text-secondary mb-3">
                  Paste emails, proposals, or LinkedIn posts you have written. The more you share, the more accurately the voice guide reflects how you actually communicate.
                </p>

                {/* Tab toggles */}
                <div className="flex gap-1 mb-3 p-1 bg-[#F0ECE4] rounded-[8px] w-fit">
                  {(['upload', 'type'] as const).map(tab => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setVoiceTab(tab)}
                      className={[
                        'px-3 py-1.5 text-[11px] font-medium rounded-[6px] transition-colors',
                        voiceTab === tab
                          ? 'bg-white text-text-primary shadow-sm'
                          : 'text-text-secondary hover:text-text-primary',
                      ].join(' ')}
                    >
                      {tab === 'upload' ? 'Upload files' : 'Type your voice'}
                    </button>
                  ))}
                </div>

                {voiceTab === 'upload' ? (
                  <FileUploadSection initialFiles={initialFiles} />
                ) : (
                  <div>
                    <textarea
                      rows={8}
                      placeholder="Paste emails, proposals, posts, or any writing that sounds like you…"
                      className={`${inputBase} resize-y`}
                      value={values['voice_typed_samples'] ?? ''}
                      onChange={e => handleChange('voice_typed_samples', e.target.value)}
                      onBlur={() => {
                        const value = values['voice_typed_samples'] ?? ''
                        startTransition(async () => {
                          await saveIntakeResponse(
                            'voice_typed_samples',
                            'Voice samples (typed)',
                            value,
                            false,
                            'voice'
                          )
                          if (value.trim()) {
                            setSavedKeys(prev => new Set(prev).add('voice_typed_samples'))
                          }
                        })
                      }}
                    />
                    {savedKeys.has('voice_typed_samples') && (values['voice_typed_samples'] ?? '').trim() && (
                      <p className="mt-1.5 text-[10px] text-text-muted">Saved</p>
                    )}
                  </div>
                )}
              </div>
            )}

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
                <div className="flex flex-col items-end gap-2 w-full">
                  {dispatchStatus === 'succeeded' ? (
                    <div className="w-full bg-[#EBF5E6] border border-[#C2E0B8] rounded-[10px] px-5 py-4">
                      <p className="text-[13px] font-medium text-[#1C4A0E] mb-1">
                        Building your strategy documents
                      </p>
                      <p className="text-[12px] text-[#3B6D11] mb-3">
                        This takes 3-5 minutes. You can close this tab. Documents will be waiting when you return.
                      </p>
                      <Link
                        href="/dashboard"
                        className="inline-flex items-center gap-1.5 text-[12px] font-medium text-brand-green hover:opacity-80 transition-opacity"
                      >
                        Continue to dashboard
                        <span aria-hidden="true">→</span>
                      </Link>
                    </div>
                  ) : (
                    <>
                      {dispatchStatus === 'failed' && (
                        <p className="text-[11px] text-[#C0392B]">
                          Submission failed. Check your connection and try again.
                        </p>
                      )}
                      <button
                        disabled={criticalAnswered < THRESHOLD || dispatchStatus === 'pending'}
                        onClick={() => {
                          if (dispatchStatus === 'failed') hasDispatchedRef.current = false
                          fireDispatch()
                        }}
                        className={`px-5 py-2.5 text-xs font-medium rounded-[20px] min-h-[44px] touch-manipulation transition-opacity ${
                          criticalAnswered < THRESHOLD
                            ? 'text-text-muted bg-[#F0ECE4] cursor-not-allowed'
                            : dispatchStatus === 'pending'
                            ? 'text-[rgba(245,240,232,0.50)] bg-brand-green opacity-60 cursor-not-allowed'
                            : 'text-[#F5F0E8] bg-brand-green hover:opacity-90'
                        }`}
                      >
                        {dispatchStatus === 'pending'
                          ? 'Building your documents…'
                          : dispatchStatus === 'failed'
                          ? 'Retry'
                          : criticalAnswered < THRESHOLD
                          ? 'Answer the required questions above to unlock'
                          : 'Generate my strategy documents'}
                      </button>
                    </>
                  )}
                </div>
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
