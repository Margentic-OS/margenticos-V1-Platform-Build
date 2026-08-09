import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'

// Test MON-006 per-row window evaluation (not single-org window)
// Run: npx dotenv -e .env.local -- npx vitest run src/__tests__/api/monitor/mon_006_per_row.test.ts

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.warn('Skipping MON-006 tests: missing Supabase credentials')
  process.exit(0)
}

const serviceClient = createClient(supabaseUrl, serviceRoleKey)

describe('MON-006 Per-Row Window Evaluation', () => {
  let shortWindowOrgId: string
  let longWindowOrgId: string
  const testMarker = `mon-006-test-${Date.now()}`

  beforeAll(async () => {
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
    // Clean up test data
    await serviceClient
      .from('organisations')
      .delete()
      .in('id', [shortWindowOrgId, longWindowOrgId])
  })

  it('should evaluate PROBLEM when any org exceeds its own window (two-org scenario)', async () => {
    // Scenario:
    // - Short-window org (1 hour): has a revision that's 2 hours old → OVERDUE
    // - Long-window org (10 hours): has a revision that's 8 hours old → NOT OVERDUE
    // Expected: state='PROBLEM' because short-window revision is overdue

    const now = new Date()
    const twoHoursAgo = new Date(now.getTime() - 2 * 3600000).toISOString()
    const eightHoursAgo = new Date(now.getTime() - 8 * 3600000).toISOString()

    const testId = `${testMarker}-overdue`

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

    // Query the view
    const { data: view, error: viewError } = await serviceClient
      .from('mon_006')
      .select('check_code, state, detail')
      .single()

    expect(viewError).toBeNull()
    expect(view).toBeDefined()
    expect(view!.check_code).toBe('MON-006')

    // Must show PROBLEM because short-window revision is overdue
    // (even though long-window revision is not)
    expect(view!.state).toBe('PROBLEM')

    // Detail should show overdue count
    expect(view!.detail).toContain('overdue')

    // Cleanup
    await serviceClient
      .from('document_suggestions')
      .delete()
      .eq('field_path', testId)
  })

  it('should show OK when all revisions are within their org windows', async () => {
    // Scenario:
    // - Short-window org (1 hour): has a revision that's 30 minutes old → OK
    // - Long-window org (10 hours): has a revision that's 8 hours old → OK
    // Expected: state='OK'

    const now = new Date()
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60000).toISOString()
    const eightHoursAgo = new Date(now.getTime() - 8 * 3600000).toISOString()

    const testId = `${testMarker}-ok`

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

    // Query the view
    const { data: view, error: viewError } = await serviceClient
      .from('mon_006')
      .select('check_code, state, detail')
      .single()

    expect(viewError).toBeNull()
    expect(view).toBeDefined()

    // Should show OK because both are within their windows
    expect(view!.state).toBe('OK')
    expect(view!.detail).toContain('within window')

    // Cleanup
    await serviceClient
      .from('document_suggestions')
      .delete()
      .eq('field_path', testId)
  })
})
