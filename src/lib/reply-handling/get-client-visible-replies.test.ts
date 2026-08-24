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
          job_title: 'Managing Director',
          company_name: 'Prospect Co',
        },
        {
          id: '44444444-4444-4444-4444-444444444444',
          organisation_id: TEST_ORG_B_ID,
          email: 'prospect-b@example.com',
          first_name: 'Bob',
          last_name: 'Prospect',
        },
        // A third prospect exists purely so the meeting badge can be tested without
        // flipping every other card: all of org A's other replies share prospect A, and a
        // meeting is matched by prospect.
        {
          id: '33333333-3333-3333-3333-33333333333c',
          organisation_id: TEST_ORG_A_ID,
          email: 'prospect-c@example.com',
          first_name: 'Cleo',
          last_name: 'Booked',
          job_title: 'Founder',
          company_name: 'Booked Ltd',
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
        original_outbound_body: 'The email that prompted this.\n\nAlice\nProspect Co',
        processed: true,
      },
      {
        id: '55555555-5555-5555-5555-555500000004',
        organisation_id: TEST_ORG_A_ID,
        prospect_id: '33333333-3333-3333-3333-333333333333',
        signal_type: 'reply_received',
        // Multi-paragraph and over 300 characters, so truncation and newline-flattening
        // are both visible failures rather than silent ones.
        raw_data: {
          subject: 'Interested',
          body: { text: 'Tell me more about this.\n\n' + 'This paragraph exists to push the body well past three hundred characters so that any truncation shows up as a failing assertion rather than as a quietly shorter card. '.repeat(3) + '\n\nRegards' },
        },
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
        id: '55555555-5555-5555-5555-55550000000c',
        organisation_id: TEST_ORG_A_ID,
        prospect_id: '33333333-3333-3333-3333-33333333333c',
        signal_type: 'reply_received',
        raw_data: { subject: 'Yes please', body: { text: 'Booked a slot, see you then' } },
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
        // A Tier 1 automatic reply that actually went out. action_succeeded true is the
        // gate: a failed send must never be shown to a client as something we said.
        action_succeeded: true,
        action_payload: { reply_body: 'Thanks for coming back to us. Grab a slot here.', calendar_link: 'https://cal.example/x' },
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
        id: '66666666-6666-6666-6666-6666000000c1',
        organisation_id: TEST_ORG_A_ID,
        signal_id: '55555555-5555-5555-5555-55550000000c',
        prospect_id: '33333333-3333-3333-3333-33333333333c',
        classified_intent: 'positive_passive',
        classification_confidence: 0.9,
        classification_reasoning: 'Booked',
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

    // Three drafts against three different signals, at three different statuses. Only the
    // 'sent' one may ever reach a client: the other two are an operator's queue.
    await supabase
      .from('reply_drafts')
      .upsert([
        {
          id: '77777777-7777-7777-7777-777700000004',
          organisation_id: TEST_ORG_A_ID,
          signal_id: '55555555-5555-5555-5555-555500000004',
          prospect_id: '33333333-3333-3333-3333-333333333333',
          intent: 'positive_passive',
          tier: 2,
          status: 'sent',
          ai_draft_body: 'A draft the operator edited.',
          final_sent_body: 'What we actually sent on your behalf.',
          sent_at: '2026-08-20T10:00:00.000Z',
        },
        {
          id: '77777777-7777-7777-7777-777700000005',
          organisation_id: TEST_ORG_A_ID,
          signal_id: '55555555-5555-5555-5555-555500000005',
          prospect_id: '33333333-3333-3333-3333-333333333333',
          intent: 'information_request_commercial',
          tier: 3,
          status: 'pending',
          ai_draft_body: 'AWAITING APPROVAL. This text must never reach a client.',
        },
        {
          id: '77777777-7777-7777-7777-777700000006',
          organisation_id: TEST_ORG_A_ID,
          signal_id: '55555555-5555-5555-5555-555500000006',
          prospect_id: '33333333-3333-3333-3333-333333333333',
          intent: 'information_request_generic',
          tier: 2,
          status: 'rejected',
          ai_draft_body: 'REJECTED DRAFT. This text must never reach a client.',
        },
      ], { onConflict: 'id' })

    await supabase
      .from('meetings')
      .upsert([{
        id: '88888888-8888-8888-8888-888800000001',
        organisation_id: TEST_ORG_A_ID,
        prospect_id: '33333333-3333-3333-3333-33333333333c',
        meeting_status: 'booked',
        scheduled_start_at: '2026-09-02T14:00:00.000Z',
        source: 'manual',
      }], { onConflict: 'id' })
  })

  describe('TEST 1: Cross-org filtering (org-scoping)', () => {
    it('returns ONLY replies from the queried org (never cross-org leaks)', async () => {
      const orgAReplies = await getClientVisibleReplies(TEST_ORG_A_ID)
      const orgBReplies = await getClientVisibleReplies(TEST_ORG_B_ID)

      expect(orgAReplies.length).toBeGreaterThan(0)
      expect(orgBReplies.length).toBeGreaterThan(0)

      const orgAEmails = new Set(orgAReplies.map(r => r.prospect.email))
      const orgBEmails = new Set(orgBReplies.map(r => r.prospect.email))

      expect(orgAEmails.has('prospect-b@example.com')).toBe(false)
      expect(orgBEmails.has('prospect-a@example.com')).toBe(false)
      expect(orgBEmails.has('prospect-c@example.com')).toBe(false)
    })
  })

  describe('TEST 2: Intent filtering (positive-intent only)', () => {
    it('returns only the positive-intent replies, never opt_out, out_of_office or unclear', async () => {
      const replies = await getClientVisibleReplies(TEST_ORG_A_ID)

      // Six positive rows are seeded for org A: five on prospect A, one on prospect C.
      // The opt_out, out_of_office and unclear rows are seeded too and must not appear.
      expect(replies.length).toBe(6)

      const bodies = replies.map(r => r.reply_body).join(' ')
      expect(bodies).not.toContain('Please remove me from your list')
      expect(bodies).not.toContain('Back on Monday')
      expect(bodies).not.toContain('Not sure what you mean by that')
    })
  })

  describe('TEST 3: the classification never leaves the data layer', () => {
    it('no returned reply carries an intent, a confidence score or a tier', async () => {
      const replies = await getClientVisibleReplies(TEST_ORG_A_ID)
      expect(replies.length).toBeGreaterThan(0)

      for (const reply of replies) {
        // Not hidden in the UI. Absent from the object, because it was never selected.
        expect(reply).not.toHaveProperty('classified_intent')
        expect(reply).not.toHaveProperty('classification_confidence')
        expect(reply).not.toHaveProperty('classification_reasoning')
        expect(reply).not.toHaveProperty('tier_assigned')
        expect(reply).not.toHaveProperty('action_taken')
      }

      // Belt and braces: no intent string appears anywhere in the serialised payload,
      // which would catch one arriving inside a nested object.
      const serialised = JSON.stringify(replies)
      for (const intent of [
        'positive_direct_booking', 'positive_passive', 'information_request_generic',
        'information_request_commercial', 'objection_mild', 'opt_out', 'out_of_office', 'unclear',
      ]) {
        expect(serialised).not.toContain(intent)
      }
    })

    it('the badge is two-valued and derived from meetings, not from the classification', async () => {
      const replies = await getClientVisibleReplies(TEST_ORG_A_ID)

      for (const reply of replies) {
        expect(['interested', 'meeting_booked']).toContain(reply.badge)
      }

      // Exactly one seeded prospect has a meeting. Note that the reply carrying it is
      // classified positive_passive, the same intent as others that show 'interested',
      // which is the point: the badge is not the intent under another name.
      const booked = replies.filter(r => r.badge === 'meeting_booked')
      expect(booked).toHaveLength(1)
      expect(booked[0].prospect.email).toBe('prospect-c@example.com')
      expect(booked[0].meeting?.scheduled_for).toBe('2026-09-02T14:00:00+00:00')
    })
  })

  describe('TEST 3b: what the card is owed', () => {
    it('carries the job title and company so a card can name who replied', async () => {
      const replies = await getClientVisibleReplies(TEST_ORG_A_ID)
      const alice = replies.find(r => r.prospect.email === 'prospect-a@example.com')

      expect(alice?.prospect.job_title).toBe('Managing Director')
      expect(alice?.prospect.company_name).toBe('Prospect Co')
    })

    it('returns the reply verbatim, not a 300-character snippet with the newlines removed', async () => {
      const replies = await getClientVisibleReplies(TEST_ORG_A_ID)
      const long = replies.find(r => r.reply_subject === 'Interested')

      expect(long).toBeDefined()
      expect(long!.reply_body.length).toBeGreaterThan(300)
      expect(long!.reply_body).toContain('\n')
      expect(long!.reply_body.trimEnd().endsWith('Regards')).toBe(true)
    })

    it('carries the email that prompted the reply', async () => {
      const replies = await getClientVisibleReplies(TEST_ORG_A_ID)
      const withPrompt = replies.find(r => r.reply_subject === "Let\'s book a call")

      expect(withPrompt?.prompting_email).toContain('The email that prompted this.')
    })
  })

  describe('TEST 3c: what was sent on the client\'s behalf', () => {
    it('shows an operator-approved reply once it has actually been sent', async () => {
      const replies = await getClientVisibleReplies(TEST_ORG_A_ID)
      const sent = replies.find(r => r.reply_subject === 'Interested')

      expect(sent?.sent_on_their_behalf?.body).toBe('What we actually sent on your behalf.')
      expect(sent?.sent_on_their_behalf?.sent_at).toBe('2026-08-20T10:00:00+00:00')
    })

    it('shows a Tier 1 automatic reply that succeeded', async () => {
      const replies = await getClientVisibleReplies(TEST_ORG_A_ID)
      const auto = replies.find(r => r.reply_subject === "Let\'s book a call")

      expect(auto?.sent_on_their_behalf?.body).toContain('Grab a slot here.')
      expect(auto?.sent_on_their_behalf?.sent_at).toBeTruthy()
    })

    it('NEVER shows a draft awaiting approval, or one that was rejected', async () => {
      const replies = await getClientVisibleReplies(TEST_ORG_A_ID)
      const serialised = JSON.stringify(replies)

      // Both drafts are seeded against replies that ARE returned, so their absence is
      // about status filtering and not about the parent row being filtered out.
      expect(serialised).not.toContain('AWAITING APPROVAL')
      expect(serialised).not.toContain('REJECTED DRAFT')

      const pendingParent = replies.find(r => r.reply_subject === 'How does it work?')
      const rejectedParent = replies.find(r => r.reply_subject === 'Timeline?')
      expect(pendingParent).toBeDefined()
      expect(rejectedParent).toBeDefined()
      expect(pendingParent!.sent_on_their_behalf).toBeNull()
      expect(rejectedParent!.sent_on_their_behalf).toBeNull()
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
