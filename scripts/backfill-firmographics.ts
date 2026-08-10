// Backfill firmographics for the 29 enriched prospects
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'

async function backfill() {
  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const orgId = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'

  // Get the Apollo IDs for the 29 prospects with NULL firmographics
  const { data: prospects, error } = await (supabase as any)
    .from('prospects')
    .select('id, source_person_key')
    .eq('enrichment_status', 'enriched')
    .is('company_industry', null)
    .eq('organisation_id', orgId)

  if (error) {
    console.error('Error loading prospects:', error)
    process.exit(1)
  }

  if (!prospects || prospects.length === 0) {
    console.log('No prospects found with NULL firmographics')
    process.exit(0)
  }

  // Extract Apollo IDs from source_person_key (remove "apollo:" prefix)
  const apolloIds = prospects
    .map((p: any) => p.source_person_key?.replace('apollo:', ''))
    .filter((id: any): id is string => !!id)

  console.log(`Backfilling firmographics for ${apolloIds.length} prospects...`)
  console.log('Org ID:', orgId)

  // Import and run enrichment
  const { enrichProspectsForOrganisation } = await import(
    '../src/lib/sourcing/handlers/adapter-apollo-enrichment'
  )

  try {
    const result = await enrichProspectsForOrganisation(supabase, orgId, apolloIds, 100)

    console.log('\n✓ Enrichment run completed:')
    console.log('  Status:', result.status)
    console.log('  Requested:', result.total_requested_enrichments)
    console.log('  Enriched:', result.unique_enriched_records)
    console.log('  Missing:', result.missing_records)
    console.log('  Credits consumed:', result.credits_consumed)
  } catch (err) {
    console.error('Error during enrichment:', err)
    process.exit(1)
  }
}

backfill()
