// B2 step 9 verification for S1 — run with: npx tsx scripts/test-revision-s1.ts
// Tests: 9a mediable success, 9b forced 422 gate path, 9c assertNoDashes unit gate

import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { runDocumentRevisionAgent, RevisionGateError } from '../src/lib/agents/revision/run-revision'
import { assertNoDashes } from '../src/lib/style/customer-facing-style-rules'
import type { Database } from '../src/types/database'

const DRY_RUN_ORG_ID = 'a2b621fc-4c9d-43d9-9af4-1253ff49d12d'
const MESSAGING_DOC_ID = '6187c801-01ea-4fa4-a61d-f93ebff8c625'

function supabase() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

async function main() {
  const db = supabase()

  const { data: doc, error: docErr } = await db
    .from('strategy_documents')
    .select('id, document_type, content, version')
    .eq('id', MESSAGING_DOC_ID)
    .single()

  if (docErr || !doc) {
    console.error('Could not fetch DRY RUN messaging doc:', docErr?.message)
    process.exit(1)
  }

  console.log(`DRY RUN messaging doc loaded — version ${doc.version}, type ${doc.document_type}\n`)

  // ── Step 9a: Mediable credentials note ──────────────────────────────────────
  console.log('=== Step 9a: Mediable credentials note ===')
  const credNote = "Can you add our credentials to the emails? We've worked with 47 consulting firms in the last 3 years, generated over $2M in pipeline for clients, and have a 94% client retention rate. This is important for establishing trust with prospects."

  let step9aPass = false
  try {
    const result = await runDocumentRevisionAgent({
      organisation_id: DRY_RUN_ORG_ID,
      document_type: 'messaging',
      current_content: doc.content,
      revision_note: credNote,
      supabase: db,
    })
    step9aPass = true
    console.log('RESULT: PASS — revision succeeded without gate failure')
    console.log('\nchange_summary:')
    console.log(result.change_summary)

    // Extract and display Email 4 variant A for evidence trace
    const content = result.revised_content as Record<string, unknown>
    const variants = (content['variants'] ?? {}) as Record<string, { emails: Array<{ sequence_position: number; body: string }> }>
    const variantA = variants['A']
    const email4A = variantA?.emails?.find(e => e.sequence_position === 4)
    console.log('\n--- Email 4 Variant A body (for evidence trace) ---')
    console.log(email4A?.body ?? '(not found)')
  } catch (err) {
    if (err instanceof RevisionGateError) {
      console.log('RESULT: FAIL — unexpected RevisionGateError')
      console.log('violations:', err.violations)
    } else {
      console.log('RESULT: FAIL — unexpected error:', err instanceof Error ? err.message : err)
    }
  }

  // ── Step 9b: Forced 422 path ─────────────────────────────────────────────
  console.log('\n=== Step 9b: Forced gate failure (422 path) ===')
  process.env.REVISION_FORCE_GATE_FAIL = 'true'

  let step9bPass = false
  try {
    await runDocumentRevisionAgent({
      organisation_id: DRY_RUN_ORG_ID,
      document_type: 'messaging',
      current_content: doc.content,
      revision_note: 'Minor wording tweak',
      supabase: db,
    })
    console.log('RESULT: FAIL — no error thrown, expected RevisionGateError')
  } catch (err) {
    if (err instanceof RevisionGateError) {
      step9bPass = true
      console.log('RESULT: PASS — RevisionGateError thrown as expected')
      console.log('violations:', err.violations)
    } else {
      console.log('RESULT: FAIL — wrong error type:', err instanceof Error ? err.message : err)
    }
  } finally {
    delete process.env.REVISION_FORCE_GATE_FAIL
  }

  // ── Step 9c: assertNoDashes unit gate ────────────────────────────────────
  console.log('\n=== Step 9c: assertNoDashes gate rejects em-dash content ===')
  const contentWithEmDash = {
    variants: {
      variant_a: {
        emails: [{
          sequence_position: 1,
          subject_line: 'Quick note',
          subject_char_count: 10,
          body: "Hi {{first_name}},\n\nSaw your firm — results look strong.\n\nDoug",
          word_count: 8,
        }],
      },
    },
  }

  let step9cPass = false
  try {
    assertNoDashes(contentWithEmDash, 'test/step9c')
    console.log('RESULT: FAIL — assertNoDashes did not throw for em-dash content')
  } catch (err) {
    step9cPass = true
    console.log('RESULT: PASS — assertNoDashes threw as expected')
    console.log('error message:', err instanceof Error ? err.message : err)
  }

  // ── agent_runs evidence ───────────────────────────────────────────────────
  console.log('\n=== agent_runs check ===')
  const { data: runs } = await db
    .from('agent_runs')
    .select('id, agent_name, status, output_summary, error_message, started_at')
    .eq('organisation_id', DRY_RUN_ORG_ID)
    .eq('agent_name', 'document-revision')
    .order('started_at', { ascending: false })
    .limit(6)

  if (runs && runs.length > 0) {
    console.log(`Found ${runs.length} document-revision run(s) for DRY RUN org:\n`)
    for (const r of runs) {
      console.log(`  id: ${r.id}`)
      console.log(`  status: ${r.status}`)
      console.log(`  started: ${r.started_at}`)
      if (r.output_summary) console.log(`  output: ${r.output_summary.slice(0, 100)}`)
      if (r.error_message) console.log(`  error: ${r.error_message.slice(0, 100)}`)
      console.log()
    }
  } else {
    console.log('No document-revision runs found (or DB query failed)')
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('=== Summary ===')
  console.log(`9a mediable success:  ${step9aPass ? 'PASS' : 'FAIL'}`)
  console.log(`9b 422 gate path:     ${step9bPass ? 'PASS' : 'FAIL'}`)
  console.log(`9c assertNoDashes:    ${step9cPass ? 'PASS' : 'FAIL'}`)
}

main().catch(err => {
  console.error('Script error:', err)
  process.exit(1)
})
