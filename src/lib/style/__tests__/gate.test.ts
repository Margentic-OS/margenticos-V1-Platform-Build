// Unit tests for scrubAITellsDeep and assertNoDashes in customer-facing-style-rules.ts
//
// Verifies the deterministic gate that ICP, Positioning, and TOV agents run before
// writing output to document_suggestions. The gate scrubs em-dashes and AI tells
// from all string values in the JSON document without touching field names or structure.

import { describe, it, expect, vi } from 'vitest'

// Mock the logger to avoid real log output in tests.
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import {
  scrubAITellsDeep,
  assertNoDashes,
  scrubAITellsDeepExcluding,
  assertNoDashesExcluding,
  scrubAITells,
} from '../customer-facing-style-rules'

// ─── scrubAITellsDeep ─────────────────────────────────────────────────────────

describe('scrubAITellsDeep', () => {
  it('replaces an em-dash in a flat string', () => {
    const result = scrubAITellsDeep('founders — who thrive', 'test')
    // Em-dash before lowercase word → comma replacement
    expect(result).not.toContain('—')
  })

  it('replaces an em-dash before an uppercase word with a period', () => {
    // Em-dash before uppercase char → period replacement
    const result = scrubAITellsDeep('the engine — Revenue follows', 'test')
    expect(result).not.toContain('—')
    expect(result).toContain('.')
  })

  it('recurses into nested objects and replaces em-dashes in string values', () => {
    const input = {
      outer: 'clean text',
      inner: {
        field: 'the pipeline — predictable now',
      },
    }
    const result = scrubAITellsDeep(input, 'test')
    expect((result.inner as { field: string }).field).not.toContain('—')
    expect(result.outer).toBe('clean text')
  })

  it('recurses into arrays and replaces em-dashes in string items', () => {
    const input = ['first — item', 'second item', 'third — item']
    const result = scrubAITellsDeep(input, 'test')
    expect(result[0]).not.toContain('—')
    expect(result[2]).not.toContain('—')
    expect(result[1]).toBe('second item')
  })

  it('does not change non-string values (numbers, booleans, null)', () => {
    const input = {
      count: 42,
      active: true,
      nothing: null,
      label: 'clean',
    }
    const result = scrubAITellsDeep(input, 'test')
    expect(result.count).toBe(42)
    expect(result.active).toBe(true)
    expect(result.nothing).toBeNull()
    expect(result.label).toBe('clean')
  })

  it('does not mutate the original input', () => {
    const input = { text: 'the gap — real problem' }
    const original = JSON.stringify(input)
    scrubAITellsDeep(input, 'test')
    expect(JSON.stringify(input)).toBe(original)
  })
})

// ─── assertNoDashes ───────────────────────────────────────────────────────────

describe('assertNoDashes', () => {
  it('passes on a clean string with no dashes', () => {
    expect(() => assertNoDashes('no dashes here', 'test')).not.toThrow()
  })

  it('throws on a string containing an em-dash', () => {
    expect(() => assertNoDashes('pipeline — broken', 'test')).toThrow(
      /em-dash or en-dash found/
    )
  })

  it('throws on a string containing an en-dash', () => {
    expect(() => assertNoDashes('pages 1–2', 'test')).toThrow(
      /em-dash or en-dash found/
    )
  })

  it('includes the context in the error message', () => {
    expect(() => assertNoDashes('pipeline — broken', 'icp-agent.summary')).toThrow(
      /icp-agent\.summary/
    )
  })

  it('throws when an em-dash is nested in an object', () => {
    const nested = {
      level1: {
        level2: 'clean — broken',
      },
    }
    expect(() => assertNoDashes(nested, 'test')).toThrow(/em-dash or en-dash found/)
  })

  it('throws when an em-dash is nested in an array', () => {
    const arr = ['clean', 'broken — value']
    expect(() => assertNoDashes(arr, 'test')).toThrow(/em-dash or en-dash found/)
  })

  it('passes on a deeply nested object with no dashes', () => {
    const clean = {
      a: { b: { c: ['no', 'dashes', 'anywhere'] } },
      d: 42,
      e: null,
    }
    expect(() => assertNoDashes(clean, 'test')).not.toThrow()
  })
})

// ─── scrubAITells — numeric range en-dash (C1) ────────────────────────────────

describe('scrubAITells numeric range handling', () => {
  it('converts a currency range en-dash to a plain hyphen, not a period', () => {
    const result = scrubAITells('prices range from €1K–€3K per month', 'test')
    expect(result).toBe('prices range from €1K-€3K per month')
    expect(result).not.toContain('–')
    expect(result).not.toContain('. €')
  })

  it('converts a plain number range en-dash to a plain hyphen', () => {
    const result = scrubAITells('billing 3K–15K per month', 'test')
    expect(result).toBe('billing 3K-15K per month')
    expect(result).not.toContain('–')
  })

  it('still converts a prose en-dash (with surrounding spaces) to comma or period', () => {
    const result = scrubAITells('the system – reliable', 'test')
    expect(result).not.toContain('–')
    expect(result).toContain(', ')
  })

  it('assertNoDashes passes after scrubAITells converts a numeric range', () => {
    const scrubbed = scrubAITells('retainer of €1K–€3K monthly', 'test')
    expect(() => assertNoDashes(scrubbed, 'test')).not.toThrow()
  })
})

// ─── scrubAITellsDeepExcluding + assertNoDashesExcluding (R1) ─────────────────

describe('scrubAITellsDeepExcluding', () => {
  const VERBATIM = new Set(['evidence', 'words_they_use'])

  it('passes verbatim fields through untouched even when they contain an em-dash', () => {
    const input = {
      summary: 'the pipeline — broken',
      evidence: 'the founder wrote: get in — get out',
    }
    const result = scrubAITellsDeepExcluding(input, 'test', VERBATIM)
    expect((result as typeof input).summary).not.toContain('—')
    expect((result as typeof input).evidence).toBe('the founder wrote: get in — get out')
  })

  it('scrubs generated fields that are NOT in the exclusion list', () => {
    const input = {
      before: 'the gap — real',
      evidence: 'raw sample — untouched',
    }
    const result = scrubAITellsDeepExcluding(input, 'test', VERBATIM)
    expect((result as typeof input).before).not.toContain('—')
    expect((result as typeof input).evidence).toContain('—')
  })
})

describe('assertNoDashesExcluding', () => {
  const VERBATIM = new Set(['evidence', 'words_they_use'])

  it('throws on a dash in a non-excluded generated field', () => {
    const doc = {
      before: 'the gap — real problem',
      evidence: 'raw — untouched',
    }
    expect(() => assertNoDashesExcluding(doc, 'test', VERBATIM)).toThrow(/em-dash or en-dash found/)
  })

  it('does not throw when the only dash is in an excluded verbatim field', () => {
    const doc = {
      summary: 'clean text, no dashes',
      evidence: 'founder sample — verbatim',
    }
    expect(() => assertNoDashesExcluding(doc, 'test', VERBATIM)).not.toThrow()
  })
})
