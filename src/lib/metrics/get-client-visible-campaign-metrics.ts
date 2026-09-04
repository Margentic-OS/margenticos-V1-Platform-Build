import { asServiceRoleClient, type ServiceRoleClient } from '@/lib/supabase/service-role'
// src/lib/metrics/get-client-visible-campaign-metrics.ts
//
// SINGLE CHOKEPOINT for all client-facing campaign metrics reads.
// ALL client views of campaign metrics must go through this function.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT BUILDS ITS OWN SERVICE-ROLE CLIENT, AND THE CALLER CANNOT PASS ONE IN
//
// This used to take a SupabaseClient. Every client-facing caller handed it the SESSION
// client, and the session client returns ZERO ROWS, silently, on every table a client
// cannot read. No error, no empty-state, just a confident 0 rendered as fact. That
// failure has now recurred three times in this build, and it recurs because the two
// clients are the same TypeScript type: nothing can tell them apart at compile time and
// nothing complains at runtime.
//
// So the choice is taken away from the caller. This function constructs the service-role
// client itself and accepts an organisation id only. Handing it the wrong client is no
// longer possible.
//
// WHAT THAT COSTS, NAMED EXPLICITLY: org-scoping here no longer has an RLS backstop. The
// .eq('organisation_id', orgId) filter on every query below IS the entire gate. That is
// ADR-027's two-client pattern, not a new decision — the session client owns
// authentication and the org resolution in the route, the service client owns the read.
// Every query in this file must carry that filter. There are no exceptions and there is
// no query here without one.
//
// The alternative was giving clients an RLS read policy on reply_handling_actions. That
// is strictly worse: the rows carry intent labels, classification confidence, tier
// assignment and suppression reasons, none of which a client may ever see. A read policy
// would put all of it one anon-key query away, and the intent filter below has no DB
// backstop by design (see get-client-visible-replies.ts).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS SAFE TO RETURN
//
// Health metrics only. Diagnostic fields — complaint rate, mailbox health, per-mailbox
// anything — are never selected and never returned.
//
// bounced_count and unsubscribed_count are BOTH selected and BOTH returned, and that is a
// deliberate reversal of the earlier rule in this file, which said bounced_count must
// never be fetched or returned.
//
// The reversal is a product decision, not a drift: bounce rate and opt-out rate are on
// the list of aggregates a client is always shown. Hiding a client's own bounce rate from
// them does not protect anything, and it leaves them unable to tell a list-quality
// problem from a copy problem in their own campaign.
//
// What stays diagnostic and is still never fetched here: per-mailbox attribution,
// complaint rate, mailbox health, and anything that identifies WHICH addresses bounced.
// A total the client can reason about is not the same as a list of names.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { Database } from '@/types/database'
import { CLIENT_VISIBLE_INTENTS } from '@/lib/reply-handling/get-client-visible-replies'

type SupabaseServiceClient = ServiceRoleClient

export interface ClientVisibleCampaignMetrics {
  // PEOPLE the sequence has started for. Not emails.
  contactedCount: number
  // Emails handed to the sending tool.
  sentCount: number
  // sentCount minus bounces. What actually landed.
  deliveredCount: number
  // Totals, never per-address. A client may see how many bounced or opted out; they may
  // never see which addresses did.
  bouncedCount: number
  unsubscribedCount: number
  repliedCount: number
  // REPLIES PER PERSON CONTACTED, not per email. See the note by its computation below.
  replyRate: number | null
  // Replies whose classified intent is in the client-visible positive set. Counted from
  // the SAME list the replies page filters on, so this number can never disagree with the
  // number of cards shown there.
  positiveReplyCount: number
  meetingsBooked: number
  meetingsHeld: number
  // MEETINGS PER PERSON CONTACTED, not per email. Same unit as replyRate and for the same
  // reason. Null when nobody has been contacted yet.
  meetingRate: number | null
  // True once a single email has gone out. Callers must not render rates when false.
  hasData: boolean
}

function serviceRoleClient(): SupabaseServiceClient {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    // Loud rather than empty. A missing key used to mean "every number reads 0", which is
    // indistinguishable from a client who has genuinely sent nothing.
    throw new Error(
      'getClientVisibleCampaignMetrics: SUPABASE_SERVICE_ROLE_KEY is not set. Client-facing ' +
      'metrics read protected tables and cannot fall back to the session client, which ' +
      'returns zero rows silently.'
    )
  }
  // asServiceRoleClient is applied to the SAME expression that passes the service-role
  // key, which is the only place the brand may be claimed.
  return asServiceRoleClient(
    createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
  )
}

/**
 * Fetches campaign metrics visible to a client.
 * SINGLE CHOKEPOINT: all client-facing campaign metric reads must use this function.
 *
 * The caller is responsible for having resolved clientOrgId through the session client
 * (resolveViewingOrg). This function trusts that id and scopes every query to it.
 */
export async function getClientVisibleCampaignMetrics(
  clientOrgId: string
): Promise<ClientVisibleCampaignMetrics> {
  const supabase = serviceRoleClient()

  const [campaignsResult, positiveRepliesResult, meetingsResult] = await Promise.all([
    supabase
      .from('campaigns')
      .select('contacted_count, sent_count, replied_count, bounced_count, unsubscribed_count')
      .eq('organisation_id', clientOrgId),

    // THE PREVIOUS QUERY HERE COULD NEVER HAVE RETURNED ANYTHING.
    // It counted signals with signal_type = 'positive_reply'. Nothing in this system has
    // ever written that value: the poller writes 'reply_received' and the classifier
    // writes its verdict to reply_handling_actions.classified_intent, not back to the
    // signal. Live check on 2026-08-24, across every org: 14 signals, all of them
    // 'reply_received', zero 'positive_reply'. So the client's positive reply count was
    // structurally 0 and always would have been, whatever they received.
    //
    // The classification lives on the action row, so that is what is counted. The intent
    // list is imported from the reply chokepoint rather than restated, so this number and
    // the replies page can never drift apart.
    supabase
      .from('reply_handling_actions')
      .select('*', { count: 'exact', head: true })
      .eq('organisation_id', clientOrgId)
      .in('classified_intent', CLIENT_VISIBLE_INTENTS),

    // meeting_status, not status. Both columns exist and both default to 'booked', but
    // meeting_status is the one the Calendly webhook and the confirm route actually
    // write ('booked', 'held', 'no_show', 'canceled', 'rescheduled').
    supabase
      .from('meetings')
      .select('meeting_status')
      .eq('organisation_id', clientOrgId),
  ])

  const campaigns = campaignsResult.data ?? []
  const contactedCount = campaigns.reduce((sum, c) => sum + (c.contacted_count ?? 0), 0)
  const sentCount      = campaigns.reduce((sum, c) => sum + (c.sent_count      ?? 0), 0)
  const repliedCount   = campaigns.reduce((sum, c) => sum + (c.replied_count   ?? 0), 0)
  const bouncedCount   = campaigns.reduce((sum, c) => sum + (c.bounced_count   ?? 0), 0)
  const unsubscribedCount = campaigns.reduce((sum, c) => sum + (c.unsubscribed_count ?? 0), 0)

  // Clamped at zero. Bounces and sends are refreshed in the same statement so they should
  // never cross, but a negative "delivered" on a client's dashboard is not a number worth
  // being pedantic to preserve.
  const deliveredCount = Math.max(0, sentCount - bouncedCount)

  const meetings = meetingsResult.data ?? []

  return {
    contactedCount,
    sentCount,
    deliveredCount,
    bouncedCount,
    unsubscribedCount,
    repliedCount,
    // ─── DENOMINATED IN PEOPLE, NOT EMAILS ────────────────────────────────────
    //
    // A four-step sequence sends up to four emails to one person, so sentCount counts the
    // same person up to four times. Per person is the more meaningful statistic: four
    // emails to one person are one person deciding once, not four independent chances of
    // a reply. Live: 2 replies from 60 emails reads 3.3%, the same 2 replies from 24
    // people reads 8.3%.
    //
    // THE ORIGINAL VERSION OF THIS COMMENT WAS WRONG AND IS CORRECTED HERE, because it
    // would mislead the next reader exactly as it misled the last one.
    //
    // It said the per-email rate "came out roughly a quarter of what published
    // reply-rate figures mean". That is backwards. The published figure this page showed
    // was the Instantly report's, and that report defines its reply rate as "percentage
    // of all replies received (including follow-up responses) divided by TOTAL EMAILS
    // SENT". Per email. So the per-email rate was the one that MATCHED the range, and
    // moving to people made the comparison wrong rather than right, for one day.
    //
    // The move to people is still correct on the statistics and stands. What was missing
    // was moving the RANGE with it, which was done on 2026-09-03: the benchmarks page now
    // cites two sources that state a per-contact denominator in their own words. See
    // tier1-benchmarks.ts.
    //
    // THE LESSON, since it cost a shipped defect: a denominator change is a change to
    // BOTH SIDES of a comparison. Changing our half and leaving the published half is not
    // a partial fix, it is a new defect pointing the other way.
    //
    // CHANGED HERE, AT THE CHOKEPOINT, RATHER THAN ON ONE PAGE. This value is rendered on
    // the benchmarks page, the pipeline page and the client campaign metrics view.
    // Changing the benchmarks card alone would have put two different reply rates for the
    // same client in the same dashboard, which is worse than one wrong one: the client
    // cannot tell which to believe and neither can we.
    replyRate: contactedCount > 0 ? (repliedCount / contactedCount) * 100 : null,
    positiveReplyCount: positiveRepliesResult.count ?? 0,
    // Booked counts every meeting that was ever booked, including ones since cancelled:
    // it answers "did outreach produce meetings". Held counts only the ones somebody
    // confirmed happened.
    meetingsBooked: meetings.length,
    meetingsHeld: meetings.filter(m => m.meeting_status === 'held').length,
    // Same denominator as replyRate, and computed HERE for the same reason: so no two
    // pages can render different meeting rates for one client. The benchmarks page adds a
    // sample gate on top of this, which decides whether to SHOW it, never what it is.
    //
    // Numerator is meetingsBooked, not meetingsHeld. The question this answers is "did
    // outreach produce meetings", and a meeting that was booked and later cancelled was
    // still produced by outreach.
    //
    // NOT CAMPAIGN-SCOPED, and that is deliberate rather than overlooked. meetings has a
    // campaign_id column but the Calendly webhook, which is the only writer of meeting
    // rows, never populates it: see webhooks/calendly/route.ts. The link exists one hop
    // away through prospect_id -> prospects.campaign_id. Left alone because there is
    // currently one campaign per organisation, so the org-wide numerator and the
    // campaign-scoped denominator have no instance where they disagree. Recorded in
    // BACKLOG rather than built against a distinction with no examples.
    meetingRate: contactedCount > 0 ? (meetings.length / contactedCount) * 100 : null,
    hasData: sentCount > 0,
  }
}

export interface AllCampaignMetrics {
  sentCount: number
  repliedCount: number
  // Same definition as the client-facing one: replies per PERSON contacted.
  //
  // contacted_count is READ to compute this and deliberately NOT returned. The two shapes
  // are separate types on purpose so a field added for one cannot arrive in the other,
  // and a test asserts this one has no contactedCount. Computing from a column without
  // exposing it keeps both true.
  replyRate: number | null
  positiveReplyCount: number
  meetingCount: number
  // Meetings per PERSON contacted, identical definition to the client-facing meetingRate.
  // An operator comparing their panel against what the client sees must not find two
  // numbers, which is the same rule replyRate follows.
  meetingRate: number | null
  bouncedCount: number
  hasData: boolean
}

/**
 * Fetches ALL campaign metrics for an organisation (operator only, no filtering).
 * Returns all metrics including diagnostic data (bounce, complaint, mailbox health).
 * Used by the operator per-client view to monitor deliverability.
 *
 * Still takes a client, unlike the function above: the operator page already passes a
 * client that can read these tables, and operators have RLS access to every org through
 * the operators_full_access_* policies. The forced-service-role treatment above exists
 * because CLIENT sessions silently read nothing, which is not a problem operators have.
 */
export async function getAllCampaignMetricsForOrg(
  supabase: SupabaseServiceClient,
  orgId: string
): Promise<AllCampaignMetrics> {
  const [campaignsResult, positiveRepliesResult, meetingsResult] = await Promise.all([
    supabase
      .from('campaigns')
      .select('sent_count, contacted_count, replied_count, bounced_count')
      .eq('organisation_id', orgId),

    // Same correction as above: the classification lives on the action row, never on the
    // signal. This counted a signal_type nothing writes, so it read 0 forever.
    supabase
      .from('reply_handling_actions')
      .select('*', { count: 'exact', head: true })
      .eq('organisation_id', orgId)
      .in('classified_intent', CLIENT_VISIBLE_INTENTS),

    supabase
      .from('meetings')
      .select('*', { count: 'exact', head: true })
      .eq('organisation_id', orgId),
  ])

  const campaigns = campaignsResult.data ?? []
  const sentCount = campaigns.reduce((sum, c) => sum + (c.sent_count ?? 0), 0)
  const contactedCount = campaigns.reduce((sum, c) => sum + (c.contacted_count ?? 0), 0)
  const repliedCount = campaigns.reduce((sum, c) => sum + (c.replied_count ?? 0), 0)
  const bouncedCount = campaigns.reduce((sum, c) => sum + (c.bounced_count ?? 0), 0)

  return {
    sentCount,
    repliedCount,
    // People-denominated, matching the client-facing function exactly. An operator
    // comparing their panel against what the client sees must not find two numbers.
    replyRate: contactedCount > 0 ? (repliedCount / contactedCount) * 100 : null,
    positiveReplyCount: positiveRepliesResult.count ?? 0,
    meetingCount: meetingsResult.count ?? 0,
    meetingRate: contactedCount > 0 ? ((meetingsResult.count ?? 0) / contactedCount) * 100 : null,
    bouncedCount,
    hasData: sentCount > 0,
  }
}
