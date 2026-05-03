// src/lib/integrations/handlers/instantly/reply-actions.ts
//
// Instantly V2 REST interface for reply-handling actions.
// This file is the API boundary only — it sends HTTP requests and returns results.
// It does NOT compose email bodies, insert Calendly links, or apply sign-offs.
// The processor (src/lib/reply-handling/process-reply.ts) owns all body templating:
//   calendar link insertion, slot-filling, persona sign-off, and any copy decisions.
// Do not add templating here. Callers must pass fully assembled bodyText.
//
// Phase 1 actions:
//   suppressLead    — PATCH /api/v2/leads/{uuid} with { lt_interest_status: -1 }
//                     Marks lead as not interested. No dedicated blocklist endpoint exists
//                     in Instantly V2 — this is the correct suppression mechanism.
//                     DB suppression (prospects.suppressed) is the caller's responsibility.
//   sendThreadReply — POST /api/v2/emails/reply
//                     Sends a reply in the existing email thread.

import { logger } from '@/lib/logger'
import { INSTANTLY_API_BASE } from './constants'

export interface ActionResult {
  ok: boolean
  error?: string
  raw?: unknown
  rateLimited?: boolean
  message_id?: string  // outbound Instantly message UUID, populated on sendThreadReply success
}

export async function suppressLead(
  leadInstantlyId: string,
  apiKey: string
): Promise<ActionResult> {
  let response: Response
  try {
    response = await fetch(`${INSTANTLY_API_BASE}/leads/${leadInstantlyId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ lt_interest_status: -1 }),
    })
  } catch (err) {
    const msg = `Network error: ${String(err)}`
    logger.error('Instantly reply-actions: suppressLead network error', { lead_id: leadInstantlyId, error: msg })
    return { ok: false, error: msg }
  }

  const raw = await response.json().catch(async () => {
    // Non-JSON body (HTML error page, plain text) — preserve as string for debugging.
    return { _raw_text: await response.text().catch(() => '(unreadable)') }
  })

  if (!response.ok) {
    const msg = `Instantly API ${response.status}: ${JSON.stringify(raw).slice(0, 200)}`
    logger.error('Instantly reply-actions: suppressLead API error', { lead_id: leadInstantlyId, status: response.status, error: msg })
    return { ok: false, error: msg, raw, rateLimited: response.status === 429 }
  }

  return { ok: true, raw }
}

// reply_to_uuid: the Instantly email UUID (signal's external_event_id / raw_data.id)
// eaccount: the sending email account — read from raw_data.eaccount (reliably present in V2 email objects)
// subject: pass the original thread subject from raw_data.subject
// bodyText: fully assembled plain-text body — caller (processor) is responsible for composing it
export async function sendThreadReply(
  params: {
    replyToUuid: string
    eaccount: string
    subject: string
    bodyText: string
  },
  apiKey: string
): Promise<ActionResult> {
  const { replyToUuid, eaccount, subject, bodyText } = params

  let response: Response
  try {
    response = await fetch(`${INSTANTLY_API_BASE}/emails/reply`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reply_to_uuid: replyToUuid,
        eaccount,
        subject,
        body: { text: bodyText },
      }),
    })
  } catch (err) {
    const msg = `Network error: ${String(err)}`
    logger.error('Instantly reply-actions: sendThreadReply network error', { reply_to_uuid: replyToUuid, error: msg })
    return { ok: false, error: msg }
  }

  const raw = await response.json().catch(async () => {
    // Non-JSON body (HTML error page, plain text) — preserve as string for debugging.
    return { _raw_text: await response.text().catch(() => '(unreadable)') }
  })

  if (!response.ok) {
    const msg = `Instantly API ${response.status}: ${JSON.stringify(raw).slice(0, 200)}`
    logger.error('Instantly reply-actions: sendThreadReply API error', { reply_to_uuid: replyToUuid, status: response.status, error: msg })
    return { ok: false, error: msg, raw, rateLimited: response.status === 429 }
  }

  let message_id: string | undefined
  if (typeof raw === 'object' && raw !== null && 'id' in raw && typeof (raw as Record<string, unknown>).id === 'string') {
    message_id = (raw as Record<string, unknown>).id as string
  } else {
    logger.warn('Instantly reply-actions: sendThreadReply success but no id in response', { reply_to_uuid: replyToUuid })
  }

  return { ok: true, raw, message_id }
}
