// Fetches per-mailbox sending health through the registered capability, stores it, and
// recomputes the verdict MON-023 reads.
//
// TOOL AGNOSTIC BY CONSTRUCTION. This file names no sending tool. It asks
// integrations_registry which tool currently provides can_report_sending_health and
// dispatches to that tool's handler. Swapping tools is a registry row plus a handler,
// and nothing here, in the cron route, in mon_023 or on the dashboard changes (ADR-001).
//
// The provider map below is the ONE place above the handler directory where a tool name
// appears, which is exactly what the registry pattern asks for: a single lookup table
// rather than tool names scattered through calling code.

import { SupabaseClient } from '@supabase/supabase-js'
import { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import { evaluateSendingHealth, sendingHealthWindow, type MailboxDailyStat } from './evaluate'
import { FETCH_LOOKBACK_DAYS } from './thresholds'

type ServiceClient = SupabaseClient<Database>

const CAPABILITY = 'can_report_sending_health'

/** What any sending tool must provide to satisfy the capability. */
export interface SendingHealthProvider {
  fetch(startDate: string, endDate: string): Promise<{
    rows: Array<MailboxDailyStat & { mailbox: string }>
    mailboxCount: number
    dropped: string[]
  }>
}

/**
 * Resolves the tool currently registered for the capability and returns its handler.
 *
 * Fails LOUDLY on an unknown tool rather than falling back to a default. A silent
 * fallback would mean a registry row pointing at a tool nobody implemented still produced
 * numbers, from the wrong place, with nothing to say so.
 */
export async function resolveSendingHealthProvider(
  supabase: ServiceClient,
): Promise<SendingHealthProvider | null> {
  const { data, error } = await supabase
    .from('integrations_registry')
    .select('tool_name, is_active')
    .eq('capability', CAPABILITY)
    .maybeSingle()

  if (error) {
    throw new Error(`Sending health: registry lookup failed: ${error.message}`)
  }
  if (!data) {
    logger.warn('Sending health: no tool registered for capability', { capability: CAPABILITY })
    return null
  }
  if (!data.is_active) {
    logger.info('Sending health: registered tool is inactive, skipping', { capability: CAPABILITY })
    return null
  }

  switch (data.tool_name) {
    case 'instantly': {
      // Imported lazily so this module does not pull a specific tool's client into every
      // caller's bundle, and so an unregistered tool costs nothing at import time.
      const [{ fetchSendingHealth }, { getInstantlyApiKey, getInstantlyApiActive }, { resolveInstantlyBaseUrl }] =
        await Promise.all([
          import('@/lib/integrations/handlers/instantly/sending-health'),
          import('@/lib/integrations/handlers/instantly/auth'),
          import('@/lib/integrations/handlers/instantly/constants'),
        ])
      return {
        async fetch(startDate, endDate) {
          const isActive = await getInstantlyApiActive()
          const apiKey = await getInstantlyApiKey('')
          const baseUrl = resolveInstantlyBaseUrl(isActive)
          return fetchSendingHealth(apiKey, isActive, baseUrl, startDate, endDate)
        },
      }
    }
    default:
      throw new Error(
        `Sending health: registry names tool "${data.tool_name}" for ${CAPABILITY}, ` +
        `but no handler is wired for it. Add one, or point the registry row at a tool that has one.`
      )
  }
}

export interface SyncResult {
  attempted:    boolean
  rowsFetched:  number
  rowsUpserted: number
  mailboxCount: number
  dropped:      number
  verdict:      string | null
  errors:       string[]
}

/**
 * Returns the inclusive date range each cron run re-fetches.
 * Pure and exported so the lookback is testable without a clock or a network.
 */
export function fetchWindow(now: Date, lookbackDays: number = FETCH_LOOKBACK_DAYS): { start: string; end: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - (lookbackDays - 1))
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

/**
 * One sync: fetch the recent window, upsert it, recompute the verdict.
 *
 * IDEMPOTENT. The upsert conflicts on (stat_date, mailbox), so running this twice
 * overwrites the same rows with the same figures rather than adding to them. The verdict
 * is a single row keyed id = 1, so it is replaced rather than appended.
 *
 * Never throws. A sending-health failure must not abort the poll it rides along with, so
 * problems come back in `errors` for the caller to report.
 */
export async function syncSendingHealth(
  supabase: ServiceClient,
  options: { now?: Date; startDate?: string; endDate?: string } = {},
): Promise<SyncResult> {
  const now = options.now ?? new Date()
  const result: SyncResult = {
    attempted: false, rowsFetched: 0, rowsUpserted: 0, mailboxCount: 0,
    dropped: 0, verdict: null, errors: [],
  }

  let provider: SendingHealthProvider | null
  try {
    provider = await resolveSendingHealthProvider(supabase)
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err))
    return result
  }
  if (!provider) return result

  const window = options.startDate && options.endDate
    ? { start: options.startDate, end: options.endDate }
    : fetchWindow(now)

  result.attempted = true

  // ── Fetch ──────────────────────────────────────────────────────────────────
  let fetched: Awaited<ReturnType<SendingHealthProvider['fetch']>>
  try {
    fetched = await provider.fetch(window.start, window.end)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(`fetch failed: ${msg}`)
    logger.error('Sending health: fetch failed', { error: msg, window })
    return result
  }

  result.rowsFetched  = fetched.rows.length
  result.mailboxCount = fetched.mailboxCount
  result.dropped      = fetched.dropped.length

  // ── Store ──────────────────────────────────────────────────────────────────
  if (fetched.rows.length > 0) {
    const payload = fetched.rows.map(r => ({
      stat_date:      r.statDate,
      mailbox:        r.mailbox,
      sending_domain: r.domain,
      sends:          r.sends,
      bounces:        r.bounces,
      fetched_at:     now.toISOString(),
    }))

    const { error } = await supabase
      .from('sending_mailbox_daily_stats')
      .upsert(payload, { onConflict: 'stat_date,mailbox' })

    if (error) {
      result.errors.push(`upsert failed: ${error.message}`)
      logger.error('Sending health: upsert failed', { error: error.message })
      return result
    }
    result.rowsUpserted = payload.length
  }

  // ── Recompute the verdict ──────────────────────────────────────────────────
  //
  // Read back from the TABLE rather than judging the rows just fetched. The window is
  // seven days and the fetch is three, so judging only what was fetched would silently
  // drop four days of denominator and inflate every rate.
  const { start: windowStart, end: windowEnd } = sendingHealthWindow(now)

  const { data: windowRows, error: readError } = await supabase
    .from('sending_mailbox_daily_stats')
    .select('stat_date, sending_domain, sends, bounces')
    .gte('stat_date', windowStart)
    .lte('stat_date', windowEnd)

  if (readError) {
    result.errors.push(`window read failed: ${readError.message}`)
    return result
  }

  const verdict = evaluateSendingHealth(
    (windowRows ?? []).map(r => ({
      statDate: r.stat_date,
      domain:   r.sending_domain,
      sends:    r.sends ?? 0,
      bounces:  r.bounces ?? 0,
    })),
    now,
  )

  const { error: snapshotError } = await supabase
    .from('sending_health_snapshot')
    .upsert({
      id:            1,
      overall_state: verdict.state,
      detail:        verdict.detail,
      window_start:  verdict.windowStart,
      window_end:    verdict.windowEnd,
      // Structurally JSON already, but DomainHealth is an interface without an index
      // signature so it does not satisfy the generated Json type. Round-tripping rather
      // than casting keeps the stored shape honest: if a field is ever added that is not
      // JSON-representable, this throws here instead of storing something unreadable.
      domains:       JSON.parse(JSON.stringify(verdict.domains)),
      computed_at:   now.toISOString(),
    }, { onConflict: 'id' })

  if (snapshotError) {
    result.errors.push(`snapshot write failed: ${snapshotError.message}`)
    return result
  }

  result.verdict = verdict.state
  logger.info('Sending health: synced', {
    window, rows: result.rowsUpserted, mailboxes: result.mailboxCount, verdict: verdict.state,
  })

  return result
}
