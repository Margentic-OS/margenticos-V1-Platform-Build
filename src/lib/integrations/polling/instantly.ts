// src/lib/integrations/polling/instantly.ts
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
//
//   Source: Instantly API v2 Lead schema.
//     status (readOnly, number): 1 Active, 2 Paused, 3 Completed,
//                                -1 Bounced, -2 Unsubscribed, -3 Skipped
//
//   Corrected 2026-08-21. The previous values were '-2' for bounced and '-1' for
//   unsubscribed: inverted, and strings where the API returns numbers. Either fault
//   alone was enough to make detection wrong, and the string type meant correcting the
//   inversion by itself would have changed nothing observable.
//
//   The filter is no longer trusted on its own. Every returned lead is checked against
//   the status that was requested before a signal is written (verifyLeadStatus below).
//   A row that comes back from a bounced query without status -1 is not written as a
//   bounce; it is recorded as a poll failure and surfaces in polling_cursors.last_error.
//
//   INSTANTLY_LEAD_STATUS_VERIFIED remains false. It flips only after a real bounce has
//   been observed travelling this path end to end, not because the constants were fixed.
//   See BACKLOG: "Instantly bounce/unsub detection - live field and value verification".

import * as Sentry from '@sentry/nextjs'
import { SupabaseClient } from '@supabase/supabase-js'
import { Database, Json } from '@/types/database'
import { logger } from '@/lib/logger'
import { resolveInstantlyBaseUrl, shouldUseMockDispatch } from '@/lib/integrations/handlers/instantly/constants'
import { getInstantlyApiActive } from '@/lib/integrations/handlers/instantly/auth'
import { mockEmailsList, mockEmailGet, mockLeadsList } from '@/lib/integrations/handlers/instantly/mock-dispatch'
import { InstantlyFlagError } from '@/lib/integrations/handlers/instantly/types'
import { recordSuppression } from '@/lib/suppression/suppression-list'
const SOURCE = 'instantly'

// Lead status values, from the Instantly API v2 Lead schema.
//
//   status (readOnly, NUMBER):
//     1 Active, 2 Paused, 3 Completed, -1 Bounced, -2 Unsubscribed, -3 Skipped
//
// NUMBERS, not strings. The API returns status as a number, so a strict comparison of
// -1 against '-1' is false forever. These were previously strings AND inverted
// (BOUNCED='-2', UNSUBSCRIBED='-1'), which meant the bounce poll was filtering for
// unsubscribes and the unsubscribe poll was filtering for bounces. Both are fixed here.
//
// Do NOT confuse this axis with lt_interest_status, which is writable, is a different
// axis, and shares the same numeric values with entirely different meanings (-1 there
// is Not Interested, not Bounced). Nothing in this file touches that field.
//
// status is readOnly. It is used here only as a list filter and as a read-back check.
// It is never written.
export const INSTANTLY_LEAD_STATUS_BOUNCED = -1
export const INSTANTLY_LEAD_STATUS_UNSUBSCRIBED = -2

// Safety flag: set to true only after a real bounce has been observed end to end through
// this path, not merely after the constants were corrected. While false, polling logs a
// warning on every run. Correcting the values above does NOT earn this flag.
export const INSTANTLY_LEAD_STATUS_VERIFIED = false

type SupabaseServiceClient = SupabaseClient<Database>

export interface PollResult {
  written: number
  skipped: number
  errors: number
  // attempted: the poller got as far as issuing at least one Instantly call.
  // False when there was nothing to poll (no registered campaigns) or when the run
  // aborted before any call was made.
  attempted: boolean
  // polled: at least one Instantly call returned 2xx and a parsed result set.
  // An empty result set counts. This is the flag that separates "polled and found
  // nothing" from "never reached Instantly" — the two the old code could not tell apart.
  polled: boolean
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

// ── Poll state accounting ─────────────────────────────────────────────────────
//
// One polling_cursors row per (source, resource), written ONCE at the end of a run
// from an accumulator. Accumulating rather than writing as we go is what stops a
// later partial success from erasing an earlier real failure within the same run.
//
// Column meanings, as enforced by writePollState below:
//
//   last_run_at     The run was attempted. Written on every run, success or failure.
//                   Answers "is the cron firing at all".
//
//   last_polled_at  At least one Instantly call for this resource returned 2xx and a
//                   parsed result set. An empty page counts: zero items from a
//                   successful call IS a successful poll. NOT written when every call
//                   threw or returned non-2xx, and NOT written when the resource was
//                   skipped because there was nothing to poll.
//                   Answers "did we actually reach Instantly", which last_run_at
//                   cannot, and which is the difference between "polled and found no
//                   bounces" and "never asked".
//
//                   This REPURPOSES the column. 20260428_instantly_polling.sql:137-139
//                   reserved it as a timestamp cursor for timestamp-filtered sources.
//                   No such source exists, no code has ever written it, and it has been
//                   NULL since the table was created. Telling a silent poll apart from a
//                   clean one is worth more than a reservation nothing has claimed.
//
//   last_cursor     The pagination cursor to resume from on the next run. Advanced only
//                   on a clean run, and only for resources that resume.
//                   ALWAYS NULL for leads_bounced and leads_unsubscribed, by design, not
//                   by omission: those resources re-scan in full every run because a lead
//                   created weeks ago can bounce today and a creation-ordered cursor
//                   would skip it. See the file header. Persisting a cursor there would
//                   silently stop detecting late status changes.
//
//   error_count     Incremented by the number of failed calls in this run. Reset to 0
//                   only by a run that recorded zero failures.
//
//   last_error      The FIRST real failure of the run, carrying its HTTP status where
//                   there was one. Never overwritten by a later success in the same run.
//                   Cleared only by a run that recorded zero failures.

interface PollState {
  // At least one Instantly call returned 2xx and a parsed result set.
  polled: boolean
  // Count of failed calls this run. Drives error_count.
  failures: number
  // First failure text of the run. Later failures and later successes never replace it.
  firstError: string | null
  // Cursor to persist, and whether this run earned the right to move it.
  cursor: string | null
  advanceCursor: boolean
}

function newPollState(): PollState {
  return { polled: false, failures: 0, firstError: null, cursor: null, advanceCursor: false }
}

// Records a failure without clobbering the first one. Callers pass text that already
// carries the HTTP status where the failure came from an HTTP response.
function recordPollFailure(state: PollState, message: string): void {
  state.failures++
  if (state.firstError === null) state.firstError = message
}

async function writePollState(
  supabase: SupabaseServiceClient,
  resource: string,
  state: PollState
): Promise<void> {
  const nowISO = new Date().toISOString()

  // Read the running total only when we are about to add to it.
  let priorErrorCount = 0
  if (state.failures > 0) {
    const { data: existing } = await supabase
      .from('polling_cursors')
      .select('error_count')
      .is('organisation_id', null)
      .eq('source', SOURCE)
      .eq('resource', resource)
      .maybeSingle()
    priorErrorCount = existing?.error_count ?? 0
  }

  const row: Database['public']['Tables']['polling_cursors']['Insert'] = {
    organisation_id: null,
    source: SOURCE,
    resource,
    last_run_at: nowISO,
    error_count: state.failures > 0 ? priorErrorCount + state.failures : 0,
    last_error: state.failures > 0 ? state.firstError : null,
    updated_at: nowISO,
  }

  // Keys omitted from an upsert payload are absent from the ON CONFLICT SET clause,
  // so leaving these out preserves the stored value rather than nulling it.
  if (state.polled) row.last_polled_at = nowISO
  if (state.advanceCursor) row.last_cursor = state.cursor

  const { error } = await supabase
    .from('polling_cursors')
    .upsert(row, { onConflict: 'organisation_id,source,resource' })

  if (error) {
    // The poll itself may have succeeded — this is the bookkeeping failing, which is
    // exactly the class of silence this change exists to remove. Say so loudly.
    Sentry.captureException(
      new Error(`polling_cursors write failed [${resource}]: ${error.message}`),
      { level: 'warning', extra: { resource, polled: state.polled, failures: state.failures } }
    )
    logger.error('Instantly poll: failed to write polling_cursors state', {
      resource,
      error: error.message,
    })
  }
}

// ── Outbound body capture (best-effort, non-blocking) ─────────────────────────

// Candidate field names in the Instantly reply email object that may reference
// the UUID of the original outbound email. Checked in order — first non-empty string wins.
const OUTBOUND_UUID_CANDIDATE_FIELDS = [
  'reply_to_uuid',
  'in_reply_to_uuid',
  'original_email_uuid',
]

interface OutboundEmailCapture {
  body: string | null
  messageId: string | null
}

// Fetches the original outbound email body from Instantly using a thread reference UUID
// found in the reply object. Returns nulls on any failure — never throws.
// 5-second timeout prevents stalling the poll loop on slow API responses.
async function fetchOutboundEmailBody(
  emailObj: Record<string, unknown>,
  apiKey: string,
  baseUrl: string,
  isActive: boolean,
): Promise<OutboundEmailCapture> {
  // Safety gate: flag off + INSTANTLY_API_BASE_URL pointing at production = misconfiguration.
  if (!isActive && !shouldUseMockDispatch(isActive) && baseUrl.includes('api.instantly.ai')) {
    throw new InstantlyFlagError('fetchOutboundEmailBody: instantly_api_active is false — cannot call production Instantly')
  }

  let outboundUuid: string | null = null
  for (const field of OUTBOUND_UUID_CANDIDATE_FIELDS) {
    const val = emailObj[field]
    if (typeof val === 'string' && val.trim().length > 0) {
      outboundUuid = val.trim()
      break
    }
  }

  if (!outboundUuid) return { body: null, messageId: null }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)

  try {
    const response = shouldUseMockDispatch(isActive)
      ? mockEmailGet(outboundUuid)
      : await fetch(`${baseUrl}/emails/${outboundUuid}`, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        })

    if (!response.ok) {
      logger.warn('Instantly poll: outbound email fetch failed', {
        uuid: outboundUuid,
        status: response.status,
      })
      return { body: null, messageId: outboundUuid }
    }

    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!json) return { body: null, messageId: outboundUuid }

    // Prefer plain-text body; fall back to html body field.
    const bodyText =
      (typeof json.body_text === 'string' && json.body_text.trim().length > 0
        ? json.body_text
        : null) ??
      (typeof json.body === 'string' && json.body.trim().length > 0 ? json.body : null)

    return { body: bodyText, messageId: outboundUuid }
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError'
    logger.warn('Instantly poll: outbound email fetch error', {
      uuid: outboundUuid,
      error: isAbort ? 'timeout' : String(err),
    })
    return { body: null, messageId: outboundUuid }
  } finally {
    clearTimeout(timeoutId)
  }
}

// ── Returned-lead status verification ─────────────────────────────────────────
//
// The list request carries a status filter, but a filter is a request, not a guarantee.
// Before this existed the poller wrote a signal for every row that came back and never
// looked at the row, so an ignored filter, a renamed field, or a changed enum would all
// have produced confidently mislabelled data with no error anywhere. This is the check
// that makes the classification something we observed rather than something we asked for.
//
// A string is deliberately NOT coerced. If Instantly starts returning "-1" instead of -1,
// that is a schema change worth seeing, and Number(raw) would paper over it silently —
// which is the exact failure mode this function exists to catch.

type LeadStatusVerdict =
  | { ok: true }
  | { ok: false; reason: string }

function verifyLeadStatus(
  lead: Record<string, unknown>,
  expectedStatus: number
): LeadStatusVerdict {
  const raw = lead.status

  if (typeof raw !== 'number') {
    return {
      ok: false,
      reason:
        raw === undefined
          ? 'no status field on the returned lead'
          : `status is ${typeof raw} ${JSON.stringify(raw)}, expected a number`,
    }
  }

  if (raw !== expectedStatus) {
    return { ok: false, reason: `status is ${raw}, expected ${expectedStatus}` }
  }

  return { ok: true }
}

// ── Signal writer ─────────────────────────────────────────────────────────────

// Returns { outcome, signalId }.
// 'skipped' means the idempotency constraint fired (signal already exists) — normal, not an error.
//
// signalId is the id of the row just inserted, and is null for 'skipped' and 'error'.
// It exists so a caller can record provenance against the signal that caused a side
// effect: the bounce and unsubscribe path writes it to suppressed_emails.source_signal_id.
// On 'skipped' the row exists but its id was not returned by the conflicting insert,
// which is why source_signal_id is nullable rather than worth a second round trip.
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
    original_outbound_body?: string | null
    original_outbound_message_id?: string | null
  }
): Promise<{ outcome: 'written' | 'skipped' | 'error'; signalId: string | null }> {
  const { data, error } = await supabase.from('signals').insert({
    organisation_id: params.organisation_id,
    campaign_id: params.campaign_id,
    prospect_id: params.prospect_id,
    signal_type: params.signal_type,
    source: params.source,
    external_event_id: params.external_event_id,
    raw_data: params.raw_data,
    processed: false,
    original_outbound_body: params.original_outbound_body ?? null,
    original_outbound_message_id: params.original_outbound_message_id ?? null,
  }).select('id')

  if (!error) {
    const signalId = (data?.[0]?.id as string | undefined) ?? null
    return { outcome: 'written', signalId }
  }

  // Unique constraint violation = idempotency fired = already written. Not an error.
  if (error.code === '23505') return { outcome: 'skipped', signalId: null }

  // Error code in the message text so Sentry deduplicates CHECK violations (23514),
  // FK violations (23503), and others as distinct issues.
  // No flush here — inside a polling loop; the cron route's error-path flush drains the buffer.
  Sentry.captureException(
    new Error(`Signal write failed [${params.signal_type}] (${error.code}): ${error.message}`),
    { level: 'warning', extra: { signal_type: params.signal_type, external_event_id: params.external_event_id, code: error.code } }
  )
  logger.error('Instantly poll: failed to write signal', {
    signal_type: params.signal_type,
    external_event_id: params.external_event_id,
    error: error.message,
  })
  return { outcome: 'error', signalId: null }
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

// Return shape shared by both API clients.
// `status` is the HTTP status where there was a response, null for network/parse
// failures that never produced one. It is reported separately from `error` so the
// per-campaign log and last_error can both carry it without re-parsing the message.
interface InstantlyListResponse {
  data: unknown[] | null
  nextCursor: string | null
  error: string | null
  status: number | null
}

// GET request — used for /emails (cursor-based, query params)
async function instantlyGet(
  path: string,
  apiKey: string,
  params: Record<string, string>,
  baseUrl: string,
  isActive: boolean,
): Promise<InstantlyListResponse> {
  // Safety gate: flag off + INSTANTLY_API_BASE_URL pointing at production = misconfiguration.
  if (!isActive && !shouldUseMockDispatch(isActive) && baseUrl.includes('api.instantly.ai')) {
    throw new InstantlyFlagError('instantlyGet: instantly_api_active is false — cannot call production Instantly')
  }

  let response: Response

  if (shouldUseMockDispatch(isActive)) {
    // Mock: /emails → empty list; other paths not expected in polling
    response = mockEmailsList()
  } else {
    const url = new URL(`${baseUrl}${path}`)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value)
      }
    }
    try {
      response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      })
    } catch (err) {
      return { data: null, nextCursor: null, error: `Network error: ${String(err)}`, status: null }
    }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    return {
      data: null,
      nextCursor: null,
      error: `Instantly API ${response.status}: ${body.slice(0, 200)}`,
      status: response.status,
    }
  }

  const json = await response.json().catch(() => null)
  if (!json) {
    return {
      data: null,
      nextCursor: null,
      error: `Instantly API ${response.status}: returned non-JSON response`,
      status: response.status,
    }
  }

  const { data, nextCursor } = parseInstantlyResponse(json)
  return { data, nextCursor, error: null, status: response.status }
}

// POST request — used for /leads/list (Instantly V2 list endpoints use POST with JSON body)
async function instantlyPost(
  path: string,
  apiKey: string,
  body: Record<string, unknown>,
  baseUrl: string,
  isActive: boolean,
): Promise<InstantlyListResponse> {
  // Safety gate: flag off + INSTANTLY_API_BASE_URL pointing at production = misconfiguration.
  if (!isActive && !shouldUseMockDispatch(isActive) && baseUrl.includes('api.instantly.ai')) {
    throw new InstantlyFlagError('instantlyPost: instantly_api_active is false — cannot call production Instantly')
  }

  let response: Response
  if (shouldUseMockDispatch(isActive)) {
    response = mockLeadsList()
  } else {
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      return { data: null, nextCursor: null, error: `Network error: ${String(err)}`, status: null }
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return {
      data: null,
      nextCursor: null,
      error: `Instantly API ${response.status}: ${text.slice(0, 200)}`,
      status: response.status,
    }
  }

  const json = await response.json().catch(() => null)
  if (!json) {
    return {
      data: null,
      nextCursor: null,
      error: `Instantly API ${response.status}: returned non-JSON response`,
      status: response.status,
    }
  }

  const { data, nextCursor } = parseInstantlyResponse(json)
  return { data, nextCursor, error: null, status: response.status }
}

// ── Reply polling (cursor-based) ──────────────────────────────────────────────

export async function pollInstantlyReplies(
  supabase: SupabaseServiceClient,
  apiKey: string
): Promise<PollResult> {
  if (!INSTANTLY_LEAD_STATUS_VERIFIED) {
    logger.warn('Instantly poll: operating on UNVERIFIED lead status values pending live confirmation', {
      bounce_value: INSTANTLY_LEAD_STATUS_BOUNCED,
      unsubscribe_value: INSTANTLY_LEAD_STATUS_UNSUBSCRIBED,
      field_unconfirmed: true,
      fix: 'See BACKLOG: Instantly bounce/unsub detection - live field and value verification',
    })
  }

  const isActive = await getInstantlyApiActive()
  const baseUrl = resolveInstantlyBaseUrl(isActive)
  const resource = 'replies'
  const result: PollResult = { written: 0, skipped: 0, errors: 0, attempted: false, polled: false }
  const campaignCache = new Map<string, ResolvedCampaign | null>()
  const state = newPollState()

  let cursor = await getCursor(supabase, resource)
  let pageCount = 0
  const MAX_PAGES = 50 // safety ceiling — prevents runaway pagination on a very large backlog
  const PAGE_LIMIT = 100

  try {
    while (pageCount < MAX_PAGES) {
      pageCount++

      const params: Record<string, string> = {
        email_type: 'received',
        sort_order: 'asc',
        limit: String(PAGE_LIMIT),
      }
      if (cursor) params.starting_after = cursor

      result.attempted = true
      const { data: emails, nextCursor, error, status } = await instantlyGet('/emails', apiKey, params, baseUrl, isActive)

      if (error) {
        recordPollFailure(state, error)
        logger.error('Instantly poll: reply fetch failed', {
          resource,
          error,
          http_status: status,
          page: pageCount,
          requested: PAGE_LIMIT,
        })
        result.errors++
        // Cursor is not advanced: the page that failed must be re-fetched next run.
        return result
      }

      // A 2xx with a parsed body is a real poll, even when it carried zero items.
      state.polled = true
      result.polled = true

      logger.info('Instantly poll: reply page fetched', {
        resource,
        page: pageCount,
        http_status: status,
        requested: PAGE_LIMIT,
        returned: emails?.length ?? 0,
        cursor_returned: nextCursor !== null,
      })

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

        const eaccount = e.eaccount as string | undefined
        if (!eaccount) {
          // Without eaccount the signal is permanently stuck at dispatch ("raw_data missing id or eaccount").
          logger.warn('Instantly poll: reply email missing eaccount — skipping to prevent stuck signal', {
            email_id: emailId,
            from_email: (e.from_address_email ?? null) as string | null,
            instantly_campaign_id: (instantlyCampaignId ?? null) as string | null,
          })
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

        const outbound = await fetchOutboundEmailBody(e, apiKey, baseUrl, isActive)

        const { outcome } = await writeSignal(supabase, {
          organisation_id: campaignRow.organisation_id,
          campaign_id: campaignRow.id,
          prospect_id: null, // prospect linkage is downstream signal processing concern
          signal_type: 'reply_received',
          source: SOURCE,
          external_event_id: emailId,
          raw_data: e as Json,
          original_outbound_body: outbound.body,
          original_outbound_message_id: outbound.messageId,
        })

        if (outcome === 'written') result.written++
        else if (outcome === 'skipped') result.skipped++
        else result.errors++
      }

      // Advance the cursor after processing the page, so a mid-page failure doesn't
      // advance past unprocessed events.
      // Prefer the cursor Instantly returned: next_starting_after is by definition the
      // value to send as starting_after. Fall back to the last email's id, which is what
      // this code has always used, so behaviour is unchanged whenever no cursor comes back.
      const lastEmail = emails[emails.length - 1] as Record<string, unknown>
      const lastId = lastEmail?.id as string | undefined
      if (nextCursor) cursor = nextCursor
      else if (lastId) cursor = lastId

      if (!nextCursor) break
    }

    // Clean completion: this run earned the right to move the stored cursor.
    state.advanceCursor = true
    state.cursor = cursor
    logger.info('Instantly poll: replies polled', { resource, ...result, pages: pageCount })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    recordPollFailure(state, msg)
    logger.error('Instantly poll: reply polling threw', { resource, error: msg })
    result.errors++
  } finally {
    // One write per run, whatever happened — including the early return on fetch failure.
    await writePollState(supabase, resource, state)
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
  instantlyStatus: number,
  signalType: 'email_bounced' | 'lead_unsubscribed'
): Promise<PollResult> {
  if (!INSTANTLY_LEAD_STATUS_VERIFIED) {
    logger.warn('Instantly poll: operating on UNVERIFIED lead status values pending live confirmation', {
      signal_type: signalType,
      requested_status: instantlyStatus,
      bounce_value: INSTANTLY_LEAD_STATUS_BOUNCED,
      unsubscribe_value: INSTANTLY_LEAD_STATUS_UNSUBSCRIBED,
      field_unconfirmed: true,
      fix: 'See BACKLOG: Instantly bounce/unsub detection - live field and value verification',
    })
  }

  const isActive = await getInstantlyApiActive()
  const baseUrl = resolveInstantlyBaseUrl(isActive)
  const resource = signalType === 'email_bounced' ? 'leads_bounced' : 'leads_unsubscribed'
  const result: PollResult = { written: 0, skipped: 0, errors: 0, attempted: false, polled: false }
  const state = newPollState()

  // last_cursor stays NULL for this resource on purpose. See writePollState's notes:
  // these resources re-scan in full every run, so state.advanceCursor is never set.

  // Fetch campaigns registered in our system that have an Instantly campaign UUID.
  // Exclude campaigns belonging to archived organisations — do not spend credits on archived clients.
  const { data: campaigns, error: campaignsError } = await supabase
    .from('campaigns')
    .select('id, organisation_id, external_id, organisations!inner(archived_at)')
    .not('external_id', 'is', null)
    .is('organisations.archived_at', null)

  if (campaignsError) {
    logger.error('Instantly poll: failed to fetch campaigns for lead status scan', {
      resource,
      signal_type: signalType,
      error: campaignsError.message,
    })
    recordPollFailure(state, `campaigns query failed: ${campaignsError.message}`)
    result.errors++
    await writePollState(supabase, resource, state)
    return result
  }

  if (!campaigns || campaigns.length === 0) {
    // Nothing to poll is not a failure, but it is also not a poll: last_polled_at stays
    // untouched so this reads as "did not reach Instantly", not as a clean scan.
    logger.info('Instantly poll: no campaigns registered — lead status scan skipped', {
      resource,
      signal_type: signalType,
      campaigns_scanned: 0,
      fix: 'Insert a row into campaigns with external_id = the Instantly campaign UUID',
    })
    await writePollState(supabase, resource, state)
    return result
  }

  let totalPages = 0
  let campaignsPolled = 0
  let campaignsFailed = 0

  try {
    for (const campaign of campaigns) {
      const instantlyCampaignId = campaign.external_id! // non-null: filtered above

      let pageCursor: string | null = null
      let pageCount = 0
      let campaignFailed = false
      let campaignPolled = false
      const MAX_PAGES_PER_CAMPAIGN = 50
      const PAGE_LIMIT = 100

      while (pageCount < MAX_PAGES_PER_CAMPAIGN) {
        pageCount++
        totalPages++

        const body: Record<string, unknown> = {
          status: instantlyStatus,
          campaign: instantlyCampaignId,
          limit: PAGE_LIMIT,
        }
        if (pageCursor) body.starting_after = pageCursor

        result.attempted = true
        const { data: leads, nextCursor, error, status } = await instantlyPost('/leads/list', apiKey, body, baseUrl, isActive)

        if (error) {
          // Log and move on to the next campaign — one campaign failure doesn't abort the run.
          logger.error('Instantly poll: lead status fetch failed', {
            resource,
            signal_type: signalType,
            campaign_external_id: instantlyCampaignId,
            error,
            http_status: status,
            page: pageCount,
            requested: PAGE_LIMIT,
          })
          recordPollFailure(
            state,
            `campaign ${instantlyCampaignId} page ${pageCount}: ${error}`
          )
          campaignFailed = true
          result.errors++
          break
        }

        // A 2xx with a parsed body is a real poll, even when it carried zero leads.
        campaignPolled = true
        state.polled = true
        result.polled = true

        logger.info('Instantly poll: lead status page fetched', {
          resource,
          signal_type: signalType,
          campaign_external_id: instantlyCampaignId,
          page: pageCount,
          http_status: status,
          requested: PAGE_LIMIT,
          returned: leads?.length ?? 0,
          cursor_returned: nextCursor !== null,
        })

        if (!leads || leads.length === 0) break

        // Mismatches are counted per page and reported once, rather than once per row.
        // A filter that is being ignored returns a whole page of wrong rows, and one
        // recordPollFailure per row would add 100 to error_count for a single bad call.
        // One call that misbehaved is one failure; the row count goes in the message.
        let pageMismatches = 0
        let firstMismatchReason: string | null = null

        for (const lead of leads) {
          const l = lead as Record<string, unknown>
          const leadId = l.id as string | undefined

          if (!leadId) {
            logger.warn('Instantly poll: lead missing id field', { signal_type: signalType })
            result.errors++
            continue
          }

          // The filter asked for this status. Confirm the row actually carries it before
          // writing a signal that asserts it does.
          const verdict = verifyLeadStatus(l, instantlyStatus)
          if (!verdict.ok) {
            pageMismatches++
            if (firstMismatchReason === null) firstMismatchReason = verdict.reason
            logger.error('Instantly poll: returned lead does not carry the requested status', {
              resource,
              signal_type: signalType,
              campaign_external_id: instantlyCampaignId,
              page: pageCount,
              lead_id: leadId,
              requested_status: instantlyStatus,
              reason: verdict.reason,
            })
            result.errors++
            continue
          }

          // campaign_id and organisation_id come from the campaigns row — no extra lookup.
          const { outcome, signalId } = await writeSignal(supabase, {
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

          // ── Suppression: the signal is the detection, this is the consequence ────
          //
          // Closes audit finding D2. Detection was correct as of fcb2f94 and fed
          // nothing; a bounce wrote a row to signals and no send path ever read it.
          //
          // Runs on 'skipped' as well as 'written', deliberately. A skipped signal means
          // the poller has seen this lead before, which for a full-scan resource is the
          // NORMAL case on every run after the first. It also covers signals written
          // before this wiring existed. recordSuppression is idempotent, so re-recording
          // an address already on the list is a no-op that returns 'already_suppressed'.
          //
          // Not on 'error': if the signal did not land, do not act on it.
          if (outcome !== 'error') {
            const leadEmail = typeof l.email === 'string' ? l.email : null

            if (!leadEmail) {
              // A bounced lead with no address cannot be suppressed. Loud, because it
              // means a real bounce is going unenforced.
              logger.error('Instantly poll: bounced/unsubscribed lead has no email — cannot suppress', {
                signal_type: signalType,
                lead_id: leadId,
                organisation_id: campaign.organisation_id,
              })
              result.errors++
            } else {
              const suppression = await recordSuppression(supabase, {
                email: leadEmail,
                reason: signalType === 'email_bounced' ? 'bounced' : 'unsubscribed',
                source_org_id: campaign.organisation_id,
                source_signal_id: signalId,
              })
              // A failed suppression write is a failed poll. The signal exists but the
              // gate it feeds does not, which is exactly the D2 state this closes.
              if (suppression === 'error') {
                result.errors++
                recordPollFailure(
                  state,
                  `campaign ${instantlyCampaignId} page ${pageCount}: suppression write failed for lead ${leadId}`
                )
                campaignFailed = true
              }
            }
          }
        }

        if (pageMismatches > 0) {
          // Surfaces through writePollState into last_error and error_count, and makes
          // the run's ok false. A status filter that is not being honoured is a broken
          // poll, not a quiet skip.
          campaignFailed = true
          recordPollFailure(
            state,
            `campaign ${instantlyCampaignId} page ${pageCount}: ` +
            `${pageMismatches}/${leads.length} returned leads did not carry status ` +
            `${instantlyStatus} (first: ${firstMismatchReason})`
          )
        }

        if (!nextCursor) break
        pageCursor = nextCursor
      }

      if (campaignFailed) campaignsFailed++
      if (campaignPolled) campaignsPolled++
    }

    logger.info('Instantly poll: lead status scan complete', {
      resource,
      signal_type: signalType,
      requested_status: instantlyStatus,
      campaigns_scanned: campaigns.length,
      campaigns_polled: campaignsPolled,
      campaigns_failed: campaignsFailed,
      total_pages: totalPages,
      ...result,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    recordPollFailure(state, msg)
    logger.error('Instantly poll: lead status polling threw', {
      resource,
      signal_type: signalType,
      error: msg,
    })
    result.errors++
  } finally {
    // One write per run, whatever happened. state.advanceCursor is deliberately never
    // set for this resource, so last_cursor is left untouched: see writePollState.
    await writePollState(supabase, resource, state)
  }

  return result
}
