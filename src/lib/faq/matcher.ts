// Deterministic FAQ matcher. Per ADR-018: no LLM calls.
// Computes Jaccard similarity between a prospect's question and each approved FAQ.
// The caller decides what score threshold to apply — this returns all matches with scores.

import type { SupabaseClient } from '@supabase/supabase-js'
import { normaliseQuestion } from './normalise'

export interface FaqMatch {
  faq_id: string
  question_canonical: string
  answer: string
  score: number  // Jaccard coefficient 0.0–1.0
}

export async function findFaqMatches({
  organisationId,
  questionText,
  supabase,
  limit = 3,
}: {
  organisationId: string
  questionText: string
  supabase: SupabaseClient
  limit?: number
}): Promise<FaqMatch[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rows, error } = await (supabase as any)
    .from('faqs')
    .select('id, question_canonical, question_variants, answer')
    .eq('organisation_id', organisationId)
    .eq('status', 'approved')

  if (error || !rows || rows.length === 0) return []

  const prospectTokens = normaliseQuestion(questionText)
  if (prospectTokens.length === 0) return []

  const prospectSet = new Set(prospectTokens)

  const scored: FaqMatch[] = []

  for (const row of rows as Array<{
    id: string
    question_canonical: string
    question_variants: unknown
    answer: string
  }>) {
    // Build token set from canonical question + all variants
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

    // Jaccard similarity = |intersection| / |union|
    let intersectionSize = 0
    for (const token of prospectSet) {
      if (faqTokens.has(token)) intersectionSize++
    }

    const unionSize = prospectSet.size + faqTokens.size - intersectionSize
    const score = unionSize === 0 ? 0 : intersectionSize / unionSize

    scored.push({
      faq_id: row.id,
      question_canonical: row.question_canonical,
      answer: row.answer,
      score: Math.round(score * 10000) / 10000,
    })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}
