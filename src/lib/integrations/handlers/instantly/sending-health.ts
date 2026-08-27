// Instantly handler for the can_report_sending_health capability.
//
// THE API BOUNDARY. Everything Instantly-shaped stops here: endpoint paths, the
// `email_account` / `bounced` field names, the mandatory-emails-filter quirk, and the
// 31-day range cap. Callers above this file see MailboxDailyStat and nothing else, so
// swapping the sending tool is a new handler plus a registry row (ADR-001).
//
// ═════════════════════════════════════════════════════════════════════════════
// TWO CALLS, NOT ONE, AND THE SECOND ONE NEEDS THE FIRST
//
// GET /accounts/analytics/daily returns HTTP 413 with no `emails` filter — measured
// 2026-08-27, and it does it even for a single day, so the filter is effectively
// mandatory for this workspace rather than an optimisation. That means the mailbox list
// has to be fetched first from GET /accounts and passed in explicitly.
//
// A NOTE ON PAGINATION, because it will bite whoever changes this next. GET /accounts
// returns `next_starting_after` even on the FINAL page. Ten accounts came back with a
// cursor attached, and requesting that cursor returned an empty list. So the loop must
// terminate on an empty page, not on the absence of a cursor.
//
// READS ONLY. Nothing in this file writes to Instantly. No campaign, account or daily
// limit is touched, by construction: there is no POST, PATCH or DELETE here.

import { logger } from '@/lib/logger'
import { shouldUseMockDispatch } from './constants'
import { InstantlyFlagError } from './types'
import { deriveSendingDomain, type MailboxDailyStat } from '@/lib/sending-health/evaluate'
import { PROVIDER_MAX_RANGE_DAYS } from '@/lib/sending-health/thresholds'

/** One mailbox-day, capability-shaped, with the mailbox kept for the caller to store. */
export interface MailboxDailyStatRow extends MailboxDailyStat {
  mailbox: string
}

export interface SendingHealthFetchResult {
  rows: MailboxDailyStatRow[]
  /** Mailboxes the provider listed, so the caller can report coverage honestly. */
  mailboxCount: number
  /** Rows the provider returned that had to be dropped, with the reason. Never silent. */
  dropped: string[]
}

// ── Raw Instantly shapes, subset of the fields we use ────────────────────────

interface InstantlyAccountRow {
  email?: string
}

interface InstantlyAccountsPage {
  items?: InstantlyAccountRow[]
  next_starting_after?: string
}

interface InstantlyDailyAccountRow {
  date?: string
  email_account?: string
  sent?: number
  bounced?: number
}

function authHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
}

function assertRealCallAllowed(isActive: boolean, baseUrl: string, fn: string): void {
  // Same safety gate as every other handler: flag off while pointed at production is a
  // misconfiguration, not something to paper over.
  if (!isActive && !shouldUseMockDispatch(isActive) && baseUrl.includes('api.instantly.ai')) {
    throw new InstantlyFlagError(`${fn}: instantly_api_active is false — cannot call production Instantly`)
  }
}

/**
 * Lists every sending mailbox in the workspace.
 *
 * Terminates on an empty page. See the pagination note in the file header: a cursor
 * coming back does NOT mean there is another page.
 */
export async function fetchSendingMailboxes(
  apiKey: string,
  isActive: boolean,
  baseUrl: string,
): Promise<string[]> {
  assertRealCallAllowed(isActive, baseUrl, 'fetchSendingMailboxes')

  if (shouldUseMockDispatch(isActive)) return []

  const mailboxes: string[] = []
  let cursor: string | null = null
  // Ten mailboxes today, fifteen this week. 20 pages of 100 is 2,000 accounts, which is
  // far beyond any real workspace and bounds the loop against a cursor that never settles.
  const MAX_PAGES = 20

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${baseUrl}/accounts`)
    url.searchParams.set('limit', '100')
    if (cursor) url.searchParams.set('starting_after', cursor)

    let response: Response
    try {
      response = await fetch(url.toString(), { headers: authHeaders(apiKey) })
    } catch (err) {
      throw new Error(`Sending mailbox list network error: ${String(err)}`)
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)')
      throw new Error(`Sending mailbox list API error ${response.status}: ${body.slice(0, 200)}`)
    }

    const json = (await response.json().catch(() => null)) as InstantlyAccountsPage | null
    if (!json) throw new Error('Sending mailbox list response was not valid JSON')

    const items = Array.isArray(json.items) ? json.items : []
    // THE TERMINATION CONDITION. Empty page, not absent cursor.
    if (items.length === 0) break

    for (const item of items) {
      if (typeof item.email === 'string' && item.email.length > 0) {
        mailboxes.push(item.email.trim().toLowerCase())
      }
    }

    if (typeof json.next_starting_after !== 'string' || json.next_starting_after.length === 0) break
    cursor = json.next_starting_after
  }

  return mailboxes
}

/**
 * Splits an inclusive date range into chunks the provider will accept.
 *
 * Exported and pure so the 31-day cap is testable without a network call. The cap is not
 * a tuning knob: the live API answered `HTTP 400: Analytics date range cannot exceed 31
 * days` on 2026-08-27.
 */
export function chunkDateRange(
  startDate: string,
  endDate: string,
  maxDays: number = PROVIDER_MAX_RANGE_DAYS,
): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = []
  const final = new Date(`${endDate}T00:00:00.000Z`)
  let cursor = new Date(`${startDate}T00:00:00.000Z`)

  if (Number.isNaN(cursor.getTime()) || Number.isNaN(final.getTime())) {
    throw new Error(`chunkDateRange: invalid range ${startDate} to ${endDate}`)
  }
  if (cursor > final) return []

  while (cursor <= final) {
    const chunkEnd = new Date(cursor)
    // Inclusive of both ends, so a maxDays-wide chunk spans maxDays - 1 days of offset.
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + (maxDays - 1))
    const end = chunkEnd > final ? final : chunkEnd
    chunks.push({ start: cursor.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) })
    cursor = new Date(end)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return chunks
}

/**
 * Fetches daily sends and bounces per mailbox for an inclusive date range.
 *
 * Rows whose mailbox cannot be parsed into a domain are DROPPED AND REPORTED rather than
 * bucketed under a guessed domain. Inventing a domain would put real sends under a label
 * nothing else uses and quietly shrink a real domain's denominator.
 */
export async function fetchSendingHealth(
  apiKey: string,
  isActive: boolean,
  baseUrl: string,
  startDate: string,
  endDate: string,
): Promise<SendingHealthFetchResult> {
  assertRealCallAllowed(isActive, baseUrl, 'fetchSendingHealth')

  if (shouldUseMockDispatch(isActive)) {
    return { rows: [], mailboxCount: 0, dropped: [] }
  }

  const mailboxes = await fetchSendingMailboxes(apiKey, isActive, baseUrl)
  if (mailboxes.length === 0) {
    logger.warn('Sending health: provider listed no mailboxes', { start_date: startDate, end_date: endDate })
    return { rows: [], mailboxCount: 0, dropped: [] }
  }

  const rows: MailboxDailyStatRow[] = []
  const dropped: string[] = []

  for (const chunk of chunkDateRange(startDate, endDate)) {
    const url = new URL(`${baseUrl}/accounts/analytics/daily`)
    url.searchParams.set('start_date', chunk.start)
    url.searchParams.set('end_date', chunk.end)
    // Mandatory for this workspace, not an optimisation. See the file header.
    url.searchParams.set('emails', mailboxes.join(','))

    let response: Response
    try {
      response = await fetch(url.toString(), { headers: authHeaders(apiKey) })
    } catch (err) {
      throw new Error(`Sending health network error: ${String(err)}`)
    }

    if (response.status === 413) {
      throw new Error(
        `Sending health API returned 413 for ${chunk.start}..${chunk.end} with ` +
        `${mailboxes.length} mailboxes. The workspace has outgrown a single request: ` +
        `split the mailbox list, not the date range.`
      )
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)')
      throw new Error(`Sending health API error ${response.status}: ${body.slice(0, 200)}`)
    }

    const json = await response.json().catch(() => null)
    // Instantly wraps this one in { result: [...] }, unlike /campaigns/analytics which
    // returns a bare array. Both shapes accepted so a wrapper change is not an outage.
    const raw: unknown = json && typeof json === 'object' && 'result' in (json as object)
      ? (json as { result: unknown }).result
      : json

    if (!Array.isArray(raw)) {
      logger.warn('Sending health: response was not an array', { type: typeof raw, chunk })
      continue
    }

    for (const item of raw as InstantlyDailyAccountRow[]) {
      const mailbox = typeof item.email_account === 'string' ? item.email_account.trim().toLowerCase() : null
      const statDate = typeof item.date === 'string' ? item.date.slice(0, 10) : null

      if (!mailbox || !statDate) {
        dropped.push(`row missing ${!mailbox ? 'email_account' : 'date'}`)
        continue
      }

      const domain = deriveSendingDomain(mailbox)
      if (!domain) {
        // Redacted: the local-part never reaches a log line. The repo is public and logs
        // are not, but a mailbox address in a log is one copy-paste from being either.
        dropped.push(`unparseable mailbox on ${statDate}`)
        continue
      }

      rows.push({
        mailbox,
        statDate,
        domain,
        sends:   Number.isFinite(item.sent)    ? Number(item.sent)    : 0,
        bounces: Number.isFinite(item.bounced) ? Number(item.bounced) : 0,
      })
    }
  }

  if (dropped.length > 0) {
    logger.error('Sending health: dropped provider rows', { count: dropped.length, reasons: dropped.slice(0, 5) })
  }

  return { rows, mailboxCount: mailboxes.length, dropped }
}
