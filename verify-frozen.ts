import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { evaluateBuyerCriterion } from '@/lib/sourcing/buyer-criterion'

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const captured = JSON.parse(readFileSync(process.env.CAPTURE_OUT!, 'utf8'))
const mg: any = Object.values(captured).find((v: any) => v.organisation_name === 'MargenticOS')

async function main() {
  const { data } = await s.from('prospects').select('job_title, tiering_reason, sourced_tier')
    .eq('sourcing_run_id', 'cc9a3ef1-0326-4083-a57d-7f2d7b563ced')
  const rows = data ?? []
  const rejected = rows.filter(r => evaluateBuyerCriterion(mg.criterion, r.job_title).decision === 'reject')
  const oldNDM = rows.filter(r => r.tiering_reason === 'not_decision_maker')

  console.log(`cohort: ${rows.length}`)
  console.log(`rejected by FROZEN criterion: ${rejected.length}`)
  console.log(`old not_decision_maker:       ${oldNDM.length}`)

  const n = new Set(rejected.map(r => r.job_title)), o = new Set(oldNDM.map(r => r.job_title))
  const onlyNew = [...n].filter(t => !o.has(t)), onlyOld = [...o].filter(t => !n.has(t))
  console.log(`\nNEW rejects, OLD kept (${onlyNew.length}):`); onlyNew.forEach(t => console.log(`  + ${t}`))
  console.log(`OLD rejected, NEW keeps (${onlyOld.length}):`); onlyOld.forEach(t => console.log(`  - ${t}`))

  // Every distinct title in the cohort and its verdict, so nothing hides in an aggregate.
  const seen = new Map<string, string>()
  for (const r of rows) {
    const v = evaluateBuyerCriterion(mg.criterion, r.job_title)
    seen.set(r.job_title as string, v.decision === 'accept' ? v.rank : v.decision)
  }
  console.log(`\ndistinct titles: ${seen.size}`)
  const rej = [...seen].filter(([, v]) => v === 'reject')
  console.log(`distinct REJECTED titles (${rej.length}):`)
  rej.forEach(([t]) => console.log(`  ${t}`))
}
main().catch(e => { console.error(e); process.exit(1) })
