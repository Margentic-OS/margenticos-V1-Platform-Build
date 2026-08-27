import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient } from '@/test-utils/test-database'

// Needs the TEST database. Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/app/api/operator/organisations/__tests__/archive.test.ts

describe('Archive/Unarchive Organisation', () => {
  let supabase: SupabaseClient<Database>
  let testOrgId: string
  let testOrgName: string

  beforeAll(async () => {
    supabase = createTestServiceClient('archive.test.ts')

    // Create test organisation
    testOrgName = `Archive Test Org ${Date.now()}`
    const testSlug = `archive-test-${Date.now()}`
    const { data: org, error: createError } = await supabase
      .from('organisations')
      .insert({
        name: testOrgName,
        slug: testSlug,
        founder_first_name: 'Test',
      })
      .select('id, name, archived_at')
      .single()

    if (createError || !org) {
      throw new Error(`Failed to create test org: ${createError?.message}`)
    }

    testOrgId = org.id
    testOrgName = org.name
  })

  afterAll(async () => {
    if (testOrgId) {
      await supabase.from('organisations').delete().eq('id', testOrgId)
    }
  })

  it('archives an organisation by setting archived_at', async () => {
    const now = new Date().toISOString()

    const { data: result, error } = await supabase
      .from('organisations')
      .update({ archived_at: now })
      .eq('id', testOrgId)
      .select('id, archived_at')
      .single()

    expect(error).toBeNull()
    expect(result).toBeDefined()
    expect(result?.archived_at).not.toBeNull()

    // Verify it doesn't appear in active list
    const { data: activeOrgs } = await supabase
      .from('organisations')
      .select('id')
      .is('archived_at', null)
      .eq('id', testOrgId)

    expect(activeOrgs).toHaveLength(0)
  })

  it('unarchives an organisation by clearing archived_at', async () => {
    // First archive it
    const archiveTime = new Date().toISOString()
    await supabase
      .from('organisations')
      .update({ archived_at: archiveTime })
      .eq('id', testOrgId)

    // Then unarchive it
    const { data: result, error } = await supabase
      .from('organisations')
      .update({ archived_at: null })
      .eq('id', testOrgId)
      .select('id, archived_at')
      .single()

    expect(error).toBeNull()
    expect(result?.archived_at).toBeNull()

    // Verify it appears in active list
    const { data: activeOrgs } = await supabase
      .from('organisations')
      .select('id')
      .is('archived_at', null)
      .eq('id', testOrgId)

    expect(activeOrgs).toHaveLength(1)
  })

  it('archived organisations appear in archived query', async () => {
    const archiveTime = new Date().toISOString()
    await supabase
      .from('organisations')
      .update({ archived_at: archiveTime })
      .eq('id', testOrgId)

    const { data: archivedOrgs } = await supabase
      .from('organisations')
      .select('id, name')
      .not('archived_at', 'is', null)
      .eq('id', testOrgId)

    expect(archivedOrgs).toHaveLength(1)
    expect(archivedOrgs?.[0].name).toBe(testOrgName)
  })

  it('active organisations do not appear in archived query', async () => {
    // Ensure it's not archived
    await supabase
      .from('organisations')
      .update({ archived_at: null })
      .eq('id', testOrgId)

    const { data: archivedOrgs } = await supabase
      .from('organisations')
      .select('id')
      .not('archived_at', 'is', null)
      .eq('id', testOrgId)

    expect(archivedOrgs).toHaveLength(0)
  })
})
