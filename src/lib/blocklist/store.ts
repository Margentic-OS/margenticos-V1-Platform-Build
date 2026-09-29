// Where MON-035 gets its domain list, and where it puts its verdict.

import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import type { BlocklistVerdict } from './sweep'

/**
 * How far back a domain counts as "in use".
 *
 * THIRTY DAYS, NOT "CURRENTLY IN A CAMPAIGN", and the difference matters.
 *
 * On 2026-09-28 three of the five sending domains were pulled from the live campaign within
 * a few hours, two for failing a Gmail seed test and one for being blocklisted. Under a
 * "currently sending" definition all three would have dropped out of this monitor on the
 * day they most needed watching, and the listing on the third would have gone unobserved
 * from the moment it was found.
 *
 * A rested domain is a domain somebody intends to bring back. Its reputation is exactly
 * what the rest is meant to repair, so it is the one you most want a daily reading on. The
 * window also means the monitor keeps watching for a month after a domain is retired for
 * good, which is cheap and harmless.
 */
export const DOMAIN_WINDOW_DAYS = 30

/**
 * The sending domains to check.
 *
 * Read from sending_mailbox_daily_stats, which is populated from the sending provider's own
 * per-mailbox daily figures. That is deliberate: it is a record of what ACTUALLY SENT,
 * not of what some configuration says should send. Deriving the list from our own campaign
 * config would mean a domain sending outside that config is never checked, which is the
 * audit-our-own-writes shape CLAUDE.md names against MON-026.
 *
 * Tool-agnostic: the column holds a bare domain, written by deriveSendingDomain, and no
 * vendor name reaches this query.
 *
 * An empty result is returned as an empty array and is NOT an error here. mon_035 renders
 * it as UNKNOWN, because a sweep with nothing to look at has not passed.
 */
export async function sendingDomainsInUse(
  supabase: ServiceRoleClient,
  now: Date,
  windowDays: number = DOMAIN_WINDOW_DAYS,
): Promise<string[]> {
  const start = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)
  const startDate = start.toISOString().slice(0, 10)

  const { data, error } = await supabase
    .from('sending_mailbox_daily_stats')
    .select('sending_domain')
    .gte('stat_date', startDate)

  if (error) {
    throw new Error(`Could not read sending domains: ${error.message}`)
  }

  const domains = new Set<string>()
  for (const row of data ?? []) {
    const domain = row.sending_domain?.trim().toLowerCase()
    if (domain) domains.add(domain)
  }

  return [...domains].sort()
}

/**
 * Store the verdict as the single row mon_035 reads.
 *
 * Written before the run is called a success. If this throws, the route's heartbeat records
 * a failure and mon_035 goes stale, which is the correct reading: a verdict nobody can see
 * is the same as a sweep that did not run.
 */
export async function writeBlocklistSnapshot(
  supabase: ServiceRoleClient,
  verdict: BlocklistVerdict,
  now: Date,
): Promise<void> {
  const { error } = await supabase
    .from('blocklist_check_snapshot')
    .upsert(
      {
        id: 1,
        domains_checked: verdict.domainsChecked,
        // Written separately so mon_035's vacuous-truth check keeps reading the SENDING
        // count. The brand floor is never empty, so the combined count can never be zero.
        sending_domains_checked: verdict.sendingDomainsChecked,
        brand_domains_checked: verdict.brandDomainsChecked,
        lists_total: verdict.listsTotal,
        lists_trusted: verdict.listsTrusted,
        listed_count: verdict.listedCount,
        control_failure_count: verdict.controlFailures.length,
        refused_count: verdict.refusedCount,
        incomplete: verdict.incomplete,
        listings: JSON.parse(JSON.stringify(verdict.listings)),
        control_failures: JSON.parse(JSON.stringify(verdict.controlFailures)),
        detail: verdict.detail,
        computed_at: now.toISOString(),
      },
      { onConflict: 'id' },
    )

  if (error) {
    throw new Error(`Could not write blocklist snapshot: ${error.message}`)
  }
}
