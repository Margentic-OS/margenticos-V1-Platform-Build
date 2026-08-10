import { createClient } from '@supabase/supabase-js'
import { runSourcing } from '@/lib/sourcing/orchestrator'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const org_id = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'

async function main() {
  console.log('\n=== PHASE 4 BACKFILL ===\n')

  try {
    const result = await runSourcing(supabase, org_id, 'operator_manual', 25)

    console.log(`✓ Orchestrator complete: ${result.candidates_sourced} sourced, ${result.candidates_qualified} qualified\n`)

    // Fetch 3 sample rows to show first_name, job_title, company_name, linkedin_url
    const { data: samples } = await supabase
      .from('prospects')
      .select('first_name, job_title, company_name, linkedin_url')
      .eq('organisation_id', org_id)
      .eq('sourcing_review_status', 'pending_review')
      .limit(3)

    console.log('SAMPLE ROWS (proof of data capture):\n')
    for (let i = 0; i < (samples?.length || 0); i++) {
      const s = samples![i]
      const firstName = s.first_name ? s.first_name[0] : '?'
      console.log(`${i + 1}. ${firstName}*** | ${s.job_title || '(no title)'} | ${s.company_name || '(no company)'} | linkedin_url: ${s.linkedin_url ? 'PRESENT' : 'null (not in api_search)'}`)
    }

  } catch (err) {
    console.error('\n❌ Backfill failed:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
