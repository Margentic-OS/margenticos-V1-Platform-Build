// Shared types for the triage queue UI.
// Mirror the shape returned by GET /api/reply-drafts.

export type TriageStatus = 'pending' | 'manual_required' | 'draft_failed' | 'send_failed'

export type DraftMetadata = {
  faq_ids_used?: string[]
  confidence_at_draft?: number
  ambiguity_note?: string
  alternative_directions?: string[]
  [key: string]: unknown
}

export type FaqItem = {
  id: string
  question_canonical: string
  answer: string
  times_used: number
}

export type ProspectInfo = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  linkedin_url: string | null
}

export type TriageDraftItem = {
  id: string
  signal_id: string
  prospect_id: string | null
  tier: 2 | 3
  intent: string
  ai_draft_body: string | null
  draft_metadata: DraftMetadata
  status: TriageStatus
  send_error: string | null
  created_at: string
  updated_at: string
  signal_reply_body: string | null
  original_outbound_body: string | null
  prospect: ProspectInfo | null
  faqs: FaqItem[]
}
