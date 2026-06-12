// src/lib/sourcing/test-dedupe.ts
//
// Demonstration script for dedupe.ts verdict engine.
// Run against DRY RUN TEST organisation to verify each verdict type fires correctly.
//
// Usage: npx tsx src/lib/sourcing/test-dedupe.ts
//
// This script:
// 1. Seeds test rows (clearly marked) into the DRY RUN TEST org
// 2. Runs checkCandidates() with candidate data designed to trigger each verdict
// 3. Verifies verdicts match expectations
// 4. Logs results without deleting test rows (marked for cleanup post-test)

import { randomUUID } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { Database } from '@/types/database'
import { checkCandidates } from './dedupe'
import { normaliseLinkedInUrl } from './normalise-linkedin'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const DRY_RUN_ORG_ID = 'dry-run-test-org-id'

function genUUID(): string {
  return randomUUID()
}

const supabase = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY)

async function seedTestRows(): Promise<void> {
  console.log('Seeding test rows into DRY RUN TEST organisation...')

  // Get or create DRY RUN TEST organisation
  const { data: orgs, error: orgError } = await supabase
    .from('organisations')
    .select('id')
    .eq('slug', 'dry-run-test')
    .limit(1)

  if (orgError) {
    console.error('Failed to fetch organisations:', orgError.message)
    return
  }

  const orgId = orgs?.[0]?.id || DRY_RUN_ORG_ID

  // Seed test prospects with different scenarios
  const testProspects: Array<{
    id: string
    organisation_id: string
    source_person_key: string
    email?: string | null
    linkedin_url?: string | null
    suppressed: boolean
    suppression_reason?: string | null
  }> = [
    {
      id: genUUID(),
      organisation_id: orgId,
      source_person_key: 'apollo:suppressed-person-123',
      email: 'suppressed-person@example.com',
      linkedin_url: 'https://linkedin.com/in/suppressed-person',
      suppressed: true,
      suppression_reason: 'dedupe-test: suppressed for person_key match testing',
    },
    {
      id: genUUID(),
      organisation_id: orgId,
      source_person_key: 'apollo:different-person',
      email: 'different-person@example.com',
      linkedin_url: 'https://linkedin.com/in/suppressed-linkedin',
      suppressed: true,
      suppression_reason: 'dedupe-test: suppressed for linkedin match testing',
    },
    {
      id: genUUID(),
      organisation_id: orgId,
      source_person_key: 'apollo:third-person',
      email: 'suppressed-email@example.com',
      linkedin_url: 'https://linkedin.com/in/third-person',
      suppressed: true,
      suppression_reason: 'dedupe-test: suppressed for email match testing',
    },
    {
      id: genUUID(),
      organisation_id: orgId,
      source_person_key: 'apollo:duplicate-person-456',
      email: 'duplicate-person@example.com',
      linkedin_url: 'https://linkedin.com/in/duplicate-person',
      suppressed: false,
    },
    {
      id: genUUID(),
      organisation_id: orgId,
      source_person_key: 'apollo:new-person-789',
      email: 'newperson@example.com',
      linkedin_url: 'https://linkedin.com/in/duplicate-linkedin',
      suppressed: false,
    },
    {
      id: genUUID(),
      organisation_id: orgId,
      source_person_key: 'apollo:email-person-101',
      email: 'duplicate-email@example.com',
      linkedin_url: 'https://linkedin.com/in/email-person',
      suppressed: false,
    },
  ]

  for (const prospect of testProspects) {
    const { error } = await supabase
      .from('prospects')
      .insert([{
        id: prospect.id,
        organisation_id: prospect.organisation_id,
        source_person_key: prospect.source_person_key,
        email: prospect.email ?? null,
        linkedin_url: prospect.linkedin_url ?? null,
        linkedin_url_normalised: normaliseLinkedInUrl(prospect.linkedin_url ?? null),
        suppressed: prospect.suppressed,
        suppression_reason: prospect.suppression_reason ?? null,
      }])
    if (error && !error.message.includes('duplicate')) {
      console.error(`Failed to seed ${prospect.id}:`, error.message)
    } else {
      console.log(`Seeded: ${prospect.id}`)
    }
  }
}

async function runDedupTest(): Promise<void> {
  console.log('\nRunning dedupe test...\n')

  // Get organisation ID
  const { data: orgs } = await supabase
    .from('organisations')
    .select('id')
    .eq('slug', 'dry-run-test')
    .limit(1)

  const orgId = orgs?.[0]?.id || DRY_RUN_ORG_ID

  // Test candidates designed to trigger each verdict type
  const candidates = [
    {
      source_person_key: 'apollo:suppressed-person-123',
      email: 'suppressed-person@example.com',
      linkedin_url: 'https://linkedin.com/in/suppressed-person',
    },
    {
      source_person_key: 'apollo:suppressed-linkedin-match',
      email: 'different-email@example.com',
      linkedin_url: 'https://linkedin.com/in/suppressed-linkedin',
    },
    {
      source_person_key: 'apollo:suppressed-email-match',
      email: 'suppressed-email@example.com',
      linkedin_url: 'https://linkedin.com/in/different-person',
    },
    {
      source_person_key: 'apollo:duplicate-person-456',
      email: 'different-dup-email@example.com',
      linkedin_url: 'https://linkedin.com/in/different-person-456',
    },
    {
      source_person_key: 'apollo:dup-linkedin-new-key',
      email: 'newperson2@example.com',
      linkedin_url: 'https://linkedin.com/in/duplicate-linkedin',
    },
    {
      source_person_key: 'apollo:dup-email-new-key',
      email: 'duplicate-email@example.com',
      linkedin_url: 'https://linkedin.com/in/email-person-new',
    },
    {
      source_person_key: 'apollo:completely-new-person',
      email: 'brandnew@example.com',
      linkedin_url: 'https://linkedin.com/in/brandnew',
    },
  ]

  const verdicts = await checkCandidates(supabase, orgId, candidates)

  console.log('Dedup Test Results:')
  console.log('===================\n')

  const expectedVerdicts = [
    ['apollo:suppressed-person-123', 'suppressed_match'],
    ['apollo:suppressed-linkedin-match', 'suppressed_match'],
    ['apollo:suppressed-email-match', 'suppressed_match'],
    ['apollo:duplicate-person-456', 'duplicate_person_key'],
    ['apollo:dup-linkedin-new-key', 'duplicate_linkedin'],
    ['apollo:dup-email-new-key', 'duplicate_email'],
    ['apollo:completely-new-person', 'new'],
  ]

  let passed = 0
  let failed = 0

  for (const [key, expectedVerdict] of expectedVerdicts) {
    const actualVerdict = verdicts.get(key)
    const status = actualVerdict === expectedVerdict ? 'PASS' : 'FAIL'
    const symbol = status === 'PASS' ? '✓' : '✗'

    if (status === 'PASS') passed++
    else failed++

    console.log(`${symbol} ${key}`)
    console.log(`  Expected: ${expectedVerdict}`)
    console.log(`  Actual:   ${actualVerdict}\n`)
  }

  console.log(`Summary: ${passed} passed, ${failed} failed`)

  if (failed === 0) {
    console.log('\nAll dedupe verdicts fired correctly!')
  } else {
    console.log('\nSome tests failed. Check the output above.')
    process.exit(1)
  }
}

async function main(): Promise<void> {
  try {
    await seedTestRows()
    await runDedupTest()
  } catch (err) {
    console.error('Test error:', err)
    process.exit(1)
  }
}

main()
