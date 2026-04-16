// test-icp-agent.mjs
// Standalone test script for the ICP generation agent.
// Run with: node scripts/test-icp-agent.mjs
//
// Reads .env.local directly so no dev server is needed.
// Calls Supabase and Anthropic directly — same logic as the agent, no TypeScript aliases.
// NOT committed as production code. For output quality verification only.

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ── Load .env.local ──────────────────────────────────────────────────────────
function loadEnv() {
  const envFile = join(ROOT, '.env.local')
  const lines = readFileSync(envFile, 'utf-8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim()
    if (val) process.env[key] = val
  }
}
loadEnv()

const SUPABASE_URL    = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY
const ORGANISATION_ID = '74243c62-f42d-4f3f-b93e-bd5e51f0b6c0'
const MODEL           = 'claude-opus-4-6'

if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) {
  console.error('Missing required env vars. Check .env.local.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY })

// ── Fetch intake responses ───────────────────────────────────────────────────
const { data: intake, error: intakeError } = await supabase
  .from('intake_responses')
  .select('field_key, field_label, response_value, section, is_critical')
  .eq('organisation_id', ORGANISATION_ID)
  .order('section')

if (intakeError) {
  console.error('Failed to fetch intake:', intakeError.message)
  process.exit(1)
}

console.log(`\nFetched ${intake.length} intake responses.`)

// Check completeness
const critical     = intake.filter(r => r.is_critical)
const answered     = critical.filter(r => r.response_value?.trim())
const completeness = Math.round((answered.length / critical.length) * 100)
console.log(`Completeness: ${completeness}% (${answered.length}/${critical.length} critical fields answered)\n`)

// ── Build prompt ─────────────────────────────────────────────────────────────
const bySec = intake.reduce((acc, row) => {
  if (!acc[row.section]) acc[row.section] = []
  acc[row.section].push(row)
  return acc
}, {})

const intakeSections = Object.entries(bySec)
  .map(([section, rows]) => {
    const lines = rows.map(r => {
      const val = r.response_value?.trim() ? r.response_value : '[not answered]'
      const flag = r.is_critical && !r.response_value?.trim() ? ' ⚠️ CRITICAL — NOT ANSWERED' : ''
      return `  Q: ${r.field_label}${flag}\n  A: ${val}`
    }).join('\n\n')
    return `### ${section}\n\n${lines}`
  })
  .join('\n\n---\n\n')

// Load system prompt from docs/prompts/icp-agent.md
const promptRaw = readFileSync(join(ROOT, 'docs', 'prompts', 'icp-agent.md'), 'utf-8')
const markerIdx = promptRaw.indexOf('## System Prompt')
const systemPrompt = promptRaw.slice(markerIdx + '## System Prompt'.length).trim()

const userMessage = `You are generating an ICP document for a founder-led B2B consulting firm.

## INTAKE QUESTIONNAIRE RESPONSES

${intakeSections}

---

## CROSS-CLIENT PATTERNS

No pattern data available yet (phase one). Base your analysis entirely on the intake data above.

---

Using the frameworks and rules in your system prompt, produce the ICP document now.
Return raw JSON only. No preamble, no explanation, no markdown fencing.`

// ── Call Claude ──────────────────────────────────────────────────────────────
console.log(`Calling ${MODEL}...`)
const startTime = Date.now()

const message = await anthropic.messages.create({
  model: MODEL,
  max_tokens: 8192,
  system: systemPrompt,
  messages: [{ role: 'user', content: userMessage }],
})

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
const rawFull = message.content.find(b => b.type === 'text')?.text.trim()
// Strip markdown fences — Claude sometimes wraps JSON in ```json ... ``` despite instructions
const rawContent = rawFull
  .replace(/^```(?:json)?\s*\n?/i, '')
  .replace(/\n?```\s*$/i, '')
  .trim()
console.log(`Claude responded in ${elapsed}s. Stop reason: ${message.stop_reason}\n`)

// ── Validate JSON ────────────────────────────────────────────────────────────
let parsed
try {
  parsed = JSON.parse(rawContent)
  console.log('JSON is valid. ✓\n')
} catch (e) {
  console.error('Claude returned invalid JSON:', e.message)
  console.error('Raw output:\n', rawContent)
  process.exit(1)
}

// ── Write to document_suggestions ───────────────────────────────────────────
const suggestionReason =
  `ICP document generated by test-icp-agent.mjs using ${MODEL}. ` +
  `Initial generation. Intake completeness: ${completeness}% (${answered.length}/${critical.length} critical fields).`

const { data: suggestion, error: writeError } = await supabase
  .from('document_suggestions')
  .insert({
    organisation_id:  ORGANISATION_ID,
    document_id:      null,
    document_type:    'icp',
    field_path:       'full_document',
    current_value:    null,
    suggested_value:  rawContent,
    suggestion_reason: suggestionReason,
    confidence_level: completeness >= 80 ? 'high' : 'low',
    signal_count:     0,
    status:           'pending',
  })
  .select('id')
  .single()

if (writeError) {
  console.error('Failed to write suggestion:', writeError.message)
  process.exit(1)
}

console.log(`Suggestion written. ID: ${suggestion.id}\n`)
console.log('═'.repeat(80))
console.log('FULL ICP DOCUMENT OUTPUT')
console.log('═'.repeat(80))
console.log(JSON.stringify(parsed, null, 2))
