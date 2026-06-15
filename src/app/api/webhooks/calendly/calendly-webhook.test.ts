import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const CALENDLY_WEBHOOK_SECRET = process.env.CALENDLY_WEBHOOK_SECRET || 'test-secret'

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// Helper to generate valid Calendly webhook signature
function generateSignature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

interface TestContext {
  org_id: string
  prospect_id: string
}

describe('Calendly Webhook Handler', () => {
  let ctx: TestContext

  beforeAll(async () => {
    // Create test org
    const { data: org, error: orgError } = await supabase
      .from('organisations')
      .insert({ name: 'Webhook Test Org', slug: `webhook-test-${Date.now()}` })
      .select('id')
      .single()

    if (orgError) throw orgError
    ctx = { org_id: org.id, prospect_id: '' }

    // Create test prospect
    const { data: prospect, error: prospectError } = await supabase
      .from('prospects')
      .insert({
        organisation_id: ctx.org_id,
        email: 'prospect@example.com',
        first_name: 'Test',
        last_name: 'Prospect',
      })
      .select('id')
      .single()

    if (prospectError) throw prospectError
    ctx.prospect_id = prospect.id
  })

  afterEach(async () => {
    // Clean up test meetings after each test
    await supabase
      .from('meetings')
      .delete()
      .eq('organisation_id', ctx.org_id)
  })

  describe('Invitee Created', () => {
    it('creates meeting with correct prospect_id on email match', async () => {
      const payload = JSON.stringify({
        event: {
          uri: 'https://api.calendly.com/event_types/123e4567-e89b-12d3-a456-426614174000',
          start_time: '2026-06-20T14:00:00Z',
          end_time: '2026-06-20T14:30:00Z',
        },
        invitee: {
          uri: 'https://api.calendly.com/invitees/789e1234-f45b-12d3-a456-426614174001',
          email: 'prospect@example.com',
          name: 'Test Prospect',
        },
      })

      const signature = generateSignature(payload, CALENDLY_WEBHOOK_SECRET)

      const response = await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/webhooks/calendly`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Calendly-Webhook-Signature': signature,
        },
        body: payload,
      })

      expect(response.status).toBe(200)

      // Verify meeting was created
      const { data: meetings, error } = await supabase
        .from('meetings')
        .select('*')
        .eq('organisation_id', ctx.org_id)
        .eq('prospect_id', ctx.prospect_id)

      expect(error).toBeNull()
      expect(meetings).toHaveLength(1)

      const meeting = meetings![0]
      expect(meeting.source).toBe('calendly')
      expect(meeting.calendly_event_uuid).toBe('123e4567-e89b-12d3-a456-426614174000')
      expect(meeting.calendly_invitee_uuid).toBe('789e1234-f45b-12d3-a456-426614174001')
      expect(meeting.meeting_status).toBe('booked')
      expect(meeting.is_billable).toBe(false)
      expect(meeting.held_decision_locked).toBe(false)
      expect(meeting.scheduled_start_at).toBe('2026-06-20T14:00:00Z')
    })

    it('extracts phone from custom_questions_answers', async () => {
      const payload = JSON.stringify({
        event: {
          uri: 'https://api.calendly.com/event_types/123e4567-e89b-12d3-a456-426614174001',
          start_time: '2026-06-21T15:00:00Z',
          end_time: '2026-06-21T15:30:00Z',
        },
        invitee: {
          uri: 'https://api.calendly.com/invitees/789e1234-f45b-12d3-a456-426614174002',
          email: 'prospect@example.com',
          custom_questions_answers: [
            { question: 'Phone number', answer: '+1-555-0123' },
          ],
        },
      })

      const signature = generateSignature(payload, CALENDLY_WEBHOOK_SECRET)

      await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/webhooks/calendly`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Calendly-Webhook-Signature': signature,
        },
        body: payload,
      })

      const { data: meetings } = await supabase
        .from('meetings')
        .select('invitee_phone')
        .eq('organisation_id', ctx.org_id)

      expect(meetings?.[0]?.invitee_phone).toBe('+1-555-0123')
    })

    it('silently returns 200 when prospect not found', async () => {
      const payload = JSON.stringify({
        event: {
          uri: 'https://api.calendly.com/event_types/123e4567-e89b-12d3-a456-426614174002',
          start_time: '2026-06-22T16:00:00Z',
          end_time: '2026-06-22T16:30:00Z',
        },
        invitee: {
          uri: 'https://api.calendly.com/invitees/789e1234-f45b-12d3-a456-426614174003',
          email: 'unknown@example.com',
        },
      })

      const signature = generateSignature(payload, CALENDLY_WEBHOOK_SECRET)

      const response = await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/webhooks/calendly`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Calendly-Webhook-Signature': signature,
        },
        body: payload,
      })

      expect(response.status).toBe(200)

      // Verify no meeting was created
      const { data: meetings } = await supabase
        .from('meetings')
        .select('*')
        .eq('organisation_id', ctx.org_id)

      expect(meetings).toHaveLength(0)
    })
  })

  describe('Invitee Canceled', () => {
    it('sets meeting to canceled and excludes from billing', async () => {
      // First create a meeting
      const { data: meeting, error: createError } = await supabase
        .from('meetings')
        .insert({
          organisation_id: ctx.org_id,
          prospect_id: ctx.prospect_id,
          source: 'calendly',
          calendly_event_uuid: 'event-uuid-123',
          calendly_invitee_uuid: 'invitee-uuid-123',
          scheduled_start_at: '2026-06-20T14:00:00Z',
          booked_at: new Date().toISOString(),
          meeting_status: 'booked',
        })
        .select('id')
        .single()

      if (createError) throw createError

      // Now send cancel webhook
      const payload = JSON.stringify({
        event: {
          uri: 'https://api.calendly.com/event_types/event-uuid-123',
          start_time: '2026-06-20T14:00:00Z',
          end_time: '2026-06-20T14:30:00Z',
        },
        invitee: {
          uri: 'https://api.calendly.com/invitees/invitee-uuid-123',
          email: 'prospect@example.com',
        },
        cancel_event: {
          cancellation_reason: 'Reschedule',
          canceled_by: 'invitee',
        },
      })

      const signature = generateSignature(payload, CALENDLY_WEBHOOK_SECRET)

      const response = await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/webhooks/calendly`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Calendly-Webhook-Signature': signature,
        },
        body: payload,
      })

      expect(response.status).toBe(200)

      // Verify meeting was updated
      const { data: updated } = await supabase
        .from('meetings')
        .select('*')
        .eq('id', meeting.id)
        .single()

      expect(updated?.meeting_status).toBe('canceled')
      expect(updated?.is_billable).toBe(false)
      expect(updated?.held_decision_locked).toBe(true)
    })
  })

  describe('Signature Verification', () => {
    it('rejects request with invalid signature', async () => {
      const payload = JSON.stringify({
        event: {
          uri: 'https://api.calendly.com/event_types/test',
          start_time: '2026-06-20T14:00:00Z',
          end_time: '2026-06-20T14:30:00Z',
        },
        invitee: {
          uri: 'https://api.calendly.com/invitees/test',
          email: 'prospect@example.com',
        },
      })

      const response = await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/webhooks/calendly`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Calendly-Webhook-Signature': 'invalid-signature',
        },
        body: payload,
      })

      expect(response.status).toBe(401)
    })

    it('rejects request with missing signature', async () => {
      const payload = JSON.stringify({
        event: {
          uri: 'https://api.calendly.com/event_types/test',
          start_time: '2026-06-20T14:00:00Z',
          end_time: '2026-06-20T14:30:00Z',
        },
        invitee: {
          uri: 'https://api.calendly.com/invitees/test',
          email: 'prospect@example.com',
        },
      })

      const response = await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/webhooks/calendly`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: payload,
      })

      expect(response.status).toBe(400)
    })
  })
})
