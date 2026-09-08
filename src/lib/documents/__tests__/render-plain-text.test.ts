import { describe, it, expect } from 'vitest'
import {
  renderDocumentPlainText,
  collectStringLeaves,
  assertNoContentLost,
  humaniseKey,
} from '../render-plain-text'

// ─── The guarantee this module sells, and the proof it is not vacuous ────────
//
// The backfill's whole claim is "same words, different layout". `assertNoContentLost` is
// what turns that from an assertion into a check. A check that passes on every input it
// has ever seen is worth nothing until it has been shown to FAIL on an input that should
// fail it, which is what the negative-control block below does.
//
// The live census on 2026-09-08 found NINE distinct top-level key sets and two
// array-rooted documents, so the shapes exercised here are the real ones, not invented.

const ICP_LIKE = {
  jtbd_statement: 'When our pipeline goes quiet, help us start conversations.',
  summary: 'A short summary paragraph.',
  tier_1: {
    company_profile: { revenue_range: 'unresolved', headcount: 'unresolved', industries: ['Alpha', 'Beta'] },
    buyer_profile: { title: 'Owner', seniority: 'Senior' },
    disqualifiers: ['Too small', 'Wrong market'],
  },
  unresolved_fields: [
    { field_path: 'tier_1.company_profile.headcount', why_unresolved: 'Intake never asked.' },
  ],
}

describe('renderDocumentPlainText', () => {
  it('renders headings from keys and keeps every string verbatim', () => {
    const out = renderDocumentPlainText(ICP_LIKE)

    expect(out).toContain('# Jtbd Statement')
    expect(out).toContain('When our pipeline goes quiet, help us start conversations.')
    expect(out).toContain('## Company Profile')
    expect(out).toContain('- Alpha')
    expect(out).toContain('Intake never asked.')
  })

  it('loses nothing from a realistic ICP shape', () => {
    const out = renderDocumentPlainText(ICP_LIKE)
    for (const leaf of collectStringLeaves(ICP_LIKE)) {
      expect(out, `missing: ${leaf}`).toContain(leaf)
    }
  })

  it('handles an ARRAY root, which two live messaging documents have', () => {
    const arrayRoot = [
      { variant: 'A', emails: [{ body: 'First body text.' }] },
      { variant: 'B', emails: [{ body: 'Second body text.' }] },
    ]
    const out = renderDocumentPlainText(arrayRoot)
    expect(out).toContain('First body text.')
    expect(out).toContain('Second body text.')
    expect(() => assertNoContentLost(arrayRoot, out, 'array-root')).not.toThrow()
  })

  it('preserves key order rather than sorting, because the agent chose the order', () => {
    const out = renderDocumentPlainText({ zebra: 'first written', alpha: 'second written' })
    expect(out.indexOf('first written')).toBeLessThan(out.indexOf('second written'))
  })

  it('skips empty values instead of emitting a bare heading', () => {
    const out = renderDocumentPlainText({ kept: 'text', blank: '', none: null, empty_list: [] })
    expect(out).toContain('# Kept')
    expect(out).not.toContain('Blank')
    expect(out).not.toContain('None')
    expect(out).not.toContain('Empty List')
  })

  it('returns empty string for content that carries no words, and never throws', () => {
    expect(renderDocumentPlainText(null)).toBe('')
    expect(renderDocumentPlainText({})).toBe('')
    expect(renderDocumentPlainText([])).toBe('')
  })

  it('renders deeply nested prose in full rather than truncating at the heading cap', () => {
    // Heading markers stop deepening at 6. The TEXT must still appear: dropping a nested
    // paragraph to satisfy a formatting rule is the exact silent loss this module prevents.
    let deep: Record<string, unknown> = { leaf: 'the deepest sentence' }
    for (let i = 0; i < 10; i++) deep = { [`level_${i}`]: deep }
    const out = renderDocumentPlainText(deep)
    expect(out).toContain('the deepest sentence')
  })
})

describe('humaniseKey', () => {
  it('turns snake_case and camelCase into headings', () => {
    expect(humaniseKey('jtbd_statement')).toBe('Jtbd Statement')
    expect(humaniseKey('moore_positioning')).toBe('Moore Positioning')
    expect(humaniseKey('bestFitCharacteristics')).toBe('Best Fit Characteristics')
  })
})

// ─── NEGATIVE CONTROL ────────────────────────────────────────────────────────
//
// Without this block, every assertion above is consistent with `assertNoContentLost` being
// a function that never throws. These prove it detects a real loss, so the backfill's
// "0 rows failed verification over 69 rows" means the instrument answered rather than that
// the instrument is broken.

describe('assertNoContentLost actually fails when content IS lost', () => {
  it('throws when a string is missing from the rendered output', () => {
    expect(() =>
      assertNoContentLost({ a: 'kept sentence', b: 'dropped sentence' }, '# A\n\nkept sentence', 'mutant'),
    ).toThrow(/did not survive rendering/)
  })

  it('throws when the output is truncated mid-string, not just when a key vanishes', () => {
    const content = { a: 'a full sentence that was cut short' }
    expect(() => assertNoContentLost(content, '# A\n\na full sentence that was', 'mutant')).toThrow()
  })

  it('names how many strings were lost, so a partial loss is not reported as total', () => {
    expect(() =>
      assertNoContentLost({ a: 'one', b: 'two', c: 'three' }, 'one', 'mutant'),
    ).toThrow(/2 string\(s\)/)
  })

  it('does NOT throw merely because the output contains extra text', () => {
    // Headings, bullets and block numbers are additions by design. Containment, not equality.
    expect(() =>
      assertNoContentLost({ a: 'kept' }, '# A\n\n- kept\n\n#### 1.', 'additions'),
    ).not.toThrow()
  })
})

describe('collectStringLeaves', () => {
  it('finds strings at every depth and ignores blanks', () => {
    expect(collectStringLeaves({ a: 'x', b: ['y', { c: 'z' }], d: '   ', e: null })).toEqual(['x', 'y', 'z'])
  })

  it('excludes numbers and booleans, which would match by substring and weaken the check', () => {
    expect(collectStringLeaves({ n: 5, b: true, s: 'text' })).toEqual(['text'])
  })
})
