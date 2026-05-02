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
  const { data, error } = await supabase
    .from('faqs')
    .insert({
      organisation_id: organisationId,
      question_canonical: 'Do you work with solo consultants?',
      question_variants: ['Do you work with solo operators?', 'Is this for individual consultants?'],
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

// Fixture 12: seeds a pending faq_extractions row.
// faq_extractions requires FKs to signals and reply_drafts — this may fail in dev
// if no real signal/draft rows exist. Harness handles gracefully.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedPendingExtractionForFixture12(supabase: any, organisationId: string): Promise<SeededRows | null> {
  // Find any existing signal for this org to satisfy the FK constraint
  const { data: signals, error: sigErr } = await supabase
    .from('signals')
    .select('id')
    .eq('organisation_id', organisationId)
    .limit(1)

  if (sigErr || !signals || signals.length === 0) {
    console.warn('  [SEED WARNING] No signals found for fixture 12 seeding — similar_pending_extraction_id will be null')
    return null
  }

  // Find any existing reply_draft for this org
  const { data: drafts, error: draftErr } = await supabase
    .from('reply_drafts')
    .select('id')
    .eq('organisation_id', organisationId)
    .limit(1)

  if (draftErr || !drafts || drafts.length === 0) {
    console.warn('  [SEED WARNING] No reply_drafts found for fixture 12 seeding — similar_pending_extraction_id will be null')
    return null
  }

  const { data, error } = await supabase
    .from('faq_extractions')
    .insert({
      organisation_id: organisationId,
      signal_id: signals[0].id,
      reply_draft_id: drafts[0].id,
      extracted_question: 'Do you work with solo consultants?',
      suggested_answer: 'Yes, we work with solo consultants and small teams.',
      status: 'pending',
    })
    .select('id')
    .single()

  if (error) {
    console.warn(`  [SEED WARNING] Could not seed pending extraction for fixture 12: ${error.message}`)
    return null
  }

  console.log(`  [SEED] Inserted pending faq_extraction ${data.id} for fixture 12`)
  return { extractionId: data.id }
}

// ─── Cleanup helpers ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function cleanupSeeds(supabase: any, seeded: SeededRows): Promise<void> {
  if (seeded.extractionId) {
    await supabase.from('faq_extractions').delete().eq('id', seeded.extractionId)
    console.log(`  [CLEANUP] Deleted faq_extraction ${seeded.extractionId}`)
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
