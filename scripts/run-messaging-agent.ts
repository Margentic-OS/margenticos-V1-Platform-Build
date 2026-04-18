// One-off script to trigger the messaging generation agent directly.
// Run from project root: node_modules/.bin/jiti scripts/run-messaging-agent.ts
// Uses service role key — bypasses RLS, operator-level access only.

import * as fs from 'fs'
import * as path from 'path'

// Load .env.local before any other imports that need env vars.
const envPath = path.join(process.cwd(), '.env.local')
const envContent = fs.readFileSync(envPath, 'utf-8')
for (const line of envContent.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eqIdx = trimmed.indexOf('=')
  if (eqIdx === -1) continue
  const key = trimmed.slice(0, eqIdx).trim()
  const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
  if (!process.env[key]) process.env[key] = val
}

import { createClient } from '@supabase/supabase-js'
import { runMessagingGenerationAgent } from '../src/agents/messaging-generation-agent'

const ORG_ID = '74243c62-f42d-4f3f-b93e-bd5e51f0b6c0'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function main() {
  console.log('Running messaging agent for MargenticOS...\n')

  const result = await runMessagingGenerationAgent({
    organisation_id: ORG_ID,
    supabase,
  })

  console.log('Agent complete. Suggestion ID:', result.suggestion_id)
  console.log('Fetching suggestion content...\n')

  const { data, error } = await supabase
    .from('document_suggestions')
    .select('id, suggested_value, suggestion_reason, created_at')
    .eq('id', result.suggestion_id)
    .single()

  if (error || !data) {
    console.error('Could not fetch suggestion:', error?.message)
    return
  }

  const parsed = JSON.parse(data.suggested_value as string)
  const emails: Array<{
    sequence_position: number
    subject_line: string | null
    subject_char_count: number
    body: string
    word_count: number
  }> = parsed.emails ?? []

  console.log('='.repeat(60))
  emails.forEach(email => {
    console.log(`\nEMAIL ${email.sequence_position}`)
    console.log('-'.repeat(40))
    if (email.subject_line) {
      console.log(`Subject: "${email.subject_line}" (${email.subject_char_count} chars)`)
    } else {
      console.log(`Subject: null (threads under Email 1 in Instantly)`)
    }
    console.log(`Word count: ${email.word_count}`)
    console.log(`\nBody:\n${email.body}`)
  })

  console.log('\n' + '='.repeat(60))
  console.log('\nSuggestion reason:\n', data.suggestion_reason)
  console.log('\nSuggestion ID for approval:', result.suggestion_id)
}

main().catch(err => {
  console.error('Script failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
