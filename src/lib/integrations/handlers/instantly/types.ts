// Instantly V2 API — typed response shapes for endpoints with real-money or real-state side effects.
// Source: https://developer.instantly.ai/api-reference/
// Date captured: 2026-05-21
//
// Only the three endpoints specified in ADR-024 Pillar 4 are typed here.
// Other Instantly endpoints used by the system retain their existing untyped pattern.

// ── Shared input type ─────────────────────────────────────────────────────────

// A single prospect record ready to be uploaded to an Instantly campaign.
// Fields beyond email are optional — Instantly accepts partial records.
// custom_variables must be flat (no nested objects or arrays) per Instantly's constraint.
export interface ProspectForUpload {
  email: string
  personalization?: string
  first_name?: string
  last_name?: string
  company_name?: string
  job_title?: string
  custom_variables?: Record<string, string>
}

// ── POST /api/v2/leads/add ────────────────────────────────────────────────────

export interface LeadUploadCreatedLead {
  id: string
  email: string
  first_name?: string
  last_name?: string
  phone?: string
  index?: number
}

export interface LeadUploadResponse {
  status?: string
  leads_uploaded: number
  created_leads: LeadUploadCreatedLead[]
  in_blocklist: number
  duplicated_leads: number
  invalid_email_count: number
  incomplete_count: number
  // Additional fields returned by Instantly — present but not relied upon by handler logic
  total_sent?: number
  duplicate_email_count?: number
  skipped_count?: number
  blocklist_used?: boolean
  remaining_in_plan?: number
}

// What uploadLeads() returns to the caller after parsing the API response and updating DB rows.
export interface LeadUploadResult {
  leads_uploaded: number
  created_count: number
  in_blocklist: number
  duplicated: number
  invalid_email_count: number
  incomplete_count: number
}

// ── POST /api/v2/dfy-email-account-orders ────────────────────────────────────

export interface DfyOrderItem {
  domain: string
}

export interface DfyOrderResponse {
  order_placed: boolean
  order_is_valid: boolean
  // Price returned by Instantly — field name varies; capture whichever is present
  total_price?: number
  price?: number
  // Instantly may return extra fields (sub-items, warnings, etc.) — not relied upon
  [key: string]: unknown
}

// What orderMailboxes() returns to the caller.
export interface DfyOrderResult {
  order_placed: boolean
  order_is_valid: boolean
  total_price: number | null
  simulated: boolean
}

// ── GET /api/v2/campaigns/{id} ────────────────────────────────────────────────

// Used by validateCampaign.ts and syncSequenceShell.ts. Typed here per ADR-024 Pillar 4.
// The full GET response includes the campaign's current sequences — captured here so
// syncSequenceShell can read them before overwriting (addendum-4: preserve other settings).
export interface SequenceVariant {
  subject: string
  body: string
  enabled?: boolean
}

export interface SequenceStep {
  type?: string
  delay: number
  delay_unit: 'days' | 'hours'
  enabled?: boolean
  variants: SequenceVariant[]
}

export interface SequenceConfig {
  steps: SequenceStep[]
}

export interface CampaignDetailResponse {
  id: string
  name: string
  status: string
  scheduling_status?: string
  campaign_type?: string
  created_at?: string
  updated_at?: string
  sequences?: SequenceConfig[]
  // Preserve any additional fields returned by the API for safe write-back.
  [key: string]: unknown
}

// ── PATCH /api/v2/campaigns/{id} ─────────────────────────────────────────────

// Partial update — only sequences is sent; all other campaign settings are untouched.
// Contract test asserts no other field is present in the PATCH body.
export interface CampaignUpdateRequest {
  sequences: SequenceConfig[]
}

export interface CampaignUpdateResponse {
  id: string
  updated_at?: string
  [key: string]: unknown
}

// ── Typed errors ──────────────────────────────────────────────────────────────
// All Instantly handler functions throw one of these classes — never plain Error —
// so callers can use instanceof to distinguish error types.

export class InstantlyFlagError extends Error {
  readonly code = 'INSTANTLY_FLAG_ERROR' as const
  constructor(message: string) { super(message); this.name = 'InstantlyFlagError' }
}

export class InstantlyNetworkError extends Error {
  readonly code = 'INSTANTLY_NETWORK_ERROR' as const
  constructor(message: string) { super(message); this.name = 'InstantlyNetworkError' }
}

export class InstantlyRateLimitError extends Error {
  readonly code = 'INSTANTLY_RATE_LIMIT' as const
  constructor(message: string) { super(message); this.name = 'InstantlyRateLimitError' }
}

export class InstantlyValidationError extends Error {
  readonly code = 'INSTANTLY_VALIDATION_ERROR' as const
  constructor(message: string) { super(message); this.name = 'InstantlyValidationError' }
}

export class InstantlyServerError extends Error {
  readonly code = 'INSTANTLY_SERVER_ERROR' as const
  constructor(message: string) { super(message); this.name = 'InstantlyServerError' }
}

export class InstantlyApiError extends Error {
  readonly code = 'INSTANTLY_API_ERROR' as const
  constructor(message: string) { super(message); this.name = 'InstantlyApiError' }
}
