// src/lib/integrations/handlers/instantly/mock-dispatch.ts
//
// In-process mock dispatch for all Instantly V2 handler functions.
// Called directly when instantly_api_active = false — zero network calls.
//
// Why in-process: HTTP-based mocks (self-calls, third-party) require URL construction,
// auth, and a live server — each of which can fail independently of the feature under test.
// In-process dispatch is the only approach that is immune to deployment protection,
// network partitions, mock server rot, and URL construction errors.
//
// Also consumed by /api/mock/instantly/[...path] for manual curl testing.

import type { LeadUploadResponse } from './types'

function mockResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// GET /campaigns/analytics — fetchCampaignStats returns empty Map for []
export function mockCampaignAnalytics(): Response {
  return mockResponse([])
}

// GET /campaigns/:id/sending-status — fetchCampaignSendingStatus
// Returns 'healthy' because the mock workspace has nothing obstructing it. Shaped like
// the real response: the code lives at diagnostics.status, with summary carrying the
// same value, so a caller that reads either field is exercised.
export function mockCampaignSendingStatus(): Response {
  return mockResponse({
    diagnostics: {
      campaign_id: 'mock-campaign',
      last_updated: new Date().toISOString(),
      status: 'healthy',
      issue_tracking: {
        current_status_code: 'healthy',
        issue_first_seen_at: null,
        consecutive_loops_with_issue: 0,
        last_healthy_send_at: null,
      },
    },
    summary: {
      status: 'healthy',
      status_message: 'Campaign is sending normally',
      issue_started_at: null,
      last_healthy_send_at: null,
    },
  })
}

// GET /campaigns/:id — validateCampaign, syncSequenceShell (read-before-patch)
export function mockCampaignGet(campaignId: string): Response {
  return mockResponse({
    id: campaignId,
    name: 'Mock Campaign',
    status: 'active',
    scheduling_status: 'scheduled',
    sequences: [],
  })
}

// PATCH /campaigns/:id — syncSequenceShell shell write
export function mockCampaignPatch(campaignId: string): Response {
  return mockResponse({
    id: campaignId,
    updated_at: new Date().toISOString(),
  })
}

// POST /leads/add — uploadLeads: all submitted leads created
export function mockLeadsAdd(leads: ReadonlyArray<{ email: string }>): Response {
  const ts = Date.now()
  const data: LeadUploadResponse = {
    status: 'ok',
    leads_uploaded: leads.length,
    created_leads: leads.map((l, i) => ({
      id: `mock-lead-${i}-${ts}`,
      email: l.email,
    })),
    in_blocklist: 0,
    duplicated_leads: 0,
    invalid_email_count: 0,
    incomplete_count: 0,
  }
  return mockResponse(data)
}

// POST /leads/list — lead status polling, process-reply lead lookup
export function mockLeadsList(): Response {
  return mockResponse({ items: [], pagination: {} })
}

// POST /dfy-email-account-orders — quote (simulate=true; real orders blocked before reaching mock)
export function mockDfyOrder(items: ReadonlyArray<{ domain: string }>): Response {
  return mockResponse({
    order_placed: false,
    order_is_valid: true,
    total_price: items.length * 35,  // $35/domain — realistic mock price
  })
}

// PATCH /leads/:id — suppressLead
export function mockLeadPatch(leadId: string): Response {
  return mockResponse({ id: leadId, lt_interest_status: -1 })
}

// POST /emails/reply — sendThreadReply
export function mockEmailReply(): Response {
  return mockResponse({ id: `mock-message-${Date.now()}` })
}

// GET /emails — reply polling (returns empty list)
export function mockEmailsList(): Response {
  return mockResponse({ items: [], pagination: {} })
}

// GET /emails/:id — outbound email body fetch
export function mockEmailGet(emailId: string): Response {
  return mockResponse({
    id: emailId,
    body_text: 'Mock outbound email body.',
    subject: 'Mock subject',
    eaccount: 'mock@example.com',
  })
}
