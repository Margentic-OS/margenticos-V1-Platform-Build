// src/lib/reply-handling/get-client-visible-replies.ts
//
// SINGLE CHOKEPOINT for all client-facing reply reads.
// ALL client views of replies must go through this function.
// Enforces BOTH filters:
//   1. org-scoping: client sees ONLY their own organisation's replies (enforced by this function + RLS policy backstop)
//   2. intent-filtering: client sees ONLY positive-intent replies (enforced ONLY by this function, no DB backstop)
//
// Per ADR: org-scoping has RLS backstop; intent-filtering does not.
// If this function is bypassed and a client queries reply_handling_actions directly,
// the org-scoping RLS catches it, but the intent filter is gone — relationship-damaging failure.
// This function makes that impossible by being the ONLY path for client reply reads.

import { SupabaseClient } from '@supabase/supabase-js'
import { Database } from '@/types/database'

type SupabaseServiceClient = SupabaseClient<Database>

// The 5 intents clients are allowed to see: positive/engaged signals
const CLIENT_VISIBLE_INTENTS = [
  'positive_direct_booking',
  'positive_passive',
  'information_request_generic',
  'information_request_commercial',
  'objection_mild',
] as const

export type ClientVisibleIntent = typeof CLIENT_VISIBLE_INTENTS[number]

export interface ClientVisibleReply {
  id: string
  created_at: string
  prospect: {
    first_name: string | null
    last_name: string | null
    company_name: string | null
    email: string | null
  }
  classified_intent: ClientVisibleIntent
  classification_confidence: number
  reply_subject: string | null
  reply_body_snippet: string // First 300 chars of body for preview
  action_taken: string
}

/**
 * Fetches replies visible to a client.
 * SINGLE CHOKEPOINT: all client-facing reply reads must use this function.
 *
 * Enforces both filters at the data layer:
 *   1. organisation_id = clientOrgId (org-scoping, backed by RLS)
 *   2. classified_intent IN (positive intents) (intent-filtering, NOT backed by RLS)
 *
 * Returns only the 5 visible intents.
 * Never returns opt_out, out_of_office, or unclear, even if they exist for this org.
 */
export async function getClientVisibleReplies(
  supabase: SupabaseServiceClient,
  clientOrgId: string,
): Promise<ClientVisibleReply[]> {
  const { data, error } = await supabase
    .from('reply_handling_actions')
    .select(
      `
      id,
      created_at,
      classified_intent,
      classification_confidence,
      action_taken,
      prospect:prospects (
        first_name,
        last_name,
        company_name,
        email
      ),
      signal:signals (
        raw_data
      )
      `,
    )
    .eq('organisation_id', clientOrgId)
    .in('classified_intent', CLIENT_VISIBLE_INTENTS)
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) {
    throw new Error(`Failed to fetch client-visible replies: ${error.message}`)
  }

  // Map to the client-visible shape, extracting subject/body from raw_data
  return (data ?? []).map((row) => {
    const signal = row.signal as { raw_data: Record<string, unknown> } | null
    const rawData = signal?.raw_data ?? {}

    // Extract body (can be { text: string } or just string)
    const bodyRaw = rawData.body
    let body = ''
    if (typeof bodyRaw === 'object' && bodyRaw !== null) {
      body = ((bodyRaw as Record<string, unknown>).text as string | undefined) ?? ''
    } else if (typeof bodyRaw === 'string') {
      body = bodyRaw
    }

    // First 300 chars of body for preview (replace newlines with space for readability)
    const snippet = body
      .replace(/\n+/g, ' ')
      .substring(0, 300)
      .trim()

    const prospect = row.prospect as {
      first_name: string | null
      last_name: string | null
      company_name: string | null
      email: string | null
    } | null

    return {
      id: row.id,
      created_at: row.created_at,
      prospect: prospect ?? {
        first_name: null,
        last_name: null,
        company_name: null,
        email: null,
      },
      classified_intent: row.classified_intent as ClientVisibleIntent,
      classification_confidence: row.classification_confidence ?? 0,
      reply_subject: (typeof rawData.subject === 'string' ? rawData.subject : null) ?? null,
      reply_body_snippet: snippet,
      action_taken: row.action_taken,
    }
  })
}

/**
 * Fetches ALL replies for an organisation (operator only, no intent filtering).
 * Used by the operator per-client reply view.
 * Returns all 8 intents so the operator can see the full picture (opt_out, hostile, etc.).
 */
export async function getAllRepliesForOrg(
  supabase: SupabaseServiceClient,
  orgId: string,
): Promise<ClientVisibleReply[]> {
  const { data, error } = await supabase
    .from('reply_handling_actions')
    .select(
      `
      id,
      created_at,
      classified_intent,
      classification_confidence,
      action_taken,
      prospect:prospects (
        first_name,
        last_name,
        company_name,
        email
      ),
      signal:signals (
        raw_data
      )
      `,
    )
    .eq('organisation_id', orgId)
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) {
    throw new Error(`Failed to fetch all replies for org: ${error.message}`)
  }

  return (data ?? []).map((row) => {
    const signal = row.signal as { raw_data: Record<string, unknown> } | null
    const rawData = signal?.raw_data ?? {}

    // Extract body (can be { text: string } or just string)
    const bodyRaw = rawData.body
    let body = ''
    if (typeof bodyRaw === 'object' && bodyRaw !== null) {
      body = ((bodyRaw as Record<string, unknown>).text as string | undefined) ?? ''
    } else if (typeof bodyRaw === 'string') {
      body = bodyRaw
    }

    const snippet = body
      .replace(/\n+/g, ' ')
      .substring(0, 300)
      .trim()

    const prospect = row.prospect as {
      first_name: string | null
      last_name: string | null
      company_name: string | null
      email: string | null
    } | null

    return {
      id: row.id,
      created_at: row.created_at,
      prospect: prospect ?? {
        first_name: null,
        last_name: null,
        company_name: null,
        email: null,
      },
      classified_intent: row.classified_intent as string as ClientVisibleIntent,
      classification_confidence: row.classification_confidence ?? 0,
      reply_subject: (typeof rawData.subject === 'string' ? rawData.subject : null) ?? null,
      reply_body_snippet: snippet,
      action_taken: row.action_taken,
    }
  })
}
