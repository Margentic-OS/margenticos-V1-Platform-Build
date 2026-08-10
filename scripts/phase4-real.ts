import { createClient } from '@supabase/supabase-js'
import { runSourcing } from '@/lib/sourcing/orchestrator'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const org_id = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'

async function main() {
  console.log('\n=== PHASE 4 (FIXED) ===\n')
  console.log('START: sourcing → dedupe → write with proper person data extraction')
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
      .select('id, status, started_at, completed_at, duration_ms, error_message')
      .eq('organisation_id', org_id)
      .eq('agent_name', 'sourcing_orchestrator')
      .order('started_at', { ascending: false })
      .limit(1)

    if (runs?.length) {
      const run = runs[0]
      console.log(`  id: ${run.id}`)
      console.log(`  status: ${run.status}`)
      console.log(`  completed_at: ${run.completed_at}`)
      console.log(`  duration_ms: ${run.duration_ms}`)
      if (run.error_message) {
        console.log(`  ERROR: ${run.error_message}`)
        process.exit(1)
      }
    } else {
      console.log('  ERROR: No agent_runs row found')
      process.exit(1)
    }

    // ─── RECEIPT 2: Prospect counts ────────────────────────────────────
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

    // ─── RECEIPT 3: Dedupe verdicts ───────────────────────────────────
    console.log('\nRECEIPT 3: dedupe verdicts (from run result)')
    console.log(`  sourced: ${result.candidates_sourced}`)
    console.log(`  written: ${result.candidates_qualified}`)
    console.log(`  deduped/dropped: ${result.candidates_sourced - result.candidates_qualified}`)

    // ─── RECEIPT 4: Sample rows (verify data populated) ────────────────
    console.log('\nRECEIPT 4: sample prospect rows (proof of data population)')
    const { data: samples } = await supabase
      .from('prospects')
      .select('first_name, job_title, company_name, country')
      .eq('organisation_id', org_id)
      .eq('sourcing_review_status', 'pending_review')
      .limit(3)

    for (let i = 0; i < (samples?.length || 0); i++) {
      const s = samples![i]
      console.log(`  Sample ${i + 1}: first_name="${s.first_name}", job_title="${s.job_title}", company_name="${s.company_name}", country="${s.country}"`)
    }

    // ─── RECEIPT 5: Enrichment status (not run yet) ────────────────────
    console.log('\nRECEIPT 5: enrichment status (not yet run - post-approval pipeline)')
    const { data: enrichProspects } = await supabase
      .from('prospects')
      .select('email, company_industry, company_headcount')
      .eq('organisation_id', org_id)
      .eq('sourcing_review_status', 'pending_review')

    const nullEmailCount = (enrichProspects || []).filter(p => !p.email).length
    const nullIndustryCount = (enrichProspects || []).filter(p => !p.company_industry).length
    const nullHeadcountCount = (enrichProspects || []).filter(p => !p.company_headcount).length
    console.log(`  null_email (unenriched, as expected): ${nullEmailCount}/${enrichProspects?.length}`)
    console.log(`  null_company_industry: ${nullIndustryCount}/${enrichProspects?.length}`)
    console.log(`  null_company_headcount: ${nullHeadcountCount}/${enrichProspects?.length}`)
    console.log(`  (Enrichment runs post-approval via separate agent — not part of sourcing phase)`)

    // ─── RECEIPT 6: MEV eligibility (not run yet) ──────────────────────
    console.log('\nRECEIPT 6: MEV eligibility (not yet run - post-enrichment)')
    const { data: mevData } = await supabase
      .from('prospects')
      .select('email_send_eligible')
      .eq('organisation_id', org_id)
      .eq('sourcing_review_status', 'pending_review')

    const mevEligible = (mevData || []).filter(p => p.email_send_eligible === true).length
    const mevIneligible = (mevData || []).filter(p => p.email_send_eligible === false).length
    const mevUnknown = (mevData || []).filter(p => p.email_send_eligible === null).length
    console.log(`  eligible: ${mevEligible} (requires email from enrichment)`)
    console.log(`  ineligible: ${mevIneligible} (default on NULL email)`)
    console.log(`  unknown/null: ${mevUnknown}`)

    // ─── RECEIPT 7: Errors ─────────────────────────────────────────────
    console.log('\nRECEIPT 7: errored prospects')
    const { data: errored } = await supabase
      .from('prospects')
      .select('id')
      .eq('organisation_id', org_id)
      .eq('sourcing_review_status', 'error')

    console.log(`  count: ${errored?.length || 0}`)

    // ─── RECEIPT 8: MON checks ────────────────────────────────────────
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

    console.log('\n=== PHASE 4 COMPLETE ===')
    console.log('Status: READY FOR OPERATOR SOURCING REVIEW (pending_review → approval → enrichment)\n')
  } catch (err) {
    console.error('\n❌ RUN FAILED:')
    const msg = err instanceof Error ? err.message : JSON.stringify(err)
    console.error(msg)
    process.exit(1)
  }
}

main()
