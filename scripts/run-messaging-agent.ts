// One-off script to trigger the messaging generation agent directly.
// Run from project root: node scripts/run-messaging-agent.js
// Uses service role key — bypasses RLS, operator-level access only.

import * as fs from 'fs'
import * as path from 'path'

// Load .env.local before any other imports that need env vars.
// Must happen before importing the agent (which reads ANTHROPIC_API_KEY at call time)
// and before creating the Supabase client.
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
import { runMessagingGenerationAgent, MessagingAgentResult } from '../src/agents/messaging-generation-agent'

const ORG_ID = '74243c62-f42d-4f3f-b93e-bd5e51f0b6c0'
const TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

// ─── Timeout helper ───────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let id: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    id = setTimeout(
      () => reject(new Error(`TIMEOUT: API call did not respond within ${ms / 1000 / 60} minutes`)),
      ms
    )
  })
  return Promise.race([promise, timeout]).then(
    val => { clearTimeout(id); return val as T },
    err => { clearTimeout(id); throw err }
  )
}

// ─── Plain-English error diagnosis ───────────────────────────────────────────

function diagnose(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)

  console.error('\n' + '!'.repeat(60))
  console.error('AGENT FAILED')
  console.error('!'.repeat(60))

  if (msg.includes('credit balance is too low') || msg.includes('insufficient')) {
    console.error('\nWhat went wrong:')
    console.error('  Your Anthropic account has run out of credits.')
    console.error('\nHow to fix it:')
    console.error('  1. Go to console.anthropic.com')
    console.error('  2. Click Plans & Billing in the left sidebar')
    console.error('  3. Add credits or upgrade your plan')
    console.error('  4. Come back and run: node scripts/run-messaging-agent.js')
  } else if (msg.includes('TIMEOUT')) {
    console.error('\nWhat went wrong:')
    console.error('  The Anthropic API did not respond within 5 minutes.')
    console.error('  This usually means the API is under heavy load right now.')
    console.error('\nHow to fix it:')
    console.error('  Wait 2–3 minutes then run the script again.')
    console.error('  If it keeps timing out, check status.anthropic.com for outages.')
  } else if (msg.includes('ANTHROPIC_API_KEY')) {
    console.error('\nWhat went wrong:')
    console.error('  ANTHROPIC_API_KEY is missing from .env.local.')
    console.error('\nHow to fix it:')
    console.error('  1. Open .env.local in the project root')
    console.error('  2. Add: ANTHROPIC_API_KEY=your-key-here')
    console.error('  3. Get your key from console.anthropic.com → API Keys')
  } else if (msg.includes('required documents') || msg.includes('has status "') || msg.includes('documents need attention')) {
    console.error('\nWhat went wrong:')
    console.error('  One or more strategy documents (ICP, Positioning, TOV) are not approved.')
    console.error('\nHow to fix it:')
    console.error('  Go to the dashboard → Strategy and approve any documents showing "In review".')
    console.error('  All three must be active before the messaging agent can run.')
    console.error('\nDetail:', msg)
  } else if (msg.includes('required fields are missing')) {
    console.error('\nWhat went wrong:')
    console.error('  The agent cannot generate emails because key fields are missing.')
    console.error('\nDetail:')
    console.error(' ', msg.replace('Messaging agent: cannot generate emails — ', ''))
  } else if (msg.includes('rate_limit') || msg.includes('rate limit')) {
    console.error('\nWhat went wrong:')
    console.error('  The Anthropic API rate limit was hit.')
    console.error('\nHow to fix it:')
    console.error('  Wait 60 seconds, then run the script again.')
  } else {
    console.error('\nWhat went wrong:')
    console.error(' ', msg)
    console.error('\nIf you are unsure what caused this, check the terminal where next dev is')
    console.error('running — the logger writes more detail there.')
  }

  console.error('\n' + '!'.repeat(60) + '\n')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = new Date()

  console.log('')
  console.log('================================================')
  console.log('  MargenticOS — Messaging Generation Agent')
  console.log('================================================')
  console.log(`  Org:     MargenticOS`)
  console.log(`  Model:   claude-opus-4-6`)
  console.log(`  Started: ${startedAt.toLocaleTimeString()}`)
  console.log(`  Timeout: 5 minutes (retries once if hit)`)
  console.log('================================================')
  console.log('')

  // ── Stage 1: connect ────────────────────────────────────────────────────────
  console.log('[1/4] Connecting to Supabase...')
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  console.log('      Done.\n')

  // ── Stage 2: run agent ──────────────────────────────────────────────────────
  console.log('[2/4] Running agent...')
  console.log('      Fetching intake responses and strategy documents from database.')
  console.log('      Then calling claude-opus-4-6 to generate the 4-email sequence.')
  console.log('      A heartbeat shows every 20 seconds while the API call is in flight.\n')

  const heartbeatStart = Date.now()
  const heartbeat = setInterval(() => {
    const secs = Math.round((Date.now() - heartbeatStart) / 1000)
    const mins = Math.floor(secs / 60)
    const rem = secs % 60
    const elapsed = mins > 0 ? `${mins}m ${rem}s` : `${secs}s`
    console.log(`      ... still running (${elapsed} elapsed)`)
  }, 20_000)

  let result: MessagingAgentResult
  try {
    result = await withTimeout(
      runMessagingGenerationAgent({ organisation_id: ORG_ID, supabase }),
      TIMEOUT_MS
    )
  } catch (firstErr) {
    const msg = firstErr instanceof Error ? firstErr.message : String(firstErr)

    if (msg.startsWith('TIMEOUT')) {
      console.log('\n      Timed out after 5 minutes. Waiting 30 seconds before retry...')
      await new Promise(r => setTimeout(r, 30_000))
      console.log('      Retrying now...\n')
      try {
        result = await withTimeout(
          runMessagingGenerationAgent({ organisation_id: ORG_ID, supabase }),
          TIMEOUT_MS
        )
      } catch (retryErr) {
        clearInterval(heartbeat)
        diagnose(retryErr)
        process.exit(1)
      }
    } else {
      clearInterval(heartbeat)
      diagnose(firstErr)
      process.exit(1)
    }
  } finally {
    clearInterval(heartbeat)
  }

  const elapsed = Math.round((Date.now() - heartbeatStart) / 1000)
  console.log(`\n      Agent completed in ${elapsed}s.`)
  console.log(`      Suggestion ID: ${result.suggestion_id}\n`)

  // ── Stage 3: fetch the written suggestion ───────────────────────────────────
  console.log('[3/4] Fetching suggestion from database...')
  const { data, error } = await supabase
    .from('document_suggestions')
    .select('id, suggested_value, suggestion_reason, created_at')
    .eq('id', result.suggestion_id)
    .single()

  if (error || !data) {
    console.error('      Could not fetch suggestion:', error?.message)
    process.exit(1)
  }
  console.log('      Done.\n')

  // ── Stage 4: display ────────────────────────────────────────────────────────
  console.log('[4/4] Email sequence output:\n')

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
    console.log(`\nEMAIL ${email.sequence_position}  (${email.word_count} words)`)
    console.log('-'.repeat(60))
    if (email.subject_line) {
      console.log(`Subject : "${email.subject_line}"`)
      console.log(`Chars   : ${email.subject_char_count}`)
    } else {
      console.log(`Subject : null — threads under Email 1 in Instantly`)
    }
    console.log(`\n${email.body}`)
  })

  console.log('\n' + '='.repeat(60))
  console.log('\nSuggestion metadata:')
  console.log(data.suggestion_reason)
  console.log('\n------------------------------------------------')
  console.log('To approve this suggestion, run:')
  console.log(`  curl -s -X POST http://localhost:3000/api/suggestions/${result.suggestion_id}/approve \\`)
  console.log('    -H "Cookie: <your-session-cookie>"')
  console.log('')
  console.log('Or go to the dashboard — the suggestion will appear under Messaging.')
  console.log('------------------------------------------------\n')
}

main().catch(err => {
  diagnose(err)
  process.exit(1)
})
