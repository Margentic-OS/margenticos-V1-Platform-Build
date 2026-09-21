// The positive control for a single-variant repair: the variants it does not touch must
// come out byte-identical, and a write that touches one must be REFUSED rather than
// merely unlikely.
//
// Every fixture here is industry-neutral on purpose (Rule Zero). The guard is about JSON
// structure and has no opinion about who the copy is for.

import { describe, it, expect } from 'vitest'
import {
  assertOnlyVariantAdded,
  canonicalJson,
  parseVariantPayload,
  spliceVariant,
  variantFingerprints,
  VariantPayloadWriteError,
} from '../variant-payload'

const emailsFor = (opener: string) => ([
  {
    sequence_position: 1,
    subject_line: 'Route planning',
    subject_char_count: 14,
    body: `{{first_name}},\n\n${opener}\n\nWe take that work off the desk entirely.\n\nWorth a look?\n\nAlex\nNorthpoint`,
    word_count: 41,
  },
  { sequence_position: 2, subject_line: null, subject_char_count: 0, body: 'Second email body here.', word_count: 32 },
  { sequence_position: 3, subject_line: null, subject_char_count: 0, body: 'Third email body here.', word_count: 30 },
  { sequence_position: 4, subject_line: null, subject_char_count: 0, body: 'Fourth email body here.', word_count: 26 },
])

const payloadWith = (keys: string[]) => JSON.stringify({
  variants: Object.fromEntries(
    keys.map(k => [k, { emails: emailsFor(`Opening observation for ${k} goes here.`), angle: k }]),
  ),
})

describe('canonicalJson', () => {
  it('is insensitive to key order, so a reserialisation is not reported as a change', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }))
  })

  it('still distinguishes a changed value at any depth', () => {
    expect(canonicalJson({ a: { b: [1, 2] } })).not.toBe(canonicalJson({ a: { b: [1, 3] } }))
  })

  it('distinguishes a dropped field', () => {
    expect(canonicalJson({ a: 1, b: 2 })).not.toBe(canonicalJson({ a: 1 }))
  })
})

describe('parseVariantPayload', () => {
  it('refuses a payload that is not JSON', () => {
    expect(() => parseVariantPayload('not json')).toThrow(VariantPayloadWriteError)
  })

  it('refuses a payload with no variants object', () => {
    expect(() => parseVariantPayload(JSON.stringify({ emails: [] }))).toThrow(/no `variants` object/)
  })

  it('refuses an empty payload rather than treating it as zero variants', () => {
    expect(() => parseVariantPayload(null)).toThrow(VariantPayloadWriteError)
  })
})

describe('variantFingerprints', () => {
  it('fingerprints each variant separately', () => {
    const prints = variantFingerprints(payloadWith(['A', 'C', 'D']))
    expect([...prints.keys()].sort()).toEqual(['A', 'C', 'D'])
    expect(new Set(prints.values()).size).toBe(3)
  })

  it('gives the same fingerprint across a parse and reserialise round trip', () => {
    const before = payloadWith(['A', 'C', 'D'])
    const round = JSON.stringify(JSON.parse(before))
    expect([...variantFingerprints(round)]).toEqual([...variantFingerprints(before)])
  })
})

describe('assertOnlyVariantAdded', () => {
  const before = payloadWith(['A', 'C', 'D'])

  it('accepts a payload that only gained the target variant', () => {
    const after = spliceVariant(before, 'B', { emails: emailsFor('A new opening line entirely.'), angle: 'B' }, 'test')
    expect(() => assertOnlyVariantAdded(before, after, 'B', 'test')).not.toThrow()
    expect([...variantFingerprints(after).keys()].sort()).toEqual(['A', 'B', 'C', 'D'])
  })

  // THE MUTATION THIS EXISTS FOR. A write that also edits a surviving variant must be
  // refused. Without this the repair could rewrite copy an operator has already read.
  it('REFUSES a payload where an untouched variant changed', () => {
    const tampered = JSON.parse(before)
    tampered.variants.A.emails[0].body = tampered.variants.A.emails[0].body.replace('Worth a look?', 'Interested?')
    tampered.variants.B = { emails: emailsFor('A new opening line entirely.'), angle: 'B' }

    expect(() => assertOnlyVariantAdded(before, JSON.stringify(tampered), 'B', 'test'))
      .toThrow(/variant A changed during a repair/)
  })

  it('REFUSES a change buried deep in an untouched variant, not just in the body', () => {
    const tampered = JSON.parse(before)
    tampered.variants.D.emails[3].word_count = 27
    tampered.variants.B = { emails: emailsFor('A new opening line entirely.'), angle: 'B' }

    expect(() => assertOnlyVariantAdded(before, JSON.stringify(tampered), 'B', 'test'))
      .toThrow(/variant D changed/)
  })

  it('REFUSES a payload that dropped a surviving variant', () => {
    const tampered = JSON.parse(before)
    delete tampered.variants.C
    tampered.variants.B = { emails: emailsFor('A new opening line entirely.'), angle: 'B' }

    expect(() => assertOnlyVariantAdded(before, JSON.stringify(tampered), 'B', 'test'))
      .toThrow(/key set changed beyond the addition/)
  })

  it('REFUSES a payload that gained an extra variant as well as the target', () => {
    const tampered = JSON.parse(before)
    tampered.variants.B = { emails: emailsFor('A new opening line entirely.'), angle: 'B' }
    tampered.variants.E = { emails: emailsFor('An unexpected extra variant.'), angle: 'E' }

    expect(() => assertOnlyVariantAdded(before, JSON.stringify(tampered), 'B', 'test'))
      .toThrow(/key set changed beyond the addition/)
  })

  it('REFUSES when the target variant is absent afterwards', () => {
    expect(() => assertOnlyVariantAdded(before, before, 'B', 'test'))
      .toThrow(/absent after the write/)
  })

  it('REFUSES overwriting a variant that already existed', () => {
    const after = payloadWith(['A', 'C', 'D'])
    expect(() => assertOnlyVariantAdded(before, after, 'A', 'test'))
      .toThrow(/already existed before the write/)
  })
})

describe('spliceVariant', () => {
  it('leaves every surviving variant byte-identical under canonical comparison', () => {
    const before = payloadWith(['A', 'C', 'D'])
    const after = spliceVariant(before, 'B', { emails: emailsFor('Brand new opener.'), angle: 'B' }, 'test')

    const b = parseVariantPayload(before).variants
    const a = parseVariantPayload(after).variants
    for (const key of ['A', 'C', 'D']) {
      expect(canonicalJson(a[key])).toBe(canonicalJson(b[key]))
    }
  })

  it('does not mutate the caller\'s input payload', () => {
    const before = payloadWith(['A', 'C', 'D'])
    const snapshot = before
    spliceVariant(before, 'B', { emails: emailsFor('Brand new opener.'), angle: 'B' }, 'test')
    expect(before).toBe(snapshot)
  })

  it('guards its own output, so an unchecked payload cannot leave this function', () => {
    const before = payloadWith(['A', 'C', 'D'])
    expect(() => spliceVariant(before, 'A', { emails: emailsFor('x'), angle: 'A' }, 'test'))
      .toThrow(VariantPayloadWriteError)
  })
})
