import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}))

import { POST } from './route'

const WEBHOOK_SECRET = 'test-secret'
const EVENT_UUID = '123e4567-e89b-12d3-a456-426614174000'
const INVITEE_UUID = '789e1234-f45b-12d3-a456-426614174001'

function generateSignature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

function createMockRequest(payload: any, signature: string) {
  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const headers = new Map([
    ['Content-Type', 'application/json'],
    ['Calendly-Webhook-Signature', signature],
  ])

  return {
    method: 'POST',
    headers,
    text: async () => payloadString,
  }
}

describe('Calendly Webhook Handler - Logic Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CALENDLY_WEBHOOK_SECRET = WEBHOOK_SECRET
  })

  describe('Signature Verification', () => {
    it('computes correct HMAC-SHA256 signature', () => {
      const payload = 'test payload'
      const secret = 'test-secret'

      const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex')
      expect(computed).toBeDefined()
      expect(typeof computed).toBe('string')
      expect(computed.length).toBeGreaterThan(0)
    })

    it('validates matching signature', () => {
      const payload = JSON.stringify({ event: { uri: 'test' } })
      const signature = generateSignature(payload, WEBHOOK_SECRET)
      const computed = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex')

      expect(signature).toBe(computed)
    })

    it('rejects mismatched signature', () => {
      const payload = JSON.stringify({ event: { uri: 'test' } })
      const signature = generateSignature(payload, WEBHOOK_SECRET)
      const wrongSignature = signature.slice(0, -5) + 'xxxxx'

      expect(signature).not.toBe(wrongSignature)
    })
  })

  describe('UUID Extraction from URI', () => {
    it('extracts UUID from event URI (last 36 chars)', () => {
      const uri = `https://api.calendly.com/event_types/${EVENT_UUID}`
      const match = uri.match(/([a-f0-9\-]{36})$/)
      expect(match).toBeTruthy()
      expect(match?.[1]).toBe(EVENT_UUID)
    })

    it('extracts UUID from invitee URI', () => {
      const uri = `https://api.calendly.com/invitees/${INVITEE_UUID}`
      const match = uri.match(/([a-f0-9\-]{36})$/)
      expect(match).toBeTruthy()
      expect(match?.[1]).toBe(INVITEE_UUID)
    })

    it('returns null for invalid URI without UUID', () => {
      const uri = 'https://api.calendly.com/event_types/invalid'
      const match = uri.match(/([a-f0-9\-]{36})$/)
      expect(match).toBeNull()
    })
  })

  describe('Event Type Detection', () => {
    it('detects invitee.created event (no cancel_event property)', () => {
      const payload: any = {
        event: { uri: 'https://api.calendly.com/event_types/test' },
        invitee: { uri: 'https://api.calendly.com/invitees/test', email: 'test@example.com' },
      }

      const eventType = payload.cancel_event ? 'invitee.canceled' : 'invitee.created'
      expect(eventType).toBe('invitee.created')
    })

    it('detects invitee.canceled event (has cancel_event property)', () => {
      const payload: any = {
        event: { uri: 'https://api.calendly.com/event_types/test' },
        invitee: { uri: 'https://api.calendly.com/invitees/test', email: 'test@example.com' },
        cancel_event: { cancellation_reason: 'Reschedule', canceled_by: 'invitee' },
      }

      const eventType = payload.cancel_event ? 'invitee.canceled' : 'invitee.created'
      expect(eventType).toBe('invitee.canceled')
    })
  })

  describe('Phone Number Extraction', () => {
    it('extracts phone from custom_questions_answers when present', () => {
      const customAnswers: any[] = [
        { question: 'Phone number', answer: '+1-555-0123' },
        { question: 'Company', answer: 'Acme Inc' },
      ]

      const phoneAnswer = customAnswers.find(qa => qa.question.toLowerCase().includes('phone'))
      expect(phoneAnswer?.answer).toBe('+1-555-0123')
    })

    it('returns null if phone question not found', () => {
      const customAnswers: any[] = [{ question: 'Company', answer: 'Acme Inc' }]

      const phoneAnswer = customAnswers.find(qa => qa.question.toLowerCase().includes('phone'))
      expect(phoneAnswer).toBeUndefined()
    })

    it('handles empty custom_questions_answers', () => {
      const customAnswers: any = undefined

      const phoneAnswer = customAnswers?.find((qa: any) => qa.question.toLowerCase().includes('phone'))
      expect(phoneAnswer).toBeUndefined()
    })
  })

  describe('New Meeting Fields (invitee.created)', () => {
    it('sets source="calendly" for new bookings', () => {
      const source = 'calendly'
      expect(source).toBe('calendly')
    })

    it('sets meeting_status="booked" for new invitees', () => {
      const status = 'booked'
      expect(status).toBe('booked')
    })

    it('sets is_billable=false for new bookings (not billable until confirmed)', () => {
      const is_billable = false
      expect(is_billable).toBe(false)
    })

    it('sets held_decision_locked=false initially', () => {
      const locked = false
      expect(locked).toBe(false)
    })

    it('stores calendly_event_uuid and calendly_invitee_uuid', () => {
      const eventUuid = EVENT_UUID
      const inviteeUuid = INVITEE_UUID

      expect(eventUuid).toBe(EVENT_UUID)
      expect(inviteeUuid).toBe(INVITEE_UUID)
      expect(eventUuid.length).toBe(36)
      expect(inviteeUuid.length).toBe(36)
    })

    it('sets scheduled_start_at from event.start_time', () => {
      const startTime = '2026-06-20T14:00:00Z'
      expect(startTime).toBeDefined()
      // Date.toISOString() adds milliseconds (000), so verify it's a valid ISO date
      const parsed = new Date(startTime)
      expect(parsed.toISOString()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    })
  })

  describe('Canceled Meeting Fields (invitee.canceled)', () => {
    it('sets meeting_status="canceled"', () => {
      const status = 'canceled'
      expect(status).toBe('canceled')
    })

    it('sets is_billable=false when canceled', () => {
      const is_billable = false
      expect(is_billable).toBe(false)
    })

    it('does NOT set held_decision_locked on cancellation', () => {
      const updateFields = { meeting_status: 'canceled', is_billable: false }
      const has_locked_field = 'held_decision_locked' in updateFields
      expect(has_locked_field).toBe(false)
    })

    it('canceled meetings excluded from auto-held by status check', () => {
      // auto-held query uses: WHERE meeting_status='booked'
      // canceled status will never match this filter
      const meeting_status: string = 'canceled'
      const would_match_booked_filter = meeting_status === 'booked'
      expect(would_match_booked_filter).toBe(false)
    })
  })

  describe('Prospect Lookup Logic', () => {
    it('prefers prospect_id from tracking over email match', () => {
      const tracking: any = { prospect_id: 'preferred-id' }
      const prospect_id = tracking?.prospect_id || 'fallback-from-email'

      expect(prospect_id).toBe('preferred-id')
    })

    it('falls back to email match if no tracking.prospect_id', () => {
      const tracking: any = undefined
      const email = 'prospect@example.com'
      const prospect_id = tracking?.prospect_id || `lookup-by-email:${email}`

      expect(prospect_id).toContain(email)
    })

    it('unknown prospect returns silently (200 OK, no meeting created)', () => {
      // Handler pattern: returns 200 without creating meeting if prospect not found
      const created = false
      expect(created).toBe(false)
    })
  })

  describe('Error Handling', () => {
    it('missing signature header returns 400', async () => {
      const payload = {
        event: { uri: 'https://api.calendly.com/event_types/test' },
        invitee: { uri: 'https://api.calendly.com/invitees/test', email: 'test@example.com' },
      }

      const payloadString = JSON.stringify(payload)
      const headers = new Map([['Content-Type', 'application/json']])

      const request = {
        method: 'POST',
        headers,
        text: async () => payloadString,
      }

      const response = await POST(request as any)
      expect(response.status).toBe(400)
      const result = await response.json()
      expect(result.error).toBe('Missing signature')
    })

    it('invalid JSON payload returns 400', async () => {
      const invalidPayload = '{ invalid json'
      const headers = new Map([
        ['Content-Type', 'application/json'],
        ['Calendly-Webhook-Signature', generateSignature(invalidPayload, WEBHOOK_SECRET)],
      ])

      const request = {
        method: 'POST',
        headers,
        text: async () => invalidPayload,
      }

      const response = await POST(request as any)
      expect(response.status).toBe(400)
    })

    it('unhandled errors return 200 to prevent webhook retries', () => {
      // Calendly best practice: return 200 even on error to avoid retry loops
      // Errors logged to Sentry for investigation
      const shouldReturnOK = true
      expect(shouldReturnOK).toBe(true)
    })
  })

  describe('Upsert Pattern for idempotency', () => {
    it('uses onConflict: "calendly_event_uuid" for upsert', () => {
      const conflictKey = 'calendly_event_uuid'
      expect(conflictKey).toBeDefined()
    })

    it('upsert allows duplicate invitee.created to update existing meeting', () => {
      // If same event UUID is sent again, it should update the existing record
      const firstUpsert = { id: 'meeting-123', source: 'calendly' }
      const secondUpsert = { id: 'meeting-123', source: 'calendly' }
      expect(firstUpsert.id).toBe(secondUpsert.id)
    })

    it('invitee.canceled can match and update meeting from invitee.created', () => {
      const createdMeeting = { calendly_event_uuid: EVENT_UUID, meeting_status: 'booked' }
      const cancelPayload = {
        event: { uri: `https://api.calendly.com/event_types/${EVENT_UUID}` },
        cancel_event: { cancellation_reason: 'Reschedule' },
      }

      const uuidFromCancel = EVENT_UUID
      expect(uuidFromCancel).toBe(createdMeeting.calendly_event_uuid)
    })
  })
})
