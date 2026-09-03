// Derive ONCE and freeze the result to disk. The backfill then writes these exact bytes,
// so what is reviewed is what is stored. Deriving twice would mean approving one answer
// and persisting another.
import { writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { deriveBuyerCriterion } from '@/agents/buyer-criterion-agent'

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const OUT = process.env.CAPTURE_OUT!

async function main() {
  const { data: docs, error } = await s
    .from('strategy_documents')
    .select('id, organisation_id, organisations(name)')
    .eq('document_type', 'icp').eq('status', 'active').not('icp_filter_spec', 'is', null)
  if (error) throw error

  const captured: Record<string, unknown> = {}
  for (const d of docs ?? []) {
    const name = (d as any).organisations?.name ?? d.organisation_id
    const criterion = await deriveBuyerCriterion({ supabase: s, organisation_id: d.organisation_id as string })
    captured[d.id as string] = { organisation_id: d.organisation_id, organisation_name: name, criterion }
  }
  writeFileSync(OUT, JSON.stringify(captured, null, 2))
  console.log(`captured ${Object.keys(captured).length} criteria to ${OUT}`)
}
main().catch(e => { console.error(e); process.exit(1) })
