/**
 * Build one pending ICP suggestion whose ONLY change is tier_1.triggers[].reason.
 *
 * The derivation script also rewrites the trigger SENTENCE (it strips inference clauses).
 * That is out of scope here, so the ORIGINAL sentence and the ORIGINAL evidence list are
 * carried through byte-identical and only `reason` is taken from the derivation.
 *
 * It then walks both documents and prints every path that differs. If any path is not a
 * trigger's reason it writes nothing.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

type J = unknown

function diffPaths(a: J, b: J, path = ''): string[] {
  if (a === b) return []
  const aObj = a && typeof a === 'object', bObj = b && typeof b === 'object'
  if (!aObj || !bObj) return [path]
  if (Array.isArray(a) !== Array.isArray(b)) return [path]
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [`${path}[length ${a.length}->${b.length}]`]
    return a.flatMap((v, i) => diffPaths(v, (b as J[])[i], `${path}[${i}]`))
  }
  const ao = a as Record<string, J>, bo = b as Record<string, J>
  const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])]
  return keys.flatMap(k => {
    const p = path ? `${path}.${k}` : k
    if (!(k in ao)) return [`${p} [ADDED]`]
    if (!(k in bo)) return [`${p} [REMOVED]`]
    return diffPaths(ao[k], bo[k], p)
  })
}

async function main() {
  const orgId = process.argv[process.argv.indexOf('--org') + 1]
  const file  = process.argv[process.argv.indexOf('--reasons') + 1]
  const apply = process.argv.includes('--apply')

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } })
  const { data: org } = await sb.from('organisations').select('name').eq('id', orgId).single()
  const { data: doc, error } = await sb.from('strategy_documents')
    .select('id, content, plain_text, version')
    .eq('organisation_id', orgId).eq('document_type', 'icp').eq('status', 'active').single()
  if (error || !doc) throw new Error(`no active ICP: ${error?.message}`)

  const derived = JSON.parse(readFileSync(file, 'utf8')) as {
    document_id: string
    triggers: Array<{ trigger: string; reason: string; evidence_to_find: unknown }>
  }
  if (derived.document_id !== doc.id) {
    throw new Error(`derivation was run against ${derived.document_id}, active document is ${doc.id}`)
  }

  const original = doc.content as Record<string, J>
  const next = JSON.parse(JSON.stringify(original)) as Record<string, J>
  const tier1 = next.tier_1 as Record<string, J>
  const triggers = tier1.triggers as Array<Record<string, J>>

  let added = 0
  triggers.forEach((t, i) => {
    const d = derived.triggers[i]
    const reason = (d?.reason ?? '').trim()
    if (!reason) return                       // trigger 3 on one client: no reason derived
    t.reason = reason                         // sentence + evidence untouched, by construction
    added++
  })

  const paths = diffPaths(original, next)
  console.log(`\n=== ${org?.name} — ICP v${doc.version} (${doc.id}) ===`)
  console.log(`reasons written: ${added} of ${triggers.length}`)
  console.log(`paths that differ (${paths.length}):`)
  for (const p of paths) console.log(`   ${p}`)

  const ok = /^tier_1\.triggers\[\d+\]\.reason \[ADDED\]$/
  const bad = paths.filter(p => !ok.test(p))
  if (bad.length) { console.error(`\nREFUSED — ${bad.length} path(s) outside a trigger reason:\n${bad.join('\n')}`); process.exit(1) }
  console.log('PROVED: every differing path is a trigger reason, and every one is an addition.')

  if (!apply) { console.log('(dry run — pass --apply to insert)'); return }

  const { data: ins, error: insErr } = await sb.from('document_suggestions').insert({
    organisation_id: orgId,
    document_id: doc.id,
    document_type: 'icp',
    field_path: 'full_document',
    current_value: doc.plain_text,
    suggested_value: JSON.stringify(next),
    suggestion_reason:
      `Trigger reasons derived by scripts/derive-trigger-reasons.ts using claude-opus-4-6, ` +
      `each verified against this client's own active positioning document by a second call ` +
      `whose quote is checked in code. ${added} of ${triggers.length} triggers given a reason. ` +
      `The trigger sentences and evidence lists are carried through byte-identical: the only ` +
      `paths that differ from the active document are tier_1.triggers[].reason, each an addition.`,
    confidence_level: 'high',
    signal_count: 0,
    status: 'pending',
    generated_by_model: 'claude-opus-4-6',
    revision_note: `Trigger reasons added (${added} of ${triggers.length}). No trigger sentence or evidence line changed.`,
  }).select('id').single()
  if (insErr) throw new Error(`insert failed: ${insErr.message}`)
  console.log(`PENDING ICP SUGGESTION: ${ins.id}`)
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
