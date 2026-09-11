import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient, bridgeEnvForSelfClientingModules } from '@/test-utils/test-database'
import { deleteTestOrganisations } from '@/test-utils/delete-test-organisations'
import {
  getClientVisibleCampaignMetrics,
  getAllCampaignMetricsForOrg,
} from './get-client-visible-campaign-metrics'

// Needs the TEST database. Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/metrics/get-client-visible-campaign-metrics.test.ts

// A test fake is the one legitimate place to assert the ServiceRoleClient brand: the fake
// is not a real client at all, so no key can be checked. Declared once here rather than
// cast at each call, so the assertion stays visible and countable.
const brandedFake = (c: unknown) => c as import('@/lib/supabase/service-role').ServiceRoleClient

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
      // THE PROVIDER'S TALLY, SET DELIBERATELY WRONG. Nothing reads this column any more.
      // It is 7 rather than 0 so that a regression to campaigns.unsubscribed_count is
      // caught by a number that cannot coincide with the 2 our own records hold, instead
      // of by a zero that could mean either "reads the provider" or "found nobody".
      unsubscribed_count: 7,
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
        action_taken: 'send_reply',
        attempt_number: 1,
      })
    }

    // ── OPT-OUT FIXTURE ──────────────────────────────────────────────────────
    //
    // Built so every filter in the opt-out query has something to exclude. A fixture with
    // only the rows that should count cannot tell a working filter from a missing one.
    //
    //   P1  TWO opt_out rows      -> proves the count is DISTINCT PEOPLE, not rows
    //   P2  one opt_out row       -> the second person
    //   P3  one objection_mild    -> proves the intent filter; a soft no is not an opt-out
    //   --  one opt_out, no prospect -> excluded; the rate is denominated in people
    //   P4  one opt_out in ORG B  -> proves org-scoping
    //
    // Org A therefore expects 2, from 4 opt_out rows across 3 organisation-A people.
    async function seedAction(orgId: string, intent: string, prospectId: string | null) {
      const signal = await supabase
        .from('signals')
        .insert({ organisation_id: orgId, signal_type: 'reply_received', source: 'test' })
        .select('id')
        .single()
      if (!signal.data?.id) throw new Error(`Failed to seed signal: ${signal.error?.message}`)

      const action = await supabase.from('reply_handling_actions').insert({
        organisation_id: orgId,
        signal_id: signal.data.id,
        prospect_id: prospectId,
        classified_intent: intent,
        classification_confidence: 0.99,
        action_taken: intent === 'opt_out' ? 'suppress' : 'log_only',
        attempt_number: 1,
      })
      if (action.error) throw new Error(`Failed to seed action: ${action.error.message}`)
    }

    async function seedProspect(orgId: string, tag: string): Promise<string> {
      const row = await supabase
        .from('prospects')
        .insert({ organisation_id: orgId, email: `${tag}-${Date.now()}-${Math.random()}@example.com` })
        .select('id')
        .single()
      if (!row.data?.id) throw new Error(`Failed to seed prospect: ${row.error?.message}`)
      return row.data.id
    }

    const optOutP1 = await seedProspect(testOrgA, 'optout-a1')
    const optOutP2 = await seedProspect(testOrgA, 'optout-a2')
    const objectionP3 = await seedProspect(testOrgA, 'objection-a3')
    const optOutP4 = await seedProspect(testOrgB, 'optout-b1')

    await seedAction(testOrgA, 'opt_out', optOutP1)
    await seedAction(testOrgA, 'opt_out', optOutP1)   // same person, second message
    await seedAction(testOrgA, 'opt_out', optOutP2)
    await seedAction(testOrgA, 'objection_mild', objectionP3)
    await seedAction(testOrgA, 'opt_out', null)
    await seedAction(testOrgB, 'opt_out', optOutP4)

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
    // Org A carries a reply_handling_actions row, whose foreign key is NO ACTION, so
    // this delete returned 409 on every test while Org B three lines down succeeded.
    // 582 Org A rows, zero Org B rows. That asymmetry was the whole leak.
    await deleteTestOrganisations(
      supabase,
      [testOrgA, testOrgB],
      'get-client-visible-campaign-metrics.test.ts',
    )
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
      'repliedCount',
      // A TOTAL, not per-address. Added 2026-09-07: distinct people who replied, counted
      // from our own signals, because the client-facing Replies card was rendering the
      // sending tool's tally (2) while five people had actually replied. Passing the
      // ADR-030 boundary because it is a count with no address, no mailbox and no
      // per-recipient detail attached.
      'peopleRepliedCount',
      // Added 2026-09-08, and unsubscribedCount REMOVED in the same change. The provider
      // counts unsubscribe link clicks; our footer asks for a reply, so the provider's
      // number is blind to our opt-outs by construction. It read 0 live while two people
      // had written to say stop. Also a total with no address attached, so it passes the
      // ADR-030 boundary for the same reason peopleRepliedCount does.
      'peopleOptedOutCount',
      'replyRate',
      'positiveReplyCount',
      'meetingsBooked',
      'meetingsHeld',
      'meetingRate',
      'hasData',
    ])

    // RUNTIME DATA CHECK: values are correct, bounce is absent
    expect(result.sentCount).toBe(100)
    expect(result.repliedCount).toBe(5)

    // REPLIES PER PERSON CONTACTED, not per email. 5 of 60 people, not 5 of 100 emails.
    // Changed 2026-09-03: a four-step sequence sends up to four emails to one person, so
    // the send denominator counted the same person up to four times and produced a rate
    // about a quarter of what published reply-rate figures mean.
    //
    // This assertion is the mutation guard. Putting sentCount back in the denominator
    // turns it red, because 5/100 and 5/60 are different numbers and the fixture was
    // built so they cannot coincide.
    expect(result.replyRate).toBeCloseTo((5 / 60) * 100, 10)
    expect(result.replyRate).not.toBeCloseTo((5 / 100) * 100, 10)
    expect(result.hasData).toBe(true)

    // bounced_count IS selected now, to derive delivered. The raw total still never
    // leaves this function; 100 sent minus 2 bounced is the only trace of it.
    expect(result.deliveredCount).toBe(98)
    expect(result.contactedCount).toBe(60)

    // Different numbers from different columns, and that is the point. They were briefly
    // the same value rendered under two labels, which is how "52 prospects contacted"
    // reached a client who had emailed 24 people. Contacted is people, from
    // contacted_count. Delivered is emails, from sent_count minus bounced_count.
    expect(result.deliveredCount).not.toBe(result.contactedCount)

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
    const result = await getAllCampaignMetricsForOrg(brandedFake(supabase), testOrgA)

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
    const resultOrgA = await getAllCampaignMetricsForOrg(brandedFake(supabase), testOrgA)
    expect(resultOrgA.sentCount).toBe(100)
    expect(resultOrgA.bouncedCount).toBe(2)

    // Org B queries
    const resultOrgB = await getAllCampaignMetricsForOrg(brandedFake(supabase), testOrgB)
    expect(resultOrgB.sentCount).toBe(200)
    expect(resultOrgB.bouncedCount).toBe(4)

    // Confirm they are separate (org-scoping enforced)
    expect(resultOrgA.sentCount).not.toBe(resultOrgB.sentCount)
    expect(resultOrgA.bouncedCount).not.toBe(resultOrgB.bouncedCount)
  })

  it('client and operator variants are still distinct shapes', async () => {
    const clientResult = await getClientVisibleCampaignMetrics(testOrgA)
    const operatorResult = await getAllCampaignMetricsForOrg(brandedFake(supabase), testOrgA)

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

    // AND THEY AGREE ON THE REPLY RATE. The operator panel and the client's pages render
    // the same metric, so they must not compute it differently. The operator function
    // reads contacted_count to do this without returning it, which is why the assertion
    // above still holds.
    expect(operatorResult.replyRate).toBe(clientResult.replyRate)
    // Same rule for the meeting rate, for the same reason and from the same day.
    expect(operatorResult.meetingRate).toBe(clientResult.meetingRate)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // THE MEETING RATE, PROVED AGAINST A REAL DATABASE WITH CONSTRUCTED DATA
  //
  // The production meetings table holds ZERO rows, and did before this change and after
  // it. So there is no live before-and-after to show: both sides would read 0 and prove
  // nothing. These tests build the rows instead, in the test database, sized so that the
  // two candidate denominators cannot produce the same answer.
  //
  // The fixture is org A: 100 emails sent, 60 people contacted, 1 meeting booked.
  //   1 / 60 people = 1.6667%
  //   1 / 100 emails = 1.0%
  // Nothing rounds one into the other.

  it('divides meetings by people contacted, not by emails sent', async () => {
    const result = await getClientVisibleCampaignMetrics(testOrgA)

    // MUTATION GUARD. Put sentCount back under the meeting rate and the first line goes
    // red; the second is what it would go red AS, stated so the failure is legible.
    expect(result.meetingRate).toBeCloseTo((1 / 60) * 100, 10)
    expect(result.meetingRate).not.toBeCloseTo((1 / 100) * 100, 10)
  })

  it('agrees with a direct query of the same two tables', async () => {
    // The chokepoint's answer beside the database's own, rather than beside a constant
    // typed into this file. A hardcoded expectation only proves the code matches what
    // someone believed when they wrote the test; this proves it matches the rows.
    const result = await getClientVisibleCampaignMetrics(testOrgA)

    const { count: meetingsFromDb } = await supabase
      .from('meetings')
      .select('*', { count: 'exact', head: true })
      .eq('organisation_id', testOrgA)

    const { data: campaignRows } = await supabase
      .from('campaigns')
      .select('contacted_count, sent_count')
      .eq('organisation_id', testOrgA)

    const peopleFromDb = (campaignRows ?? []).reduce((n, c) => n + (c.contacted_count ?? 0), 0)
    const emailsFromDb = (campaignRows ?? []).reduce((n, c) => n + (c.sent_count ?? 0), 0)

    expect(meetingsFromDb).toBe(result.meetingsBooked)
    expect(peopleFromDb).toBe(result.contactedCount)
    // The claim itself, computed from the direct read.
    expect(result.meetingRate).toBeCloseTo((meetingsFromDb! / peopleFromDb) * 100, 10)
    // And the denominator really is the smaller of the two, which is what makes the
    // assertion above discriminating rather than a tautology.
    expect(peopleFromDb).toBeLessThan(emailsFromDb)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // THE OPT-OUT COUNT, PROVED AGAINST A REAL DATABASE AND AGAINST ITS MUTATIONS
  //
  // The card read 0 for a client who had two people write in to say stop, because it
  // divided campaigns.unsubscribed_count by emails sent. That column counts unsubscribe
  // LINK CLICKS, and our footer says "Not for you? Just reply stop." There is no link, so
  // the provider's number is blind to our opt-outs by construction and always will be.
  //
  // Every test below names the mutation it catches. If one fails, the question is not
  // "why is this strict", it is "where is the count coming from now".

  it('counts DISTINCT PEOPLE, so one person writing twice is one opt-out', async () => {
    const result = await getClientVisibleCampaignMetrics(testOrgA)

    // MUTATION: drop the de-duplication (return rows.length instead of the Set size) and
    // this reads 3, because P1 has two opt_out rows.
    expect(result.peopleOptedOutCount).toBe(2)
  })

  it('reads our own classification, never the provider tally', async () => {
    const result = await getClientVisibleCampaignMetrics(testOrgA)

    // MUTATION: put campaigns.unsubscribed_count back and this reads 7, which is what the
    // fixture sets it to precisely so the two can never coincide. The old defect would
    // have read 0 here, which is also not 2.
    expect(result.peopleOptedOutCount).toBe(2)
    expect(result.peopleOptedOutCount).not.toBe(7)
    // And the provider's field does not leave this function at all.
    expect(result).not.toHaveProperty('unsubscribedCount')
  })

  it('excludes a soft objection, which is a reply and not a request to stop', async () => {
    const result = await getClientVisibleCampaignMetrics(testOrgA)

    // MUTATION: widen the intent filter, or drop it, and P3's objection_mild joins the
    // count at 3. "Come back next quarter" is a soft no; nobody is suppressed for it.
    expect(result.peopleOptedOutCount).toBe(2)

    // The same person IS counted as having replied, which is the distinction the two
    // numbers exist to hold apart. Three people replied; two of them asked us to stop.
    expect(result.peopleRepliedCount).toBe(3)
    expect(result.peopleOptedOutCount).toBeLessThan(result.peopleRepliedCount)
  })

  it('is org-scoped: org B\'s opt-out never reaches org A', async () => {
    // MUTATION: drop .eq('organisation_id', clientOrgId) from the opt-out query and org A
    // reads 3 while org B reads 3, instead of 2 and 1.
    const resultOrgA = await getClientVisibleCampaignMetrics(testOrgA)
    const resultOrgB = await getClientVisibleCampaignMetrics(testOrgB)

    expect(resultOrgA.peopleOptedOutCount).toBe(2)
    expect(resultOrgB.peopleOptedOutCount).toBe(1)
  })

  it('agrees with a direct query of the same table', async () => {
    // The chokepoint's answer beside the database's own, rather than beside a constant
    // typed into this file. Same standard the meeting rate is held to above.
    const result = await getClientVisibleCampaignMetrics(testOrgA)

    const { data: rows } = await supabase
      .from('reply_handling_actions')
      .select('prospect_id')
      .eq('organisation_id', testOrgA)
      .eq('classified_intent', 'opt_out')

    const rowCount = (rows ?? []).length
    const peopleFromDb = new Set(
      (rows ?? []).map(r => r.prospect_id).filter((id): id is string => id !== null),
    ).size

    expect(result.peopleOptedOutCount).toBe(peopleFromDb)
    // And the two really are different numbers here, which is what makes the assertion
    // above discriminating rather than a tautology: 4 rows, 2 people, 1 of them unattributed.
    expect(rowCount).toBe(4)
    expect(rowCount).toBeGreaterThan(peopleFromDb)
  })

  it('is null rather than zero when nobody has been contacted', async () => {
    // Null, not 0. A rate of zero is a claim that outreach produced no meetings; "we have
    // not contacted anyone yet" is a different statement, and a client reading 0.0% on
    // their first day would be reading the first one.
    //
    // Needs its own organisation: orgA and orgB both carry a contacted_count, so neither
    // can reach this branch. Built and removed here rather than added to beforeEach,
    // where it would sit unused by every other test in the file.
    const now = Date.now()
    const uncontacted = await supabase
      .from('organisations')
      .insert({
        name: `Test Org C ${now}`,
        slug: `test-org-c-${now}`,
        founder_first_name: 'Test',
      })
      .select('id')
      .single()

    const orgC = uncontacted.data!.id
    try {
      const result = await getClientVisibleCampaignMetrics(orgC)

      expect(result.contactedCount).toBe(0)
      expect(result.meetingRate).toBeNull()
      expect(result.replyRate).toBeNull()
      // ZERO, not null. "Nobody has opted out" is a fact and the card can say it: the
      // counts line reads "0 opted out from 0 people contacted". Only the RATE has to
      // wait, and readRate is what withholds it.
      expect(result.peopleOptedOutCount).toBe(0)
      // And hasData is false, which is the flag every caller is told to check before
      // rendering any rate at all.
      expect(result.hasData).toBe(false)
    } finally {
      await supabase.from('organisations').delete().eq('id', orgC)
    }
  })
})
