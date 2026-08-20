// The stored-findings reuse path, tested against the SHIPPED function.
//
// This file used to define a local pickBest() whose own comment said it "mirrors the
// ordering in loadStoredFindings". A mirror cannot fail when the thing it mirrors drifts,
// because it is testing the copy. It passed happily while the real function grew an
// organisation_id filter, an age window, a row cap and a carried-forward classification,
// none of which it modelled.
//
// Everything below drives the real loadStoredFindings. The query assertions read the calls
// the function actually issues against a stub client, so a dropped .eq or a raised .limit
// fails here rather than in production.
//
// Why this matters: on 2026-08-20 an empty Apify balance made LinkedIn fail silently for a
// whole batch of 13 prospects. Every log line read as success and sources_successful simply
// lost 'linkedin'. A most-recent selector would pick exactly those rows, which is the
// opposite of what the flag is for.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { logger } from '@/lib/logger'
import {
  loadStoredFindings,
  runProspectResearchAgentV2,
  runProspectResearchAgentV2Batch,
  STORED_FINDINGS_MAX_AGE_DAYS,
} from '../prospect-research-agent-v2'

// ─── Stub client ──────────────────────────────────────────────────────────────
// Records the query the real function builds. Thenable, so the awaited chain resolves to
// whatever this test wants the database to have returned.

type QueryLog = {
  from:   string | null
  select: string | null
  eq:     Array<[string, unknown]>
  gte:    Array<[string, unknown]>
  order:  Array<[string, unknown]>
  limit:  number | null
}

type DbResult = { data: unknown[] | null; error: { message: string } | null }

function stubClient(result: DbResult) {
  const q: QueryLog = { from: null, select: null, eq: [], gte: [], order: [], limit: null }

  const builder: Record<string, unknown> = {
    select: (cols: string) => { q.select = cols; return builder },
    eq:     (c: string, v: unknown) => { q.eq.push([c, v]); return builder },
    gte:    (c: string, v: unknown) => { q.gte.push([c, v]); return builder },
    order:  (c: string, o: unknown) => { q.order.push([c, o]); return builder },
    limit:  (n: number) => { q.limit = n; return builder },
    then:   <T,>(onOk: (v: DbResult) => T) => Promise.resolve(result).then(onOk),
  }

  const client = { from: (t: string) => { q.from = t; return builder } }
  return { client: client as never, q }
}

/** A full result row, every column the real select asks for. */
const dbRow = (over: Record<string, unknown> = {}) => ({
  id:                   'row-1',
  candidates:           [{ observation: 'a thing that happened', date: null }],
  sources_successful:   ['linkedin', 'apollo'],
  created_at:           '2026-08-20T01:00:00Z',
  synthesized_at:       '2026-08-20T01:00:05Z',
  icp_fit:              'strong',
  qualification_status: 'qualified',
  qualification_reason: null,
  synthesis_confidence: 'high',
  has_dateable_signal:  true,
  signal_observation:   'stored observation',
  relevance_reason:     'stored reason',
  ...over,
})

/** Shorthand for the ordering cases: id, LinkedIn present, candidate count, timestamp. */
const orderRow = (id: string, linkedin: boolean, cands: number, at: string) =>
  dbRow({
    id,
    sources_successful: linkedin ? ['linkedin'] : ['apollo'],
    candidates: Array.from({ length: cands }, () => ({ observation: 'x', date: null })),
    created_at: at,
  })

const load = (result: DbResult) => {
  const { client, q } = stubClient(result)
  return { run: () => loadStoredFindings(client, 'prospect-1', 'org-1'), q }
}

beforeEach(() => { vi.clearAllMocks() })

// ─── Selection: best, not most recent ────────────────────────────────────────

describe('loadStoredFindings: which row it picks', () => {
  it('prefers a LinkedIn run over a newer degraded one, the real incident', async () => {
    const { run } = load({
      data: [
        orderRow('degraded', false, 5, '2026-08-20T15:24:00Z'),
        orderRow('good',     true,  7, '2026-08-20T01:20:00Z'),
      ],
      error: null,
    })
    expect((await run())?.result_id).toBe('good')
  })

  it('breaks a LinkedIn tie on candidate count', async () => {
    const { run } = load({
      data: [
        orderRow('thin', true, 3, '2026-08-20T10:00:00Z'),
        orderRow('rich', true, 8, '2026-08-19T10:00:00Z'),
      ],
      error: null,
    })
    expect((await run())?.result_id).toBe('rich')
  })

  it('breaks a full tie on recency', async () => {
    const { run } = load({
      data: [
        orderRow('older', true, 5, '2026-08-19T10:00:00Z'),
        orderRow('newer', true, 5, '2026-08-20T10:00:00Z'),
      ],
      error: null,
    })
    expect((await run())?.result_id).toBe('newer')
  })

  it('ignores rows with zero candidates, which carry no findings to reuse', async () => {
    const { run } = load({
      data: [
        orderRow('empty', true,  0, '2026-08-20T15:00:00Z'),
        orderRow('has',   false, 4, '2026-08-19T10:00:00Z'),
      ],
      error: null,
    })
    expect((await run())?.result_id).toBe('has')
  })

  it('returns null when nothing usable is stored, so the caller fetches instead', async () => {
    expect(await load({ data: [orderRow('empty', true, 0, '2026-08-20T15:00:00Z')], error: null }).run())
      .toBeNull()
    expect(await load({ data: [], error: null }).run()).toBeNull()
    expect(await load({ data: null, error: null }).run()).toBeNull()
  })
})

// ─── The query it actually issues ────────────────────────────────────────────

describe('loadStoredFindings: the query it builds', () => {
  it('scopes to BOTH the prospect and the organisation', async () => {
    const { run, q } = load({ data: [dbRow()], error: null })
    await run()

    expect(q.from).toBe('prospect_research_results')
    // Agent isolation is enforced at three levels and this is the application-layer one.
    // Losing this filter would read another client's research.
    expect(q.eq).toContainEqual(['prospect_id', 'prospect-1'])
    expect(q.eq).toContainEqual(['organisation_id', 'org-1'])
  })

  it('bounds the age at 30 days so a stale observation cannot reach a live email', async () => {
    const { run, q } = load({ data: [dbRow()], error: null })
    const before = Date.now()
    await run()

    expect(STORED_FINDINGS_MAX_AGE_DAYS).toBe(30)
    expect(q.gte).toHaveLength(1)

    const [column, cutoff] = q.gte[0]
    expect(column).toBe('created_at')

    const ageMs = before - Date.parse(cutoff as string)
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
    // Generous window: the assertion is "30 days back", not a stopwatch on the test.
    expect(ageMs).toBeGreaterThan(thirtyDaysMs - 60_000)
    expect(ageMs).toBeLessThan(thirtyDaysMs + 60_000)
  })

  it('caps the scan at 50 rows, since every reuse run inserts another one', async () => {
    const { run, q } = load({ data: [dbRow()], error: null })
    await run()
    expect(q.limit).toBe(50)
    expect(q.order).toContainEqual(['created_at', { ascending: false }])
  })

  it('selects every column the carried-forward classification needs', async () => {
    const { run, q } = load({ data: [dbRow()], error: null })
    await run()

    for (const column of [
      'id', 'candidates', 'sources_successful', 'created_at', 'synthesized_at',
      'icp_fit', 'qualification_status', 'qualification_reason', 'synthesis_confidence',
      'has_dateable_signal', 'signal_observation', 'relevance_reason',
    ]) {
      expect(q.select).toContain(column)
    }
  })
})

// ─── A query fault is not an empty history ───────────────────────────────────

describe('loadStoredFindings: failure is distinguishable from absence', () => {
  it('logs a query fault distinctly and still falls back', async () => {
    const { run } = load({ data: null, error: { message: 'connection reset' } })

    expect(await run()).toBeNull()
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.error).mock.calls[0][0]).toContain('stored-findings lookup failed')
    expect(vi.mocked(logger.error).mock.calls[0][1]).toMatchObject({ error: 'connection reset' })
  })

  it('does NOT log an error when the prospect simply has no history', async () => {
    const { run } = load({ data: [], error: null })

    expect(await run()).toBeNull()
    // The whole point of the split: a first-time prospect is routine and must stay quiet,
    // otherwise the real fault above is invisible in the noise.
    expect(logger.error).not.toHaveBeenCalled()
  })
})

// ─── The classification travels with the findings ────────────────────────────

describe('loadStoredFindings: carries the classification forward', () => {
  it('returns the verdict the source row reached, not a placeholder', async () => {
    const { run } = load({ data: [dbRow()], error: null })
    const stored = await run()

    // Placeholders here were written straight onto the prospect by updateProspect, which
    // flattened a strong prospect to moderate on every rerun.
    expect(stored).toMatchObject({
      result_id:            'row-1',
      had_linkedin:         true,
      icp_fit:              'strong',
      qualification_status: 'qualified',
      confidence:           'high',
      has_dateable_signal:  true,
      signal_observation:   'stored observation',
      relevance_reason:     'stored reason',
      synthesized_at:       '2026-08-20T01:00:05Z',
    })
  })

  it('nulls a missing column rather than inventing one, so old rows degrade no worse', async () => {
    const { run } = load({
      data: [dbRow({
        icp_fit: null, qualification_status: null, synthesis_confidence: null,
        has_dateable_signal: null, signal_observation: null, relevance_reason: null,
        synthesized_at: null,
      })],
      error: null,
    })
    const stored = await run()

    expect(stored).toMatchObject({
      icp_fit: null, qualification_status: null, confidence: null,
      has_dateable_signal: null, signal_observation: null, relevance_reason: null,
      synthesized_at: null,
    })
    // The candidates are still usable, which is the point of reusing the row at all.
    expect(stored?.candidates).toHaveLength(1)
  })
})

// ─── The default that made all of this reachable ─────────────────────────────

describe('use_stored_findings default', () => {
  // Read off the shipped function source. There is no cheaper observable: the flag is a
  // destructured default, and exercising it through either entry point would drag in the
  // four source handlers, the synthesis call and the writer. This pins the declaration, so
  // flipping it back to false is a deliberate act that fails here first.
  it('is true on the single-prospect entry point', () => {
    expect(runProspectResearchAgentV2.toString()).toMatch(/use_stored_findings\s*=\s*true/)
  })

  it('is true on the batch entry point', () => {
    expect(runProspectResearchAgentV2Batch.toString()).toMatch(/use_stored_findings\s*=\s*true/)
  })

  it('is not silently false anywhere in either signature', () => {
    expect(runProspectResearchAgentV2.toString()).not.toMatch(/use_stored_findings\s*=\s*false/)
    expect(runProspectResearchAgentV2Batch.toString()).not.toMatch(/use_stored_findings\s*=\s*false/)
  })
})
