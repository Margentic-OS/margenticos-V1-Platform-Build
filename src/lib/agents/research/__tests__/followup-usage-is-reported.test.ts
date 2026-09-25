// THE FACT-CHECK IS BILLED INSIDE THE FOLLOW-UP LINE, AND MUST STAY COUNTED THERE.
//
// write-followups.ts adds factCheck.usage into the same accumulator it returns, so one
// `followup_calls` covers a follow-up attempt and every check it triggered. Both production
// callers now persist that accumulator. If the fact-check usage ever leaves it, the persisted
// figure goes quietly low and nothing else in the system would say so: the check makes a full
// Sonnet request with a 2,000-token output ceiling, which is not a rounding error.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const sdk = {
  created: [] as Record<string, unknown>[],
  reply: {
    text: '[]',
    stop: 'end_turn' as string,
    usage: { input_tokens: 2100, output_tokens: 240, cache_creation_input_tokens: 0, cache_read_input_tokens: 1400 },
  },
}

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = {
      create: async (params: Record<string, unknown>) => {
        sdk.created.push(params)
        return {
          content: [{ type: 'text', text: sdk.reply.text }],
          stop_reason: sdk.reply.stop,
          usage: sdk.reply.usage,
        }
      },
    }
    constructor(_opts: Record<string, unknown>) {}
  }
  return { default: Anthropic }
})
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { factCheckFollowups } = await import('../fact-check-followups')

const params = {
  apiKey: 'test-key',
  prose2: 'The second email says one thing and asks one question.',
  prose3: 'The third email says a shorter thing and asks a shorter question.',
  findingsEvidence: '1. A dated event on file.',
  prospectId: 'p-fixture',
}

beforeEach(() => {
  sdk.created.length = 0
  sdk.reply = {
    text: '[]',
    stop: 'end_turn',
    usage: { input_tokens: 2100, output_tokens: 240, cache_creation_input_tokens: 0, cache_read_input_tokens: 1400 },
  }
})

describe('factCheckFollowups reports what it cost', () => {
  it('returns the tokens its own call billed', async () => {
    const result = await factCheckFollowups(params)
    expect(result.usage).toMatchObject({
      input_tokens: 2100,
      output_tokens: 240,
      cache_read_input_tokens: 1400,
      calls: 1,
    })
  })

  it('reports its cost even when it FAILS OPEN on a truncated reply', async () => {
    // The check is deliberately non-blocking when it cannot run, per ADR-059. That must not
    // also make it free: the call was billed whatever the verdict was worth.
    sdk.reply.stop = 'max_tokens'
    const result = await factCheckFollowups(params)
    expect(result.failures).toEqual([])         // failed open, as designed
    expect(result.usage.calls).toBe(1)          // and still counted
    expect(result.usage.input_tokens).toBe(2100)
  })

  it('reports zero, not undefined, when the call itself threw', async () => {
    // A zero here is a floor on an unknown rather than a claim that nothing was spent, and
    // the field must still be a TokenUsage so a caller can sum it without a guard.
    sdk.reply = { text: '', stop: 'end_turn', usage: undefined as never }
    const result = await factCheckFollowups(params)
    expect(result.usage.calls).toBe(1)
    expect(result.usage.input_tokens).toBe(0)
  })
})

// ─── THE FOLD ITSELF ─────────────────────────────────────────────────────────
//
// A SOURCE CHECK, AND ITS LIMIT IS STATED. Reaching this behaviourally means driving
// writeFollowups far enough that its deterministic gates ACCEPT a mocked model's copy, and
// the gate set is wide enough that such a fixture would be testing the fixture. So this reads
// the one line that does the folding.
//
// What it does catch: the line being deleted, renamed, or moved off the returned accumulator,
// which is the regression that would silently halve the recorded follow-up cost.
// What it cannot catch: the fold happening on a path that never returns. The three
// behavioural tests above cover the other end of the same chain.
describe('writeFollowups folds the fact-check usage into the usage it returns', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/agents/research/write-followups.ts'),
    'utf8',
  )

  it('can find a line it is certain about, so a zero below means the code and not the search', () => {
    // The positive control. Without it, a rename of the module would make every assertion
    // here pass vacuously on an empty read.
    expect(source).toContain('factCheckFollowups')
    expect(source.length).toBeGreaterThan(1000)
  })

  it('adds the fact-check usage into the accumulator', () => {
    expect(source).toMatch(/usage\s*=\s*addTokenUsage\(\s*usage\s*,\s*factCheck\.usage\s*\)/)
  })

  it('returns that same accumulator', () => {
    expect(source).toMatch(/return\s*\{\s*\.\.\.outcome,\s*usage,/)
  })
})
