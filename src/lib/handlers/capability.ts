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

export type Capability =
  | 'can_send_email'
  | 'can_schedule_linkedin_post'
  | 'can_send_linkedin_dm'
  | 'can_enrich_contact'
  | 'can_book_meeting'
  | 'can_validate_email'

export type CapabilityPayload = Record<string, unknown>
export type CapabilityResult = Record<string, unknown>

// TODO: Implement after integrations_registry table is created in Supabase.
// Each handler will be imported here and mapped to its capability.
// Only this file may contain tool-specific import references.

export async function executeCapability(
  capability: Capability,
  payload: CapabilityPayload
): Promise<CapabilityResult> {
  throw new Error(
    `executeCapability('${capability}') is not yet implemented. ` +
    `Build the integrations_registry table and register a handler first.`
  )
}
