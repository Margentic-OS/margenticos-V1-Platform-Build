// resolveVariantId and a stored variant the document no longer has.
//
// Brief-generated templates hold one variant per lead angle, so a client can go from four
// variants to three. A prospect stored on the dropped variant must be chosen for again,
// not written against whichever variant happens to be first.

import { describe, it, expect } from 'vitest'
import { resolveVariantId } from '../produce-opening'

const email1 = (offerAngle: string | null) => ({
  sequence_position: 1, subject_line: 's', subject_char_count: 1, word_count: 5,
  body: '{{first_name}}\n\nPain.\n\nOffer.\n\nQuestion?\n\nSam\nQuillmere', offer_angle: offerAngle,
})
const doc = (keys: string[]) => ({
  variants: Object.fromEntries(keys.map((k, i) => [k, { emails: [email1(i === keys.length - 1 ? null : `problem ${k}`)] }])),
}) as Parameters<typeof resolveVariantId>[2]

describe('resolveVariantId', () => {
  it('keeps an assigned variant the document still has (control)', () => {
    expect(resolveVariantId('prospect-1', 'B', doc(['A', 'B', 'C']), 'a hook')).toEqual({ variantId: 'B', basis: 'assigned' })
  })

  it('chooses again when the assigned variant is gone, and says so in the basis', () => {
    const choice = resolveVariantId('prospect-1', 'D', doc(['A', 'B', 'C']), 'a hook')
    expect(['A', 'B', 'C']).toContain(choice.variantId)
    // Not 'assigned': the caller writes back every basis except that one, so the new
    // variant is recorded on the prospect rather than silently used once.
    expect(choice.basis).not.toBe('assigned')
  })

  it('chooses again with no hook too, by the same hash composition uses', () => {
    const choice = resolveVariantId('prospect-1', 'D', doc(['A', 'B', 'C']))
    expect(['A', 'B', 'C']).toContain(choice.variantId)
    expect(choice.basis).not.toBe('assigned')
  })
})
