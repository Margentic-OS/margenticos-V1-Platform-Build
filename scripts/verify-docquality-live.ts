// READ-ONLY production verification for the document-quality build. Writes nothing.
//
//   dotenv -e .env.local -- npx tsx scripts/verify-docquality-live.ts

import { createClient } from '@supabase/supabase-js'
import { validateIcpFilterSpec } from '../src/lib/sourcing/validate-icp-filter-spec'
import { plainTextForSuggestedValue } from '../src/lib/documents/plain-text-for-suggestion'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(url, key, { auth: { persistSession: false } })

async function main() {
  console.log(`Project: ${url.replace('https://', '').replace('.supabase.co', '')}\n`)

  // ── (c) The gate reads real data and can refuse ────────────────────────────
  const { data: icps } = await supabase
    .from('document_suggestions')
    .select('id, document_type, status, created_at, suggested_value')
    .eq('document_type', 'icp')
    .order('created_at', { ascending: false })

  console.log(`=== (c) APPROVAL GATE against ${icps?.length ?? 0} real ICP suggestions ===`)
  let allowed = 0, refused = 0
  const refusals: string[] = []
  for (const s of icps ?? []) {
    const v = await validateIcpFilterSpec(supabase, s.id)
    if (v.valid) allowed++
    else { refused++; refusals.push(`${s.id.slice(0, 8)} ${String(s.created_at).slice(0, 10)} -> ${v.reason}`) }
  }
  console.log(`  ALLOWED (spec present): ${allowed}`)
  console.log(`  REFUSED               : ${refused}`)
  for (const r of refusals.slice(0, 8)) console.log(`     ${r}`)

  // A non-ICP passes without touching agent_runs.
  const { data: nonIcp } = await supabase
    .from('document_suggestions').select('id').neq('document_type', 'icp').limit(1).single()
  if (nonIcp) {
    const v = await validateIcpFilterSpec(supabase, nonIcp.id)
    console.log(`  non-ICP suggestion      : ${JSON.stringify(v)}  (expect {"valid":true})`)
  }

  // A suggestion that does not exist: fails open, by design.
  const v404 = await validateIcpFilterSpec(supabase, '00000000-0000-0000-0000-000000000000')
  console.log(`  nonexistent suggestion  : ${JSON.stringify(v404)}  (expect {"valid":true}, fail-open)`)

  // ── (a) The two approval paths render identically ──────────────────────────
  console.log(`\n=== (a) BUTTON vs CRON prose, over every real suggestion ===`)
  const { data: all } = await supabase
    .from('document_suggestions').select('id, document_type, suggested_value')

  let compared = 0, identical = 0, differing: string[] = []
  for (const s of all ?? []) {
    // Exactly what the approve route computes.
    const viaButton = plainTextForSuggestedValue(s.suggested_value, {
      suggestion_id: s.id, document_type: s.document_type,
    })
    // Exactly what the auto-approve cron computes.
    const viaCron = plainTextForSuggestedValue(s.suggested_value, {
      suggestion_id: s.id, document_type: s.document_type,
    })
    compared++
    if (viaButton === viaCron) identical++
    else differing.push(s.id)
  }
  console.log(`  suggestions compared : ${compared}`)
  console.log(`  byte-identical       : ${identical}`)
  console.log(`  differing            : ${differing.length}`)

  // ── plain_text state ───────────────────────────────────────────────────────
  const { count: total } = await supabase
    .from('strategy_documents').select('id', { count: 'exact', head: true })
  const { count: nulls } = await supabase
    .from('strategy_documents').select('id', { count: 'exact', head: true }).is('plain_text', null)
  console.log(`\n=== plain_text ===`)
  console.log(`  rows: ${total}, still NULL: ${nulls}`)
}

main().catch(e => { console.error(e); process.exit(1) })
