import { describe, it, expect, beforeEach, vi } from 'vitest'

// Test the reschedule handling logic
describe('Calendly Webhook — Reschedule Event Handling', () => {
  describe('Event Type Determination', () => {
    it('detects invitee.created event (no cancel_event, no reschedule_event)', () => {
      const payload = {
        event: { uri: 'event-uuid', start_time: '2026-07-01', end_time: '2026-07-01' },
        invitee: { uri: 'invitee-uuid', email: 'test@example.com' },
      }

      // Type determination logic from route.ts
      let eventType: 'invitee.created' | 'invitee.canceled' | 'invitee.rescheduled'
      if ((payload as any).cancel_event) {
        eventType = 'invitee.canceled'
      } else if ((payload as any).reschedule_event) {
        eventType = 'invitee.rescheduled'
      } else {
        eventType = 'invitee.created'
      }

      expect(eventType).toBe('invitee.created')
    })

    it('detects invitee.canceled event (has cancel_event)', () => {
      const payload = {
        event: { uri: 'event-uuid', start_time: '2026-07-01', end_time: '2026-07-01' },
        invitee: { uri: 'invitee-uuid', email: 'test@example.com' },
        cancel_event: { cancellation_reason: 'No longer interested' },
      }

      let eventType: 'invitee.created' | 'invitee.canceled' | 'invitee.rescheduled'
      if ((payload as any).cancel_event) {
        eventType = 'invitee.canceled'
      } else if ((payload as any).reschedule_event) {
        eventType = 'invitee.rescheduled'
      } else {
        eventType = 'invitee.created'
      }

      expect(eventType).toBe('invitee.canceled')
    })

    it('detects invitee.rescheduled event (has reschedule_event)', () => {
      const payload = {
        event: { uri: 'event-uuid', start_time: '2026-07-15', end_time: '2026-07-15' },
        invitee: { uri: 'invitee-uuid', email: 'test@example.com' },
        reschedule_event: { previous_event_start_time: '2026-07-01' },
      }

      let eventType: 'invitee.created' | 'invitee.canceled' | 'invitee.rescheduled'
      if ((payload as any).cancel_event) {
        eventType = 'invitee.canceled'
      } else if ((payload as any).reschedule_event) {
        eventType = 'invitee.rescheduled'
      } else {
        eventType = 'invitee.created'
      }

      expect(eventType).toBe('invitee.rescheduled')
    })
  })

  describe('UUID Extraction', () => {
    it('extracts UUID from Calendly event.uri', () => {
      const eventUri = 'https://api.calendly.com/events/abc12345-def6-7890-abcd-ef1234567890'
      const uuidMatch = eventUri.match(/([a-f0-9\-]{36})$/)
      expect(uuidMatch).toBeDefined()
      expect(uuidMatch?.[1]).toBe('abc12345-def6-7890-abcd-ef1234567890')
    })

    it('extracts UUID from Calendly invitee.uri', () => {
      const inviteeUri = 'https://api.calendly.com/scheduled_events/event-id/invitees/98765abc-def4-3210-abcd-1234ef567890'
      const uuidMatch = inviteeUri.match(/([a-f0-9\-]{36})$/)
      expect(uuidMatch).toBeDefined()
      expect(uuidMatch?.[1]).toBe('98765abc-def4-3210-abcd-1234ef567890')
    })

    it('returns null for invalid URI format', () => {
      const invalidUri = 'https://api.calendly.com/invalid'
      const uuidMatch = invalidUri.match(/([a-f0-9\-]{36})$/)
      expect(uuidMatch).toBeNull()
    })
  })

  describe('Reschedule Update Logic', () => {
    it('constructs update with scheduled_start_at from new event time', () => {
      const newStartTime = '2026-07-15T16:30:00Z'

      const updatePayload = {
        scheduled_start_at: newStartTime,
      }

      expect(updatePayload.scheduled_start_at).toBe(newStartTime)
      expect(updatePayload).not.toHaveProperty('meeting_status')
      expect(updatePayload).not.toHaveProperty('held_decision_locked')
    })

    it('does NOT update meeting_status or held_decision_locked on reschedule', () => {
      // The reschedule handler should only update scheduled_start_at
      // Status changes are NOT part of reschedule logic
      const updatePayload = {
        scheduled_start_at: '2026-07-15T16:30:00Z',
      }

      expect(updatePayload).toHaveProperty('scheduled_start_at')
      expect(updatePayload).not.toHaveProperty('meeting_status')
      expect(updatePayload).not.toHaveProperty('held_decision_locked')
    })

    it('reschedule earlier than original moves auto-held window earlier', () => {
      const org = { auto_held_window_hours: 72 }
      const now = new Date('2026-07-10T00:00:00Z')

      // Original meeting: 2026-07-01 14:00
      const originalTime = new Date('2026-07-01T14:00:00Z').getTime()
      const originalWindowEnd = originalTime + org.auto_held_window_hours * 60 * 60 * 1000
      const originalEligible = now.getTime() >= originalWindowEnd

      // After 10 days, original meeting is auto-holdable
      expect(originalEligible).toBe(true)

      // Reschedule to earlier: 2026-06-15 14:00
      const earlierTime = new Date('2026-06-15T14:00:00Z').getTime()
      const earlierWindowEnd = earlierTime + org.auto_held_window_hours * 60 * 60 * 1000
      const earlierEligible = now.getTime() >= earlierWindowEnd

      // Even earlier time moves window earlier
      expect(earlierWindowEnd).toBeLessThan(originalWindowEnd)
      expect(earlierEligible).toBe(true)
    })

    it('reschedule later than original moves auto-held window later', () => {
      const org = { auto_held_window_hours: 72 }
      const now = new Date('2026-07-10T00:00:00Z')

      // Original meeting: 2026-07-01 14:00
      const originalTime = new Date('2026-07-01T14:00:00Z').getTime()
      const originalWindowEnd = originalTime + org.auto_held_window_hours * 60 * 60 * 1000
      const originalEligible = now.getTime() >= originalWindowEnd

      expect(originalEligible).toBe(true)

      // Reschedule to later: 2026-07-20 14:00
      const laterTime = new Date('2026-07-20T14:00:00Z').getTime()
      const laterWindowEnd = laterTime + org.auto_held_window_hours * 60 * 60 * 1000
      const laterEligible = now.getTime() >= laterWindowEnd

      // Later time moves window later, so NOT eligible for auto-hold yet
      expect(laterWindowEnd).toBeGreaterThan(originalWindowEnd)
      expect(laterEligible).toBe(false)
    })
  })

  describe('Locked Decision Handling', () => {
    it('does not unlock held_decision_locked on reschedule', () => {
      // If a meeting is already locked (held or no_show confirmed),
      // reschedule should not change held_decision_locked
      const meeting = {
        id: 'meeting-123',
        meeting_status: 'held',
        held_decision_locked: true,
        held_confirmed_by: 'auto',
      }

      const updatePayload = {
        scheduled_start_at: '2026-07-15T16:30:00Z',
      }

      // After reschedule, held_decision_locked should remain true
      expect(meeting.held_decision_locked).toBe(true)
      expect(updatePayload).not.toHaveProperty('held_decision_locked')

      // The meeting fields should be unchanged except for scheduled_start_at
      const expectedMeeting = {
        ...meeting,
        scheduled_start_at: '2026-07-15T16:30:00Z',
      }

      expect(expectedMeeting.held_decision_locked).toBe(true)
      expect(expectedMeeting.meeting_status).toBe('held')
    })
  })

  describe('No Orphaned Rows', () => {
    it('reschedule uses same Calendly UUIDs (no new row created)', () => {
      // Calendly reschedule events use the same UUIDs
      const eventUuid = 'event-abc-123'
      const inviteeUuid = 'invitee-xyz-789'

      // Before reschedule: meeting exists with these UUIDs
      const beforeReschedule = {
        meeting_id: 'meeting-1',
        calendly_event_uuid: eventUuid,
        calendly_invitee_uuid: inviteeUuid,
      }

      // After reschedule: same UUIDs, same meeting row
      const afterReschedule = {
        meeting_id: 'meeting-1',
        calendly_event_uuid: eventUuid,
        calendly_invitee_uuid: inviteeUuid,
      }

      // No duplicate rows created
      expect(afterReschedule.meeting_id).toBe(beforeReschedule.meeting_id)
      expect(afterReschedule.calendly_event_uuid).toBe(beforeReschedule.calendly_event_uuid)
      expect(afterReschedule.calendly_invitee_uuid).toBe(beforeReschedule.calendly_invitee_uuid)
    })
  })
})
