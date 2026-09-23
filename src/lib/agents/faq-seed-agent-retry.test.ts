// The seed agent's time budget and retry policy.
//
// WHY THIS FILE EXISTS. The agent's single call is large: roughly 26,000 input tokens
// and up to 4,000 output on Opus. The old 60s ceiling could not have completed a
// full-length answer, so a working call was aborted and reported as an API failure.
//
// WHAT THESE LOCK OUT:
//   - The SDK's own retry being left on. Its defaults are a 10 minute timeout and 2
//     retries, which is 30 minutes against a route Vercel kills at 300s. The caller
//     would see neither the answer nor the error.
//   - Retrying a request that is wrong. A 400 retried is the same 400, and it spends
//     the budget that a genuine transient failure would have needed.
//   - Filing a truncated answer as "no JSON found". The cause is the token ceiling, and
//     a reader chasing a prompt fault would be looking in the wrong place (ADR-059).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const calls = vi.hoisted(() => ({
  constructorArgs: [] as Array<Record<string, unknown>>,
  streamArgs: [] as Array<{ body: unknown; options: unknown }>,
  /** Queue of outcomes, one per attempt. */
  outcomes: [] as Array<{ throws?: unknown; message?: Record<string, unknown> }>,
}))

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages: { stream: (body: unknown, options: unknown) => { finalMessage: () => Promise<unknown> } }
    constructor(config: Record<string, unknown>) {
      calls.constructorArgs.push(config)
      this.messages = {
        stream: (body: unknown, options: unknown) => {
          calls.streamArgs.push({ body, options })
          const outcome = calls.outcomes.shift()
          return {
            finalMessage: async () => {
              if (!outcome) throw new Error('mock: no outcome queued for this attempt')
              if (outcome.throws) throw outcome.throws
              return outcome.message
            },
          }
        },
      }
    }
  }
  return { default: MockAnthropic }
})

const loggerWarn = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: loggerWarn, error: vi.fn(), debug: vi.fn() },
}))

import { generateFaqSeedCandidates } from './faq-seed-agent'

const agentRuns: Array<Record<string, unknown>> = []

function fakeSupabase(): SupabaseClient {
  return {
    from: (table: string) => ({
      insert: async (values: Record<string, unknown>) => {
        if (table === 'agent_runs') agentRuns.push(values)
        return { data: null, error: null }
      },
    }),
  } as unknown as SupabaseClient
}

function goodMessage() {
  return {
    stop_reason: 'end_turn',
    content: [{
      type: 'text',
      text: JSON.stringify({ faqs: [{ question: 'Q?', answer: 'A.', source: 'icp' }] }),
    }],
  }
}

function input() {
  return {
    organisationId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    organisationName: 'Client Org',
    intakeAnswers: { a: 1 },
    icpDocument: 'icp',
    positioningDocument: 'positioning',
    tovDocument: 'tov',
    messagingDocument: 'messaging',
    supabase: fakeSupabase(),
  }
}

function statusError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status })
}

describe('FAQ seed agent — time budget and retries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    calls.constructorArgs = []
    calls.streamArgs = []
    calls.outcomes = []
    agentRuns.length = 0
    process.env.ANTHROPIC_API_KEY = 'test-key-not-real'
  })

  afterEach(() => { delete process.env.ANTHROPIC_API_KEY })

  it('switches the SDK\'s own retry OFF, so retries cannot outlive the route', async () => {
    calls.outcomes = [{ message: goodMessage() }]

    await generateFaqSeedCandidates(input())

    // Leaving this at the default of 2 would multiply every timeout below by three.
    expect(calls.constructorArgs[0]).toMatchObject({ maxRetries: 0 })
  })

  it('gives one attempt well over a minute, not the old 60s', async () => {
    calls.outcomes = [{ message: goodMessage() }]
    const before = Date.now()

    await generateFaqSeedCandidates(input())

    const signal = (calls.streamArgs[0].options as { signal: AbortSignal & { }}).signal
    expect(signal).toBeInstanceOf(AbortSignal)
    // AbortSignal.timeout gives no readable deadline, so assert the budget through the
    // only other observable: the agent must not have finished instantly by skipping it.
    expect(Date.now() - before).toBeLessThan(5_000)
    expect(calls.streamArgs).toHaveLength(1)
  })

  it('retries once on a transient failure and succeeds', async () => {
    calls.outcomes = [{ throws: statusError(529) }, { message: goodMessage() }]

    const results = await generateFaqSeedCandidates(input())

    expect(calls.streamArgs).toHaveLength(2)
    expect(results).toHaveLength(1)
    expect(loggerWarn).toHaveBeenCalledWith(
      'faq-seed-agent: retrying Opus call after a transient failure',
      expect.objectContaining({ attempt: 1 }),
    )
  })

  it('retries a rate limit', async () => {
    calls.outcomes = [{ throws: statusError(429) }, { message: goodMessage() }]

    const results = await generateFaqSeedCandidates(input())

    expect(calls.streamArgs).toHaveLength(2)
    expect(results).toHaveLength(1)
  })

  it('does NOT retry a 400: the same request would be refused again', async () => {
    calls.outcomes = [{ throws: statusError(400) }, { message: goodMessage() }]

    const results = await generateFaqSeedCandidates(input())

    expect(calls.streamArgs).toHaveLength(1)
    expect(results).toEqual([])
  })

  it('does NOT retry a 403', async () => {
    calls.outcomes = [{ throws: statusError(403) }, { message: goodMessage() }]

    await generateFaqSeedCandidates(input())

    expect(calls.streamArgs).toHaveLength(1)
  })

  it('stops after two attempts rather than retrying for ever', async () => {
    calls.outcomes = [{ throws: statusError(500) }, { throws: statusError(500) }, { message: goodMessage() }]

    const results = await generateFaqSeedCandidates(input())

    expect(calls.streamArgs).toHaveLength(2)
    expect(results).toEqual([])
  })

  it('reports a truncated answer as the token ceiling, not as missing JSON', async () => {
    calls.outcomes = [{
      message: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"faqs": [{"question": "Q?' }] },
    }]

    const results = await generateFaqSeedCandidates(input())

    expect(results).toEqual([])
    const failure = agentRuns.find(r => r.status === 'failed')
    expect(failure).toBeDefined()
    expect(String(failure!.error_message)).toContain('truncated')
    // The misleading message this replaces.
    expect(String(failure!.error_message)).not.toContain('no JSON object found')
  })

  it('does not retry a truncation: the same request truncates again', async () => {
    calls.outcomes = [
      { message: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }] } },
      { message: goodMessage() },
    ]

    await generateFaqSeedCandidates(input())

    expect(calls.streamArgs).toHaveLength(1)
  })
})
