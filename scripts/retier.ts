import { createClient } from '@supabase/supabase-js'
import { tierEnrichedBatch } from '@/lib/sourcing/tiering-trigger'
import type { Database } from '@/types/database'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ORG_ID = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function main() {
  console.log(`Running tiering for org ${ORG_ID}...`)
  const result = await tierEnrichedBatch(supabase, ORG_ID, 100)

  console.log('\n=== TIERING RESULT ===')
  console.log(JSON.stringify(result, null, 2))

  // Query distribution by tier and reason
  const { data: distribution, error: distError } = await supabase
    .from('prospects')
    .select('sourced_tier, tiering_reason')
    .eq('organisation_id', ORG_ID)
    .eq('suppressed', false)

  if (distError) {
    console.error('Error fetching distribution:', distError)
    process.exit(1)
  }

  console.log('\n=== DISTRIBUTION BY TIER & REASON ===')
  const breakdown: Record<string, Record<string, number>> = {}

  distribution?.forEach(p => {
    const tier = p.sourced_tier || 'untiered'
    const reason = p.tiering_reason || 'none'
    if (!breakdown[tier]) breakdown[tier] = {}
    breakdown[tier][reason] = (breakdown[tier][reason] || 0) + 1
  })

  for (const [tier, reasons] of Object.entries(breakdown)) {
    console.log(`\n${tier}:`)
    for (const [reason, count] of Object.entries(reasons)) {
      console.log(`  ${reason}: ${count}`)
    }
  }

  // Count client-visible (tier_1 + tier_2)
  const clientVisible = distribution?.filter(p => p.sourced_tier === 'tier_1' || p.sourced_tier === 'tier_2').length || 0
  const flagged = distribution?.filter(p => p.sourced_tier === null).length || 0

  console.log(`\n=== SUMMARY ===`)
  console.log(`Total non-suppressed: ${distribution?.length || 0}`)
  console.log(`Client-visible (tier_1+tier_2): ${clientVisible}`)
  console.log(`Flagged (untiered): ${flagged}`)

  // Query for Charlie/Landmark Surf and Stephen/Matrix Restaurant
  const { data: specific } = await supabase
    .from('prospects')
    .select('first_name, last_name, company_name, sourced_tier, tiering_reason')
    .eq('organisation_id', ORG_ID)
    .eq('suppressed', false)
    .or("first_name.ilike.Charlie,first_name.ilike.Stephen")
    .order('first_name', { ascending: true })

  console.log(`\n=== SPECIFIC PROSPECTS ===`)
  specific?.forEach(p => {
    console.log(`${p.first_name} ${p.last_name} (${p.company_name}): ${p.sourced_tier || 'untiered'} - ${p.tiering_reason || 'none'}`)
  })
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
