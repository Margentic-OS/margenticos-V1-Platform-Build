// Re-runs the prospects that currently carry a personalisation_trigger, through the new
// write-in-context plus judge path. CONCURRENT. Lori and Richard at Corral are NULL and
// are excluded by the query itself.
import { createClient } from '@supabase/supabase-js'
import { runProspectResearchAgentV2Batch } from '@/lib/agents/prospect-research-agent-v2'
import { fatalApiReason } from '@/lib/agents/fatal-api-error'

const ORG = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data, error } = await sb.from('prospects')
    .select('id, first_name, company_name')
    .eq('organisation_id', ORG).eq('outbound_upload_status', 'uploaded')
    .not('personalisation_trigger', 'is', null).order('first_name')
  if (error) throw new Error(error.message)
  const ids = (data ?? []).map(r => r.id as string)
  console.log(`TARGETS: ${ids.length}`)
  for (const r of data ?? []) console.log(`  ${r.first_name} / ${r.company_name}`)
  if (ids.length !== 13) { console.error(`ABORT: expected 13, found ${ids.length}`); process.exit(1) }

  const started = Date.now()
  try {
    const summary = await runProspectResearchAgentV2Batch({
      prospect_ids: ids, client_id: ORG,
      skip_existing: false, confirm_before_run: false,
      concurrency: 5,
    })
    console.log('\n=== SUMMARY ===')
    console.log(JSON.stringify(summary, null, 2))
    console.log(`Wall clock: ${Math.round((Date.now() - started) / 1000)}s`)
  } catch (err) {
    console.error('\n=== RUN ABORTED ===')
    console.error(fatalApiReason(err) ? `FATAL: ${fatalApiReason(err)}` : String(err))
    process.exit(1)
  }
}
main().catch(e => { console.error('FAILED:', e instanceof Error ? e.stack : String(e)); process.exit(1) })
