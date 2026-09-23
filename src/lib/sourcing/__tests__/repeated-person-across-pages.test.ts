// The provider returns the same person on two pages, and the run must survive it.
//
// ─── WHAT THIS EXERCISES, AND WHY IT IS END TO END ────────────────────────────
//
// Only `fetch` and the database are faked. The real handler pages, the real dedupe runs,
// the real write loop writes. That matters because the defect lived in the SEAM between
// those three and not inside any of them: dedupe reads the database before the write loop
// touches it, so two copies of a person nobody has yet are both told, correctly, that they
// are new.
//
// ─── THE DATABASE FAKE ENFORCES THE UNIQUE INDEX ──────────────────────────────
//
// prospects carries a unique index on (organisation_id, source_person_key). A fake that
// accepted every insert would make this test pass in a world where the in-batch collapse
// had been deleted, which is the exact failure CLAUDE.md describes under "A fake that does
// not honour a filter cannot test that filter". So the fake raises 23505 the way Postgres
// does, and the mutation test below depends on it.
//
// Measured origin, organisation 0ed34697 on 2026-09-21: a run asking for 200 spanned two
// pages of 100, apollo:676ef86aa5bcbe000107a6a7 came back on both, was written as the 34th
// row and presented again as the 35th candidate. The run died there with 34 rows kept and
// the provider call for all 200 records already paid.
//
// ─── WHICH MECHANISM CATCHES IT MOVED WHEN SOURCING BECAME WINDOWED ──────────
//
// Read this before changing an assertion here. The OUTCOME is unchanged and still asserted:
// the repeated person is written exactly once, 199 distinct people land, the run survives.
// What changed is which guard does it.
//
// A run now reads the provider in windows of 100 records, one window per handler call, so
// the two pages of this fixture are two SEPARATE windows. Window one's writes are committed
// before window two asks the database anything, so the repeat is caught by step 6's database
// check as `duplicate_person_key` rather than by step 5.5's in-batch collapse as
// `duplicate_in_batch_person_key`. It costs the two dedupe queries that candidate used to be
// spared, and the cursor now advances twice rather than once.
//
// THE IN-BATCH COLLAPSE IS STILL LOAD-BEARING and still has a test below: it covers a person
// repeated WITHIN one window, which is the only repeat step 6 cannot see, because every
// candidate in one window is asked about before any of them is written. Windowing narrowed its
// job; it did not remove it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runSourcing } from '@/lib/sourcing/orchestrator'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'

const ORG = '11111111-2222-3333-4444-555555555555'

// The person the provider repeats. Named after the real one so a grep from the incident
// lands here.
const REPEATED_PERSON_ID = '676ef86aa5bcbe000107a6a7'
const REPEATED_KEY = `apollo:${REPEATED_PERSON_ID}`

function baseSpec() {
  return {
    // REQUIRED. The handler refuses a spec with no job titles, because searching without
    // them returns every employee of every matching company. An empty list here made all
    // three tests fail at the search step, which is the fixture being wrong rather than
    // the code, and is why the positive control on pagesServed is in the first test.
    job_titles: ['Managing Director'],
    job_titles_excluded: [],
    seniority_levels: [],
    // BOTH axes, also required: constraining only the company returns its employees
    // wherever they live, which is the exposure that mailed two excluded-country
    // prospects. ADR-032.
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
  cursorUpserts: Record<string, unknown>[]
  prospects: ProspectRow[]
  /** Every dedupe read against prospects, so the query count can be asserted. */
  prospectSelects: number
}

function makeSupabase(state: FakeState): SupabaseClient {
  const tables: Record<string, Record<string, unknown>[]> = {
    strategy_documents: [
      {
        id: 'doc-1',
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
        `fake supabase does not implement ${method}(). The code under test reached a ` +
        'query shape this fake cannot honour, so any result it returned would be a lie.',
      )
    }
  }

  return {
    from(table: string) {
      // Honoured, not merely recorded. eq() narrows, not() excludes. A filter this fake
      // ignored would be a filter this test cannot prove exists.
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
            // `.not('suppressed', 'is', true)` keeps false AND null, which is what
            // Postgres does and what the dedupe relies on for never-suppressed rows.
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
            // No row yet: this client starts at offset 0.
            return { data: null, error: null }
          }
          if (table !== 'prospects') {
            throw new Error(
              `fake supabase does not implement maybeSingle() for ${table}.`,
            )
          }
          state.prospectSelects++
          const rows = matchingProspects()
          return { data: rows[0] ?? null, error: null }
        },
        // The empty-shell guard (step 7.5) reads back with order().limit() and awaits the
        // builder directly rather than calling a terminal method.
        then: (resolve: (value: { data: ProspectRow[] | null; error: null }) => unknown) => {
          if (table !== 'prospects') {
            throw new Error(`fake supabase: unexpected awaited builder on ${table}`)
          }
          state.prospectSelects++
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
            const candidate = row as unknown as ProspectRow
            // idx_prospects_source_person_key: UNIQUE (organisation_id, source_person_key)
            // WHERE source_person_key IS NOT NULL. Reproduced, error code included, so a
            // run that tries to write the same person twice fails here exactly as
            // production did.
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
    prospects: [],
    prospectSelects: 0,
  }
}

/** One provider person, in the shape the handler reads. */
function person(id: string) {
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
 * Two pages of 100, with ONE person appearing on both.
 *
 * Page 1 holds people p000..p099 with the repeated person at the end. Page 2 holds
 * p100..p198 plus the repeated person again, at the front, which is what unstable page
 * ordering between calls looks like from our side.
 */
function twoPagesWithOneRepeat() {
  const pageOne = [
    ...Array.from({ length: 99 }, (_, i) => person(`p${String(i).padStart(3, '0')}`)),
    person(REPEATED_PERSON_ID),
  ]
  const pageTwo = [
    person(REPEATED_PERSON_ID),
    ...Array.from({ length: 99 }, (_, i) => person(`p${String(100 + i).padStart(3, '0')}`)),
  ]
  return { pageOne, pageTwo }
}

/**
 * The terminal patch on the sourcing_runs row.
 *
 * Selected BY STATUS rather than by index: the orchestrator also patches the row earlier
 * to attach the ICP document, so patch[0] is that attach and not the completion. Indexing
 * found the wrong row and the assertion failed for a reason that had nothing to do with
 * what it was testing.
 */
function completionPatch(state: FakeState) {
  const terminal = state.sourcingRunPatches.filter(
    p => p.status === 'completed' || p.status === 'failed',
  )
  expect(terminal).toHaveLength(1)
  return terminal[0] as unknown as {
    status: string
    candidates_returned: number
    prospects_written: number
    dropped_by_reason: Record<string, number>
  }
}

const brandedFake = (c: unknown) => c as ServiceRoleClient

describe('Sourcing: the provider returns the same person on two pages', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>
  let pagesServed: number[]

  beforeEach(() => {
    vi.stubEnv('APOLLO_API_KEY', 'test-key-not-a-real-credential')
    const { pageOne, pageTwo } = twoPagesWithOneRepeat()
    pagesServed = []

    fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy.mockImplementation(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { page: number }
      pagesServed.push(body.page)
      const people = body.page === 1 ? pageOne : body.page === 2 ? pageTwo : []
      return {
        ok: true,
        status: 200,
        json: async () => ({ people, total_entries: 200 }),
        text: async () => '',
        headers: { get: () => null },
      } as unknown as Response
    })
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    vi.unstubAllEnvs()
  })

  it('writes the repeated person once and the run completes', async () => {
    const state = freshState()
    const supabase = makeSupabase(state)

    const result = await runSourcing(brandedFake(supabase), ORG, 'operator_manual', 200)

    // POSITIVE CONTROL ON THE FIXTURE: if the handler only ever fetched one page, the
    // repeat would never be presented and this test would pass while proving nothing.
    expect(pagesServed).toContain(1)
    expect(pagesServed).toContain(2)

    // THE RUN SURVIVES. Before the in-batch collapse this threw at the write step.
    expect(result.error).toBeUndefined()

    // THE PERSON IS WRITTEN EXACTLY ONCE.
    const written = state.prospects.filter(p => p.source_person_key === REPEATED_KEY)
    expect(written).toHaveLength(1)

    // AND EVERYONE ELSE STILL LANDS. 199 distinct people across the two pages.
    expect(state.prospects).toHaveLength(199)
    expect(new Set(state.prospects.map(p => p.source_person_key)).size).toBe(199)

    // The run record says the batch repeated someone, rather than looking like a short
    // page. dropped_by_reason lives on the sourcing_runs row, not on the returned result.
    const completion = completionPatch(state)
    expect(completion.status).toBe('completed')
    // BY THE DATABASE CHECK, not the in-batch collapse, because the two pages are now two
    // windows. See the note at the top of this file. The drop is still counted and still
    // visible in the run record, which is what the assertion is for.
    expect(completion.dropped_by_reason.duplicate_person_key).toBe(1)
    expect(completion.dropped_by_reason.duplicate_in_batch_person_key).toBeUndefined()
    expect(completion.candidates_returned).toBe(200)
    expect(completion.prospects_written).toBe(199)

    // The provider's count is preserved: 200 records arrived, 199 distinct people.
    expect(result.candidates_sourced).toBe(200)
    expect(result.candidates_qualified).toBe(199)

    // The cursor advanced by records READ, not by people written, and ONCE PER WINDOW. Two
    // windows of 100, banked as each one finished. A single advance at the end is the shape
    // that lost everything when the platform killed a slow request: see
    // interrupted-run-resumes.test.ts.
    expect(state.cursorUpserts.map(u => u.record_offset)).toEqual([100, 200])
  })

  it('does not pay dedupe queries for the redundant copy', async () => {
    // The collapse runs BEFORE step 6, so the repeated candidate costs no round trips.
    // Dedupe issues up to 6 queries per candidate; the write-loop skip alternative would
    // have spent 6 on a candidate already known to be redundant.
    const state = freshState()
    const supabase = makeSupabase(state)

    await runSourcing(brandedFake(supabase), ORG, 'operator_manual', 200)

    // Candidates carry a person key only (no email, no LinkedIn at sourcing time), so
    // dedupe asks 2 questions each: suppressed-by-key, then duplicate-by-key.
    //
    // 200 candidates, not 199, and that is the cost of windowing rather than a regression: the
    // repeated person is in a different window from its twin, so it reaches step 6 and is asked
    // about like everybody else. Plus the single empty-shell read-back in step 7.5.
    //
    // The collapse still saves the queries it was built to save, for a repeat inside ONE
    // window, which the test below covers.
    expect(state.prospectSelects).toBe(200 * 2 + 1)
  })

  it('still drops a person this organisation already has', async () => {
    // The in-batch collapse must not shadow the database check. One of the two pages'
    // people is already in the table, and must be dropped as a database duplicate rather
    // than written a second time.
    const state = freshState()
    state.prospects.push({
      organisation_id: ORG,
      source_person_key: 'apollo:p005',
      first_name: 'Already',
      company_name: 'Here',
      suppressed: false,
    })
    const supabase = makeSupabase(state)

    const result = await runSourcing(brandedFake(supabase), ORG, 'operator_manual', 200)

    expect(result.error).toBeUndefined()
    expect(state.prospects.filter(p => p.source_person_key === 'apollo:p005')).toHaveLength(1)
    const dropped = completionPatch(state).dropped_by_reason
    // TWO now, not one and one: the seeded person AND the cross-window repeat are both database
    // duplicates. Under a single un-windowed call the repeat was an in-batch drop instead.
    expect(dropped.duplicate_person_key).toBe(2)
    expect(dropped.duplicate_in_batch_person_key).toBeUndefined()
    // 199 distinct, one of them already present, so 198 new rows on top of the seeded one.
    expect(state.prospects).toHaveLength(199)
  })

  // ── THE IN-BATCH COLLAPSE, ON THE REPEAT IT IS STILL THE ONLY GUARD FOR ────
  //
  // Windowing moved the cross-page case to the database check, which would leave step 5.5
  // with no failing test and make it look like dead code the next person could delete. This
  // is the case it is still the ONLY guard for: the same person twice inside ONE window.
  // Step 6 cannot see it, because every candidate in a window is asked about before any of
  // them is written, so both copies are correctly told they are new and the write loop hits
  // the unique index on the second.
  it('collapses a person repeated INSIDE one window, which step 6 cannot see', async () => {
    const state = freshState()
    const supabase = makeSupabase(state)

    // One window of 100 holding the repeat twice, so the whole batch is a single window and
    // the database check has had no chance to learn about anyone.
    const onePageWithInternalRepeat = [
      ...Array.from({ length: 98 }, (_, i) => person(`q${String(i).padStart(3, '0')}`)),
      person(REPEATED_PERSON_ID),
      person(REPEATED_PERSON_ID),
    ]
    fetchSpy.mockImplementation(async (_url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as { page: number }
      pagesServed.push(body.page)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          people: body.page === 1 ? onePageWithInternalRepeat : [],
          total_entries: 100,
        }),
        text: async () => '',
        headers: { get: () => null },
      } as unknown as Response
    })

    const result = await runSourcing(brandedFake(supabase), ORG, 'operator_manual', 100)

    // POSITIVE CONTROL: exactly one window, so nothing here can be the database check.
    expect(pagesServed).toEqual([1])

    expect(result.error).toBeUndefined()
    expect(state.prospects.filter(p => p.source_person_key === REPEATED_KEY)).toHaveLength(1)
    expect(state.prospects).toHaveLength(99)

    // COUNTED AS AN IN-BATCH DROP. Deleting removeInBatchDuplicates makes the run die at the
    // write step on 23505, exactly as production did on 2026-09-21.
    const dropped = completionPatch(state).dropped_by_reason
    expect(dropped.duplicate_in_batch_person_key).toBe(1)
    expect(dropped.duplicate_person_key).toBeUndefined()
  })
})
