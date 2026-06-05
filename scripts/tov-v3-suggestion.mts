/**
 * One-shot: construct TOV v3 pending suggestion from v2 content with two surgical edits,
 * run through deterministic gates, write to document_suggestions.
 *
 * Edits:
 *   1. before_after_examples[1].after — remove "revenue rollercoaster", keep "most consultants I talk to"
 *   2. voice_style_note — one informative line, no process commentary
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load env before any dynamic imports that reference process.env
const envFile = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8')
for (const line of envFile.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eq = trimmed.indexOf('=')
  if (eq === -1) continue
  const key = trimmed.slice(0, eq).trim()
  const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
  if (!(key in process.env)) process.env[key] = val
}

const { createClient } = await import('@supabase/supabase-js')
const { scrubAITellsDeepExcluding, assertNoDashesExcluding } = await import(
  '../src/lib/style/customer-facing-style-rules'
)

const ORG_ID  = '74243c62-f42d-4f3f-b93e-bd5e51f0b6c0'
const V2_DOC  = '04521064-1180-46bb-8cc4-94086faa6398'

// Same verbatim fields as the TOV agent — these pass through gates unchanged.
const TOV_VERBATIM_FIELDS: ReadonlySet<string> = new Set([
  'evidence',
  'words_they_use',
  'dominant_sentence_length',
  'fragment_usage',
  'punctuation_patterns',
  'opening_move_pattern',
])

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── 1. Fetch v2 content ────────────────────────────────────────────────────────
const { data: doc, error: fetchErr } = await supabase
  .from('strategy_documents')
  .select('content')
  .eq('id', V2_DOC)
  .single()

if (fetchErr || !doc) {
  throw new Error(`Failed to fetch v2 doc: ${fetchErr?.message}`)
}

const content = structuredClone(doc.content) as Record<string, unknown>

// ── 2. Edit 1 — before_after_examples[1].after ────────────────────────────────
// Remove "revenue rollercoaster". Keep "Most consultants I talk to."
// Replace the opening hook sentence with an equivalent that names the same
// LinkedIn post signal without the banned cliche.
const examples = content.before_after_examples as Array<Record<string, string>>
const ex2 = examples[1]
ex2.after = ex2.after.replace(
  'Your post about the revenue rollercoaster hit close to home.',
  'Your post about the referral ceiling hit close to home.'
)

// ── 3. Edit 2 — voice_style_note ──────────────────────────────────────────────
// One informative line; no process commentary about extraction or confidence.
content.voice_style_note =
  'Voice extracted from writing samples and intake responses; no self-described style was provided.'

// ── 4. Deterministic gates ────────────────────────────────────────────────────
const scrubbed = scrubAITellsDeepExcluding(content, 'tov-v3-suggestion', TOV_VERBATIM_FIELDS)
assertNoDashesExcluding(scrubbed, 'tov-v3-suggestion', TOV_VERBATIM_FIELDS)

// ── 5. Write pending suggestion ───────────────────────────────────────────────
const { data: suggestion, error: insertErr } = await supabase
  .from('document_suggestions')
  .insert({
    organisation_id: ORG_ID,
    document_type: 'tov',
    field_path: 'full_document',
    segment_id: null,
    suggested_value: JSON.stringify(scrubbed),
    status: 'pending',
    confidence_level: 'high',
    signal_count: 0,
    suggestion_reason:
      'Two targeted edits to v2 content: (1) Example 2 opener — "revenue rollercoaster" ' +
      'replaced with "referral ceiling" (newly banned phrase, Rule 5); ' +
      '(2) voice_style_note reduced to one informative line with no process commentary.',
  })
  .select('id')
  .single()

if (insertErr || !suggestion) {
  throw new Error(`Failed to insert suggestion: ${insertErr?.message}`)
}

console.log('Suggestion written:', suggestion.id)
console.log('Edited fields:')
console.log('  before_after_examples[1].after:', (scrubbed as typeof content).before_after_examples[1].after)
console.log('  voice_style_note:', (scrubbed as typeof content).voice_style_note)
