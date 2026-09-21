import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MONITORS } from '../monitors'

/**
 * WHY THESE TESTS EXIST.
 *
 * The sweep held two parallel arrays, checkCodes (16) and viewNames (17), and looped to
 * checkCodes.length. viewNames[16], 'mon_019', was never read. Commit 89ac57b tried to fix
 * exactly that and added only the view name, so the defect survived its own fix and
 * monitor_events held zero MON-019 rows while the sweep ran happily.
 *
 * A silent monitor reads as a healthy one, so this is a defect that hides defects. These
 * tests make the two failure modes loud: a malformed pair, and a view on disk that the
 * sweep does not query.
 */
describe('monitor-sweep monitor registry', () => {
  it('pairs every check code with a view name, with nothing undefined', () => {
    for (const pair of MONITORS) {
      expect(pair).toHaveLength(2)
      const [code, view] = pair
      expect(code, `check code missing in pair ${JSON.stringify(pair)}`).toBeTruthy()
      expect(view, `view name missing in pair ${JSON.stringify(pair)}`).toBeTruthy()
    }
  })

  it('derives the view name from the check code, so a mismatched pair cannot ship', () => {
    // MON-019 <-> mon_019. A pair that does not follow this is almost certainly a paste
    // error, which is the other way the old parallel arrays could have gone wrong.
    for (const [code, view] of MONITORS) {
      expect(view, `${code} is paired with ${view}`).toBe(code.toLowerCase().replace('-', '_'))
    }
  })

  it('has no duplicate check codes or view names', () => {
    const codes = MONITORS.map(([c]) => c)
    const views = MONITORS.map(([, v]) => v)
    expect(new Set(codes).size, 'duplicate check code').toBe(codes.length)
    expect(new Set(views).size, 'duplicate view name').toBe(views.length)
  })

  it('queries every mon_NNN view that exists in the migrations', () => {
    // THE TEST THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. A view created by a migration and
    // never added here is a monitor that exists, looks registered, and is never read.
    const migrationsDir = join(process.cwd(), 'supabase', 'migrations')
    const created = new Set<string>()

    for (const file of readdirSync(migrationsDir)) {
      if (!file.endsWith('.sql')) continue
      const sql = readFileSync(join(migrationsDir, file), 'utf8')
      for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:public\.)?(mon_\d+)/gi)) {
        created.add(m[1].toLowerCase())
      }
    }

    // Guard the guard: if the regex ever stops matching, this test must fail loudly rather
    // than pass vacuously over an empty set.
    expect(created.size, 'found no mon_NNN views in migrations, so this test proves nothing')
      .toBeGreaterThan(0)

    const queried = new Set(MONITORS.map(([, v]) => v))
    const orphaned = [...created].filter(v => !queried.has(v)).sort()

    expect(
      orphaned,
      `these monitor views exist but the sweep never queries them, so they are dark: ${orphaned.join(', ')}`,
    ).toEqual([])
  })

  it('includes MON-019, the verification sweep, which was dark until 2026-08-25', () => {
    expect(MONITORS.some(([code]) => code === 'MON-019')).toBe(true)
  })

  it('includes MON-021 and MON-022, the batch research path', () => {
    // Registered together on purpose. MON-021 is operational and MON-022 is structural,
    // and MON-022 is the AUTHORITATIVE check for the indexes this suite can only scan the
    // migrations for. A migration scan proves history; only the live catalog proves now.
    expect(MONITORS.some(([code]) => code === 'MON-021')).toBe(true)
    expect(MONITORS.some(([code]) => code === 'MON-022')).toBe(true)
  })

  it('includes MON-025, without which the cron schedule scan is the only check', () => {
    // cron-schedule-registry.test.ts reads the migration FILES and proves the registry seed
    // matches them. That is a history check, in the sense CLAUDE.md warns about: it says
    // nothing about what cron.job actually holds right now. MON-025 is the live half, and
    // it is the only thing in this platform that reads cron.job.schedule at all.
    expect(
      MONITORS.some(([code]) => code === 'MON-025'),
      'mon_025 is the live cron-schedule check behind cron-schedule-registry.test.ts. ' +
      'Removing it leaves a migration scan as the only guard, and a scan cannot see a ' +
      'schedule changed by hand with cron.alter_job.',
    ).toBe(true)
  })

  it('MON-022 is what makes the migration scans in this repo trustworthy', () => {
    // Several tests assert that a migration still CREATEs an index. Migrations are
    // append-only, so those prove a migration once created it and nothing more: a later
    // DROP leaves the CREATE sitting there, green for ever. Found by mutation-testing the
    // test rather than the code. MON-022 reads pg_indexes live, so if it is ever removed
    // from the registry, those scans quietly become the only check again.
    expect(
      MONITORS.some(([, view]) => view === 'mon_022'),
      'mon_022 is the live catalog check behind the migration-scanning tests. Removing it ' +
      'leaves those tests as the only guard, and they cannot see a DROP in a later migration.',
    ).toBe(true)
  })
})
// PIECE 3: MON-033, the reassignment monitor.
//
// The warning that a prospect had been moved off a missing variant went to stdout. The
// logger has no Sentry wiring, so a document short a variant moved live prospects and
// nothing surfaced it. MON-033 reads prospects.variant_reassigned_at, which resolveVariant
// writes at the moment it moves one, so the monitor reads STATE rather than a log line.
describe('MON-033 is registered and its view exists', () => {
  const migrationsDir = join(process.cwd(), 'supabase', 'migrations')
  const MIGRATION = '20260921120000_variant_reassignment_record_and_mon_033.sql'
  const sql = () => readFileSync(join(migrationsDir, MIGRATION), 'utf-8')

  it('is in the registry, paired with its view', () => {
    expect(MONITORS).toContainEqual(['MON-033', 'mon_033'])
  })

  it('the migrations create the view it names', () => {
    expect(sql()).toMatch(/CREATE OR REPLACE VIEW public\.mon_033/)
  })

  // The view is useless without the column, and the column is useless unless the write
  // path sets it. Both are asserted here so the pair cannot drift apart.
  it('the same migration adds the columns the view reads', () => {
    expect(sql()).toContain('variant_reassigned_from')
    expect(sql()).toContain('variant_reassigned_at')
  })

  it('and compose-sequence actually writes them', () => {
    const src = readFileSync(
      join(migrationsDir, '..', '..', 'src', 'lib', 'composition', 'compose-sequence.ts'),
      'utf-8',
    )
    expect(src).toContain('variant_reassigned_from')
    expect(src).toContain('variant_reassigned_at')
  })

  // Service role only. RLS is one layer and the GRANT is the other; a view runs as its
  // owner unless security_invoker is set, so an anon grant here would be a read straight
  // past RLS on prospects.
  it('is revoked from anon and authenticated, and granted to service_role', () => {
    expect(sql()).toMatch(/REVOKE ALL ON public\.mon_033 FROM anon, authenticated/)
    expect(sql()).toMatch(/GRANT SELECT ON public\.mon_033 TO service_role/)
  })
})
