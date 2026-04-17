// Capability handler — the tool-agnostic execution layer.
// Agents call executeCapability(), never a tool directly.
// The registry maps capabilities to whichever tool is currently active.
// See CLAUDE.md — Tool agnosticism section and sections/02-stack.md.

// Supported capabilities (phase one):
//   can_send_email              → Instantly
//   can_schedule_linkedin_post  → Taplio (content delivery model — no API scheduling)
//   can_send_linkedin_dm        → Lemlist
//   can_enrich_contact          → Apollo
//   can_book_meeting            → Calendly (URL stored per client in registry)
//   can_validate_email          → Hunter.io (phase two — not yet active)

import { getCapabilityRow } from '@/lib/registry-cache'

export type Capability =
  | 'can_send_email'
  | 'can_schedule_linkedin_post'
  | 'can_send_linkedin_dm'
  | 'can_enrich_contact'
  | 'can_book_meeting'
  | 'can_validate_email'

export type CapabilityPayload = Record<string, unknown>
export type CapabilityResult = Record<string, unknown>

// Handler implementations are added here as each integration is built.
// Only this file may contain tool-specific import references.
// Adding a new tool: write a handler in src/lib/handlers/, import it here,
// and add it to the map below. Register the tool in integrations_registry.
const handlers: Partial<Record<Capability, (payload: CapabilityPayload) => Promise<CapabilityResult>>> = {
  // Handlers are registered here once each integration is built.
  // Example: can_send_email: instantlyHandler,
}

export async function executeCapability(
  capability: Capability,
  payload: CapabilityPayload
): Promise<CapabilityResult> {
  const registryRow = await getCapabilityRow(capability)

  if (!registryRow) {
    throw new Error(
      `executeCapability('${capability}'): no active registry entry found. ` +
      `Register the capability in integrations_registry and set is_active = true.`
    )
  }

  if (registryRow.connection_status !== 'connected') {
    throw new Error(
      `executeCapability('${capability}'): tool '${registryRow.tool_name}' ` +
      `has connection_status '${registryRow.connection_status}'. Check the integration.`
    )
  }

  const handler = handlers[capability]

  if (!handler) {
    throw new Error(
      `executeCapability('${capability}'): registry entry exists for '${registryRow.tool_name}' ` +
      `but no handler is implemented yet. Build the handler and register it in capability.ts.`
    )
  }

  return handler(payload)
}
