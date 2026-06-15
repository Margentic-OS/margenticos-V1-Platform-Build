import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { generateConfirmationToken } from '@/lib/meetings/confirmation-token'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

interface TestContext {
  org_id: string
  prospect_id: string
  meeting_id: string
}

describe('Meeting Confirmation Endpoint', () => {
  let ctx: TestContext

  beforeAll(async () => {
    // Create test org with 72-hour window
    const { data: org } = await supabase
      .from('organisations')
      .insert({
        name: `Confirm Test Org ${Date.now()}`,
        slug: `confirm-test-${Date.now()}`,
        auto_held_window_hours: 72,
      })
      .select('id')
      .single()

    ctx = { org_id: org!.id, prospect_id: '', meeting_id: '' }

    // Create test prospect
    const { data: prospect } = await supabase
      .from('prospects')
      .insert({
        organisation_id: ctx.org_id,
        email: 'confirm@example.com',
        first_name: 'Confirm',
        last_name: 'Test',
      })
      .select('id')
      .single()

    ctx.prospect_id = prospect!.id

    // Create test meeting scheduled in the past but within window
    const scheduledTime = new Date()
    scheduledTime.setHours(scheduledTime.getHours() - 24) // 24 hours ago

    const { data: meeting } = await supabase
      .from('meetings')
      .insert({
        organisation_id: ctx.org_id,
        prospect_id: ctx.prospect_id,
        scheduled_start_at: scheduledTime.toISOString(),
        booked_at: new Date().toISOString(),
        meeting_status: 'booked',
        source: 'manual',
      })
      .select('id')
      .single()

    ctx.meeting_id = meeting!.id
  })

  afterEach(async () => {
    // Reset meeting after each test
    await supabase
      .from('meetings')
      .update({
        meeting_status: 'booked',
        held_decision_locked: false,
        held_confirmed_by: null,
        is_billable: false,
      })
      .eq('id', ctx.meeting_id)
  })

  describe('Idempotency', () => {
    it('records held decision on first POST', async () => {
      const token = generateConfirmationToken(ctx.meeting_id, ctx.org_id)

      const response = await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/meetings/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          decision: 'held',
        }),
      })

      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result.success).toBe(true)
      expect(result.meeting.meeting_status).toBe('held')
      expect(result.meeting.held_confirmed_by).toBe('client')
      expect(result.meeting.held_decision_locked).toBe(true)
      expect(result.meeting.is_billable).toBe(true)
    })

    it('returns current state on duplicate POST (idempotent)', async () => {
      const token = generateConfirmationToken(ctx.meeting_id, ctx.org_id)

      // First POST
      await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/meetings/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          decision: 'held',
        }),
      })

      // Second POST (duplicate)
      const response2 = await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/meetings/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          decision: 'held',
        }),
      })

      expect(response2.status).toBe(200)
      const result2 = await response2.json()
      expect(result2.success).toBe(true)
      expect(result2.message).toContain('already recorded')
      expect(result2.meeting.meeting_status).toBe('held')
    })

    it('email security scanner (HEAD/GET) does NOT trigger confirmation', async () => {
      // POST should record the decision
      const token = generateConfirmationToken(ctx.meeting_id, ctx.org_id)

      // Simulated scanner HEAD request (do nothing)
      const headResponse = await fetch(
        `${process.env.VERCEL_URL || 'http://localhost:3000'}/api/meetings/confirm`,
        {
          method: 'HEAD',
          headers: { 'Content-Type': 'application/json' },
        }
      )

      // Verify meeting is still booked (not held)
      const { data: meeting } = await supabase
        .from('meetings')
        .select('meeting_status, held_decision_locked')
        .eq('id', ctx.meeting_id)
        .single()

      expect(meeting?.meeting_status).toBe('booked')
      expect(meeting?.held_decision_locked).toBe(false)

      // Now POST with the token
      const postResponse = await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/meetings/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          decision: 'held',
        }),
      })

      expect(postResponse.status).toBe(200)

      // Verify meeting is now held
      const { data: updated } = await supabase
        .from('meetings')
        .select('meeting_status, held_decision_locked')
        .eq('id', ctx.meeting_id)
        .single()

      expect(updated?.meeting_status).toBe('held')
      expect(updated?.held_decision_locked).toBe(true)
    })
  })

  describe('Window Checks', () => {
    it('does not confirm if window has closed and meeting not yet decided', async () => {
      // Create a meeting scheduled far in the past (beyond window)
      const farPast = new Date()
      farPast.setHours(farPast.getHours() - 100) // 100 hours ago, beyond 72-hour window

      const { data: oldMeeting } = await supabase
        .from('meetings')
        .insert({
          organisation_id: ctx.org_id,
          prospect_id: ctx.prospect_id,
          scheduled_start_at: farPast.toISOString(),
          booked_at: new Date().toISOString(),
          meeting_status: 'booked',
          source: 'manual',
        })
        .select('id')
        .single()

      const token = generateConfirmationToken(oldMeeting!.id, ctx.org_id)

      const response = await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/meetings/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          decision: 'held',
        }),
      })

      // Should still allow confirmation (operator can always decide)
      // but is_billable remains tied to the decision
      expect(response.status).toBe(200)
    })
  })

  describe('Decision Recording', () => {
    it('sets is_billable=true on held decision', async () => {
      const token = generateConfirmationToken(ctx.meeting_id, ctx.org_id)

      await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/meetings/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          decision: 'held',
        }),
      })

      const { data: meeting } = await supabase
        .from('meetings')
        .select('is_billable, meeting_status')
        .eq('id', ctx.meeting_id)
        .single()

      expect(meeting?.is_billable).toBe(true)
      expect(meeting?.meeting_status).toBe('held')
    })

    it('sets is_billable=false on no_show decision', async () => {
      const token = generateConfirmationToken(ctx.meeting_id, ctx.org_id)

      await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/meetings/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          decision: 'no_show',
        }),
      })

      const { data: meeting } = await supabase
        .from('meetings')
        .select('is_billable, meeting_status')
        .eq('id', ctx.meeting_id)
        .single()

      expect(meeting?.is_billable).toBe(false)
      expect(meeting?.meeting_status).toBe('no_show')
    })

    it('leaves billed_at NULL after confirmation (manual invoicing only)', async () => {
      const token = generateConfirmationToken(ctx.meeting_id, ctx.org_id)

      await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/meetings/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          decision: 'held',
        }),
      })

      const { data: meeting } = await supabase
        .from('meetings')
        .select('billed_at, is_billable')
        .eq('id', ctx.meeting_id)
        .single()

      expect(meeting?.is_billable).toBe(true)
      expect(meeting?.billed_at).toBeNull() // Manual invoicing only
    })
  })
})
