// Reply drafter test harness.
// Reads all 15 fixtures, calls draftReply() for each, prints output for human review.
// Run with: npm run test-drafter
//
// This is NOT a pass/fail test suite. It is a quality review tool.
// Doug reads the output and decides whether the prompt needs tuning.
// A null return means the agent returned null — check agent_runs for the error.

import { readdir, readFile } from 'fs/promises'
import { join, basename } from 'path'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { draftReply } from '../src/lib/agents/reply-draft-agent'
import { SHARED_ORG_CONTEXT } from '../tests/fixtures/reply-draft/_shared-org-context'
import type { ReplyDrafterInput } from '../src/lib/agents/reply-draft-agent'

// ─── Dev Supabase client ──────────────────────────────────────────────────────

function getDevClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.')
    console.error('Run this script from the project root after loading .env.local:')
    console.error('  npx dotenv -e .env.local npx tsx scripts/test-reply-drafter.ts')
    process.exit(1)
  }
  return createClient<Database>(url, key)
}

// ─── Fixture type ─────────────────────────────────────────────────────────────

interface FixtureJson {
  organisationId: string
  organisationName: string
  senderFirstName: string
  prospectReplyBody: string
  originalOutboundBody: string
  classification: {
    intent: string
    confidence: number
    reasoning: string
  }
  tierHint: 2 | 3
  faqMatches: Array<{
    faq_id: string
    question_canonical: string
    answer: string
    score: number
  }>
  includeCalendlyHint: boolean
  signalId: string
  prospectId: string | null
  expected_behaviour: string
}

// ─── Main runner ──────────────────────────────────────────────────────────────

async function main() {
  const supabase = getDevClient()

  const fixtureDir = join(process.cwd(), 'tests', 'fixtures', 'reply-draft')
  const allFiles = await readdir(fixtureDir)
  const fixtureFiles = allFiles
    .filter(f => f.match(/^\d{2}_.*\.json$/) && !f.startsWith('_'))
    .sort()

  console.log(`\nReply Drafter Test Harness`)
  console.log(`Loading ${fixtureFiles.length} fixtures from ${fixtureDir}`)
  console.log(`${'='.repeat(60)}\n`)

  let succeeded = 0
  let failed = 0

  for (const file of fixtureFiles) {
    const fixturePath = join(fixtureDir, file)
    const raw = await readFile(fixturePath, 'utf-8')
    let fixture: FixtureJson
    try {
      fixture = JSON.parse(raw)
    } catch (err) {
      console.error(`ERROR: Could not parse ${file} — ${String(err)}`)
      failed++
      continue
    }

    console.log(`${'='.repeat(60)}`)
    console.log(`FIXTURE: ${basename(file)}`)
    console.log(`EXPECTED: ${fixture.expected_behaviour}`)
    console.log()

    const input: ReplyDrafterInput = {
      organisationId: fixture.organisationId,
      organisationName: fixture.organisationName,
      senderFirstName: fixture.senderFirstName,
      prospectReplyBody: fixture.prospectReplyBody,
      originalOutboundBody: fixture.originalOutboundBody,
      classification: fixture.classification,
      tierHint: fixture.tierHint,
      orgContext: SHARED_ORG_CONTEXT,
      faqMatches: fixture.faqMatches,
      includeCalendlyHint: fixture.includeCalendlyHint,
      signalId: fixture.signalId,
      prospectId: fixture.prospectId,
      supabase,
    }

    let result: Awaited<ReturnType<typeof draftReply>>
    try {
      result = await draftReply(input)
    } catch (err) {
      console.log(`FAILED — threw unexpectedly: ${String(err)}`)
      failed++
      console.log()
      continue
    }

    if (result === null) {
      console.log(`FAILED — draftReply returned null (see agent_runs for error detail)`)
      failed++
    } else {
      console.log(`ACTUAL OUTPUT:`)
      console.log(`  tier: ${result.tier}`)
      console.log(`  draft_body:`)
      const indented = result.draft_body.split('\n').map(l => `    ${l}`).join('\n')
      console.log(indented)

      if (result.tier === 2) {
        console.log(`  faq_ids_used: ${result.faq_ids_used.join(', ') || '(none)'}`)
        console.log(`  confidence_at_draft: ${result.confidence_at_draft}`)
        console.log(`  prompt_version: ${result.prompt_version}`)
      } else {
        console.log(`  ambiguity_note: ${result.ambiguity_note}`)
        console.log(`  alternative_directions:`)
        for (const d of result.alternative_directions) {
          console.log(`    - ${d}`)
        }
        console.log(`  downgraded_from_tier: ${result.downgraded_from_tier}`)
        console.log(`  prompt_version: ${result.prompt_version}`)
      }
      succeeded++
    }

    console.log()
  }

  console.log('='.repeat(60))
  console.log(`SUMMARY: ${fixtureFiles.length} fixtures | ${succeeded} succeeded | ${failed} failed`)
  console.log('='.repeat(60))
  console.log()
  console.log('This is a quality review, not a pass/fail test.')
  console.log('Review the actual output above and decide if the prompt needs tuning.')

  process.exit(failed > 0 ? 1 : 0)
}

// Load .env.local if running directly (not in CI)
async function loadEnvLocal() {
  try {
    const envPath = join(process.cwd(), '.env.local')
    const content = await readFile(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Z_]+[A-Z0-9_]*)=(.*)$/)
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^"|"$/g, '').trim()
      }
    }
  } catch {
    // .env.local not found — assume env vars already set (CI/prod)
  }
}

loadEnvLocal().then(main).catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
