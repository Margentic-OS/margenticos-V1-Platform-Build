// Single source of truth for intent → human-readable label mapping.
// Used by the triage UI and any future operator-facing views.
//
// Rules:
//   - Tool-agnostic: no "Calendly", no "Instantly", no tool names.
//   - Niche-agnostic: no "consulting", no "coaching", no buyer archetypes.
//   - Unknown intents (classifier adds a new value before this mapping is updated)
//     render as the raw string in monospace — never crash.

export type ReplyIntent =
  | 'opt_out'
  | 'out_of_office'
  | 'positive_direct_booking'
  | 'positive_passive'
  | 'information_request_generic'
  | 'information_request_commercial'
  | 'objection_mild'
  | 'unclear'

const INTENT_LABELS: Record<ReplyIntent, string> = {
  positive_direct_booking:      'Interested — asked to book',
  positive_passive:             'Interested — hasn\'t booked yet',
  objection_mild:               'Soft pushback',
  information_request_generic:  'Asked a general question',
  information_request_commercial: 'Asked about terms or pricing',
  opt_out:                      'Opted out',
  out_of_office:                'Out of office',
  unclear:                      'Intent unclear',
}

/**
 * Returns a human-readable label for a classifier intent value.
 * Unknown intents return null so the caller can render the raw value in monospace.
 */
export function intentLabel(intent: string): string | null {
  return INTENT_LABELS[intent as ReplyIntent] ?? null
}
