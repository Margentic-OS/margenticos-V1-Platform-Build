// Sequence coherence, tested BOTH WAYS: a follow-up that reuses Email 1's angle is
// replaced, and a sequence with no reuse is left exactly as it was.

import { describe, it, expect } from 'vitest'
import { coherentFollowups, type CoherenceVariant } from '../sequence-coherence'

// Bodies are sized so Email 3 is never longer than Email 2 unless a test wants it to be.
const body = (label: string, words: number) => `{{first_name}}\n\n${Array(words).fill(label).join(' ')}\n\nSam\nQuillmere`

function variants(): Record<string, CoherenceVariant> {
  return {
    A: { email1Angle: 'PA1', followupAngles: { 2: 'PA2', 3: 'PA3', 4: 'PA1' }, bodies: { 2: body('a2', 30), 3: body('a3', 25), 4: body('a4', 10) } },
    B: { email1Angle: 'PA2', followupAngles: { 2: 'PA4', 3: 'PA5', 4: 'PA2' }, bodies: { 2: body('b2', 30), 3: body('b3', 25), 4: body('b4', 10) } },
    C: { email1Angle: 'PA3', followupAngles: { 2: 'PA6', 3: 'PA1', 4: 'PA3' }, bodies: { 2: body('c2', 30), 3: body('c3', 25), 4: body('c4', 10) } },
    D: { email1Angle: 'PA1', followupAngles: { 2: 'PA3', 3: 'PA4', 4: 'PA1' }, bodies: { 2: body('d2', 30), 3: body('d3', 25), 4: body('d4', 10) } },
  }
}
const RANK = ['PA1', 'PA2', 'PA3', 'PA4', 'PA5', 'PA6']

describe('coherentFollowups', () => {
  it('leaves the sequence alone when no follow-up reuses Email 1 (the other way)', () => {
    // Assigned A, Email 1 used A's own angle: nothing overlaps.
    const r = coherentFollowups({ assignedVariant: 'A', email1Angle: 'PA1', variants: variants(), angleRank: RANK })
    expect(r.swaps).toEqual([])
    expect(r.bodies).toEqual(variants().A.bodies)
    expect(r.angles).toEqual({ 2: 'PA2', 3: 'PA3', 4: 'PA1' })
  })

  it('leaves the sequence alone when Email 1 used no angle (a neutral offer line)', () => {
    const r = coherentFollowups({ assignedVariant: 'A', email1Angle: null, variants: variants(), angleRank: RANK })
    expect(r.swaps).toEqual([])
    expect(r.bodies).toEqual(variants().A.bodies)
  })

  it('replaces Email 2 when it reuses the angle Email 1 used', () => {
    // Assigned A (E2 = PA2), but the selector gave Email 1 the PA2 offer line.
    const r = coherentFollowups({ assignedVariant: 'A', email1Angle: 'PA2', variants: variants(), angleRank: RANK })
    expect(r.angles[2]).not.toBe('PA2')
    expect(r.angles[2]).not.toBe(r.angles[3])
    expect(r.swaps.find(s => s.position === 2)).toMatchObject({ from_angle: 'PA2', to_variant: 'B', to_angle: 'PA4' })
    expect(r.bodies[2]).toBe(variants().B.bodies[2])
    expect(r.bodies[3]).toBe(variants().A.bodies[3])   // Email 3 untouched
  })

  it('replaces Email 3 when it reuses the angle Email 1 used, preferring the variant\'s own unused Email 1 angle', () => {
    // Assigned A (E3 = PA3), Email 1 used PA3. A's own Email 1 angle PA1 is unused, and
    // variant C has an Email 3 written for PA1.
    const r = coherentFollowups({ assignedVariant: 'A', email1Angle: 'PA3', variants: variants(), angleRank: RANK })
    expect(r.swaps.find(s => s.position === 3)).toMatchObject({ from_angle: 'PA3', to_variant: 'C', to_angle: 'PA1' })
    expect(r.bodies[3]).toBe(variants().C.bodies[3])
    expect(r.bodies[2]).toBe(variants().A.bodies[2])
  })

  it('makes the break-up name the angle Email 1 used', () => {
    const r = coherentFollowups({ assignedVariant: 'A', email1Angle: 'PA2', variants: variants(), angleRank: RANK })
    expect(r.angles[4]).toBe('PA2')
    expect(r.bodies[4]).toBe(variants().B.bodies[4])
  })

  it('never picks a replacement that would make Email 3 longer than Email 2', () => {
    const v = variants()
    v.C.bodies[3] = body('c3', 60)   // the preferred PA1 Email 3 is now too long
    const r = coherentFollowups({ assignedVariant: 'A', email1Angle: 'PA3', variants: v, angleRank: RANK })
    expect(r.swaps.find(s => s.position === 3)?.to_variant).not.toBe('C')
    expect(r.angles[3]).not.toBe('PA3')
  })

  it('keeps the template and says so when nothing else fits', () => {
    const v = { A: variants().A, B: { ...variants().B, followupAngles: { 2: 'PA2', 3: 'PA5', 4: 'PA2' } as const } }
    // A's Email 2 is PA2, and the only other Email 2 is also PA2.
    const r = coherentFollowups({ assignedVariant: 'A', email1Angle: 'PA2', variants: v, angleRank: RANK })
    expect(r.bodies[2]).toBe(variants().A.bodies[2])
    expect(r.unresolved).toEqual([{ position: 2, reason: 'no other approved follow-up for an unused angle fits' }])
  })

  it('after any swap, no shipped follow-up is about the angle Email 1 used', () => {
    for (const assigned of ['A', 'B', 'C', 'D']) {
      for (const used of RANK) {
        const r = coherentFollowups({ assignedVariant: assigned, email1Angle: used, variants: variants(), angleRank: RANK })
        if (r.unresolved.length === 0) {
          expect([r.angles[2], r.angles[3]]).not.toContain(used)
          expect(r.angles[2]).not.toBe(r.angles[3])
        }
      }
    }
  })
})
