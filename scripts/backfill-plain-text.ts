// Backfills strategy_documents.plain_text from the structured content already stored.
//
//   DRY RUN (default, writes nothing):
//     dotenv -e .env.local -- npx tsx scripts/backfill-plain-text.ts
//
//   SHOW ONE DOCUMENT before and after:
//     dotenv -e .env.local -- npx tsx scripts/backfill-plain-text.ts --show <document-id>
//
//   APPLY (writes):
//     dotenv -e .env.local -- npx tsx scripts/backfill-plain-text.ts --apply
//
// THIS IS A FORMATTING CONVERSION. No model call, no rewriting, no summarising. See
// src/lib/documents/render-plain-text.ts for the renderer and for why it is schema-agnostic.
//
// SAFETY PROPERTIES, in the order they matter:
//
//   1. DRY RUN IS THE DEFAULT. Writing requires --apply. A script that mutates data by
//      default is one mistyped command away from an incident, and this one touches five
//      live documents a client can read today.
//   2. EVERY ROW IS VERIFIED BEFORE ANY ROW IS WRITTEN. assertNoContentLost runs over all
//      69 rows first. If one row would lose a string, nothing is written at all. A partial
//      backfill would leave the table in a state no reader expects.
//   3. IT ONLY EVER FILLS NULLS. The update carries `.is('plain_text', null)`, so a row
//      that has gained a value between the read and the write is left alone rather than
//      overwritten. Re-running is safe and is a no-op once complete.
//   4. IT NEVER TOUCHES content. The only column in the update is plain_text.

import { createClient } from '@supabase/supabase-js'
import {
  renderDocumentPlainText,
  assertNoContentLost,
  collectStringLeaves,
} from '../src/lib/documents/render-plain-text'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}

const apply = process.argv.includes('--apply')
const showIndex = process.argv.indexOf('--show')
const showId = showIndex >= 0 ? process.argv[showIndex + 1] : null

const supabase = createClient(url, key, { auth: { persistSession: false } })

interface Row {
  id: string
  organisation_id: string
  document_type: string
  version: string
  status: string
  created_at: string
  content: unknown
  plain_text: string | null
}

async function main(): Promise<void> {
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('id, organisation_id, document_type, version, status, created_at, content, plain_text')
    .order('document_type', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Read failed:', error.message)
    process.exit(1)
  }

  const rows = (data ?? []) as Row[]
  console.log(`Read ${rows.length} strategy_documents rows.\n`)

  // ── Single-document display mode ──────────────────────────────────────────
  if (showId) {
    const row = rows.find(r => r.id === showId)
    if (!row) {
      console.error(`No document with id ${showId}`)
      process.exit(1)
    }
    const rendered = renderDocumentPlainText(row.content)
    console.log('='.repeat(78))
    console.log(`BEFORE — content (JSON), ${row.document_type} v${row.version} [${row.status}]`)
    console.log('='.repeat(78))
    console.log(JSON.stringify(row.content, null, 2))
    console.log()
    console.log('='.repeat(78))
    console.log(`AFTER — plain_text (rendered), ${row.document_type} v${row.version}`)
    console.log('='.repeat(78))
    console.log(rendered)
    console.log()
    console.log('='.repeat(78))
    const leaves = collectStringLeaves(row.content)
    const missing = leaves.filter(l => !rendered.includes(l))
    console.log(`VERIFY: ${leaves.length} string leaves in content, ${missing.length} missing from output.`)
    console.log('='.repeat(78))
    return
  }

  // ── Phase 1: render and verify EVERY row before writing ANY row ───────────
  const planned: { row: Row; rendered: string }[] = []
  const failures: string[] = []
  let emptyRenders = 0

  for (const row of rows) {
    const label = `${row.document_type} v${row.version} (${row.id})`
    let rendered: string
    try {
      rendered = renderDocumentPlainText(row.content)
      assertNoContentLost(row.content, rendered, label)
    } catch (e) {
      failures.push(`${label}: ${(e as Error).message}`)
      continue
    }
    if (rendered.trim() === '') emptyRenders++
    planned.push({ row, rendered })
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const byType = new Map<string, { n: number; leaves: number; chars: number }>()
  for (const { row, rendered } of planned) {
    const cur = byType.get(row.document_type) ?? { n: 0, leaves: 0, chars: 0 }
    cur.n += 1
    cur.leaves += collectStringLeaves(row.content).length
    cur.chars += rendered.length
    byType.set(row.document_type, cur)
  }

  console.log('Per document type:')
  console.log('  type          rows   string leaves   rendered chars')
  for (const [type, s] of [...byType.entries()].sort()) {
    console.log(
      `  ${type.padEnd(12)}  ${String(s.n).padStart(4)}   ${String(s.leaves).padStart(13)}   ${String(s.chars).padStart(14)}`,
    )
  }
  console.log()
  console.log(`Rows that render cleanly, no string lost : ${planned.length}`)
  console.log(`Rows that render to empty text           : ${emptyRenders}`)
  console.log(`Rows that FAILED verification            : ${failures.length}`)

  if (failures.length > 0) {
    console.log('\nFAILURES:')
    for (const f of failures) console.log(`  ${f}`)
    console.error('\nRefusing to write. Every row must verify before any row is written.')
    process.exit(1)
  }

  if (!apply) {
    console.log('\nDRY RUN. Nothing was written. Re-run with --apply to write.')
    return
  }

  // ── Phase 2: write ────────────────────────────────────────────────────────
  console.log('\nApplying...')
  let written = 0
  let skipped = 0

  for (const { row, rendered } of planned) {
    const { data: updated, error: upErr } = await supabase
      .from('strategy_documents')
      .update({ plain_text: rendered })
      .eq('id', row.id)
      .is('plain_text', null)   // never overwrite a value that appeared since the read
      .select('id')

    if (upErr) {
      console.error(`  FAILED ${row.id}: ${upErr.message}`)
      process.exit(1)
    }
    if ((updated ?? []).length === 0) skipped++
    else written++
  }

  console.log(`\nWrote ${written} rows. Skipped ${skipped} (already had a value).`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
