import { createClient } from '@supabase/supabase-js'
import { tierEnrichedBatch } from '@/lib/sourcing/tiering-trigger'
import type { Database } from '@/types/database'

const supabase = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const ORG_ID = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'

async function main() {
  console.log('Clearing existing tiers to force re-classification...')

  // Clear all tiers so tierEnrichedBatch will re-classify everything
  const { error: clearError } = await supabase
    .from('prospects')
    .update({ sourced_tier: null, tiering_reason: null })
    .eq('organisation_id', ORG_ID)
    .eq('suppressed', false)

  if (clearError) {
    console.error('Error clearing tiers:', clearError)
    process.exit(1)
  }

  console.log('Tiers cleared. Running tiering...')

  // Run tiering
  const result = await tierEnrichedBatch(supabase, ORG_ID, 100)

  console.log('\n=== TIERING RESULT ===')
  console.log(`Prospects classified: ${result.prospects_classified}`)
  console.log(`Tier 1: ${result.tier_1_count}`)
  console.log(`Tier 2: ${result.tier_2_count}`)
  console.log(`Tier 3: ${result.tier_3_count}`)
  console.log(`Untiered (flagged): ${result.untiered_count}`)

  // Query distribution
  const { data: distribution } = await supabase
    .from('prospects')
    .select('sourced_tier, tiering_reason')
    .eq('organisation_id', ORG_ID)
    .eq('suppressed', false)

  console.log('\n=== DISTRIBUTION BY TIER & REASON ===')
  const breakdown: Record<string, Record<string, number>> = {}

  distribution?.forEach(p => {
    const tier = p.sourced_tier || 'untiered'
    const reason = p.tiering_reason || 'none'
    if (!breakdown[tier]) breakdown[tier] = {}
    breakdown[tier][reason] = (breakdown[tier][reason] || 0) + 1
  })

  for (const [tier, reasons] of Object.entries(breakdown).sort()) {
    console.log(`\n${tier}:`)
    for (const [reason, count] of Object.entries(reasons).sort()) {
      console.log(`  ${reason}: ${count}`)
    }
  }

  // Summary
  const tier1 = distribution?.filter(p => p.sourced_tier === 'tier_1').length || 0
  const tier2 = distribution?.filter(p => p.sourced_tier === 'tier_2').length || 0
  const flagged = distribution?.filter(p => p.sourced_tier === null).length || 0

  console.log(`\n=== SUMMARY ===`)
  console.log(`Total non-suppressed: ${distribution?.length || 0}`)
  console.log(`Tier 1: ${tier1}`)
  console.log(`Tier 2: ${tier2}`)
  console.log(`Client-visible (tier_1+tier_2): ${tier1 + tier2}`)
  console.log(`Flagged/Untiered: ${flagged}`)

  // Show flagged prospects
  const { data: flaggedProspects } = await supabase
    .from('prospects')
    .select('first_name, last_name, company_name, company_industry, tiering_reason')
    .eq('organisation_id', ORG_ID)
    .eq('suppressed', false)
    .is('sourced_tier', null)
    .order('first_name')

  if (flaggedProspects && flaggedProspects.length > 0) {
    console.log(`\n=== FLAGGED PROSPECTS (${flaggedProspects.length}) ===`)
    flaggedProspects.forEach(p => {
      console.log(`${p.first_name} ${p.last_name} (${p.company_name}) | Industry: ${p.company_industry} | Reason: ${p.tiering_reason}`)
    })
  }
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
