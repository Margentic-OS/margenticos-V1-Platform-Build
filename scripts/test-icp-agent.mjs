// test-icp-agent.mjs
// End-to-end pipeline test for all four document generation agents.
// Run with: node scripts/test-icp-agent.mjs
//
// Sequence:
//   1. ICP          — intake + web research → document_suggestions
//   2. Positioning  — intake + ICP + web research → document_suggestions  } parallel
//      TOV          — intake + voice_samples/voice_style → document_suggestions }
//   3. Messaging    — intake + ICP + Positioning + TOV → document_suggestions
//
// Each agent's suggestion is read back from document_suggestions after writing
// and passed forward to the next agent. This mirrors the full approval pipeline
// without requiring manual dashboard approval between steps.

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ── Env ──────────────────────────────────────────────────────────────────────
function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env.local'), 'utf-8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    process.env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
}
loadEnv()

const SUPABASE_URL    = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY
const ORGANISATION_ID = '74243c62-f42d-4f3f-b93e-bd5e51f0b6c0'
const OPUS_MODEL      = 'claude-opus-4-6'
const HAIKU_MODEL     = 'claude-haiku-4-5-20251001'

if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) {
  console.error('Missing required env vars. Check .env.local.')
  process.exit(1)
}

const supabase  = createClient(SUPABASE_URL, SERVICE_KEY)
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY })

// ── Helpers ───────────────────────────────────────────────────────────────────

function header(title) {
  const line = '═'.repeat(80)
  console.log(`\n${line}`)
  console.log(`  ${title}`)
  console.log(line)
}

function subheader(title) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  ${title}`)
  console.log('─'.repeat(60))
}

function elapsed(ms) {
  return ms < 60000
    ? `${(ms / 1000).toFixed(1)}s`
    : `${(ms / 60000).toFixed(1)}m`
}

function wordCount(text) {
  return text?.split(/\s+/).filter(w => w.length > 0).length ?? 0
}

function stripFences(text) {
  return text
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()
}

function loadPrompt(filename) {
  const raw = readFileSync(join(ROOT, 'docs', 'prompts', filename), 'utf-8')
  const marker = '## System Prompt'
  const idx = raw.indexOf(marker)
  if (idx === -1) throw new Error(`Could not find "## System Prompt" in ${filename}`)
  return raw.slice(idx + marker.length).trim()
}

async function callClaude(systemPrompt, userMessage, label) {
  process.stdout.write(`  Calling ${OPUS_MODEL} for ${label}...`)
  const start = Date.now()
  const msg = await anthropic.messages.create({
    model: OPUS_MODEL,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  })
  const ms = Date.now() - start
  process.stdout.write(` ${elapsed(ms)} | stop: ${msg.stop_reason}\n`)
  const text = msg.content.find(b => b.type === 'text')?.text?.trim() ?? ''
  return stripFences(text)
}

async function runWebSearch(query) {
  try {
    const res = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 512,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Research this topic and return only factual findings as 4–6 concise bullet points. Focus on what is verifiable and specific. Do not editorialize.\n\nTopic: ${query}`,
      }],
    })
    const text = res.content.find(b => b.type === 'text')?.text?.trim() ?? ''
    const limited = text.split('\n').filter(l => l.trim()).length < 2
    return { query, synthesis: text, limited }
  } catch (err) {
    console.warn(`  ⚠ Search failed for "${query.slice(0, 60)}...": ${err.message}`)
    return { query, synthesis: '', limited: true }
  }
}

async function runResearchQueries(queries, label) {
  process.stdout.write(`  Running ${queries.length} ${label} research queries...\n`)
  const start = Date.now()
  const results = await Promise.all(queries.map(async (q, i) => {
    process.stdout.write(`    [${i + 1}/${queries.length}] ${q.slice(0, 65)}...`)
    const r = await runWebSearch(q)
    process.stdout.write(r.limited ? ' ⚠ limited\n' : ' ✓\n')
    return r
  }))
  console.log(`  Research done in ${elapsed(Date.now() - start)}`)
  return results
}

function formatResearchBlock(results) {
  const useful = results.filter(r => !r.limited && r.synthesis.trim())
  if (useful.length === 0) {
    return '## WEB RESEARCH\n\nNo usable results. Base analysis on intake data and framework logic.'
  }
  return '## WEB RESEARCH (current market intelligence)\n\n' +
    useful.map(r => `### ${r.query}\n\n${r.synthesis}`).join('\n\n')
}

function buildIntakeSections(intake, excludeKeys = []) {
  const bySec = intake.reduce((acc, row) => {
    if (excludeKeys.includes(row.field_key)) return acc
    if (!acc[row.section]) acc[row.section] = []
    acc[row.section].push(row)
    return acc
  }, {})
  return Object.entries(bySec)
    .map(([section, rows]) => {
      const lines = rows.map(r => {
        const v    = r.response_value?.trim() || '[not answered]'
        const flag = r.is_critical && !r.response_value?.trim() ? ' ⚠️ CRITICAL — NOT ANSWERED' : ''
        return `  Q: ${r.field_label}${flag}\n  A: ${v}`
      }).join('\n\n')
      return `### ${section}\n\n${lines}`
    })
    .join('\n\n---\n\n')
}

async function writeSuggestion(fields) {
  const { data, error } = await supabase
    .from('document_suggestions')
    .insert(fields)
    .select('id')
    .single()
  if (error) throw new Error(`Failed to write ${fields.document_type} suggestion: ${error.message}`)
  return data.id
}

function printDocumentOutput(label, parsed, suggestionId) {
  subheader(`${label} — Suggestion ID: ${suggestionId}`)
  console.log(JSON.stringify(parsed, null, 2))
}

function confirmWrite(label, id) {
  console.log(`  ✓ ${label} written to document_suggestions — ID: ${id}`)
}

// ── Shared: fetch intake ──────────────────────────────────────────────────────

header('STEP 0 — FETCH INTAKE')

const { data: intake, error: intakeError } = await supabase
  .from('intake_responses')
  .select('field_key, field_label, response_value, section, is_critical')
  .eq('organisation_id', ORGANISATION_ID)
  .order('section')

if (intakeError) { console.error('Intake fetch failed:', intakeError.message); process.exit(1) }

const criticalFields = intake.filter(r => r.is_critical)
const answeredCritical = criticalFields.filter(r => r.response_value?.trim())
const completeness = Math.round((answeredCritical.length / criticalFields.length) * 100)

function intakeVal(key) {
  return intake.find(r => r.field_key === key)?.response_value?.trim() ?? ''
}

const currency = intakeVal('company_currency')
const geoHint  = currency === 'GBP' ? 'UK' : currency === 'EUR' ? 'Europe' : currency === 'USD' ? 'US' : 'English-speaking markets'

console.log(`Fetched ${intake.length} intake fields | Completeness: ${completeness}% (${answeredCritical.length}/${criticalFields.length} critical)`)
console.log(`Organisation: ${ORGANISATION_ID} | Geo hint: ${geoHint}`)

// ══════════════════════════════════════════════════════════════════════════════
// STEP 1 — ICP AGENT
// ══════════════════════════════════════════════════════════════════════════════

header('STEP 1 — ICP AGENT (intake + web research → document_suggestions)')

// ICP research queries — buyer pain, trigger events, buyer profile, competitors
const icpQueries = [
  `B2B consulting firm founder pipeline challenges feast famine revenue plateau ${geoHint} 2025`,
  `founder-led consulting referral dependency ceiling growth trigger events outbound investment`,
  `solo micro team B2B consultant annual revenue range ${geoHint} professional services market 2024 2025`,
  `cold email outbound lead generation service for consultants competitors positioning ${geoHint} 2025`,
]

const icpResearch = await runResearchQueries(icpQueries, 'ICP')
const icpResearchBlock = formatResearchBlock(icpResearch)
const icpResearchLimitedNote = icpResearch.some(r => r.limited)
  ? ` ⚠️ Research: limited results for ${icpResearch.filter(r => r.limited).length}/${icpQueries.length} queries.`
  : ` Web research: all ${icpQueries.length} queries succeeded.`

const icpIntakeSections = buildIntakeSections(intake)

const icpSystemPrompt = loadPrompt('icp-agent.md')

const icpUserMessage = `You are generating an ICP document for a founder-led B2B consulting firm.

## INTAKE QUESTIONNAIRE RESPONSES

${icpIntakeSections}

---

${icpResearchBlock}

RESEARCH WEIGHTING RULE: Use research to validate, enrich, and sharpen the language in the ICP. If research findings conflict with intake data, do NOT silently override intake. Use intake as primary and note any conflict.

---

## CROSS-CLIENT PATTERNS

No pattern data available yet (phase one). Base your analysis entirely on the intake data and research above.

---

Using the frameworks and rules in your system prompt, produce the ICP document now.
Return raw JSON only. No preamble, no explanation, no markdown fencing.`

const icpRaw = await callClaude(icpSystemPrompt, icpUserMessage, 'ICP generation')

let icpParsed
try {
  icpParsed = JSON.parse(icpRaw)
  console.log('  JSON valid ✓')
} catch (e) {
  console.error('  ICP returned invalid JSON:', e.message)
  console.error(icpRaw.slice(0, 500))
  process.exit(1)
}

const icpSuggestionReason =
  `ICP document generated by test script using ${OPUS_MODEL}. ` +
  `Initial generation. Intake completeness: ${completeness}%.` +
  icpResearchLimitedNote

const icpSuggestionId = await writeSuggestion({
  organisation_id:   ORGANISATION_ID,
  document_id:       null,
  document_type:     'icp',
  field_path:        'full_document',
  current_value:     null,
  suggested_value:   icpRaw,
  suggestion_reason: icpSuggestionReason,
  confidence_level:  completeness >= 80 ? 'high' : 'low',
  signal_count:      0,
  status:            'pending',
})

confirmWrite('ICP', icpSuggestionId)

// ══════════════════════════════════════════════════════════════════════════════
// STEP 2 — POSITIONING + TOV (parallel)
// ══════════════════════════════════════════════════════════════════════════════

header('STEP 2 — POSITIONING + TOV (parallel)')

// ── 2a: Positioning research queries — competitor-focused ─────────────────────

const posQueries = [
  `outbound lead generation agency consulting firms positioning messaging claims ${geoHint} 2025`,
  `founder-led consulting firm pipeline outbound "looking for" OR "need help with" search terms 2025`,
  `outbound agency consulting clients case study results testimonial "pipeline" OR "meetings" ${geoHint} 2025`,
  `outbound agency consulting "didn't work" OR "failed" OR "disappointed" OR "frustration" review complaints 2025`,
]

// ── 2b: TOV — extract voice_samples and voice_style from intake ───────────────

const voiceSamples = intakeVal('voice_samples')
const voiceStyle   = intakeVal('voice_style')

const sampleWordCount = wordCount(voiceSamples)
const samplesEmpty    = sampleWordCount === 0
const samplesThin     = !samplesEmpty && sampleWordCount < 100

// Heuristic contradiction check (mirrors tov-generation-agent.ts logic)
let apparentContradiction = false
if (!samplesEmpty && voiceStyle.length > 0) {
  const styleLower   = voiceStyle.toLowerCase()
  const samplesLower = voiceSamples.toLowerCase()
  const sentences    = voiceSamples.split(/[.!?]+/).filter(s => s.trim().length > 5)
  const avgSentLen   = sentences.length > 0 ? wordCount(voiceSamples) / sentences.length : 0
  const jargonTerms  = ['leverage', 'synergy', 'scalable', 'robust', 'seamless', 'holistic', 'ecosystem']
  if (
    ((styleLower.includes('direct') || styleLower.includes('concise')) && avgSentLen > 25) ||
    (styleLower.includes('no jargon') && jargonTerms.some(t => samplesLower.includes(t))) ||
    ((styleLower.includes('warm') || styleLower.includes('friendly')) &&
      (samplesLower.includes('dear ') || samplesLower.includes('kind regards')))
  ) {
    apparentContradiction = true
  }
}

console.log(`  voice_samples: ${samplesEmpty ? '⚠ EMPTY' : samplesThin ? `⚠ thin (${sampleWordCount} words)` : `${sampleWordCount} words ✓`}`)
console.log(`  voice_style:   ${voiceStyle.length > 0 ? `"${voiceStyle.slice(0, 60)}..."` : '⚠ not provided'}`)
if (apparentContradiction) console.log('  ⚠ Apparent contradiction detected between voice_style and samples')

// Run positioning research and both Claude calls in parallel
console.log('\n  Running Positioning research + both Claude calls in parallel...')

const posSystemPrompt  = loadPrompt('positioning-agent.md')
const tovSystemPrompt  = loadPrompt('tov-agent.md')
const icpDocContent    = icpRaw  // the ICP suggestion content from Step 1

const posIntakeSections = buildIntakeSections(intake)

const posResearchPromise = runResearchQueries(posQueries, 'Positioning')

// Build TOV user message (no research — uses samples only)
const tovIntakeSections = buildIntakeSections(intake, ['voice_samples', 'voice_style'])

const sampleStatus = samplesEmpty
  ? '⚠️ NO SAMPLES PROVIDED — generate from voice_style and intake preferences only. Mark confidence as low.'
  : samplesThin
    ? `⚠️ THIN SAMPLES (${sampleWordCount} words) — extract what you can. Note the limitation. Mark confidence as low.`
    : `${sampleWordCount} words across samples — full extraction is possible.`

const voiceSamplesBlock = samplesEmpty
  ? `## WRITING SAMPLES (primary extraction source)\n\n${sampleStatus}\n\n[No samples provided]`
  : `## WRITING SAMPLES (primary extraction source)\n\n${sampleStatus}\n\n${voiceSamples}`

const contradictionHint = apparentContradiction
  ? '\n\n⚠️ PRE-CHECK: A surface-level scan suggests the self-description may not match the samples. Look carefully and surface any contradiction in voice_style_note.'
  : ''

const voiceStyleBlock = voiceStyle.length > 0
  ? `## FOUNDER'S SELF-DESCRIPTION OF VOICE (voice_style — secondary, cross-reference only)\n\n` +
    'This is how the founder describes their style. Cross-reference against samples. If they contradict, samples win.' +
    contradictionHint + `\n\n${voiceStyle}`
  : `## FOUNDER'S SELF-DESCRIPTION OF VOICE (voice_style)\n\n[Not provided — base guide entirely on writing samples.]`

const tovUserMessage = `You are generating a Tone of Voice guide for a founder-led B2B consulting firm.

## INTAKE QUESTIONNAIRE RESPONSES (excluding voice fields — those are below)

${tovIntakeSections}

---

${voiceSamplesBlock}

---

${voiceStyleBlock}

---

## CROSS-CLIENT PATTERNS

No pattern data available yet (phase one).

---

Using the frameworks and rules in your system prompt, produce the Tone of Voice guide now.
voice_samples is your primary source. voice_style is a secondary cross-reference only.
The five mandatory corrections apply always: no I/We opener, one question max, no feature listing before relevance, no service-led language, first touch under 100 words.
Return raw JSON only. No preamble, no explanation, no markdown fencing.`

// Run TOV Claude call immediately (no research to wait for)
const tovClaudePromise = callClaude(tovSystemPrompt, tovUserMessage, 'TOV generation')

// Wait for positioning research, then run positioning Claude call
const posResearch = await posResearchPromise
const posResearchBlock = formatResearchBlock(posResearch)
const posResearchLimitedNote = posResearch.some(r => r.limited)
  ? ` ⚠️ Research: limited results for ${posResearch.filter(r => r.limited).length}/${posQueries.length} queries.`
  : ` Web research: all ${posQueries.length} queries succeeded.`

const posUserMessage = `You are generating a Positioning document for a founder-led B2B consulting firm.

## INTAKE QUESTIONNAIRE RESPONSES

${posIntakeSections}

---

${posResearchBlock}

RESEARCH WEIGHTING RULE: Use competitor research to sharpen unique_attributes and competitive_landscape. If research conflicts with intake or ICP, use intake and ICP as primary and note the conflict.

---

## ICP DOCUMENT (PRIMARY ANCHOR)

This is the approved ICP document. It is the primary source of truth for buyer language, four_forces, and best-fit characteristics. Do not contradict it.

${icpDocContent}

---

## CROSS-CLIENT PATTERNS

No pattern data available yet (phase one).

---

Using the frameworks and rules in your system prompt, produce the Positioning document now.
The ICP document above is your primary anchor — every element must be consistent with the buyer described in ICP Tier 1.
Return raw JSON only. No preamble, no explanation, no markdown fencing.`

const posClaudePromise = callClaude(posSystemPrompt, posUserMessage, 'Positioning generation')

// Await both Claude calls
const [posRaw, tovRaw] = await Promise.all([posClaudePromise, tovClaudePromise])

// Validate positioning JSON
let posParsed
try {
  posParsed = JSON.parse(posRaw)
  console.log('  Positioning JSON valid ✓')
} catch (e) {
  console.error('  Positioning returned invalid JSON:', e.message)
  console.error(posRaw.slice(0, 500))
  process.exit(1)
}

// Validate TOV JSON
let tovParsed
try {
  tovParsed = JSON.parse(tovRaw)
  console.log('  TOV JSON valid ✓')
} catch (e) {
  console.error('  TOV returned invalid JSON:', e.message)
  console.error(tovRaw.slice(0, 500))
  process.exit(1)
}

// Write both suggestions
const posSuggestionReason =
  `Positioning document generated by test script using ${OPUS_MODEL}. ` +
  `Initial generation. ICP v(test) used as primary anchor. Intake completeness: ${completeness}%.` +
  posResearchLimitedNote

const tovConfidence = samplesEmpty || samplesThin || completeness < 80 ? 'low' : 'high'
const tovSampleNote = samplesEmpty
  ? ' ⚠️ No writing samples provided — generated from self-description only.'
  : samplesThin
    ? ` ⚠️ Thin samples (${sampleWordCount} words).`
    : ` Writing samples: ${sampleWordCount} words.`
const tovContradictionNote = apparentContradiction
  ? ' ⚠️ Potential contradiction between voice_style and samples — check voice_style_note.'
  : ''

const tovSuggestionReason =
  `TOV guide generated by test script using ${OPUS_MODEL}. ` +
  `Initial generation. Intake completeness: ${completeness}%.` +
  tovSampleNote +
  tovContradictionNote

const [posSuggestionId, tovSuggestionId] = await Promise.all([
  writeSuggestion({
    organisation_id:   ORGANISATION_ID,
    document_id:       null,
    document_type:     'positioning',
    field_path:        'full_document',
    current_value:     null,
    suggested_value:   posRaw,
    suggestion_reason: posSuggestionReason,
    confidence_level:  completeness >= 80 ? 'high' : 'low',
    signal_count:      0,
    status:            'pending',
  }),
  writeSuggestion({
    organisation_id:   ORGANISATION_ID,
    document_id:       null,
    document_type:     'tov',
    field_path:        'full_document',
    current_value:     null,
    suggested_value:   tovRaw,
    suggestion_reason: tovSuggestionReason,
    confidence_level:  tovConfidence,
    signal_count:      0,
    status:            'pending',
  }),
])

confirmWrite('Positioning', posSuggestionId)
confirmWrite('TOV', tovSuggestionId)

// ══════════════════════════════════════════════════════════════════════════════
// STEP 3 — MESSAGING AGENT
// ══════════════════════════════════════════════════════════════════════════════

header('STEP 3 — MESSAGING AGENT (intake + ICP + Positioning + TOV → document_suggestions)')

const msgSystemPrompt   = loadPrompt('messaging-agent.md')
const msgIntakeSections = buildIntakeSections(intake)

const msgUserMessage = `You are generating a Messaging Playbook for a founder-led B2B consulting firm.

The three strategy documents below are your primary context. Do not invent details not present in them.

## INTAKE QUESTIONNAIRE RESPONSES

${msgIntakeSections}

---

## ICP DOCUMENT (version test)

Use this to understand who the playbook is written for. ICP Tier 1 defines the hero.
Their four_forces are the emotional raw material for opening lines and subject lines.
Their triggers are the situations that make Email 1 land. Their switching_costs inform objection handling.

${icpRaw}

---

## POSITIONING DOCUMENT (version test)

Use this for the core_message, value_themes, and key_messages.
The moore_statement is the spine. The competitive_alternatives inform cost-of-inaction framing.
The white_space from competitive_landscape is what differentiates this firm in copy.

${posRaw}

---

## TONE OF VOICE GUIDE (version test)

Every word of copy must pass through this filter.
Use vocabulary.words_they_use directly. Apply vocabulary.structural_patterns to every email.
The writing_rules section contains the five mandatory corrections — all apply here.
The before_after_examples show the register. The do_dont_list is a copy checklist.

${tovRaw}

---

## CROSS-CLIENT PATTERNS

No pattern data available yet (phase one).

---

Using the frameworks and rules in your system prompt, produce the Messaging Playbook now.

Critical reminders:
- Write the core_message first — every piece of copy must trace back to it
- Email 1 is where 58% of replies come from — quality here is everything
- Word counts are hard caps: Email 1 ≤100 words, Email 2 ≤75, Email 3 ≤65, Email 4 ≤50
- Count every word. Include the accurate word_count in each email object.
- Every message must pass the TOV writing_rules — apply them before returning
- No I/We openers. One question per message. No service-led language.

Return raw JSON only. No preamble, no explanation, no markdown fencing.`

const msgRaw = await callClaude(msgSystemPrompt, msgUserMessage, 'Messaging generation')

let msgParsed
try {
  msgParsed = JSON.parse(msgRaw)
  console.log('  Messaging JSON valid ✓')
} catch (e) {
  console.error('  Messaging returned invalid JSON:', e.message)
  console.error(msgRaw.slice(0, 500))
  process.exit(1)
}

const msgSuggestionReason =
  `Messaging Playbook generated by test script using ${OPUS_MODEL}. ` +
  `Initial generation. Intake completeness: ${completeness}%. ` +
  `Source documents used: ICP v(test), Positioning v(test), TOV v(test).`

const msgSuggestionId = await writeSuggestion({
  organisation_id:   ORGANISATION_ID,
  document_id:       null,
  document_type:     'messaging',
  field_path:        'full_document',
  current_value:     null,
  suggested_value:   msgRaw,
  suggestion_reason: msgSuggestionReason,
  confidence_level:  completeness >= 80 ? 'high' : 'low',
  signal_count:      0,
  status:            'pending',
})

confirmWrite('Messaging', msgSuggestionId)

// ══════════════════════════════════════════════════════════════════════════════
// DATABASE CONFIRMATION
// ══════════════════════════════════════════════════════════════════════════════

header('DATABASE CONFIRMATION — document_suggestions')

const { data: written, error: readError } = await supabase
  .from('document_suggestions')
  .select('id, document_type, confidence_level, status, suggestion_reason, created_at')
  .in('id', [icpSuggestionId, posSuggestionId, tovSuggestionId, msgSuggestionId])
  .order('created_at')

if (readError) {
  console.error('Could not read back suggestions:', readError.message)
} else {
  for (const row of written) {
    console.log(`\n  ${row.document_type.toUpperCase()} — ${row.id}`)
    console.log(`    status:     ${row.status}`)
    console.log(`    confidence: ${row.confidence_level}`)
    console.log(`    reason:     ${row.suggestion_reason}`)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FULL DOCUMENT OUTPUT
// ══════════════════════════════════════════════════════════════════════════════

header('FULL OUTPUT — ALL FOUR DOCUMENTS')

printDocumentOutput('ICP DOCUMENT', icpParsed, icpSuggestionId)
printDocumentOutput('POSITIONING DOCUMENT', posParsed, posSuggestionId)
printDocumentOutput('TONE OF VOICE GUIDE', tovParsed, tovSuggestionId)

// Messaging: also show email word count compliance summary
subheader(`MESSAGING PLAYBOOK — Suggestion ID: ${msgSuggestionId}`)
console.log(JSON.stringify(msgParsed, null, 2))

// Email word count compliance check.
// Handles both array format (emails: [...]) and object format (email_1: {...})
// since Claude may return either structure.
const seq = msgParsed?.cold_email_sequence
if (seq) {
  subheader('EMAIL SEQUENCE — WORD COUNT COMPLIANCE')
  // Normalise to array regardless of shape
  const emailEntries = Array.isArray(seq.emails)
    ? seq.emails.map((e, i) => ({ num: e.email_number ?? i + 1, day: e.send_day ?? e.day ?? '?', entry: e }))
    : [1, 2, 3, 4]
        .filter(n => seq[`email_${n}`])
        .map(n => ({ num: n, day: seq[`email_${n}`].day ?? '?', entry: seq[`email_${n}`] }))

  const limits = { 1: 100, 2: 75, 3: 65, 4: 50 }

  for (const { num, day, entry } of emailEntries) {
    const limit = limits[num] ?? '?'
    // word_count may live at the top level or nested inside template/worked_example
    const count =
      entry.word_count
      ?? entry.template?.word_count
      ?? wordCount(entry.body ?? entry.template?.body ?? '')
    const pass = typeof limit === 'number' ? count <= limit : true
    console.log(`  Email ${num} (Day ${day}): ${count} words / limit ${limit} — ${pass ? '✓ PASS' : '✗ FAIL — EXCEEDS LIMIT'}`)
  }
}

header('PIPELINE COMPLETE')
console.log(`  All four documents generated and written to document_suggestions.`)
console.log(`  ICP:         ${icpSuggestionId}`)
console.log(`  Positioning: ${posSuggestionId}`)
console.log(`  TOV:         ${tovSuggestionId}`)
console.log(`  Messaging:   ${msgSuggestionId}`)
console.log()
