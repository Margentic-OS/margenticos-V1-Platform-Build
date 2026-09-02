// Guards on the two operator entry points, tested against the SHIPPED functions.
//
// These are the checks that stand between an operator click and money, or between an
// operator click and the destruction of copy that has already been sent. Each one is driven
// through the real exported function against a stub client, so a dropped filter or a
// loosened default fails here.
//
// Nothing in this file calls a network. The batch runner, the sourcing orchestrator and the
// agent-run logger are all mocked, and the assertions are about what the entry point
// DECIDES, not about what the underlying agent produces.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const completeSpy = vi.fn()
const failSpy = vi.fn()
vi.mock('@/lib/agents/log-agent-run', () => ({
  startAgentRun: vi.fn(async () => ({
    run_id: 'run-1',
    complete: completeSpy,
    fail: failSpy,
  })),
}))

const batchSpy = vi.fn()
vi.mock('@/lib/agents/prospect-research-agent-v2', () => ({
  runProspectResearchAgentV2Batch: (...args: unknown[]) => batchSpy(...args),
  STORED_FINDINGS_MAX_AGE_DAYS: 30,
}))

const sourcingSpy = vi.fn()
vi.mock('@/lib/sourcing/orchestrator', () => ({
  runSourcing: (...args: unknown[]) => sourcingSpy(...args),
}))

import {
  runResearchBatchForOrg,
  RESEARCH_MAX_PROSPECTS,
  RUNTIME_BUDGET_SECONDS,
  FRESH_SECONDS_PER_PROSPECT,
} from '../research-batch-entry'
import { runSourcingForOrg, SOURCING_MAX_BATCH_SIZE } from '../sourcing-entry'
import { TIER_NOT_REJECTED_FILTER } from '@/lib/sourcing/tier-verdict'

// ─── Stub client ──────────────────────────────────────────────────────────────
//
// Routes by table name. Each table's chain records its filters and resolves to whatever the
// test says the database holds, so the assertions can read the query the real code built.

type Row = Record<string, unknown>

interface TableLog {
  select: string | null
  eq: Array<[string, unknown]>
  in: Array<[string, unknown]>
  is: Array<[string, unknown]>
  not: Array<[string, string, unknown]>
  neq: Array<[string, unknown]>
  gte: Array<[string, unknown]>
  or: string[]
}

function emptyLog(): TableLog {
  return { select: null, eq: [], in: [], is: [], not: [], neq: [], gte: [], or: [] }
}

function stubClient(tables: Record<string, Row[]>) {
  const logs: Record<string, TableLog> = {}

  function builderFor(table: string) {
    const log = logs[table] ?? (logs[table] = emptyLog())
    const rows = tables[table] ?? []

    const builder: Record<string, unknown> = {
      select: (c: string) => { log.select = c; return builder },
      eq: (c: string, v: unknown) => { log.eq.push([c, v]); return builder },
      in: (c: string, v: unknown) => { log.in.push([c, v]); return builder },
      is: (c: string, v: unknown) => { log.is.push([c, v]); return builder },
      not: (c: string, op: string, v: unknown) => { log.not.push([c, op, v]); return builder },
      neq: (c: string, v: unknown) => { log.neq.push([c, v]); return builder },
      gte: (c: string, v: unknown) => { log.gte.push([c, v]); return builder },
      // HONOURED for the tier gate, not merely logged. This stub returns whatever the test
      // says the table holds regardless of filters, which is fine for the filters the tests
      // assert on directly through `logs`. The tier gate is different: it must actually
      // REMOVE rows, or a rejected prospect would still reach the guards below and this
      // file would pass in a world where the gate had been deleted.
      or: (expr: string) => { log.or.push(expr); return builder },
      order: () => builder,
      limit: () => builder,
      single: async () => (rows.length > 0
        ? { data: rows[0], error: null }
        : { data: null, error: { message: 'no rows' } }),
      then: <T,>(onOk: (v: { data: Row[]; error: null }) => T) => {
        const gated = log.or.includes(TIER_NOT_REJECTED_FILTER)
          ? rows.filter(r => r.sourced_tier !== null || r.tiering_reason === null)
          : rows
        return Promise.resolve({ data: gated, error: null }).then(onOk)
      },
    }
    return builder
  }

  const client = { from: (t: string) => builderFor(t) }
  return { client: client as never, logs }
}

const ORG = 'org-1'
const OPERATOR_ID = 'operator-1'
const activeOrg = [{ id: ORG, name: 'Test Org' }]

/**
 * A prospect row as the entry point's select returns it.
 *
 * Carries a clean Valid verdict by default. The send-eligibility gate added 2026-08-25
 * fails closed on a missing verdict, so a fixture without these columns would be filtered
 * out before any guard under test ran, and every assertion here would pass against an
 * empty batch instead of the behaviour it names.
 */
const prospect = (id: string, trigger: string | null = null) => ({
  id,
  personalisation_trigger: trigger,
  independent_verified_at: '2026-08-10T00:00:00Z',
  independent_email_status: 'Valid',
  email_send_ineligible_reason: null,
  // A QUALIFIED tier verdict, for the same reason the verification columns are here: the
  // tier gate added 2026-09-01 removes rejected rows before any guard below runs, so a
  // fixture without these would be filtered out and every assertion in this file would
  // pass against an empty batch. The gate's own behaviour is tested in
  // research-batch-entry-tier-gate.test.ts.
  sourced_tier: 'tier_1' as string | null,
  tiering_reason: 'tier_1 (score 90)' as string | null,
})

const okSummary = {
  total: 1, completed: 1, skipped: 0, failed: 0, failures: [], failed_log_path: null,
  frame_collisions: [], bridge_frame_collisions: [], question_collisions: [],
  distinct_questions: 1, abstract_noun_hits: [], abstract_noun_total: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  batchSpy.mockResolvedValue(okSummary)
  sourcingSpy.mockResolvedValue({
    organisation_id: ORG, trigger_type: 'operator_manual',
    candidates_sourced: 25, candidates_qualified: 25, run_timestamp: 'now',
  })
})

// ─── The guard that protects copy already written ────────────────────────────
//
// updateProspect writes personalisation_trigger on EVERY run: the new wording on a SEND
// verdict, NULL on a HOLD. So re-running a finished prospect either rewrites its opening or
// deletes it. Neither may happen because someone clicked a button.

describe('research entry: overwrite guard', () => {
  it('refuses when any selected prospect already has a trigger', async () => {
    const { client } = stubClient({
      organisations: activeOrg,
      prospects: [prospect('p1'), prospect('p2', 'You ran two firms side by side.')],
      agent_runs: [],
      prospect_research_results: [],
    })

    const result = await runResearchBatchForOrg({
      supabase: client, organisation_id: ORG, scope: 'researched',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('already have a personalisation trigger')
    expect(batchSpy).not.toHaveBeenCalled()
  })

  it('proceeds when the caller explicitly allows the overwrite', async () => {
    const { client } = stubClient({
      organisations: activeOrg,
      prospects: [prospect('p1', 'existing copy')],
      agent_runs: [],
      prospect_research_results: [{ prospect_id: 'p1' }],
    })

    const result = await runResearchBatchForOrg({
      supabase: client, organisation_id: ORG, scope: 'researched',
      allow_overwrite_trigger: true,
    })

    expect(result.ok).toBe(true)
    expect(batchSpy).toHaveBeenCalledTimes(1)
  })

  it('runs without the flag when no selected prospect has a trigger', async () => {
    const { client } = stubClient({
      organisations: activeOrg,
      prospects: [prospect('p1'), prospect('p2')],
      agent_runs: [],
      prospect_research_results: [{ prospect_id: 'p1' }, { prospect_id: 'p2' }],
    })

    const result = await runResearchBatchForOrg({
      supabase: client, organisation_id: ORG, scope: 'unresearched',
    })

    expect(result.ok).toBe(true)
  })
})

// ─── The dashboard route cannot reach the overwrite path ─────────────────────

describe('research route: cannot request an overwrite', () => {
  it('never reads allow_overwrite_trigger from the request body', async () => {
    const src = await import('fs').then(fs =>
      fs.readFileSync(
        'src/app/api/operator/organisations/[id]/research-prospects/route.ts',
        'utf-8',
      ),
    )
    // The flag appears exactly once, hardcoded false. If it is ever wired to the body this
    // fails, because body.allow_overwrite_trigger would appear.
    expect(src).toContain('allow_overwrite_trigger: false')
    expect(src).not.toMatch(/body\.allow_overwrite_trigger/)
  })

  it('keeps stored findings on unless the body explicitly sends false', async () => {
    const src = await import('fs').then(fs =>
      fs.readFileSync(
        'src/app/api/operator/organisations/[id]/research-prospects/route.ts',
        'utf-8',
      ),
    )
    expect(src).toContain('body.use_stored_findings === false ? false : true')
  })
})

// ─── Safe default ─────────────────────────────────────────────────────────────

describe('research entry: use_stored_findings default', () => {
  it('defaults to reusing findings, so a caller cannot pay to re-fetch by omission', async () => {
    const { client } = stubClient({
      organisations: activeOrg,
      prospects: [prospect('p1')],
      agent_runs: [],
      prospect_research_results: [{ prospect_id: 'p1' }],
    })

    await runResearchBatchForOrg({ supabase: client, organisation_id: ORG, scope: 'unresearched' })

    expect(batchSpy.mock.calls[0][0].use_stored_findings).toBe(true)
  })

  it('never lets the batch open a stdin prompt', async () => {
    // confirm_before_run defaults to true in the batch runner, and at 10 or more prospects
    // it calls readline on stdin. On a serverless surface that hangs until the platform
    // kills the request.
    const { client } = stubClient({
      organisations: activeOrg,
      prospects: [prospect('p1')],
      agent_runs: [],
      prospect_research_results: [{ prospect_id: 'p1' }],
    })

    await runResearchBatchForOrg({ supabase: client, organisation_id: ORG, scope: 'unresearched' })

    expect(batchSpy.mock.calls[0][0].confirm_before_run).toBe(false)
  })
})

// ─── Admission control, explicit refusal not silent truncation ───────────────

describe('research entry: size and runtime caps', () => {
  it('refuses more prospects than the absolute ceiling', async () => {
    const many = Array.from({ length: RESEARCH_MAX_PROSPECTS + 1 }, (_, i) => prospect(`p${i}`))
    const { client } = stubClient({
      organisations: activeOrg, prospects: many, agent_runs: [],
      prospect_research_results: many.map(p => ({ prospect_id: p.id })),
    })

    const result = await runResearchBatchForOrg({
      supabase: client, organisation_id: ORG, scope: 'unresearched',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain(`${RESEARCH_MAX_PROSPECTS}-prospect ceiling`)
    expect(batchSpy).not.toHaveBeenCalled()
  })

  it('refuses a fetching batch that would outlast the request, and says the real limit', async () => {
    // Nothing on file, so every prospect fetches all four sources.
    const overBudget = Math.ceil(RUNTIME_BUDGET_SECONDS / FRESH_SECONDS_PER_PROSPECT) + 1
    const rows = Array.from({ length: overBudget }, (_, i) => prospect(`p${i}`))
    const { client } = stubClient({
      organisations: activeOrg, prospects: rows, agent_runs: [], prospect_research_results: [],
    })

    const result = await runResearchBatchForOrg({
      supabase: client, organisation_id: ORG, scope: 'unresearched',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('over the')
    expect(result.error).toContain('fetching every source')
    expect(batchSpy).not.toHaveBeenCalled()
  })

  it('admits the same count when every prospect can reuse findings', async () => {
    // Same size that was refused above. The only difference is that findings are on file,
    // which is exactly what the estimate is for.
    const size = Math.ceil(RUNTIME_BUDGET_SECONDS / FRESH_SECONDS_PER_PROSPECT) + 1
    const rows = Array.from({ length: size }, (_, i) => prospect(`p${i}`))
    const { client } = stubClient({
      organisations: activeOrg, prospects: rows, agent_runs: [],
      prospect_research_results: rows.map(p => ({ prospect_id: p.id })),
    })

    const result = await runResearchBatchForOrg({
      supabase: client, organisation_id: ORG, scope: 'unresearched',
    })

    expect(result.ok).toBe(true)
  })
})

// ─── Isolation and organisation state ────────────────────────────────────────

describe('research entry: organisation gates', () => {
  it('refuses an organisation that does not exist or is archived', async () => {
    const { client } = stubClient({ organisations: [], prospects: [], agent_runs: [], prospect_research_results: [] })

    const result = await runResearchBatchForOrg({
      supabase: client, organisation_id: ORG, scope: 'unresearched',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('not found or archived')
  })

  it('filters every prospect read by organisation_id and excludes suppressed', async () => {
    const { client, logs } = stubClient({
      organisations: activeOrg,
      prospects: [prospect('p1')],
      agent_runs: [],
      prospect_research_results: [{ prospect_id: 'p1' }],
    })

    await runResearchBatchForOrg({ supabase: client, organisation_id: ORG, scope: 'unresearched' })

    expect(logs.prospects.eq).toContainEqual(['organisation_id', ORG])
    expect(logs.prospects.eq).toContainEqual(['suppressed', false])
  })

  it('scopes explicit prospect ids to the organisation rather than trusting them', async () => {
    const { client, logs } = stubClient({
      organisations: activeOrg,
      prospects: [prospect('p1')],
      agent_runs: [],
      prospect_research_results: [{ prospect_id: 'p1' }],
    })

    await runResearchBatchForOrg({
      supabase: client, organisation_id: ORG, scope: 'unresearched',
      prospect_ids: ['p1', 'belongs-to-another-client'],
    })

    expect(logs.prospects.eq).toContainEqual(['organisation_id', ORG])
    expect(logs.prospects.in).toContainEqual(['id', ['p1', 'belongs-to-another-client']])
  })

  it('refuses when nothing matches the scope, rather than running an empty batch', async () => {
    const { client } = stubClient({
      organisations: activeOrg, prospects: [], agent_runs: [], prospect_research_results: [],
    })

    const result = await runResearchBatchForOrg({
      supabase: client, organisation_id: ORG, scope: 'unresearched',
    })

    expect(result.ok).toBe(false)
    expect(batchSpy).not.toHaveBeenCalled()
  })
})

// ─── Concurrency ──────────────────────────────────────────────────────────────

describe('entry points: in-flight guard', () => {
  it('refuses a second research run while one is still going', async () => {
    const { client } = stubClient({
      organisations: activeOrg,
      prospects: [prospect('p1')],
      agent_runs: [{ started_at: new Date().toISOString() }],
      prospect_research_results: [{ prospect_id: 'p1' }],
    })

    const result = await runResearchBatchForOrg({
      supabase: client, organisation_id: ORG, scope: 'unresearched',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('has not finished')
    expect(batchSpy).not.toHaveBeenCalled()
  })

  it('refuses a second sourcing run while one is still going', async () => {
    const { client } = stubClient({
      organisations: activeOrg,
      agent_runs: [{ started_at: new Date().toISOString() }],
    })

    const result = await runSourcingForOrg({
      supabase: client, organisation_id: ORG, target_batch_size: 25,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('has not finished')
    expect(sourcingSpy).not.toHaveBeenCalled()
  })
})

// ─── Sourcing ─────────────────────────────────────────────────────────────────

describe('sourcing entry', () => {
  it('refuses a batch size over the ceiling', async () => {
    const { client } = stubClient({ organisations: activeOrg, agent_runs: [] })

    const result = await runSourcingForOrg({
      supabase: client, organisation_id: ORG, target_batch_size: SOURCING_MAX_BATCH_SIZE + 1,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain(`${SOURCING_MAX_BATCH_SIZE}-prospect ceiling`)
    expect(sourcingSpy).not.toHaveBeenCalled()
  })

  it('refuses a non-integer or zero batch size', async () => {
    const { client } = stubClient({ organisations: activeOrg, agent_runs: [] })

    for (const bad of [0, -5, 2.5, NaN]) {
      const result = await runSourcingForOrg({
        supabase: client, organisation_id: ORG, target_batch_size: bad,
      })
      expect(result.ok).toBe(false)
    }
    expect(sourcingSpy).not.toHaveBeenCalled()
  })

  it('refuses an archived organisation before spending Apollo credits', async () => {
    const { client } = stubClient({ organisations: [], agent_runs: [] })

    const result = await runSourcingForOrg({
      supabase: client, organisation_id: ORG, target_batch_size: 25,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('not found or archived')
    expect(sourcingSpy).not.toHaveBeenCalled()
  })

  it('reports a returned error as a failure, because runSourcing never throws', async () => {
    // Every failure path in the orchestrator returns a zero-count result carrying an error
    // string. A caller that only watches for an exception reads that as a successful run of
    // nothing, which is how a broken sourcing run looks like an empty market.
    sourcingSpy.mockResolvedValue({
      organisation_id: ORG, trigger_type: 'operator_manual',
      candidates_sourced: 0, candidates_qualified: 0, run_timestamp: 'now',
      error: 'no client-approved ICP document found',
    })

    const { client } = stubClient({ organisations: activeOrg, agent_runs: [] })

    const result = await runSourcingForOrg({
      supabase: client, organisation_id: ORG, target_batch_size: 25,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('no client-approved ICP document found')
    expect(failSpy).toHaveBeenCalled()
  })

  it('passes the operator_manual trigger type and the requested size through', async () => {
    const { client } = stubClient({ organisations: activeOrg, agent_runs: [] })

    await runSourcingForOrg({ supabase: client, organisation_id: ORG, target_batch_size: 40 })

    expect(sourcingSpy).toHaveBeenCalledWith(
      expect.anything(), ORG, 'operator_manual', 40, expect.anything(),
    )
  })

  // THE PROVENANCE ARGUMENT IS ASSERTED BY VALUE, not with expect.anything().
  //
  // created_by is the whole reason the route stopped discarding user.id, and agent_run_id
  // is what keeps the sourcing_runs row and its agent_runs row from becoming rival
  // histories of one run. Both are optional parameters threaded through three functions,
  // so dropping either is a silent change: the run still succeeds, the record is still
  // written, and only a column nobody looks at goes quietly NULL.
  it('threads the operator id and the agent run id into the run record', async () => {
    const { client } = stubClient({ organisations: activeOrg, agent_runs: [] })

    await runSourcingForOrg({
      supabase: client,
      organisation_id: ORG,
      target_batch_size: 40,
      created_by: OPERATOR_ID,
    })

    expect(sourcingSpy).toHaveBeenCalledWith(
      expect.anything(), ORG, 'operator_manual', 40,
      expect.objectContaining({
        created_by: OPERATOR_ID,
        agent_run_id: expect.any(String),
      }),
    )
  })

  // A run nobody clicked is a real case, not an error: the committed CLI has no operator.
  // It must record NULL rather than inventing an id or refusing to run.
  it('records no clicker when the caller is the CLI', async () => {
    const { client } = stubClient({ organisations: activeOrg, agent_runs: [] })

    await runSourcingForOrg({ supabase: client, organisation_id: ORG, target_batch_size: 40 })

    expect(sourcingSpy).toHaveBeenCalledWith(
      expect.anything(), ORG, 'operator_manual', 40,
      expect.objectContaining({ created_by: null }),
    )
  })
})
