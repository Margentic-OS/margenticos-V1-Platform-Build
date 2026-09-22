// WHAT THE SCREEN SEES DURING THE GAP BETWEEN THE TWO RESEARCH STAGES.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS PINS
//
// Research runs in two stages. Phase 1 buys the sources and writes a synthesis_batch_entries
// row in 'pending_submission' WITH A NULL batch_id. A cron sweep, every five minutes,
// gathers those rows into a batch, submits it, and much later enqueues phase 2.
//
// Progress counted the middle of that through the entries of an OPEN BATCH. An entry that
// has not been submitted has no batch, so it matched nothing: every count read zero, the
// stage read 'idle', and the whole research panel disappeared from the screen.
//
// Measured on production 2026-09-21. Phase 1 finished for 107 prospects at 18:06:17. The
// first batch was created at 18:08:01 and a second at 18:13:01, because one batch takes at
// most MAX_ENTRIES_PER_BATCH and 7 did not fit. Nothing was shown for any of it, and the
// research button still offered to research the same prospects.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE FAKE THROWS ON ANYTHING IT DOES NOT IMPLEMENT, AND THAT IS THE POINT
//
// A fake that quietly returns its chain for an unimplemented filter cannot test that
// filter: the query runs, the rows come back unfiltered, and the assertion looks like it
// is about a predicate that was never applied. Removing the predicate from the real code
// then fails nothing. This fake's proxy raises on every method it does not know, so a
// query shape it has not been taught is a loud failure rather than a silent pass.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/operator/__tests__/pipeline-progress-awaiting-submission.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// The verification backlog has its own module and its own tests. It is not what this file
// is about, and leaving it real would drag half the sourcing layer into the fake.
vi.mock('@/lib/sourcing/pending-verification', () => ({
  countPendingVerification: vi.fn(async () => 0),
}))

import { getPipelineProgress, type SweepContext } from '../pipeline-progress'

type Row = Record<string, unknown>

/** One filter the code under test asked for. Applied, never swallowed. */
type Predicate = (row: Row) => boolean

const ORG = 'org-under-test'
const OTHER_ORG = 'someone-else'

/**
 * A minimal Supabase stand-in over in-memory tables.
 *
 * Implements exactly the chain getPipelineProgress uses. Everything else raises.
 */
function fakeClient(tables: Record<string, Row[]>): SupabaseClient {
  function chain(table: string, counting: boolean) {
    const predicates: Predicate[] = []
    let limitTo: number | null = null

    const rows = () => {
      const kept = (tables[table] ?? []).filter(row => predicates.every(p => p(row)))
      return limitTo === null ? kept : kept.slice(0, limitTo)
    }

    const settle = () =>
      counting ? { count: rows().length, error: null } : { data: rows(), error: null }

    const impl: Record<string, unknown> = {
      eq: (col: string, value: unknown) => {
        predicates.push(row => row[col] === value)
        return proxy
      },
      in: (col: string, values: readonly unknown[]) => {
        predicates.push(row => values.includes(row[col]))
        return proxy
      },
      is: (col: string, value: unknown) => {
        if (value !== null) throw new Error(`fake: .is() only implements null, got ${String(value)}`)
        predicates.push(row => row[col] === null || row[col] === undefined)
        return proxy
      },
      not: (col: string, op: string, value: unknown) => {
        if (op !== 'is' || value !== null) {
          throw new Error(`fake: .not() only implements ('col','is',null), got (${op})`)
        }
        predicates.push(row => row[col] !== null && row[col] !== undefined)
        return proxy
      },
      // Ordering changes which row maybeSingle returns, so it is applied rather than ignored.
      order: (col: string, opts?: { ascending?: boolean }) => {
        const dir = opts?.ascending === false ? -1 : 1
        const base = tables[table] ?? []
        tables[table] = [...base].sort((a, b) =>
          String(a[col] ?? '') < String(b[col] ?? '') ? -dir : String(a[col] ?? '') > String(b[col] ?? '') ? dir : 0,
        )
        return proxy
      },
      limit: (n: number) => {
        limitTo = n
        return proxy
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
    }

    const proxy: Record<string, unknown> = new Proxy(impl, {
      get(target, prop: string) {
        if (prop in target) return target[prop]
        // THE WHOLE POINT. A swallowed filter is an untested filter.
        throw new Error(`fake: .${String(prop)}() on ${table} is not implemented`)
      },
    })

    return proxy
  }

  return {
    from: (table: string) => ({
      select: (_cols: string, opts?: { count?: string; head?: boolean }) =>
        chain(table, opts?.head === true),
    }),
  } as unknown as SupabaseClient
}

const NEXT_SEND = '2026-09-21T18:08:00.000Z'

const SWEEP: SweepContext = {
  lastRanAt: null,
  nextRunAt: null,
  periodMs: null,
  ratePerMinute: null,
  queueNextRunAt: null,
  batchSubmitNextRunAt: NEXT_SEND,
  readAtMs: Date.parse('2026-09-21T18:06:20.000Z'),
}

const THRESHOLDS = {} as never

/** Entries as phase 1 leaves them: state pending_submission, and NO batch. */
function pendingEntries(count: number, organisationId = ORG): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `entry-${organisationId}-${i}`,
    organisation_id: organisationId,
    batch_id: null,
    state: 'pending_submission',
  }))
}

function emptyTables(): Record<string, Row[]> {
  return { prospects: [], job_queue: [], synthesis_batches: [], synthesis_batch_entries: [] }
}

beforeEach(() => vi.clearAllMocks())

describe('the window between the two research stages', () => {
  it('counts entries that phase 1 finished and nothing has sent yet', async () => {
    const tables = emptyTables()
    tables.synthesis_batch_entries = pendingEntries(107)

    const progress = await getPipelineProgress(fakeClient(tables), ORG, THRESHOLDS, SWEEP)

    expect(progress.research.awaitingSubmission).toBe(107)
  })

  // THE SYMPTOM, NOT JUST THE NUMBER. The panel renders nothing when the stage is idle, so
  // 'idle' here is the whole defect: an operator saw a screen indistinguishable from one
  // where research had never been started.
  it('does not report the pipeline as idle while they wait', async () => {
    const tables = emptyTables()
    tables.synthesis_batch_entries = pendingEntries(107)

    const progress = await getPipelineProgress(fakeClient(tables), ORG, THRESHOLDS, SWEEP)

    expect(progress.research.stage).toBe('awaiting_submission')
    expect(progress.research.stage).not.toBe('idle')
  })

  // These entries have no batch, so nothing about them can be found through one. A count
  // that reads them through an open batch is the bug, and there is no open batch here.
  it('finds them with no synthesis_batches row in existence', async () => {
    const tables = emptyTables()
    tables.synthesis_batch_entries = pendingEntries(107)
    expect(tables.synthesis_batches).toHaveLength(0)

    const progress = await getPipelineProgress(fakeClient(tables), ORG, THRESHOLDS, SWEEP)

    expect(progress.research.awaitingSubmission).toBe(107)
  })

  it('says when the next send is, so a count is not read as a stall', async () => {
    const tables = emptyTables()
    tables.synthesis_batch_entries = pendingEntries(7)

    const progress = await getPipelineProgress(fakeClient(tables), ORG, THRESHOLDS, SWEEP)

    expect(progress.research.nextSubmissionRunAt).toBe(NEXT_SEND)
  })

  // A firing time for a sweep that will find nothing to do is true and useless, and it
  // would put a moving caption on a screen where nothing is moving.
  it('names no send time when nothing is waiting to be sent', async () => {
    const progress = await getPipelineProgress(fakeClient(emptyTables()), ORG, THRESHOLDS, SWEEP)

    expect(progress.research.awaitingSubmission).toBe(0)
    expect(progress.research.nextSubmissionRunAt).toBeNull()
    expect(progress.research.stage).toBe('idle')
  })

  // ── ISOLATION ──────────────────────────────────────────────────────────────
  //
  // Every count on this screen is per organisation. This one is read by STATE with no batch
  // to scope it, which is exactly the shape that loses an organisation filter.
  it('counts only this organisation’s entries', async () => {
    const tables = emptyTables()
    tables.synthesis_batch_entries = [...pendingEntries(3), ...pendingEntries(40, OTHER_ORG)]

    const progress = await getPipelineProgress(fakeClient(tables), ORG, THRESHOLDS, SWEEP)

    expect(progress.research.awaitingSubmission).toBe(3)
  })

  // An entry aged out of a batch goes back to pending_submission and KEEPS the old batch_id.
  // That batch is 'expired' and so is not open, so a batch-scoped read misses it too.
  it('counts a requeued entry that still carries an expired batch’s id', async () => {
    const tables = emptyTables()
    tables.synthesis_batches = [
      { id: 'batch-old', organisation_id: ORG, state: 'expired', request_count: 5, submitted_at: '2026-09-21T10:00:00Z' },
    ]
    tables.synthesis_batch_entries = [
      { id: 'e1', organisation_id: ORG, batch_id: 'batch-old', state: 'pending_submission' },
    ]

    const progress = await getPipelineProgress(fakeClient(tables), ORG, THRESHOLDS, SWEEP)

    expect(progress.research.awaitingSubmission).toBe(1)
    expect(progress.research.stage).toBe('awaiting_submission')
  })

  // ── NO DOUBLE COUNTING ─────────────────────────────────────────────────────
  //
  // awaitingSubmission is read by state alone and awaitingModel through an open batch. If
  // the second one still admitted pending_submission, an entry in both reads would be
  // counted twice and "Still to go" would overstate the work left.
  it('keeps the two halves of the wait disjoint', async () => {
    const tables = emptyTables()
    tables.synthesis_batches = [
      { id: 'batch-open', organisation_id: ORG, state: 'submitted', request_count: 2, submitted_at: '2026-09-21T18:08:03Z' },
    ]
    tables.synthesis_batch_entries = [
      { id: 'e1', organisation_id: ORG, batch_id: 'batch-open', state: 'submitted' },
      { id: 'e2', organisation_id: ORG, batch_id: 'batch-open', state: 'pending_submission' },
    ]

    const progress = await getPipelineProgress(fakeClient(tables), ORG, THRESHOLDS, SWEEP)

    expect(progress.research.awaitingModel).toBe(1)
    expect(progress.research.awaitingSubmission).toBe(1)
    expect(progress.research.awaitingModel + progress.research.awaitingSubmission).toBe(2)
  })

  // Pipeline order, not pile size: phase 1 still running is the earlier stage and stays the
  // headline even when more prospects are waiting behind it.
  it('still names the earlier stage while sources are being read', async () => {
    const tables = emptyTables()
    tables.job_queue = [
      { id: 'j1', organisation_id: ORG, job_type: 'research_sources', state: 'claimed' },
    ]
    tables.synthesis_batch_entries = pendingEntries(50)

    const progress = await getPipelineProgress(fakeClient(tables), ORG, THRESHOLDS, SWEEP)

    expect(progress.research.stage).toBe('fetching_sources')
    expect(progress.research.awaitingSubmission).toBe(50)
  })
})
