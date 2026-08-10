import { createClient } from '@supabase/supabase-js'
import { runSourcing } from '@/lib/sourcing/orchestrator'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const org_id = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'

async function main() {
  console.log('\n=== PHASE 4 FINAL RUN ===\n')
  console.log('START: orchestrator (cap 25, active doc, full pipeline to operator sourcing review)')
  console.log(`  org: ${org_id}`)
  console.log(`  cap: 25`)
  console.log(`  time: ${new Date().toISOString()}\n`)

  try {
    console.log('RUNNING: orchestrator...')
    const startTime = Date.now()

    const result = await runSourcing(supabase, org_id, 'operator_manual', 25)

    const durationMs = Date.now() - startTime
    console.log(`✓ COMPLETED in ${durationMs}ms`)
    console.log(`  candidates_sourced: ${result.candidates_sourced}`)
    console.log(`  candidates_qualified: ${result.candidates_qualified}\n`)

    // ─── RECEIPT 1: agent_runs ────────────────────────────────────────
    console.log('RECEIPT 1: agent_runs')
    const { data: runs } = await supabase
      .from('agent_runs')
      .select('id, agent_name, status, started_at, completed_at, duration_ms, error_message')
      .eq('organisation_id', org_id)
      .eq('agent_name', 'sourcing_orchestrator')
      .order('started_at', { ascending: false })
      .limit(1)

    if (runs?.length) {
      const run = runs[0]
      console.log(`  id: ${run.id}`)
      console.log(`  status: ${run.status}`)
      console.log(`  started_at: ${run.started_at}`)
      console.log(`  completed_at: ${run.completed_at || 'NULL'}`)
      console.log(`  duration_ms: ${run.duration_ms || 'NULL'}`)
      if (run.error_message) {
        console.log(`  error_message: ${run.error_message}`)
      }
    } else {
      console.log('  ERROR: No agent_runs row found (insert may have failed)')
      process.exit(1)
    }

    // ─── RECEIPT 2: Prospect counts by sourcing_review_status ─────────
    console.log('\nRECEIPT 2: prospect counts by sourcing_review_status')
    const { data: allProspects } = await supabase
      .from('prospects')
      .select('sourcing_review_status')
      .eq('organisation_id', org_id)

    const statusCounts: Record<string, number> = {}
    for (const p of allProspects || []) {
      const s = p.sourcing_review_status || 'null'
      statusCounts[s] = (statusCounts[s] || 0) + 1
    }

    for (const [status, count] of Object.entries(statusCounts).sort()) {
      console.log(`  ${status}: ${count}`)
    }

    // ─── RECEIPT 3: Dedupe verdicts (inferred from status distribution) ─
    console.log('\nRECEIPT 3: dedupe verdicts (from result output)')
    console.log(`  sourced: ${result.candidates_sourced}`)
    console.log(`  written: ${result.candidates_qualified}`)
    console.log(`  deduped (dropped): ${result.candidates_sourced - result.candidates_qualified}`)

    // ─── RECEIPT 4: Enrichment null-email count ──────────────────────
    console.log('\nRECEIPT 4: enrichment null-email count')
    const { data: enrichProspects } = await supabase
      .from('prospects')
      .select('email')
      .eq('organisation_id', org_id)
      .eq('sourcing_review_status', 'pending_review')

    const nullEmailCount = (enrichProspects || []).filter(p => !p.email).length
    const enrichedCount = (enrichProspects || []).filter(p => p.email).length
    console.log(`  pending_review: ${enrichProspects?.length || 0}`)
    console.log(`  null_email (unenriched): ${nullEmailCount}`)
    console.log(`  enriched (email populated): ${enrichedCount}`)
    console.log(`  Apollo credits consumed (est ~1 per enriched): ${enrichedCount}`)

    // ─── RECEIPT 5: company_industry & industry-match annotation ──────
    console.log('\nRECEIPT 5: company_industry & industry-match annotation')
    const { data: industryData } = await supabase
      .from('prospects')
      .select('company_industry, industry_matches_spec')
      .eq('organisation_id', org_id)
      .eq('sourcing_review_status', 'pending_review')

    const industryPopulated = (industryData || []).filter(p => p.company_industry).length
    const matchTrue = (industryData || []).filter(p => p.industry_matches_spec === true).length
    const matchFalse = (industryData || []).filter(p => p.industry_matches_spec === false).length
    const matchNull = (industryData || []).filter(p => p.industry_matches_spec === null).length

    console.log(`  company_industry populated: ${industryPopulated}`)
    console.log(`  industry_matches_spec: true=${matchTrue}, false=${matchFalse}, null=${matchNull}`)

    // ─── RECEIPT 6: MEV eligibility ────────────────────────────────────
    console.log('\nRECEIPT 6: MEV eligibility & credits')
    const { data: mevData } = await supabase
      .from('prospects')
      .select('email_send_eligible')
      .eq('organisation_id', org_id)
      .eq('sourcing_review_status', 'pending_review')

    const mevEligible = (mevData || []).filter(p => p.email_send_eligible === true).length
    const mevIneligible = (mevData || []).filter(p => p.email_send_eligible === false).length
    const mevUnknown = (mevData || []).filter(p => p.email_send_eligible === null).length

    console.log(`  eligible: ${mevEligible}`)
    console.log(`  ineligible: ${mevIneligible}`)
    console.log(`  unknown/not_validated: ${mevUnknown}`)
    console.log(`  MEV credits consumed (est ~1 per validated): ${mevEligible + mevIneligible}`)

    // ─── RECEIPT 7: Errored prospects ──────────────────────────────────
    console.log('\nRECEIPT 7: errored prospects')
    const { data: erroredProspects } = await supabase
      .from('prospects')
      .select('id, sourcing_review_status')
      .eq('organisation_id', org_id)
      .eq('sourcing_review_status', 'error')

    console.log(`  count: ${erroredProspects?.length || 0}`)

    // ─── RECEIPT 8: MON checks firing ──────────────────────────────────
    console.log('\nRECEIPT 8: MON checks firing')
    const { data: monitors } = await supabase
      .from('monitor_checks')
      .select('check_code, status')
      .eq('organisation_id', org_id)
      .eq('status', 'alert')

    console.log(`  alert count: ${monitors?.length || 0}`)
    for (const m of monitors || []) {
      console.log(`    - ${m.check_code}`)
    }

    console.log('\n=== PHASE 4 FINAL RUN COMPLETE ===')
    console.log('Status: READY FOR OPERATOR SOURCING REVIEW\n')
  } catch (err) {
    console.error('\n❌ RUN FAILED:')
    const msg = err instanceof Error ? err.message : typeof err === 'object' ? JSON.stringify(err) : String(err)
    console.error(msg)
    process.exit(1)
  }
}

main()
