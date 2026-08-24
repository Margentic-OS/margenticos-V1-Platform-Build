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

type SupabaseServiceClient = SupabaseClient<Database>

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
  replyRate: number | null
  // Replies whose classified intent is in the client-visible positive set. Counted from
  // the SAME list the replies page filters on, so this number can never disagree with the
  // number of cards shown there.
  positiveReplyCount: number
  meetingsBooked: number
  meetingsHeld: number
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
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
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
    replyRate: sentCount > 0 ? (repliedCount / sentCount) * 100 : null,
    positiveReplyCount: positiveRepliesResult.count ?? 0,
    // Booked counts every meeting that was ever booked, including ones since cancelled:
    // it answers "did outreach produce meetings". Held counts only the ones somebody
    // confirmed happened.
    meetingsBooked: meetings.length,
    meetingsHeld: meetings.filter(m => m.meeting_status === 'held').length,
    hasData: sentCount > 0,
  }
}

export interface AllCampaignMetrics {
  sentCount: number
  repliedCount: number
  replyRate: number | null
  positiveReplyCount: number
  meetingCount: number
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
      .select('sent_count, replied_count, bounced_count')
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
  const repliedCount = campaigns.reduce((sum, c) => sum + (c.replied_count ?? 0), 0)
  const bouncedCount = campaigns.reduce((sum, c) => sum + (c.bounced_count ?? 0), 0)

  return {
    sentCount,
    repliedCount,
    replyRate: sentCount > 0 ? (repliedCount / sentCount) * 100 : null,
    positiveReplyCount: positiveRepliesResult.count ?? 0,
    meetingCount: meetingsResult.count ?? 0,
    bouncedCount,
    hasData: sentCount > 0,
  }
}
