// Write the FROZEN criteria from criteria.json into each organisation's existing spec.
// It does NOT re-derive: the whole point is that the bytes reviewed are the bytes stored.
// Additive — one key added to an existing jsonb spec, nothing else touched.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const captured = JSON.parse(readFileSync(process.env.CAPTURE_OUT!, 'utf8')) as Record<string, any>

async function main() {
  for (const [docId, entry] of Object.entries(captured)) {
    const { data: row, error: readErr } = await s
      .from('strategy_documents').select('icp_filter_spec, status, document_type')
      .eq('id', docId).single()
    if (readErr || !row) throw new Error(`could not read ${docId}: ${readErr?.message}`)
    // Refuse to write to a document that has been superseded since capture.
    if (row.status !== 'active' || row.document_type !== 'icp') {
      console.log(`SKIP ${docId}: no longer an active ICP (status=${row.status})`)
      continue
    }
    const spec = { ...(row.icp_filter_spec as object), buyer_criterion: entry.criterion }
    const { error } = await s.from('strategy_documents').update({ icp_filter_spec: spec }).eq('id', docId)
    if (error) throw new Error(`write failed for ${docId}: ${error.message}`)
    console.log(`wrote ${entry.organisation_name} (${docId})`)
  }

  // Read back. Never assume the effect of a write.
  console.log('\n--- READ BACK ---')
  const { data } = await s.from('strategy_documents')
    .select('id, organisation_id, icp_filter_spec')
    .eq('document_type', 'icp').eq('status', 'active').not('icp_filter_spec', 'is', null)
  for (const v of data ?? []) {
    const c = (v.icp_filter_spec as any)?.buyer_criterion
    const want = captured[v.id as string]?.criterion
    const identical = want && JSON.stringify(c) === JSON.stringify(want)
    console.log(`${v.organisation_id}: ${c ? `status=${c.status} accept=${c.accept.length} identical_to_reviewed=${identical}` : 'MISSING'}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
