// src/lib/integrations/handlers/instantly/suppress-contact.ts
//
// The Instantly implementation of the can_suppress_contact capability.
//
// This file is the only place in the build that knows HOW this provider is told to stop
// sending to somebody. Everything upstream asks the capability, never this module.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY INTEREST STATUS, AND NOT DELETE OR THE BLOCKLIST
//
// The provider offers four ways to stop mail to one lead. Checked against
// developer.instantly.ai and help.instantly.ai on 2026-09-04:
//
//   interest status   PATCH /leads/{id} with lt_interest_status. Documented: "Any status
//                     other than the default 'Lead' status stops the campaign sequence."
//                     Keeps the lead, its replies and its analytics. Scope: one lead.
//   blocklist         POST /block-lists-entries. Documented to be "checked both during the
//                     uploading of lead data and throughout ongoing campaigns", so it does
//                     stop a lead mid-sequence. Scope: THE WHOLE WORKSPACE.
//   delete            DELETE /leads/{id}. The API description says plainly that it "cannot
//                     be undone". Nothing documents what survives it.
//   move              POST /leads/move, to a campaign that never sends.
//
// DELETE is refused because reply history is load-bearing here, not decoration: the reply
// processor threads replies off the stored email object, campaign analytics counts replies,
// and the reply audit trail is the record showing an opt-out was honoured. Irreversible
// plus undocumented is not a combination to choose when a reversible option exists.
//
// THE BLOCKLIST IS REFUSED FOR A SHARPER REASON, and it is worth stating because it looks
// like the obvious answer. getInstantlyApiKey() ignores its organisationId argument and
// returns one global key, so every client's campaigns live in ONE workspace and share ONE
// blocklist. One client rejecting a prospect would block that address out of every other
// client's campaigns, and blocklist entries accept whole domains. Today there is one
// campaign and the blast radius is zero. The moment there are two it is not, and nothing
// about the failure is visible.
//
// The cost of that refusal, stated rather than buried: the blocklist is the only mechanism
// that can stop an address with no lead row yet. Interest status needs a lead id, so it
// cannot pre-empt a future upload. That half is already covered by findBlockedProspects,
// which blocks a suppressed address before it is ever uploaded. The two mechanisms cover
// different halves and this one covers the half that was missing.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE READ-BACK IS NOT OPTIONAL
//
// stopLead PATCHes and then GETs the lead back. A 200 from a write endpoint is the same
// class of evidence as a notification logged as sent before it was sent, and this codebase
// has been burned by exactly that: a REVOKE whose effect was assumed rather than read back
// left eight functions callable by anon for four minutes, and a validated opt-out footer was
// discarded by a return-value bug and shipped on every stored document.
//
// So 'confirmed' means the lead was read back and carries the value we wrote. Nothing else
// earns it.
//
// WHAT THE READ-BACK DOES NOT PROVE, stated so it is not over-trusted: it proves OUR WRITE
// LANDED, not that the sequence stopped. Those are different claims and only the provider
// can settle the second one. That is what the reconciliation sweep is for, and it reads
// every suppressed lead's live sending state rather than trusting this function.

import { logger } from '@/lib/logger'
import { resolveInstantlyBaseUrl, shouldUseMockDispatch } from './constants'
import { mockLeadGet, mockLeadsList } from './mock-dispatch'
import { getInstantlyApiKey, getInstantlyApiActive } from './auth'
import { InstantlyFlagError } from './types'
import { suppressLead } from './reply-actions'

// The writable interest axis. -1 is "Not Interested".
//
// DO NOT confuse this with the readOnly `status` field, which shares these numbers with
// completely different meanings (-1 there is Bounced). The polling layer documents that
// collision at length and nothing here touches that field except to read it.
const NOT_INTERESTED = -1

// Rows per page on the address lookup. The provider caps this at 100.
const LEAD_LIST_PAGE_SIZE = 100

// A ceiling on paging, so a lookup can never loop for ever against a cursor that does not
// advance. 20 pages is 2,000 leads for one address, which is far beyond any real state; if
// it is ever hit, that is a finding and it is reported as a failure rather than a partial
// success.
const LEAD_LIST_MAX_PAGES = 20

/** Sending states, from the readOnly Lead.status field. See the polling layer's header. */
export const PROVIDER_STATUS_ACTIVE = 1
export const PROVIDER_STATUS_PAUSED = 2

export interface ProviderLeadState {
  leadId: string
  /** readOnly Lead.status. 1 Active, 2 Paused, 3 Completed, -1 Bounced, -2 Unsub, -3 Skipped. */
  status: number | null
  /** The writable interest axis. null means the default 'Lead' status. */
  interestStatus: number | null
}

export type StopLeadOutcome =
  | { ok: true; state: ProviderLeadState }
  | { ok: false; error: string; state: ProviderLeadState | null }

export type FindLeadsOutcome =
  | { ok: true; leadIds: string[] }
  | { ok: false; error: string }

export type ReadLeadOutcome =
  | { ok: true; state: ProviderLeadState }
  | { ok: false; error: string }

function parseLeadState(leadId: string, raw: unknown): ProviderLeadState {
  const row = (raw ?? {}) as Record<string, unknown>
  return {
    leadId,
    status: typeof row.status === 'number' ? row.status : null,
    interestStatus:
      typeof row.lt_interest_status === 'number' ? row.lt_interest_status : null,
  }
}

/**
 * Read one lead back from the provider.
 *
 * Exported because the reconciliation sweep needs exactly this and must not reach for the
 * write path to get it.
 */
export async function readLead(
  leadId: string,
  organisationId: string,
): Promise<ReadLeadOutcome> {
  const apiKey = await getInstantlyApiKey(organisationId)
  const isActive = await getInstantlyApiActive()
  const baseUrl = resolveInstantlyBaseUrl(isActive)

  // Same safety gate every handler carries: flag off while the URL points at production is
  // a misconfiguration, not a reason to proceed quietly.
  if (!isActive && !shouldUseMockDispatch(isActive) && baseUrl.includes('api.instantly.ai')) {
    throw new InstantlyFlagError('readLead: instantly_api_active is false — cannot read production leads')
  }

  let response: Response
  if (shouldUseMockDispatch(isActive)) {
    response = mockLeadGet(leadId)
  } else {
    try {
      response = await fetch(`${baseUrl}/leads/${leadId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      })
    } catch (err) {
      return { ok: false, error: `Network error reading lead back: ${String(err)}` }
    }
  }

  if (response.status === 404) {
    // The lead is not there. For suppression that is a stopped lead, but this function does
    // not get to decide that; it reports what it saw and the caller applies meaning.
    return { ok: false, error: 'Provider returned 404: no such lead' }
  }

  if (!response.ok) {
    return { ok: false, error: `Provider returned ${response.status} reading lead back` }
  }

  const raw = await response.json().catch(() => null)
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: 'Provider read-back was not a JSON object' }
  }

  return { ok: true, state: parseLeadState(leadId, raw) }
}

/**
 * Stop the provider sending to one lead, then read it back and confirm the write landed.
 *
 * ok:true means read back and confirmed. It does NOT mean the sequence has stopped; see
 * the header. ok:false always carries a reason, and never a silent success.
 */
export async function stopLead(
  leadId: string,
  organisationId: string,
): Promise<StopLeadOutcome> {
  const apiKey = await getInstantlyApiKey(organisationId)
  const isActive = await getInstantlyApiActive()
  const baseUrl = resolveInstantlyBaseUrl(isActive)

  // suppressLead already owns the PATCH, its flag gate and its error shape. Reusing it
  // rather than writing a second PATCH keeps one definition of what "stop" means on the
  // wire, which is what the opt-out path has been sending since it was built.
  const patch = await suppressLead(leadId, apiKey, baseUrl, isActive)

  if (!patch.ok) {
    return { ok: false, error: patch.error ?? 'provider rejected the suppression write', state: null }
  }

  const readBack = await readLead(leadId, organisationId)

  if (!readBack.ok) {
    // A 200 on the write with no confirming read is NOT a success. Reporting it as one is
    // the failure class this whole build exists to remove.
    return {
      ok: false,
      error: `provider accepted the write but it could not be confirmed: ${readBack.error}`,
      state: null,
    }
  }

  if (readBack.state.interestStatus !== NOT_INTERESTED) {
    return {
      ok: false,
      error:
        `provider accepted the write and the read-back disagrees: interest status is ` +
        `${readBack.state.interestStatus === null ? 'unset' : readBack.state.interestStatus}, ` +
        `expected ${NOT_INTERESTED}`,
      state: readBack.state,
    }
  }

  logger.info('instantly/suppress-contact: lead stopped and confirmed', {
    lead_id: leadId,
    organisation_id: organisationId,
    provider_status: readBack.state.status,
  })

  return { ok: true, state: readBack.state }
}

/**
 * Every lead the provider holds for this address.
 *
 * PAGES TO EXHAUSTION, and returns all of them.
 *
 * The lookup this replaces asked for limit 1 and took items[0]. If an address existed as
 * more than one lead it suppressed one and left the rest sending, silently, and the caller
 * could not tell the difference. Our own uploads cannot create a duplicate, because they
 * send skip_if_in_workspace, but a lead added through the provider's UI, a CSV import or
 * its own lead finder can. The provider's list endpoint carries a distinct_contacts flag
 * whose entire purpose is collapsing duplicates of one address, which is the provider
 * stating that duplicates are an expected state.
 *
 * distinct_contacts is deliberately NOT sent here. It would hand back one row per address,
 * which is the opposite of what suppression needs.
 */
export async function findLeadIds(
  email: string,
  organisationId: string,
): Promise<FindLeadsOutcome> {
  const apiKey = await getInstantlyApiKey(organisationId)
  const isActive = await getInstantlyApiActive()
  const baseUrl = resolveInstantlyBaseUrl(isActive)

  if (!isActive && !shouldUseMockDispatch(isActive) && baseUrl.includes('api.instantly.ai')) {
    throw new InstantlyFlagError('findLeadIds: instantly_api_active is false — cannot query production leads')
  }

  const leadIds: string[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  let pages = 0

  while (pages < LEAD_LIST_MAX_PAGES) {
    pages++

    let response: Response
    if (shouldUseMockDispatch(isActive)) {
      response = mockLeadsList()
    } else {
      try {
        response = await fetch(`${baseUrl}/leads/list`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contacts: [email],
            limit: LEAD_LIST_PAGE_SIZE,
            ...(cursor ? { starting_after: cursor } : {}),
          }),
        })
      } catch (err) {
        return { ok: false, error: `Network error listing leads: ${String(err)}` }
      }
    }

    if (!response.ok) {
      return { ok: false, error: `Provider returned ${response.status} listing leads` }
    }

    const json = await response.json().catch(() => null)
    const items = (Array.isArray(json) ? json : (json as { items?: unknown })?.items) as
      | Array<Record<string, unknown>>
      | undefined

    if (!Array.isArray(items)) {
      return { ok: false, error: 'Provider lead list was not an array' }
    }

    for (const item of items) {
      const id = typeof item.id === 'string' ? item.id : null
      // The endpoint takes `contacts` as a filter, but a filter honoured on the provider's
      // side is still a filter this code has not read back. Confirm the address before
      // acting on a lead: suppressing the wrong lead is worse than finding none.
      const itemEmail = typeof item.email === 'string' ? item.email.trim().toLowerCase() : null
      if (!id || itemEmail !== email) continue
      if (seen.has(id)) continue
      seen.add(id)
      leadIds.push(id)
    }

    const next = (json as { next_starting_after?: unknown } | null)?.next_starting_after
    if (typeof next !== 'string' || next.length === 0) break
    if (next === cursor) {
      // A cursor that does not advance would page for ever. The polling layer treats the
      // same shape as a poll failure rather than a completed scan.
      return { ok: false, error: 'Provider lead list cursor did not advance' }
    }
    cursor = next
  }

  if (pages >= LEAD_LIST_MAX_PAGES) {
    // Reported as a failure, not as the leads found so far. A partial answer here reads as
    // "these are all of them" to every caller.
    return {
      ok: false,
      error: `Provider lead list exceeded ${LEAD_LIST_MAX_PAGES} pages for one address`,
    }
  }

  return { ok: true, leadIds }
}
