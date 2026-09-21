// Finding the outbound email a reply is answering, and reading its body as text.
//
// PROVIDER-SPECIFIC ON PURPOSE. Both the wire shapes below (the `body` object, `ue_type`,
// `thread_id`, `lead`) are Instantly's, and per ADR-001 that knowledge belongs inside this
// handler and nowhere above it. The poller calls these two pure functions; nothing upstream
// sees a provider field name.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY THE LOOKUP IS BY `lead`, AND WHY THE THREAD CHECK IS DONE HERE RATHER THAN ASKED FOR
//
// The version this replaces looked for the original email's uuid in three fields on the
// reply object: reply_to_uuid, in_reply_to_uuid, original_email_uuid. Measured against all
// nine replies in production on 2026-09-21: ZERO of them carry any of the three. The
// function returned null before making a single API call, every time, since it was written.
// `original_outbound_body` was NULL on every reply ever received, so the draft orchestrator's
// gate at draft-orchestrator.ts:240 always tripped and the reply-draft agent has never run
// in production.
//
// The obvious replacement is `GET /emails?thread_id=<the reply's thread>`. DO NOT DO THAT.
// **Instantly accepts `thread_id` as a query parameter and silently ignores it.** Measured
// 2026-09-21 against three different real thread ids: each returned the identical unfiltered
// first page of the mailbox, 50 rows spanning 49 different threads and 49 different leads.
// Taking the first row of that would have written ANOTHER PROSPECT'S outbound email into
// this prospect's `original_outbound_body`, and the drafter would then answer a stranger's
// email in this prospect's name. That is meaningfully worse than the null it replaced, and
// it would have looked like it was working.
//
// What Instantly does honour, measured in the same session, same endpoint:
//
//   lead=<address>                 honoured   2 rows, 1 thread, 1 lead
//   email_type=sent                honoured   50 rows, all ue_type 1
//   eaccount=<address>             honoured   8 rows
//   lead + email_type=sent         honoured   1 row, exactly the outbound email
//   thread_id=<id>                 IGNORED    identical to no filter at all
//
// So the request narrows by `lead`, which the provider does apply, and the thread is then
// matched IN THIS FILE against the rows that come back. The thread check is therefore not a
// belt-and-braces extra: it is the only thing standing between a multi-campaign prospect and
// the wrong email, because the server will not do it for us. A filter is a request, not a
// guarantee, and this endpoint is a measured instance of the difference.

import { parse } from 'node-html-parser'

/** The fields of an Instantly email object these functions read. */
export interface InstantlyEmailLike {
  id?: unknown
  thread_id?: unknown
  lead?: unknown
  timestamp_email?: unknown
  body?: unknown
}

// ── Half one: choosing the right email ────────────────────────────────────────

/**
 * Pick the outbound email a reply is answering, out of the sent emails returned for its lead.
 *
 * Returns null unless exactly one thread-matching candidate can be identified, because a
 * wrong outbound body is worse than an absent one: it reaches the drafter as fact.
 *
 * Selection, in order:
 *   1. Drop every candidate whose thread_id differs from the reply's. THE SERVER DOES NOT
 *      DO THIS (see the header) so dropping it here is the whole guard.
 *   2. Of what remains, take the LATEST email sent at or before the reply arrived. A thread
 *      with three follow-ups is answering the third, not the first.
 *   3. If no timestamp can be compared, fall back to the single remaining candidate, and
 *      only when there is exactly one.
 */
export function selectOutboundEmailForReply(
  reply: InstantlyEmailLike,
  sentEmails: readonly InstantlyEmailLike[],
): InstantlyEmailLike | null {
  const replyThreadId = typeof reply.thread_id === 'string' ? reply.thread_id.trim() : ''
  if (!replyThreadId) return null
  if (!Array.isArray(sentEmails) || sentEmails.length === 0) return null

  const sameThread = sentEmails.filter(
    (e) => typeof e.thread_id === 'string' && e.thread_id.trim() === replyThreadId,
  )
  if (sameThread.length === 0) return null
  if (sameThread.length === 1) return sameThread[0]

  const replyAt = toTime(reply.timestamp_email)

  const dated = sameThread
    .map((e) => ({ email: e, at: toTime(e.timestamp_email) }))
    .filter((c): c is { email: InstantlyEmailLike; at: number } => c.at !== null)

  if (dated.length === 0) return null

  const atOrBefore = replyAt === null ? dated : dated.filter((c) => c.at <= replyAt)
  const pool = atOrBefore.length > 0 ? atOrBefore : dated

  return pool.reduce((best, c) => (c.at > best.at ? c : best)).email
}

function toTime(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

// ── Half two: reading the body as text ────────────────────────────────────────

/**
 * Read an Instantly email's body as plain text.
 *
 * THE SHAPE THIS EXISTS FOR. `body` is an OBJECT, and on a sent email it carries `html` and
 * usually nothing else. There is no `body_text` field on this endpoint at all. The version
 * this replaces read `json.body_text` and then `json.body` and required each to be a STRING,
 * so both branches missed and it returned null even when handed the correct email. Confirmed
 * 2026-09-21 by calling GET /emails/{id} directly: keys were id, timestamp_created,
 * timestamp_email, message_id, subject, to_address_email_list, body:{html}, ...
 *
 * `body.text` is preferred where present (replies carry it, sent emails generally do not)
 * because it is the provider's own plain text and needs no conversion.
 */
export function extractOutboundBodyText(email: InstantlyEmailLike | null): string | null {
  if (!email) return null
  const body = email.body
  if (typeof body === 'string') return blankToNull(body)
  if (typeof body !== 'object' || body === null) return null

  const asRecord = body as Record<string, unknown>

  const text = asRecord.text
  if (typeof text === 'string' && text.trim() !== '') return text.trim()

  const html = asRecord.html
  if (typeof html === 'string' && html.trim() !== '') return htmlToPlainText(html)

  return null
}

/**
 * Convert email HTML to readable plain text.
 *
 * Block-level elements must become line breaks or every paragraph of the outbound email
 * collapses into one run-on line, which is exactly what the drafter would then quote back.
 * node-html-parser is already a dependency (src/lib/intake/fetch-website.ts) so this adds
 * none. Deliberately NOT the inverse of plainTextToHtml: that lives in the composition layer,
 * another session is editing outbound copy, and this must not couple to it.
 */
function htmlToPlainText(html: string): string | null {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)\s*>/gi, '\n')

  let text: string
  try {
    text = parse(withBreaks).textContent ?? ''
  } catch {
    // A parse failure must not lose the email. Strip tags and keep the words.
    text = withBreaks.replace(/<[^>]*>/g, ' ')
  }

  const cleaned = text
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return blankToNull(cleaned)
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
