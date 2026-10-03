// Sequence coherence: when Email 1 is personalised, the template follow-ups must not come
// back to the angle Email 1 already used.
//
// Operator decision, 2026-09-30.
//
// WHY THIS CAN HAPPEN AT ALL. Inside one variant the three angles are distinct by
// construction (the validator enforces it). But on the researched path the offer-line
// selector (offer-angle.ts) may give a prospect ANOTHER variant's offer line, the one whose
// declared angle answers what research found. Email 1 is then about that variant's angle,
// while Emails 2 to 4 still come from the prospect's assigned variant, and one of those may
// be written for the very same angle. The reader gets the same point twice in a sequence
// that was meant to bring three.
//
// WHAT IT DOES, deterministically and with no model:
//   Email 2 or 3 written for the angle Email 1 used is replaced by the same-position email
//   written for another angle, taken from another variant of the SAME approved document.
//   Preference: the assigned variant's own Email 1 angle first, because research replaced
//   that paragraph and so it is the variant's next unused angle; then brief rank order.
//   Email 4 names the sequence's main pain, so it is taken from the variant whose Email 1
//   angle IS the one Email 1 used, when the assigned variant's is not.
//   A replacement that would make Email 3 longer than Email 2 is skipped (the standing
//   rule). If nothing fits, the template follow-up stays and the reason is recorded.
//
// ONLY THE COPY ALREADY APPROVED. Every body comes verbatim from the client's messaging
// document. Nothing is written, reworded or generated here.
//
// Positions that ship a GENERATED follow-up are not this function's concern: the caller
// applies this to the template bodies first, and a generated follow-up then replaces the
// template in its position exactly as before.

import { countWords } from './personalization'

export interface CoherenceVariant {
  /** The variant's Email 1 angle id. */
  email1Angle: string
  /** Angle ids of Emails 2 and 3, and the angle Email 4 names. */
  followupAngles: { 2: string; 3: string; 4: string }
  /** The stored template bodies for positions 2, 3 and 4. */
  bodies: { 2: string; 3: string; 4: string }
}

export interface CoherenceSwap {
  position: 2 | 3 | 4
  from_variant: string
  from_angle: string
  to_variant: string
  to_angle: string
}

export interface CoherenceResult {
  bodies: { 2: string; 3: string; 4: string }
  /** The angle each shipped follow-up is about, after any swap. */
  angles: { 2: string; 3: string; 4: string }
  swaps: CoherenceSwap[]
  /** Positions that reused Email 1's angle and could not be replaced. */
  unresolved: Array<{ position: 2 | 3; reason: string }>
}

export function coherentFollowups(input: {
  assignedVariant: string
  /** The angle Email 1 actually used, or null when it used none (a neutral offer line). */
  email1Angle: string | null
  variants: Readonly<Record<string, CoherenceVariant>>
  /** Every pain angle id in brief rank order, strongest first. */
  angleRank: readonly string[]
}): CoherenceResult {
  const own = input.variants[input.assignedVariant]
  if (!own) throw new Error(`coherentFollowups: variant ${input.assignedVariant} is not in the document`)
  const bodies = { ...own.bodies }
  const angles = { ...own.followupAngles }
  const swaps: CoherenceSwap[] = []
  const unresolved: CoherenceResult['unresolved'] = []
  const used = input.email1Angle
  if (used === null) return { bodies, angles, swaps, unresolved }

  const rank = (angle: string) => {
    const i = input.angleRank.indexOf(angle)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  // Other variants' same-position emails, best first: the assigned variant's own Email 1
  // angle (its next unused one), then brief rank, then variant key for a stable order.
  const candidatesFor = (position: 2 | 3) =>
    Object.entries(input.variants)
      .filter(([key]) => key !== input.assignedVariant)
      .map(([key, v]) => ({ key, angle: v.followupAngles[position], body: v.bodies[position] }))
      .sort((a, b) =>
        (a.angle === own.email1Angle ? 0 : 1) - (b.angle === own.email1Angle ? 0 : 1) ||
        rank(a.angle) - rank(b.angle) ||
        a.key.localeCompare(b.key))

  for (const position of [2, 3] as const) {
    if (angles[position] !== used) continue
    const other = position === 2 ? 3 : 2
    const pick = candidatesFor(position).find(c => {
      if (c.angle === used || c.angle === angles[other]) return false
      const e2 = position === 2 ? c.body : bodies[2]
      const e3 = position === 3 ? c.body : bodies[3]
      return countWords(e3) <= countWords(e2)
    })
    if (!pick) {
      unresolved.push({ position, reason: 'no other approved follow-up for an unused angle fits' })
      continue
    }
    swaps.push({ position, from_variant: input.assignedVariant, from_angle: angles[position], to_variant: pick.key, to_angle: pick.angle })
    bodies[position] = pick.body
    angles[position] = pick.angle
  }

  // The break-up names the angle Email 1 was about.
  if (angles[4] !== used) {
    const match = Object.entries(input.variants)
      .filter(([key, v]) => key !== input.assignedVariant && v.followupAngles[4] === used)
      .sort(([a], [b]) => a.localeCompare(b))[0]
    if (match) {
      swaps.push({ position: 4, from_variant: input.assignedVariant, from_angle: angles[4], to_variant: match[0], to_angle: used })
      bodies[4] = match[1].bodies[4]
      angles[4] = used
    }
  }
  return { bodies, angles, swaps, unresolved }
}

// ─── From a messaging document ────────────────────────────────────────────────

interface DocVariant {
  emails?: Array<{ sequence_position: number; body: string }>
  lines?: {
    email1?: { angle?: string; offer_angle?: string | null }
    followups?: Array<{ position: number; angle: string }>
  }
}

/**
 * Apply sequence coherence to a document's template follow-ups for one variant.
 *
 * Returns null when the document cannot support it: any variant without `lines` (a
 * document written by the older messaging agent carries no angles), or no brief to rank
 * angles by. Null means "leave the follow-ups exactly as they are", which is what every
 * such document did before this existed.
 *
 * THE ANGLE EMAIL 1 USED is the angle its offer line answers: the assigned variant's own
 * Email 1 angle when that variant's offer is tagged, and none when it is the neutral line.
 * The offer-line selector assigns the WHOLE variant by its offer, so a personalised Email 1
 * always carries its own variant's offer.
 *
 * ON A DOCUMENT THE TEMPLATE VALIDATOR PASSED THIS NEVER SWAPS: a variant's three angles
 * are distinct there by rule (angle_distinct). It is a guard at the point of sending for
 * documents nothing validated, and the record of which angle each email carried.
 */
export function coherenceForDocument(content: unknown, assignedVariant: string): CoherenceResult & { email1_angle: string | null } | null {
  const doc = (content ?? {}) as { variants?: Record<string, DocVariant>; outbound_brief?: { pain_angles?: Array<{ id: string; rank: number }> } }
  const angles = doc.outbound_brief?.pain_angles
  if (!doc.variants || !Array.isArray(angles) || angles.length === 0) return null
  const variants: Record<string, CoherenceVariant> = {}
  for (const [key, v] of Object.entries(doc.variants)) {
    const angle = (position: number) => v.lines?.followups?.find(f => f.position === position)?.angle
    const body = (position: number) => v.emails?.find(e => e.sequence_position === position)?.body
    const e1 = v.lines?.email1?.angle
    const [a2, a3, a4, b2, b3, b4] = [angle(2), angle(3), angle(4), body(2), body(3), body(4)]
    if (!e1 || !a2 || !a3 || !a4 || !b2 || !b3 || !b4) return null
    variants[key] = { email1Angle: e1, followupAngles: { 2: a2, 3: a3, 4: a4 }, bodies: { 2: b2, 3: b3, 4: b4 } }
  }
  const own = doc.variants[assignedVariant]?.lines?.email1
  if (!own || !variants[assignedVariant]) return null
  const email1Angle = own.offer_angle === null || own.offer_angle === undefined ? null : (own.angle ?? null)
  const result = coherentFollowups({
    assignedVariant,
    email1Angle,
    variants,
    angleRank: [...angles].sort((a, b) => a.rank - b.rank).map(a => a.id),
  })
  return { ...result, email1_angle: email1Angle }
}
