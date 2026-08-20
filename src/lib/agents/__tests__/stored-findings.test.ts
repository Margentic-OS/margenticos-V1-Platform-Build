// The stored-findings selector. "Best" is deliberately not "most recent".
//
// On 2026-08-20 an empty Apify balance made LinkedIn fail silently for a whole batch of
// 13 prospects. Every log line read as success, sources_successful simply lost 'linkedin',
// and the openings were written without any LinkedIn data. A most-recent selector would
// pick exactly those rows, which is the opposite of what the flag is for.

import { describe, it, expect } from 'vitest'

type Row = { result_id: string; candidates: unknown[]; had_linkedin: boolean; created_at: string }

// Mirrors the ordering in loadStoredFindings.
function pickBest(rows: Row[]): Row | null {
  const usable = rows.filter(r => r.candidates.length > 0)
  if (usable.length === 0) return null
  return [...usable].sort((a, b) =>
    (Number(b.had_linkedin) - Number(a.had_linkedin))
    || (b.candidates.length - a.candidates.length)
    || b.created_at.localeCompare(a.created_at),
  )[0]
}

const row = (id: string, linkedin: boolean, cands: number, at: string): Row =>
  ({ result_id: id, candidates: Array(cands).fill({}), had_linkedin: linkedin, created_at: at })

describe('best stored findings', () => {
  it('prefers a LinkedIn run over a newer degraded one, the real incident', () => {
    const best = pickBest([
      row('degraded', false, 5, '2026-08-20T15:24:00Z'),
      row('good',     true,  7, '2026-08-20T01:20:00Z'),
    ])
    expect(best?.result_id).toBe('good')
  })

  it('breaks a LinkedIn tie on candidate count', () => {
    const best = pickBest([
      row('thin',  true, 3, '2026-08-20T10:00:00Z'),
      row('rich',  true, 8, '2026-08-19T10:00:00Z'),
    ])
    expect(best?.result_id).toBe('rich')
  })

  it('breaks a full tie on recency', () => {
    const best = pickBest([
      row('older', true, 5, '2026-08-19T10:00:00Z'),
      row('newer', true, 5, '2026-08-20T10:00:00Z'),
    ])
    expect(best?.result_id).toBe('newer')
  })

  it('ignores rows with zero candidates, which carry no findings to reuse', () => {
    const best = pickBest([
      row('empty', true, 0, '2026-08-20T15:00:00Z'),
      row('has',   false, 4, '2026-08-19T10:00:00Z'),
    ])
    expect(best?.result_id).toBe('has')
  })

  it('returns null when nothing usable is stored, so the caller can fetch instead', () => {
    expect(pickBest([row('empty', true, 0, '2026-08-20T15:00:00Z')])).toBeNull()
    expect(pickBest([])).toBeNull()
  })
})
