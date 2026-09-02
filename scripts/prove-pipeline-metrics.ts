// Proof harness for every number the pipeline review screen renders.
//
// Prints what the UI would show beside what a direct SQL query returns, for each active
// organisation. The UI column comes from getSourcingMetrics, which is the exact function
// the page and the poll route call; the SQL column is written independently, against the
// same database, so a shared bug would have to exist in both to hide.
//
// READ ONLY. Counts and selects, no writes. Safe against production, which is the point.
//
// Run:  npx dotenv -e .env.local -- npx tsx scripts/prove-pipeline-metrics.ts

import { createClient } from '@supabase/supabase-js'
import { getSourcingMetrics } from '../src/lib/operator/sourcing-metrics'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. ' +
      'Run via: npx dotenv -e .env.local -- npx tsx scripts/prove-pipeline-metrics.ts',
    )
  }

  const supabase = createClient(url, key)
  const metrics = await getSourcingMetrics(supabase)

  const rows: Array<Record<string, string>> = []

  for (const m of metrics) {
    /** One independent SQL count, written without reference to the metrics module. */
    const sqlCount = async (shape: (q: any) => any): Promise<number> => {
      const { count, error } = await shape(
        supabase.from('prospects').select('id', { count: 'exact', head: true })
          .eq('organisation_id', m.organisation_id),
      )
      if (error) throw new Error(error.message)
      return count ?? 0
    }

    const checks: Array<[string, number, number]> = [
      ['awaiting approval', m.pending_review_count,
        await sqlCount(q => q.eq('sourcing_review_status', 'pending_review'))],
      ['enriching', m.approved_unenriched_count,
        await sqlCount(q => q.eq('sourcing_review_status', 'approved').is('enrichment_status', null))],
      ['tier 1 total', m.tiers.tier_1.total, await sqlCount(q => q.eq('sourced_tier', 'tier_1'))],
      ['tier 1 sendable', m.tiers.tier_1.sendable,
        await sqlCount(q => q.eq('sourced_tier', 'tier_1').eq('email_send_eligible', true))],
      ['tier 2 total', m.tiers.tier_2.total, await sqlCount(q => q.eq('sourced_tier', 'tier_2'))],
      ['tier 2 sendable', m.tiers.tier_2.sendable,
        await sqlCount(q => q.eq('sourced_tier', 'tier_2').eq('email_send_eligible', true))],
      ['tier 3 total', m.tiers.tier_3.total, await sqlCount(q => q.eq('sourced_tier', 'tier_3'))],
      ['tier 3 sendable', m.tiers.tier_3.sendable,
        await sqlCount(q => q.eq('sourced_tier', 'tier_3').eq('email_send_eligible', true))],
      ['removed', m.removed_count,
        await sqlCount(q => q.eq('enrichment_status', 'enriched').is('sourced_tier', null)
          .not('tiering_reason', 'is', null))],
      ['verification failures', m.verification_failures.count,
        await sqlCount(q => q.not('last_verification_error', 'is', null))],
    ]

    for (const [label, ui, sql] of checks) {
      rows.push({
        organisation: m.organisation_name,
        number: label,
        'UI renders': String(ui),
        'SQL says': String(sql),
        agree: ui === sql ? 'yes' : 'NO',
      })
    }

    rows.push({
      organisation: m.organisation_name,
      number: 'research button label',
      'UI renders': String(m.research.actionable),
      'SQL says': m.research.blocked ? '0 (blocked)' : String(m.research.actionable),
      agree: m.research.blocked && m.research.actionable !== 0 ? 'NO' : 'yes',
    })
  }

  // eslint-disable-next-line no-console -- a proof harness prints to a terminal by design
  console.table(rows)

  // eslint-disable-next-line no-console -- see above
  console.log('\nBREAKDOWNS THE SCREEN NOW SHOWS (previously not rendered anywhere):')
  for (const m of metrics) {
    const notSendable = Object.entries(m.tiers.tier_1.notSendableByReason)
    if (notSendable.length === 0 && m.verification_failures.count === 0 &&
        Object.keys(m.removed_by_reason).length === 0) continue
    // eslint-disable-next-line no-console -- see above
    console.log(`\n  ${m.organisation_name}`)
    // eslint-disable-next-line no-console -- see above
    console.log(`    tier 1 not sendable: ${JSON.stringify(m.tiers.tier_1.notSendableByReason)}`)
    // eslint-disable-next-line no-console -- see above
    console.log(`    removed by reason:   ${JSON.stringify(m.removed_by_reason)}`)
    // eslint-disable-next-line no-console -- see above
    console.log(`    verification failed: ${JSON.stringify(m.verification_failures)}`)
    // eslint-disable-next-line no-console -- see above
    console.log(`    breakdowns truncated: ${m.breakdowns_truncated}`)
  }
}

main().catch(err => {
  // eslint-disable-next-line no-console -- see above
  console.error(err)
  process.exit(1)
})
