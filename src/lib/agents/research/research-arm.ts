// THE RESEARCH ARMS, AS PURE FUNCTIONS. No database, no clock except the injected random source.
//
// ═══ WHAT AN ARM IS ══════════════════════════════════════════════════════════
//
// Two arms of production research, split 50/50 at random BEFORE a prospect is researched:
//
//   standard         the synthesis request exactly as it has always been built.
//   short_reasoning  the same request with ONE instruction appended to the user message, asking
//                    for a short reasoning block and a complete candidate list. Measured on
//                    2026-10-01 at 63% less synthesis output, with personalised emails inside the
//                    writer's noise. It moved fit grades on 5 of 20, so its output is HELD AT
//                    UPLOAD until the operator approves the arm for that batch (see
//                    src/lib/operator/research-arm.ts).
//
// The arm is a property of the synthesis, so it is decided once and stored on the prospect. It is
// never recomputed: a retry, a resubmitted batch or a re-read has to produce the same arm.
//
// This module only says what an arm is and how one is drawn. Where it is stored, how it is
// released and what is reported live in src/lib/operator/research-arm.ts.

export const RESEARCH_ARMS = ['standard', 'short_reasoning'] as const

export type ResearchArm = (typeof RESEARCH_ARMS)[number]

/**
 * One prospect's arm, as an independent fair coin. A fair coin, not a count, because the spec is
 * "at random, 50/50" per prospect. The random source is injected so a test can pin it.
 */
export function drawResearchArm(random: () => number = Math.random): ResearchArm {
  return random() < 0.5 ? 'short_reasoning' : 'standard'
}

/**
 * A balanced plan for a fixed set of prospects: a random shuffle, then the first half to
 * short_reasoning and the rest to standard. Used by the dry run, where a 3-and-3 split is the
 * point of the run and independent coins could give 5 and 1.
 *
 * Refuses an odd count rather than silently giving one arm an extra prospect. A plan that is not
 * exactly balanced is not the plan the operator asked for.
 */
export function balancedArmPlan(
  prospectIds: readonly string[],
  random: () => number = Math.random,
): Map<string, ResearchArm> {
  if (prospectIds.length % 2 !== 0) {
    throw new Error(`balancedArmPlan needs an even number of prospects, got ${prospectIds.length}.`)
  }
  const shuffled = [...prospectIds]
  // Fisher-Yates on the injected source.
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  const half = shuffled.length / 2
  const plan = new Map<string, ResearchArm>()
  shuffled.forEach((id, index) => plan.set(id, index < half ? 'short_reasoning' : 'standard'))
  return plan
}

/**
 * The arm a stored value means. NULL is 'standard': every research run before the split existed
 * was standard, so a prospect with no stored arm is a standard prospect. The stored value is never
 * rewritten to 'standard' here; a NULL column is reported as NULL where it matters.
 */
export function armOf(stored: string | null | undefined): ResearchArm {
  return stored === 'short_reasoning' ? 'short_reasoning' : 'standard'
}
