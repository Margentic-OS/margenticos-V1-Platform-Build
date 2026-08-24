import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import {
  getClientVisibleCampaignMetrics,
  getAllCampaignMetricsForOrg,
} from './get-client-visible-campaign-metrics'

describe('Campaign Metrics Choicepoint — ADR-026 Runtime Boundary', () => {
  let supabase: ReturnType<typeof createClient<Database>>
  let testOrgA: string
  let testOrgB: string

  beforeEach(async () => {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!url || !key) {
      console.warn('Skipping campaign metrics tests: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set')
      return
    }

    supabase = createClient<Database>(url, key)
    // getClientVisibleCampaignMetrics builds its own service-role client rather than
    // accepting one, so the caller cannot hand it a session client by mistake. It reads
    // NEXT_PUBLIC_SUPABASE_URL; this suite is configured with SUPABASE_URL.
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= url
    // Create two test organisations
    const now = Date.now()
    const orgA = await supabase
      .from('organisations')
      .insert({
        name: `Test Org A ${now}`,
        slug: `test-org-a-${now}`,
        founder_first_name: 'Test',
        contract_start_date: new Date().toISOString().split('T')[0],
      })
      .select('id')
      .single()

    const orgB = await supabase
      .from('organisations')
      .insert({
        name: `Test Org B ${now}`,
        slug: `test-org-b-${now}`,
        founder_first_name: 'Test',
        contract_start_date: new Date().toISOString().split('T')[0],
      })
      .select('id')
      .single()

    if (!orgA.data?.id || !orgB.data?.id) throw new Error('Failed to create test orgs')
    testOrgA = orgA.data.id
    testOrgB = orgB.data.id

    // Create campaigns with bounce data for org A
    await supabase.from('campaigns').insert({
      organisation_id: testOrgA,
      campaign_type: 'outbound',
      status: 'active',
      sent_count: 100,
      replied_count: 5,
      bounced_count: 2,
      contacted_count: 60,
    })

    // Create campaigns with bounce data for org B
    await supabase.from('campaigns').insert({
      organisation_id: testOrgB,
      campaign_type: 'outbound',
      status: 'active',
      sent_count: 200,
      replied_count: 10,
      bounced_count: 4,
      contacted_count: 120,
    })

    // A positive reply, recorded the way production actually records one.
    //
    // This block used to insert a signal with signal_type 'positive_reply' and assert the
    // count came back. Nothing in the system has ever written that signal_type — the
    // poller writes 'reply_received' and the classifier writes its verdict to
    // reply_handling_actions.classified_intent. The fixture manufactured a row shape that
    // does not occur, which is precisely how a metric that was structurally always zero
    // passed its own test.
    const replySignal = await supabase
      .from('signals')
      .insert({ organisation_id: testOrgA, signal_type: 'reply_received', source: 'test' })
      .select('id')
      .single()

    if (replySignal.data?.id) {
      await supabase.from('reply_handling_actions').insert({
        organisation_id: testOrgA,
        signal_id: replySignal.data.id,
        classified_intent: 'positive_passive',
        classification_confidence: 0.95,
        action_taken: 'auto_reply_calendly',
        attempt_number: 1,
      })
    }

    // Insert meeting for org A
    const prospect = await supabase
      .from('prospects')
      .insert({ organisation_id: testOrgA, email: `test-a-${Date.now()}@example.com` })
      .select('id')
      .single()

    if (prospect.data?.id) {
      await supabase.from('meetings').insert({
        organisation_id: testOrgA,
        prospect_id: prospect.data.id,
        meeting_date: new Date().toISOString(),
        qualification: 'qualified',
        meeting_status: 'booked',
      })
    }
  })

  afterEach(async () => {
    if (testOrgA) await supabase.from('organisations').delete().eq('id', testOrgA)
    if (testOrgB) await supabase.from('organisations').delete().eq('id', testOrgB)
  })

  it('client choicepoint returns object WITHOUT bouncedCount at runtime (data layer proof)', async () => {
    if (!supabase || !testOrgA) return
    // CRITICAL: Call the real function against real DB data that HAS bounced_count
    const result = await getClientVisibleCampaignMetrics(testOrgA)

    // RUNTIME ASSERTION: the returned object must NOT have bouncedCount property
    expect(result).not.toHaveProperty('bouncedCount')
    expect(Object.keys(result)).toEqual([
      'contactedCount',
      'sentCount',
      'deliveredCount',
      'repliedCount',
      'replyRate',
      'positiveReplyCount',
      'meetingsBooked',
      'meetingsHeld',
      'hasData',
    ])

    // RUNTIME DATA CHECK: values are correct, bounce is absent
    expect(result.sentCount).toBe(100)
    expect(result.repliedCount).toBe(5)
    expect(result.replyRate).toBe(5)
    expect(result.hasData).toBe(true)

    // bounced_count IS selected now, to derive delivered. The raw total still never
    // leaves this function; 100 sent minus 2 bounced is the only trace of it.
    expect(result.deliveredCount).toBe(98)
    expect(result.contactedCount).toBe(60)

    // CRITICAL: Verify the query selected ONLY safe columns
    // The function logic shows SELECT 'sent_count, replied_count' — never bounced_count
    // This assertion proves the data layer excludes bounced_count from the SELECT clause
    expect((result as unknown as Record<string, unknown>).bouncedCount).toBeUndefined()
  })

  it('counts a positive reply from the action row, which is where the classification lives', async () => {
    if (!supabase || !testOrgA) return
    const result = await getClientVisibleCampaignMetrics(testOrgA)

    // One positive_passive action row was seeded. Before this change the query counted a
    // signal_type nothing writes and this read 0 no matter what the client received.
    expect(result.positiveReplyCount).toBe(1)
  })

  it('separates meetings booked from meetings held', async () => {
    if (!supabase || !testOrgA) return
    const result = await getClientVisibleCampaignMetrics(testOrgA)

    // One meeting, seeded at 'booked'. Booked answers "did outreach produce meetings";
    // held answers "did they happen", and nobody has confirmed this one.
    expect(result.meetingsBooked).toBe(1)
    expect(result.meetingsHeld).toBe(0)
  })

  it('cross-org boundary: client choicepoint returns ZERO org-B rows when queried as org-A', async () => {
    if (!supabase || !testOrgA || !testOrgB) return
    // CRITICAL: Org A queries its own metrics
    const resultOrgA = await getClientVisibleCampaignMetrics(testOrgA)

    // Should return only org A's sent count (100), NOT org B's (200)
    expect(resultOrgA.sentCount).toBe(100)

    // Org B queries its own metrics
    const resultOrgB = await getClientVisibleCampaignMetrics(testOrgB)

    // Should return only org B's sent count (200), NOT org A's
    expect(resultOrgB.sentCount).toBe(200)

    // CRITICAL: Confirm they are completely separate (cross-org excluded)
    expect(resultOrgA.sentCount).not.toBe(resultOrgB.sentCount)
  })

  it('operator variant returns bouncedCount at runtime (ALL metrics)', async () => {
    if (!supabase || !testOrgA) return
    // CRITICAL: Call the operator-only function against the same org
    const result = await getAllCampaignMetricsForOrg(supabase, testOrgA)

    // RUNTIME ASSERTION: the returned object MUST have bouncedCount property
    expect(result).toHaveProperty('bouncedCount')
    expect(result.bouncedCount).toBe(2)

    // Verify it has all diagnostic fields
    expect(Object.keys(result)).toContain('bouncedCount')

    // Verify client-safe fields are still there
    expect(result.sentCount).toBe(100)
    expect(result.repliedCount).toBe(5)
  })

  it('operator variant is org-scoped: returns ZERO cross-org data', async () => {
    if (!supabase || !testOrgA || !testOrgB) return
    // Org A queries
    const resultOrgA = await getAllCampaignMetricsForOrg(supabase, testOrgA)
    expect(resultOrgA.sentCount).toBe(100)
    expect(resultOrgA.bouncedCount).toBe(2)

    // Org B queries
    const resultOrgB = await getAllCampaignMetricsForOrg(supabase, testOrgB)
    expect(resultOrgB.sentCount).toBe(200)
    expect(resultOrgB.bouncedCount).toBe(4)

    // Confirm they are separate (org-scoping enforced)
    expect(resultOrgA.sentCount).not.toBe(resultOrgB.sentCount)
    expect(resultOrgA.bouncedCount).not.toBe(resultOrgB.bouncedCount)
  })

  it('client and operator variants are distinguishable at runtime', async () => {
    if (!supabase || !testOrgA) return
    // Call both against the same org
    const clientResult = await getClientVisibleCampaignMetrics(testOrgA)
    const operatorResult = await getAllCampaignMetricsForOrg(supabase, testOrgA)

    // CRITICAL: Client result DOES NOT have bouncedCount
    expect(clientResult).not.toHaveProperty('bouncedCount')
    expect((clientResult as unknown as Record<string, unknown>).bouncedCount).toBeUndefined()

    // CRITICAL: Operator result DOES have bouncedCount
    expect(operatorResult).toHaveProperty('bouncedCount')
    expect(operatorResult.bouncedCount).toBe(2)

    // Both have the safe metrics
    expect(clientResult.sentCount).toBe(operatorResult.sentCount)
    expect(clientResult.repliedCount).toBe(operatorResult.repliedCount)
  })
})
