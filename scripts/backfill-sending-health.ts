// One-off backfill of per-mailbox sending health from the live campaign's first send.
//
//   dotenv -e .env.local -- npx tsx scripts/backfill-sending-health.ts
//   dotenv -e .env.local -- npx tsx scripts/backfill-sending-health.ts --from 2026-08-01
//
// WHY A BACKFILL AT ALL. The 15-minute cron only re-fetches the last three days, so
// without this the table would take a week to hold a full window and MON-023 would report
// insufficient_sends for that week regardless of what the domains were actually doing.
// Worse, the source has a hard 31-day ceiling: history not captured inside that window is
// gone permanently. Backfilling on day one is the only chance to have it.
//
// IDEMPOTENT. It upserts on (stat_date, mailbox), the same constraint the cron uses, so
// running it twice rewrites the same rows with the same figures. Run it as many times as
// you like.
//
// READS ONLY against the sending tool. Nothing here modifies a campaign, an account, or a
// daily limit.

import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { syncSendingHealth } from '../src/lib/sending-health/sync'
import { SENDING_HEALTH_BACKFILL_FROM } from '../src/lib/sending-health/thresholds'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
    process.exit(1)
  }

  const from = arg('from') ?? SENDING_HEALTH_BACKFILL_FROM
  const to   = arg('to')   ?? new Date().toISOString().slice(0, 10)

  console.log(`Backfilling sending health ${from} to ${to} ...`)

  const supabase = createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const result = await syncSendingHealth(supabase, { startDate: from, endDate: to })

  // Mailbox addresses are deliberately NOT printed. The repo is public and terminal
  // output ends up pasted into issues; counts answer every question the operator has.
  console.log(JSON.stringify({
    attempted:     result.attempted,
    mailboxes:     result.mailboxCount,
    rows_fetched:  result.rowsFetched,
    rows_upserted: result.rowsUpserted,
    dropped:       result.dropped,
    verdict:       result.verdict,
    errors:        result.errors,
  }, null, 2))

  if (result.errors.length > 0) process.exit(1)
  if (!result.attempted) {
    console.error('No tool is registered and active for can_report_sending_health.')
    process.exit(1)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
