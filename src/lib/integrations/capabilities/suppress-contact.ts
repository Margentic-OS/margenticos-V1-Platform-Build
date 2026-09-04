// src/lib/integrations/capabilities/suppress-contact.ts
//
// The can_suppress_contact capability: "stop the sending tool contacting this person".
//
// ADR-001. Callers ask for the capability. This module reads integrations_registry to find
// which tool currently provides it and returns that tool's handler. No suppression path
// anywhere in the build names a tool, and swapping the sending provider is a registry
// UPDATE plus one entry in HANDLERS below.
//
// This module exists because the opt-out reply path calls the provider handler directly,
// which its own comment at process-reply.ts flags as a deferred ADR-001 violation. This
// build adds two more suppression callers. Wiring them the same way would have tripled a
// recorded violation instead of repaying it, so the capability came first and all three go
// through it.

import { logger } from '@/lib/logger'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import {
  stopLead as instantlyStopLead,
  findLeadIds as instantlyFindLeadIds,
  readLead as instantlyReadLead,
  PROVIDER_STATUS_ACTIVE,
  PROVIDER_STATUS_PAUSED,
  type StopLeadOutcome,
  type FindLeadsOutcome,
  type ReadLeadOutcome,
  type ProviderLeadState,
} from '@/lib/integrations/handlers/instantly/suppress-contact'

export type { StopLeadOutcome, FindLeadsOutcome, ReadLeadOutcome, ProviderLeadState }

export const SUPPRESS_CONTACT_CAPABILITY = 'can_suppress_contact'

/**
 * What a sending tool must be able to do to provide this capability.
 *
 * Three operations, because suppression has two entry points and one instrument:
 *   stopLead     the per-prospect path, which already holds a provider lead id
 *   findLeadIds  the address path, for the global list, which holds no id at all
 *   readLead     the reconciliation sweep, which must read the provider's own answer and
 *                must never reach for the write path to get it
 */
export interface SuppressContactHandler {
  toolName: string
  stopLead(leadId: string, organisationId: string): Promise<StopLeadOutcome>
  findLeadIds(email: string, organisationId: string): Promise<FindLeadsOutcome>
  readLead(leadId: string, organisationId: string): Promise<ReadLeadOutcome>
}

/**
 * Registered handlers, keyed by the tool_name in integrations_registry.
 *
 * The ONLY place a tool name appears on this side of the capability boundary. Adding a
 * second sending tool is a new entry here and a registry row; nothing upstream changes.
 */
const HANDLERS: Record<string, SuppressContactHandler> = {
  instantly: {
    toolName: 'instantly',
    stopLead: instantlyStopLead,
    findLeadIds: instantlyFindLeadIds,
    readLead: instantlyReadLead,
  },
}

export type ResolveHandlerResult =
  | { ok: true; handler: SuppressContactHandler }
  | { ok: false; error: string }

/**
 * Which tool currently provides this capability.
 *
 * FAILS CLOSED, and the direction matters. If the registry cannot be read, or names a tool
 * with no handler, this returns an error and every caller records the suppression as one
 * that did not reach the provider. It never falls back to a default tool: a fallback here
 * would send a real suppression to whichever provider happened to be first in the map.
 */
export async function resolveSuppressContactHandler(
  supabase: ServiceRoleClient,
): Promise<ResolveHandlerResult> {
  const { data, error } = await supabase
    .from('integrations_registry')
    .select('tool_name, is_active')
    .eq('capability', SUPPRESS_CONTACT_CAPABILITY)
    .eq('is_active', true)
    .limit(2)

  if (error) {
    logger.error('suppress-contact capability: registry read failed', { error: error.message })
    return { ok: false, error: `capability registry read failed: ${error.message}` }
  }

  const rows = data ?? []

  if (rows.length === 0) {
    return {
      ok: false,
      error: `no active tool provides ${SUPPRESS_CONTACT_CAPABILITY}`,
    }
  }

  if (rows.length > 1) {
    // Two active providers for one capability is ambiguous, and guessing would send a real
    // person's suppression to whichever row sorted first. The registry has a UNIQUE on
    // (capability, tool_name) but nothing stops two DIFFERENT tools both being active.
    const names = rows.map(r => r.tool_name).sort().join(', ')
    logger.error('suppress-contact capability: more than one active provider', { tools: names })
    return {
      ok: false,
      error: `${SUPPRESS_CONTACT_CAPABILITY} has more than one active tool (${names})`,
    }
  }

  const toolName = rows[0].tool_name
  const handler = HANDLERS[toolName]

  if (!handler) {
    logger.error('suppress-contact capability: registered tool has no handler', { tool: toolName })
    return {
      ok: false,
      error: `${SUPPRESS_CONTACT_CAPABILITY} is registered to "${toolName}", which has no handler`,
    }
  }

  return { ok: true, handler }
}

/**
 * Is this provider lead still in a state where the sequence can send to it?
 *
 * Active and Paused both count as still sending: paused is not sending right now but can
 * resume, and a suppression that survives only until somebody unpauses a campaign is not a
 * suppression. Everything else (completed, bounced, unsubscribed, skipped) has stopped.
 *
 * A null status is NOT treated as stopped. It means the provider returned a lead whose
 * state this code could not read, and reporting "cannot tell" as "fine" is the failure
 * class this build exists to remove.
 */
export function isStillSending(state: ProviderLeadState): boolean {
  if (state.status === null) return true
  return state.status === PROVIDER_STATUS_ACTIVE || state.status === PROVIDER_STATUS_PAUSED
}
