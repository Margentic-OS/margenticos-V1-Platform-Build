// Temporary test script for the prospect research agent.
// Run with: npx tsx --env-file=.env.local src/lib/agents/test-prospect-research-run.ts
// Delete after test passes.

import { createClient } from '@supabase/supabase-js'
import { runProspectResearchAgent } from '@/lib/agents/prospect-research-agent'

const ORG_ID      = '74243c62-f42d-4f3f-b93e-bd5e51f0b6c0' // MargenticOS client zero
const PROSPECT_ID = '177c0f70-e51e-4275-8261-908c7ef2bab0' // Jeb Blount — Sales Gravy (test)

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }

  console.log('=== Prospect Research Agent — Test Run ===')
  console.log(`Prospect ID : ${PROSPECT_ID}`)
  console.log(`Client ID   : ${ORG_ID}`)
  console.log('')

  try {
    const result = await runProspectResearchAgent({
      prospect_id: PROSPECT_ID,
      client_id: ORG_ID,
    })

    console.log('=== TRIGGER RESULT ===')
    console.log(JSON.stringify(result, null, 2))

    // Verify the DB write
    const supabase = createClient(url, key)
    const { data: prospect } = await supabase
      .from('prospects')
      .select('personalisation_trigger, research_source, trigger_confidence, trigger_data, research_ran_at')
      .eq('id', PROSPECT_ID)
      .eq('organisation_id', ORG_ID)
      .single()

    console.log('\n=== DB RECORD (after write) ===')
    console.log(JSON.stringify(prospect, null, 2))
  } catch (err) {
    console.error('\n=== AGENT FAILED ===')
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
