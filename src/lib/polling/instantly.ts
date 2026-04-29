// src/lib/polling/instantly.ts
//
// Future home: src/lib/integrations/polling/instantly.ts
// Move after Phase 1 reply handling ships — dedicated tidy-up commit. See BACKLOG [post-build].
//
// Instantly V2 event polling — the Instantly-specific source handler.
// Called by /api/cron/instantly-poll every 15 minutes.
//
// Three resources are polled:
//   replies         — cursor-based via GET /api/v2/emails?email_type=received
//   leads_bounced   — full status scan via GET /api/v2/lead/list?status=BOUNCED_STATUS
//   leads_unsub     — full status scan via GET /api/v2/lead/list?status=UNSUB_STATUS
//
// Why full scan for bounces/unsubscribes (not cursor-based):
//   Instantly V2 has no updated_after filter on leads. Bounces and unsubscribes are
//   status changes on existing leads — a lead created weeks ago can bounce today.
//   Cursor-based pagination ordered by creation date would miss those late changes.
//   The correct approach: scan ALL currently-bounced/unsubscribed leads on every poll.
//   Idempotency (ON CONFLICT DO NOTHING) prevents duplicate signals.
//   At typical campaign scales (1-3% bounce rate), the filtered list is small.
//   At very large lead counts (10k+), replace with webhook-based ingestion.
//
// Status values for bounced/unsubscribed leads:
//   INSTANTLY_LEAD_STATUS_BOUNCED and INSTANTLY_LEAD_STATUS_UNSUBSCRIBED below.
//   These values are from Instantly V2 API documentation — verify against live API
//   before first production poll. If a poll returns zero bounces/unsubscribes on an
//   account where you expect some, the status values are the first thing to check.

import { SupabaseClient } from '@supabase/supabase-js'
import { Database, Json } from '@/types/database'
import { logger } from '@/lib/logger'

const INSTANTLY_API_BASE = 'https://api.instantly.ai/api/v2'
const SOURCE = 'instantly'

// UNVERIFIED — these values are assumed from training data, not confirmed against
// a live Instantly API response. Verify before trusting bounce/unsubscribe signals:
// call list_leads with no status filter against a known-bounced lead and inspect
// the actual `status` field value. See BACKLOG [c0-blocker] Verify Instantly lead status values.
export const INSTANTLY_LEAD_STATUS_BOUNCED = '-2'
export const INSTANTLY_LEAD_STATUS_UNSUBSCRIBED = '-1'

type SupabaseServiceClient = SupabaseClient<Database>

export interface PollResult {
  written: number
  skipped: number
  errors: number
}

// ── Campaign resolution ───────────────────────────────────────────────────────

interface ResolvedCampaign {
  id: string
  organisation_id: string
}

// Maps an Instantly campaign UUID to our internal campaign record.
// Returns null if the campaign isn't registered in our campaigns table.
// When null: the signal cannot be written (organisation_id is required, not nullable).
// Log a warning — the fix is to register the campaign in the campaigns table
// with external_id = the Instantly campaign UUID.
async function resolveCampaign(
  supabase: SupabaseServiceClient,
  instantlyCampaignId: string,
  campaignCache: Map<string, ResolvedCampaign | null>
): Promise<ResolvedCampaign | null> {
  if (campaignCache.has(instantlyCampaignId)) {
    return campaignCache.get(instantlyCampaignId)!
  }

  const { data } = await supabase
    .from('campaigns')
    .select('id, organisation_id')
    .eq('external_id', instantlyCampaignId)
    .maybeSingle()

  const resolved = data ?? null
  campaignCache.set(instantlyCampaignId, resolved)

  if (!resolved) {
    logger.warn('Instantly poll: campaign not found in campaigns table', {
      instantly_campaign_id: instantlyCampaignId,
      fix: 'Insert a row into campaigns with external_id = this value and the correct organisation_id',
    })
  }

  return resolved
}

// ── Cursor helpers ────────────────────────────────────────────────────────────

async function getCursor(
  supabase: SupabaseServiceClient,
  resource: string
): Promise<string | null> {
  const { data } = await supabase
    .from('polling_cursors')
    .select('last_cursor')
    .is('organisation_id', null)
    .eq('source', SOURCE)
    .eq('resource', resource)
    .maybeSingle()
  return data?.last_cursor ?? null
}

async function setCursorSuccess(
  supabase: SupabaseServiceClient,
  resource: string,
  newCursor: string | null
): Promise<void> {
  await supabase
    .from('polling_cursors')
    .upsert(
      {
        organisation_id: null,
        source: SOURCE,
        resource,
        last_cursor: newCursor,
        last_run_at: new Date().toISOString(),
        error_count: 0,
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organisation_id,source,resource' }
    )
}

async function setCursorError(
  supabase: SupabaseServiceClient,
  resource: string,
  errorMessage: string
): Promise<void> {
  // Read current error_count then increment — two queries, acceptable at this frequency.
  const { data: existing } = await supabase
    .from('polling_cursors')
    .select('error_count')
    .is('organisation_id', null)
    .eq('source', SOURCE)
    .eq('resource', resource)
    .maybeSingle()

  await supabase
    .from('polling_cursors')
    .upsert(
      {
        organisation_id: null,
        source: SOURCE,
        resource,
        last_run_at: new Date().toISOString(),
        error_count: (existing?.error_count ?? 0) + 1,
        last_error: errorMessage,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organisation_id,source,resource' }
    )
}

// ── Signal writer ─────────────────────────────────────────────────────────────

// Returns 'written' | 'skipped' | 'error'.
// 'skipped' means the idempotency constraint fired (signal already exists) — normal, not an error.
async function writeSignal(
  supabase: SupabaseServiceClient,
  params: {
    organisation_id: string
    campaign_id: string | null
    prospect_id: string | null
    signal_type: string
    source: string
    external_event_id: string
    raw_data: Json
  }
): Promise<'written' | 'skipped' | 'error'> {
  const { error } = await supabase.from('signals').insert({
    organisation_id: params.organisation_id,
    campaign_id: params.campaign_id,
    prospect_id: params.prospect_id,
    signal_type: params.signal_type,
    source: params.source,
    external_event_id: params.external_event_id,
    raw_data: params.raw_data,
    processed: false,
  })

  if (!error) return 'written'

  // Unique constraint violation = idempotency fired = already written. Not an error.
  if (error.code === '23505') return 'skipped'

  logger.error('Instantly poll: failed to write signal', {
    signal_type: params.signal_type,
    external_event_id: params.external_event_id,
    error: error.message,
  })
  return 'error'
}

// ── Instantly API client ──────────────────────────────────────────────────────

// Shared response normaliser: { items, pagination } → { data, nextCursor, error }
function parseInstantlyResponse(json: unknown): { data: unknown[]; nextCursor: string | null } {
  const items: unknown[] = Array.isArray(json)
    ? json
    : ((json as Record<string, unknown>)?.items as unknown[]) ?? []
  const nextCursor: string | null =
    ((json as Record<string, unknown>)?.pagination as Record<string, unknown>)
      ?.next_starting_after as string | null ?? null
  return { data: items, nextCursor }
}

// GET request — used for /emails (cursor-based, query params)
async function instantlyGet(
  path: string,
  apiKey: string,
  params: Record<string, string>
): Promise<{ data: unknown[] | null; nextCursor: string | null; error: string | null }> {
  const url = new URL(`${INSTANTLY_API_BASE}${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value)
    }
  }

  let response: Response
  try {
    response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    })
  } catch (err) {
    return { data: null, nextCursor: null, error: `Network error: ${String(err)}` }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    return {
      data: null,
      nextCursor: null,
      error: `Instantly API ${response.status}: ${body.slice(0, 200)}`,
    }
  }

  const json = await response.json().catch(() => null)
  if (!json) {
    return { data: null, nextCursor: null, error: 'Instantly API returned non-JSON response' }
  }

  const { data, nextCursor } = parseInstantlyResponse(json)
  return { data, nextCursor, error: null }
}

// POST request — used for /leads/list (Instantly V2 list endpoints use POST with JSON body)
async function instantlyPost(
  path: string,
  apiKey: string,
  body: Record<string, unknown>
): Promise<{ data: unknown[] | null; nextCursor: string | null; error: string | null }> {
  let response: Response
  try {
    response = await fetch(`${INSTANTLY_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    return { data: null, nextCursor: null, error: `Network error: ${String(err)}` }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return {
      data: null,
      nextCursor: null,
      error: `Instantly API ${response.status}: ${text.slice(0, 200)}`,
    }
  }

  const json = await response.json().catch(() => null)
  if (!json) {
    return { data: null, nextCursor: null, error: 'Instantly API returned non-JSON response' }
  }

  const { data, nextCursor } = parseInstantlyResponse(json)
  return { data, nextCursor, error: null }
}

// ── Reply polling (cursor-based) ──────────────────────────────────────────────

export async function pollInstantlyReplies(
  supabase: SupabaseServiceClient,
  apiKey: string
): Promise<PollResult> {
  const resource = 'replies'
  const result: PollResult = { written: 0, skipped: 0, errors: 0 }
  const campaignCache = new Map<string, ResolvedCampaign | null>()

  let cursor = await getCursor(supabase, resource)
  let pageCount = 0
  const MAX_PAGES = 50 // safety ceiling — prevents runaway pagination on a very large backlog

  try {
    while (pageCount < MAX_PAGES) {
      pageCount++

      const params: Record<string, string> = {
        email_type: 'received',
        sort_order: 'asc',
        limit: '100',
      }
      if (cursor) params.starting_after = cursor

      const { data: emails, nextCursor, error } = await instantlyGet('/emails', apiKey, params)

      if (error) {
        await setCursorError(supabase, resource, error)
        logger.error('Instantly poll: reply fetch failed', { error, page: pageCount })
        result.errors++
        return result
      }

      if (!emails || emails.length === 0) break

      for (const email of emails) {
        const e = email as Record<string, unknown>
        const emailId = e.id as string | undefined
        const instantlyCampaignId = (e.campaign_id ?? e.campaign) as string | undefined

        if (!emailId) {
          logger.warn('Instantly poll: reply email missing id field', { raw: e })
          result.errors++
          continue
        }

        let campaignRow: ResolvedCampaign | null = null
        if (instantlyCampaignId) {
          campaignRow = await resolveCampaign(supabase, instantlyCampaignId, campaignCache)
        }

        if (!campaignRow) {
          // Cannot write signal without organisation_id. Event is logged above in resolveCampaign.
          result.errors++
          continue
        }

        const outcome = await writeSignal(supabase, {
          organisation_id: campaignRow.organisation_id,
          campaign_id: campaignRow.id,
          prospect_id: null, // prospect linkage is downstream signal processing concern
          signal_type: 'reply_received',
          source: SOURCE,
          external_event_id: emailId,
          raw_data: e as Json,
        })

        if (outcome === 'written') result.written++
        else if (outcome === 'skipped') result.skipped++
        else result.errors++
      }

      // Advance cursor to the last email in this page.
      // Do this after processing the page so that a mid-page failure doesn't advance past unprocessed events.
      const lastEmail = emails[emails.length - 1] as Record<string, unknown>
      const lastId = lastEmail?.id as string | undefined
      if (lastId) cursor = lastId

      if (!nextCursor) break
    }

    await setCursorSuccess(supabase, resource, cursor)
    logger.info('Instantly poll: replies polled', { ...result, pages: pageCount })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await setCursorError(supabase, resource, msg)
    logger.error('Instantly poll: reply polling threw', { error: msg })
    result.errors++
  }

  return result
}

// ── Lead status polling (campaign-filtered, full scan, idempotency-deduplicated) ──
//
// Loops through each campaign registered in our campaigns table, fetching leads
// with the given status per campaign. Only campaigns with external_id set are included.
//
// Why per-campaign rather than workspace-wide:
//   Avoids scope bleed from unregistered campaigns in the same Instantly account.
//   campaign_id and organisation_id are known from the campaigns row — no external
//   lookup needed in the inner loop.
//
// Why full scan (no cursor between polls):
//   Instantly V2 has no updated_after filter on leads. Bounces are status changes
//   on existing leads — cursor-by-creation-date would miss late changes.
//   Idempotency (ON CONFLICT DO NOTHING) prevents duplicate signals.

export async function pollInstantlyLeadStatus(
  supabase: SupabaseServiceClient,
  apiKey: string,
  instantlyStatus: string,
  signalType: 'email_bounced' | 'lead_unsubscribed'
): Promise<PollResult> {
  const resource = signalType === 'email_bounced' ? 'leads_bounced' : 'leads_unsubscribed'
  const result: PollResult = { written: 0, skipped: 0, errors: 0 }

  // Fetch campaigns registered in our system that have an Instantly campaign UUID.
  const { data: campaigns, error: campaignsError } = await supabase
    .from('campaigns')
    .select('id, organisation_id, external_id')
    .not('external_id', 'is', null)

  if (campaignsError) {
    logger.error('Instantly poll: failed to fetch campaigns for lead status scan', {
      signal_type: signalType,
      error: campaignsError.message,
    })
    await setCursorError(supabase, resource, campaignsError.message)
    result.errors++
    return result
  }

  if (!campaigns || campaigns.length === 0) {
    logger.info('Instantly poll: no campaigns registered — lead status scan skipped', {
      signal_type: signalType,
      fix: 'Insert a row into campaigns with external_id = the Instantly campaign UUID',
    })
    await setCursorSuccess(supabase, resource, null)
    return result
  }

  let totalPages = 0

  try {
    for (const campaign of campaigns) {
      const instantlyCampaignId = campaign.external_id! // non-null: filtered above

      let pageCursor: string | null = null
      let pageCount = 0
      const MAX_PAGES_PER_CAMPAIGN = 50

      while (pageCount < MAX_PAGES_PER_CAMPAIGN) {
        pageCount++
        totalPages++

        const body: Record<string, unknown> = {
          status: instantlyStatus,
          campaign: instantlyCampaignId,
          limit: 100,
        }
        if (pageCursor) body.starting_after = pageCursor

        const { data: leads, nextCursor, error } = await instantlyPost('/leads/list', apiKey, body)

        if (error) {
          // Log and move on to the next campaign — one campaign failure doesn't abort the run.
          logger.error('Instantly poll: lead status fetch failed', {
            signal_type: signalType,
            campaign_external_id: instantlyCampaignId,
            error,
            page: pageCount,
          })
          result.errors++
          break
        }

        if (!leads || leads.length === 0) break

        for (const lead of leads) {
          const l = lead as Record<string, unknown>
          const leadId = l.id as string | undefined

          if (!leadId) {
            logger.warn('Instantly poll: lead missing id field', { signal_type: signalType })
            result.errors++
            continue
          }

          // campaign_id and organisation_id come from the campaigns row — no extra lookup.
          const outcome = await writeSignal(supabase, {
            organisation_id: campaign.organisation_id,
            campaign_id: campaign.id,
            prospect_id: null,
            signal_type: signalType,
            source: SOURCE,
            external_event_id: leadId,
            raw_data: l as Json,
          })

          if (outcome === 'written') result.written++
          else if (outcome === 'skipped') result.skipped++
          else result.errors++
        }

        if (!nextCursor) break
        pageCursor = nextCursor
      }
    }

    await setCursorSuccess(supabase, resource, null)
    logger.info('Instantly poll: lead status scan complete', {
      signal_type: signalType,
      status: instantlyStatus,
      campaigns_scanned: campaigns.length,
      total_pages: totalPages,
      ...result,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await setCursorError(supabase, resource, msg)
    logger.error('Instantly poll: lead status polling threw', {
      signal_type: signalType,
      error: msg,
    })
    result.errors++
  }

  return result
}
