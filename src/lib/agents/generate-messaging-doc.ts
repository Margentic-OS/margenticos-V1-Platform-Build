// One-off generation harness for the Messaging Playbook.
//
// Mirrors what POST /api/suggestions/regenerate does when NO pending suggestion exists:
// that route sets is_refresh = !!suggestion_id, so with nothing to reject it generates
// fresh. This script does the same, minus the cookie-session auth the route requires.
//
// GENERATE ONLY. Writes a pending document_suggestions row. It does not approve, promote,
// compose, or upload.
//
// Run with: npx tsx --env-file=.env.local src/lib/agents/generate-messaging-doc.ts

import { createClient } from '@supabase/supabase-js'
import { runMessagingGenerationAgent } from '@/agents/messaging-generation-agent'

const ORG_ID = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing Supabase env vars')

  const supabase = createClient(url, key)

  // Guard: a pending row makes the insert hit the idempotency index, which returns the
  // OLD suggestion id while reporting success. Refuse to run rather than report a
  // generation that silently did nothing.
  const { data: pending } = await supabase
    .from('document_suggestions')
    .select('id, created_at')
    .eq('organisation_id', ORG_ID)
    .eq('document_type', 'messaging')
    .eq('status', 'pending')

  if (pending && pending.length > 0) {
    console.error(`ABORT: ${pending.length} pending messaging suggestion(s) already exist:`)
    pending.forEach(p => console.error(`  ${p.id} created ${p.created_at}`))
    console.error('Reject them first, or the run is a silent no-op.')
    process.exit(1)
  }
  console.log('Pre-flight: no pending messaging suggestion. Safe to generate.')

  const { data: before } = await supabase
    .from('document_suggestions')
    .select('id')
    .eq('organisation_id', ORG_ID)
    .eq('document_type', 'messaging')
  const beforeIds = new Set((before ?? []).map(r => r.id))
  console.log(`Pre-flight: ${beforeIds.size} existing messaging suggestion row(s).`)

  const startedAt = Date.now()
  const result = await runMessagingGenerationAgent({
    organisation_id: ORG_ID,
    supabase,
    is_refresh: false,
  })

  console.log('\n=== AGENT RESULT ===')
  console.log(JSON.stringify(result, null, 2))
  console.log(`Duration: ${Math.round((Date.now() - startedAt) / 1000)}s`)

  // The returned id must be one we have not seen before. If it is an id that already
  // existed, the idempotency index swallowed the write and this run produced nothing.
  if (beforeIds.has(result.suggestion_id)) {
    console.error(`\nFAIL: returned suggestion_id ${result.suggestion_id} ALREADY EXISTED before this run.`)
    console.error('The generation was a silent no-op.')
    process.exit(1)
  }
  console.log(`\nConfirmed NEW suggestion id: ${result.suggestion_id}`)
}

main().catch(err => {
  console.error('GENERATION FAILED:', err instanceof Error ? err.stack : String(err))
  process.exit(1)
})
