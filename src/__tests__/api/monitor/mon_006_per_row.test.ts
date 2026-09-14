import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient } from '@/test-utils/test-database'
import { deleteTestOrganisations } from '@/test-utils/delete-test-organisations'

// Test MON-006 per-row window evaluation (not single-org window).
// Needs the TEST database, never production. Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/__tests__/api/monitor/mon_006_per_row.test.ts
//
// process.exit(0) removed here for the same reason as monitor-acknowledge: it
// terminates the worker rather than skipping the suite, so any file sharing that
// worker stops reporting too.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS MEASURES A DIFFERENCE INSTEAD OF READING A STATE
//
// mon_006 is a single-row aggregate over EVERY organisation. It has no org
// dimension, so there is no filter a caller can add to narrow it. This file used
// to seed two organisations and then assert state = 'OK' on that global row. That
// is an assertion about the whole shared test database, not about anything this
// test created, and one pending overdue revision belonging to anyone else turns
// it red.
//
// It did, and it ratcheted. Measured on 2026-09-14, the test project held 56
// pending client_revision rows carrying this file's own marker, left by 28 runs
// between 2026-09-08 and 2026-09-11. The in-test cleanup sat AFTER the assertion,
// so a failure left its two rows behind; those rows then aged past their window,
// became overdue, and failed the next run. (They were stranded by worktrees whose
// copy of this file predates the checked cleanup in 0e96f89. On this tree afterAll
// does remove them, through the ON DELETE CASCADE from organisations.)
//
// So each test now reads mon_006 before and after its own inserts and asserts the
// CHANGE in the overdue count. That is scoped to this file's rows by construction:
// anything else in the database appears in both readings and cancels. It is also
// stricter than the assertion it replaces, because the expected delta names which
// of the two seeded rows must count as overdue and which must not.
//
// The overdue count is the right quantity to difference for a second reason. Rows
// written by other test files (documents/revise) are created at now(), so they are
// never overdue and cannot move it, which keeps the difference stable against a
// parallel worker.
//
// The cleanup is now in a finally, so it no longer depends on the assertion above
// it passing.

let serviceClient: SupabaseClient<Database>

interface Mon006Reading {
  state: string
  detail: string
  overdueCount: number
}

/**
 * Reads the one mon_006 row and recovers the overdue count from it.
 *
 * The view prints that count only in its PROBLEM branch, but it also sets PROBLEM
 * if and only if overdue_count > 0, so any other state means zero overdue. That is
 * read off the view's own CASE expression rather than off the wording of a message.
 */
async function readMon006(): Promise<Mon006Reading> {
  const { data, error } = await serviceClient
    .from('mon_006')
    .select('check_code, state, detail')
    .single()

  expect(error).toBeNull()
  expect(data).toBeDefined()
  expect(data!.check_code).toBe('MON-006')

  const { state, detail } = data!
  if (state === null || detail === null) {
    throw new Error(
      `mon_006 returned a null state or detail, so this test can measure nothing. ` +
        `state=${state} detail=${detail}`,
    )
  }

  if (state !== 'PROBLEM') return { state, detail, overdueCount: 0 }

  const match = /^(\d+) overdue revision/.exec(detail)
  if (!match) {
    throw new Error(
      `mon_006 is PROBLEM but its detail does not open with an overdue count, so this ` +
        `test cannot measure its own contribution to it. detail was: ${detail}`,
    )
  }
  return { state, detail, overdueCount: Number(match[1]) }
}

/**
 * Removes the rows one test seeded, and THROWS if it cannot, for the reason set out
 * in src/test-utils/delete-test-organisations.ts: a bare `await` on a PostgREST
 * delete discards the error, so the suite reports green while the row is still there.
 */
async function deleteSeededSuggestions(fieldPath: string): Promise<void> {
  const { error } = await serviceClient
    .from('document_suggestions')
    .delete()
    .eq('field_path', fieldPath)

  if (error) {
    throw new Error(
      `[test-cleanup] mon_006_per_row.test.ts: could not delete document_suggestions ` +
        `with field_path ${fieldPath}.\n  ${error.code ?? 'no-code'}: ${error.message}\n` +
        `  Cleanup must not fail silently. Fix the cause; do not swallow this.`,
    )
  }
}

describe('MON-006 Per-Row Window Evaluation', () => {
  let shortWindowOrgId: string
  let longWindowOrgId: string
  const testMarker = `mon-006-test-${Date.now()}`

  beforeAll(async () => {
    serviceClient = createTestServiceClient('mon_006_per_row.test.ts')

    // Create short-window org (default 72 hours, but override to 1 hour)
    const { data: shortOrg, error: shortError } = await serviceClient
      .from('organisations')
      .insert({
        name: `MON-006 Short Window ${testMarker}`,
        slug: `mon-006-short-${Date.now()}`,
        auto_approve_window_hours: 1,
      })
      .select()
      .single()
    expect(shortError).toBeNull()
    shortWindowOrgId = shortOrg!.id

    // Create long-window org (10 hours)
    const { data: longOrg, error: longError } = await serviceClient
      .from('organisations')
      .insert({
        name: `MON-006 Long Window ${testMarker}`,
        slug: `mon-006-long-${Date.now()}`,
        auto_approve_window_hours: 10,
      })
      .select()
      .single()
    expect(longError).toBeNull()
    longWindowOrgId = longOrg!.id
  })

  afterAll(async () => {
    // Sweep anything this file seeded, by marker, before the organisations go. The
    // foreign key cascades, so this is belt and braces, but it means a cleanup that
    // cannot clear these rows says document_suggestions rather than surfacing later
    // as an organisation that would not delete.
    const { error: sweepError } = await serviceClient
      .from('document_suggestions')
      .delete()
      .like('field_path', `${testMarker}%`)

    // The organisations go whatever happened above, so a failed sweep cannot leak
    // them. The sweep's own failure is raised afterwards rather than swallowed.
    await deleteTestOrganisations(
      serviceClient,
      [shortWindowOrgId, longWindowOrgId],
      'mon_006_per_row.test.ts',
    )

    if (sweepError) {
      throw new Error(
        `[test-cleanup] mon_006_per_row.test.ts: could not sweep document_suggestions ` +
          `for marker ${testMarker}.\n  ${sweepError.code ?? 'no-code'}: ${sweepError.message}`,
      )
    }
  })

  it('counts a revision past its own org window, and not one still inside a longer window', async () => {
    // Scenario:
    // - Short-window org (1 hour): has a revision that's 2 hours old → OVERDUE
    // - Long-window org (10 hours): has a revision that's 8 hours old → NOT OVERDUE
    // Expected: the view's overdue count rises by exactly one.

    const now = new Date()
    const twoHoursAgo = new Date(now.getTime() - 2 * 3600000).toISOString()
    const eightHoursAgo = new Date(now.getTime() - 8 * 3600000).toISOString()

    const testId = `${testMarker}-overdue`
    const before = await readMon006()

    try {
      // Insert pending client_revision in short-window org (2 hours old, exceeds 1-hour window)
      const { error: shortError } = await serviceClient
        .from('document_suggestions')
        .insert({
          organisation_id: shortWindowOrgId,
          status: 'pending',
          update_trigger: 'client_revision',
          created_at: twoHoursAgo,
          document_type: 'icp',
          field_path: testId,
          suggested_value: 'test',
        })
      expect(shortError).toBeNull()

      // Insert pending client_revision in long-window org (8 hours old, within 10-hour window)
      const { error: longError } = await serviceClient
        .from('document_suggestions')
        .insert({
          organisation_id: longWindowOrgId,
          status: 'pending',
          update_trigger: 'client_revision',
          created_at: eightHoursAgo,
          document_type: 'icp',
          field_path: testId,
          suggested_value: 'test',
        })
      expect(longError).toBeNull()

      const after = await readMon006()

      // Both halves of per-row evaluation are in this one number. A delta of 2 would
      // mean the 8-hour row had been judged against the 1-hour window; a delta of 0
      // would mean the 2-hour row had not been judged against its own.
      expect(after.overdueCount - before.overdueCount).toBe(1)

      // Adding an overdue row can only move the view towards PROBLEM, so unlike the
      // OK case below this one does hold whatever else is in the shared database.
      expect(after.state).toBe('PROBLEM')
      expect(after.detail).toContain('overdue')
    } finally {
      await deleteSeededSuggestions(testId)
    }
  })

  it('counts neither revision while both are inside their own org windows', async () => {
    // Scenario:
    // - Short-window org (1 hour): has a revision that's 30 minutes old → OK
    // - Long-window org (10 hours): has a revision that's 8 hours old → OK
    // Expected: the view's overdue count does not move.

    const now = new Date()
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60000).toISOString()
    const eightHoursAgo = new Date(now.getTime() - 8 * 3600000).toISOString()

    const testId = `${testMarker}-ok`
    const before = await readMon006()

    try {
      // Insert within short-window
      const { error: shortError } = await serviceClient
        .from('document_suggestions')
        .insert({
          organisation_id: shortWindowOrgId,
          status: 'pending',
          update_trigger: 'client_revision',
          created_at: thirtyMinAgo,
          document_type: 'icp',
          field_path: testId,
          suggested_value: 'test',
        })
      expect(shortError).toBeNull()

      // Insert within long-window
      const { error: longError } = await serviceClient
        .from('document_suggestions')
        .insert({
          organisation_id: longWindowOrgId,
          status: 'pending',
          update_trigger: 'client_revision',
          created_at: eightHoursAgo,
          document_type: 'icp',
          field_path: testId,
          suggested_value: 'test',
        })
      expect(longError).toBeNull()

      const after = await readMon006()

      // Neither seeded row is past its own window, so neither may be counted. This is
      // the assertion that replaces the old global state read, and it is the one that
      // always runs.
      expect(after.overdueCount - before.overdueCount).toBe(0)

      // Extra, and it binds only when nothing else in the shared test database has an
      // overdue revision. It covers the OK branch's state and wording, which no
      // difference can reach. It is deliberately not the primary assertion: making it
      // unconditional is exactly the defect this file was rewritten to remove.
      if (before.overdueCount === 0) {
        expect(after.state).toBe('OK')
        expect(after.detail).toContain('within window')
      }
    } finally {
      await deleteSeededSuggestions(testId)
    }
  })
})
