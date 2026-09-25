// THE TS UNION AND THE SQL CHECK ARE TWO LISTS THAT MUST AGREE.
//
// research_usage.path carries CHECK (path IN ('cli','inline','queue','collect')) and
// RESEARCH_PATHS carries the same four values in TypeScript. Neither can be derived from the
// other across the process boundary, so this is the parallel-list shape CLAUDE.md warns
// about, one level removed: adding a value to the union and not the constraint makes every
// insert on the new path fail with 23514 at runtime, and only at runtime.
//
// ═══ THE LIMIT OF THIS TEST, STATED RATHER THAN LEFT TO BE DISCOVERED ═══
//
// It reads the MIGRATION FILE, so it proves what the migrations declare and NOT what the
// database currently enforces. Migrations are append-only: a later one is free to drop and
// recreate the constraint with different values and this test would stay green. That is why
// the authoritative check is the live read-back recorded when the migration was applied, and
// why research-usage-stored.live.test.ts exercises all four values against a real database.
// This is the cheap early warning that fires in CI without a database.

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { RESEARCH_PATHS } from '../types'

const MIGRATION = path.join(
  process.cwd(), 'supabase/migrations/20260925030000_research_usage.sql',
)

describe('research_usage.path', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8')

  it('can find the constraint at all, so a zero below is the code and not the search', () => {
    // The positive control. Without it, renaming the migration would make every assertion
    // here pass over an empty read, which is the failure this repo keeps relearning.
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.research_usage')
    expect(sql).toMatch(/CHECK \(path IN \(/)
  })

  it('declares exactly the values the TypeScript union declares', () => {
    const m = sql.match(/CHECK \(path IN \(([^)]*)\)\)/)
    if (!m) throw new Error('no path CHECK found in the migration')
    const inSql = m[1].split(',').map(v => v.trim().replace(/^'|'$/g, '')).sort()
    expect(inSql).toEqual([...RESEARCH_PATHS].sort())
  })

  it('has no duplicate values in the union, which would hide a missing one', () => {
    expect(new Set(RESEARCH_PATHS).size).toBe(RESEARCH_PATHS.length)
  })

  it('asserts no later migration drops the constraint under the same name', () => {
    // The append-only caveat above, narrowed to the one thing a file scan CAN see.
    const dir = path.join(process.cwd(), 'supabase/migrations')
    const offenders = fs.readdirSync(dir)
      .filter(f => f.endsWith('.sql'))
      .filter(f => /DROP\s+CONSTRAINT[^;]*research_usage_path/i.test(
        fs.readFileSync(path.join(dir, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  // ── ADDED BECAUSE A MUTATION SURVIVED ───────────────────────────────────────
  //
  // Deleting `research_path: 'cli'` from scripts/run-research.ts broke nothing: the live
  // test drives storeResearchResult directly, so it proves the ledger records whatever path
  // it is handed and says nothing about whether each caller hands it the right one. The
  // scripts have no unit tests, and a literal argument in a CLI is not worth a harness.
  //
  // So this reads them. Same limit as the rest of this file: it catches the line being
  // deleted, which is the regression that would silently file CLI spend as 'inline'. What
  // actually proves it in production is the data, because a path with no rows after a run on
  // it is visible as a missing value — which is why the column exists.
  it.each(['scripts/run-research.ts', 'scripts/rerun-cohort.ts'])(
    '%s declares itself as the cli path', file => {
      const text = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
      // Positive control first, so a moved or renamed script cannot pass on an empty read.
      expect(text).toContain('runResearchBatchForOrg')
      expect(text).toMatch(/research_path:\s*'cli'/)
    },
  )

  it('the queue full_run executor declares itself as the queue path', () => {
    const text = fs.readFileSync(
      path.join(process.cwd(), 'src/lib/queue/executors/research.ts'), 'utf8')
    expect(text).toContain('runProspectResearchAgentV2')
    expect(text).toMatch(/research_path:\s*'queue'/)
  })
})
