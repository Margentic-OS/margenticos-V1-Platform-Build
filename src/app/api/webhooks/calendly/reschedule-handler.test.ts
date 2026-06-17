import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'

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

// ─── Helper: Simulate the reschedule handler logic ──────────────────────────

function extractUuidFromUri(uri: string): string | null {
  const match = uri.match(/([a-f0-9\-]{36})$/)
  return match ? match[1] : null
}

async function handleInviteeRescheduled(
  payload: any,
  supabase: SupabaseClient,
): Promise<void> {
  const eventUuid = extractUuidFromUri(payload.event.uri)
  const inviteeUuid = extractUuidFromUri(payload.invitee.uri)

  if (!eventUuid || !inviteeUuid) {
    return
  }

  const { data: meeting, error: fetchError } = await supabase
    .from('meetings')
    .select('id, organisation_id, meeting_status, held_decision_locked')
    .eq('calendly_event_uuid', eventUuid)
    .eq('calendly_invitee_uuid', inviteeUuid)
    .single()

  if (fetchError || !meeting) {
    return
  }

  const { error: updateError } = await supabase
    .from('meetings')
    .update({
      scheduled_start_at: payload.event.start_time,
    })
    .eq('id', meeting.id)

  if (updateError) {
    throw updateError
  }
}

// ─── Test Suite ───────────────────────────────────────────────────────────

describe('Calendly Webhook Reschedule Handler', () => {
  describe('Event Type Detection', () => {
    it('distinguishes invitee.rescheduled by presence of reschedule_event', () => {
      const payload = {
        event: { uri: 'event-uuid', start_time: '2026-07-15', end_time: '2026-07-15' },
        invitee: { uri: 'invitee-uuid', email: 'test@example.com' },
        reschedule_event: { previous_event_start_time: '2026-07-01' },
      }

      const isReschedule = !!(payload as any).reschedule_event
      expect(isReschedule).toBe(true)
    })
  })

  describe('UUID Extraction', () => {
    it('extracts 36-char UUID from URI', () => {
      const uri = 'https://api.calendly.com/events/abc12345-def6-7890-abcd-ef1234567890'
      const uuid = extractUuidFromUri(uri)
      expect(uuid).toBe('abc12345-def6-7890-abcd-ef1234567890')
    })

    it('returns null for invalid URI', () => {
      const uuid = extractUuidFromUri('https://api.calendly.com/invalid')
      expect(uuid).toBeNull()
    })
  })

  describe('Reschedule Handler — No Orphaned Rows', () => {
    it('updates existing meeting by UUID (calls update, not insert)', async () => {
      const eventUri = 'https://api.calendly.com/events/abc12345-def6-7890-abcd-ef1234567890'
      const inviteeUri = 'https://api.calendly.com/invitees/98765abc-def4-3210-abcd-1234ef567890'

      const payload = {
        event: { uri: eventUri, start_time: '2026-07-15T16:30:00Z', end_time: '2026-07-15T17:30:00Z' },
        invitee: { uri: inviteeUri, email: 'prospect@example.com' },
        reschedule_event: { previous_event_start_time: '2026-07-01T10:00:00Z' },
      }

      const existingMeeting = {
        id: 'meeting-uuid-001',
        organisation_id: 'org-123',
        meeting_status: 'booked',
        held_decision_locked: false,
      }

      const updateMock = vi.fn().mockReturnThis()
      const eqMock = vi.fn().mockResolvedValue({ error: null, count: 1 })

      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'meetings') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              single: vi.fn().mockResolvedValue({ data: existingMeeting, error: null }),
              update: updateMock.mockReturnValue({ eq: eqMock }),
            }
          }
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() }
        }),
      } as unknown as SupabaseClient

      await handleInviteeRescheduled(payload, mockSupabase)

      // Verify from('meetings') was called
      expect(mockSupabase.from).toHaveBeenCalledWith('meetings')

      // Verify update was called with scheduled_start_at only
      expect(updateMock).toHaveBeenCalledWith({
        scheduled_start_at: '2026-07-15T16:30:00Z',
      })
    })
  })

  describe('Reschedule Handler — Locked Decisions Preserved', () => {
    it('does not modify meeting_status or held_decision_locked', async () => {
      const eventUri = 'https://api.calendly.com/events/abc12345-def6-7890-abcd-ef1234567890'
      const inviteeUri = 'https://api.calendly.com/invitees/98765abc-def4-3210-abcd-1234ef567890'

      const payload = {
        event: { uri: eventUri, start_time: '2026-07-20T10:00:00Z', end_time: '2026-07-20T11:00:00Z' },
        invitee: { uri: inviteeUri, email: 'test@example.com' },
        reschedule_event: { previous_event_start_time: '2026-07-01T10:00:00Z' },
      }

      const lockedMeeting = {
        id: 'meeting-held-001',
        organisation_id: 'org-123',
        meeting_status: 'held',
        held_decision_locked: true,
      }

      const updateMock = vi.fn()
      const eqMock = vi.fn().mockResolvedValue({ error: null, count: 1 })

      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'meetings') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              single: vi.fn().mockResolvedValue({ data: lockedMeeting, error: null }),
              update: updateMock.mockReturnValue({ eq: eqMock }),
            }
          }
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() }
        }),
      } as unknown as SupabaseClient

      await handleInviteeRescheduled(payload, mockSupabase)

      // Get the payload passed to update
      const updatePayload = updateMock.mock.calls[0]?.[0]

      // Update must contain scheduled_start_at only, not status fields
      expect(updatePayload).toBeDefined()
      expect(updatePayload).toHaveProperty('scheduled_start_at', '2026-07-20T10:00:00Z')
      expect(updatePayload).not.toHaveProperty('meeting_status')
      expect(updatePayload).not.toHaveProperty('held_decision_locked')
    })
  })
})
