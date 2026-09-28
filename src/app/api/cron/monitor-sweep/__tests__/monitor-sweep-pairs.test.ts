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

// PIECE 4: MON-035, the sending-domain blocklist monitor.
//
// Added 2026-09-28, the day SURBL was found listing two sending domains while a Gmail seed
// test, an Outlook seed test and Instantly warmup all called them healthy. The listing was
// found by a hand-typed dig and nothing would have found it again.
describe('MON-035 is registered and its view exists', () => {
  const migrationsDir = join(process.cwd(), 'supabase', 'migrations')
  const MIGRATION = '20260928180000_blocklist_check_and_mon_035.sql'
  const sql = () => readFileSync(join(migrationsDir, MIGRATION), 'utf-8')

  it('is in the registry, paired with its view', () => {
    expect(MONITORS).toContainEqual(['MON-035', 'mon_035'])
  })

  it('the migrations create the view it names', () => {
    expect(sql()).toMatch(/CREATE OR REPLACE VIEW public\.mon_035/)
  })

  // The view reads a stored verdict, so it is useless without the table, and the table is
  // useless unless the cron writes it. All three are asserted so they cannot drift apart.
  it('the same migration creates the table the view reads', () => {
    expect(sql()).toMatch(/CREATE TABLE IF NOT EXISTS public\.blocklist_check_snapshot/)
  })

  it('and the cron route actually writes it', () => {
    const store = readFileSync(
      join(migrationsDir, '..', '..', 'src', 'lib', 'blocklist', 'store.ts'),
      'utf-8',
    )
    expect(store).toContain('blocklist_check_snapshot')
    const route = readFileSync(
      join(migrationsDir, '..', '..', 'src', 'app', 'api', 'cron', 'blocklist-check', 'route.ts'),
      'utf-8',
    )
    expect(route).toContain('writeBlocklistSnapshot')
  })

  // It is registered in monitor_checks in the SAME migration. monitor_events.check_code is a
  // foreign key, so a view and a MONITORS entry without this row means every sweep insert is
  // rejected and the new monitor records nothing while looking registered. That has already
  // cost this project twice: MON-033, then MON-034 two days later.
  it('seeds its monitor_checks row, which MON-033 and MON-034 both forgot', () => {
    expect(sql()).toMatch(/INSERT INTO public\.monitor_checks/)
    expect(sql()).toContain("'MON-035'")
  })

  it('declares its cron job in cron_schedule_registry, so MON-025 can see drift', () => {
    expect(sql()).toMatch(/INSERT INTO public\.cron_schedule_registry/)
    expect(sql()).toContain("'blocklist-check'")
  })

  it('never commits the cron secret', () => {
    // The scheduled command carries a bearer token. Every cron migration here uses a
    // placeholder replaced at apply time; a real 64-char secret in this file would be the
    // 2026-08-26 leak repeated.
    const text = sql()
    expect(text).toContain('REDACTED_CRON_SECRET_IN_COMMAND')
    expect(text, 'a 64-character hex string in a committed migration is a leaked secret')
      .not.toMatch(/\b[0-9a-f]{64}\b/)
  })

  // Service role only. RLS is one layer and the GRANT is the other; a view runs as its owner
  // unless security_invoker is set, so an anon grant here would be a read straight past RLS.
  it('is revoked from anon and authenticated in both directions, view and table', () => {
    expect(sql()).toMatch(/REVOKE ALL ON public\.mon_035 FROM anon, authenticated/)
    expect(sql()).toMatch(/GRANT SELECT ON public\.mon_035 TO service_role/)
    expect(sql()).toMatch(
      /REVOKE ALL ON TABLE public\.blocklist_check_snapshot FROM anon, authenticated/,
    )
    expect(sql()).toMatch(/ENABLE ROW LEVEL SECURITY/)
  })

  // The born-dark rule. Every "no domain is listed" claim is trivially true over zero
  // domains, and a check born dark reporting OK is the failure this whole family avoids.
  it('reports UNKNOWN rather than OK when it had nothing to check', () => {
    const text = sql()
    expect(text).toMatch(/domains_checked FROM snap\) = 0\s+THEN 'UNKNOWN'/)
    expect(text).toContain('not a pass')
  })

  it('checks freshness BEFORE it reads any count', () => {
    // A stale all-clear is not an all-clear. The freshness branch must come first, or a dead
    // cron leaves its last green verdict on the board for ever.
    const text = sql()
    const freshness = text.indexOf("interval '48 hours'")
    const listed = text.indexOf('listed_count FROM snap) > 0')
    expect(freshness).toBeGreaterThan(-1)
    expect(listed).toBeGreaterThan(-1)
    expect(freshness, 'freshness must be evaluated before findings').toBeLessThan(listed)
  })

  it('treats a control failure as PROBLEM, ahead of any finding', () => {
    // An instrument that cannot see is a fault to fix, not an absence of data, and it must
    // outrank the counts below it because those counts are unsafe to read.
    const text = sql()
    const control = text.indexOf('control_failure_count FROM snap) > 0')
    const listed = text.indexOf('listed_count FROM snap) > 0')
    expect(control).toBeGreaterThan(-1)
    expect(control, 'a blind instrument must be reported before its clean counts')
      .toBeLessThan(listed)
    expect(text).toMatch(/control_failure_count FROM snap\) > 0\s+THEN 'PROBLEM'/)
  })
})
