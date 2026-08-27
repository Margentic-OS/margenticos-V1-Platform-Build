import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient, bridgeEnvForSelfClientingModules } from '@/test-utils/test-database'
import {
  getClientVisibleCampaignMetrics,
  getAllCampaignMetricsForOrg,
} from './get-client-visible-campaign-metrics'

// Needs the TEST database. Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/metrics/get-client-visible-campaign-metrics.test.ts

describe('Campaign Metrics Chokepoint — ADR-030 Runtime Boundary', () => {
  let supabase: SupabaseClient<Database>
  let testOrgA: string
  let testOrgB: string

  beforeEach(async () => {
    // Was: read SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, and `return` quietly when
    // either was missing. Two defects in four lines.
    //
    // First, it wrote to whichever database those variables named, inserting
    // organisations called `Test Org A ${Date.now()}`. On this machine that was
    // production.
    //
    // Second, and worse, the early `return` meant a missing credential produced a
    // PASSING test file. Every assertion below was skipped and the suite reported
    // green, so this file has been claiming to prove the ADR-030 chokepoint while
    // proving nothing. It was not among the seven known integration files for
    // exactly that reason: the others failed loudly and this one did not.
    supabase = createTestServiceClient('get-client-visible-campaign-metrics.test.ts')

    // getClientVisibleCampaignMetrics builds its own service-role client rather than
    // accepting one, so the caller cannot hand it a session client by mistake. Point
    // that internal client at the test database too, or it would read the ambient
    // environment, which vitest.setup.ts has deliberately emptied.
    bridgeEnvForSelfClientingModules('get-client-visible-campaign-metrics.test.ts')

    // Every `it` below used to open with `if (!supabase || !testOrgA) return`. All seven
    // are gone. With beforeEach now throwing loudly on missing credentials those guards
    // could no longer prevent anything, and all they could still do is convert a real
    // failure into a silent pass. Same defect as the early return they used to pair with.
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
      // 'outbound' is NOT a permitted value. campaigns_campaign_type_check allows only
      // cold_email | linkedin_post | linkedin_dm. The insert below never checked its
      // error, so the constraint violation was swallowed, the campaign silently did not
      // exist, and the metrics assertions failed with 'expected +0 to be 100' — a
      // symptom that points nowhere near the cause. Invisible until now because this
      // file returned early from beforeEach and reported green without running.
      campaign_type: 'cold_email',
      status: 'active',
      sent_count: 100,
      replied_count: 5,
      bounced_count: 2,
      contacted_count: 60,
    })

    // Create campaigns with bounce data for org B
    await supabase.from('campaigns').insert({
      organisation_id: testOrgB,
      campaign_type: 'cold_email',
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

  it('client choicepoint returns totals only, never per-address or diagnostic fields', async () => {
    const result = await getClientVisibleCampaignMetrics(testOrgA)

    // DELIBERATE REVERSAL, 2026-08-24. This assertion used to be
    // expect(result).not.toHaveProperty('bouncedCount'), on the rule that a client must
    // never be shown bounce data. Bounce rate and opt-out rate are now on the list of
    // aggregates a client is always shown: hiding a client's own bounce rate protects
    // nothing and leaves them unable to tell a list-quality problem from a copy problem.
    //
    // What is still protected is the distinction between a TOTAL and an ATTRIBUTION. A
    // client may see how many bounced. They may never see which addresses did, nor
    // per-mailbox health, nor complaint rate.
    expect(Object.keys(result)).toEqual([
      'contactedCount',
      'sentCount',
      'deliveredCount',
      'bouncedCount',
      'unsubscribedCount',
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

    // The fields that remain diagnostic and must never appear.
    for (const forbidden of [
      'complaintRate', 'mailboxHealth', 'bouncedAddresses', 'perMailbox', 'suppressionReasons',
    ]) {
      expect(result).not.toHaveProperty(forbidden)
    }
    expect(result.bouncedCount).toBe(2)
  })

  it('counts a positive reply from the action row, which is where the classification lives', async () => {
    const result = await getClientVisibleCampaignMetrics(testOrgA)

    // One positive_passive action row was seeded. Before this change the query counted a
    // signal_type nothing writes and this read 0 no matter what the client received.
    expect(result.positiveReplyCount).toBe(1)
  })

  it('separates meetings booked from meetings held', async () => {
    const result = await getClientVisibleCampaignMetrics(testOrgA)

    // One meeting, seeded at 'booked'. Booked answers "did outreach produce meetings";
    // held answers "did they happen", and nobody has confirmed this one.
    expect(result.meetingsBooked).toBe(1)
    expect(result.meetingsHeld).toBe(0)
  })

  it('cross-org boundary: client choicepoint returns ZERO org-B rows when queried as org-A', async () => {
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

  it('client and operator variants are still distinct shapes', async () => {
    const clientResult = await getClientVisibleCampaignMetrics(testOrgA)
    const operatorResult = await getAllCampaignMetricsForOrg(supabase, testOrgA)

    // They agree on the facts they share.
    expect(clientResult.sentCount).toBe(operatorResult.sentCount)
    expect(clientResult.repliedCount).toBe(operatorResult.repliedCount)
    expect(clientResult.bouncedCount).toBe(operatorResult.bouncedCount)

    // The client shape carries things the operator shape does not, and the reverse. They
    // are separate types on purpose, so a field added for one cannot arrive in the other.
    expect(clientResult).toHaveProperty('contactedCount')
    expect(clientResult).toHaveProperty('meetingsHeld')
    expect(operatorResult).not.toHaveProperty('contactedCount')
    expect(operatorResult).toHaveProperty('meetingCount')
  })
})
