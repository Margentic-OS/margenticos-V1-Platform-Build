// A sourcing run stopped by its own time limit must lose nothing and duplicate nothing when
// the operator presses again.
//
// ─── WHAT THIS EXERCISES, AND WHY IT IS END TO END ────────────────────────────
//
// Only `fetch`, the clock and the database are faked. The real handler pages, the real cursor
// reads and advances, the real dedupe runs, the real write loop writes. The property being
// proved lives in the SEAM between those: it is about WHEN the cursor is written relative to
// the prospects, and nothing inside any one of them can show that.
//
// ─── THE DEFECT THIS IS ABOUT ─────────────────────────────────────────────────
//
// The run used to advance the cursor ONCE, after writing the whole batch. A request killed by
// the platform timeout therefore kept its prospects and lost its position, so the next press
// re-read the same records, dedupe dropped them all, and the run produced nothing new. At a
// per-candidate cost measured between 58 ms and 3,535 ms (production sourcing_runs, 2026-09-23)
// a 500-prospect batch does not fit a 240s budget on a slow day, so that press could fail the
// same way indefinitely. Progress was not monotonic.
//
// ─── THE DATABASE FAKE PERSISTS ACROSS BOTH RUNS ──────────────────────────────
//
// One FakeState is shared by run one and run two, because "does the second run duplicate the
// first run's prospects" is meaningless against a fresh table. The fake also enforces the
// unique index on (organisation_id, source_person_key) the way Postgres does, so a run that
// tried to write the same person twice would fail here exactly as production did on
// 2026-09-21, rather than passing quietly.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runSourcing } from '@/lib/sourcing/orchestrator'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import { SOURCING_RUNTIME_BUDGET_MS } from '@/lib/sourcing/window-budget'

const ORG = '11111111-2222-3333-4444-555555555555'
const ICP_DOC = 'doc-1'

/** Total records the fake provider holds. Three windows of 100. */
const PROVIDER_TOTAL = 300

function baseSpec() {
  return {
    // REQUIRED: the handler refuses a spec with no job titles, because searching without them
    // returns every employee of every matching company.
    job_titles: ['Managing Director'],
    job_titles_excluded: [],
    seniority_levels: [],
    // BOTH axes, also required. ADR-032.
    person_countries: ['GB'],
    company_countries: ['GB'],
    company_headcount_min: 0,
    company_headcount_max: 0,
    industries: ['Management Consulting'],
    industries_excluded: [],
    keywords: [],
    keywords_excluded: [],
    notes: '',
  }
}

interface ProspectRow {
  organisation_id: string
  source_person_key: string | null
  first_name: string | null
  company_name: string | null
  suppressed?: boolean | null
  linkedin_url_normalised?: string | null
  email?: string | null
  sourcing_review_status?: string | null
  [key: string]: unknown
}

interface FakeState {
  agentRuns: Record<string, unknown>[]
  sourcingRuns: Record<string, unknown>[]
  sourcingRunPatches: Record<string, unknown>[]
  /** Every cursor write, in order. The sequence IS the thing under test. */
  cursorUpserts: Record<string, unknown>[]
  /** The stored cursor row, or null when this client has never been sourced. */
  cursorRow: { organisation_id: string; icp_document_id: string | null; record_offset: number } | null
  prospects: ProspectRow[]
  /** Fails the Nth prospect insert of the process, to simulate a hard mid-window death. */
  failInsertAfter: number | null
  insertsAttempted: number
}

function makeSupabase(state: FakeState): SupabaseClient {
  const tables: Record<string, Record<string, unknown>[]> = {
    strategy_documents: [
      {
        id: ICP_DOC,
        organisation_id: ORG,
        document_type: 'icp',
        status: 'active',
        content: {},
        icp_filter_spec: baseSpec(),
      },
    ],
    integrations_registry: [
      {
        capability: 'can_source_prospects',
        is_active: true,
        tool_name: 'apollo',
        api_handler_ref: 'adapter-apollo',
      },
    ],
  }

  let nextRunId = 0

  function unimplemented(method: string) {
    return () => {
      throw new Error(
        `fake supabase does not implement ${method}(). The code under test reached a query ` +
        'shape this fake cannot honour, so any result it returned would be a lie.',
      )
    }
  }

  return {
    from(table: string) {
      // HONOURED, not merely recorded. A filter this fake ignored would be a filter this test
      // cannot prove exists. See CLAUDE.md, "A fake that does not honour a filter cannot test
      // that filter".
      const eqFilters: [string, unknown][] = []
      const notFilters: [string, string, unknown][] = []
      let limitN: number | null = null

      function matchingProspects(): ProspectRow[] {
        return state.prospects.filter(row => {
          for (const [column, value] of eqFilters) {
            if (row[column] !== value) return false
          }
          for (const [column, operator, value] of notFilters) {
            if (operator !== 'is') {
              throw new Error(`fake supabase: not() operator '${operator}' not implemented`)
            }
            // `.not('suppressed', 'is', true)` keeps false AND null, as Postgres does.
            if (row[column] === value) return false
          }
          return true
        })
      }

      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          eqFilters.push([column, value])
          return chain
        },
        not: (column: string, operator: string, value: unknown) => {
          notFilters.push([column, operator, value])
          return chain
        },
        order: () => chain,
        limit: (n: number) => {
          limitN = n
          return chain
        },
        single: async () => {
          const rows = (tables[table] ?? []).filter(row =>
            eqFilters.every(([column, value]) => row[column] === value),
          )
          if (rows.length !== 1) {
            return { data: null, error: { message: `no single row for ${table}` } }
          }
          return { data: rows[0], error: null }
        },
        maybeSingle: async () => {
          if (table === 'sourcing_cursors') {
            // THE STORED POSITION, NOT ALWAYS NULL. A fake that answered null here would hand
            // every run offset 0 and make a resume test impossible to write.
            return { data: state.cursorRow, error: null }
          }
          if (table !== 'prospects') {
            throw new Error(`fake supabase does not implement maybeSingle() for ${table}.`)
          }
          const rows = matchingProspects()
          return { data: rows[0] ?? null, error: null }
        },
        // The empty-shell guard reads back with order().limit() and awaits the builder.
        then: (resolve: (value: { data: ProspectRow[] | null; error: null }) => unknown) => {
          if (table !== 'prospects') {
            throw new Error(`fake supabase: unexpected awaited builder on ${table}`)
          }
          const rows = matchingProspects()
          return Promise.resolve({
            data: limitN === null ? rows : rows.slice(0, limitN),
            error: null,
          }).then(resolve)
        },
        insert: (row: Record<string, unknown>) => {
          if (table === 'sourcing_runs') {
            const id = `run-${++nextRunId}`
            state.sourcingRuns.push({ id, ...row })
            const inserted: Record<string, unknown> = {
              select: () => inserted,
              single: async () => ({ data: { id }, error: null }),
            }
            return inserted
          }
          if (table === 'agent_runs') {
            state.agentRuns.push(row)
            return Promise.resolve({ error: null })
          }
          if (table === 'prospects') {
            state.insertsAttempted++
            // A HARD DEATH PARTWAY THROUGH A WINDOW, on demand. Not a duplicate-key error:
            // this stands for the platform killing the request, which is the case the cursor
            // ordering exists for.
            if (state.failInsertAfter !== null && state.insertsAttempted > state.failInsertAfter) {
              return Promise.resolve({
                error: { code: '57014', message: 'simulated interruption: request terminated' },
              })
            }
            const candidate = row as unknown as ProspectRow
            // idx_prospects_source_person_key: UNIQUE (organisation_id, source_person_key)
            // WHERE source_person_key IS NOT NULL. Reproduced, error code included.
            const clash =
              candidate.source_person_key !== null &&
              candidate.source_person_key !== undefined &&
              state.prospects.some(
                existing =>
                  existing.organisation_id === candidate.organisation_id &&
                  existing.source_person_key === candidate.source_person_key,
              )
            if (clash) {
              return Promise.resolve({
                error: {
                  code: '23505',
                  message:
                    'duplicate key value violates unique constraint ' +
                    '"idx_prospects_source_person_key"',
                  details:
                    `Key (organisation_id, source_person_key)=(${candidate.organisation_id}, ` +
                    `${candidate.source_person_key}) already exists.`,
                },
              })
            }
            state.prospects.push(candidate)
            return Promise.resolve({ error: null })
          }
          throw new Error(`fake supabase: unexpected insert into ${table}`)
        },
        update: (patch: Record<string, unknown>) => {
          if (table !== 'sourcing_runs') {
            throw new Error(`fake supabase: unexpected update on ${table}`)
          }
          const updated: Record<string, unknown> = {
            eq: (column: string, value: unknown) => {
              state.sourcingRunPatches.push({ ...patch, __where: { [column]: value } })
              return Promise.resolve({ error: null })
            },
          }
          return updated
        },
        upsert: async (row: Record<string, unknown>) => {
          if (table !== 'sourcing_cursors') {
            throw new Error(`fake supabase: unexpected upsert into ${table}`)
          }
          state.cursorUpserts.push(row)
          // PERSISTED, so the next run reads what this one wrote. An upsert the fake recorded
          // but did not store would make every resume start from zero and the test would pass
          // while proving the opposite.
          state.cursorRow = {
            organisation_id: row.organisation_id as string,
            icp_document_id: (row.icp_document_id as string | null) ?? null,
            record_offset: row.record_offset as number,
          }
          return { error: null }
        },

        is: unimplemented('is'),
        in: unimplemented('in'),
        or: unimplemented('or'),
        delete: unimplemented('delete'),
      }

      return chain
    },
  } as unknown as SupabaseClient
}

function freshState(): FakeState {
  return {
    agentRuns: [],
    sourcingRuns: [],
    sourcingRunPatches: [],
    cursorUpserts: [],
    cursorRow: null,
    prospects: [],
    failInsertAfter: null,
    insertsAttempted: 0,
  }
}

/** One provider person, in the shape the handler reads. Identity is its index. */
function person(index: number) {
  const id = `p${String(index).padStart(4, '0')}`
  return {
    id,
    first_name: `First${id}`,
    last_name: 'Surname',
    title: 'Managing Director',
    has_email: true,
    organization: { name: `Company ${id}` },
  }
}

/**
 * A clock the test drives, and the per-page cost it charges.
 *
 * The orchestrator takes `clock` for exactly this: the budget is 240 real seconds and the
 * branch under test is what happens when it runs out. Charging the time inside the fetch fake
 * rather than incrementing on every read means the elapsed total tracks PROVIDER CALLS, which
 * is what the real cost is dominated by.
 */
function makeClock() {
  let nowMs = 1_000_000
  return {
    now: () => nowMs,
    charge: (ms: number) => { nowMs += ms },
  }
}

const brandedFake = (c: unknown) => c as ServiceRoleClient

describe('a sourcing run interrupted by its own time limit', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  let pagesServed: number[]
  let clock: ReturnType<typeof makeClock>
  let msPerPage: number

  beforeEach(() => {
    vi.stubEnv('APOLLO_API_KEY', 'test-key-not-a-real-credential')
    pagesServed = []
    clock = makeClock()
    msPerPage = 0

    fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { page: number; per_page: number }
      pagesServed.push(body.page)
      clock.charge(msPerPage)

      // Records are numbered globally, so a person's identity says which page they came from
      // and a duplicate across runs is visible by key alone.
      const start = (body.page - 1) * body.per_page
      const people = Array.from(
        { length: Math.max(0, Math.min(body.per_page, PROVIDER_TOTAL - start)) },
        (_, i) => person(start + i),
      )
      return {
        ok: true,
        status: 200,
        json: async () => ({ people, total_entries: PROVIDER_TOTAL }),
        text: async () => '',
        headers: { get: () => null },
      } as unknown as Response
    })
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    vi.unstubAllEnvs()
  })

  it('banks the window it finished, reports what remains, and resumes without re-reading or duplicating', async () => {
    const state = freshState()
    const supabase = makeSupabase(state)

    // ── RUN ONE: slow enough that only one window fits ──────────────────────
    //
    // 150s a window against a 240s budget. The prediction for a second window is
    // 150s x 1.5 = 225s and 150 + 225 > 240, so it stops after one. This is the real
    // 2026-09-15 rate (3,535 ms a candidate) scaled to a 100-record window.
    msPerPage = 150_000
    const first = await runSourcing(brandedFake(supabase), ORG, 'operator_manual', PROVIDER_TOTAL, {
      clock: clock.now,
      budgetMs: SOURCING_RUNTIME_BUDGET_MS,
    })

    // POSITIVE CONTROL ON THE FIXTURE: the run really did call the provider, and really did
    // stop at one window rather than never starting.
    expect(pagesServed).toEqual([1])

    expect(first.error).toBeUndefined()
    expect(first.windows_processed).toBe(1)

    // IT LOST NOTHING. The 100 records the window read are written and the cursor says so.
    expect(state.prospects).toHaveLength(100)
    expect(first.records_consumed).toBe(100)
    expect(state.cursorUpserts).toHaveLength(1)
    expect(state.cursorUpserts[0].record_offset).toBe(100)
    // Advanced INSIDE the loop, not after it. Before this change the single advance came after
    // the whole batch, so a killed request banked nothing.
    expect(state.cursorRow?.record_offset).toBe(100)

    // IT SAYS WHAT REMAINS, AND WHY. The number and the reason both, because "sourced 100 of
    // 300" means something different when the provider has run out.
    expect(first.records_remaining).toBe(200)
    expect(first.stop_reason).toBe('budget_exhausted')
    expect(first.stop_message).toContain('200 remain')

    // ── RUN TWO: the operator presses again, on a fast day ──────────────────
    //
    // Asking for the 200 the first run REPORTED as remaining, which is the whole point of
    // reporting it. Asking for 300 again would also work, and would stop at provider_exhausted
    // with 100 unfillable, which is a different assertion and has its own test below.
    pagesServed = []
    msPerPage = 5_000
    const second = await runSourcing(brandedFake(supabase), ORG, 'operator_manual', first.records_remaining!, {
      clock: clock.now,
      budgetMs: SOURCING_RUNTIME_BUDGET_MS,
    })

    expect(second.error).toBeUndefined()

    // IT DID NOT RE-READ. Page 1 is never requested again: the run resumes at record 100,
    // which is page 2. Without the per-window advance in run one this would start at page 1.
    expect(pagesServed).not.toContain(1)
    expect(pagesServed).toEqual([2, 3])

    // IT DID NOT DUPLICATE. 300 distinct people for 300 records, across two runs.
    expect(state.prospects).toHaveLength(300)
    const keys = state.prospects.map(p => p.source_person_key)
    expect(new Set(keys).size).toBe(300)

    // AND IT FINISHED. The remaining 200 were read, and the cursor reached the end.
    expect(second.records_consumed).toBe(200)
    expect(second.records_remaining).toBe(0)
    expect(second.stop_reason).toBe('target_met')
    expect(state.cursorRow?.record_offset).toBe(300)
  })

  it('keeps the finished window when a LATER window dies mid-write, and still duplicates nothing', async () => {
    // The harder interruption: not a clean stop at the budget, but the request dying inside a
    // window. Window one completes; window two is killed after 30 of its inserts. What must
    // survive is window one's cursor advance, and window two's partial writes must not be
    // written twice on the resume.
    const state = freshState()
    const supabase = makeSupabase(state)

    msPerPage = 5_000
    state.failInsertAfter = 130

    const failed = await runSourcing(brandedFake(supabase), ORG, 'operator_manual', PROVIDER_TOTAL, {
      clock: clock.now,
      budgetMs: SOURCING_RUNTIME_BUDGET_MS,
    })

    // The run reports the failure rather than a quiet short batch.
    expect(failed.error).toBeDefined()

    // WINDOW ONE IS BANKED. Its cursor advance happened before window two ever opened, which
    // is the ordering this test exists for.
    expect(state.cursorRow?.record_offset).toBe(100)
    expect(state.cursorUpserts.map(u => u.record_offset)).toEqual([100])

    // WINDOW TWO'S PARTIAL WRITES SURVIVE TOO. They are real rows and the provider call that
    // produced them is paid for; throwing them away would be the expensive direction.
    expect(state.prospects).toHaveLength(130)

    // THE FAILURE REPORTS PARTIAL PROGRESS, not zero. 130 rows exist and point at this run.
    expect(failed.candidates_qualified).toBe(130)

    // ── THE RESUME ─────────────────────────────────────────────────────────
    state.failInsertAfter = null
    pagesServed = []
    const recovered = await runSourcing(brandedFake(supabase), ORG, 'operator_manual', PROVIDER_TOTAL, {
      clock: clock.now,
      budgetMs: SOURCING_RUNTIME_BUDGET_MS,
    })

    expect(recovered.error).toBeUndefined()

    // It re-reads window two, because that window's cursor advance never happened. That is the
    // conservative direction and is why dedupe stays: the 30 rows already written are dropped
    // as database duplicates rather than written again.
    expect(pagesServed).toEqual([2, 3])

    // NOTHING DUPLICATED. The unique index in the fake would have raised 23505 if the write
    // loop had tried, so this assertion is about dedupe having caught them first.
    expect(state.prospects).toHaveLength(300)
    expect(new Set(state.prospects.map(p => p.source_person_key)).size).toBe(300)
    expect(state.cursorRow?.record_offset).toBe(300)
  })

  it('stops at provider_exhausted rather than spending a call to be told again', async () => {
    // The provider holds 300 and the operator asks for 500. The third window comes back short,
    // which is the handler's only way of saying the result set has run out. A fourth window
    // would be a provider call for nothing.
    const state = freshState()
    const supabase = makeSupabase(state)

    msPerPage = 1_000
    const result = await runSourcing(brandedFake(supabase), ORG, 'operator_manual', 500, {
      clock: clock.now,
      budgetMs: SOURCING_RUNTIME_BUDGET_MS,
    })

    expect(result.error).toBeUndefined()
    expect(pagesServed).toEqual([1, 2, 3])
    expect(result.records_consumed).toBe(300)
    expect(result.stop_reason).toBe('provider_exhausted')
    // AND IT TELLS THE OPERATOR PRESSING AGAIN WILL NOT HELP, which is the opposite advice to
    // budget_exhausted. Asserted on what the message SAYS rather than on the absence of the
    // words "press again", because the message uses those words in order to rule them out.
    expect(result.stop_message).toContain('will not find any')
    expect(result.stop_message).not.toMatch(/picks up exactly where/)
  })

  it('reads all 500 in ONE press on a fast day, which is the run this was built for', async () => {
    // The goal stated plainly: 500 sourced in one go. At the fast end of the measured range
    // (58 ms a candidate, so ~6s a window) five windows cost ~30s of a 240s budget.
    const state = freshState()
    const supabase = makeSupabase(state)

    // A provider deep enough to satisfy 500, so this measures the budget and not the fixture.
    fetchSpy.mockImplementation(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { page: number; per_page: number }
      pagesServed.push(body.page)
      clock.charge(6_000)
      const start = (body.page - 1) * body.per_page
      return {
        ok: true,
        status: 200,
        json: async () => ({
          people: Array.from({ length: body.per_page }, (_, i) => person(start + i)),
          total_entries: 50_000,
        }),
        text: async () => '',
        headers: { get: () => null },
      } as unknown as Response
    })

    const result = await runSourcing(brandedFake(supabase), ORG, 'operator_manual', 500, {
      clock: clock.now,
      budgetMs: SOURCING_RUNTIME_BUDGET_MS,
    })

    expect(result.error).toBeUndefined()
    expect(result.stop_reason).toBe('target_met')
    expect(result.records_consumed).toBe(500)
    expect(result.records_remaining).toBe(0)
    expect(state.prospects).toHaveLength(500)
    // Five windows, five cursor advances, one per window and each banked as it happened.
    expect(state.cursorUpserts.map(u => u.record_offset)).toEqual([100, 200, 300, 400, 500])
  })
})
