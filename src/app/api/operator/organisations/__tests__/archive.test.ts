import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

describe('Archive/Unarchive Organisation', () => {
  let supabase: ReturnType<typeof createClient<Database>>
  let testOrgId: string
  let testOrgName: string

  beforeAll(async () => {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      throw new Error('Supabase env vars not set (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)')
    }

    supabase = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // Create test organisation
    const { data: org, error: createError } = await supabase
      .from('organisations')
      .insert({
        name: `Archive Test Org ${Date.now()}`,
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
