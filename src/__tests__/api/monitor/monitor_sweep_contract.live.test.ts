import { describe, it, expect, beforeAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient } from '@/test-utils/test-database'
import { MONITORS } from '@/app/api/cron/monitor-sweep/monitors'

/**
 * THE DEFECT THESE TESTS EXIST FOR.
 *
 * MON-033 shipped on 2026-09-21 with its view, its two prospects columns and its grants,
 * and WITHOUT its row in monitor_checks. monitor_events.check_code is
 * NOT NULL REFERENCES monitor_checks(code), so every sweep read the view fine and then
 * failed to write:
 *
 *   ERROR: 23503: insert or update on table "monitor_events" violates foreign key
 *   constraint "monitor_events_check_code_fkey"
 *   DETAIL: Key (check_code)=(MON-033) is not present in table "monitor_checks".
 *
 * results.checked++ runs after the reads succeed and only results.errors sees the failed
 * write, so the sweep reported "Checked 30 monitors, 1 error(s)", set its own heartbeat
 * ok=false, and MON-005 went PROBLEM about the sweep rather than about MON-033. The
 * monitor built to catch a document short a variant recorded ZERO events for 16 hours.
 *
 * WHY THE EXISTING TESTS ALL PASSED. Every MON-033 test in monitor-sweep-pairs.test.ts
 * reads the MIGRATION FILE and proves the view, the columns and the grants are declared.
 * The sweep's contract has a second half no view can exercise on its own: it WRITES the
 * check code through a foreign key. Reading mon_033 in isolation proves the read half,
 * and the read half was never broken. This is the seam that had tests on both ends and
 * none on the join.
 *
 * WHY THIS IS A LIVE TEST AND NOT A MIGRATION SCAN. A scan would assert something FALSE
 * here: the migrations only ever INSERT 'MON-010-UNSCHEDULED', while the live registry
 * holds 'MON-010', renamed by a statement that is in no migration file. Migrations are
 * append-only and describe history; monitor_checks is what the foreign key actually
 * consults. Only the live catalog can answer this one.
 *
 * Run:
 *   npx dotenv -e .env.test.local -- npx vitest run \
 *     src/__tests__/api/monitor/monitor_sweep_contract.live.test.ts
 */

let serviceClient: SupabaseClient<Database>

/** Exactly the columns the sweep names in route.ts. Not a guess, and not `*`. */
const SWEEP_SELECT = 'check_code, state, detail'

/** The states monitor_events accepts. A view emitting anything else fails the CHECK. */
const VALID_STATES = ['OK', 'PROBLEM', 'UNKNOWN']

/**
 * KNOWN TEST-DATABASE DRIFT, measured 2026-09-21.
 *
 * These monitors' migrations were applied to production and never to the test project, so
 * their views do not exist here. They are NOT skipped silently: every monitor outside this
 * set must satisfy the full contract, and the assertion below is a SUBSET check, so
 * repairing the drift keeps this file green while a NEW absence turns it red.
 *
 * Production carries none of this: all 30 views and all 30 registry rows are present
 * there, read back 2026-09-21.
 */
const VIEWS_ABSENT_FROM_TEST_DB = ['mon_024', 'mon_027', 'mon_028', 'mon_029']

/** Same drift, registry side. MON-033 was removed from this list by the fix. */
const REGISTRY_ABSENT_FROM_TEST_DB = [
  'MON-024', 'MON-026', 'MON-027', 'MON-028', 'MON-029', 'MON-031', 'MON-032',
]

beforeAll(() => {
  serviceClient = createTestServiceClient('monitor sweep contract')
})

describe('every monitor satisfies the contract the sweep actually uses', () => {
  it('has monitors to check at all, so nothing below can pass vacuously', () => {
    // Guard the guard. An empty MONITORS list would make every per-monitor test below
    // trivially green, which is the exact shape CLAUDE.md keeps relearning.
    expect(MONITORS.length).toBeGreaterThan(25)
  })

  // ── The READ half ────────────────────────────────────────────────────────────
  it('each view returns exactly one row exposing check_code, state and detail', async () => {
    const failures: string[] = []
    let checked = 0

    for (const [checkCode, viewName] of MONITORS) {
      if (VIEWS_ABSENT_FROM_TEST_DB.includes(viewName)) continue

      // .single() is what the sweep uses, so zero rows and two rows both fail here for
      // the same reason they would fail in production.
      // `as 'mon_001'` is the idiom this repo already uses for a dynamic view name:
      // every mon_ view shares these three columns, so one of them stands in for the type.
      const { data, error } = await serviceClient
        .from(viewName as 'mon_001')
        .select(SWEEP_SELECT)
        .single()

      if (error || !data) {
        failures.push(`${checkCode}: ${viewName} did not return one row (${error?.message ?? 'no data'})`)
        continue
      }

      const row = data as unknown as Record<string, unknown>
      if (row.check_code !== checkCode) {
        failures.push(`${checkCode}: ${viewName} reports check_code '${String(row.check_code)}'`)
      }
      if (!VALID_STATES.includes(String(row.state))) {
        failures.push(`${checkCode}: state '${String(row.state)}' is not one of ${VALID_STATES.join('/')}`)
      }
      if (!('detail' in row)) {
        failures.push(`${checkCode}: ${viewName} has no detail column`)
      }
      checked++
    }

    expect(checked, 'no views were read, so this test proves nothing').toBeGreaterThan(20)
    expect(failures, `views that do not match what the sweep selects:\n${failures.join('\n')}`).toEqual([])
  })

  // ── The WRITE half. THIS IS THE ONE MON-033 BROKE. ──────────────────────────
  it('each check code has a monitor_checks row, so the sweep can record it', async () => {
    const { data, error } = await serviceClient.from('monitor_checks').select('code')
    expect(error, `could not read monitor_checks: ${error?.message}`).toBeNull()

    const registered = new Set((data ?? []).map(r => (r as { code: string }).code))
    expect(registered.size, 'monitor_checks is empty, so this test proves nothing').toBeGreaterThan(20)

    const missing = MONITORS
      .map(([code]) => code)
      .filter(code => !registered.has(code))
      .filter(code => !REGISTRY_ABSENT_FROM_TEST_DB.includes(code))

    expect(
      missing,
      'these monitors are in the sweep and have no monitor_checks row, so every sweep ' +
      'will read their view, fail the monitor_events insert on ' +
      'monitor_events_check_code_fkey, and mark its own heartbeat ok=false. The monitor ' +
      `itself stays dark and MON-005 reports the failure instead: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('MON-033 specifically is registered, which is the bug this file was written for', async () => {
    const { data, error } = await serviceClient
      .from('monitor_checks')
      .select('code, title, category')
      .eq('code', 'MON-033')
      .maybeSingle()

    expect(error, `read failed: ${error?.message}`).toBeNull()
    expect(data, 'MON-033 has no monitor_checks row; the sweep cannot record it').not.toBeNull()
  })

  // ── The two halves together ─────────────────────────────────────────────────
  it('the sweep\'s real insert succeeds for every monitor, then is rolled back', async () => {
    // The end-to-end proof: read each view the way the sweep does, then write the row the
    // sweep writes. A registry gap fails on the write exactly as it does in production.
    //
    // Cleaned up by id rather than left to a truncate, so a crash between insert and
    // delete strands at most one marked row per monitor.
    const marker = `contract-test-${Date.now()}`
    const inserted: number[] = []
    const failures: string[] = []

    for (const [checkCode] of MONITORS) {
      if (REGISTRY_ABSENT_FROM_TEST_DB.includes(checkCode)) continue

      const { data, error } = await serviceClient
        .from('monitor_events')
        .insert({ check_code: checkCode, state: 'UNKNOWN', detail: marker })
        .select('id')
        .single()

      if (error || !data) {
        failures.push(`${checkCode}: ${error?.message ?? 'insert returned nothing'}`)
        continue
      }
      inserted.push((data as { id: number }).id)
    }

    if (inserted.length > 0) {
      await serviceClient.from('monitor_events').delete().in('id', inserted)
    }

    expect(inserted.length, 'no events were inserted, so this test proves nothing').toBeGreaterThan(20)
    expect(
      failures,
      `the sweep's monitor_events insert fails for these monitors:\n${failures.join('\n')}`,
    ).toEqual([])
  })

  it('leaves no rows behind', async () => {
    const { data, error } = await serviceClient
      .from('monitor_events')
      .select('id')
      .like('detail', 'contract-test-%')

    expect(error).toBeNull()
    expect(data ?? [], 'the insert test stranded rows in monitor_events').toEqual([])
  })
})
