// src/lib/reply-handling/route-intent.ts
//
// Pure function: maps a classified intent + confidence + FAQ top score to a
// routing decision. No I/O, no side effects (except logger.warn for unknown intents).
//
// Tier model (ADR-019):
//   tier_1_handled — already actioned upstream (opt-out, OOO, high-confidence booking)
//   tier_2         — AI-drafted reply; operator approves before sending
//   tier_3         — AI starting point; operator rewrites before sending
//   log_only       — no draft warranted; signal logged only

import { logger } from '@/lib/logger'

// Confidence threshold that lets positive_direct_booking act as Tier 1 (already handled).
// Must match the threshold in process-reply.ts — do not change independently.
const POSITIVE_BOOKING_TIER1_THRESHOLD = 0.9

// Confidence below this routes positive_direct_booking to Tier 3 (too uncertain to draft well).
const POSITIVE_BOOKING_TIER2_MIN = 0.7

// FAQ similarity score at or above this makes information_request_generic draftable as Tier 2.
// Must match FAQ_USE_THRESHOLD in reply-draft-agent.ts — do not change independently.
const FAQ_TIER2_THRESHOLD = 0.65

const KNOWN_INTENTS = new Set([
  'opt_out',
  'out_of_office',
  'positive_direct_booking',
  'positive_passive',
  'objection_mild',
  'information_request_generic',
  'information_request_commercial',
  'unclear',
])

export type RoutingDecision = 'tier_1_handled' | 'tier_2' | 'tier_3' | 'log_only'

export function routeIntent({
  intent,
  confidence,
  faqMatchTopScore,
}: {
  intent: string
  confidence: number
  faqMatchTopScore: number | null
}): RoutingDecision {
  if (!KNOWN_INTENTS.has(intent)) {
    logger.warn('routeIntent: unknown intent received — routing to log_only', { intent })
    return 'log_only'
  }

  switch (intent) {
    case 'opt_out':
    case 'out_of_office':
      return 'tier_1_handled'

    case 'positive_direct_booking':
      if (confidence >= POSITIVE_BOOKING_TIER1_THRESHOLD) return 'tier_1_handled'
      if (confidence >= POSITIVE_BOOKING_TIER2_MIN) return 'tier_2'
      return 'tier_3'

    case 'positive_passive':
    case 'objection_mild':
      return 'tier_2'

    case 'information_request_generic':
      return (faqMatchTopScore ?? 0) >= FAQ_TIER2_THRESHOLD ? 'tier_2' : 'tier_3'

    case 'information_request_commercial':
    case 'unclear':
      return 'tier_3'

    default:
      // Unreachable given the KNOWN_INTENTS guard above, but TypeScript requires exhaustion.
      logger.warn('routeIntent: unhandled intent — routing to log_only', { intent })
      return 'log_only'
  }
}
