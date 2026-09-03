// The dependency graph is written twice and the two copies must agree.
//
// TypeScript: DOWNSTREAM_OF, used by the sequencer and by the operator's stale list.
// SQL:        promote_strategy_doc_version, which marks downstream documents stale.
//
// Neither can see the other. Adding a fifth document type to one and not the other
// produces no error anywhere; the symptom is a document that silently never goes stale,
// which reads on screen exactly like a document that is up to date. That is the
// parallel-array shape from CLAUDE.md, and this file is the guard.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. It reads a MIGRATION FILE. Migrations are
// append-only, so it proves what that migration said on the day it was written. A later
// migration is free to redefine the function with a different graph and this test stays
// green. Stated here so the next reader does not over-trust it: the authoritative check
// is reading pg_get_functiondef live, which the proof run does.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DOWNSTREAM_OF,
  UPSTREAM_OF,
  STRATEGY_DOC_TYPES,
  SEGMENT_SCOPED,
  isStrategyDocType,
} from '../document-dependencies'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')

function latestPromoteMigration(): string {
  const files = readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.sql'))
    .filter(f => readFileSync(join(MIGRATIONS, f), 'utf8')
      .includes('FUNCTION public.promote_strategy_doc_version'))
    .sort()

  // Guard the guard. If the filter ever matches nothing, every assertion below would
  // pass vacuously against an empty string.
  expect(files.length, 'no migration defines promote_strategy_doc_version').toBeGreaterThan(0)

  return readFileSync(join(MIGRATIONS, files[files.length - 1]), 'utf8')
}

describe('the graph itself', () => {
  it('names only known document types', () => {
    for (const [upstream, downstreams] of Object.entries(DOWNSTREAM_OF)) {
      expect(isStrategyDocType(upstream)).toBe(true)
      for (const d of downstreams) expect(isStrategyDocType(d)).toBe(true)
    }
  })

  it('covers every document type, so a new one cannot be silently absent', () => {
    expect(Object.keys(DOWNSTREAM_OF).sort()).toEqual([...STRATEGY_DOC_TYPES].sort())
  })

  it('has no cycles, because a document cannot be built from itself', () => {
    for (const type of STRATEGY_DOC_TYPES) {
      expect(DOWNSTREAM_OF[type]).not.toContain(type)
    }
  })

  it('derives UPSTREAM_OF as the exact inverse rather than a second hand-typed list', () => {
    for (const upstream of STRATEGY_DOC_TYPES) {
      for (const downstream of DOWNSTREAM_OF[upstream]) {
        expect(UPSTREAM_OF[downstream]).toContain(upstream)
      }
    }
    for (const downstream of STRATEGY_DOC_TYPES) {
      for (const upstream of UPSTREAM_OF[downstream]) {
        expect(DOWNSTREAM_OF[upstream]).toContain(downstream)
      }
    }
  })

  it('leaves messaging downstream of everything and upstream of nothing', () => {
    expect(DOWNSTREAM_OF.messaging).toEqual([])
    expect([...UPSTREAM_OF.messaging].sort()).toEqual(['icp', 'positioning', 'tov'])
  })
})

describe('the SQL agrees with the TypeScript', () => {
  const sql = latestPromoteMigration()

  it('marks positioning and messaging stale when the prospect profile changes', () => {
    const branch = sql.slice(sql.indexOf("IF p_doc_type = 'icp' THEN"), sql.indexOf("ELSIF p_doc_type IN"))
    expect(branch.length, 'could not find the icp branch').toBeGreaterThan(0)
    for (const downstream of DOWNSTREAM_OF.icp) {
      expect(branch, `icp branch does not mark ${downstream}`).toContain(`'${downstream}'`)
    }
  })

  it('marks messaging stale when positioning or the voice guide changes', () => {
    expect(sql).toContain("ELSIF p_doc_type IN ('positioning', 'tov') THEN")
    const branch = sql.slice(sql.indexOf("ELSIF p_doc_type IN"))
    for (const downstream of new Set([...DOWNSTREAM_OF.positioning, ...DOWNSTREAM_OF.tov])) {
      expect(branch, `branch does not mark ${downstream}`).toContain(`'${downstream}'`)
    }
  })

  it('scopes the segment-scoped downstream by segment and the org-level one by NULL', () => {
    // An ICP change must not stale another segment's messaging, and must stale the
    // org-level positioning whatever segment it came from. Getting this backwards would
    // flag the wrong documents and stay green in every other test here.
    expect(SEGMENT_SCOPED).toContain('messaging')
    expect(SEGMENT_SCOPED).not.toContain('positioning')
    expect(sql).toContain("(document_type = 'positioning' AND segment_id IS NULL)")
    expect(sql).toContain("(document_type = 'messaging' AND segment_id IS NOT DISTINCT FROM p_segment_id)")
  })

  it('never marks the document type that was just promoted', () => {
    // Self-marking would make every regeneration produce a document that is born stale.
    expect(sql).not.toContain("AND document_type   = p_doc_type\n      AND is_stale")
    expect(sql).toContain('AND is_stale        = false')
  })

  it('does not touch last_updated_at when marking, because that reports a real change', () => {
    const marking = sql.slice(sql.indexOf("IF p_doc_type = 'icp' THEN"))
    expect(marking).toContain('SET is_stale = true')
    expect(marking).not.toContain('SET is_stale = true, last_updated_at')
  })
})
