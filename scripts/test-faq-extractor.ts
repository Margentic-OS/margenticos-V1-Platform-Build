// FAQ extractor test harness — human review tool.
// Reads all 12 fixtures, seeds prerequisite rows for fixtures 02 and 12,
// calls extractFaq() for each, prints output for Doug to review.
// Run with: npm run test-extractor
//
// This is NOT a pass/fail test suite. It is a quality review tool.
// A null return or empty array may indicate a gate skip — check the EXPECTED line.
// Check agent_runs in Supabase for debug detail on unexpected empty results.

import { readdir, readFile } from 'fs/promises'
import { join, basename } from 'path'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { extractFaq } from '../src/lib/agents/faq-extraction-agent'
import type { FaqExtractionInput } from '../src/lib/agents/faq-extraction-agent'

// ─── Dev Supabase client ──────────────────────────────────────────────────────

function getDevClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.')
    console.error('Run from the project root with env vars loaded:')
    console.error('  npx dotenv -e .env.local npx tsx scripts/test-faq-extractor.ts')
    process.exit(1)
  }
  return createClient<Database>(url, key)
}

// ─── Fixture type ─────────────────────────────────────────────────────────────

interface FixtureJson {
  organisationId: string
  organisationName: string
  replyDraftId: string
  prospectQuestionContext: string
  originalOutboundBody: string
  operatorAnswer: string
  aiDraftBody: string
  orgPositioningDocument: string
  expected_behaviour: string
}

// ─── Seeded row tracker for cleanup ──────────────────────────────────────────

interface SeededRows {
  faqId?: string
  extractionId?: string
  replyDraftId?: string
  signalId?: string
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

// Fixture 02: seeds an approved FAQ with a question about working with solo consultants.
// faqs only requires organisation_id — no other FK dependencies.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedFaqForFixture02(supabase: any, organisationId: string): Promise<string | null> {
  // question_variants must be empty so the FAQ token set stays small.
  // Adding variants expands the union (e.g. from 4 to 6 tokens) and drops
  // the Jaccard score below the 0.45 flag threshold despite a genuine match.
  const { data, error } = await supabase
    .from('faqs')
    .insert({
      organisation_id: organisationId,
      question_canonical: 'Do you work with solo consultants?',
      question_variants: [],
      answer: 'Yes, we work with both solo consultants and small consulting teams.',
      status: 'approved',
    })
    .select('id')
    .single()

  if (error) {
    console.warn(`  [SEED WARNING] Could not seed FAQ for fixture 02: ${error.message}`)
    return null
  }
  console.log(`  [SEED] Inserted approved FAQ ${data.id} for fixture 02`)
  return data.id
}

// Deterministic UUIDs for fixture 12 self-seeding.
// Using these IDs lets the harness clean up exactly what it inserted on every run,
// even if a previous run crashed before cleanup.
const SEED12_SIGNAL_ID = '00000000-0000-0000-0000-001200000001'
const SEED12_REPLY_DRAFT_ID = '00000000-0000-0000-0000-001200000002'
const SEED12_EXTRACTION_ID = '00000000-0000-0000-0000-001200000003'

// Fixture 12: self-seeds signal → reply_draft → faq_extractions using deterministic UUIDs.
// Pre-cleans stale rows from any previous crashed run before inserting fresh ones.
// Cleanup in cleanupSeeds runs in reverse FK order: extraction → reply_draft → signal.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedPendingExtractionForFixture12(supabase: any, organisationId: string): Promise<SeededRows | null> {
  // Pre-clean stale rows from any previous crashed run (reverse FK order)
  await supabase.from('faq_extractions').delete().eq('id', SEED12_EXTRACTION_ID)
  await supabase.from('reply_drafts').delete().eq('id', SEED12_REPLY_DRAFT_ID)
  await supabase.from('signals').delete().eq('id', SEED12_SIGNAL_ID)

  // 1. Insert signal
  const { error: sigErr } = await supabase
    .from('signals')
    .insert({
      id: SEED12_SIGNAL_ID,
      organisation_id: organisationId,
      signal_type: 'email_reply',
      raw_data: {},
    })

  if (sigErr) {
    console.warn(`  [SEED WARNING] Could not seed signal for fixture 12: ${sigErr.message}`)
    return null
  }

  // 2. Insert reply_draft referencing the seeded signal
  const { error: draftErr } = await supabase
    .from('reply_drafts')
    .insert({
      id: SEED12_REPLY_DRAFT_ID,
      organisation_id: organisationId,
      signal_id: SEED12_SIGNAL_ID,
      tier: 3,
      intent: 'information_request',
      ai_draft_body: 'We work with both solo consultants and small teams.',
      final_sent_body: 'We work with both solo consultants and small teams.',
      status: 'sent',
    })

  if (draftErr) {
    console.warn(`  [SEED WARNING] Could not seed reply_draft for fixture 12: ${draftErr.message}`)
    await supabase.from('signals').delete().eq('id', SEED12_SIGNAL_ID)
    return null
  }

  // 3. Insert pending faq_extractions row representing a prior extraction on the same topic.
  // The extracted_question must have high token overlap with whatever Haiku extracts from
  // fixture 12's prospect question ("Do you work with solo consultants or mainly bigger
  // consulting firms?"). "Do you work with solo consultants or mainly consulting firms?"
  // shares {you, work, solo, consultants, or, mainly, consulting, firms} = 8/9 tokens
  // → Jaccard ≈ 0.89, well above the 0.45 flag threshold.
  const { error: extractErr } = await supabase
    .from('faq_extractions')
    .insert({
      id: SEED12_EXTRACTION_ID,
      organisation_id: organisationId,
      signal_id: SEED12_SIGNAL_ID,
      reply_draft_id: SEED12_REPLY_DRAFT_ID,
      extracted_question: 'Do you work with solo consultants or mainly consulting firms?',
      suggested_answer: 'Yes, we work with solo consultants and small consulting teams.',
      status: 'pending',
    })

  if (extractErr) {
    console.warn(`  [SEED WARNING] Could not seed faq_extractions for fixture 12: ${extractErr.message}`)
    await supabase.from('reply_drafts').delete().eq('id', SEED12_REPLY_DRAFT_ID)
    await supabase.from('signals').delete().eq('id', SEED12_SIGNAL_ID)
    return null
  }

  console.log(`  [SEED] Inserted signal ${SEED12_SIGNAL_ID} for fixture 12`)
  console.log(`  [SEED] Inserted reply_draft ${SEED12_REPLY_DRAFT_ID} for fixture 12`)
  console.log(`  [SEED] Inserted pending faq_extraction ${SEED12_EXTRACTION_ID} for fixture 12`)
  return {
    extractionId: SEED12_EXTRACTION_ID,
    replyDraftId: SEED12_REPLY_DRAFT_ID,
    signalId: SEED12_SIGNAL_ID,
  }
}

// ─── Cleanup helpers ──────────────────────────────────────────────────────────

// Cleanup must run in reverse FK order: faq_extractions → reply_drafts → signals → faqs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function cleanupSeeds(supabase: any, seeded: SeededRows): Promise<void> {
  if (seeded.extractionId) {
    await supabase.from('faq_extractions').delete().eq('id', seeded.extractionId)
    console.log(`  [CLEANUP] Deleted faq_extraction ${seeded.extractionId}`)
  }
  if (seeded.replyDraftId) {
    await supabase.from('reply_drafts').delete().eq('id', seeded.replyDraftId)
    console.log(`  [CLEANUP] Deleted reply_draft ${seeded.replyDraftId}`)
  }
  if (seeded.signalId) {
    await supabase.from('signals').delete().eq('id', seeded.signalId)
    console.log(`  [CLEANUP] Deleted signal ${seeded.signalId}`)
  }
  if (seeded.faqId) {
    await supabase.from('faqs').delete().eq('id', seeded.faqId)
    console.log(`  [CLEANUP] Deleted FAQ ${seeded.faqId}`)
  }
}

// ─── Main runner ──────────────────────────────────────────────────────────────

async function main() {
  const supabase = getDevClient()

  const fixtureDir = join(process.cwd(), 'tests', 'fixtures', 'faq-extraction')
  const allFiles = await readdir(fixtureDir)
  const fixtureFiles = allFiles
    .filter(f => f.match(/^\d{2}_.*\.json$/) && !f.startsWith('_'))
    .sort()

  console.log('\nFAQ Extractor Test Harness')
  console.log(`Loading ${fixtureFiles.length} fixtures from ${fixtureDir}`)
  console.log('='.repeat(60) + '\n')

  let succeeded = 0
  let failed = 0

  for (const file of fixtureFiles) {
    const fixtureNum = basename(file, '.json').slice(0, 2)
    const fixturePath = join(fixtureDir, file)
    const raw = await readFile(fixturePath, 'utf-8')
    let fixture: FixtureJson

    try {
      fixture = JSON.parse(raw)
    } catch {
      console.log(`FIXTURE: ${file}`)
      console.log(`  ERROR: Could not parse fixture JSON`)
      failed++
      console.log('='.repeat(60) + '\n')
      continue
    }

    console.log('='.repeat(60))
    console.log(`FIXTURE: ${file}`)
    console.log(`EXPECTED: ${fixture.expected_behaviour}`)
    console.log()

    // Seed prerequisite rows for fixtures that need them
    const seeded: SeededRows = {}

    if (fixtureNum === '02') {
      const faqId = await seedFaqForFixture02(supabase, fixture.organisationId)
      if (faqId) seeded.faqId = faqId
    }

    if (fixtureNum === '12') {
      const seedResult = await seedPendingExtractionForFixture12(supabase, fixture.organisationId)
      if (seedResult) Object.assign(seeded, seedResult)
    }

    // Build input (omit supabase — injected here)
    const input: FaqExtractionInput = {
      organisationId: fixture.organisationId,
      organisationName: fixture.organisationName,
      replyDraftId: fixture.replyDraftId,
      prospectQuestionContext: fixture.prospectQuestionContext,
      originalOutboundBody: fixture.originalOutboundBody,
      operatorAnswer: fixture.operatorAnswer,
      aiDraftBody: fixture.aiDraftBody,
      orgPositioningDocument: fixture.orgPositioningDocument,
      supabase,
    }

    let results
    try {
      results = await extractFaq(input)
      succeeded++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  THREW: ${msg}`)
      failed++
      await cleanupSeeds(supabase, seeded)
      console.log('='.repeat(60) + '\n')
      continue
    }

    // Print results
    console.log(`ACTUAL OUTPUT:`)
    console.log(`  extraction_count: ${results.length}`)

    if (results.length === 0) {
      console.log('  (empty — gate skipped or agent returned no extractions)')
    }

    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      console.log(`\n  Extraction ${i + 1}:`)
      console.log(`    extracted_question: ${r.extracted_question}`)
      console.log(`    captured_answer:    ${r.captured_answer}`)
      console.log(`    similar_faq_id:     ${r.similar_faq_id ?? 'null'}`)
      console.log(`    similar_pending:    ${r.similar_pending_extraction_id ?? 'null'}`)
      console.log(`    similarity_score:   ${r.similarity_score ?? 'null'}`)
      console.log(`    names_flagged:      ${r.potential_names_flagged.length > 0 ? r.potential_names_flagged.join(', ') : '(none)'}`)
    }

    // Cleanup seeded rows
    await cleanupSeeds(supabase, seeded)

    console.log('='.repeat(60) + '\n')
  }

  // Summary
  console.log(`Results: ${succeeded} fixtures completed (returned a result), ${failed} threw`)
  if (failed > 0) {
    console.log('Review THREW lines above — these indicate a code error, not a quality issue.')
  }
  console.log('\nQuality review: read each ACTUAL OUTPUT against its EXPECTED line.')
  console.log('Doug judges quality — this harness does not auto-pass/fail on content.')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Harness crashed:', err)
  process.exit(1)
})
