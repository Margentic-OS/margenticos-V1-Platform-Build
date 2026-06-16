import { describe, it, expect, beforeAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { getClientVisibleReplies, getAllRepliesForOrg } from './get-client-visible-replies'

/**
 * Tests for the client-visible replies chokepoint function.
 *
 * CRITICAL TESTS:
 * 1. Cross-org filtering: client from org A gets ONLY org A's replies (never org B's)
 * 2. Intent filtering: client gets ONLY the 5 positive intents (never opt_out/out_of_office/unclear)
 * 3. Data-layer assertion: hidden intents are NOT in the returned data (not just hidden in UI)
 * 4. Operator view: returns ALL 8 intents for campaign health monitoring
 *
 * These tests use a DRY_RUN test org (seeded, never deleted) so they survive reruns.
 */

describe('getClientVisibleReplies (client-visible chokepoint)', () => {
  // Use test orgs that persist across test runs
  const TEST_ORG_A_ID = '11111111-1111-1111-1111-111111111111'
  const TEST_ORG_B_ID = '22222222-2222-2222-2222-222222222222'
  const TEST_ORG_A_NAME = 'Test Org A (DRY RUN)'
  const TEST_ORG_B_NAME = 'Test Org B (DRY RUN)'

  let supabase: SupabaseClient<Database>

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

  beforeAll(async () => {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      throw new Error('Supabase env vars not set (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)')
    }
    supabase = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY)

    // Seed test orgs
    await supabase
      .from('organisations')
      .upsert([
        { id: TEST_ORG_A_ID, name: TEST_ORG_A_NAME, slug: 'test-org-a', founder_first_name: 'Test' },
        { id: TEST_ORG_B_ID, name: TEST_ORG_B_NAME, slug: 'test-org-b', founder_first_name: 'Test' },
      ], { onConflict: 'id' })

    // Seed test prospects
    await supabase
      .from('prospects')
      .upsert([
        {
          id: '33333333-3333-3333-3333-333333333333',
          organisation_id: TEST_ORG_A_ID,
          email: 'prospect-a@example.com',
          first_name: 'Alice',
          last_name: 'Prospect',
        },
        {
          id: '44444444-4444-4444-4444-444444444444',
          organisation_id: TEST_ORG_B_ID,
          email: 'prospect-b@example.com',
          first_name: 'Bob',
          last_name: 'Prospect',
        },
      ], { onConflict: 'id' })

    // Seed signals for org A (all 8 intents) and org B (one positive)
    const orgASignals = [
      {
        id: '55555555-5555-5555-5555-555500000001',
        organisation_id: TEST_ORG_A_ID,
        prospect_id: '33333333-3333-3333-3333-333333333333',
        signal_type: 'reply_received',
        raw_data: { subject: 'Stop contacting me', body: { text: 'Please remove me from your list' } },
        processed: true,
      },
      {
        id: '55555555-5555-5555-5555-555500000002',
        organisation_id: TEST_ORG_A_ID,
        prospect_id: '33333333-3333-3333-3333-333333333333',
        signal_type: 'reply_received',
        raw_data: { subject: 'I am out of the office', body: { text: 'Back on Monday' } },
        processed: true,
      },
      {
        id: '55555555-5555-5555-5555-555500000003',
        organisation_id: TEST_ORG_A_ID,
        prospect_id: '33333333-3333-3333-3333-333333333333',
        signal_type: 'reply_received',
        raw_data: { subject: "Let's book a call", body: { text: 'I want to discuss this more' } },
        processed: true,
      },
      {
        id: '55555555-5555-5555-5555-555500000004',
        organisation_id: TEST_ORG_A_ID,
        prospect_id: '33333333-3333-3333-3333-333333333333',
        signal_type: 'reply_received',
        raw_data: { subject: 'Interested', body: { text: 'Tell me more about this' } },
        processed: true,
      },
      {
        id: '55555555-5555-5555-5555-555500000005',
        organisation_id: TEST_ORG_A_ID,
        prospect_id: '33333333-3333-3333-3333-333333333333',
        signal_type: 'reply_received',
        raw_data: { subject: 'How does it work?', body: { text: 'What is your pricing model?' } },
        processed: true,
      },
      {
        id: '55555555-5555-5555-5555-555500000006',
        organisation_id: TEST_ORG_A_ID,
        prospect_id: '33333333-3333-3333-3333-333333333333',
        signal_type: 'reply_received',
        raw_data: { subject: 'Timeline?', body: { text: 'How long does it take?' } },
        processed: true,
      },
      {
        id: '55555555-5555-5555-5555-555500000007',
        organisation_id: TEST_ORG_A_ID,
        prospect_id: '33333333-3333-3333-3333-333333333333',
        signal_type: 'reply_received',
        raw_data: { subject: 'Maybe later', body: { text: 'Not the right time for us right now' } },
        processed: true,
      },
      {
        id: '55555555-5555-5555-5555-555500000008',
        organisation_id: TEST_ORG_A_ID,
        prospect_id: '33333333-3333-3333-3333-333333333333',
        signal_type: 'reply_received',
        raw_data: { subject: 'Unclear', body: { text: 'Not sure what you mean by that' } },
        processed: true,
      },
      {
        id: '55555555-5555-5555-5555-555500000099',
        organisation_id: TEST_ORG_B_ID,
        prospect_id: '44444444-4444-4444-4444-444444444444',
        signal_type: 'reply_received',
        raw_data: { subject: 'Interested in learning more', body: { text: 'This looks interesting' } },
        processed: true,
      },
    ]

    await supabase
      .from('signals')
      .upsert(orgASignals, { onConflict: 'id' })

    // Seed reply_handling_actions with classifications
    const orgAActions = [
      {
        id: '66666666-6666-6666-6666-666600000001',
        organisation_id: TEST_ORG_A_ID,
        signal_id: '55555555-5555-5555-5555-555500000001',
        prospect_id: '33333333-3333-3333-3333-333333333333',
        classified_intent: 'opt_out',
        classification_confidence: 0.95,
        classification_reasoning: 'Clear request to stop',
        action_taken: 'suppress',
        attempt_number: 1,
      },
      {
        id: '66666666-6666-6666-6666-666600000002',
        organisation_id: TEST_ORG_A_ID,
        signal_id: '55555555-5555-5555-5555-555500000002',
        prospect_id: '33333333-3333-3333-3333-333333333333',
        classified_intent: 'out_of_office',
        classification_confidence: 1.0,
        classification_reasoning: 'Automated OOO',
        action_taken: 'ooo_log',
        attempt_number: 1,
      },
      {
        id: '66666666-6666-6666-6666-666600000003',
        organisation_id: TEST_ORG_A_ID,
        signal_id: '55555555-5555-5555-5555-555500000003',
        prospect_id: '33333333-3333-3333-3333-333333333333',
        classified_intent: 'positive_direct_booking',
        classification_confidence: 0.92,
        classification_reasoning: 'Direct booking request',
        action_taken: 'send_reply',
        attempt_number: 1,
      },
      {
        id: '66666666-6666-6666-6666-666600000004',
        organisation_id: TEST_ORG_A_ID,
        signal_id: '55555555-5555-5555-5555-555500000004',
        prospect_id: '33333333-3333-3333-3333-333333333333',
        classified_intent: 'positive_passive',
        classification_confidence: 0.88,
        classification_reasoning: 'General interest',
        action_taken: 'log_only',
        attempt_number: 1,
      },
      {
        id: '66666666-6666-6666-6666-666600000005',
        organisation_id: TEST_ORG_A_ID,
        signal_id: '55555555-5555-5555-5555-555500000005',
        prospect_id: '33333333-3333-3333-3333-333333333333',
        classified_intent: 'information_request_commercial',
        classification_confidence: 0.9,
        classification_reasoning: 'Pricing question',
        action_taken: 'log_only',
        attempt_number: 1,
      },
      {
        id: '66666666-6666-6666-6666-666600000006',
        organisation_id: TEST_ORG_A_ID,
        signal_id: '55555555-5555-5555-5555-555500000006',
        prospect_id: '33333333-3333-3333-3333-333333333333',
        classified_intent: 'information_request_generic',
        classification_confidence: 0.85,
        classification_reasoning: 'Generic inquiry',
        action_taken: 'log_only',
        attempt_number: 1,
      },
      {
        id: '66666666-6666-6666-6666-666600000007',
        organisation_id: TEST_ORG_A_ID,
        signal_id: '55555555-5555-5555-5555-555500000007',
        prospect_id: '33333333-3333-3333-3333-333333333333',
        classified_intent: 'objection_mild',
        classification_confidence: 0.8,
        classification_reasoning: 'Soft objection',
        action_taken: 'log_only',
        attempt_number: 1,
      },
      {
        id: '66666666-6666-6666-6666-666600000008',
        organisation_id: TEST_ORG_A_ID,
        signal_id: '55555555-5555-5555-5555-555500000008',
        prospect_id: '33333333-3333-3333-3333-333333333333',
        classified_intent: 'unclear',
        classification_confidence: 0.6,
        classification_reasoning: 'Ambiguous',
        action_taken: 'log_only',
        attempt_number: 1,
      },
      {
        id: '66666666-6666-6666-6666-666600000099',
        organisation_id: TEST_ORG_B_ID,
        signal_id: '55555555-5555-5555-5555-555500000099',
        prospect_id: '44444444-4444-4444-4444-444444444444',
        classified_intent: 'positive_passive',
        classification_confidence: 0.9,
        classification_reasoning: 'Interest signal',
        action_taken: 'log_only',
        attempt_number: 1,
      },
    ]

    await supabase
      .from('reply_handling_actions')
      .upsert(orgAActions, { onConflict: 'id' })
  })

  describe('TEST 1: Cross-org filtering (org-scoping)', () => {
    it('returns ONLY replies from the queried org (never cross-org leaks)', async () => {
      const orgAReplies = await getClientVisibleReplies(supabase, TEST_ORG_A_ID)
      const orgBReplies = await getClientVisibleReplies(supabase, TEST_ORG_B_ID)

      // Org A should have replies from org A only
      expect(orgAReplies.length).toBeGreaterThan(0)
      for (const reply of orgAReplies) {
        expect(reply.prospect.email).toBe('prospect-a@example.com')
      }

      // Org B should have replies from org B only
      expect(orgBReplies.length).toBeGreaterThan(0)
      for (const reply of orgBReplies) {
        expect(reply.prospect.email).toBe('prospect-b@example.com')
      }

      // Cross-org check: org A should NEVER see org B's replies
      const orgAEmails = new Set(orgAReplies.map(r => r.prospect.email))
      const orgBEmails = new Set(orgBReplies.map(r => r.prospect.email))
      expect(orgAEmails).not.toContain('prospect-b@example.com')
      expect(orgBEmails).not.toContain('prospect-a@example.com')
    })
  })

  describe('TEST 2: Intent filtering (positive-intent only)', () => {
    it('returns ONLY the 5 positive intents (never opt_out, out_of_office, unclear)', async () => {
      const replies = await getClientVisibleReplies(supabase, TEST_ORG_A_ID)

      // Should have 5 replies (the 5 positive intents)
      expect(replies.length).toBe(5)

      // Collect all intents returned
      const returnedIntents = new Set(replies.map(r => r.classified_intent))

      // Verify: only positive intents present
      const expectedIntents = new Set([
        'positive_direct_booking',
        'positive_passive',
        'information_request_generic',
        'information_request_commercial',
        'objection_mild',
      ])
      expect(returnedIntents).toEqual(expectedIntents)

      // Verify: hidden intents NEVER present
      const hiddenIntents = ['opt_out', 'out_of_office', 'unclear']
      for (const reply of replies) {
        expect(hiddenIntents).not.toContain(reply.classified_intent)
      }
    })
  })

  describe('TEST 3: Data-layer enforcement (not UI-only)', () => {
    it('hidden intents are absent from returned data, not just hidden in render', async () => {
      const replies = await getClientVisibleReplies(supabase, TEST_ORG_A_ID)

      // Count intents in the returned data
      const intentCounts: Record<string, number> = {}
      for (const reply of replies) {
        intentCounts[reply.classified_intent] = (intentCounts[reply.classified_intent] ?? 0) + 1
      }

      // opt_out, out_of_office, unclear should have count 0 (not present)
      expect(intentCounts['opt_out']).toBeUndefined()
      expect(intentCounts['out_of_office']).toBeUndefined()
      expect(intentCounts['unclear']).toBeUndefined()

      // Positive intents should be present
      expect(intentCounts['positive_direct_booking']).toBe(1)
      expect(intentCounts['positive_passive']).toBe(1)
      expect(intentCounts['information_request_generic']).toBe(1)
      expect(intentCounts['information_request_commercial']).toBe(1)
      expect(intentCounts['objection_mild']).toBe(1)
    })
  })

  describe('TEST 4: Operator view returns ALL intents', () => {
    it('getAllRepliesForOrg returns all 8 intents (no filtering)', async () => {
      const allReplies = await getAllRepliesForOrg(supabase, TEST_ORG_A_ID)

      // Should have 8 replies (all intents)
      expect(allReplies.length).toBe(8)

      // Collect all intents
      const returnedIntents = new Set(allReplies.map(r => r.classified_intent))

      // Verify: all 8 intents present
      const expectedIntents = new Set([
        'opt_out',
        'out_of_office',
        'positive_direct_booking',
        'positive_passive',
        'information_request_generic',
        'information_request_commercial',
        'objection_mild',
        'unclear',
      ])
      expect(returnedIntents).toEqual(expectedIntents)
    })
  })
})
