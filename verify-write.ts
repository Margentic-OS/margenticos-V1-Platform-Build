import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const captured = JSON.parse(readFileSync(process.env.CAPTURE_OUT!, 'utf8')) as Record<string, any>

// Order-insensitive: jsonb does not preserve key order, so a raw stringify comparison
// reports a difference that is not one.
const canon = (v: any): any =>
  Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])]))
    : v

async function main() {
  for (const [docId, entry] of Object.entries(captured)) {
    const { data } = await s.from('strategy_documents').select('icp_filter_spec').eq('id', docId).single()
    const stored = (data!.icp_filter_spec as any).buyer_criterion
    const want = entry.criterion
    const same = JSON.stringify(canon(stored)) === JSON.stringify(canon(want))
    console.log(`\n=== ${entry.organisation_name} ===`)
    console.log(`canonical deep-equal: ${same}`)
    if (!same) {
      for (const k of new Set([...Object.keys(stored), ...Object.keys(want)])) {
        const a = JSON.stringify(canon(stored[k])), b = JSON.stringify(canon(want[k]))
        if (a !== b) console.log(`  FIELD ${k}\n    stored: ${a}\n    wanted: ${b}`)
      }
    }
    console.log(`  accept: ${stored.accept.map((x: any) => `${x.fragment}[${x.rank}]`).join(', ')}`)
    console.log(`  cut fragment present? ${stored.accept.some((x: any) => x.fragment === 'director' || x.fragment === 'deputy')}`)
    console.log(`  raw stringify equal (order-sensitive): ${JSON.stringify(stored) === JSON.stringify(want)}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
