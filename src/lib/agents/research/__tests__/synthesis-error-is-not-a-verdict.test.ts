// FIX 7. A SYNTHESIS ERROR MUST NEVER BECOME A CONTENT DECISION.
//
// THE INCIDENT THIS ENCODES, 2026-09-21. A fresh research run over 28 prospects had every
// synthesis call refused by the SDK before it was sent. synthesizeResearch caught each
// error and returned buildFallbackSynthesis: a well-formed SynthesisOutput carrying ZERO
// candidates and no_signal. Downstream that is indistinguishable from a synthesis that ran
// and honestly found nothing, so with allow_overwrite_trigger on it CLEARED the copy.
// NINETEEN prospects lost real personalisation copy. Zero model calls reached Anthropic.
// The batch reported "completed".
//
// The control group was in the same run: 9 prospects whose result INSERT threw kept their
// copy intact. Throwing was already the safe behaviour; the error path just did not throw.
//
// WHAT THIS FILE PINS, and it is a shape rather than a message: on a call failure
// synthesizeResearch THROWS. It must never RETURN, because every return value is a verdict
// and a verdict is what overwrites copy.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const streamMock = vi.fn()

// importOriginal, so the module keeps every other export. A bare factory silently drops
// anything this module adds later, and the failure looks like an unrelated import error.
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/sdk')>()
  return {
    ...actual,
    default: class {
      messages = { stream: streamMock, create: streamMock }
    },
  }
})

vi.mock('@/lib/agents/research/synthesize', async (importOriginal) => {
  return await importOriginal<typeof import('../synthesize')>()
})

const PROSPECT = {
  id: 'p-fix7', organisation_id: 'org-fix7', first_name: 'Test', last_name: 'Prospect',
  company_name: 'Example Co', role: 'Founder', linkedin_url: null, website_url: null,
} as never

const RAW = {
  linkedin: { available: false, error: 'skipped' },
  apollo: { available: false, error: 'skipped' },
  website: { available: false, error: 'skipped' },
  web_search: { available: false, error: 'skipped' },
} as never

describe('FIX 7: a synthesis error is not a no-signal verdict', () => {
  beforeEach(() => {
    vi.resetModules()
    streamMock.mockReset()
    process.env.ANTHROPIC_API_KEY = 'test-key-not-real'
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('THROWS SynthesisCallFailedError when the model call fails, and returns nothing', async () => {
    const { synthesizeResearch, SynthesisCallFailedError } = await import('../synthesize')
    // The exact failure from the incident: the SDK refuses before sending.
    streamMock.mockImplementation(() => {
      throw new Error('Streaming is required for operations that may take longer than 10 minutes.')
    })

    let threw: unknown = null
    let returned: unknown = 'NOT-SET'
    try { returned = await synthesizeResearch(PROSPECT, RAW, 'client-fix7') }
    catch (e) { threw = e }

    // THE ASSERTION THAT MATTERS: it threw, and it did NOT hand back a verdict.
    expect(returned).toBe('NOT-SET')
    expect(threw).toBeInstanceOf(SynthesisCallFailedError)
  })

  // MUTATION PROOF. Reverting FIX 7 means returning buildFallbackSynthesis instead of
  // throwing. That return value is what cleared 19 prospects' copy, and it is
  // well-formed, so nothing else in the suite would object to it. This asserts the shape
  // of the reverted behaviour directly: a returned SynthesisOutput with no candidates and
  // no_signal is the bug, and if a future edit brings it back, the test above goes red
  // because `returned` is no longer 'NOT-SET'.
  it('a returned no-signal output would be indistinguishable from an honest miss', async () => {
    const { synthesisFallback } = await import('../synthesize')
    const fallback = synthesisFallback(PROSPECT, { icpSummary: 'icp summary' } as never, { has_dateable_signal: false, signal_observation: null, signal_relevance: 'no_signal' } as never, 'Claude error: boom')
    // This is what the old code returned on an ERROR. Note what a caller can see:
    expect(fallback.candidates ?? []).toHaveLength(0)
    expect(fallback.signal_relevance).toBe('no_signal')
    // Nothing on the object says "this failed". That is the entire defect: the only
    // signal of an error was a log line, and copy is cleared from the RETURN VALUE.
    expect(Object.keys(fallback)).not.toContain('error')
    expect(Object.keys(fallback)).not.toContain('failed')
  })
})
