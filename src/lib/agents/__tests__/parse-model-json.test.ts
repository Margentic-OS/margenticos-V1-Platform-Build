// The parse failure must say enough to diagnose itself.
//
// On 2026-09-05 a tov regeneration failed on this exact code path and left nothing behind.
// The catch bound no error, the raw response was never logged, stop_reason and usage were
// discarded at the API boundary, and the thrown message claimed "Raw response has been
// logged" when no code anywhere wrote one. The complete production log for a 100-second
// run was four lines, and what the model returned is gone for good.
//
// These tests are what stops that being true again. Each one names the question that could
// not be answered that day.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { parseModelJsonOrThrow, type ModelResponse } from '../parse-model-json'
import { logger } from '@/lib/logger'

const MAX_TOKENS = 8192

function response(over: Partial<ModelResponse> = {}): ModelResponse {
  return { raw: '{"a":1}', stopReason: 'end_turn', outputTokens: 120, ...over }
}

/** The last error the logger was given, as the structured object. */
function loggedContext(): Record<string, unknown> {
  const calls = vi.mocked(logger.error).mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][1] as Record<string, unknown>
}

beforeEach(() => vi.clearAllMocks())

describe('the happy path is untouched', () => {
  it('returns the parsed document and logs nothing', () => {
    const out = parseModelJsonOrThrow('TOV agent', 'org-1', response({ raw: '{"voice":"direct"}' }), MAX_TOKENS)
    expect(out).toEqual({ voice: 'direct' })
    expect(logger.error).not.toHaveBeenCalled()
  })
})

describe('what the 2026-09-05 failure could not tell anyone', () => {
  // "Was it truncated?" The single fastest discriminator, and it was thrown away.
  it('logs the stop reason, and says outright whether the ceiling was hit', () => {
    expect(() =>
      parseModelJsonOrThrow('TOV agent', 'org-1', response({
        raw: '{"voice":"direct","incomplete":',
        stopReason: 'max_tokens',
        outputTokens: 8192,
      }), MAX_TOKENS),
    ).toThrow()

    const ctx = loggedContext()
    expect(ctx.stop_reason).toBe('max_tokens')
    expect(ctx.hit_output_ceiling).toBe(true)
    expect(ctx.output_tokens).toBe(8192)
    expect(ctx.max_tokens).toBe(MAX_TOKENS)
  })

  it('does not claim the ceiling was hit when the model simply finished', () => {
    // This is the 2026-09-05 shape as best it can be reconstructed: a normal-length
    // response that stopped on its own and still would not parse. Reporting it as a
    // truncation would send the next reader after the wrong fix.
    expect(() =>
      parseModelJsonOrThrow('TOV agent', 'org-1', response({
        raw: 'Here is the tone of voice guide:\n\n{"voice":"direct"}',
        stopReason: 'end_turn',
        outputTokens: 4300,
      }), MAX_TOKENS),
    ).toThrow()

    const ctx = loggedContext()
    expect(ctx.hit_output_ceiling).toBe(false)
    expect(ctx.stop_reason).toBe('end_turn')
  })

  // "What did it actually return?" Head AND tail, because they fail differently.
  it('logs the head, which is where a preamble shows', () => {
    expect(() =>
      parseModelJsonOrThrow('TOV agent', 'org-1', response({
        raw: 'Here is the tone of voice guide you asked for:\n\n{"voice":"direct"}',
      }), MAX_TOKENS),
    ).toThrow()

    expect(String(loggedContext().raw_head)).toContain('Here is the tone of voice guide')
  })

  it('logs the tail, which is where a truncation shows', () => {
    // A head-only excerpt of a truncated document is indistinguishable from a healthy one:
    // the first 600 characters of a cut-off JSON document look perfectly well formed.
    const truncated = '{"voice_characteristics":[' + '{"name":"direct","evidence":"x"},'.repeat(80)
    expect(() =>
      parseModelJsonOrThrow('TOV agent', 'org-1', response({ raw: truncated, stopReason: 'max_tokens' }), MAX_TOKENS),
    ).toThrow()

    const ctx = loggedContext()
    expect(String(ctx.raw_tail)).toContain('evidence')
    expect(String(ctx.raw_tail).endsWith('}')).toBe(false)
    expect(ctx.raw_length).toBe(truncated.length)
  })

  it('logs the parse error itself, which the bare catch discarded', () => {
    expect(() =>
      parseModelJsonOrThrow('TOV agent', 'org-1', response({ raw: 'not json at all' }), MAX_TOKENS),
    ).toThrow()

    expect(String(loggedContext().parse_error).length).toBeGreaterThan(0)
  })

  it('reports the full length separately from the excerpts', () => {
    // Distinguishes a short malformed response from a long truncated one without putting a
    // whole strategy document into the log line.
    const long = '{"x":"' + 'y'.repeat(50_000)
    expect(() => parseModelJsonOrThrow('TOV agent', 'org-1', response({ raw: long }), MAX_TOKENS)).toThrow()

    const ctx = loggedContext()
    expect(ctx.raw_length).toBe(long.length)
    expect(String(ctx.raw_head).length).toBeLessThan(1000)
    expect(String(ctx.raw_tail).length).toBeLessThan(1000)
  })
})

describe('the thrown message no longer lies', () => {
  it('does not promise a log that was never written', () => {
    // The old message said "Raw response has been logged" and nothing logged it. That
    // sentence cost two days: it sent the reader hunting for something that did not exist.
    let message = ''
    try {
      parseModelJsonOrThrow('TOV agent', 'org-1', response({ raw: 'nope' }), MAX_TOKENS)
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }

    expect(message).not.toContain('Raw response has been logged')
    // It points at a log line that this function demonstrably writes.
    expect(message).toContain('model response is not valid JSON')
    expect(logger.error).toHaveBeenCalledWith(
      'TOV agent: model response is not valid JSON',
      expect.any(Object),
    )
  })

  it('carries the discriminating numbers in the message itself', () => {
    // agent_runs.error_message and the operator alert both get this string and neither
    // gets the log line, so the numbers have to travel in the message too.
    let message = ''
    try {
      parseModelJsonOrThrow('TOV agent', 'org-1', response({
        raw: 'nope', stopReason: 'max_tokens', outputTokens: 8192,
      }), MAX_TOKENS)
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }

    expect(message).toContain('stop_reason=max_tokens')
    expect(message).toContain('output_tokens=8192/8192')
    expect(message).toContain('raw_length=4')
    expect(message).toContain('Nothing was written to the database.')
  })

  it('names the agent it came from, so three agents stay distinguishable', () => {
    for (const label of ['TOV agent', 'ICP agent', 'Positioning agent']) {
      expect(() => parseModelJsonOrThrow(label, 'org-1', response({ raw: 'nope' }), MAX_TOKENS))
        .toThrow(new RegExp(`^${label}: Claude returned content that is not valid JSON`))
    }
  })
})
