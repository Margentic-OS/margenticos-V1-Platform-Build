import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient } from '@/test-utils/test-database'

/**
 * THE DEFECT THESE TESTS EXIST FOR.
 *
 * Six liveness views derived their state from staleness alone. cron_heartbeats.ok
 * was read into the DETAIL string and never into the STATE, so a job that ran
 * exactly on schedule and failed every single run reported OK.
 *
 * Measured, not hypothetical: on 2026-09-03 the monitor sweep failed five
 * consecutive runs writing ok=false, and MON-005, the monitor that watches the
 * sweep, showed OK for the whole hour.
 *
 * Production cannot demonstrate the fix, because every cron is currently healthy
 * (all thirteen job_names read latest_ok = true on 2026-09-04). So these tests
 * carry the whole weight of proving it, and they are written so they cannot pass
 * by accident:
 *
 *   1. A run that SUCCEEDED on time  -> OK       (the fixture works at all)
 *   2. A LATER run that FAILED on time -> PROBLEM  (the fix; this is what goes red
 *                                                   when the clause is deleted)
 *   3. A LATER run that SUCCEEDED    -> OK       (it reads the LATEST run, not
 *                                                 "any failure in a window", and
 *                                                 it recovers)
 *
 * Step 1 exists specifically so step 2 cannot pass vacuously. If a seeded value
 * and the expected value happened to agree, step 1 would already be asserting the
 * monitor is OK, so step 2's flip to PROBLEM can only come from the failing run
 * inserted between them.
 *
 * Needs the TEST database, never production. Run:
 *   npx dotenv -e .env.test.local -- npx vitest run src/__tests__/api/monitor/monitor_state_latest_run.test.ts
 */

let serviceClient: SupabaseClient<Database>

/**
 * The six views this fix covers, paired with the job_name each one watches.
 *
 * ONE ARRAY OF PAIRS, not two parallel arrays, for the reason written at length in
 * monitor-sweep/monitors.ts: parallel arrays drifted there twice and the second
 * drift survived its own fix.
 */
const COVERED = [
  ['mon_001', 'auto-approve', ''],
  ['mon_002', 'instantly-poll', ''],
  ['mon_003', 'process-replies', ''],
  ['mon_004', 'reap-agent-runs', ''],
  ['mon_005', 'monitor-sweep', ''],
  // mon_010 gained a FORMAT CONTRACT on 2026-09-07. It parses the organisation count
  // out of the detail and cross-checks it against the organisations that existed at
  // run time, and it reports UNKNOWN rather than OK when it cannot parse.
  //
  // So this file must hand it a well-formed detail, or every mon_010 case here would
  // read UNKNOWN and this test would be measuring the parser instead of the thing it
  // is for. The prefix keeps `ok` the ONLY variable across the three runs below, which
  // is the same reason the timestamps sit well inside every staleness threshold.
  //
  // The count is deliberately larger than any plausible organisation count, so the
  // cross-check cannot fire here either. The cross-check has its own coverage in
  // the migration's BEGIN..ROLLBACK verification and in resolve-auto-held/route.test.ts.
  ['mon_010', 'resolve-auto-held', 'Examined 999999 organisations, resolved 0 meetings. '],
] as const

/** Heartbeat rows this file inserted, deleted by id in afterAll. */
const insertedIds: number[] = []

/** Writes one heartbeat and returns nothing but its recorded id, for cleanup. */
async function writeHeartbeat(
  jobName: string,
  ok: boolean,
  ranAt: Date,
  detail: string,
): Promise<void> {
  const { data, error } = await serviceClient
    .from('cron_heartbeats')
    .insert({ job_name: jobName, ok, ran_at: ranAt.toISOString(), detail })
    .select('id')
    .single()

  expect(error, `could not write heartbeat for ${jobName}`).toBeNull()
  insertedIds.push(data!.id)
}

/** Reads one monitor view and returns its state and detail. */
async function readMonitor(viewName: string): Promise<{ state: string; detail: string | null }> {
  const { data, error } = await serviceClient
    .from(viewName as 'mon_001')
    .select('check_code, state, detail')
    .single()

  expect(error, `could not read ${viewName}`).toBeNull()
  return { state: data!.state as string, detail: data!.detail as string | null }
}

describe('liveness monitor state reads whether the LATEST run succeeded', () => {
  beforeAll(() => {
    serviceClient = createTestServiceClient('monitor_state_latest_run.test.ts')
  })

  afterAll(async () => {
    if (insertedIds.length === 0) return
    const { error } = await serviceClient.from('cron_heartbeats').delete().in('id', insertedIds)
    // A failed cleanup must be loud. Stranded rows are what put eight test
    // organisations into production in August.
    expect(error, 'heartbeat cleanup failed, rows may be stranded').toBeNull()
  })

  for (const [viewName, jobName, detailPrefix] of COVERED) {
    describe(`${viewName} (${jobName})`, () => {
      // Three runs, seconds apart and all well inside every staleness threshold
      // (the tightest is 10 minutes), so staleness can never be what moves the
      // state. The only variable across the three is `ok`.
      const base = Date.now()
      const ranFirst = new Date(base - 3000)
      const ranSecond = new Date(base - 2000)
      const ranThird = new Date(base - 1000)

      it('reports OK after a run that was on time and succeeded', async () => {
        await writeHeartbeat(jobName, true, ranFirst, detailPrefix + 'first run, succeeded')

        const { state } = await readMonitor(viewName)
        expect(state, `${viewName} should be OK after an on-time successful run`).toBe('OK')
      })

      it('reports PROBLEM when the latest run was ON TIME but FAILED', async () => {
        // THE TEST. Deleting "WHEN latest.ok = false THEN 'PROBLEM'" from the view
        // makes this line go red, and nothing else in the suite notices.
        await writeHeartbeat(jobName, false, ranSecond, detailPrefix + 'second run, failed')

        const { state, detail } = await readMonitor(viewName)
        expect(
          state,
          `${viewName} ran on time and FAILED, and still reported ${state}. This is the ` +
            'defect: a silent monitor reads on the board as a healthy one.',
        ).toBe('PROBLEM')
        expect(detail, 'the detail should name the failure, not a stale success').toContain(
          'second run, failed',
        )
      })

      it('returns to OK on the next successful run, and drops the old failure detail', async () => {
        // Two things at once. It proves the state follows the LATEST run rather
        // than "any failure in a window", which is what separates this shape from
        // mon_019/mon_020. And it proves the frozen-detail defect is gone: the old
        // views built detail with max(CASE WHEN ok = false THEN detail END) over
        // ALL history with no time bound, so one bad run poisoned the detail line
        // for ever. MON-005 was live proof, showing OK beside a failure message
        // from the previous day.
        await writeHeartbeat(jobName, true, ranThird, detailPrefix + 'third run, succeeded')

        const { state, detail } = await readMonitor(viewName)
        expect(state, `${viewName} should recover once a later run succeeds`).toBe('OK')
        expect(
          detail,
          'the detail still quotes a failure that has since been superseded',
        ).not.toContain('second run, failed')
      })
    })
  }

  it('covers every view whose state depends on a heartbeat and is not window-based', () => {
    // Guard the guard. If a seventh heartbeat-backed liveness view is added and
    // not listed above, this file silently stops covering it, which is the exact
    // shape of the original MON-019 bug: a monitor that exists and is never read.
    //
    // mon_016 already had the fix before this migration. mon_019, mon_020 and
    // mon_021 deliberately keep the window shape and are out of scope here.
    expect(COVERED.length, 'COVERED no longer lists six views').toBe(6)
    const views = COVERED.map(([v]) => v)
    // A view with a format contract must be handed a detail that satisfies it, or its
    // cases here silently measure the parser rather than the ok-follows-latest rule.
    const mon010 = COVERED.find(([v]) => v === 'mon_010')
    expect(mon010?.[2], 'mon_010 needs a well-formed detail prefix').toMatch(
      /^Examined \d+ organisations/,
    )
    expect(new Set(views).size, 'duplicate view in COVERED').toBe(views.length)
    for (const [view, job] of COVERED) {
      expect(view, `${view} is not a mon_NNN view name`).toMatch(/^mon_\d{3}$/)
      expect(job, `${view} has no job name`).toBeTruthy()
    }
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // MON-010 CROSS-CHECKS THE WORLD, NOT ONLY THE JOB'S SELF-REPORT
  //
  // These live in THIS file, not a file of their own, deliberately. Both would write
  // resolve-auto-held heartbeats and both read "the latest one", so as separate files
  // running in parallel they would race and flake. Vitest runs tests within a file
  // sequentially, which is the property being relied on.
  //
  // WHY THE CHECK EXISTS. resolve-auto-held ran as `anon` from 2026-08-09 to
  // 2026-09-07 and reported ok=true on every one of 31 runs while three live
  // organisations existed. MON-010 read only freshness and `ok`, both written by the
  // path that had already swallowed the denied read, so it could not have caught it
  // once. Reading the organisation count independently is what makes that visible.
  // ═══════════════════════════════════════════════════════════════════════════
  describe('mon_010 organisation cross-check', () => {
    /** Live organisations in this database, which is what the view compares against. */
    async function liveOrgCount(): Promise<number> {
      const { count, error } = await serviceClient
        .from('organisations')
        .select('id', { count: 'exact', head: true })
        .is('archived_at', null)
      expect(error, 'could not count organisations').toBeNull()
      return count ?? 0
    }

    it('PROBLEM when the run reports ok but examined FEWER organisations than exist', async () => {
      const orgs = await liveOrgCount()
      // The guard is meaningless against an empty table, so prove there is something
      // to under-count before asserting that under-counting is caught.
      expect(orgs, 'no organisations in this database, the cross-check cannot be tested').toBeGreaterThan(0)

      await writeHeartbeat(
        'resolve-auto-held',
        true,
        new Date(),
        'Examined 0 organisations, resolved 0 meetings',
      )

      const { state, detail } = await readMonitor('mon_010')

      // THE TEST. Deleting "WHEN p.examined < p.org_count THEN 'PROBLEM'" from the
      // view makes this line go red, and nothing else in the suite notices.
      expect(
        state,
        'the run claimed success over zero organisations while organisations exist, ' +
          'and MON-010 still reported ' + state + '. This is the defect the check exists for.',
      ).toBe('PROBLEM')
      expect(detail, 'the detail should name both counts').toContain('examined only 0 organisation(s)')
    })

    it('OK when the run examined at least as many organisations as exist', async () => {
      await writeHeartbeat(
        'resolve-auto-held',
        true,
        new Date(),
        'Examined 999999 organisations, resolved 0 meetings',
      )

      const { state, detail } = await readMonitor('mon_010')
      expect(state, 'a run that examined everything should be OK').toBe('OK')
      expect(detail, 'the OK detail should say it cross-checked').toContain('cross-checked against')
    })

    it('UNKNOWN, never OK, when the detail cannot be parsed', async () => {
      // The exact wording the job wrote for all 31 runs of the outage. It must not be
      // silently parsed, and it must not read as healthy.
      await writeHeartbeat(
        'resolve-auto-held',
        true,
        new Date(),
        'Processed 0 organisations, resolved 0 meetings',
      )

      const { state, detail } = await readMonitor('mon_010')
      expect(
        state,
        'a check that could not perform its comparison must not report the colour ' +
          'that means "I compared and it was fine"',
      ).toBe('UNKNOWN')
      expect(detail).toContain('does not match the expected')
    })
  })
})
