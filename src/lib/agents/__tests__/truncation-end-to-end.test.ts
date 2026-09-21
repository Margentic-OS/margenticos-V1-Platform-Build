// THE WHOLE TRUNCATION PATH, ACROSS THE BRIDGE, AGAINST ONE DATABASE.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS, AND WHY THE HALVES WERE NOT ENOUGH
//
// ADR-059 shipped the truncation fix as two halves with a test on each: the sweep labels a
// truncated entry 'failed' (batch-sweep.test.ts) and the collect agent selects 'failed'
// (research-collect-snapshot.test.ts). Both passed. The feature was inert.
//
// The missing piece sat between them: enqueueCollectJobs creates the only research_collect
// job in the repo, and its own state list did not include 'failed'. So the entry was
// labelled correctly, was readable by a job that was never created, reached no phase 2,
// wrote no research row, and then read as unresearched and re-bought its four sources.
//
// TWO GREEN HALF-TESTS CANNOT SEE A BROKEN JOIN. That is the whole lesson, and it is why
// this file runs the REAL sweep and the REAL collect agent against ONE shared fake database
// and asserts the CHAIN rather than the ends: labelled -> enqueued -> selected -> retried ->
// research row -> no longer unresearched.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IS FAKED, AND THE RULE THE FAKE FOLLOWS
//
// Faked: Anthropic (the paid boundary), the writer/judge, and the two write helpers.
//
// The two write helpers are BEHAVIOURAL stand-ins, not inert spies: storeResearchResult
// inserts a row and updateProspect applies its patch to the prospect. That is deliberate and
// it is what makes the last assertion mean anything - the re-spend check has to read a
// prospect row that a real run would have left behind, not a mock's call log.
//
// The query builder THROWS on any method it does not implement. A fake that silently returns
// its chain cannot test a filter, which is the failure mode that produced this file.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message } from '@anthropic-ai/sdk/resources/messages'

// ─── Hoisted, because vi.mock's factory runs before module init ──────────────
const {
  enqueueResearchPhaseJob, retryTruncatedSynthesis, produceOpening,
  storeResearchResult, updateProspect, db,
} = vi.hoisted(() => {
  const state = {
    batches: [] as Record<string, unknown>[],
    entries: [] as Record<string, unknown>[],
    prospects: [] as Record<string, unknown>[],
    research: [] as Record<string, unknown>[],
    jobs: [] as Record<string, unknown>[],
  }
  return {
    db: state,
    enqueueResearchPhaseJob: vi.fn(),
    retryTruncatedSynthesis: vi.fn(),
    produceOpening: vi.fn(),
    storeResearchResult: vi.fn(),
    updateProspect: vi.fn(),
  }
})

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
// PARTIAL, and deliberately so: this file's whole subject is a list that drifted because two
// places held their own copy. A whole-module mock here would be the same mistake in the test,
// and it already bit once - it dropped prospectsWithLiveResearchJob, which the research
// selector calls.
vi.mock('@/lib/queue/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/queue/job-queue')>()),
  enqueueResearchPhaseJob,
}))
// The collect agent builds its OWN client through getServiceClient/createClient rather than
// taking one, so the only way to give it the shared fake is at the module boundary.
vi.mock('@supabase/supabase-js', () => ({ createClient: () => client() }))
vi.mock('@/lib/agents/prospect-research-sources-agent', () => ({ BATCH_CACHE_TTL: '1h' }))
vi.mock('@/lib/agents/log-agent-run', () => ({
  startAgentRun: async () => ({ run_id: 'run-1', complete: async () => {}, fail: async () => {} }),
}))

// PARTIAL. wasTruncated and COLLECTABLE_ENTRY_STATES stay REAL - they are the logic under
// test. Only the paid call is stubbed.
vi.mock('@/lib/agents/research/synthesize', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/research/synthesize')>()),
  retryTruncatedSynthesis,
}))
vi.mock('@/lib/agents/research/produce-opening', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/research/produce-opening')>()),
  produceOpening,
  loadClientName: async () => 'Placeholder Client',
}))
vi.mock('@/lib/agents/prospect-research-agent-v2', () => ({
  storeResearchResult,
  updateProspect,
}))
vi.mock('@/lib/agents/research/prospect-context', () => ({
  loadProspectContext: async (_c: unknown, id: string) => ({
    ctx: {
      id, organisation_id: ORG, segment_id: 'seg-1',
      first_name: 'Placeholder', last_name: 'Person', company_name: 'Placeholder Company',
      role: null, job_title: 'Placeholder Title', email: 'placeholder@example.test',
      linkedin_url: null, website_url: null, country: null, company: null,
    },
    extras: { apollo_enrichment_data: null, variant_id: 'A' },
  }),
}))

const ORG = '00000000-0000-4000-8000-000000000001'
const PROSPECT = '00000000-0000-4000-8000-0000000000p1'.replace('p1', '0a1')
const NOW = new Date('2026-09-15T12:00:00Z')

// ─── The one shared fake database ────────────────────────────────────────────

type Row = Record<string, unknown>

/**
 * A builder that records its filters and applies them for real.
 *
 * Every method a caller under test uses is implemented. Anything else throws, because a
 * chain-returning stub for an unimplemented method is exactly how a dropped filter passes.
 */
function table(rows: Row[], onInsert?: (r: Row) => void) {
  const eqs: Array<[string, unknown]> = []
  const ins: Array<[string, unknown[]]> = []
  const isNull: string[] = []
  const notNull: string[] = []
  const cmps: Array<[string, 'gte' | 'lte' | 'gt' | 'lt', unknown]> = []
  let ordered = false
  let limited: number | null = null
  let updatePatch: Row | null = null

  const matches = (r: Row) =>
    eqs.every(([c, v]) => r[c] === v)
    && ins.every(([c, v]) => (v as unknown[]).includes(r[c]))
    && isNull.every(c => r[c] === null || r[c] === undefined)
    && notNull.every(c => r[c] !== null && r[c] !== undefined)
    && cmps.every(([c, op, v]) => {
      const a = r[c]
      if (a === null || a === undefined) return false
      if (op === 'gte') return (a as never) >= (v as never)
      if (op === 'lte') return (a as never) <= (v as never)
      if (op === 'gt') return (a as never) > (v as never)
      return (a as never) < (v as never)
    })

  const resolve = () => {
    let out = rows.filter(matches)
    if (updatePatch) {
      out.forEach(r => Object.assign(r, updatePatch))
      return { data: out.map(r => ({ ...r })), error: null }
    }
    if (ordered) out = [...out].reverse()
    if (limited !== null) out = out.slice(0, limited)
    return { data: out.map(r => ({ ...r })), error: null }
  }

  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (c: string, v: unknown) => { eqs.push([c, v]); return chain },
    in: (c: string, v: unknown[]) => { ins.push([c, v]); return chain },
    is: (c: string, v: unknown) => {
      if (v !== null) throw new Error(`fake: .is(${c}, ${String(v)}) not implemented`)
      isNull.push(c); return chain
    },
    not: (c: string, op: string, v: unknown) => {
      if (op !== 'is' || v !== null) throw new Error(`fake: .not(${c},${op},...) not implemented`)
      notNull.push(c); return chain
    },
    or: () => { throw new Error('fake: .or() not implemented — the research gate must use .not()') },
    // HONOURED, not swallowed. A comparison the fake ignores is a filter the test cannot see.
    gte: (c: string, v: unknown) => { cmps.push([c, 'gte', v]); return chain },
    lte: (c: string, v: unknown) => { cmps.push([c, 'lte', v]); return chain },
    gt: (c: string, v: unknown) => { cmps.push([c, 'gt', v]); return chain },
    lt: (c: string, v: unknown) => { cmps.push([c, 'lt', v]); return chain },
    order: () => { ordered = true; return chain },
    limit: (n: number) => { limited = n; return chain },
    update: (patch: Row) => { updatePatch = patch; return chain },
    insert: (r: Row | Row[]) => {
      const list = Array.isArray(r) ? r : [r]
      list.forEach(x => { rows.push({ ...x }); onInsert?.(x) })
      return chain
    },
    maybeSingle: async () => {
      const { data } = resolve()
      return { data: data[0] ?? null, error: null }
    },
    single: async () => {
      const { data } = resolve()
      return { data: data[0] ?? null, error: null }
    },
    then: (res: (v: unknown) => void) => res(resolve()),
  }
  return chain
}

function client() {
  return {
    from(name: string) {
      if (name === 'synthesis_batches') return table(db.batches)
      if (name === 'synthesis_batch_entries') return table(db.entries)
      if (name === 'prospects') return table(db.prospects)
      if (name === 'prospect_research_results') return table(db.research)
      if (name === 'job_queue') return table(db.jobs)
      // archived_at present and null, because selectProspectsForResearch filters on it.
      if (name === 'organisations') return table([{ id: ORG, name: 'Placeholder Client', archived_at: null }])
      if (name === 'strategy_documents') return table([])
      throw new Error(`fake does not implement table ${name}`)
    },
  } as never
}

// ─── The truncated Anthropic result the batch returns ────────────────────────

const TRUNCATED_MESSAGE = {
  id: 'msg_truncated', type: 'message', role: 'assistant', model: 'placeholder',
  content: [{ type: 'text', text: '<reasoning>ran long' }],
  stop_reason: 'max_tokens', stop_sequence: null,
  usage: {
    input_tokens: 1200, output_tokens: 24000,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 8500,
  },
} as unknown as Message

const GOOD_RETRY_MESSAGE = {
  id: 'msg_retry', type: 'message', role: 'assistant', model: 'placeholder',
  content: [{ type: 'text', text: '<reasoning>brief</reasoning>\n{"icp_fit":"strong","candidates":[]}' }],
  stop_reason: 'end_turn', stop_sequence: null,
  usage: {
    input_tokens: 1100, output_tokens: 9000,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 8500,
  },
} as unknown as Message

function fakeAnthropic() {
  return {
    messages: {
      batches: {
        retrieve: async (id: string) => ({
          id, processing_status: 'ended', ended_at: NOW.toISOString(), request_counts: { succeeded: 1 },
        }),
        results: async function* () {
          yield { custom_id: 'entry-1', result: { type: 'succeeded', message: TRUNCATED_MESSAGE } }
        },
      },
    },
  } as never
}

function seed() {
  db.batches.length = 0; db.entries.length = 0
  db.prospects.length = 0; db.research.length = 0; db.jobs.length = 0

  db.batches.push({
    id: 'batch-1', organisation_id: ORG, state: 'submitted',
    anthropic_batch_id: 'msgbatch_1', poll_count: 0, request_count: 1,
    requested_at: new Date(NOW.getTime() - 3_600_000).toISOString(),
  })
  db.entries.push({
    id: 'entry-1', batch_id: 'batch-1', organisation_id: ORG, prospect_id: PROSPECT,
    state: 'submitted',
    raw_sources: { linkedin: {}, apollo: {}, website: {}, web_search: { search_count: 2 } },
    detected_signal: { has_dateable_signal: false, signal_observation: null },
    client_context: { clientName: 'Placeholder Client', icpSummary: 'placeholder' },
    client_name: 'Placeholder Client', segment_id: 'seg-1', variant_id: 'A',
    messaging_doc_id: 'doc-1', messaging_content: { variants: { A: {} } },
    response_message: null, result_type: null, error: null, usage: null, stop_reason: null,
  })
  // A prospect that would otherwise be picked up as unresearched: positively tiered,
  // verified, not suppressed, no research row yet.
  db.prospects.push({
    id: PROSPECT, organisation_id: ORG, suppressed: false,
    sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 100)',
    current_research_result_id: null, personalisation_trigger: null,
    independent_verified_at: '2026-09-01T00:00:00Z', independent_email_status: 'Valid',
    email_send_ineligible_reason: null, verification_provider: 'placeholder',
    second_pass_status: null, second_pass_provider: null,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'sk-placeholder-not-a-real-key'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://placeholder.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder-service-role'
  seed()

  retryTruncatedSynthesis.mockResolvedValue(GOOD_RETRY_MESSAGE)
  produceOpening.mockResolvedValue({
    not_written_reason: null, opening: 'A placeholder opening.', question: 'A placeholder question?',
    subject: null, bridge: null, observation: null, written_won: true, retry_used: false,
    retries_used: 0, strong_material: false, judge_reasoning: 'placeholder',
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, calls: 0 },
    comparisons: [], gate_failures: [],
  // The follow-up fields the real produceOpening always returns. A mock that omits
    // them is the fake-that-silently-accepts shape: it passes while the real object
    // would not, and the caller then crashes only in production.
    email2: { prose: null, body: null, discarded: null, failures: [] },
    email3: { prose: null, body: null, discarded: null, failures: [] },
    followup_usage: null, followup_attempts: [], followup_email1_fingerprint: null,
  })
  // BEHAVIOURAL stand-ins: they do to the database what the real ones do, because the
  // re-spend assertion has to read a realistic prospect row.
  storeResearchResult.mockImplementation(async () => {
    const id = 'research-1'
    db.research.push({ id, prospect_id: PROSPECT, organisation_id: ORG })
    return id
  })
  // Signature mirrors the real one: (prospect, synthesis, resultId, opening, classifiedAt).
  // It writes the two fields the re-spend question turns on, because
  // selectProspectsForResearch keys 'unresearched' on current_research_result_id IS NULL and
  // its overwrite guard reads personalisation_trigger.
  updateProspect.mockImplementation(async (
    prospect: { id: string },
    _synthesis: unknown,
    resultId: string,
    opening: { written_won?: boolean; opening?: string | null },
  ) => {
    const row = db.prospects.find(p => p.id === prospect.id)
    if (!row) return
    row.current_research_result_id = resultId
    row.personalisation_trigger = opening?.written_won ? (opening.opening ?? null) : null
  })
})

describe('a truncated synthesis travels the whole path, not two halves of it', () => {
  it('is labelled failed, enqueued, selected, retried, and ends with a research row', async () => {
    const { runSynthesisBatchSweep } = await import('../research/batch-sweep')
    const { runProspectResearchCollect } = await import('../prospect-research-collect-agent')

    // ── PHASE 1: the sweep collects a truncated answer ──────────────────────
    await runSynthesisBatchSweep(client(), fakeAnthropic(), NOW)

    const entry = db.entries.find(e => e.id === 'entry-1')!

    // LINK 1: our lifecycle verdict says failed, and the provider's billing word is kept.
    expect(entry.state).toBe('failed')
    expect(entry.result_type).toBe('succeeded')
    expect(String(entry.error)).toMatch(/cut off at the output ceiling/i)
    expect(entry.response_message).toBeTruthy()

    // LINK 2: THE BRIDGE. Without this the two halves below are unreachable.
    expect(enqueueResearchPhaseJob).toHaveBeenCalledTimes(1)
    expect(enqueueResearchPhaseJob.mock.calls[0][1]).toMatchObject({
      jobType: 'research_collect',
      prospectId: PROSPECT,
      organisationId: ORG,
    })

    // ── PHASE 2: the collect agent runs, as that job would run it ───────────
    const result = await runProspectResearchCollect({ prospect_id: PROSPECT, client_id: ORG })

    // LINK 3: the selector accepted an entry in state 'failed'. If it had not, the agent
    // throws "No collectable synthesis entry" and this line never runs.
    expect(result).toBeTruthy()

    // LINK 4: the retry happened, exactly once.
    expect(retryTruncatedSynthesis).toHaveBeenCalledTimes(1)

    // LINK 5: a research row exists, so the paid sources bought something.
    expect(storeResearchResult).toHaveBeenCalledTimes(1)
    expect(db.research).toHaveLength(1)

    // LINK 6: the entry is finished, not left mid-flight.
    expect(db.entries.find(e => e.id === 'entry-1')!.state).toBe('collected')
  })

  it('closes the re-spend path: the prospect no longer reads as unresearched', async () => {
    // THE POINT OF THIS ASSERTION. 'failed' sits outside the
    // synthesis_batch_entries_one_live_per_prospect predicate, so a truncated entry releases
    // the prospect's one-live-entry slot. Before the bridge existed, phase 2 never ran, no
    // research row was written, current_research_result_id stayed null, and the prospect was
    // re-selected as unresearched - re-buying Apify, Apollo, the website fetch and web search.
    //
    // Proved against the REAL selector, not by inspecting a mock's call log.
    const { runSynthesisBatchSweep } = await import('../research/batch-sweep')
    const { runProspectResearchCollect } = await import('../prospect-research-collect-agent')
    const { selectProspectsForResearch } = await import('@/lib/queue/enqueue/research')

    // Before anything runs, the prospect IS a legitimate unresearched candidate. This is the
    // control: without it, a selector that returns nothing would satisfy the assertion below
    // for entirely the wrong reason.
    const before = await selectProspectsForResearch(client(), ORG, 'unresearched', 50)
    if (!before.ok) throw new Error(`expected the selector to succeed: ${before.error}`)
    expect(before.selection.enqueueable).toContain(PROSPECT)

    await runSynthesisBatchSweep(client(), fakeAnthropic(), NOW)
    await runProspectResearchCollect({ prospect_id: PROSPECT, client_id: ORG })

    // After the full path, the prospect carries a research result and is out of the
    // unresearched population. Nothing will re-buy its sources.
    expect(db.prospects[0].current_research_result_id).toBe('research-1')

    const after = await selectProspectsForResearch(client(), ORG, 'unresearched', 50)
    if (!after.ok) throw new Error(`expected the selector to succeed: ${after.error}`)
    expect(after.selection.enqueueable).not.toContain(PROSPECT)
    expect(after.selection.selected).toBe(0)
  })
})
