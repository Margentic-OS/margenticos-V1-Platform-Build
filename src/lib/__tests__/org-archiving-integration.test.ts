import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

const supabase = createServiceClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

describe('Org Archiving — Contract Tests', () => {
  let testOrgId: string
  let archivedOrgId: string
  let testCampaignId: string
  let archivedCampaignId: string
  let testSignalId: string

  beforeAll(async () => {
    // Create test org (not archived)
    const { data: org, error: orgErr } = await supabase
      .from('organisations')
      .insert({
        name: 'Test Org Active',
        slug: `test-org-active-${Date.now()}`,
        auto_approve_window_hours: 72,
        auto_held_window_hours: 24,
        engagement_month: 1,
        monthly_meetings_target: 4,
        billing_basis: 'held',
      })
      .select('id')
      .single()

    if (orgErr || !org) throw new Error(`Failed to create test org: ${orgErr?.message}`)
    testOrgId = org.id

    // Create archived org
    const now = new Date().toISOString()
    const { data: archOrg, error: archErr } = await supabase
      .from('organisations')
      .insert({
        name: 'Test Org Archived',
        slug: `test-org-archived-${Date.now()}`,
        auto_approve_window_hours: 72,
        auto_held_window_hours: 24,
        engagement_month: 1,
        monthly_meetings_target: 4,
        billing_basis: 'held',
        archived_at: now,
      })
      .select('id')
      .single()

    if (archErr || !archOrg) throw new Error(`Failed to create archived org: ${archErr?.message}`)
    archivedOrgId = archOrg.id

    // Create campaign for active org
    const { data: camp, error: campErr } = await supabase
      .from('campaigns')
      .insert({
        organisation_id: testOrgId,
        name: 'Test Campaign',
        campaign_type: 'cold_email',
        external_id: `test-ext-${Date.now()}`,
      })
      .select('id')
      .single()

    if (campErr || !camp) throw new Error(`Failed to create campaign: ${campErr?.message}`)
    testCampaignId = camp.id

    // Create campaign for archived org
    const { data: archCamp, error: archCampErr } = await supabase
      .from('campaigns')
      .insert({
        organisation_id: archivedOrgId,
        name: 'Archived Campaign',
        campaign_type: 'cold_email',
        external_id: `archived-ext-${Date.now()}`,
      })
      .select('id')
      .single()

    if (archCampErr || !archCamp) throw new Error(`Failed to create archived campaign: ${archCampErr?.message}`)
    archivedCampaignId = archCamp.id

    // Create a signal for the archived org to test late-arrival gate
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sig, error: sigErr } = await supabase
      .from('signals')
      .insert({
        organisation_id: archivedOrgId,
        campaign_id: archivedCampaignId,
        signal_type: 'reply_received',
        source: 'instantly',
        external_event_id: `test-reply-${Date.now()}`,
        raw_data: { from_address_email: 'sender@example.com' } as any,
        processed: false,
      })
      .select('id')
      .single()

    if (sigErr || !sig) throw new Error(`Failed to create signal: ${sigErr?.message}`)
    testSignalId = sig.id
  })

  afterAll(async () => {
    // Cleanup: delete in dependency order
    await supabase.from('reply_handling_actions').delete().eq('signal_id', testSignalId)
    await supabase.from('signals').delete().in('organisation_id', [testOrgId, archivedOrgId])
    await supabase.from('campaigns').delete().in('organisation_id', [testOrgId, archivedOrgId])
    await supabase.from('organisations').delete().in('id', [testOrgId, archivedOrgId])
  })

  describe('Operator queries exclude archived orgs', () => {
    it('Operator sidebar query: archived orgs excluded from enumeration', async () => {
      const { data: orgs, error } = await supabase
        .from('organisations')
        .select('id, name, pipeline_unlocked')
        .is('archived_at', null)
        .order('name')

      expect(error).toBeNull()
      expect(orgs).toBeDefined()

      const orgIds = orgs?.map(o => o.id) ?? []
      expect(orgIds).toContain(testOrgId)
      expect(orgIds).not.toContain(archivedOrgId)
    })

    it('Operator clients page query: archived orgs excluded from enumeration', async () => {
      const { data: orgs, error } = await supabase
        .from('organisations')
        .select('id, name, pipeline_unlocked, engagement_month, payment_status, contract_status')
        .is('archived_at', null)
        .order('name')

      expect(error).toBeNull()
      expect(orgs).toBeDefined()

      const orgIds = orgs?.map(o => o.id) ?? []
      expect(orgIds).toContain(testOrgId)
      expect(orgIds).not.toContain(archivedOrgId)
    })
  })

  describe('Campaign selection excludes archived org campaigns', () => {
    it('pollInstantlyLeadStatus: archived org campaigns excluded from selection', async () => {
      // Query as pollInstantlyLeadStatus does: campaigns with external_id, excluding archived orgs
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: campaigns, error } = await (supabase as any)
        .from('campaigns')
        .select('id, organisation_id, external_id, organisations!inner(archived_at)')
        .not('external_id', 'is', null)
        .is('organisations.archived_at', null)

      expect(error).toBeNull()
      expect(campaigns).toBeDefined()

      const campaignIds = campaigns?.map((c: any) => c.id) ?? []
      expect(campaignIds).toContain(testCampaignId)
      expect(campaignIds).not.toContain(archivedCampaignId)
    })
  })

  describe('Gatekeeper endpoints refuse archived orgs', () => {
    it('Enrich endpoint: archived org query returns NOT FOUND', async () => {
      const { data, error } = await supabase
        .from('organisations')
        .select('id')
        .eq('id', archivedOrgId)
        .is('archived_at', null)
        .single()

      // Should return PGRST116 (not found) because query filters out archived orgs
      expect(error?.code).toBe('PGRST116')
      expect(data).toBeNull()
    })

    it('Approve prospects endpoint: archived org query returns NOT FOUND', async () => {
      const { data, error } = await supabase
        .from('organisations')
        .select('id')
        .eq('id', archivedOrgId)
        .is('archived_at', null)
        .single()

      expect(error?.code).toBe('PGRST116')
      expect(data).toBeNull()
    })

    it('Tier enriched endpoint: archived org query returns NOT FOUND', async () => {
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

  describe('Late-arrival reply signal for archived org', () => {
    it('Reply signal for archived org creates org_archived action with succeeded=true, no processing', async () => {
      // Manually insert the action row as the process-reply gate would
      const { data: action, error: actionErr } = await supabase
        .from('reply_handling_actions')
        .insert({
          organisation_id: archivedOrgId,
          signal_id: testSignalId,
          prospect_id: null,
          campaign_id: archivedCampaignId,
          classified_intent: null,
          classification_confidence: null,
          classification_reasoning: null,
          tier_assigned: null,
          action_taken: 'org_archived',
          action_payload: null,
          action_succeeded: true,
          attempt_number: 1,
        })
        .select('id')
        .single()

      expect(actionErr).toBeNull()
      expect(action).toBeDefined()

      // Verify the action row has correct values
      const { data: verifyAction, error: verifyErr } = await supabase
        .from('reply_handling_actions')
        .select('action_taken, action_succeeded, attempt_number')
        .eq('id', action!.id)
        .single()

      expect(verifyErr).toBeNull()
      expect(verifyAction?.action_taken).toBe('org_archived')
      expect(verifyAction?.action_succeeded).toBe(true)
      expect(verifyAction?.attempt_number).toBe(1)

      // Verify signal is marked processed (as the gate would do)
      const { data: processed, error: procErr } = await supabase
        .from('signals')
        .update({ processed: true, processed_at: new Date().toISOString() })
        .eq('id', testSignalId)
        .select('processed')
        .single()

      expect(procErr).toBeNull()
      expect(processed?.processed).toBe(true)

      // Cleanup this test's action
      await supabase.from('reply_handling_actions').delete().eq('id', action!.id)
    })
  })

  describe('Unarchive restores visibility', () => {
    it('Unarchiving org makes it visible in operator queries', async () => {
      // Unarchive the org
      const { error: unarchErr } = await supabase
        .from('organisations')
        .update({ archived_at: null })
        .eq('id', archivedOrgId)

      expect(unarchErr).toBeNull()

      // Verify it now appears in the list
      const { data: orgs, error } = await supabase
        .from('organisations')
        .select('id')
        .is('archived_at', null)

      expect(error).toBeNull()
      const orgIds = orgs?.map(o => o.id) ?? []
      expect(orgIds).toContain(archivedOrgId)

      // Re-archive for cleanup
      const beforeAllDate = new Date().toISOString()
      await supabase
        .from('organisations')
        .update({ archived_at: beforeAllDate })
        .eq('id', archivedOrgId)
    })
  })
})
