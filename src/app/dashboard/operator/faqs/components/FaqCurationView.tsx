'use client'

// FAQ curation view — two surfaces on one page:
//   Left (or top on narrow): extraction queue — pending faq_extractions to curate.
//   Right (or bottom): knowledge base — all approved/archived FAQs for this client.
//
// Polling: 30s interval on extractions only (FAQs change only through operator action).
// Polling pauses when tab is hidden, resumes on visibility.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ExtractionCard, type ExtractionInFlight } from './ExtractionCard'
import { ExtractionCardSkeleton } from './ExtractionCardSkeleton'
import { FaqRow } from './FaqRow'
import type { ExtractionItem, FaqListItem } from './types'
import { logger } from '@/lib/logger'

const POLL_INTERVAL_MS = 30_000

interface ExtractionCardState {
  inFlight: ExtractionInFlight
  actionError: string | null
}

interface FaqCurationViewProps {
  orgId: string
  orgName: string
}

// ── Add FAQ form ────────────────────────────────────────────────────────────────

interface AddFaqFormProps {
  orgId: string
  onAdded: (faq: FaqListItem) => void
}

function AddFaqForm({ orgId, onAdded }: AddFaqFormProps) {
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (saving || !question.trim() || !answer.trim()) return
    setSaving(true)
    setError(null)

    try {
      const res = await fetch('/api/operator/faqs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ organisation_id: orgId, question_canonical: question.trim(), answer: answer.trim() }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as Record<string, unknown>
        setError(typeof json.error === 'string' ? json.error : `Failed to add FAQ (${res.status}).`)
        setSaving(false)
        return
      }
      const json = await res.json() as { faq: FaqListItem }
      onAdded(json.faq)
      setQuestion('')
      setAnswer('')
      setOpen(false)
    } catch {
      setError('Connection error — please try again.')
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-[12px] font-medium text-brand-green hover:text-[#244030] transition-colors"
      >
        + Add FAQ
      </button>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="bg-[#F8F4EE] border border-border-card rounded-[8px] p-4 flex flex-col gap-3">
      <p className="text-[11px] font-medium text-text-primary uppercase tracking-[0.07em]">New FAQ</p>
      <div>
        <label className="text-[10px] text-text-secondary uppercase tracking-[0.07em] mb-1 block">
          Question
        </label>
        <input
          type="text"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          disabled={saving}
          placeholder="e.g. How long does onboarding take?"
          className="w-full text-[12px] text-text-primary bg-white border border-border-card rounded-[6px] px-3 py-2 focus:outline-none focus:border-[#A8D4B8] focus:ring-1 focus:ring-[#A8D4B8] disabled:opacity-60"
        />
      </div>
      <div>
        <label className="text-[10px] text-text-secondary uppercase tracking-[0.07em] mb-1 block">
          Answer
        </label>
        <textarea
          value={answer}
          onChange={e => setAnswer(e.target.value)}
          disabled={saving}
          rows={3}
          placeholder="Write the standard answer here…"
          className="w-full text-[12px] text-text-primary bg-white border border-border-card rounded-[6px] px-3 py-2 resize-none focus:outline-none focus:border-[#A8D4B8] focus:ring-1 focus:ring-[#A8D4B8] disabled:opacity-60"
        />
      </div>
      {error && <p className="text-[11px] text-[#8B2020]">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={saving || !question.trim() || !answer.trim()}
          className="px-3.5 py-1.5 rounded-[6px] bg-brand-green text-[#F5F0E8] text-[12px] font-medium hover:bg-[#244030] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Adding…' : 'Add FAQ'}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setQuestion(''); setAnswer(''); setError(null) }}
          disabled={saving}
          className="px-3.5 py-1.5 rounded-[6px] bg-white border border-border-card text-[12px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

// ── Main component ──────────────────────────────────────────────────────────────

export function FaqCurationView({ orgId, orgName }: FaqCurationViewProps) {
  const router = useRouter()

  // ── Extraction queue state ────────────────────────────────────────────────────
  const [extractions, setExtractions] = useState<ExtractionItem[]>([])
  const [extractionStates, setExtractionStates] = useState<Record<string, ExtractionCardState>>({})
  const [extractionsLoading, setExtractionsLoading] = useState(true)
  const [extractionsFetchError, setExtractionsFetchError] = useState<string | null>(null)

  const extractionStatesRef = useRef<Record<string, ExtractionCardState>>({})
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const visibilityTickRef = useRef<(() => void) | null>(null)

  // ── Knowledge base state ──────────────────────────────────────────────────────
  const [faqs, setFaqs] = useState<FaqListItem[]>([])
  const [faqsLoading, setFaqsLoading] = useState(true)
  const [faqsFetchError, setFaqsFetchError] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  // ── Fetch extractions ─────────────────────────────────────────────────────────

  const fetchExtractions = useCallback(async () => {
    try {
      const res = await fetch(`/api/operator/faq-extractions?client=${orgId}`, { credentials: 'same-origin' })
      if (res.status === 401) { router.push('/login'); return }
      if (res.status === 403) { setExtractionsFetchError('Your account no longer has operator permissions.'); return }
      if (!res.ok) { setExtractionsFetchError(`Could not load extraction queue (${res.status}).`); return }

      const json = await res.json() as { extractions: ExtractionItem[] }
      const incoming = json.extractions ?? []

      // Filter out rows that are currently being acted on.
      const snapshot = extractionStatesRef.current
      const inFlightIds = new Set(
        Object.entries(snapshot)
          .filter(([, s]) => s.inFlight !== 'idle')
          .map(([id]) => id)
      )
      setExtractions(incoming.filter(e => !inFlightIds.has(e.id)))

      // Init state for any new arrivals.
      setExtractionStates(prev => {
        const next: Record<string, ExtractionCardState> = { ...prev }
        for (const extraction of incoming) {
          if (!next[extraction.id]) {
            next[extraction.id] = { inFlight: 'idle', actionError: null }
          }
        }
        return next
      })

      setExtractionsFetchError(null)
    } catch {
      setExtractionsFetchError('Lost connection. Will retry shortly.')
    } finally {
      setExtractionsLoading(false)
    }
  }, [orgId, router])

  useEffect(() => { extractionStatesRef.current = extractionStates }, [extractionStates])

  // Mount + polling effect for extractions.
  useEffect(() => {
    if (intervalRef.current !== null) clearInterval(intervalRef.current)
    if (visibilityTickRef.current !== null) document.removeEventListener('visibilitychange', visibilityTickRef.current)

    fetchExtractions()

    const tick = () => { if (document.visibilityState === 'visible') fetchExtractions() }
    intervalRef.current = setInterval(tick, POLL_INTERVAL_MS)
    visibilityTickRef.current = tick
    document.addEventListener('visibilitychange', tick)

    return () => {
      if (intervalRef.current !== null) { clearInterval(intervalRef.current); intervalRef.current = null }
      if (visibilityTickRef.current !== null) { document.removeEventListener('visibilitychange', visibilityTickRef.current); visibilityTickRef.current = null }
    }
  }, [fetchExtractions])

  // ── Fetch FAQs (once on mount) ────────────────────────────────────────────────

  useEffect(() => {
    async function loadFaqs() {
      try {
        const res = await fetch(`/api/operator/faqs?client=${orgId}`, { credentials: 'same-origin' })
        if (!res.ok) { setFaqsFetchError(`Could not load knowledge base (${res.status}).`); return }
        const json = await res.json() as { faqs: FaqListItem[] }
        setFaqs(json.faqs ?? [])
      } catch {
        setFaqsFetchError('Could not load knowledge base.')
      } finally {
        setFaqsLoading(false)
      }
    }
    loadFaqs()
  }, [orgId])

  // ── Extraction card state helpers ─────────────────────────────────────────────

  function updateExtractionState(id: string, patch: Partial<ExtractionCardState>) {
    setExtractionStates(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }

  function removeExtraction(id: string) {
    setExtractions(prev => prev.filter(e => e.id !== id))
    setExtractionStates(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  // ── Extraction actions ────────────────────────────────────────────────────────

  async function handleApproveNew(extraction: ExtractionItem) {
    updateExtractionState(extraction.id, { inFlight: 'approving_new', actionError: null })

    try {
      const res = await fetch(`/api/operator/faq-extractions/${extraction.id}/approve-new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ organisation_id: orgId }),
      })

      if (res.status === 401) { router.push('/login'); return }
      if (res.status === 403) { updateExtractionState(extraction.id, { inFlight: 'idle', actionError: 'Operator access required.' }); return }
      if (res.status === 409) {
        updateExtractionState(extraction.id, { inFlight: 'idle', actionError: 'Already actioned — refreshing.' })
        await fetchExtractions()
        return
      }
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as Record<string, unknown>
        updateExtractionState(extraction.id, { inFlight: 'idle', actionError: typeof json.error === 'string' ? json.error : `Failed (${res.status}).` })
        return
      }

      const json = await res.json() as { faq_id: string }

      // Optimistically add the new FAQ to the KB list.
      const newFaq: FaqListItem = {
        id: json.faq_id,
        organisation_id: orgId,
        question_canonical: extraction.extracted_question,
        answer: extraction.suggested_answer,
        question_variants: [],
        status: 'approved',
        times_used: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      setFaqs(prev => [newFaq, ...prev])
      removeExtraction(extraction.id)
    } catch {
      updateExtractionState(extraction.id, { inFlight: 'idle', actionError: 'Connection error — try again.' })
    }
  }

  async function handleApproveMerge(extraction: ExtractionItem, targetFaqId: string) {
    updateExtractionState(extraction.id, { inFlight: 'approving_merge', actionError: null })

    try {
      const res = await fetch(`/api/operator/faq-extractions/${extraction.id}/approve-merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ organisation_id: orgId, target_faq_id: targetFaqId }),
      })

      if (res.status === 401) { router.push('/login'); return }
      if (res.status === 403) { updateExtractionState(extraction.id, { inFlight: 'idle', actionError: 'Operator access required.' }); return }
      if (res.status === 409) {
        updateExtractionState(extraction.id, { inFlight: 'idle', actionError: 'Already actioned — refreshing.' })
        await fetchExtractions()
        return
      }
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as Record<string, unknown>
        updateExtractionState(extraction.id, { inFlight: 'idle', actionError: typeof json.error === 'string' ? json.error : `Failed (${res.status}).` })
        return
      }

      // Optimistically add the extracted question as a variant on the target FAQ.
      setFaqs(prev => prev.map(f =>
        f.id === targetFaqId
          ? { ...f, question_variants: [...f.question_variants, extraction.extracted_question] }
          : f
      ))
      removeExtraction(extraction.id)
    } catch {
      updateExtractionState(extraction.id, { inFlight: 'idle', actionError: 'Connection error — try again.' })
    }
  }

  async function handleRejectExtraction(extraction: ExtractionItem) {
    updateExtractionState(extraction.id, { inFlight: 'rejecting', actionError: null })

    try {
      const res = await fetch(`/api/operator/faq-extractions/${extraction.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ organisation_id: orgId }),
      })

      if (res.status === 401) { router.push('/login'); return }
      if (res.status === 403) { updateExtractionState(extraction.id, { inFlight: 'idle', actionError: 'Operator access required.' }); return }
      if (res.status === 409) {
        updateExtractionState(extraction.id, { inFlight: 'idle', actionError: 'Already actioned — refreshing.' })
        await fetchExtractions()
        return
      }
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as Record<string, unknown>
        updateExtractionState(extraction.id, { inFlight: 'idle', actionError: typeof json.error === 'string' ? json.error : `Failed (${res.status}).` })
        return
      }

      removeExtraction(extraction.id)
    } catch {
      updateExtractionState(extraction.id, { inFlight: 'idle', actionError: 'Connection error — try again.' })
    }
  }

  // ── FAQ KB actions ────────────────────────────────────────────────────────────

  async function handleFaqSave(faqId: string, answer: string) {
    const res = await fetch(`/api/operator/faqs/${faqId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ answer }),
    })
    if (!res.ok) {
      const json = await res.json().catch(() => ({})) as Record<string, unknown>
      throw new Error(typeof json.error === 'string' ? json.error : `Save failed (${res.status}).`)
    }
    setFaqs(prev => prev.map(f => f.id === faqId ? { ...f, answer } : f))
  }

  async function handleFaqArchive(faqId: string) {
    const res = await fetch(`/api/operator/faqs/${faqId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ status: 'archived' }),
    })
    if (!res.ok) {
      const json = await res.json().catch(() => ({})) as Record<string, unknown>
      throw new Error(typeof json.error === 'string' ? json.error : `Archive failed (${res.status}).`)
    }
    setFaqs(prev => prev.map(f => f.id === faqId ? { ...f, status: 'archived' } : f))
  }

  async function handleFaqRestore(faqId: string) {
    const res = await fetch(`/api/operator/faqs/${faqId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ status: 'approved' }),
    })
    if (!res.ok) {
      const json = await res.json().catch(() => ({})) as Record<string, unknown>
      throw new Error(typeof json.error === 'string' ? json.error : `Restore failed (${res.status}).`)
    }
    setFaqs(prev => prev.map(f => f.id === faqId ? { ...f, status: 'approved' } : f))
  }

  // ── Derived KB list ───────────────────────────────────────────────────────────

  const visibleFaqs = showArchived ? faqs : faqs.filter(f => f.status === 'approved')
  const archivedCount = faqs.filter(f => f.status === 'archived').length

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-8 px-7 py-6 lg:flex-row lg:items-start lg:gap-6">

      {/* ── Left column: extraction queue ───────────────────────────────────── */}
      <section className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-[13px] font-semibold text-text-primary">
            Extraction queue
          </h2>
          {!extractionsLoading && extractions.length > 0 && (
            <span className="text-[11px] text-text-muted">{extractions.length} pending</span>
          )}
        </div>

        {extractionsLoading ? (
          <div className="flex flex-col gap-4">
            <ExtractionCardSkeleton />
            <ExtractionCardSkeleton />
          </div>
        ) : extractionsFetchError ? (
          <div className="bg-[#FDEEE8] border border-[#EFBCAA] rounded-[10px] px-5 py-4">
            <p className="text-[13px] font-medium text-[#8B2020] mb-1">Queue unavailable</p>
            <p className="text-[12px] text-[#8B2020]">{extractionsFetchError}</p>
          </div>
        ) : extractions.length === 0 ? (
          <div className="bg-surface-card border border-border-card rounded-[10px] px-5 py-8 text-center">
            <p className="text-[13px] font-medium text-text-primary mb-1">Queue is clear</p>
            <p className="text-[12px] text-text-secondary">No extractions waiting for review for {orgName}.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {extractions.map(extraction => {
              const state = extractionStates[extraction.id] ?? { inFlight: 'idle' as const, actionError: null }
              return (
                <ExtractionCard
                  key={extraction.id}
                  extraction={extraction}
                  faqs={faqs}
                  callbacks={{
                    onApproveNew: handleApproveNew,
                    onApproveMerge: handleApproveMerge,
                    onReject: handleRejectExtraction,
                  }}
                  inFlight={state.inFlight}
                  actionError={state.actionError}
                />
              )
            })}
          </div>
        )}
      </section>

      {/* ── Right column: knowledge base ─────────────────────────────────────── */}
      <section className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-[13px] font-semibold text-text-primary">Knowledge base</h2>
          <AddFaqForm orgId={orgId} onAdded={faq => setFaqs(prev => [faq, ...prev])} />
        </div>

        {faqsLoading ? (
          <div className="bg-surface-card border border-border-card rounded-[10px] p-[22px] animate-pulse">
            <div className="flex flex-col gap-4">
              {[1, 2, 3].map(i => (
                <div key={i} className="border-b border-border-card last:border-b-0 pb-4">
                  <div className="h-3 w-3/4 bg-[#E8E2D8] rounded mb-2" />
                  <div className="h-2 w-full bg-[#F0EBE3] rounded mb-1" />
                  <div className="h-2 w-2/3 bg-[#F0EBE3] rounded" />
                </div>
              ))}
            </div>
          </div>
        ) : faqsFetchError ? (
          <div className="bg-[#FDEEE8] border border-[#EFBCAA] rounded-[10px] px-5 py-4">
            <p className="text-[13px] font-medium text-[#8B2020] mb-1">Knowledge base unavailable</p>
            <p className="text-[12px] text-[#8B2020]">{faqsFetchError}</p>
          </div>
        ) : faqs.length === 0 ? (
          <div className="bg-surface-card border border-border-card rounded-[10px] px-5 py-8 text-center">
            <p className="text-[13px] font-medium text-text-primary mb-1">No FAQs yet</p>
            <p className="text-[12px] text-text-secondary">Add one manually or approve an extraction above.</p>
          </div>
        ) : (
          <div className="bg-surface-card border border-border-card rounded-[10px] p-[22px]">
            {visibleFaqs.map(faq => (
              <FaqRow
                key={faq.id}
                faq={faq}
                onSave={handleFaqSave}
                onArchive={handleFaqArchive}
                onRestore={handleFaqRestore}
              />
            ))}
            {archivedCount > 0 && (
              <button
                onClick={() => setShowArchived(s => !s)}
                className="mt-4 text-[11px] text-text-muted hover:text-text-secondary transition-colors"
              >
                {showArchived
                  ? 'Hide archived'
                  : `Show ${archivedCount} archived FAQ${archivedCount !== 1 ? 's' : ''}`}
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
