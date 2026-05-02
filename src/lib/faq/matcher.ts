// Deterministic FAQ matcher. Per ADR-018: no LLM calls.
// Computes Jaccard similarity between a prospect's question and each approved FAQ.
// When includePendingExtractions is true, also scores pending faq_extractions rows
// so the extraction agent can detect near-duplicate candidates before writing.
// The caller decides what score threshold to apply — this returns all matches with scores.

import type { SupabaseClient } from '@supabase/supabase-js'
import { normaliseQuestion } from './normalise'

export interface FaqMatch {
  faq_id: string | null                     // null when source = 'pending_extraction'
  pending_extraction_id: string | null      // populated when source = 'pending_extraction'
  question_canonical: string
  answer: string
  score: number                             // Jaccard coefficient 0.0–1.0
  source: 'approved_faq' | 'pending_extraction'
}

export async function findFaqMatches({
  organisationId,
  questionText,
  supabase,
  limit = 3,
  includePendingExtractions = false,
}: {
  organisationId: string
  questionText: string
  supabase: SupabaseClient
  limit?: number
  includePendingExtractions?: boolean
}): Promise<FaqMatch[]> {
  const prospectTokens = normaliseQuestion(questionText)
  if (prospectTokens.length === 0) return []

  const prospectSet = new Set(prospectTokens)
  const scored: FaqMatch[] = []

  // ── Approved FAQs ──────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: faqRows, error: faqError } = await (supabase as any)
    .from('faqs')
    .select('id, question_canonical, question_variants, answer')
    .eq('organisation_id', organisationId)
    .eq('status', 'approved')

  if (!faqError && faqRows && faqRows.length > 0) {
    for (const row of faqRows as Array<{
      id: string
      question_canonical: string
      question_variants: unknown
      answer: string
    }>) {
      const faqTokens = new Set(normaliseQuestion(row.question_canonical))

      const variants = Array.isArray(row.question_variants) ? row.question_variants : []
      for (const variant of variants) {
        if (typeof variant === 'string') {
          for (const token of normaliseQuestion(variant)) {
            faqTokens.add(token)
          }
        }
      }

      if (faqTokens.size === 0) continue

      const score = jaccardScore(prospectSet, faqTokens)

      scored.push({
        faq_id: row.id,
        pending_extraction_id: null,
        question_canonical: row.question_canonical,
        answer: row.answer,
        score: Math.round(score * 10000) / 10000,
        source: 'approved_faq',
      })
    }
  }

  // ── Pending extractions (optional) ─────────────────────────────────────────
  // Used by the faq-extraction-agent to detect near-duplicate pending candidates.
  // Not exposed to the reply-draft-agent (flag defaults to false).
  if (includePendingExtractions) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: extractionRows, error: extractionError } = await (supabase as any)
      .from('faq_extractions')
      .select('id, extracted_question, suggested_answer')
      .eq('organisation_id', organisationId)
      .eq('status', 'pending')

    if (!extractionError && extractionRows && extractionRows.length > 0) {
      for (const row of extractionRows as Array<{
        id: string
        extracted_question: string
        suggested_answer: string
      }>) {
        const extractionTokens = new Set(normaliseQuestion(row.extracted_question))
        if (extractionTokens.size === 0) continue

        const score = jaccardScore(prospectSet, extractionTokens)

        scored.push({
          faq_id: null,
          pending_extraction_id: row.id,
          question_canonical: row.extracted_question,
          answer: row.suggested_answer,
          score: Math.round(score * 10000) / 10000,
          source: 'pending_extraction',
        })
      }
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

// Jaccard similarity = |intersection| / |union|
function jaccardScore(setA: Set<string>, setB: Set<string>): number {
  let intersectionSize = 0
  for (const token of setA) {
    if (setB.has(token)) intersectionSize++
  }
  const unionSize = setA.size + setB.size - intersectionSize
  return unionSize === 0 ? 0 : intersectionSize / unionSize
}
