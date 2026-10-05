// The two counts that decide the Prospects nav entry, in ONE place.
//
// They were inline in (client)/layout.tsx, which meant the layout was the only thing that
// could produce them, and the layout cannot see `?client=`: a Next.js App Router layout
// receives `params` but never `searchParams`. So when an operator used "View as client",
// the sidebar counted the operator's OWN organisation while the page rendered the viewed
// one. On the live workspace that is doug@margenticos.com resolving to "MargenticOS
// (archived April 2026)" while the page renders "MargenticOS", two organisations whose
// names differ only by a suffix.
//
// Pulling the query out here lets the layout keep server-rendering the common case and
// lets an API route serve the operator-preview case, without two copies of the filter
// drifting apart. There is one definition of "how many prospects does this org have on
// the roster", and both callers use it.
//
// SERVICE-ROLE CLIENT, ALWAYS. clients_read_own_prospects_denied is USING (false), so a
// session client returns zero rows and no error for every one of these reads.

import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import { serviceReadSignal } from '@/lib/supabase/read-timeout'
import { describeQueryFailure } from '@/lib/supabase/describe-query-failure'
import { recordDashboardFailure } from './record-dashboard-failure'

export interface ProspectNavCounts {
  pendingProspectsCount: number
  rosterProspectsCount: number
}

export const EMPTY_NAV_COUNTS: ProspectNavCounts = {
  pendingProspectsCount: 0,
  rosterProspectsCount: 0,
}

/**
 * Counts for one organisation.
 *
 * Both queries are scoped to tier 1 and tier 2, matching what the roster page renders.
 * Counting every tier made the badge exceed the page: 5 tier-3 prospects sat at
 * pending_review on the live organisation while the page showed none of them.
 */
export async function getProspectNavCounts(
  serviceClient: ServiceRoleClient,
  organisationId: string,
): Promise<ProspectNavCounts> {
  // BOUNDED, because service_role has no statement_timeout. Read back from pg_roles on
  // 2026-09-07: authenticated is capped at 8s by the database, service_role at nothing at
  // all. So these two counts were the reads on this page with no ceiling anywhere, and a
  // hang here held the whole sidebar until the 300s function timeout cut the response.
  const [pendingResult, rosterResult] = await Promise.all([
    serviceClient
      .from('prospects')
      .select('*', { count: 'exact', head: true })
      .eq('organisation_id', organisationId)
      .eq('client_review_status', 'pending_review')
      .in('sourced_tier', ['tier_1', 'tier_2'])
      .not('tier_published_at', 'is', null)
      .eq('suppressed', false)
      .abortSignal(serviceReadSignal()),
    // Does this organisation have a roster at all? The nav entry persists after approval,
    // so visibility is driven by "is there anything to show" rather than by pending work.
    // Deliberately does not model the roster's pending-and-unsendable exclusion: that
    // needs a filter PostgREST cannot express cleanly, and over-counting only risks
    // landing on the page's empty state rather than hiding a real list.
    serviceClient
      .from('prospects')
      .select('*', { count: 'exact', head: true })
      .eq('organisation_id', organisationId)
      .in('sourced_tier', ['tier_1', 'tier_2'])
      .not('tier_published_at', 'is', null)
      .eq('suppressed', false)
      .or('client_review_status.is.null,client_review_status.neq.rejected')
      .abortSignal(serviceReadSignal()),
  ])

  // A FAILED READ AND AN EMPTY ROSTER ARE NOT THE SAME FACT, AND THIS USED TO RETURN THE
  // SAME NUMBER FOR BOTH. `count ?? 0` erases the difference: refused, timed out, network
  // down and genuinely-zero all arrive as 0, and the nav entry then hides itself with the
  // same confidence either way. postgrest-js never throws, so nothing upstream could tell.
  // The counts still degrade to zero, because a sidebar that renders is worth more than a
  // sidebar that is right, but the failure now leaves a row behind it.
  for (const [label, result] of [
    ['pending', pendingResult] as const,
    ['roster', rosterResult] as const,
  ]) {
    if (result.error) {
      await recordDashboardFailure({
        kind: 'read',
        source: `prospect-nav-counts:${label}`,
        route: '/dashboard',
        organisationId,
        detail: describeQueryFailure(result),
      })
    }
  }

  return {
    pendingProspectsCount: pendingResult.count ?? 0,
    rosterProspectsCount: rosterResult.count ?? 0,
  }
}
