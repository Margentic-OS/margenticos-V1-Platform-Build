import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * WHAT THIS TEST CAN AND CANNOT PROVE.
 *
 * It reads the migration files, so it proves what the repository ASKS FOR. It does not prove
 * what the live database currently HAS: migrations are append-only, a later one is free to
 * replace this view, and the CREATE stays here green for ever. CLAUDE.md states the limit
 * directly, and it is restated here so the next reader does not over-trust a pass.
 *
 * The live half is a read-back through the Supabase MCP against both projects, recorded in
 * the migration's Status line. This file is the cheap early warning that sits in CI.
 *
 * What it is guarding is an ORDERING inside a CASE expression, which is invisible to every
 * other kind of test we have: get it wrong and the monitor still returns a state for every
 * input, just the wrong one for the combination that matters least often and costs most.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

/** Every migration that defines mon_035, oldest first. */
function mon035Definitions(): { file: string; sql: string }[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()

  const out: { file: string; sql: string }[] = []
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    if (/CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+public\.mon_035\b/i.test(sql)) {
      out.push({ file, sql })
    }
  }
  return out
}

/** The body of the last mon_035 definition: the one the database ends up with. */
function latestDefinition(): { file: string; sql: string } {
  const defs = mon035Definitions()
  // GUARDS ITSELF. Without this, a rename or a moved directory makes every assertion below
  // pass over an empty set, which is the vacuous-pass shape this codebase keeps writing
  // tests about.
  expect(defs.length).toBeGreaterThan(0)
  return defs[defs.length - 1]
}

describe('mon_035: the view the migrations end up with', () => {
  it('finds at least two definitions, so the replacement is actually in the repo', () => {
    // The original on 2026-09-28 and the brand-domain replacement on 2026-09-29.
    const defs = mon035Definitions()
    expect(defs.length).toBeGreaterThanOrEqual(2)
  })

  it('reads the SENDING count for its vacuous-truth check, not the combined count', () => {
    const { sql } = latestDefinition()
    // The brand list is a non-empty hardcoded floor, so a combined count can never be zero
    // and this branch would be unreachable. See the migration header.
    expect(sql).toMatch(/sending_domains_checked/)
  })

  it('COALESCEs to domains_checked so the pre-split row is not read as empty scope', () => {
    const { sql } = latestDefinition()
    expect(sql).toMatch(/COALESCE\(\s*\(SELECT sending_domains_checked FROM snap\),/)
  })

  it('checks listed_count BEFORE the vacuous-truth branch, so a listing is never masked', () => {
    const { sql } = latestDefinition()
    const listedAt = sql.search(/WHEN \(SELECT listed_count FROM snap\) > 0/)
    const vacuousAt = sql.search(/WHEN COALESCE\(\(SELECT sending_domains_checked FROM snap\)/)

    expect(listedAt).toBeGreaterThan(-1)
    expect(vacuousAt).toBeGreaterThan(-1)
    // A confirmed listing outranks an uncertain scope. Reversing these two lines would make
    // a brand-domain listing during a sending-stats outage report UNKNOWN instead of PROBLEM,
    // and nothing else in the suite would notice.
    expect(listedAt).toBeLessThan(vacuousAt)
  })

  it('still checks freshness and control failures ahead of any finding', () => {
    const { sql } = latestDefinition()
    const freshAt = sql.search(/WHEN \(SELECT computed_at FROM snap\) < now\(\)/)
    const controlAt = sql.search(/WHEN \(SELECT control_failure_count FROM snap\) > 0/)
    const listedAt = sql.search(/WHEN \(SELECT listed_count FROM snap\) > 0/)

    expect(freshAt).toBeGreaterThan(-1)
    expect(controlAt).toBeGreaterThan(-1)
    expect(freshAt).toBeLessThan(controlAt)
    // A list that could not answer makes every clean result below it unsafe to read, so it
    // is reported ahead of the findings rather than underneath them.
    expect(controlAt).toBeLessThan(listedAt)
  })

  it('no later migration drops the columns the view depends on', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      // Substring matching is what let a RENAME slip past an earlier version of a test like
      // this one, per CLAUDE.md. Matched against DROP COLUMN specifically.
      expect(sql).not.toMatch(/DROP\s+COLUMN\s+(IF\s+EXISTS\s+)?sending_domains_checked/i)
      expect(sql).not.toMatch(/DROP\s+COLUMN\s+(IF\s+EXISTS\s+)?brand_domains_checked/i)
    }
  })
})
