// Dry-run composition test for Anya Dayson against the v6 messaging document.
// Verifies the new B1 paragraph 2 reads coherently after trigger replaces paragraph 1.
// Run with: npx tsx --env-file=.env.local src/lib/composition/test-anya-compose.ts
// Delete after test passes.

import { composeSequence } from './compose-sequence'

const PROSPECT_ID = '0e62da2b-d274-4951-ae3f-6864d94a397d' // Anya Dayson, Ascend Strategic Marketing
const CLIENT_ID   = '74243c62-f42d-4f3f-b93e-bd5e51f0b6c0' // MargenticOS client zero

async function main() {
  console.log('\nComposing Email 1 for Anya Dayson (Ascend Strategic Marketing)')
  console.log('Variant B — bridge path (has_dateable_signal=true, signal_relevance=use_as_hook)\n')

  const result = await composeSequence({ prospect_id: PROSPECT_ID, client_id: CLIENT_ID })

  const email1 = result.emails.find(e => e.sequence_position === 1)
  if (!email1) {
    console.error('No Email 1 in composed sequence.')
    process.exit(1)
  }

  console.log('=== ASSEMBLED EMAIL 1 ===\n')
  console.log(email1.body)
  console.log(`\nWord count: ${email1.word_count}`)
  console.log(`Subject: ${email1.subject_line ?? '(null)'}`)
}

main().catch(err => {
  console.error('\nComposition failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
