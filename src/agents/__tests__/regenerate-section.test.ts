// POSITIVE CONTROLS for hiding the section being rewritten.
//
// WRITTEN BECAUSE A MUTATION FOUND NOTHING. Deleting the line that removes the section from
// the content left every test green: the behaviour had been checked by hand and never
// written down, so the only thing standing between it and a silent regression was that
// somebody had run a script once.

import { describe, it, expect } from 'vitest'
import { omitSection, documentContextFor } from '../regenerate-section'

const CONTENT = {
  tier_1: {
    buyer_profile: { title: 'A buyer title' },
    triggers: [{ trigger: 'THE OLD TRIGGER', evidence_to_find: ['OLD EVIDENCE'] }],
    four_forces: { push: ['a push force'] },
  },
  tier_2: { label: 'second tier' },
  summary: 'a summary',
}

describe('omitSection', () => {
  it('removes the named path and nothing else', () => {
    const out = omitSection(CONTENT, 'tier_1.triggers') as typeof CONTENT
    expect('triggers' in out.tier_1).toBe(false)
    // Everything else survives, byte for byte.
    expect(out.tier_1.buyer_profile).toEqual(CONTENT.tier_1.buyer_profile)
    expect(out.tier_1.four_forces).toEqual(CONTENT.tier_1.four_forces)
    expect(out.tier_2).toEqual(CONTENT.tier_2)
    expect(out.summary).toEqual(CONTENT.summary)
  })

  it('does not mutate its input', () => {
    // The caller still needs the real document to splice into afterwards.
    omitSection(CONTENT, 'tier_1.triggers')
    expect(CONTENT.tier_1.triggers).toHaveLength(1)
  })

  it('a path that does not exist is a no-op, not a throw', () => {
    // A document written before the section existed has nothing to hide, and that is the
    // same answer as hiding it. Throwing would make an older client unregenerable.
    expect(omitSection(CONTENT, 'nope.not.here')).toEqual(CONTENT)
    expect(omitSection(CONTENT, '')).toEqual(CONTENT)
  })

  it('removes a top-level path too', () => {
    expect('summary' in (omitSection(CONTENT, 'summary') as typeof CONTENT)).toBe(false)
  })
})

describe('documentContextFor', () => {
  const doc = { plain_text: 'STORED PROSE, EXACTLY AS RENDERED', content: CONTENT }

  it('a normal run returns the stored prose unchanged', () => {
    // Byte-identical to what every run saw before this option existed.
    expect(documentContextFor(doc, null)).toBe('STORED PROSE, EXACTLY AS RENDERED')
  })

  it('THE SECTION IS ABSENT when one is being rewritten', () => {
    const hidden = documentContextFor(doc, 'tier_1.triggers')
    expect(hidden).not.toContain('THE OLD TRIGGER')
    expect(hidden).not.toContain('OLD EVIDENCE')
  })

  it('and everything else is still there', () => {
    // "Nothing else in that context changes" is the whole requirement. A version that
    // hid the section by handing over less of the document would pass the test above
    // and be wrong.
    const hidden = documentContextFor(doc, 'tier_1.triggers')
    expect(hidden).toContain('A buyer title')
    expect(hidden).toContain('a push force')
    expect(hidden).toContain('second tier')
    expect(hidden).toContain('a summary')
  })

  it('falls back to JSON when there is no stored prose, as it always did', () => {
    const out = documentContextFor({ plain_text: null, content: CONTENT }, null)
    expect(out).toContain('THE OLD TRIGGER')
  })
})
