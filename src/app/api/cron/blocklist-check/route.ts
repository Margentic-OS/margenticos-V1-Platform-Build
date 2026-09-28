// POST /api/cron/blocklist-check
//
// Called by Supabase pg_cron once a day at 12:29 UTC. Asks three public domain blocklists
// whether any sending domain in use is listed, proves in the same run that each list is
// actually answering, and stores one verdict row for mon_035 to read.
//
// Auth: Authorization: Bearer ${CRON_SECRET}. Service role, like every other sweep.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY 12:29 UTC
//
// The live campaign's sending window is 09:30 to 15:00 America/Detroit, which is 13:30 to
// 19:00 UTC. This runs an hour ahead of it, so a listing found today is on the monitor board
// before the day's first send rather than after it. monitor-sweep runs at 5-59/15, so the
// board updates by 12:35.
//
// Minute 29 was chosen by reading cron.job live on 2026-09-28: of the 13 jobs scheduled,
// the staggered series between them occupy every minute of the hour except 29, 39, 49 and
// 59. The stagger exists so jobs do not all start in the same second, and this keeps to it.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY DAILY AND NOT MORE OFTEN
//
// A blocklisting is not a fast-moving event: a domain stays listed for days and delisting
// is a manual process measured in days too. Querying more often would buy nothing and would
// spend free-tier query budget on these lists, which is what gets a querier blocked, and a
// blocked querier is an instrument that reports clean. Once a day, ahead of sending, is the
// useful cadence.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A CRON AND NOT A QUEUE JOB
//
// The queue is for expensive, non-idempotent work that must not be paid for twice; its
// central mechanism is the spend stamp. This spends nothing, writes nothing outside our own
// database, is safe to repeat, and its whole workload is a handful of DNS queries.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/nextjs'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import { asServiceRoleClient } from '@/lib/supabase/service-role'
import { BLOCKLISTS, withSpamhausDqsKey } from '@/lib/blocklist/lists'
import { makeResolver, resolverAddressesFrom } from '@/lib/blocklist/resolver'
import { runBlocklistSweep } from '@/lib/blocklist/sweep'
import { sendingDomainsInUse, writeBlocklistSnapshot } from '@/lib/blocklist/store'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MONITOR_SLUG = 'blocklist-check'
const MONITOR_CONFIG = {
  schedule: { type: 'crontab' as const, value: '29 12 * * *' },
  checkinMargin: 15,
  maxRuntime: 5,
  timezone: 'UTC',
}

/**
 * THE HEARTBEAT IS NOT OPTIONAL. MON-002 derives liveness from staleness in cron_heartbeats
 * alone, so a sweep that writes no row is invisible: it could stop entirely and nothing
 * would say so.
 */
async function writeHeartbeat(
  supabase: ReturnType<typeof asServiceRoleClient>,
  ok: boolean,
  detail: string,
): Promise<void> {
  const { error } = await supabase
    .from('cron_heartbeats')
    .insert({ job_name: MONITOR_SLUG, ok, detail: detail.slice(0, 900) })

  if (error) {
    logger.error('blocklist-check: heartbeat write failed', {
      error: error.message,
      consequence: 'MON-002 will read this sweep as stale until the next successful write.',
    })
  }
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const checkInId = Sentry.captureCheckIn(
    { monitorSlug: MONITOR_SLUG, status: 'in_progress' },
    MONITOR_CONFIG,
  )

  const supabase = asServiceRoleClient(
    createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    ),
  )

  const now = new Date()

  try {
    // Throws on a banned resolver rather than falling back, so a misconfiguration is a
    // named failure instead of a monitor quietly measuring the wrong thing.
    const resolverAddresses = resolverAddressesFrom(process.env.BLOCKLIST_DNS_RESOLVERS)
    const resolve = makeResolver(resolverAddresses)

    const domains = await sendingDomainsInUse(supabase, now)
    const lists = withSpamhausDqsKey(BLOCKLISTS, process.env.SPAMHAUS_DQS_KEY)

    const verdict = await runBlocklistSweep({ resolve, domains, lists })

    await writeBlocklistSnapshot(supabase, verdict, now)

    // 'ok' is about whether the INSTRUMENT worked, not about what it found. A sweep that
    // correctly discovers a listing has done its job perfectly, and marking its heartbeat
    // failed would confuse "the instrument is broken" with "the instrument found
    // something". mon_035 reads the finding; the heartbeat reads the instrument.
    const ok = !verdict.incomplete && verdict.controlFailures.length === 0

    logger.info('blocklist-check: run complete', {
      domains_checked: verdict.domainsChecked,
      lists_trusted: verdict.listsTrusted,
      lists_total: verdict.listsTotal,
      listed: verdict.listedCount,
      control_failures: verdict.controlFailures.length,
      refused: verdict.refusedCount,
      incomplete: verdict.incomplete,
      resolvers: resolverAddresses.join(','),
    })

    if (verdict.listedCount > 0) {
      // Sentry as well as the monitor board. A sending domain on a public abuse list is
      // costing deliverability on every send until it is dealt with.
      Sentry.captureException(
        new Error(
          `Blocklist check: ${verdict.listedCount} sending domain listing(s) found: ` +
            verdict.listings.map(l => `${l.domain} on ${l.list}`).join(', '),
        ),
        { level: 'error', extra: { listings: verdict.listings } },
      )
    }

    if (verdict.controlFailures.length > 0) {
      // Separate from the listing alert on purpose. This one says the check cannot see,
      // which is a different problem from the check seeing something bad, and conflating
      // them is how "no listings" gets trusted when it means "no answers".
      Sentry.captureException(
        new Error(
          `Blocklist check: ${verdict.controlFailures.length} control failure(s), so ` +
            `${verdict.listsTotal - verdict.listsTrusted} of ${verdict.listsTotal} lists ` +
            `could not be trusted this run`,
        ),
        { level: 'error', extra: { control_failures: verdict.controlFailures } },
      )
    }

    await writeHeartbeat(supabase, ok, verdict.detail)
    Sentry.captureCheckIn(
      { checkInId, monitorSlug: MONITOR_SLUG, status: ok ? 'ok' : 'error' },
      MONITOR_CONFIG,
    )
    await Sentry.flush(2000)

    return NextResponse.json({ ok, ...verdict })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('blocklist-check: run failed', { error: message })
    Sentry.captureException(err instanceof Error ? err : new Error(message))
    await writeHeartbeat(supabase, false, `Run failed: ${message}`)
    Sentry.captureCheckIn({ checkInId, monitorSlug: MONITOR_SLUG, status: 'error' }, MONITOR_CONFIG)
    await Sentry.flush(2000)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
