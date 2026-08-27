import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { VERDICT_MAX_AGE_MINUTES } from '../thresholds'
import { MONITORS } from '@/app/api/cron/monitor-sweep/monitors'

/**
 * THE PAIR TEST.
 *
 * Almost all of MON-023's judgement is in TypeScript, where the rest of this suite can
 * reach it. Two things cannot be: the freshness comparison, which must happen at READ
 * time and therefore inside the view, and the mapping from the four health states onto
 * the sweep's three.
 *
 * Those two are duplicated between thresholds.ts / monitor-state.ts and the migration.
 * CLAUDE.md is explicit that a producer and a consumer which must agree need a test
 * exercising the PAIR, not each side alone — the Apollo handler wrote "Germany", the send
 * rule matched 'DE', both sides had passing tests, and two German prospects were mailed.
 *
 * This suite cannot run the SQL. It can read it, and it fails if the two stop agreeing.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

function findMigration(): string {
  const file = readdirSync(MIGRATIONS_DIR).find(f => f.includes('sending_domain_health'))
  if (!file) throw new Error('sending_domain_health migration not found')
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
}

describe('mon_023 SQL agrees with the TypeScript it mirrors', () => {
  const sql = findMigration()

  it('finds the migration and it is not empty, so this suite cannot pass vacuously', () => {
    expect(sql.length).toBeGreaterThan(500)
    expect(sql).toContain('CREATE OR REPLACE VIEW public.mon_023')
  })

  it(`uses the same freshness limit as VERDICT_MAX_AGE_MINUTES (${VERDICT_MAX_AGE_MINUTES})`, () => {
    // The one comparison that has to live in SQL. If someone tunes the constant in
    // TypeScript and forgets the view, the monitor and the dashboard would disagree about
    // whether the same verdict is trustworthy.
    const occurrences = sql.match(/interval '(\d+) minutes'/g) ?? []
    expect(occurrences.length, 'expected the staleness interval in the view').toBeGreaterThan(0)
    for (const occurrence of occurrences) {
      expect(occurrence).toBe(`interval '${VERDICT_MAX_AGE_MINUTES} minutes'`)
    }
  })

  it('mentions the limit in the operator-facing detail text too', () => {
    expect(sql).toContain(`${VERDICT_MAX_AGE_MINUTES}-minute limit`)
  })

  it('constrains overall_state to exactly the four states the writer can produce', () => {
    // 'stale' must NOT be here: staleness is a property of the row's age, not something
    // a writer can stamp into it.
    const match = sql.match(/overall_state\s+text NOT NULL CHECK \(overall_state IN \(([^)]*)\)\)/)
    expect(match, 'overall_state CHECK constraint not found').not.toBeNull()
    const listed = match![1].split(',').map(s => s.trim().replace(/'/g, ''))
    expect(new Set(listed)).toEqual(new Set(['no_data', 'insufficient_sends', 'healthy', 'failing']))
    expect(listed).not.toContain('stale')
  })

  it('maps failing to PROBLEM and no_data to UNKNOWN, matching resolveMonitorState', () => {
    expect(sql).toMatch(/overall_state FROM snap\) = 'failing' THEN 'PROBLEM'/)
    expect(sql).toMatch(/overall_state FROM snap\) = 'no_data' THEN 'UNKNOWN'/)
  })

  it('checks freshness BEFORE it reads the verdict', () => {
    // Order matters: a stale 'failing' and a stale 'healthy' must both report stale.
    const stalePos   = sql.indexOf("< now() - interval")
    const verdictPos = sql.indexOf("= 'failing' THEN 'PROBLEM'")
    expect(stalePos).toBeGreaterThan(-1)
    expect(verdictPos).toBeGreaterThan(-1)
    expect(stalePos, 'the freshness branch must come first in the CASE').toBeLessThan(verdictPos)
  })

  it('leaves insufficient_sends falling through to OK, not to UNKNOWN', () => {
    // Mapping it to UNKNOWN would make the check dark from birth: the sweep only writes
    // an event on a state change and treats "no prior event" as UNKNOWN.
    expect(sql).not.toMatch(/= 'insufficient_sends' THEN 'UNKNOWN'/)
  })
})

describe('MON-023 is registered everywhere it has to be', () => {
  const sql = findMigration()

  it('is in the sweep registry, so something actually queries the view', () => {
    expect(MONITORS.some(([code]) => code === 'MON-023')).toBe(true)
  })

  it('is paired with mon_023', () => {
    const pair = MONITORS.find(([code]) => code === 'MON-023')
    expect(pair?.[1]).toBe('mon_023')
  })

  it('has a monitor_checks row in the SAME migration that creates the view', () => {
    // MON-008 and MON-009 are registered with no view. This is the opposite failure and
    // the guard against it is that both live in one file.
    expect(sql).toContain("INSERT INTO public.monitor_checks")
    expect(sql).toContain("'MON-023'")
  })

  it('carries all three plain-English columns, non-empty', () => {
    // The operator dashboard renders these. A check registered without them shows a bare
    // code and helps nobody at the moment it fires.
    for (const phrase of ['plain_meaning', 'plain_impact', 'plain_action']) {
      expect(sql).toContain(phrase)
    }
    // The plain_action must name where to look, not just say "investigate".
    expect(sql).toContain('per-domain table')
  })

  it('revokes anon and authenticated on both tables and the view, by name', () => {
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.sending_mailbox_daily_stats FROM anon, authenticated/)
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.sending_health_snapshot\s+FROM anon, authenticated/)
    expect(sql).toMatch(/REVOKE ALL ON\s+public\.mon_023\s+FROM anon, authenticated/)
  })

  it('enables RLS on both tables as well as revoking, not instead of', () => {
    expect(sql).toMatch(/ALTER TABLE public\.sending_mailbox_daily_stats ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/ALTER TABLE public\.sending_health_snapshot\s+ENABLE ROW LEVEL SECURITY/)
  })

  it('registers the capability rather than hardcoding the tool upstream', () => {
    expect(sql).toContain('can_report_sending_health')
    expect(sql).toContain('integrations_registry')
  })

  it('guarantees idempotency with a unique constraint on date plus mailbox', () => {
    // The receipt for "running it twice must not double any figure" is this constraint
    // plus the upsert that targets it.
    expect(sql).toMatch(/UNIQUE \(stat_date, mailbox\)/)
  })
})
