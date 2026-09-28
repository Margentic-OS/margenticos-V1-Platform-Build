// ONE RESEARCH ROW PER SEQUENCE: the follow-ups read what Email 1 was written from.
//
// THE SEAM. Email 1 is written by the research run, from the row that run just produced:
// `current_research_result_id` and `personalisation_trigger` are written in the same object
// literal, so that column IS the Email 1 corpus. Follow-ups are written later by the backfill,
// which called loadStoredFindings with no pin and got whichever row its scoring ranked highest.
//
// MEASURED 2026-09-27 across the 104-prospect cohort: DIFFERENT rows for 57 of them. The
// consequences were both real and both expensive. A follow-up argued from facts its own Email 1
// never mentioned. And an audit that judged Email 1 against the follow-up corpus reported 18
// fabrications that were not fabrications, including one I confirmed with my own grep before
// discovering the grep was pointed at the wrong row.
//
// WHY A TEST AND NOT JUST THE FIX. Nothing here would fail if the pin were dropped: both sides
// would keep working, each against its own corpus, exactly as before. That is the definition of
// a seam defect, and this repo's own lesson is that half-tests cannot see a join.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect, vi } from 'vitest'
import { loadStoredFindings } from '../prospect-research-agent-v2'

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const iso = (d: string) => new Date(d).toISOString()

/** Two rows for one prospect. The NEWER one is deliberately the weaker by the scoring. */
const ROWS = [
  {
    id: 'row-newer',
    candidates: [{ id: 'c1', observation: 'The firm posted for a site manager in August.', date: '2026-08-01' }],
    sources_successful: ['apollo'],
    created_at: iso('2026-09-20'),
    synthesized_at: null,
    icp_fit: 'strong', qualification_status: 'qualified', qualification_reason: null,
    synthesis_confidence: 'high', has_dateable_signal: true, signal_observation: null,
    relevance_reason: null, selected_candidate_id: 'c1', selection_reason: null,
    selection_basis: null, prospect_reason: null, supporting_candidate_id: null,
  },
  {
    id: 'row-older-but-richer',
    candidates: [{ id: 'd1', observation: 'The firm opened a second depot in March.', date: '2026-03-01' }],
    // LinkedIn plus website is what the scoring prefers, which is why this older row wins
    // an unpinned read. That is the whole mechanism of the defect.
    sources_successful: ['linkedin', 'website'],
    created_at: iso('2026-09-10'),
    synthesized_at: null,
    icp_fit: 'strong', qualification_status: 'qualified', qualification_reason: null,
    synthesis_confidence: 'high', has_dateable_signal: true, signal_observation: null,
    relevance_reason: null, selected_candidate_id: 'd1', selection_reason: null,
    selection_basis: null, prospect_reason: null, supporting_candidate_id: null,
  },
]

/** A Supabase-like chain that answers the one query loadStoredFindings makes. */
function client(rows: unknown[]) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'gte', 'order', 'limit']) chain[m] = () => chain
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res)
  return { from: () => chain } as never
}

describe('a pinned research row is the one that is read', () => {
  it('UNPINNED: the scoring wins, and it is NOT the newest row', async () => {
    const s = await loadStoredFindings(client(ROWS), 'p1', 'org-1')
    // Establishes the premise the pin exists to correct. Without this the test below could
    // pass because the pin happened to agree with the default.
    expect(s!.result_id).toBe('row-older-but-richer')
  })

  it('PINNED: the named row is read even though the scoring prefers the other', async () => {
    const s = await loadStoredFindings(client(ROWS), 'p1', 'org-1', 'row-newer')
    expect(s!.result_id).toBe('row-newer')
    expect(s!.candidates[0].observation).toContain('site manager')
  })

  it('the two differ, so the pin is load-bearing rather than cosmetic', async () => {
    const unpinned = await loadStoredFindings(client(ROWS), 'p1', 'org-1')
    const pinned = await loadStoredFindings(client(ROWS), 'p1', 'org-1', 'row-newer')
    expect(pinned!.result_id).not.toBe(unpinned!.result_id)
    expect(pinned!.candidates[0].observation).not.toBe(unpinned!.candidates[0].observation)
  })

  // ─── Failing safe ────────────────────────────────────────────────────────────

  it('a pin naming a row this prospect does not have falls back to the scoring', async () => {
    const s = await loadStoredFindings(client(ROWS), 'p1', 'org-1', 'row-belonging-to-somebody-else')
    expect(s!.result_id).toBe('row-older-but-richer')
  })

  it('a null pin behaves exactly as no pin', async () => {
    const a = await loadStoredFindings(client(ROWS), 'p1', 'org-1', null)
    const b = await loadStoredFindings(client(ROWS), 'p1', 'org-1')
    expect(a!.result_id).toBe(b!.result_id)
  })

  it('no rows at all still returns null, pinned or not', async () => {
    expect(await loadStoredFindings(client([]), 'p1', 'org-1', 'row-newer')).toBeNull()
  })
})
