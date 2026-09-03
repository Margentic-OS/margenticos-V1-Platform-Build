// Remove two bare fragments, then RECOMPUTE the sanity band. Editing the accept list
// without re-measuring would leave a stored note describing a criterion that no longer
// exists, which is the validate-one-thing-store-another shape.
import { readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { checkSanityBand, evaluateBuyerCriterion, type BuyerCriterion } from '@/lib/sourcing/buyer-criterion'

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const FILE = process.env.CAPTURE_OUT!
const CUTS: Record<string, string> = { MargenticOS: 'director', '360 Bia Og': 'deputy' }

async function main() {
  const captured = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, any>

  for (const [docId, entry] of Object.entries(captured)) {
    const cut = CUTS[entry.organisation_name]
    if (!cut) continue
    const before: BuyerCriterion = entry.criterion
    const removed = before.accept.filter(a => a.fragment === cut)
    if (removed.length !== 1) throw new Error(`${entry.organisation_name}: expected exactly one '${cut}', found ${removed.length}`)

    const edited: BuyerCriterion = { ...before, accept: before.accept.filter(a => a.fragment !== cut) }

    const { data } = await s.from('prospects').select('job_title')
      .eq('organisation_id', entry.organisation_id).not('job_title', 'is', null).limit(1000)
    const titles = (data ?? []).map(r => r.job_title as string)

    const { status, sanity } = checkSanityBand(edited, titles)
    entry.criterion = { ...edited, status, sanity }

    console.log(`\n=== ${entry.organisation_name} ===`)
    console.log(`removed: '${cut}' (was ${removed[0].rank})`)
    console.log(`accept now: ${entry.criterion.accept.map((a: any) => `${a.fragment}[${a.rank}]`).join(', ')}`)
    console.log(`status: ${before.status} -> ${status}`)
    console.log(`sanity before: ${before.sanity?.note}`)
    console.log(`sanity after:  ${sanity.note}`)
  }

  writeFileSync(FILE, JSON.stringify(captured, null, 2))

  // Re-prove the cohort against the EDITED MargenticOS criterion.
  const mg: any = Object.values(captured).find((v: any) => v.organisation_name === 'MargenticOS')
  const { data: cohort } = await s.from('prospects').select('job_title, tiering_reason')
    .eq('sourcing_run_id', 'cc9a3ef1-0326-4083-a57d-7f2d7b563ced')
  const rows = cohort ?? []
  const rejected = rows.filter(r => evaluateBuyerCriterion(mg.criterion, r.job_title).decision === 'reject')
  const oldNDM = rows.filter(r => r.tiering_reason === 'not_decision_maker')
  const n = new Set(rejected.map(r => r.job_title)), o = new Set(oldNDM.map(r => r.job_title))
  console.log(`\n=== COHORT, EDITED CRITERION ===`)
  console.log(`rejected: ${rejected.length} (old not_decision_maker: ${oldNDM.length})`)
  console.log(`NEW rejects OLD kept: ${[...n].filter(t => !o.has(t)).join(', ') || 'none'}`)
  console.log(`OLD rejected NEW keeps: ${[...o].filter(t => !n.has(t)).join(', ') || 'none'}`)
}
main().catch(e => { console.error(e); process.exit(1) })
