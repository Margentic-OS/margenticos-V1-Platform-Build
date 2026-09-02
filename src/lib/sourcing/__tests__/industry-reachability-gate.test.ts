// Tests for the orchestrator's pre-search industry reachability gate (step 4.5)
// and for the constant it reads, APOLLO_TARGETED_INDUSTRIES.
//
// ─── ABOUT THE FAKE BELOW ─────────────────────────────────────────────────────
//
// It HONOURS the eq() filters rather than recording and ignoring them: rows are
// actually filtered by what the query asked for, so removing the
// `client_approval_status = approved` filter from the orchestrator makes these
// tests go red instead of silently passing. It THROWS on every method it does not
// implement, which is the other half of the same rule. A fake that quietly returns
// its chain for `limit` or `not` tests nothing about them, and the suite stays
// green in a world where the filter has been deleted.
// See CLAUDE.md, "A fake that does not honour a filter cannot test that filter".

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runSourcing } from '@/lib/sourcing/orchestrator'
import { apolloHandler, APOLLO_TARGETED_INDUSTRIES } from '@/lib/sourcing/handlers/adapter-apollo'
import { CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'
import { logger } from '@/lib/logger'

const ORG = '11111111-2222-3333-4444-555555555555'

// The one live approved spec, read from production on 2026-08-27. Kept here so the
// gate is measured against the client that actually exists rather than an invented one.
const CLIENT_ZERO_INDUSTRIES = [
  'Management Consulting',
  'Operations Consulting',
  'Marketing Consulting',
  'Information Technology Consulting',
  'Financial Advisory Services',
  'Strategy Consulting',
  'Sales Consulting',
  'Human Resources Consulting',
  'Change Management Consulting',
  'Supply Chain Consulting',
  'Procurement Consulting',
  'Risk Management Consulting',
  'Compliance Consulting',
  'Data Analytics Consulting',
  'Business Coaching',
]

function baseSpec(industries: string[]) {
  return {
    job_titles: [],
    job_titles_excluded: [],
    seniority_levels: [],
    person_countries: [],
    company_countries: [],
    company_headcount_min: 0,
    company_headcount_max: 0,
    industries,
    industries_excluded: [],
    keywords: [],
    keywords_excluded: [],
    notes: '',
  }
}

interface FakeState {
  agentRuns: Record<string, unknown>[]
  /** Rows inserted into sourcing_runs, and the patches later applied to each. */
  sourcingRuns: Record<string, unknown>[]
  sourcingRunPatches: Record<string, unknown>[]
}

function makeSupabase(spec: unknown, state: FakeState): SupabaseClient {
  const strategyDocuments = [
    {
      id: 'doc-1',
      organisation_id: ORG,
      document_type: 'icp',
      status: 'active',
      client_approval_status: 'approved',
      content: {},
      icp_filter_spec: spec,
    },
  ]

  const integrationsRegistry = [
    {
      capability: 'can_source_prospects',
      is_active: true,
      tool_name: 'apollo',
      api_handler_ref: 'adapter-apollo',
    },
  ]

  const tables: Record<string, Record<string, unknown>[]> = {
    strategy_documents: strategyDocuments,
    integrations_registry: integrationsRegistry,
  }

  let nextRunId = 0

  function unimplemented(method: string) {
    return () => {
      throw new Error(
        `fake supabase does not implement ${method}(). The code under test reached a ` +
        'query shape this fake cannot honour, so any result it returned would be a lie.'
      )
    }
  }

  return {
    from(table: string) {
      const filters: [string, unknown][] = []

      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters.push([column, value])
          return chain
        },
        single: async () => {
          const rows = (tables[table] ?? []).filter(row =>
            filters.every(([column, value]) => row[column] === value),
          )
          if (rows.length !== 1) {
            return { data: null, error: { message: `no single row for ${table}` } }
          }
          return { data: rows[0], error: null }
        },
        insert: (row: Record<string, unknown>) => {
          // sourcing_runs is inserted then READ BACK for its id, so it needs a chain
          // rather than a bare promise. agent_runs is awaited directly. Both are recorded,
          // because a fake that accepts a write without recording it cannot test the write.
          if (table === 'sourcing_runs') {
            const id = `run-${++nextRunId}`
            state.sourcingRuns.push({ id, ...row })
            const inserted: Record<string, unknown> = {
              select: () => inserted,
              single: async () => ({ data: { id }, error: null }),
            }
            return inserted
          }
          if (table !== 'agent_runs') {
            throw new Error(`fake supabase: unexpected insert into ${table}`)
          }
          state.agentRuns.push(row)
          return Promise.resolve({ error: null })
        },
        update: (patch: Record<string, unknown>) => {
          if (table !== 'sourcing_runs') {
            throw new Error(`fake supabase: unexpected update on ${table}`)
          }
          // The patch is recorded WITH its filter, so a test can tell a terminal write on
          // the right row from one on the wrong row. Returning a bare success would make
          // both look identical.
          const updated: Record<string, unknown> = {
            eq: (column: string, value: unknown) => {
              state.sourcingRunPatches.push({ ...patch, __where: { [column]: value } })
              return Promise.resolve({ error: null })
            },
          }
          return updated
        },
        // Everything the orchestrator could reach but must not in these tests.
        is: unimplemented('is'),
        not: unimplemented('not'),
        in: unimplemented('in'),
        or: unimplemented('or'),
        limit: unimplemented('limit'),
        order: unimplemented('order'),
        delete: unimplemented('delete'),
        maybeSingle: unimplemented('maybeSingle'),
      }

      return chain
    },
  } as unknown as SupabaseClient
}

// A test fake is the one legitimate place to assert the ServiceRoleClient brand: the fake
// is not a real client at all, so no key can be checked. Declared once here rather than
// cast at each call, so the assertion stays visible and countable.
const brandedFake = (c: unknown) => c as import('@/lib/supabase/service-role').ServiceRoleClient

describe('APOLLO_TARGETED_INDUSTRIES', () => {
  it('is non-empty', () => {
    // An empty list would make every intersection empty and refuse every run.
    expect(APOLLO_TARGETED_INDUSTRIES.length).toBeGreaterThan(0)
  })

  it('contains only canonical industry names', () => {
    const canonical = new Set<string>(CANONICAL_INDUSTRIES)
    for (const industry of APOLLO_TARGETED_INDUSTRIES) {
      expect(canonical.has(industry)).toBe(true)
    }
  })

  it('covers every industry in the live client-zero spec', () => {
    // Regression guard with teeth: the one approved ICP in production must not be
    // refused by the gate, and must not trip the partial-coverage warning either.
    const targeted = new Set<string>(APOLLO_TARGETED_INDUSTRIES.map(i => i.toLowerCase()))
    const uncovered = CLIENT_ZERO_INDUSTRIES.filter(i => !targeted.has(i.toLowerCase()))
    expect(uncovered).toEqual([])
  })

  it('hands the handler a copy, not the module constant instance', () => {
    // Same reason supported_fields is copied: one caller mutating a shared array
    // would change what every later client in the process is measured against.
    expect(apolloHandler.targeted_industries).not.toBe(APOLLO_TARGETED_INDUSTRIES)
    expect(apolloHandler.targeted_industries).toEqual([...APOLLO_TARGETED_INDUSTRIES])
  })
})

describe('Sourcing orchestrator: industry reachability gate', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // If the gate lets a non-intersecting spec through, the handler runs and calls
    // Apollo. Spying here is what proves the refusal happens BEFORE the search.
    fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async () => {
      throw new Error('fetch must not be called: the gate should have refused first')
    })
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('refuses the run when no spec industry is targeted by the handler query', async () => {
    const state: FakeState = { agentRuns: [], sourcingRuns: [], sourcingRunPatches: [] }
    const supabase = makeSupabase(
      baseSpec(['Primary and Secondary Education', 'Higher Education']),
      state,
    )

    const result = await runSourcing(brandedFake(supabase), ORG, 'operator_manual', 10)

    expect(result.error).toBeDefined()
    expect(result.error).toContain('Sourcing refused')
    // Names what was expected and what the handler actually goes looking for.
    expect(result.error).toContain('Primary and Secondary Education')
    expect(result.error).toContain('Management Consulting')
    expect(result.candidates_sourced).toBe(0)
    expect(result.candidates_qualified).toBe(0)

    // Refused before the search: Apollo was never called.
    expect(fetchSpy).not.toHaveBeenCalled()

    // And the refusal is recorded, not just returned.
    expect(state.agentRuns).toHaveLength(1)
    expect(state.agentRuns[0].status).toBe('failed')
    expect(String(state.agentRuns[0].error_message)).toContain('Sourcing refused')
  })

  it('allows the run when at least one spec industry is targeted', async () => {
    const state: FakeState = { agentRuns: [], sourcingRuns: [], sourcingRunPatches: [] }
    const supabase = makeSupabase(baseSpec(CLIENT_ZERO_INDUSTRIES), state)

    const result = await runSourcing(brandedFake(supabase), ORG, 'operator_manual', 10)

    // It still fails, but at the SEARCH step and for a different reason, which is
    // what proves the gate passed rather than that nothing was checked.
    expect(result.error).toBeDefined()
    expect(result.error).not.toContain('Sourcing refused')
    expect(result.error).toContain('APOLLO_API_KEY')
  })

  it('reports the unreachable industries by name on partial coverage', async () => {
    // Not a refusal, and that is the point: the run can still return prospects in
    // the industries that ARE targeted. Without this line the difference between
    // "searched for the 15 you named" and "searched for 12 of them" is invisible.
    const warn = vi.spyOn(logger, 'warn')
    const state: FakeState = { agentRuns: [], sourcingRuns: [], sourcingRunPatches: [] }
    const supabase = makeSupabase(
      baseSpec(['Management Consulting', 'Higher Education', 'Agriculture']),
      state,
    )

    await runSourcing(brandedFake(supabase), ORG, 'operator_manual', 10)

    const partial = warn.mock.calls.find(c =>
      String(c[0]).includes('not targeted by the handler query'),
    )
    expect(partial).toBeDefined()

    const payload = partial![1] as Record<string, unknown>
    expect(payload.unreachable_count).toBe(2)
    expect(payload.reachable_count).toBe(1)
    expect(payload.unreachable_industries).toEqual(['Higher Education', 'Agriculture'])
  })

  it('says out loud when the spec constrains no industry at all', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const state: FakeState = { agentRuns: [], sourcingRuns: [], sourcingRunPatches: [] }
    const supabase = makeSupabase(baseSpec([]), state)

    await runSourcing(brandedFake(supabase), ORG, 'operator_manual', 10)

    const unchecked = warn.mock.calls.find(c =>
      String(c[0]).includes('ICP names no industries'),
    )
    expect(unchecked).toBeDefined()
    expect((unchecked![1] as Record<string, unknown>).handler_targets).toEqual(
      [...APOLLO_TARGETED_INDUSTRIES],
    )
  })

  it('allows the run on partial coverage, and does not refuse', async () => {
    const state: FakeState = { agentRuns: [], sourcingRuns: [], sourcingRunPatches: [] }
    const supabase = makeSupabase(
      // One targeted, one not.
      baseSpec(['Management Consulting', 'Higher Education']),
      state,
    )

    const result = await runSourcing(brandedFake(supabase), ORG, 'operator_manual', 10)

    expect(result.error).not.toContain('Sourcing refused')
    expect(result.error).toContain('APOLLO_API_KEY')
  })

  it('does not refuse when the spec names no industries at all', async () => {
    const state: FakeState = { agentRuns: [], sourcingRuns: [], sourcingRunPatches: [] }
    const supabase = makeSupabase(baseSpec([]), state)

    const result = await runSourcing(brandedFake(supabase), ORG, 'operator_manual', 10)

    // An empty list is the spec declining to constrain industry, not a disagreement.
    // There is no intersection to be empty, so there is nothing to refuse.
    expect(result.error).not.toContain('Sourcing refused')
    expect(result.error).toContain('APOLLO_API_KEY')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE RUN RECORD
//
// These assert the two properties the batch identity depends on, and both are
// mutation-testable: delete the startSourcingRun call and the first goes red; move it
// below the ICP read and the second does.
describe('Sourcing orchestrator: the run record', () => {
  it('creates the run record BEFORE reading the ICP, so a failed run still has one', async () => {
    // No approved ICP at all, so the run dies at step 1. Nine real runs failed this way on
    // 2026-08-09 and left nothing to look at; those are exactly the runs worth seeing.
    const state: FakeState = { agentRuns: [], sourcingRuns: [], sourcingRunPatches: [] }
    const supabase = makeSupabase(null, state)
    // Remove the approved ICP the fake would otherwise return.
    const noIcp = {
      from: (table: string) =>
        table === 'strategy_documents'
          ? { select: () => noIcp.from(table), eq: () => noIcp.from(table),
              single: async () => ({ data: null, error: { message: 'no rows' } }) }
          : (supabase as unknown as { from: (t: string) => unknown }).from(table),
    }

    const result = await runSourcing(brandedFake(noIcp), ORG, 'operator_manual', 10)

    expect(result.error).toBeDefined()
    expect(state.sourcingRuns).toHaveLength(1)
    expect(state.sourcingRuns[0]).toMatchObject({
      organisation_id: ORG,
      status: 'running',
      target_batch_size: 10,
    })
  })

  it('closes the record as failed, on the row it opened', async () => {
    const state: FakeState = { agentRuns: [], sourcingRuns: [], sourcingRunPatches: [] }
    // An empty industries list, deliberately. This test is about the run record's terminal
    // write, not about industry matching, and naming a real industry here would put a
    // sector into a fixture that has no need of one.
    const supabase = makeSupabase({ industries: [] }, state)

    // No vendor key in the test environment, so the run fails at the search step.
    const result = await runSourcing(brandedFake(supabase), ORG, 'operator_manual', 10)

    expect(result.error).toBeDefined()

    const terminal = state.sourcingRunPatches.filter(p => p.status === 'failed')
    expect(terminal).toHaveLength(1)
    // On the row it opened, not on some other row. A terminal write aimed at the wrong id
    // succeeds silently and leaves the real row stuck reading 'running' forever.
    expect(terminal[0].__where).toEqual({ id: state.sourcingRuns[0].id })
    expect(terminal[0].completed_at).toEqual(expect.any(String))
  })
})
