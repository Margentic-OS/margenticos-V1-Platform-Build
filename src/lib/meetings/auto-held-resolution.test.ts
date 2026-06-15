import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { resolveAutoHeldMeetings } from './auto-held-resolution'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

interface TestContext {
  org_id: string
  prospect_id: string
}

describe('Auto-held Resolution', () => {
  let ctx: TestContext

  beforeAll(async () => {
    // Create test org with 72-hour window
    const { data: org } = await supabase
      .from('organisations')
      .insert({
        name: `AutoHeld Test Org ${Date.now()}`,
        slug: `autoheld-test-${Date.now()}`,
        auto_held_window_hours: 72,
      })
      .select('id')
      .single()

    ctx = { org_id: org!.id, prospect_id: '' }

    // Create test prospect
    const { data: prospect } = await supabase
      .from('prospects')
      .insert({
        organisation_id: ctx.org_id,
        email: 'autoheld@example.com',
        first_name: 'AutoHeld',
        last_name: 'Test',
      })
      .select('id')
      .single()

    ctx.prospect_id = prospect!.id
  })

  afterEach(async () => {
    // Clean up meetings after each test
    await supabase
      .from('meetings')
      .delete()
      .eq('organisation_id', ctx.org_id)
  })

  describe('Window Calculation', () => {
    it('does not auto-hold meeting scheduled in future', async () => {
      const futureTime = new Date()
      futureTime.setHours(futureTime.getHours() + 100) // 100 hours in future

      await supabase
        .from('meetings')
        .insert({
          organisation_id: ctx.org_id,
          prospect_id: ctx.prospect_id,
          scheduled_start_at: futureTime.toISOString(),
          booked_at: new Date().toISOString(),
          meeting_status: 'booked',
          source: 'manual',
        })

      await resolveAutoHeldMeetings()

      const { data: meeting } = await supabase
        .from('meetings')
        .select('meeting_status, held_decision_locked')
        .eq('organisation_id', ctx.org_id)
        .single()

      expect(meeting?.meeting_status).toBe('booked')
      expect(meeting?.held_decision_locked).toBe(false)
    })

    it('does not auto-hold meeting scheduled past but within window', async () => {
      const recentPast = new Date()
      recentPast.setHours(recentPast.getHours() - 24) // 24 hours ago (within 72-hour window)

      await supabase
        .from('meetings')
        .insert({
          organisation_id: ctx.org_id,
          prospect_id: ctx.prospect_id,
          scheduled_start_at: recentPast.toISOString(),
          booked_at: new Date().toISOString(),
          meeting_status: 'booked',
          source: 'manual',
        })

      await resolveAutoHeldMeetings()

      const { data: meeting } = await supabase
        .from('meetings')
        .select('meeting_status, held_decision_locked')
        .eq('organisation_id', ctx.org_id)
        .single()

      expect(meeting?.meeting_status).toBe('booked')
      expect(meeting?.held_decision_locked).toBe(false)
    })

    it('auto-holds meeting past window closure', async () => {
      const farPast = new Date()
      farPast.setHours(farPast.getHours() - 100) // 100 hours ago (beyond 72-hour window)

      await supabase
        .from('meetings')
        .insert({
          organisation_id: ctx.org_id,
          prospect_id: ctx.prospect_id,
          scheduled_start_at: farPast.toISOString(),
          booked_at: new Date().toISOString(),
          meeting_status: 'booked',
          source: 'manual',
        })

      await resolveAutoHeldMeetings()

      const { data: meeting } = await supabase
        .from('meetings')
        .select('meeting_status, held_confirmed_by, held_decision_locked, is_billable')
        .eq('organisation_id', ctx.org_id)
        .single()

      expect(meeting?.meeting_status).toBe('held')
      expect(meeting?.held_confirmed_by).toBe('auto')
      expect(meeting?.held_decision_locked).toBe(true)
      expect(meeting?.is_billable).toBe(true)
    })
  })

  describe('Exclusions', () => {
    it('skips canceled meetings', async () => {
      const farPast = new Date()
      farPast.setHours(farPast.getHours() - 100)

      await supabase
        .from('meetings')
        .insert({
          organisation_id: ctx.org_id,
          prospect_id: ctx.prospect_id,
          scheduled_start_at: farPast.toISOString(),
          booked_at: new Date().toISOString(),
          meeting_status: 'canceled',
          source: 'manual',
        })

      await resolveAutoHeldMeetings()

      const { data: meeting } = await supabase
        .from('meetings')
        .select('meeting_status')
        .eq('organisation_id', ctx.org_id)
        .single()

      expect(meeting?.meeting_status).toBe('canceled')
    })

    it('skips rescheduled meetings', async () => {
      const farPast = new Date()
      farPast.setHours(farPast.getHours() - 100)

      await supabase
        .from('meetings')
        .insert({
          organisation_id: ctx.org_id,
          prospect_id: ctx.prospect_id,
          scheduled_start_at: farPast.toISOString(),
          booked_at: new Date().toISOString(),
          meeting_status: 'rescheduled',
          source: 'calendly',
        })

      await resolveAutoHeldMeetings()

      const { data: meeting } = await supabase
        .from('meetings')
        .select('meeting_status')
        .eq('organisation_id', ctx.org_id)
        .single()

      expect(meeting?.meeting_status).toBe('rescheduled')
    })

    it('does not double-hold already-locked meetings', async () => {
      const farPast = new Date()
      farPast.setHours(farPast.getHours() - 100)

      const { data: meeting } = await supabase
        .from('meetings')
        .insert({
          organisation_id: ctx.org_id,
          prospect_id: ctx.prospect_id,
          scheduled_start_at: farPast.toISOString(),
          booked_at: new Date().toISOString(),
          meeting_status: 'held',
          held_confirmed_by: 'client',
          held_decision_locked: true,
          is_billable: true,
          source: 'manual',
        })
        .select('id')
        .single()

      // Run resolution twice
      await resolveAutoHeldMeetings()
      await resolveAutoHeldMeetings()

      const { data: final } = await supabase
        .from('meetings')
        .select('held_confirmed_by')
        .eq('id', meeting!.id)
        .single()

      expect(final?.held_confirmed_by).toBe('client') // Not overwritten to 'auto'
    })
  })

  describe('Billing', () => {
    it('auto-held meeting has is_billable=true and billed_at=NULL', async () => {
      const farPast = new Date()
      farPast.setHours(farPast.getHours() - 100)

      await supabase
        .from('meetings')
        .insert({
          organisation_id: ctx.org_id,
          prospect_id: ctx.prospect_id,
          scheduled_start_at: farPast.toISOString(),
          booked_at: new Date().toISOString(),
          meeting_status: 'booked',
          source: 'manual',
        })

      await resolveAutoHeldMeetings()

      const { data: meeting } = await supabase
        .from('meetings')
        .select('is_billable, billed_at')
        .eq('organisation_id', ctx.org_id)
        .single()

      expect(meeting?.is_billable).toBe(true)
      expect(meeting?.billed_at).toBeNull() // Not yet invoiced
    })
  })
})
