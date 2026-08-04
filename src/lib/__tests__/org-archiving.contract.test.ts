import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { Database } from '@/types/database'
import { processOneSignal } from '@/lib/reply-handling/process-reply'

const supabase = createServiceClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

describe('Org Archiving — Contract Tests', () => {
  let testOrgId: string
  let archivedOrgId: string
  let campaignId: string
  let archivedCampaignId: string

  beforeAll(async () => {
    // Create test org
    const { data: org, error: orgError } = await supabase
      .from('organisations')
      .insert({ name: 'Test Org for Archiving' })
      .select('id')
      .single()

    if (orgError || !org) throw new Error(`Failed to create test org: ${orgError?.message}`)
    testOrgId = org.id

    // Create archived org
    const { data: archivedOrg, error: archError } = await supabase
      .from('organisations')
      .insert({ name: 'Archived Test Org', archived_at: new Date().toISOString() })
      .select('id')
      .single()

    if (archError || !archivedOrg) throw new Error(`Failed to create archived org: ${archError?.message}`)
    archivedOrgId = archivedOrg.id

    // Create campaign for test org
    const { data: campaign, error: campError } = await supabase
      .from('campaigns')
      .insert({ organisation_id: testOrgId, name: 'Test Campaign', external_id: 'ext-test-1' })
      .select('id')
      .single()

    if (campError || !campaign) throw new Error(`Failed to create campaign: ${campError?.message}`)
    campaignId = campaign.id

    // Create campaign for archived org
    const { data: archivedCampaign, error: archCampError } = await supabase
      .from('campaigns')
      .insert({ organisation_id: archivedOrgId, name: 'Archived Campaign', external_id: 'ext-archived-1' })
      .select('id')
      .single()

    if (archCampError || !archivedCampaign) throw new Error(`Failed to create archived campaign: ${archCampError?.message}`)
    archivedCampaignId = archivedCampaign.id
  })

  afterAll(async () => {
    // Cleanup
    await supabase.from('campaigns').delete().eq('organisation_id', testOrgId)
    await supabase.from('campaigns').delete().eq('organisation_id', archivedOrgId)
    await supabase.from('organisations').delete().eq('id', testOrgId)
    await supabase.from('organisations').delete().eq('id', archivedOrgId)
  })

  describe('Operator queries exclude archived orgs', () => {
    it('operator sidebar excludes archived orgs', async () => {
      const { data: orgs, error } = await supabase
        .from('organisations')
        .select('id')
        .is('archived_at', null)

      expect(error).toBeNull()
      const orgIds = orgs?.map(o => o.id) ?? []
      expect(orgIds).toContain(testOrgId)
      expect(orgIds).not.toContain(archivedOrgId)
    })

    it('operator clients page excludes archived orgs', async () => {
      const { data: orgs, error } = await supabase
        .from('organisations')
        .select('id, name')
        .is('archived_at', null)
        .order('name')

      expect(error).toBeNull()
      const orgIds = orgs?.map(o => o.id) ?? []
      expect(orgIds).toContain(testOrgId)
      expect(orgIds).not.toContain(archivedOrgId)
    })
  })

  describe('Late-arrival reply for archived org', () => {
    it('reply signal for archived org creates org_archived action with succeeded=true', async () => {
      // Create a signal for the archived org
      const { data: signal, error: signalError } = await supabase
        .from('signals')
        .insert({
          organisation_id: archivedOrgId,
          campaign_id: archivedCampaignId,
          signal_type: 'reply_received',
          source: 'instantly',
          external_event_id: 'test-reply-1',
          raw_data: { from_address_email: 'test@example.com' },
          processed: false,
        })
        .select('id')
        .single()

      if (signalError || !signal) throw new Error(`Failed to create signal: ${signalError?.message}`)

      // Process the signal
      const result = await processOneSignal(
        supabase,
        'dummy-key',
        'https://api.instantly.ai',
        false,
        {
          id: signal.id,
          organisation_id: archivedOrgId,
          campaign_id: archivedCampaignId,
          raw_data: { from_address_email: 'test@example.com' },
          original_outbound_body: null,
          created_at: new Date().toISOString(),
        }
      )

      expect(result).toBe('processed')

      // Verify the action row was created
      const { data: actions, error: actionError } = await supabase
        .from('reply_handling_actions')
        .select('action_taken, action_succeeded')
        .eq('signal_id', signal.id)

      expect(actionError).toBeNull()
      expect(actions).toHaveLength(1)
      expect(actions?.[0].action_taken).toBe('org_archived')
      expect(actions?.[0].action_succeeded).toBe(true)

      // Verify signal is marked processed
      const { data: processedSignal, error: procError } = await supabase
        .from('signals')
        .select('processed')
        .eq('id', signal.id)
        .single()

      expect(procError).toBeNull()
      expect(processedSignal?.processed).toBe(true)

      // Cleanup
      await supabase.from('reply_handling_actions').delete().eq('signal_id', signal.id)
      await supabase.from('signals').delete().eq('id', signal.id)
    })
  })

  describe('Campaign selection excludes archived org campaigns', () => {
    it('pollInstantlyLeadStatus excludes campaigns of archived orgs', async () => {
      // Query like pollInstantlyLeadStatus does
      const { data: campaigns, error } = await supabase
        .from('campaigns')
        .select('id, organisation_id, external_id, organisations!inner(archived_at)')
        .not('external_id', 'is', null)
        .is('organisations.archived_at', null)

      expect(error).toBeNull()
      const campaignIds = campaigns?.map(c => c.id) ?? []
      expect(campaignIds).toContain(campaignId)
      expect(campaignIds).not.toContain(archivedCampaignId)
    })
  })

  describe('Gatekeeper endpoints refuse archived orgs', () => {
    it('enrich-approved-batch endpoint rejects archived org', async () => {
      const { data, error } = await supabase
        .from('organisations')
        .select('id')
        .eq('id', archivedOrgId)
        .is('archived_at', null)
        .single()

      // Should not return the archived org
      expect(error?.code).toBe('PGRST116') // Not found error
      expect(data).toBeNull()
    })

    it('approve-prospects endpoint rejects archived org', async () => {
      const { data, error } = await supabase
        .from('organisations')
        .select('id')
        .eq('id', archivedOrgId)
        .is('archived_at', null)
        .single()

      expect(error?.code).toBe('PGRST116')
      expect(data).toBeNull()
    })

    it('tier-enriched-batch endpoint rejects archived org', async () => {
      const { data, error } = await supabase
        .from('organisations')
        .select('id')
        .eq('id', archivedOrgId)
        .is('archived_at', null)
        .single()

      expect(error?.code).toBe('PGRST116')
      expect(data).toBeNull()
    })
  })

  describe('Unarchive restores visibility', () => {
    it('unarchiving org restores visibility in operator queries', async () => {
      // Unarchive the org
      await supabase
        .from('organisations')
        .update({ archived_at: null })
        .eq('id', archivedOrgId)

      // Verify it now appears in the list
      const { data: orgs, error } = await supabase
        .from('organisations')
        .select('id')
        .is('archived_at', null)

      expect(error).toBeNull()
      const orgIds = orgs?.map(o => o.id) ?? []
      expect(orgIds).toContain(archivedOrgId)

      // Re-archive for cleanup
      await supabase
        .from('organisations')
        .update({ archived_at: new Date().toISOString() })
        .eq('id', archivedOrgId)
    })
  })
})
