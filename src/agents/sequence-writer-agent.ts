// SEQUENCE WRITER AGENT (writer v2). One model call writes a prospect's whole four-email
// sequence, as one conversation, from:
//   - every dated research candidate the prospect's research stored (src/lib/writer-v2/facts.ts),
//   - the firm fact (what the firm does, quoted from its website) or the stored industry,
//   - the client's playbook, read from the active messaging document (content.writer_playbook).
//
// Operator decision, 2026-10-03. Notion: "Writer v2: playbook format, MargenticOS playbook v1,
// writer instructions (prototype spec)". ADR-068.
//
// THREE TIERS, RECORDED ON EVERY SEQUENCE:
//   personalised        a qualifying research fact exists, and a sequence built on it passes.
//   semi_personalised   no research fact qualifies, or the personalised tier failed twice: the
//                       writer works from the firm fact (or only the industry label) instead.
//   template            last resort: neither tier passed, or there was nothing to write from.
//                       No model output ships; composition uses the client's approved template.
// Each tier gets ONE retry with its failures stated, then falls to the next.
//
// SHORTEN BEFORE RETRYING (operator, 2026-10-05). When an attempt fails ONLY because some emails
// are too long, just those emails go back to be cut (a small call, no playbook) and the whole
// output is checked again. If that passes, no rewrite is paid for. If not, the normal retry
// runs exactly as before. Any other failure goes straight to the normal retry.
//
// THE ONLY CHECKS are in src/lib/writer-v2/checks.ts. The old writing path's gates are not run.
//
// STATELESS. Everything is read per call and passed explicitly; client_id scopes every query.
// The one piece of cross-prospect context, which angles and questions the client's other
// recent sequences used, is read from those sequences each time (or passed in by a batch
// runner), never held in module state.
//
// MODEL: the production research writer's model (RESEARCH_SONNET_MODEL), no extended thinking,
// passed explicitly on every call. The operator's blind read found the strongest model at most
// marginally better at about five times the cost.

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { RESEARCH_SONNET_MODEL } from '@/lib/agents/research/cost-constants'
import { ZERO_TOKEN_USAGE, addTokenUsage, readTokenUsage, type ObservationCandidate, type TokenUsage } from '@/lib/agents/research/types'
import type { FirmFactRecord } from '@/lib/agents/research/firm-fact'
import { fetchApprovedMessagingDoc } from '@/lib/composition/compose-sequence'
import { companyShortName, firmTradeWords } from '@/lib/composition/company-short-name'
import { clientGenericWords, readBrief } from '@/lib/outbound-brief/brief'
import { peerKindRecordFromRow } from '@/lib/sourcing/peer-kind'
import { factsForProspect, hasQualifyingResearch, type WriterFact } from '@/lib/writer-v2/facts'
import { copiedPhrases, overLengthOnly, splitSentences, transformOutput, writerV2Failures, type Sender, type WriterOutput } from '@/lib/writer-v2/checks'
import { exampleSentences, playbookFromDocumentContent, type WriterPlaybook } from '@/lib/writer-v2/playbook'
import { emptyBatchMemory, WRITER_V2_SHORTEN_INSTRUCTIONS, writerV2ShortenMessage, writerV2System, writerV2UserMessage, type BatchMemory, type WriterTier } from '@/lib/writer-v2/prompt'
import type { WriterV2Attempt, WriterV2Record } from '@/lib/writer-v2/record'

export const WRITER_V2_MODEL = RESEARCH_SONNET_MODEL
const MAX_TOKENS = 8000
const SHORTEN_MAX_TOKENS = 2000

export type WriterV2UsagePath = 'cli' | 'inline' | 'queue' | 'collect'

export interface WriteSequenceInput {
  supabase: SupabaseClient
  anthropic: Anthropic
  client_id: string
  prospect_id: string
  usagePath: WriterV2UsagePath
  /** Write the record to the prospect. False for a trial: nothing on the prospect changes. */
  persist: boolean
  /** A trial only: a playbook from a file instead of the active messaging document. A record
   *  written from it says so, and composition never ships it. */
  playbookOverride?: WriterPlaybook
  /** A batch runner's in-process memory. When absent, read from the client's recent sequences. */
  memory?: BatchMemory
  today?: Date
}

export interface WriteSequenceResult {
  record: WriterV2Record
  /** Spend across every call this prospect made, recorded in research_usage. */
  usage: TokenUsage
  persisted: boolean
}

interface LoadedProspect {
  id: string
  firstName: string
  lastName: string | null
  role: string | null
  companyName: string | null
  shortName: string | null
  facts: WriterFact[]
  researchResultId: string | null
}

export async function writeSequenceForProspect(input: WriteSequenceInput): Promise<WriteSequenceResult> {
  const { supabase, anthropic, client_id, prospect_id } = input
  const today = input.today ?? new Date()

  const { data: org, error: orgError } = await supabase
    .from('organisations').select('name, founder_first_name').eq('id', client_id).single()
  if (orgError || !org?.name || !org.founder_first_name) {
    throw new Error(`sequence-writer: organisation ${client_id} needs a name and founder_first_name for the sign-off`)
  }
  const sender: Sender = { firstName: org.founder_first_name as string, company: org.name as string }

  const { data: row, error: rowError } = await supabase
    .from('prospects')
    .select('id, segment_id, first_name, last_name, job_title, role, company_name, company_industry, apollo_enrichment_data, firm_fact, current_research_result_id, outbound_upload_status')
    .eq('id', prospect_id).eq('organisation_id', client_id).single()
  if (rowError || !row) throw new Error(`sequence-writer: prospect ${prospect_id} not found for client ${client_id}`)

  const messaging = await fetchApprovedMessagingDoc(supabase as never, client_id, (row.segment_id as string | null) ?? null)
  let playbook: WriterPlaybook
  if (input.playbookOverride) {
    playbook = input.playbookOverride
  } else {
    const read = playbookFromDocumentContent(messaging.content)
    if (!read.playbook) throw new Error(`sequence-writer: ${read.problem}. Writer v2 needs an approved playbook in the messaging document.`)
    playbook = read.playbook
  }

  const prospect = await loadProspect(supabase, client_id, row as Record<string, unknown>, messaging.content, today)
  const memory = input.memory ?? await readBatchMemory(supabase, client_id)

  const attempts: WriterV2Attempt[] = []
  let usage: TokenUsage = ZERO_TOKEN_USAGE
  let passed: { tier: WriterTier; output: WriterOutput } | null = null

  const research = prospect.facts.filter(f => f.kind === 'research' && !f.ineligible)
  const standing = prospect.facts.find(f => f.kind !== 'research') ?? null
  const ladder: Array<{ tier: WriterTier; offered: WriterFact[] }> = []
  if (hasQualifyingResearch(prospect.facts)) ladder.push({ tier: 'personalised', offered: [...research, ...(standing ? [standing] : [])] })
  if (standing) ladder.push({ tier: 'semi_personalised', offered: [standing] })

  for (const step of ladder) {
    const leftOut = prospect.facts.length - step.offered.length
    const outcome = await writeTier(anthropic, playbook, sender, prospect, step.tier, step.offered, leftOut, memory, today)
    attempts.push(...outcome.attempts)
    usage = outcome.attempts.reduce((u, a) => addTokenUsage(u, a.usage), usage)
    if (outcome.passed) { passed = { tier: step.tier, output: outcome.passed }; break }
  }

  const record: WriterV2Record = {
    record_version: 1,
    written_at: new Date().toISOString(),
    model: WRITER_V2_MODEL,
    tier: passed ? recordedTier(passed.tier, passed.output, prospect.facts) : 'template',
    emails: passed ? [...passed.output.emails].sort((a, b) => a.email - b.email).map(e => ({ position: e.email, subject: e.email === 1 ? e.subject : null, body: e.body })) : null,
    fact_used: passed ? passed.output.fact_used : null,
    link_sentence: passed ? passed.output.link_sentence : null,
    angles: passed ? [...passed.output.angles].sort((a, b) => a.email - b.email) : [],
    attempts,
    copied_phrases: passed ? copiedPhrases(passed.output, exampleSentences(playbook)) : [],
    playbook_version: playbook.version,
    playbook_source: input.playbookOverride ? 'file' : 'document',
    messaging_doc_id: input.playbookOverride ? null : messaging.doc_id,
    research_result_id: prospect.researchResultId,
  }

  if (passed) rememberSequence(memory, record)
  // Shorten calls are their own ledger row (arm 'writer_v2_shorten'), so what shortening costs
  // can be read on its own. Both rows are priced the same way and both count in run spend.
  const sumOf = (kind: 'write' | 'shorten') => attempts.filter(a => (a.kind ?? 'write') === kind).reduce((u, a) => addTokenUsage(u, a.usage), ZERO_TOKEN_USAGE)
  const writeUsage = sumOf('write')
  const shortenUsage = sumOf('shorten')
  if (writeUsage.calls > 0) await recordWriterUsage(supabase, client_id, prospect_id, writeUsage, input.usagePath, record, 'writer_v2')
  if (shortenUsage.calls > 0) await recordWriterUsage(supabase, client_id, prospect_id, shortenUsage, input.usagePath, record, 'writer_v2_shorten')

  let persisted = false
  if (input.persist) {
    // Only while the prospect is waiting to upload. A sequence already handed to the sending
    // tool is a record of what was sent, and rewriting it would make that record false.
    const { data: written, error } = await supabase
      .from('prospects')
      .update({ writer_v2_sequence: record })
      .eq('id', prospect_id).eq('organisation_id', client_id).eq('outbound_upload_status', 'pending')
      .select('id')
    if (error) throw new Error(`sequence-writer: could not store the sequence for ${prospect_id}: ${error.message}`)
    persisted = (written ?? []).length > 0
    if (!persisted) logger.warn('sequence-writer: prospect is no longer pending; sequence not stored', { prospect_id })
  }

  logger.info('sequence-writer: written', {
    prospect_id, client_id, tier: record.tier, calls: usage.calls,
    failed_attempts: attempts.filter(a => a.failures.length > 0).length,
    shorten_calls: attempts.filter(a => a.kind === 'shorten').length,
  })
  return { record, usage, persisted }
}

// ─── One tier: a call, the checks, one retry with the failures stated ─────────

async function writeTier(
  anthropic: Anthropic, playbook: WriterPlaybook, sender: Sender, p: LoadedProspect,
  tier: WriterTier, offered: WriterFact[], leftOut: number, memory: BatchMemory, today: Date,
): Promise<{ attempts: WriterV2Attempt[]; passed: WriterOutput | null }> {
  // The instructions and the playbook are identical for every prospect of this client, so the
  // system prompt carries a cache breakpoint and later prospects read it from cache.
  const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: writerV2System(playbook), cache_control: { type: 'ephemeral' } }]
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: writerV2UserMessage(p, tier, offered, leftOut, memory, today) }]
  const attempts: WriterV2Attempt[] = []

  for (let i = 0; i < 2; i++) {
    const res = await anthropic.messages.create({ model: WRITER_V2_MODEL, max_tokens: MAX_TOKENS, system, messages })
    const usage = readTokenUsage(res.usage)
    // A truncated or refused answer is a failure, never a sequence (ADR-059).
    if (res.stop_reason === 'max_tokens' || res.stop_reason === 'refusal') {
      attempts.push({ tier, failures: [`the model stopped: ${res.stop_reason}`], usage, stop_reason: res.stop_reason, kind: 'write' })
      continue
    }
    const raw = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('')
    const parsed = parseWriterOutput(raw)
    const output = parsed ? transformOutput(parsed) : null
    const failures = output
      ? writerV2Failures({ output, offered, prospect: p, sender, playbook })
      : ['the output was not a JSON object in the shape asked for']
    attempts.push({ tier, failures, usage, stop_reason: res.stop_reason, kind: 'write' })
    if (failures.length === 0 && output) return { attempts, passed: output }
    const over = output ? overLengthOnly(output, failures, sender) : null
    if (output && over) {
      const shortened = await shortenOverLength(anthropic, output, over, tier, offered, p, sender, playbook)
      attempts.push(shortened.attempt)
      if (shortened.passed) return { attempts, passed: shortened.passed }
    }
    if (i === 0) {
      messages.push({ role: 'assistant', content: raw || '(no text)' })
      messages.push({ role: 'user', content: `Your sequence failed these checks:\n- ${failures.join('\n- ')}\n\nRewrite the whole sequence so every check passes, keeping what was good. Return the same JSON shape.` })
    }
  }
  return { attempts, passed: null }
}

/**
 * ONE SHORTEN CALL: only the over-length emails, each with the declared sentences it must keep
 * word for word, so the declarations still match the body. The result replaces just those
 * emails and the WHOLE output is checked again, with every check, so a cut that changed a
 * claim, dropped the question's email below its floor, or added anything is caught the same
 * way as in a full write. A malformed or truncated answer is a failed attempt, never a pass.
 */
async function shortenOverLength(
  anthropic: Anthropic, output: WriterOutput, over: Array<{ email: number; words: number; max: number }>, tier: WriterTier,
  offered: WriterFact[], p: LoadedProspect, sender: Sender, playbook: WriterPlaybook,
): Promise<{ attempt: WriterV2Attempt; passed: WriterOutput | null }> {
  const declared = (n: number) => [...(output.prospect_claims ?? []), ...(output.sender_claims ?? [])].filter(c => c.email === n).map(c => c.sentence)
  const asked = over.map(o => ({ ...o, body: output.emails.find(e => e.email === o.email)?.body ?? '', keep: declared(o.email) }))
  const res = await anthropic.messages.create({
    model: WRITER_V2_MODEL, max_tokens: SHORTEN_MAX_TOKENS,
    system: WRITER_V2_SHORTEN_INSTRUCTIONS,
    messages: [{ role: 'user', content: writerV2ShortenMessage(asked) }],
  })
  const usage = readTokenUsage(res.usage)
  const fail = (failures: string[], shortened?: WriterV2Attempt['shortened']) => ({ attempt: { tier, failures, usage, stop_reason: res.stop_reason, kind: 'shorten' as const, ...(shortened ? { shortened } : {}) }, passed: null })
  if (res.stop_reason === 'max_tokens' || res.stop_reason === 'refusal') return fail([`the shortening call stopped: ${res.stop_reason}`])
  const raw = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('')
  const returned = parseShortened(raw)
  if (!returned || asked.some(a => typeof returned.get(a.email) !== 'string')) return fail(['the shortened answer was not in the shape asked for'])
  const merged = transformOutput({ ...output, emails: output.emails.map(e => (returned.has(e.email) && asked.some(a => a.email === e.email) ? { ...e, body: returned.get(e.email)! } : e)) })
  const shortened = asked.map(a => ({ email: a.email, before: a.body, after: merged.emails.find(e => e.email === a.email)!.body }))
  const failures = writerV2Failures({ output: merged, offered, prospect: p, sender, playbook })
  if (failures.length > 0) return fail(failures, shortened)
  return { attempt: { tier, failures: [], usage, stop_reason: res.stop_reason, kind: 'shorten', shortened }, passed: merged }
}

export function parseShortened(text: string): Map<number, string> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { emails?: Array<{ email?: unknown; body?: unknown }> }
    if (!Array.isArray(parsed.emails)) return null
    const out = new Map<number, string>()
    for (const e of parsed.emails) if (typeof e?.email === 'number' && typeof e.body === 'string' && e.body.trim()) out.set(e.email, e.body)
    return out
  } catch {
    return null
  }
}

/**
 * THE TIER FOLLOWS THE FACT THE SEQUENCE ACTUALLY OPENS ON, not the step it passed in. The
 * personalised step offers research facts AND the standing description, and the writer may
 * choose the standing one; a sequence that does is semi-personalised, whatever step wrote it.
 * Found on the first 20-prospect run (2026-10-03): one sequence opened on the industry label
 * and was recorded as personalised.
 */
export function recordedTier(step: WriterTier, output: WriterOutput, facts: WriterFact[]): WriterTier {
  if (step !== 'personalised') return step
  const used = facts.find(f => f.id === output.fact_used?.fact_id)
  return used?.kind === 'research' ? 'personalised' : 'semi_personalised'
}

export function parseWriterOutput(text: string): WriterOutput | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const out = JSON.parse(text.slice(start, end + 1)) as WriterOutput
    if (!Array.isArray(out.emails)) return null
    return { ...out, prospect_claims: out.prospect_claims ?? [], sender_claims: out.sender_claims ?? [], angles: out.angles ?? [] }
  } catch {
    return null
  }
}

// ─── Inputs ───────────────────────────────────────────────────────────────────

async function loadProspect(supabase: SupabaseClient, client_id: string, r: Record<string, unknown>, messagingContent: unknown, today: Date): Promise<LoadedProspect> {
  const researchResultId = (r.current_research_result_id as string | null) ?? null
  let candidates: ObservationCandidate[] = []
  if (researchResultId) {
    const { data: result, error } = await supabase
      .from('prospect_research_results').select('candidates')
      .eq('id', researchResultId).eq('organisation_id', client_id).maybeSingle()
    if (error) throw new Error(`sequence-writer: could not read research for ${r.id as string}: ${error.message}`)
    candidates = ((result?.candidates ?? []) as ObservationCandidate[])
  }
  const brief = readBrief(messagingContent).brief
  const genericWords = brief ? clientGenericWords(brief) : new Set<string>()
  const record = peerKindRecordFromRow({ company_name: r.company_name as string | null, company_industry: r.company_industry as string | null, enrichment: r.apollo_enrichment_data })
  return {
    id: r.id as string,
    firstName: (r.first_name as string | null) ?? 'there',
    lastName: r.last_name as string | null,
    role: (r.job_title as string | null) ?? (r.role as string | null),
    companyName: r.company_name as string | null,
    shortName: companyShortName(r.company_name as string | null, genericWords, { firstName: r.first_name as string | null, lastName: r.last_name as string | null }, firmTradeWords(record?.industry, record?.tags)),
    facts: factsForProspect(candidates, (r.firm_fact as FirmFactRecord | null) ?? null, (r.company_industry as string | null) ?? null, today),
    researchResultId,
  }
}

// ─── Cross-prospect memory ────────────────────────────────────────────────────

const MEMORY_SIZE = 12

/** What the client's most recent written sequences used, read fresh each time. */
export async function readBatchMemory(supabase: SupabaseClient, client_id: string): Promise<BatchMemory> {
  const { data, error } = await supabase
    .from('prospects').select('writer_v2_sequence')
    .eq('organisation_id', client_id).not('writer_v2_sequence', 'is', null)
    .order('updated_at', { ascending: false }).limit(MEMORY_SIZE)
  const memory = emptyBatchMemory()
  if (error) { logger.warn('sequence-writer: could not read recent sequences; writing without them', { client_id, error: error.message }); return memory }
  for (const r of [...(data ?? [])].reverse()) rememberSequence(memory, r.writer_v2_sequence as WriterV2Record)
  return memory
}

export function rememberSequence(memory: BatchMemory, record: WriterV2Record): void {
  if (!record?.emails) return
  const angle = (n: number) => record.angles.find(a => a.email === n)?.angle
  const a2 = angle(2), a3 = angle(3)
  if (a2 && a3) memory.followUpAnglePairs.push([a2, a3])
  for (const e of record.emails) {
    const q = splitSentences(e.body).filter(s => s.endsWith('?')).pop()
    if (q) memory.questions.push(q)
  }
}

// ─── The spend ledger ─────────────────────────────────────────────────────────

/**
 * One research_usage row per prospect written, arm 'writer_v2', and a second, arm
 * 'writer_v2_shorten', when any shorten call was made. The writer's tokens go in the
 * opening column, which researchUsageRowUsd prices at the research writer's rate: the same
 * model, so run spend counts this row with no change to the reader. Every other stage is zero
 * by construction, as on a firm-fact row. Does not throw: the money is already spent, and a
 * lost ledger row is logged with the prospect so it can be rebuilt from the stored attempts.
 */
async function recordWriterUsage(supabase: SupabaseClient, client_id: string, prospect_id: string, usage: TokenUsage, path: WriterV2UsagePath, record: WriterV2Record, arm: 'writer_v2' | 'writer_v2_shorten'): Promise<void> {
  const { error } = await supabase.from('research_usage').insert({
    organisation_id: client_id,
    prospect_id,
    research_result_id: null,
    arm,
    path,
    synthesis: ZERO_TOKEN_USAGE,
    opening: usage,
    followups: null,
    web_search: { input_tokens: 0, output_tokens: 0, model: null, search_count: 0 },
    synthesis_batched: false,
  })
  if (error) logger.error('sequence-writer: FAILED TO RECORD what this prospect cost', { prospect_id, arm, tier: record.tier, calls: usage.calls, error: error.message })
}

// ─── After research ───────────────────────────────────────────────────────────

/**
 * The client's writer v2 switch. A read that fails is logged and reads as OFF, deliberately:
 * off means the old writer runs and its copy is stored as it always was, and with the switch
 * actually on, upload then holds the prospect for want of a writer v2 sequence. Reading a
 * failure as ON would skip the old writer AND write nothing, which loses the copy outright.
 */
export async function readWriterV2Enabled(supabase: SupabaseClient, client_id: string): Promise<boolean> {
  const { data, error } = await supabase.from('organisations').select('sequence_writer_v2_enabled').eq('id', client_id).single()
  if (error || !data) {
    logger.error('sequence-writer: could not read the writer v2 switch; the old writer runs for this prospect', { client_id, error: error?.message ?? 'no row' })
    return false
  }
  return data.sequence_writer_v2_enabled === true
}

/**
 * Called by every research path after the research result and the firm fact are stored. A
 * no-op unless the client is on writer v2. NEVER THROWS: the research is already paid for and
 * stored, and a failed write leaves the prospect with no sequence, which upload holds rather
 * than sends. Rerunning the writer for that prospect is the remedy.
 */
export async function maybeWriteSequenceAfterResearch(input: {
  supabase: SupabaseClient
  apiKey: string
  client_id: string
  prospect_id: string
  writerV2Enabled: boolean
  usagePath: WriterV2UsagePath
}): Promise<void> {
  if (!input.writerV2Enabled) return
  try {
    const anthropic = new Anthropic({ apiKey: input.apiKey, timeout: 120_000, maxRetries: 1 })
    await writeSequenceForProspect({
      supabase: input.supabase, anthropic, client_id: input.client_id, prospect_id: input.prospect_id,
      usagePath: input.usagePath, persist: true,
    })
  } catch (err) {
    logger.error('sequence-writer: writing after research failed; the prospect has no sequence and upload will hold it', {
      client_id: input.client_id, prospect_id: input.prospect_id, error: err instanceof Error ? err.message : String(err),
    })
  }
}
