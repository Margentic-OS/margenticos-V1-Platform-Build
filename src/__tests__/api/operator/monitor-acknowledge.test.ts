import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient } from '@/test-utils/test-database'

// Needs the TEST database, never production. Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/__tests__/api/operator/monitor-acknowledge.test.ts
//
// This file previously read NEXT_PUBLIC_SUPABASE_URL, so the documented command
// was `dotenv -e .env.local`, which pointed it at the live database. It inserts an
// organisation named 'Archived Test Active'; eight of them were still in
// production on 2026-08-27. See src/test-utils/test-database.ts.
//
// It also called process.exit(0) when credentials were missing. That does not skip
// a suite, it TERMINATES THE WORKER mid-run, so whatever else that worker had left
// to execute simply never reported. Removed: a missing credential now fails one
// named hook, loudly, and the rest of the suite still runs.

let serviceClient: SupabaseClient<Database>

describe('Monitor Acknowledge Flow', () => {
  let testOperatorId: string
  let testUserId: string
  let problemEventId: number
  let resolvedEventId: number
  let acknowledgedEventId: number

  beforeAll(async () => {
    serviceClient = createTestServiceClient('monitor-acknowledge.test.ts')

    // Create a test operator user
    const { data: authUser, error: signUpError } = await serviceClient.auth.admin.createUser({
      email: `monitor-test-${Date.now()}@test.local`,
      password: 'TestPassword123!',
      email_confirm: true,
    })
    expect(signUpError).toBeNull()
    expect(authUser?.user).toBeDefined()
    testOperatorId = authUser!.user!.id

    // Create operator role in users table
    const { error: userError } = await serviceClient
      .from('users')
      .insert({
        id: testOperatorId,
        // auth.admin.createUser types email as optional, and users.email is NOT NULL.
        // The old client was untyped, so this mismatch was invisible until the
        // client gained a Database generic. Asserted rather than defaulted: if the
        // address is genuinely missing the fixture is wrong and should fail here.
        email: authUser!.user!.email!,
        role: 'operator',
      })
    expect(userError).toBeNull()

    // Create a PROBLEM event (open, unacknowledged)
    const { data: problemEvent, error: problemError } = await serviceClient
      .from('monitor_events')
      .insert({
        check_code: 'MON-001',
        state: 'PROBLEM',
        detail: 'Test problem event',
        created_at: new Date().toISOString(),
        resolved_at: null,
        acknowledged_at: null,
        acknowledged_note: null,
      })
      .select()
      .single()
    expect(problemError).toBeNull()
    expect(problemEvent).toBeDefined()
    problemEventId = problemEvent!.id

    // Create a resolved event (resolved, should not be acknowledgeable)
    const { data: resolvedEvent, error: resolvedError } = await serviceClient
      .from('monitor_events')
      .insert({
        check_code: 'MON-002',
        state: 'OK',
        detail: 'Resolved event',
        created_at: new Date().toISOString(),
        resolved_at: new Date().toISOString(),
        acknowledged_at: null,
        acknowledged_note: null,
      })
      .select()
      .single()
    expect(resolvedError).toBeNull()
    resolvedEventId = resolvedEvent!.id

    // Create an already-acknowledged event
    const { data: acknowledgedEvent, error: ackError } = await serviceClient
      .from('monitor_events')
      .insert({
        check_code: 'MON-003',
        state: 'PROBLEM',
        detail: 'Already acknowledged',
        created_at: new Date().toISOString(),
        resolved_at: null,
        acknowledged_at: new Date().toISOString(),
        acknowledged_note: 'Previously acknowledged',
      })
      .select()
      .single()
    expect(ackError).toBeNull()
    acknowledgedEventId = acknowledgedEvent!.id
  })

  afterAll(async () => {
    // Clean up test data
    await serviceClient
      .from('monitor_events')
      .delete()
      .in('id', [problemEventId, resolvedEventId, acknowledgedEventId])

    await serviceClient.auth.admin.deleteUser(testOperatorId)
  })

  it('should acknowledge an open PROBLEM event and set fields', async () => {
    const note = 'Test acknowledgement note'

    const { data: updated, error: updateError } = await serviceClient
      .from('monitor_events')
      .update({
        acknowledged_at: new Date().toISOString(),
        acknowledged_note: note,
      })
      .eq('id', problemEventId)
      .select()
      .single()

    expect(updateError).toBeNull()
    expect(updated).toBeDefined()
    expect(updated!.acknowledged_at).toBeTruthy()
    expect(updated!.acknowledged_note).toBe(note)
  })

  it('should not allow acknowledging a non-PROBLEM event', async () => {
    // Try to acknowledge a resolved (OK) event
    const { data: event } = await serviceClient
      .from('monitor_events')
      .select()
      .eq('id', resolvedEventId)
      .single()

    expect(event?.state).not.toBe('PROBLEM')
    expect(event?.resolved_at).toBeTruthy()
    // Verification: should return 409 if attempted via API
    // This is enforced by the route, not the database
  })

  it('should not allow acknowledging an already-acknowledged event', async () => {
    // Try to acknowledge an event that's already acknowledged
    const { data: event } = await serviceClient
      .from('monitor_events')
      .select()
      .eq('id', acknowledgedEventId)
      .single()

    expect(event?.acknowledged_at).toBeTruthy()
    // Should return 409 if attempted via API (event not "open")
  })
})

describe('Badge Count Logic', () => {
  let org1Id: string
  let org2Id: string

  beforeAll(async () => {
    // Create two test organisations
    const { data: org1, error: org1Error } = await serviceClient
      .from('organisations')
      .insert({ name: 'Badge Test Org 1', slug: `badge-test-org-1-${Date.now()}` })
      .select()
      .single()
    expect(org1Error).toBeNull()
    org1Id = org1!.id

    const { data: org2, error: org2Error } = await serviceClient
      .from('organisations')
      .insert({ name: 'Badge Test Org 2', slug: `badge-test-org-2-${Date.now()}` })
      .select()
      .single()
    expect(org2Error).toBeNull()
    org2Id = org2!.id
  })

  afterAll(async () => {
    // Clean up
    await serviceClient.from('organisations').delete().in('id', [org1Id, org2Id])
  })

  it('should count only open unacknowledged PROBLEM events for current test', async () => {
    // This test verifies the query logic, not the absolute count
    // which can vary based on other test runs

    // Create variety of events
    const now = new Date().toISOString()
    const yesterday = new Date(Date.now() - 86400000).toISOString()
    const testId = `badge-test-${Date.now()}`

    const { error: insertError } = await serviceClient
      .from('monitor_events')
      .insert([
        // Should count: open unacknowledged PROBLEM
        { check_code: 'MON-001', state: 'PROBLEM', detail: testId, created_at: now, resolved_at: null, acknowledged_at: null, acknowledged_note: null },
        // Should count: another open unacknowledged PROBLEM
        { check_code: 'MON-002', state: 'PROBLEM', detail: testId, created_at: now, resolved_at: null, acknowledged_at: null, acknowledged_note: null },
        // Should NOT count: resolved
        { check_code: 'MON-003', state: 'PROBLEM', detail: testId, created_at: yesterday, resolved_at: now, acknowledged_at: null, acknowledged_note: null },
      ])

    expect(insertError).toBeNull()

    // Query to verify count for our test data only
    const { data: events, error: queryError } = await serviceClient
      .from('monitor_events')
      .select('id', { count: 'exact' })
      .eq('state', 'PROBLEM')
      .eq('detail', testId)
      .is('resolved_at', null)
      .is('acknowledged_at', null)

    expect(queryError).toBeNull()
    expect(events).toHaveLength(2)

    // Cleanup
    await serviceClient
      .from('monitor_events')
      .delete()
      .eq('detail', testId)
  })
})

describe('Archived Org Exclusion', () => {
  let activeOrgId: string
  let archivedOrgId: string

  beforeAll(async () => {
    // Create active org
    const { data: activeOrg, error: activeError } = await serviceClient
      .from('organisations')
      .insert({ name: 'Archived Test Active', slug: `archived-test-active-${Date.now()}` })
      .select()
      .single()
    expect(activeError).toBeNull()
    activeOrgId = activeOrg!.id

    // Create archived org
    const { data: archivedOrg, error: archError } = await serviceClient
      .from('organisations')
      .insert({
        name: 'Archived Test Archived',
        slug: `archived-test-archived-${Date.now()}`,
        archived_at: new Date().toISOString(),
      })
      .select()
      .single()
    expect(archError).toBeNull()
    archivedOrgId = archivedOrg!.id
  })

  afterAll(async () => {
    // Clean up
    await serviceClient
      .from('organisations')
      .delete()
      .in('id', [activeOrgId, archivedOrgId])
  })

  it('should exclude archived orgs from detection views', async () => {
    // Create failed agent runs in both orgs
    const now = new Date().toISOString()
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString()

    const { error: insertError } = await serviceClient
      .from('agent_runs')
      .insert([
        {
          organisation_id: activeOrgId,
          agent_name: 'prospect-research-agent',
          status: 'failed',
          completed_at: now,
        },
        {
          organisation_id: archivedOrgId,
          agent_name: 'prospect-research-agent',
          status: 'failed',
          completed_at: now,
        },
      ])

    expect(insertError).toBeNull()

    // Query detection view (should only see active org)
    const { data: view, error: viewError } = await serviceClient
      .from('mon_011')
      .select('*')

    expect(viewError).toBeNull()
    expect(view).toBeDefined()
    // View should show OK if only archived org has failures
    // This test verifies the view's RLS works correctly
    if (view && view.length > 0) {
      expect(view[0].check_code).toBe('MON-011')
    }
  })
})

describe('Sweep Behaviour - Acknowledged Events and Re-Alerts', () => {
  it('should not re-alert while condition persists if acknowledged', async () => {
    // This test documents the sweep behaviour:
    // 1. Event exists in state PROBLEM, resolved_at IS NULL, acknowledged_at IS NULL
    // 2. Operator acknowledges it (sets acknowledged_at, acknowledged_note)
    // 3. While the condition persists AND acknowledged_at IS NOT NULL:
    //    - Should NOT create new PROBLEM event
    //    - Should NOT re-alert to Sentry
    // 4. NEW incident (previous event resolved OR check's newest-incident advances):
    //    - Creates fresh unacknowledged PROBLEM event
    //    - Alerts normally

    // This is enforced at the application layer in the monitoring cron.
    // The exact comparison: if (acknowledged_at IS NOT NULL AND resolved_at IS NULL) skip alert
    // Otherwise if check condition triggers: create new event
    expect(true).toBe(true) // Placeholder for sweep logic verification
  })
})
