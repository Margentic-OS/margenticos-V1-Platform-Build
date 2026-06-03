// scripts/test-compose-segment-routing.ts
// Verifies that compose-sequence routes to the correct messaging doc per prospect segment.
//
// Test A — NULL segment_id prospect uses the primary segment's messaging doc.
// Test B — Prospect tagged to a second segment uses that segment's own doc, not the primary.
//
// Run with: npx tsx scripts/test-compose-segment-routing.ts
//
// Creates and cleans up all test rows. Safe to run against the live DB.

import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { composeSequence } from '../src/lib/composition/compose-sequence'

// ── Env load ──────────────────────────────────────────────────────────────────
function loadEnv(): void {
  try {
    const lines = readFileSync(join(process.cwd(), '.env.local'), 'utf-8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx < 0) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '')
      if (!process.env[key]) process.env[key] = val
    }
  } catch { /* rely on shell env */ }
}
loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  process.exit(1)
}

const LIVE_ORG_ID      = '74243c62-f42d-4f3f-b93e-bd5e51f0b6c0'
const PRIMARY_SEG_ID   = 'cf41cd92-79ed-4824-8a4a-fa1db8d611f5'
const PRIMARY_MSG_DOC  = 'da3e795d-c0d9-4182-9063-0ca0638e0a89'
// Unique marker embedded in emails 2-4 of the test seg-2 doc.
// applyPersonalization only touches email 1, so this survives compose.
const SEG2_MARKER = 'SEG2-TEST-MARKER-7f3a'

function admin() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST A — NULL segment_id prospect resolves to primary segment doc
// ─────────────────────────────────────────────────────────────────────────────
async function testA(): Promise<void> {
  console.log('\n── Test A: NULL segment_id prospect uses primary segment messaging doc ──')

  const db = admin()
  const tempId = randomUUID()

  // Fetch the primary doc content so we can verify the assigned variant's email 2 after compose.
  const { data: primaryDocRow } = await db
    .from('strategy_documents')
    .select('content')
    .eq('id', PRIMARY_MSG_DOC)
    .single()

  const primaryContent = primaryDocRow?.content as Record<string, unknown> | undefined
  const primaryVariants = primaryContent?.variants as Record<string, { emails: Array<{ sequence_position: number; body: string }> }> | undefined

  assert(!!primaryVariants && Object.keys(primaryVariants).length > 0,
    `Primary doc has variants`)

  try {
    // Insert temp prospect with segment_id = NULL
    const { error: insertErr } = await db.from('prospects').insert({
      id: tempId,
      organisation_id: LIVE_ORG_ID,
      segment_id: null,
      first_name: 'TempA',
      last_name: 'TestProspect',
      company_name: 'Test Corp',
      role: 'Founder',
      email: `temp-a-${tempId}@test.invalid`,
    })
    assert(!insertErr, `Temp prospect inserted (segment_id = NULL): ${insertErr?.message ?? 'ok'}`)
    if (insertErr) return

    // Run compose
    const result = await composeSequence({ prospect_id: tempId, client_id: LIVE_ORG_ID })

    assert(result.emails.length === 4, `Compose returned 4 emails (got ${result.emails.length})`)
    assert(result.emails[0].body.length > 0, 'Email 1 body is non-empty')
    assert(result.emails[1].body.length > 0, 'Email 2 body is non-empty')

    // Email 2 from compose must match the same variant's email 2 from the primary doc verbatim.
    // (applyPersonalization never touches emails 2-4)
    const assignedVariantEmail2 = primaryVariants?.[result.variant_id]?.emails
      ?.find(e => e.sequence_position === 2)?.body
    if (assignedVariantEmail2) {
      assert(
        result.emails[1].body === assignedVariantEmail2,
        `Email 2 body matches primary doc variant ${result.variant_id} verbatim (da3e795d confirmed used)`
      )
    } else {
      assert(false, `Could not find email 2 in primary doc variant ${result.variant_id} for comparison`)
    }

    console.log(`  → variant assigned: ${result.variant_id}`)
    console.log(`  → messaging doc used: ${PRIMARY_MSG_DOC} (primary segment ${PRIMARY_SEG_ID})`)
    console.log(`  → email 1 word count: ${result.emails[0].word_count}`)

  } finally {
    const { error: delErr } = await db.from('prospects').delete().eq('id', tempId)
    assert(!delErr, `Temp prospect deleted: ${delErr?.message ?? 'ok'}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST B — Prospect tagged to second segment uses that segment's own doc
// ─────────────────────────────────────────────────────────────────────────────
async function testB(): Promise<void> {
  console.log('\n── Test B: Prospect tagged to second segment uses second segment doc, not da3e795d ──')

  const db = admin()
  const seg2Id    = randomUUID()
  const docId     = randomUUID()
  const prospectId = randomUUID()

  // Minimal 4-email messaging doc with SEG2_MARKER in emails 2-4.
  // Only variant A — compose always uses A when that's the only available variant.
  const seg2DocContent = {
    variants: {
      A: {
        emails: [
          {
            sequence_position: 1,
            subject_line: 'test seg2',
            subject_char_count: 9,
            body: `{{first_name}}\n\nSEG2-EMAIL-1-OPENER\n\nSEG2-CTA line here for test\n\nDoug`,
            word_count: 10,
          },
          {
            sequence_position: 2,
            subject_line: null,
            subject_char_count: 0,
            body: `${SEG2_MARKER} — email 2 follow up\n\nDoug`,
            word_count: 7,
          },
          {
            sequence_position: 3,
            subject_line: null,
            subject_char_count: 0,
            body: `${SEG2_MARKER} — email 3 follow up\n\nDoug`,
            word_count: 7,
          },
          {
            sequence_position: 4,
            subject_line: 'last note',
            subject_char_count: 9,
            body: `${SEG2_MARKER} — closing\n\nDoug`,
            word_count: 5,
          },
        ],
      },
    },
  }

  try {
    // Insert the second segment (is_default = false)
    const { error: segErr } = await db.from('segments').insert({
      id: seg2Id,
      organisation_id: LIVE_ORG_ID,
      name: 'Test Segment Two',
      slug: `test-seg-two-${seg2Id.slice(0, 8)}`,
      is_default: false,
    })
    assert(!segErr, `Second segment inserted: ${segErr?.message ?? 'ok'}`)
    if (segErr) return

    // Insert an active messaging doc for the second segment
    const { error: docErr } = await db.from('strategy_documents').insert({
      id: docId,
      organisation_id: LIVE_ORG_ID,
      segment_id: seg2Id,
      document_type: 'messaging',
      status: 'active',
      content: seg2DocContent,
      version: '1',
    })
    assert(!docErr, `Second segment messaging doc inserted (id: ${docId.slice(0, 8)}…): ${docErr?.message ?? 'ok'}`)
    if (docErr) return

    // Insert a prospect tagged to the second segment
    const { error: prospErr } = await db.from('prospects').insert({
      id: prospectId,
      organisation_id: LIVE_ORG_ID,
      segment_id: seg2Id,
      first_name: 'TempB',
      last_name: 'TestProspect',
      company_name: 'Seg Two Corp',
      role: 'CEO',
      email: `temp-b-${prospectId}@test.invalid`,
    })
    assert(!prospErr, `Temp prospect inserted (segment_id = ${seg2Id.slice(0, 8)}…): ${prospErr?.message ?? 'ok'}`)
    if (prospErr) return

    // Run compose on the second-segment prospect
    const result = await composeSequence({ prospect_id: prospectId, client_id: LIVE_ORG_ID })

    assert(result.emails.length === 4, `Compose returned 4 emails (got ${result.emails.length})`)

    // Emails 2-4 must contain the SEG2 marker — proving the second doc was used
    const email2HasMarker = result.emails[1].body.includes(SEG2_MARKER)
    const email3HasMarker = result.emails[2].body.includes(SEG2_MARKER)
    const email4HasMarker = result.emails[3].body.includes(SEG2_MARKER)

    assert(email2HasMarker, `Email 2 body contains ${SEG2_MARKER} (second segment doc used)`)
    assert(email3HasMarker, `Email 3 body contains ${SEG2_MARKER} (second segment doc used)`)
    assert(email4HasMarker, `Email 4 body contains ${SEG2_MARKER} (second segment doc used)`)

    // Emails 2-4 must NOT contain content from the primary doc
    const email2HasPrimaryContent = result.emails[1].body.includes('da3e795d')
    assert(!email2HasPrimaryContent, 'Email 2 does not reference primary doc id (sanity check)')

    console.log(`  → variant assigned: ${result.variant_id}`)
    console.log(`  → second segment doc used: ${docId}`)
    console.log(`  → primary doc (da3e795d) was NOT used ✓`)

  } finally {
    // Clean up in dependency order: prospect → doc → segment
    const { error: delP } = await db.from('prospects').delete().eq('id', prospectId)
    assert(!delP, `Temp prospect deleted: ${delP?.message ?? 'ok'}`)

    const { error: delD } = await db.from('strategy_documents').delete().eq('id', docId)
    assert(!delD, `Second segment doc deleted: ${delD?.message ?? 'ok'}`)

    const { error: delS } = await db.from('segments').delete().eq('id', seg2Id)
    assert(!delS, `Second segment deleted: ${delS?.message ?? 'ok'}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('compose-sequence segment routing tests')
  console.log('Live org:', LIVE_ORG_ID)

  await testA()
  await testB()

  console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('Unhandled error:', err)
  process.exit(1)
})
