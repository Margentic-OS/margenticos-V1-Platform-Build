// The weekly watch. Ask for this before deciding whether to advance a ramp rung.
//
//   npx dotenv -e .env.local -- npx tsx scripts/weekly-watch.ts
//
// READS ONLY. No campaign, account, daily limit or database row is modified anywhere in
// this path: there is no POST, PATCH or DELETE outside the one warmup-analytics read,
// which Instantly exposes as a POST because it takes a mailbox list in the body.
//
// EXIT CODES, because this is the bit a wrapper would act on:
//   0  ADVANCE     all six sources read, all clear
//   1  HOLD        all six read, something says wait
//   2  INCOMPLETE  one or more sources could not be read — the loudest outcome
//
// INCOMPLETE exits 2 rather than 0 on purpose. A report that could not read the canary
// must not be mistakable, by a human or a wrapper, for one that read it and found nothing.

import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { collectWeeklyWatch } from '../src/lib/weekly-watch/collect'
import { renderReport, verdictFor } from '../src/lib/weekly-watch/report'
import { getInstantlyApiKey } from '../src/lib/integrations/handlers/instantly/auth'
import { resolveInstantlyBaseUrl } from '../src/lib/integrations/handlers/instantly/constants'
import { createInstantlyWatchProvider } from '../src/lib/integrations/handlers/instantly/weekly-watch'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('WEEKLY WATCH COULD NOT START: missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
    console.error('This is not an empty report. Nothing was read.')
    process.exit(2)
  }

  let apiKey: string
  try {
    apiKey = await getInstantlyApiKey('weekly-watch')
  } catch (err) {
    console.error('WEEKLY WATCH COULD NOT START: no Instantly API key.')
    console.error(err instanceof Error ? err.message : String(err))
    console.error('This is not an empty report. Nothing was read.')
    process.exit(2)
  }

  // isActive=true: this script only reads, so the write-safety flag does not apply. The
  // INSTANTLY_API_BASE_URL override still wins, which is what the mutation proof uses.
  const baseUrl = resolveInstantlyBaseUrl(true)

  const db = createClient<Database>(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  const provider = createInstantlyWatchProvider({ apiKey, baseUrl })
  const report = await collectWeeklyWatch(db, provider)
  console.log(renderReport(report))

  const verdict = verdictFor(report)
  process.exit(verdict === 'ADVANCE' ? 0 : verdict === 'HOLD' ? 1 : 2)
}

main().catch(err => {
  console.error('WEEKLY WATCH CRASHED — no reading should be inferred from this run.')
  console.error(err)
  process.exit(2)
})
