// Run tiering on enriched prospects with real industries
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { tierEnrichedBatch } from '../src/lib/sourcing/tiering-trigger'

async function runTiering() {
  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const orgId = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'

  console.log(`Running tiering on enriched prospects for org: ${orgId}...`)

  try {
    const result = await tierEnrichedBatch(supabase, orgId, 100)

    console.log('\n✓ Tiering run completed:')
    console.log('  Prospects classified:', result.prospects_classified)
    console.log('  Tier 1:', result.tier_1_count)
    console.log('  Tier 2:', result.tier_2_count)
    console.log('  Tier 3:', result.tier_3_count)
    console.log('  Untiered:', result.untiered_count)
    if (result.error) {
      console.log('  Error:', result.error)
    }
  } catch (err) {
    console.error('Error during tiering:', err)
    process.exit(1)
  }
}

runTiering()
