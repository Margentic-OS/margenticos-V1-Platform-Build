// src/lib/faq/write-enforcement.test.ts
//
// CRITICAL: Tests that prove write-side enforcement via database trigger.
//
// The trigger validate_faq_extractions_org_consistency() runs on every INSERT/UPDATE,
// regardless of user role (including service role). It validates that every FK reference
// (signal_id, reply_draft_id, similar_faq_id, similar_pending_extraction_id)
// belongs to the same organisation_id as the row being written.
//
// This test proves that attempting to write a cross-org FAQ extraction FAILS at the
// database level, not just because the application forgot to filter.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient } from '@/test-utils/test-database'

// Needs the TEST database. Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/faq/write-enforcement.test.ts

describe('FAQ write-side enforcement (database trigger)', () => {
  let serviceClient: SupabaseClient<Database>
  let org1Id: string
  let org2Id: string
  let signal1Id: string
  let draft1Id: string

  beforeAll(async () => {
    serviceClient = createTestServiceClient('write-enforcement.test.ts')

    // Create two organisations
    const { data: org1, error: org1Err } = await serviceClient
      .from('organisations')
      .insert({
        name: 'Write Test Org A',
        slug: `write-test-org-a-${Date.now()}`,
        founder_first_name: 'Alice'
      })
      .select('id')
      .single()

    const { data: org2, error: org2Err } = await serviceClient
      .from('organisations')
      .insert({
        name: 'Write Test Org B',
        slug: `write-test-org-b-${Date.now()}`,
        founder_first_name: 'Bob'
      })
      .select('id')
      .single()

    if (org1Err || !org1 || org2Err || !org2) {
      throw new Error(`Failed to create test orgs: ${org1Err?.message} ${org2Err?.message}`)
    }

    org1Id = org1.id
    org2Id = org2.id

    // Create a campaign in org-A first
    const { data: campaign, error: campaignErr } = await serviceClient
      .from('campaigns')
      .insert({
        organisation_id: org1Id,
        campaign_type: 'cold_email',
        name: 'Write Test Campaign A',
      })
      .select('id')
      .single()

    if (campaignErr || !campaign) {
      throw new Error(`Failed to create test campaign: ${campaignErr?.message}`)
    }

    // Create a signal in org-A
    const { data: signal, error: signalErr } = await serviceClient
      .from('signals')
      .insert({
        organisation_id: org1Id,
        campaign_id: campaign.id,
        signal_type: 'reply_received',
        raw_data: { test: true },
      })
      .select('id')
      .single()

    if (signalErr || !signal) {
      throw new Error(`Failed to create test signal: ${signalErr?.message}`)
    }

    signal1Id = signal.id

    // Create a reply draft in org-A
    const { data: draft, error: draftErr } = await serviceClient
      .from('reply_drafts')
      .insert({
        organisation_id: org1Id,
        signal_id: signal1Id,
        tier: 3,
        intent: 'test_intent',
        ai_draft_body: 'Test draft',
      })
      .select('id')
      .single()

    if (draftErr || !draft) {
      throw new Error(`Failed to create test draft: ${draftErr?.message}`)
    }

    draft1Id = draft.id
  }, 60000)

  afterAll(async () => {
    // Cleanup
    if (org1Id) await serviceClient.from('organisations').delete().eq('id', org1Id)
    if (org2Id) await serviceClient.from('organisations').delete().eq('id', org2Id)
  })

  it('Trigger REJECTS faq_extractions insert with signal_id from different org', async () => {
    // Create a campaign in org-B
    const { data: campaign2, error: campaign2Err } = await serviceClient
      .from('campaigns')
      .insert({
        organisation_id: org2Id,
        campaign_type: 'cold_email',
        name: 'Write Test Campaign B',
      })
      .select('id')
      .single()

    if (campaign2Err || !campaign2) {
      throw new Error(`Failed to create campaign in org-B: ${campaign2Err?.message}`)
    }

    // Create a signal in org-B (different org)
    const { data: signal2, error: signal2Err } = await serviceClient
      .from('signals')
      .insert({
        organisation_id: org2Id,
        campaign_id: campaign2.id,
        signal_type: 'reply_received',
        raw_data: { test: true },
      })
      .select('id')
      .single()

    if (signal2Err || !signal2) {
      throw new Error(`Failed to create signal in org-B: ${signal2Err?.message}`)
    }

    const signal2Id = signal2.id

    // Attempt to insert a faq_extractions row in org-A that references signal from org-B
    // This should FAIL at the database level due to the trigger
    const { data: extraction, error: extractionErr } = await serviceClient
      .from('faq_extractions')
      .insert({
        organisation_id: org1Id,          // Org-A
        signal_id: signal2Id,             // But signal belongs to org-B
        reply_draft_id: draft1Id,
        extracted_question: 'Test question',
        suggested_answer: 'Test answer',
        status: 'pending',
        source: 'reply_extracted',
      })
      .select('id')
      .single()

    // The trigger should reject this write
    expect(extractionErr).not.toBeNull()
    expect(extractionErr?.message).toContain('does not belong to organisation')

    // The row should NOT have been created
    expect(extraction).toBeNull()
  })

  it('Trigger REJECTS faq_extractions insert with reply_draft_id from different org', async () => {
    // Create a campaign in org-B for signal
    const { data: campaign3, error: campaign3Err } = await serviceClient
      .from('campaigns')
      .insert({
        organisation_id: org2Id,
        campaign_type: 'cold_email',
        name: 'Write Test Campaign C',
      })
      .select('id')
      .single()

    if (campaign3Err || !campaign3) {
      throw new Error(`Failed to create campaign in org-B: ${campaign3Err?.message}`)
    }

    // Create a reply draft in org-B
    const { data: signal2, error: signal2Err } = await serviceClient
      .from('signals')
      .insert({
        organisation_id: org2Id,
        campaign_id: campaign3.id,
        signal_type: 'reply_received',
        raw_data: { test: true },
      })
      .select('id')
      .single()

    if (signal2Err || !signal2) {
      throw new Error(`Failed to create signal in org-B: ${signal2Err?.message}`)
    }

    const { data: draft2, error: draft2Err } = await serviceClient
      .from('reply_drafts')
      .insert({
        organisation_id: org2Id,          // Org-B
        signal_id: signal2.id,
        tier: 3,
        intent: 'test_intent',
        ai_draft_body: 'Test draft',
      })
      .select('id')
      .single()

    if (draft2Err || !draft2) {
      throw new Error(`Failed to create draft in org-B: ${draft2Err?.message}`)
    }

    const draft2Id = draft2.id

    // Attempt to insert a faq_extractions row in org-A that references draft from org-B
    const { data: extraction, error: extractionErr } = await serviceClient
      .from('faq_extractions')
      .insert({
        organisation_id: org1Id,          // Org-A
        signal_id: signal1Id,             // Org-A
        reply_draft_id: draft2Id,         // But draft belongs to org-B
        extracted_question: 'Test question',
        suggested_answer: 'Test answer',
        status: 'pending',
        source: 'reply_extracted',
      })
      .select('id')
      .single()

    // The trigger should reject this write
    expect(extractionErr).not.toBeNull()
    expect(extractionErr?.message).toContain('does not belong to organisation')
    expect(extraction).toBeNull()
  })

  it('Trigger ALLOWS faq_extractions insert when all FKs belong to same org', async () => {
    // Create a faq_extractions row in org-A that references signal and draft from org-A
    // This should SUCCEED because all references belong to the same org

    const { data: extraction, error: extractionErr } = await serviceClient
      .from('faq_extractions')
      .insert({
        organisation_id: org1Id,          // Org-A
        signal_id: signal1Id,             // Org-A
        reply_draft_id: draft1Id,         // Org-A
        extracted_question: 'Valid question',
        suggested_answer: 'Valid answer',
        status: 'pending',
        source: 'reply_extracted',
      })
      .select('id')
      .single()

    // This write should SUCCEED
    expect(extractionErr).toBeNull()
    expect(extraction).not.toBeNull()
    expect(extraction?.id).toBeDefined()

    // Verify the row was actually created
    if (extraction) {
      const { data: verify, error: verifyErr } = await serviceClient
        .from('faq_extractions')
        .select('id')
        .eq('id', extraction.id)
        .single()

      expect(verifyErr).toBeNull()
      expect(verify?.id).toBe(extraction.id)
    }
  })
})
