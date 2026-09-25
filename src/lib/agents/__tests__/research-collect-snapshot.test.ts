// Phase 2 of the batch research path, and the one thing it must never do: re-read
// something the wait could have changed.
//
// Every assertion here is about a value that moves SILENTLY. If phase 2 fetched the
// current messaging document instead of the snapshot, nothing would fail: the prospect
// would simply receive an opening written against copy that phase 1 never saw. That is
// the exact reason compose was never migrated to the queue, and it is the risk the
// snapshot columns exist to remove.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const produceOpening = vi.fn()
const storeResearchResult = vi.fn()
const updateProspect = vi.fn()
const synthesisFromMessage = vi.fn()
const synthesisFallback = vi.fn()
const retryTruncatedSynthesis = vi.fn()

vi.mock('../research/produce-opening', () => ({
  produceOpening,
  loadClientName: async () => 'Fetched Name Nobody Should Use',
  resolveVariantId: () => 'SHOULD-NOT-BE-CALLED',
}))
vi.mock('../prospect-research-agent-v2', () => ({
  storeResearchResult,
  updateProspect,
}))
// PARTIAL, VIA importOriginal. A whole-module replacement silently removes every export the
// agent does not currently use, and when the agent started reading wasTruncated that would
// have thrown inside the collect path. wasTruncated is pure, so it stays REAL: stubbing it
// would test the stub. retryTruncatedSynthesis IS stubbed, because it makes a paid call.
vi.mock('../research/synthesize', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../research/synthesize')>()),
  synthesisFromMessage,
  synthesisFallback,
  retryTruncatedSynthesis,
}))
vi.mock('../research/prospect-context', () => ({
  loadProspectContext: async () => ({
    ctx: {
      id: 'p-1', organisation_id: 'org-1', segment_id: 'seg-1',
      first_name: 'Ada', last_name: 'Okoro', company_name: 'Meridian Systems',
      role: 'Head of Delivery', email: 'ada@example.com',
      linkedin_url: null, website_url: null,
    },
    extras: { apollo_enrichment_data: null, variant_id: 'D_ASSIGNED_DURING_THE_WAIT' },
  }),
}))
vi.mock('@/lib/agents/log-agent-run', () => ({
  startAgentRun: async () => ({
    run_id: 'run-collect-1',
    complete: async () => {},
    fail: async () => {},
  }),
}))

const SNAPSHOT_DOC = { variants: { A: { snapshot: true } } }
const CURRENT_DOC  = { variants: { A: { snapshot: false } } }

interface FakeOpts {
  entryState?: string
  hasMessage?: boolean
  suppressed?: boolean
  emailStatus?: string | null
  currentApprovedDocId?: string | null
  entryMissing?: boolean
  /** Override the stored Message, so a truncated one can be collected. */
  responseMessage?: Record<string, unknown> | null
  /**
   * Entries of this batch not yet collected. Defaults to 1, so the end-of-batch repetition
   * tally does not fire in the tests that are about the snapshot. Set to 0 to make this job
   * the last one.
   */
  remainingEntries?: number
}

function fakeSupabase(opts: FakeOpts = {}) {
  const updates: Array<Record<string, unknown>> = []
  const inFilters: Array<[string, unknown[]]> = []

  const entryRow = {
    id: 'entry-1',
    state: opts.entryState ?? 'succeeded',
    raw_sources: { linkedin: { available: true }, apollo: {}, website: {}, web_search: { search_count: 1 } },
    detected_signal: { has_dateable_signal: true, signal_observation: 'snapshotted signal' },
    client_context: { clientName: 'Northwind', icpSummary: 'snapshotted icp' },
    client_name: 'Northwind Advisory',
    variant_id: 'A_SNAPSHOTTED',
    messaging_doc_id: 'doc-snapshot',
    segment_id: 'seg-SNAPSHOTTED',
    messaging_content: SNAPSHOT_DOC,
    response_message: opts.responseMessage !== undefined
      ? opts.responseMessage
      : (opts.hasMessage ?? true) ? { id: 'msg_1', content: [{ type: 'text', text: '{}' }] } : null,
    result_type: (opts.hasMessage ?? true) ? 'succeeded' : 'errored',
    error: (opts.hasMessage ?? true) ? null : 'overloaded_error',
    batch_id: 'batch-1',
  }

  const neqFilters: Array<[string, unknown]> = []
  // Entries of this batch not yet collected. Non-zero by default, so the end-of-batch tally
  // does not run in tests that are about something else.
  const countRemaining = opts.remainingEntries ?? 1

  const client = {
    from(table: string) {
      const countChain: Record<string, unknown> = {
        eq: () => countChain,
        neq: (c: string, v: unknown) => { neqFilters.push([c, v]); return countChain },
        then: (resolve: (r: { count: number; error: null }) => unknown) =>
          resolve({ count: countRemaining, error: null }),
      }
      const chain: Record<string, unknown> = {
        // COUNT MODE. `select('id', { count: 'exact', head: true })` returns a thenable that
        // resolves to { count }, not a row set. reportBatchRepetition uses it to ask whether
        // it is the last entry of its batch; answering "one still outstanding" is what keeps
        // every other test in this file on the path it was written for, since none of them
        // is about the end-of-batch tally.
        // A HEAD COUNT IS A THENABLE BUILDER, not a promise. PostgREST lets you keep
        // chaining filters onto `select(cols, { head: true, count: 'exact' })` and await the
        // result, so a fake that returned a bare promise here broke on the very next `.eq`.
        select: (_cols?: string, o?: { count?: string; head?: boolean }) =>
          o?.head ? countChain : chain,
        eq: () => chain,
        // HONOURED. It is the only thing separating "entries still to collect" from "all of
        // them", and a fake that swallowed it would make the tally look like it ran on every
        // job when it runs on one.
        neq: (c: string, v: unknown) => { neqFilters.push([c, v]); return chain },
        // HONOURED, not swallowed. The states phase 2 is willing to collect are the whole of
        // its contract with the sweep, and this used to accept the call and drop it, so a test
        // could not tell a widened filter from an unchanged one.
        in: (c: string, v: unknown) => { inFilters.push([c, v as unknown[]]); return chain },
        order: () => chain,
        limit: () => chain,
        update: (patch: Record<string, unknown>) => { updates.push({ table, ...patch }); return chain },
        maybeSingle: async () => {
          if (table === 'synthesis_batch_entries') {
            return { data: opts.entryMissing ? null : entryRow, error: null }
          }
          if (table === 'synthesis_batches') return { data: { ended_at: '2026-08-26T09:00:00Z' }, error: null }
          if (table === 'strategy_documents') {
            return {
              data: opts.currentApprovedDocId === null ? null : { id: opts.currentApprovedDocId ?? 'doc-snapshot' },
              error: null,
            }
          }
          return { data: null, error: null }
        },
        single: async () => {
          if (table === 'prospects') {
            return {
              data: {
                suppressed: opts.suppressed ?? false,
                independent_verified_at: '2026-08-10T00:00:00Z',
                independent_email_status: opts.emailStatus === undefined ? 'Valid' : opts.emailStatus,
                email_send_ineligible_reason: null,
                verification_provider: null,
                second_pass_status: null,
                second_pass_provider: null,
              },
              error: null,
            }
          }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      }
      return chain
    },
  }
  return { client, updates, inFilters }
}

async function runCollect(opts: FakeOpts = {}) {
  const fake = fakeSupabase(opts)
  vi.doMock('@supabase/supabase-js', () => ({ createClient: () => fake.client }))
  vi.resetModules()
  const { runProspectResearchCollect } = await import('../prospect-research-collect-agent')
  const result = await runProspectResearchCollect({ prospect_id: 'p-1', client_id: 'org-1' })
  return { result, updates: fake.updates, inFilters: fake.inFilters }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  synthesisFromMessage.mockReturnValue({
    candidates: [{ id: 'c1', observation: 'x' }],
    qualification_status: 'qualified',
    usage: { calls: 1 },
  })
  synthesisFallback.mockReturnValue({
    candidates: [], qualification_status: 'qualified', usage: { calls: 0 },
  })
  produceOpening.mockResolvedValue({
    opening: 'An opening.', question: 'A question?', bridge: null, observation: 'x',
    written_won: true, retry_used: false, retries_used: 0, strong_material: true,
    judge_reasoning: 'ok', usage: { calls: 3 },
  // The follow-up fields the real produceOpening always returns. A mock that omits
    // them is the fake-that-silently-accepts shape: it passes while the real object
    // would not, and the caller then crashes only in production.
    email2: { prose: null, body: null, discarded: null, failures: [] },
    email3: { prose: null, body: null, discarded: null, failures: [] },
    followup_usage: null, followup_attempts: [], followup_email1_fingerprint: null,
  })
  storeResearchResult.mockResolvedValue('result-1')
  updateProspect.mockResolvedValue(undefined)
})

describe('phase 2 writes against the SNAPSHOT, never a fresh read', () => {
  it('passes the snapshotted messaging content to the writer', async () => {
    await runCollect()
    expect(produceOpening).toHaveBeenCalledTimes(1)
    const arg = produceOpening.mock.calls[0][0]
    // The document the writer was scoped to in phase 1, not whatever is approved now.
    expect(arg.messagingContent).toBe(SNAPSHOT_DOC)
    expect(arg.messagingContent).not.toBe(CURRENT_DOC)
  })

  it('uses the snapshotted variant, not one composition assigned during the wait', async () => {
    // loadProspectContext deliberately returns variant_id 'D_ASSIGNED_DURING_THE_WAIT'.
    // Taking it would put an opening written for variant A's P3 and CTA into variant D's
    // email, and nothing would fail.
    await runCollect()
    expect(produceOpening.mock.calls[0][0].variantId).toBe('A_SNAPSHOTTED')
    expect(produceOpening.mock.calls[0][0].variantId).not.toBe('D_ASSIGNED_DURING_THE_WAIT')
  })

  it('uses the snapshotted client name rather than re-reading the organisation', async () => {
    await runCollect()
    expect(produceOpening.mock.calls[0][0].clientName).toBe('Northwind Advisory')
  })

  it('passes the snapshotted client context and recency signal to the parse', async () => {
    await runCollect()
    const [, , clientContext, detectedSignal] = synthesisFromMessage.mock.calls[0]
    expect(clientContext).toEqual({ clientName: 'Northwind', icpSummary: 'snapshotted icp' })
    expect(detectedSignal).toEqual({ has_dateable_signal: true, signal_observation: 'snapshotted signal' })
  })

  it('stamps synthesized_at with the BATCH completion time, not collection time', async () => {
    // The column defaults to now(). loadStoredFindings hands this value to updateProspect
    // as classifiedAt, so a collection-time stamp would make a verdict reached yesterday
    // look freshly confirmed today.
    await runCollect()
    expect(storeResearchResult.mock.calls[0][5]).toBe('2026-08-26T09:00:00Z')
    expect(updateProspect.mock.calls[0][4]).toBe('2026-08-26T09:00:00Z')
  })
})

describe('phase 2 reports whether the document moved, and uses the snapshot regardless', () => {
  it('marks doc_superseded when a different document is now approved', async () => {
    const { result, updates } = await runCollect({ currentApprovedDocId: 'doc-newer' })
    expect(result).toMatchObject({ outcome: 'stored', doc_superseded: true })
    expect(updates.find(u => u.table === 'synthesis_batch_entries')).toMatchObject({
      state: 'collected', doc_superseded: true,
    })
    // AND the writer still received the snapshot. Reported, never acted on.
    expect(produceOpening.mock.calls[0][0].messagingContent).toBe(SNAPSHOT_DOC)
  })

  it('does NOT mark superseded inside the promote-but-not-yet-approved window', async () => {
    // Between a promotion and its approval the old row is archived and the new one is
    // pending, so nothing matches active+approved. Reporting "superseded" there would be
    // misleading: no newer document has been approved.
    const { result } = await runCollect({ currentApprovedDocId: null })
    expect(result).toMatchObject({ doc_superseded: false })
  })
})

describe('phase 2 protects spend on prospects that went bad during the wait', () => {
  it('skips the writer and judge entirely for a suppressed prospect', async () => {
    const { result } = await runCollect({ suppressed: true })
    expect(produceOpening).not.toHaveBeenCalled()
    expect(result).toMatchObject({ outcome: 'stored_without_opening', reason: 'suppressed' })
  })

  it('still STORES the research, because the synthesis was already paid for', async () => {
    await runCollect({ suppressed: true })
    expect(storeResearchResult).toHaveBeenCalledTimes(1)
    expect(updateProspect).toHaveBeenCalledTimes(1)
  })

  it('writes an opening with written_won false, so composition ships the approved opener', async () => {
    await runCollect({ suppressed: true })
    const opening = storeResearchResult.mock.calls[0][4]
    // This is the load-bearing field: it makes personalisation_trigger NULL rather than
    // leaving a half-written one behind.
    expect(opening.written_won).toBe(false)
  })
})

describe('phase 2 does not throw away sources when the batch entry failed', () => {
  it('stores a fallback synthesis when Anthropic returned no message', async () => {
    // errored and expired entries are NOT BILLED by Anthropic, but the four source
    // payloads on this row were. Throwing here would discard them.
    const { result } = await runCollect({ entryState: 'errored', hasMessage: false })
    expect(synthesisFallback).toHaveBeenCalledTimes(1)
    expect(synthesisFromMessage).not.toHaveBeenCalled()
    expect(result.outcome).toBe('stored')
    expect(storeResearchResult).toHaveBeenCalledTimes(1)
  })

  it('names the entry and the result type in the fallback reason', async () => {
    await runCollect({ entryState: 'errored', hasMessage: false })
    expect(synthesisFallback.mock.calls[0][3]).toContain('entry-1')
    expect(synthesisFallback.mock.calls[0][3]).toContain('overloaded_error')
  })
})

describe('phase 2 fails loudly when its input is missing', () => {
  it('throws rather than no-opping when no collectable entry exists', async () => {
    // A collect job exists only because something enqueued it. Finding no entry means the
    // queue and the entry table disagree, and a silent success would hide that for ever.
    await expect(runCollect({ entryMissing: true })).rejects.toThrow(/No collectable synthesis entry/)
    expect(produceOpening).not.toHaveBeenCalled()
    expect(storeResearchResult).not.toHaveBeenCalled()
  })
})

describe('phase 2 carries the snapshotted segment, not a freshly resolved one', () => {
  it('uses the entry segment_id on the context handed downstream', async () => {
    // segment_id is the key the messaging document and the ICP were resolved under in
    // phase 1. Re-resolving it here would point the doc-superseded comparison at a
    // different segment's document than the one actually snapshotted. This started as a
    // comment claiming an override the code did not perform.
    await runCollect()
    expect(synthesisFromMessage.mock.calls[0][1].segment_id).toBe('seg-SNAPSHOTTED')
    expect(produceOpening.mock.calls[0][0].ctx.segment_id).toBe('seg-SNAPSHOTTED')
    expect(storeResearchResult.mock.calls[0][0].segment_id).toBe('seg-SNAPSHOTTED')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// A TRUNCATED BATCH ANSWER IS RETRIED ONCE BEFORE THE FALLBACK
//
// Added 2026-09-15. Measured on the live 2026-09-14 batch: 2 of 7 entries hit the 24,000-token
// output ceiling, losing the JSON that is the last thing the answer writes. Each was billed
// about $0.20 at batch rates and bought nothing: no candidates, so the writer never ran and
// the approved template shipped.

describe('phase 2 collects a truncated entry and retries it once', () => {
  const truncatedMessage = {
    id: 'msg_1',
    content: [{ type: 'text', text: '{}' }],
    stop_reason: 'max_tokens',
    usage: { input_tokens: 100, output_tokens: 24000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }

  it('asks for the failed state too, or the sweep change would strand the prospect', async () => {
    // The sweep now records a truncated answer as state 'failed' rather than 'succeeded'.
    // These two are one mechanism in two files: without this value there is no collectable
    // entry, the agent throws, and the research_collect job fails on every attempt.
    const { inFilters } = await runCollect()
    const states = inFilters.find(([c]) => c === 'state')?.[1]
    expect(states).toContain('failed')
    // Still collects the other three, so widening did not replace the contract.
    expect(states).toContain('succeeded')
    expect(states).toContain('errored')
    expect(states).toContain('expired')
  })

  it('retries once, rather than going straight to the fallback', async () => {
    retryTruncatedSynthesis.mockResolvedValue({
      id: 'msg_2', content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 9000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    })

    await runCollect({ entryState: 'failed', responseMessage: truncatedMessage })

    expect(retryTruncatedSynthesis).toHaveBeenCalledTimes(1)
  })

  it('does not retry an answer that finished', async () => {
    // The control. A retry on every entry would triple the synthesis bill.
    await runCollect()
    expect(retryTruncatedSynthesis).not.toHaveBeenCalled()
  })

  it('reads the RETRY through synthesisFromMessage, not the truncated answer', async () => {
    const retryMessage = {
      id: 'msg_2', content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 9000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }
    retryTruncatedSynthesis.mockResolvedValue(retryMessage)

    await runCollect({ entryState: 'failed', responseMessage: truncatedMessage })

    expect(synthesisFromMessage).toHaveBeenCalledTimes(1)
    expect(synthesisFromMessage.mock.calls[0][0]).toBe(retryMessage)
  })

  it('falls back to the truncated answer when the retry could not be made', async () => {
    retryTruncatedSynthesis.mockResolvedValue(null)

    await runCollect({ entryState: 'failed', responseMessage: truncatedMessage })

    // The truncated Message is still what synthesisFromMessage reads, and it returns the
    // fallback with the truncation reason. One call, one usage, no double count.
    expect(synthesisFromMessage.mock.calls[0][0]).toBe(truncatedMessage)
  })
})

// ─── THE JOIN BETWEEN THE AGENT AND THE EXECUTOR ─────────────────────────────
//
// ADDED BECAUSE A MUTATION SURVIVED. Replacing `followup_usage: opening.followup_usage`
// with `null` in this agent broke nothing: the executor's tests feed it a fixture, so they
// prove the executor writes what it is given and say nothing about whether the agent gives
// it anything. A test at each end of a handoff proves both ends and not the handoff.
describe('phase 2 reports what its model calls cost, so the executor can persist them', () => {
  it('passes the follow-up and fact-check tokens through from produceOpening', async () => {
    produceOpening.mockResolvedValue({
      opening: 'An opening.', question: 'A question?', bridge: null, observation: 'x',
      written_won: true, retry_used: false, retries_used: 0, strong_material: true,
      judge_reasoning: 'ok',
      usage: {
        input_tokens: 3016, output_tokens: 6610,
        cache_creation_input_tokens: 3018, cache_read_input_tokens: 21421, calls: 5,
      },
      email2: { prose: 'p2', body: 'b2', discarded: null, failures: [] },
      email3: { prose: 'p3', body: 'b3', discarded: null, failures: [] },
      // Follow-up attempts PLUS the fact-check calls they triggered: write-followups.ts
      // adds the fact-check usage into this same accumulator.
      followup_usage: {
        input_tokens: 2400, output_tokens: 310,
        cache_creation_input_tokens: 1800, cache_read_input_tokens: 4300, calls: 3,
      },
      followup_attempts: [], followup_email1_fingerprint: 'fp',
    })

    const { result } = await runCollect()

    expect(result.outcome).toBe('stored')
    if (result.outcome !== 'stored') throw new Error('unreachable')
    expect(result.followup_usage).toMatchObject({ input_tokens: 2400, output_tokens: 310, calls: 3 })
    // And Email 1's own calls, which this path recorded nowhere at all before.
    expect(result.opening_usage).toMatchObject({ input_tokens: 3016, calls: 5 })
  })

  it('reports null follow-up usage when no follow-up call was made', async () => {
    // The default fixture is the template arm: written_won true, no follow-up call.
    const { result } = await runCollect()
    expect(result.outcome).toBe('stored')
    if (result.outcome !== 'stored') throw new Error('unreachable')
    expect(result.followup_usage).toBeNull()
    // The control: the opening usage IS reported on the same run, so the null above is
    // about the follow-up line and not about a result that carries no usage at all.
    expect(result.opening_usage).toMatchObject({ calls: 3 })
  })
})
