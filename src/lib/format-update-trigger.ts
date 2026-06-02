// Whitelist map: only explicitly known trigger values produce client-facing copy.
// Any unknown, null, or unmapped value returns null so it is suppressed at render.
const UPDATE_TRIGGER_LABELS: Record<string, string> = {
  signal_suggestion: 'Refined from campaign data',
  // manual → intentionally absent; no suffix shown for manual updates
}

export function formatUpdateTrigger(trigger: string | null | undefined): string | null {
  if (!trigger) return null
  return UPDATE_TRIGGER_LABELS[trigger] ?? null
}
