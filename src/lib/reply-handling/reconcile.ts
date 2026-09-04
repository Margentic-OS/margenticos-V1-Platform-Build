// Reply reconciliation — does the provider hold a reply we never stored?
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY THIS IS THE ONLY CHECK THAT CATCHES A LOST REPLY POSITIVELY
//
// Every other instrument around reply loss infers it from an error flag:
//
//   the instantly-poll heartbeat  goes red for ONE 15-minute cycle and self-clears, because
//                                 MON-002 reads only the latest heartbeat row
//   polling_cursors.last_error    written by the poller, and until MON-027 read by nothing
//   MON-014 / MON-015             count rows that EXIST; a lost reply has no row to count
//
// All of those answer "did something go wrong", and the answer is overwritten by the next
// clean run. This one answers "is anything missing", by comparing what the provider holds
// against what we stored. A gap is still a gap a week later.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY IT COUNTS EMAIL OBJECTS AND NOT THE CAMPAIGN ANALYTICS reply_count
//
// campaigns.replied_count is already fetched every run and would have been free. It is the
// WRONG NUMBER, and this was measured rather than assumed.
//
// On 2026-09-04 the one live campaign reported provider reply_count = 2 while we held 3
// reply_received signals for it, with nothing lost. The analytics counter and a count of
// received-email objects do not mean the same thing — most likely the analytics figure is
// per replying lead, or excludes something, but the point does not depend on which. A
// monitor built on it would have been comparing two quantities that legitimately differ,
// and its resting state would have been a permanent small gap that everyone learns to
// ignore. That is how MON-007 died.
//
// So this asks the provider for the same /emails?email_type=received objects the POLLER
// reads, through the poller's own instantlyGet, and compares their ids against
// signals.external_event_id. Same objects on both sides, so a gap has exactly one meaning.
//
// ADR-001 deferred: campaign_id and email_type are Instantly V2 field names, and the API key
// is passed rather than resolved from the capability registry. Same deferral as the rest of
// this directory — see the ADR-001 notes in process-reply.ts.

import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import { logger } from '@/lib/logger'
import { instantlyGet } from '@/lib/integrations/polling/instantly'

const SOURCE = 'instantly'

// Rows per list call, matching the poller so both sides page identically.
const PAGE_LIMIT = 100

// Per-campaign page ceiling. At 100 rows a page this reads up to 1,000 replies per campaign
// per sweep. Hitting it does NOT mean "no gap found": it means the sweep did not finish, so
// it sets incomplete and the monitor refuses to report OK. A bounded check that reported a
// pass on a partial read would be the vacuous-green shape this file exists to avoid.
const MAX_PAGES_PER_CAMPAIGN = 10

// Ids named in the detail line. Enough to start an investigation, not so many that the line
// becomes unreadable on the operator board.
const MISSING_SAMPLE_SIZE = 5

export interface ReplyReconciliationVerdict {
  campaignsChecked: number
  providerReplyCount: number
  storedReplyCount: number
  missingCount: number
  unreachableCampaigns: number
  incomplete: boolean
  missingSample: string[]
  detail: string
}

interface RegisteredCampaign {
  id: string
  organisation_id: string
  external_id: string
}

/**
 * Reads every registered campaign's received emails from the provider and reports any whose
 * id we hold no signal for.
 *
 * Never throws: a reconciliation sweep that crashes takes the whole poll run with it, and
 * the poll is the thing that actually matters. Failures become `incomplete`, which the
 * monitor treats as not-OK.
 */
export async function reconcileReplies(
  supabase: ServiceRoleClient,
  apiKey: string,
  baseUrl: string,
  isActive: boolean,
): Promise<ReplyReconciliationVerdict> {
  const verdict: ReplyReconciliationVerdict = {
    campaignsChecked: 0,
    providerReplyCount: 0,
    storedReplyCount: 0,
    missingCount: 0,
    unreachableCampaigns: 0,
    incomplete: false,
    missingSample: [],
    detail: '',
  }

  const { data: campaigns, error: campaignError } = await supabase
    .from('campaigns')
    .select('id, organisation_id, external_id, organisations!inner(archived_at)')
    .not('external_id', 'is', null)
    .is('organisations.archived_at', null)

  if (campaignError) {
    verdict.incomplete = true
    verdict.detail = `Could not read registered campaigns: ${campaignError.message}`
    logger.error('reply-reconcile: campaign read failed', { error: campaignError.message })
    return verdict
  }

  const registered = (campaigns ?? []) as unknown as RegisteredCampaign[]

  if (registered.length === 0) {
    verdict.detail = 'No registered campaigns with a provider id, so there is nothing to reconcile.'
    return verdict
  }

  for (const campaign of registered) {
    const providerIds: string[] = []
    let cursor: string | null = null
    let pages = 0
    let campaignFailed = false

    for (;;) {
      if (pages >= MAX_PAGES_PER_CAMPAIGN) {
        verdict.incomplete = true
        logger.warn('reply-reconcile: page ceiling reached, sweep is partial', {
          campaign_id: campaign.id,
          pages,
        })
        break
      }
      pages++

      const params: Record<string, string> = {
        email_type: 'received',
        campaign_id: campaign.external_id,
        sort_order: 'asc',
        limit: String(PAGE_LIMIT),
      }
      if (cursor) params.starting_after = cursor

      const { data, nextCursor, error } = await instantlyGet('/emails', apiKey, params, baseUrl, isActive)

      if (error) {
        // UNREACHABLE IS NOT A PASS. A campaign we could not read is a campaign whose
        // replies we cannot vouch for, and saying nothing is missing would be a claim the
        // sweep did not earn.
        verdict.unreachableCampaigns++
        verdict.incomplete = true
        campaignFailed = true
        logger.error('reply-reconcile: provider read failed for campaign', {
          campaign_id: campaign.id,
          error,
        })
        break
      }

      for (const row of data ?? []) {
        const id = (row as Record<string, unknown>).id
        if (typeof id === 'string' && id) providerIds.push(id)
      }

      if (!nextCursor || !data || data.length === 0) break
      cursor = nextCursor
    }

    if (campaignFailed) continue

    verdict.campaignsChecked++
    verdict.providerReplyCount += providerIds.length

    if (providerIds.length === 0) continue

    // Which of those ids do we actually hold? Chunked because a very long `in` list
    // becomes a URL PostgREST will reject, and a rejected read would look like "we hold
    // none of them", i.e. a false alarm rather than a false pass.
    const held = new Set<string>()
    for (let i = 0; i < providerIds.length; i += PAGE_LIMIT) {
      const chunk = providerIds.slice(i, i + PAGE_LIMIT)
      const { data: rows, error: signalError } = await supabase
        .from('signals')
        .select('external_event_id')
        .eq('organisation_id', campaign.organisation_id)
        .eq('source', SOURCE)
        .eq('signal_type', 'reply_received')
        .in('external_event_id', chunk)

      if (signalError) {
        verdict.incomplete = true
        logger.error('reply-reconcile: signal read failed', {
          campaign_id: campaign.id,
          error: signalError.message,
        })
        campaignFailed = true
        break
      }

      for (const row of rows ?? []) {
        const id = (row as { external_event_id: string | null }).external_event_id
        if (id) held.add(id)
      }
    }

    if (campaignFailed) continue

    verdict.storedReplyCount += held.size

    const missing = providerIds.filter(id => !held.has(id))
    verdict.missingCount += missing.length
    for (const id of missing) {
      if (verdict.missingSample.length < MISSING_SAMPLE_SIZE) verdict.missingSample.push(id)
    }
  }

  verdict.detail = buildDetail(verdict)
  return verdict
}

function buildDetail(v: ReplyReconciliationVerdict): string {
  if (v.unreachableCampaigns > 0) {
    return `${v.unreachableCampaigns} campaign(s) could not be read from the provider, so `
      + `reply coverage is unverified. Checked ${v.campaignsChecked}, `
      + `${v.providerReplyCount} provider reply/replies seen, ${v.missingCount} missing.`
  }
  if (v.missingCount > 0) {
    return `${v.missingCount} reply/replies exist at the provider with no signal row. `
      + `First: ${v.missingSample.join(', ')}. `
      + `Checked ${v.campaignsChecked} campaign(s), ${v.providerReplyCount} provider reply/replies, `
      + `${v.storedReplyCount} stored.`
  }
  if (v.incomplete) {
    return `Sweep did not finish across all ${v.campaignsChecked} campaign(s), so no coverage `
      + `claim is made. ${v.providerReplyCount} provider reply/replies seen, ${v.missingCount} missing.`
  }
  if (v.providerReplyCount === 0) {
    return `The provider holds no replies at all across ${v.campaignsChecked} campaign(s). `
      + `Nothing to reconcile, so this is not a pass: the check cannot distinguish a working `
      + `poller from a broken one until a reply exists.`
  }
  return `All ${v.providerReplyCount} reply/replies the provider holds across `
    + `${v.campaignsChecked} campaign(s) have a signal row.`
}
