// EXPERIMENT HARNESS, ARM B (relevance from the brief). Branch exp-relevance-gate. NOT FOR MERGE.
//
//   npx tsx --env-file=.env.local scripts/exp-relevance-run.ts synth --max-usd=2.50
//   npx tsx --env-file=.env.local scripts/exp-relevance-run.ts write --run=1 --max-usd=1.75
//
// WRITES NOTHING TO THE DATABASE. Reads go through readOnlyClient (export-writer-run.ts), an
// allowlist proxy that throws on any write. loadClientContext builds its own service client
// and only selects. Everything this produces lands in .writer-export/, which is gitignored.
//
// synth  rebuilds each prospect's research input from the stored source payloads (the most
//        recent prospect_research_results row that holds real payloads), builds the synthesis
//        request with the client's brief attached (arm B), and sends all of them as ONE
//        Anthropic message batch. A truncated answer is retried once inline, as production does.
// write  runs produceOpening in arm B mode, follow-ups on, against the stored arm B synthesis,
//        pinned to the same messaging document arm A ran against.

import Anthropic from '@anthropic-ai/sdk'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import fs from 'node:fs'
import path from 'node:path'
import { readOnlyClient, usdForUsage, renderSequence } from './export-writer-run'
import {
  loadClientContext,
  buildSynthesisParams,
  synthesisFromMessage,
  detectRecencySignal,
  retryTruncatedSynthesis,
} from '@/lib/agents/research/synthesize'
import { renderRelevanceBrief } from '@/lib/agents/research/relevance-brief'
import { produceOpening, resolveVariantId, loadClientName, type MessagingContent } from '@/lib/agents/research/produce-opening'
import { writerInputFromSynthesis } from '@/lib/agents/research/writer-input'
import { BatchUniquenessRegistry } from '@/lib/agents/research/batch-uniqueness'
import { companyFactsFromRow } from '@/lib/agents/research/company-facts'
import type { ProspectContext, RawSourceData, SynthesisOutput, TokenUsage } from '@/lib/agents/research/types'
import type { ClientDocContext, DetectedSignal } from '@/lib/agents/research/synthesize'

const ORG_ID = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'
// The documents arm A ran against on 2026-10-03 (reading file 6): messaging v9, ICP v11.
const MESSAGING_DOC_ID = '5915ac04-f5ab-49f1-b433-49b42f557b5d'
const PROSPECT_IDS = [
  '31a46d86-02ed-4f4d-bcf6-daac989b391a', '387300c5-26e3-4e6d-b3e8-cdea59cc9162', '69fce51e-101d-4075-91ab-2c958960d7fa',
  '1ae31d0e-c433-4011-bce2-7cfd6c86e19c', 'cd3331b4-d5ac-4c04-9e78-6366a35c9b37', '4a4b1a77-e8e1-4f08-8c15-cb4b954ecef0',
  '17eea3eb-847b-4415-b28b-c0fd7c945396', '9b3e381c-75f8-42a8-b7b4-a7d6c4e34d80', '70b6d076-038d-4a80-bd99-8ea48f8f03a1',
  '305f3871-e703-4cfb-861f-a2eba2cedbb9', 'e2bd4750-5b71-49a7-bc94-849379928c3d', 'bfb9dce8-6e1a-4422-bcd0-e59c821358f2',
  '1e9e71b7-7945-4a4d-b271-1cb822715019', '188ec7f0-f9c9-4a31-983a-918a84faba58', '8e67ab18-b46f-421a-89f5-424ccc069e85',
  '8764359f-c2d6-41cf-b9a0-a8ea7d5003cf', 'e3876f09-90d2-4efe-86f4-850612581dde', '4fec29e8-465b-42f2-9033-84ba03533296',
  '3ae4c698-edf2-4bf7-bb99-ee981ec71688', '175e4565-04a8-4896-a133-7943ec424a1e', '74b08379-6aa9-4596-9b0a-3dd8460a7488',
  '82260430-0ff6-413e-a662-0a44ff1d776e', 'ba2d4c4e-4a1e-4bb5-b556-8ff27d21073d',
]

const OUT = path.join(process.cwd(), '.writer-export', 'exp-relevance')
const SYNTH_FILE = path.join(OUT, 'armB-synthesis.json')

// Sonnet 4.6 published rates per million tokens; the Batch API bills 50% of each. A 1-hour
// cache write is 2x base input. Derived from returned usage, not an invoice.
const BATCH_USD = { input: 1.5, output: 7.5, cacheWrite1h: 3.0, cacheRead: 0.15 }
function batchUsd(u: Message['usage']): number {
  return ((u.input_tokens ?? 0) * BATCH_USD.input
    + (u.output_tokens ?? 0) * BATCH_USD.output
    + (u.cache_creation_input_tokens ?? 0) * BATCH_USD.cacheWrite1h
    + (u.cache_read_input_tokens ?? 0) * BATCH_USD.cacheRead) / 1e6
}

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}
function arg(name: string): string | undefined {
  return process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Supabase = ReturnType<typeof readOnlyClient>

async function loadProspect(supabase: Supabase, id: string): Promise<{ ctx: ProspectContext; variant_id: string | null }> {
  const { data: p, error } = await supabase
    .from('prospects')
    .select('id, organisation_id, segment_id, variant_id, first_name, last_name, company_name, country, role, job_title, email, linkedin_url, website_url, company_headcount, company_industry, apollo_enrichment_data')
    .eq('id', id).eq('organisation_id', ORG_ID).single()
  if (error || !p) throw new Error(`prospect ${id} not found for this organisation`)
  return {
    variant_id: (p.variant_id ?? null) as string | null,
    ctx: {
      id: p.id as string, organisation_id: ORG_ID, segment_id: (p.segment_id ?? null) as string | null,
      first_name: (p.first_name ?? null) as string | null, last_name: (p.last_name ?? null) as string | null,
      company_name: (p.company_name ?? null) as string | null, country: (p.country ?? null) as string | null,
      role: (p.role ?? null) as string | null, job_title: (p.job_title ?? null) as string | null,
      email: (p.email ?? null) as string | null, linkedin_url: (p.linkedin_url ?? null) as string | null,
      website_url: (p.website_url ?? null) as string | null, company: companyFactsFromRow(p),
    },
  }
}

/** A stored payload back into the shape synthesis reads. Stored errors read as unavailable. */
function asSource<T>(raw: unknown): T {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (o.available === true) return o as T
  return { ...o, available: false, error: typeof o.error === 'string' ? o.error : 'not stored' } as T
}

/** The most recent row holding real source payloads. Reuse rows carry 44-byte placeholders. */
async function loadRawSources(supabase: Supabase, id: string): Promise<{ raw: RawSourceData; row_id: string; created_at: string }> {
  const { data, error } = await supabase
    .from('prospect_research_results')
    .select('id, created_at, raw_linkedin, raw_apollo, raw_website, raw_web_search')
    .eq('prospect_id', id).eq('organisation_id', ORG_ID)
    .order('created_at', { ascending: false }).limit(10)
  if (error) throw new Error(`could not read research rows for ${id}: ${error.message}`)
  const row = (data ?? []).find(r => [r.raw_linkedin, r.raw_apollo, r.raw_website]
    .some(x => x && typeof x === 'object' && (x as Record<string, unknown>).available === true))
  if (!row) throw new Error(`no stored source payloads for ${id}`)
  return {
    row_id: row.id as string,
    created_at: row.created_at as string,
    raw: {
      linkedin: asSource(row.raw_linkedin), apollo: asSource(row.raw_apollo),
      website: asSource(row.raw_website), web_search: asSource(row.raw_web_search),
    },
  }
}

async function loadMessaging(supabase: Supabase): Promise<MessagingContent> {
  const { data, error } = await supabase.from('strategy_documents')
    .select('id, organisation_id, document_type, version, content').eq('id', MESSAGING_DOC_ID).single()
  if (error || !data) throw new Error('pinned messaging document not found')
  if (data.organisation_id !== ORG_ID || data.document_type !== 'messaging') throw new Error('pinned document is not this client\'s messaging document')
  return data.content as MessagingContent
}

async function armBClientContext(supabase: Supabase): Promise<ClientDocContext> {
  const base = await loadClientContext(ORG_ID, null)
  const brief = renderRelevanceBrief(await loadMessaging(supabase))
  if (!brief) throw new Error('the pinned messaging document carries no usable brief')
  return { ...base, relevanceBrief: brief }
}

interface SynthRecord {
  prospect_id: string
  raw_row_id: string
  raw_row_created_at: string
  detected_signal: DetectedSignal
  synthesis: SynthesisOutput | null
  error: string | null
  usd: number
  retried_truncation: boolean
}

async function synth() {
  const cap = Number(arg('max-usd') ?? '2.50')
  const supabase = readOnlyClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))
  const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') })
  fs.mkdirSync(OUT, { recursive: true })

  const clientCtx = await armBClientContext(supabase)
  fs.writeFileSync(path.join(OUT, 'armB-client-context.json'), JSON.stringify(clientCtx, null, 2))
  const prepared = []
  // --ids=a,b re-runs only those prospects and merges them into the stored file.
  const only = arg('ids')?.split(',').filter(Boolean) ?? null
  for (const id of only ?? PROSPECT_IDS) {
    const { ctx } = await loadProspect(supabase, id)
    const src = await loadRawSources(supabase, id)
    const detected = detectRecencySignal(src.raw, new Date())
    const params = buildSynthesisParams(ctx, src.raw, clientCtx, detected, '1h')
    prepared.push({ id, ctx, src, detected, params })
  }
  const inputChars = prepared.reduce((n, p) => n + JSON.stringify(p.params.messages).length, 0)
  const systemChars = JSON.stringify(prepared[0].params.system).length
  console.log(`armB synth: ${prepared.length} prospects, user material ${Math.round(inputChars / 1000)}k chars, system prompt ${Math.round(systemChars / 1000)}k chars.`)
  console.log(`Spend cap $${cap.toFixed(2)}. Batch route (50% rates). Nothing is written to the database.`)
  fs.writeFileSync(path.join(OUT, 'armB-system-prompt.txt'), (prepared[0].params.system as Array<{ text: string }>)[0].text)

  if (process.argv.includes('--dry')) {
    // FREE: token counting is not billed. Prices the run before anything is sent.
    let inTok = 0
    for (const p of prepared) {
      const c = await client.messages.countTokens({ model: p.params.model, system: p.params.system, messages: p.params.messages })
      inTok += c.input_tokens
    }
    const sysTok = (await client.messages.countTokens({ model: prepared[0].params.model, system: prepared[0].params.system, messages: [{ role: 'user', content: 'x' }] })).input_tokens
    console.log(`dry: ${inTok} input tokens across ${prepared.length} requests; system prompt ~${sysTok} tokens.`)
    console.log(`dry: markers left in system prompt: ${(prepared[0].params.system as Array<{ text: string }>)[0].text.includes('<<ARM_B') ? 'YES' : 'none'}`)
    return
  }
  const batch = await client.messages.batches.create({
    requests: prepared.map(p => ({ custom_id: p.id, params: p.params })),
  })
  console.log(`batch ${batch.id} submitted`)
  fs.writeFileSync(path.join(OUT, 'armB-batch-id.txt'), batch.id)

  let status = batch
  while (status.processing_status !== 'ended') {
    await sleep(30_000)
    status = await client.messages.batches.retrieve(batch.id)
    console.log(`  ${new Date().toISOString()} ${status.processing_status} ${JSON.stringify(status.request_counts)}`)
  }

  const byId = new Map(prepared.map(p => [p.id, p]))
  const records: SynthRecord[] = []
  let spent = 0
  for await (const result of await client.messages.batches.results(batch.id)) {
    const p = byId.get(result.custom_id)!
    const base = { prospect_id: p.id, raw_row_id: p.src.row_id, raw_row_created_at: p.src.created_at, detected_signal: p.detected }
    if (result.result.type !== 'succeeded') {
      records.push({ ...base, synthesis: null, error: `batch result ${result.result.type}`, usd: 0, retried_truncation: false })
      continue
    }
    const message = result.result.message
    let usd = batchUsd(message.usage)
    let synthesis = synthesisFromMessage(message, p.ctx, clientCtx, p.detected, p.src.raw)
    const text = message.content.find(b => b.type === 'text')
    if (text && text.type === 'text') fs.writeFileSync(path.join(OUT, `raw-${p.id.slice(0, 8)}.txt`), text.text)
    let retried = false
    if (message.stop_reason === 'max_tokens') {
      // Production retries a truncated answer once with the reasoning constrained, inline.
      if (spent + usd + 0.40 > cap) throw new Error(`cap: a truncation retry for ${p.id} could pass $${cap}`)
      const retry = await retryTruncatedSynthesis(client, p.ctx, p.src.raw, clientCtx, p.detected)
      if (retry) {
        retried = true
        usd += 2 * batchUsd(retry.usage) // inline is full price
        synthesis = synthesisFromMessage(retry, p.ctx, clientCtx, p.detected, p.src.raw)
      }
    }
    spent += usd
    records.push({ ...base, synthesis, error: null, usd, retried_truncation: retried })
  }
  if (only) {
    const prior = JSON.parse(fs.readFileSync(SYNTH_FILE, 'utf8')) as { batch_id: string; spent_usd: number; records: SynthRecord[] }
    const merged = prior.records.map(r => records.find(n => n.prospect_id === r.prospect_id) ?? r)
    fs.writeFileSync(SYNTH_FILE, JSON.stringify({ batch_id: `${prior.batch_id}+${batch.id}`, spent_usd: prior.spent_usd + spent, records: merged }, null, 2))
  } else {
    fs.writeFileSync(SYNTH_FILE, JSON.stringify({ batch_id: batch.id, spent_usd: spent, records }, null, 2))
  }
  const selected = records.filter(r => r.synthesis?.selected_candidate_id).length
  console.log(`armB synth done: ${records.length} records, ${selected} with a selected fact, $${spent.toFixed(3)} (derived from usage at batch rates).`)
}

interface WriteRecord {
  prospect_id: string
  company: string | null
  first_name: string | null
  variant_id: string
  selected: { id: string; observation: string; provenance: string; date: string | null; source: string; fact_kind: string | null; matched_trigger_text: string | null } | null
  link: string | null
  gate_state: string | null
  gate_why: string | null
  written_won: boolean
  not_written_reason: string | null
  observation: string | null
  bridge: string | null
  question: string | null
  subject: string | null
  email2_shipped: boolean
  email3_shipped: boolean
  gate_failures: unknown
  followup_attempts: unknown
  attempts: unknown
  sequence: ReturnType<typeof renderSequence>
  judge_reasoning?: string | null
  usd: number
}

async function write() {
  const run = Number(arg('run') ?? '1')
  const cap = Number(arg('max-usd') ?? '1.75')
  const supabase = readOnlyClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))
  const apiKey = env('ANTHROPIC_API_KEY')
  const stored = JSON.parse(fs.readFileSync(SYNTH_FILE, 'utf8')) as { records: SynthRecord[] }
  const messaging = await loadMessaging(supabase)
  const clientCtx = await loadClientContext(ORG_ID, null)
  const clientName = await loadClientName(supabase as never, ORG_ID)
  const uniqueness = new BatchUniquenessRegistry()
  const WORST_USD = 0.15
  console.log(`armB write run ${run}: ${stored.records.length} prospects. Spend cap $${cap.toFixed(2)}, stopping before any prospect that could pass it at $${WORST_USD} worst case. Nothing is written to the database.`)

  const out: WriteRecord[] = []
  const file = path.join(OUT, `armB-write-run${run}.json`)
  let spent = 0
  for (const rec of stored.records) {
    if (spent + WORST_USD > cap) { console.log(`STOPPED at the cap before ${rec.prospect_id}`); break }
    const { ctx, variant_id } = await loadProspect(supabase, rec.prospect_id)
    const variantId = resolveVariantId(ctx.id, variant_id, messaging).variantId
    if (!rec.synthesis) { console.log(`  ${rec.prospect_id}: no synthesis (${rec.error})`); continue }
    const input = writerInputFromSynthesis(rec.synthesis)
    const attempts: unknown[] = []
    const opening = await produceOpening({
      onAttempt: o => attempts.push(o),
      apiKey, clientName, ctx, ...input,
      messagingContent: messaging, variantId,
      icpBuyerTitle: clientCtx.buyerTitle, positioningText: clientCtx.positioningText,
      triggers: clientCtx.triggers, relevanceMode: true,
      uniqueness, writeFollowupEmails: true,
    })
    const usage = opening.usage as TokenUsage
    const usd = usdForUsage(usage) + (opening.followup_usage ? usdForUsage(opening.followup_usage) : 0)
    spent += usd
    const sel = rec.synthesis.candidates.find(c => c.id === rec.synthesis!.selected_candidate_id) ?? null
    const gate = opening.approved_reason as { state?: string; why?: string; reason?: string } | undefined
    out.push({
      prospect_id: ctx.id, company: ctx.company_name, first_name: ctx.first_name, variant_id: variantId,
      selected: sel ? {
        id: sel.id, observation: sel.observation, provenance: sel.provenance, date: sel.date, source: sel.source,
        fact_kind: sel.brief_relevance?.fact_kind ?? null, matched_trigger_text: sel.matched_trigger_text ?? null,
      } : null,
      link: sel?.brief_relevance?.link ?? null,
      gate_state: gate?.state ?? null, gate_why: gate?.why ?? null,
      written_won: opening.written_won, not_written_reason: opening.not_written_reason ?? null,
      observation: opening.observation, bridge: opening.bridge, question: opening.question, subject: opening.subject,
      email2_shipped: opening.email2.body !== null, email3_shipped: opening.email3.body !== null,
      gate_failures: opening.gate_failures, followup_attempts: opening.followup_attempts, attempts,
      judge_reasoning: opening.judge_reasoning ?? null,
      sequence: renderSequence(messaging, variantId, ctx.first_name, opening, true),
      usd,
    })
    fs.writeFileSync(file, JSON.stringify({ run, spent_usd: spent, records: out }, null, 2))
    console.log(`  ${out.length}/${stored.records.length} ${ctx.id.slice(0, 8)} won=${opening.written_won} e2=${opening.email2.body !== null} e3=${opening.email3.body !== null} $${usd.toFixed(3)} total $${spent.toFixed(3)}`)
  }
  console.log(`armB write run ${run} done: ${out.filter(r => r.written_won).length} of ${out.length} personalised, $${spent.toFixed(3)}.`)
}

const mode = process.argv[2]
if (mode === 'synth') synth().catch(e => { console.error(e); process.exit(1) })
else if (mode === 'write') write().catch(e => { console.error(e); process.exit(1) })
else { console.error('usage: exp-relevance-run.ts synth|write [--run=N] [--max-usd=X]'); process.exit(2) }
