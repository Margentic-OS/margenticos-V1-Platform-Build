import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

const supabase = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const orgId = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'

async function main() {
  // Find all prospects
  const { data: prospects } = await supabase
    .from('prospects')
    .select('id, first_name, last_name, company_name, job_title, company_industry, sourced_tier, tiering_reason, enrichment_status, suppressed')
    .eq('organisation_id', orgId)
    .eq('suppressed', false)
    .order('first_name')

  console.log('ALL PROSPECTS (non-suppressed):')
  prospects?.forEach(p => {
    console.log(`${p.first_name} ${p.last_name} (${p.company_name}) | Industry: ${p.company_industry} | Tier: ${p.sourced_tier || 'null'} | Reason: ${p.tiering_reason}`)
  })

  // Check ICP industries
  const { data: icp } = await supabase
    .from('strategy_documents')
    .select('icp_filter_spec')
    .eq('organisation_id', orgId)
    .eq('document_type', 'icp')
    .eq('status', 'active')
    .single()

  if (icp?.icp_filter_spec) {
    const spec = icp.icp_filter_spec as any
    console.log('\nICP Industries:', spec.industries)
  }
}

main().catch(console.error)
