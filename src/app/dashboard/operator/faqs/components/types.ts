// Shared types for the FAQ curation UI.
// ExtractionItem mirrors GET /api/operator/faq-extractions response shape.
// FaqListItem mirrors GET /api/operator/faqs response shape.

export type ExtractionItem = {
  id: string
  organisation_id: string
  extracted_question: string
  suggested_answer: string
  similar_faq_id: string | null
  similar_faq_question: string | null
  similar_pending_extraction_id: string | null
  similarity_score: number | null
  potential_names_flagged: string[]
  created_at: string
}

export type FaqStatus = 'approved' | 'archived'

export type FaqListItem = {
  id: string
  organisation_id: string
  question_canonical: string
  answer: string
  question_variants: string[]
  status: FaqStatus
  times_used: number
  created_at: string
  updated_at: string
}

// Actions emitted from ExtractionCard up to FaqCurationView
export type ExtractionAction =
  | { type: 'approve_new'; extraction: ExtractionItem }
  | { type: 'approve_merge'; extraction: ExtractionItem; target_faq_id: string }
  | { type: 'reject'; extraction: ExtractionItem }
