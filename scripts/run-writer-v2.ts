// Run writer v2 for a client's not-yet-uploaded prospects from the command line, reusing
// their stored research, and write a reading file of the sequences exactly as upload would
// compose them.
//
//   npx tsx scripts/run-writer-v2.ts --org <id> --out-dir .writer-export/<dir> \
//     [--n 20] [--cap 3] [--recent-days 30] [--exclude-from <raw-results.json>] \
//     [--playbook-file <file.json>] [--persist] [--ids-from <raw-results.json>]
//
// --ids-from runs exactly the prospects of an earlier run (still pending ones only), so a
// re-run after a playbook or guidance change compares like with like.
//
// --rerun-written runs prospects that ALREADY HAVE a stored writer v2 sequence, uploaded or not,
// and compares each new result with the stored one (first-call pass, calls, cost, tier). Trial
// only: refused with --persist, because an uploaded prospect's sequence is the record of what was
// sent. Also lists every sentence that passed only because of the 2026-10-05 retry-reduction
// rules, for a human to read. Writes comparison.md beside the reading file.
//
// A TRIAL BY DEFAULT: nothing is written to any prospect. --persist stores each sequence on
// its prospect (only while it is still pending), which is what the research hook does in
// production; it is refused with --playbook-file, because a sequence written from a file is
// never shippable and storing it would only make a prospect look ready when it is not.
//
// --playbook-file uses a playbook from disk instead of the active messaging document. For a
// trial before the playbook is approved. Every record says which it was.
//
// THE SPEND IS REAL AND IS RECORDED: one research_usage row per prospect (arm 'writer_v2',
// path 'cli'), exactly as in production. The cap is checked BEFORE each prospect against that
// prospect's worst case (four calls at the dearest call seen so far), so it holds before the
// bill rather than after it.
//
// THE OUTPUT NAMES REAL PEOPLE AND FIRMS: --out-dir must be under .writer-export/ (gitignored).

import * as fs from 'fs'
import * as path from 'path'

for (const line of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const eq = t.indexOf('=')
  if (eq > 0 && !process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
}

import Anthropic from '@anthropic-ai/sdk'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { parseWriterOutput, writeSequenceForProspect, WRITER_V2_MODEL } from '../src/agents/sequence-writer-agent'
import { asSenderClaimForTheFirm, citedFactIds, norm, splitSentences, transformOutput, type WriterOutput } from '../src/lib/writer-v2/checks'
import { playbookFromDocumentContent, playbookScopeText } from '../src/lib/writer-v2/playbook'
import { fetchApprovedMessagingDoc } from '../src/lib/composition/compose-sequence'
import { composeSequence, type ComposedSequence } from '../src/lib/composition/compose-sequence'
import { usdForTokens } from '../src/lib/agents/research/cost-constants'
import { playbookProblems, type WriterPlaybook } from '../src/lib/writer-v2/playbook'
import { emptyBatchMemory } from '../src/lib/writer-v2/prompt'
import type { WriterV2Record } from '../src/lib/writer-v2/record'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

interface Row { id: string; first_name: string | null; company_name: string | null }
interface Outcome { row: Row; record: WriterV2Record | null; cost: number; composed: ComposedSequence | null; error: string | null; baseline?: WriterV2Record | null; passedOutput?: WriterOutput | null }

async function main() {
  // --render-only <raw-results.json>: rebuild the reading file from a saved run, paying for
  // nothing. Tiers are re-derived by the rule in recordedTier (a research fact id is R<n>), so
  // a run saved before that rule existed reads the same as one saved after it.
  const renderOnly = arg('render-only')
  if (renderOnly) {
    const saved = JSON.parse(fs.readFileSync(renderOnly, 'utf-8')) as { outcomes: Outcome[]; spent: number; stoppedAt: string | null }
    for (const o of saved.outcomes) {
      if (o.record?.tier === 'personalised' && !/^R\d+$/.test(o.record.fact_used?.fact_id ?? '')) {
        o.record.tier = 'semi_personalised'
        if (o.composed?.writer) o.composed.writer.tier = 'semi_personalised'
      }
    }
    const out = path.join(path.dirname(renderOnly), 'reading-file.md')
    writeReadingFile(out, saved.outcomes, { spent: saved.spent, cap: Number(arg('cap') ?? '3'), stoppedAt: saved.stoppedAt, eligible: saved.outcomes.length, playbookSource: arg('playbook-source') ?? 'file' })
    fs.writeFileSync(renderOnly, JSON.stringify(saved, null, 2))
    console.log(`rendered ${out}`)
    return
  }
  const orgId = arg('org')
  const outDir = arg('out-dir')
  if (!orgId || !outDir) throw new Error('--org and --out-dir are required')
  if (!path.resolve(outDir).includes(`${path.sep}.writer-export`)) throw new Error('--out-dir must be under .writer-export/ (gitignored): the output names real people')
  const n = Number(arg('n') ?? '20')
  const cap = Number(arg('cap') ?? '3')
  const recentDays = Number(arg('recent-days') ?? '30')
  const persist = process.argv.includes('--persist')
  const playbookFile = arg('playbook-file')
  if (persist && playbookFile) throw new Error('--persist with --playbook-file is refused: a sequence written from a file never ships')
  const rerunWritten = process.argv.includes('--rerun-written')
  if (persist && rerunWritten) throw new Error('--persist with --rerun-written is refused: a stored sequence may already have been sent')
  let playbookOverride: WriterPlaybook | undefined
  if (playbookFile) {
    playbookOverride = JSON.parse(fs.readFileSync(playbookFile, 'utf-8')) as WriterPlaybook
    const problems = playbookProblems(playbookOverride)
    if (problems.length) throw new Error(`the playbook file is not valid:\n- ${problems.join('\n- ')}`)
  }
  const excluded = new Set<string>()
  const excludeFrom = arg('exclude-from')
  if (excludeFrom) for (const r of (JSON.parse(fs.readFileSync(excludeFrom, 'utf-8')).results ?? [])) excluded.add(r.p.id)

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 1 })
  // The raw answer of every call, so the passing output's declarations can be read afterwards
  // (the stored record keeps the emails, not the claims).
  const rawAnswers: string[] = []
  const create = anthropic.messages.create.bind(anthropic.messages)
  ;(anthropic.messages as unknown as { create: unknown }).create = async (...a: Parameters<typeof create>) => {
    const res = await create(...a) as Anthropic.Message
    rawAnswers.push(res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join(''))
    return res
  }

  if (rerunWritten) return rerunWrittenTrial({ supabase, anthropic, rawAnswers, orgId, outDir, n, cap, playbookOverride })
  const { data: rows, error } = await supabase.from('prospects')
    .select('id, first_name, company_name, current_research_result_id')
    .eq('organisation_id', orgId).eq('outbound_upload_status', 'pending').not('current_research_result_id', 'is', null)
  if (error) throw new Error(error.message)
  const since = new Date(Date.now() - recentDays * 86_400_000).toISOString()
  const { data: results, error: rError } = await supabase.from('prospect_research_results')
    .select('id').eq('organisation_id', orgId).in('id', (rows ?? []).map(r => r.current_research_result_id as string)).gte('created_at', since)
  if (rError) throw new Error(rError.message)
  const recent = new Set((results ?? []).map(r => r.id as string))
  const idsFrom = arg('ids-from')
  const sameAs = idsFrom ? new Set((JSON.parse(fs.readFileSync(idsFrom, 'utf-8')).outcomes as Outcome[]).map(o => o.row.id)) : null
  const eligible = (rows ?? [])
    .filter(r => sameAs ? sameAs.has(r.id as string) : recent.has(r.current_research_result_id as string) && !excluded.has(r.id as string))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  if (sameAs && eligible.length !== sameAs.size) console.log(`note: ${sameAs.size - eligible.length} of the earlier run's prospects are no longer pending and are skipped`)
  const picked = eligible.slice(0, n) as Row[]
  console.log(`eligible ${eligible.length} (pending, research in the last ${recentDays} days, ${excluded.size} excluded), picked ${picked.length}, cap $${cap}, ${persist ? 'PERSIST' : 'trial, nothing stored'}`)

  const memory = emptyBatchMemory()
  const outcomes: Outcome[] = []
  let spent = 0
  let dearestCall = 0.07
  let stoppedAt: string | null = null
  for (const row of picked) {
    const worst = 4 * dearestCall
    if (spent + worst > cap) { stoppedAt = `cap $${cap}: spent $${spent.toFixed(3)}, the next prospect could cost up to $${worst.toFixed(3)}`; console.log(`STOP: ${stoppedAt}`); break }
    process.stdout.write(`${row.id.slice(0, 8)} ... `)
    try {
      const r = await writeSequenceForProspect({ supabase, anthropic, client_id: orgId, prospect_id: row.id, usagePath: 'cli', persist, playbookOverride, memory })
      const cost = r.record.attempts.reduce((s, a) => s + usdForTokens(a.usage, WRITER_V2_MODEL), 0)
      for (const a of r.record.attempts) dearestCall = Math.max(dearestCall, usdForTokens(a.usage, WRITER_V2_MODEL))
      spent += cost
      let composed: ComposedSequence | null = null
      let composeError: string | null = null
      try {
        composed = await composeSequence({ prospect_id: row.id, client_id: orgId, dryRun: { writerV2: { sequence: r.record, allowTrialPlaybook: true, optOutFooter: playbookOverride?.opt_out_footer ?? undefined } } })
      } catch (e) { composeError = e instanceof Error ? e.message : String(e) }
      outcomes.push({ row, record: r.record, cost, composed, error: composeError })
      console.log(`${r.record.tier} calls ${r.record.attempts.length} $${cost.toFixed(3)} (total $${spent.toFixed(3)})${composeError ? ` COMPOSE FAILED: ${composeError}` : ''}`)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      outcomes.push({ row, record: null, cost: 0, composed: null, error: message })
      console.log(`ERROR ${message}`)
    }
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'raw-results.json'), JSON.stringify({ outcomes, spent, stoppedAt }, null, 2))
  }
  writeReadingFile(path.join(outDir, 'reading-file.md'), outcomes, { spent, cap, stoppedAt, eligible: eligible.length, playbookSource: playbookFile ? 'file' : 'document' })
  console.log(`spent $${spent.toFixed(3)} of $${cap}`)
}

// ─── --rerun-written: the same prospects again, compared with what is stored ──

async function rerunWrittenTrial(a: { supabase: SupabaseClient; anthropic: Anthropic; rawAnswers: string[]; orgId: string; outDir: string; n: number; cap: number; playbookOverride?: WriterPlaybook }) {
  const { supabase, anthropic, rawAnswers, orgId, outDir, n, cap, playbookOverride } = a
  const { data: rows, error } = await supabase.from('prospects')
    .select('id, first_name, last_name, company_name, writer_v2_sequence')
    .eq('organisation_id', orgId).not('writer_v2_sequence', 'is', null)
  if (error) throw new Error(error.message)
  const all = ((rows ?? []) as Array<Row & { last_name: string | null; writer_v2_sequence: WriterV2Record }>).sort((x, y) => (x.id < y.id ? -1 : 1))
  const picked = all.slice(0, n)
  console.log(`stored sequences ${all.length}; rerunning the first ${picked.length} by id; cap $${cap}; trial, nothing stored on any prospect`)
  const messaging = await fetchApprovedMessagingDoc(supabase as never, orgId, null)
  const playbook = playbookOverride ?? playbookFromDocumentContent(messaging.content).playbook
  if (!playbook) throw new Error('no playbook in the active messaging document')
  const memory = emptyBatchMemory()
  const outcomes: Outcome[] = []
  let spent = 0
  let dearestCall = 0.07
  let stoppedAt: string | null = null
  for (const row of picked) {
    const worst = 4 * dearestCall
    if (spent + worst > cap) { stoppedAt = `cap $${cap}: spent $${spent.toFixed(3)}, the next prospect could cost up to $${worst.toFixed(3)}`; console.log(`STOP: ${stoppedAt}`); break }
    process.stdout.write(`${row.id.slice(0, 8)} ... `)
    rawAnswers.length = 0
    try {
      const r = await writeSequenceForProspect({ supabase: supabase as never, anthropic, client_id: orgId, prospect_id: row.id, usagePath: 'cli', persist: false, playbookOverride, memory })
      const cost = r.record.attempts.reduce((s, x) => s + usdForTokens(x.usage, WRITER_V2_MODEL), 0)
      for (const x of r.record.attempts) dearestCall = Math.max(dearestCall, usdForTokens(x.usage, WRITER_V2_MODEL))
      spent += cost
      const last = r.record.tier !== 'template' ? parseWriterOutput(rawAnswers[rawAnswers.length - 1] ?? '') : null
      outcomes.push({ row, record: r.record, cost, composed: null, error: null, baseline: row.writer_v2_sequence, passedOutput: last ? transformOutput(last) : null })
      console.log(`${r.record.tier} calls ${r.record.attempts.length} $${cost.toFixed(3)} (was ${row.writer_v2_sequence.tier} calls ${row.writer_v2_sequence.attempts.length}) total $${spent.toFixed(3)}`)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      outcomes.push({ row, record: null, cost: 0, composed: null, error: message, baseline: row.writer_v2_sequence })
      console.log(`ERROR ${message}`)
    }
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'raw-results.json'), JSON.stringify({ outcomes, spent, stoppedAt }, null, 2))
  }
  writeComparison(path.join(outDir, 'comparison.md'), outcomes, all.map(r => r.writer_v2_sequence), playbook, { spent, cap, stoppedAt })
  console.log(`spent $${spent.toFixed(3)} of $${cap}; wrote ${path.join(outDir, 'comparison.md')}`)
}

function stats(records: WriterV2Record[]) {
  const n = records.length || 1
  const calls = records.reduce((s, r) => s + r.attempts.length, 0)
  const cost = records.reduce((s, r) => s + r.attempts.reduce((t, x) => t + usdForTokens(x.usage, WRITER_V2_MODEL), 0), 0)
  const first = records.filter(r => r.tier !== 'template' && r.attempts.length === 1).length
  const tiers = ['personalised', 'semi_personalised', 'template'].map(t => records.filter(r => r.tier === t).length).join(' / ')
  return { count: records.length, first, firstShare: `${Math.round((100 * first) / n)}%`, calls: (calls / n).toFixed(2), cost: (cost / n).toFixed(4), tiers }
}

/** Every sentence of a passing output that the 2026-10-05 rules let through and the old ones did not. */
function newlyAccepted(o: Outcome, playbook: WriterPlaybook): string[] {
  const out = o.passedOutput
  if (!out || !o.record) return []
  const names = { firstName: o.row.first_name ?? '', lastName: null, role: null, companyName: o.row.company_name, shortName: null }
  const scope = norm(playbookScopeText(playbook))
  const hits: string[] = []
  for (const c of out.prospect_claims ?? []) if (citedFactIds(c.fact_id).length > 1) hits.push(`[several facts ${c.fact_id}] E${c.email}: ${c.sentence}`)
  for (const c of out.sender_claims ?? []) {
    if (c.playbook_line && !scope.includes(norm(c.playbook_line).replace(/^"|"$/g, ''))) hits.push(`[scope by actions] E${c.email}: ${c.sentence}  (cited: ${c.playbook_line})`)
  }
  for (const e of out.emails) for (const s of splitSentences(e.body)) {
    // Over-lists on purpose: the short name the writer used is not stored, so any sender sentence
    // with a capitalised word after "for" or between "who" and "serves" is shown.
    const shaped = /\b(?:we|us|our)\b/i.test(s) && /\bfor (?:the )?[A-Z0-9]|\bwho [A-Z0-9][^,.]{0,40} serves?\b/.test(s)
    if (shaped || asSenderClaimForTheFirm(s, names) !== null) hits.push(`[firm as who it is for] E${e.email}: ${s}`)
  }
  return hits
}

function writeComparison(file: string, outcomes: Outcome[], batch: WriterV2Record[], playbook: WriterPlaybook, meta: { spent: number; cap: number; stoppedAt: string | null }) {
  const ran = outcomes.filter(o => o.record)
  const now = stats(ran.map(o => o.record!))
  const before = stats(ran.map(o => o.baseline!).filter(Boolean))
  const whole = stats(batch)
  const L: string[] = ['# Writer v2 retry reduction: trial rerun', '']
  L.push(`${ran.length} prospects rerun (${outcomes.length - ran.length} errors). Spent $${meta.spent.toFixed(3)} of $${meta.cap}.${meta.stoppedAt ? ` STOPPED EARLY: ${meta.stoppedAt}` : ''}`, '')
  L.push('| | first-call pass | calls per sequence | cost per sequence | tiers (personalised / semi / template) |', '|---|---|---|---|---|')
  L.push(`| this run, new rules | ${now.first} of ${now.count} (${now.firstShare}) | ${now.calls} | $${now.cost} | ${now.tiers} |`)
  L.push(`| same prospects, stored | ${before.first} of ${before.count} (${before.firstShare}) | ${before.calls} | $${before.cost} | ${before.tiers} |`)
  L.push(`| whole stored batch | ${whole.first} of ${whole.count} (${whole.firstShare}) | ${whole.calls} | $${whole.cost} | ${whole.tiers} |`, '')
  L.push('## Failures in this run', '')
  for (const o of ran) for (const x of o.record!.attempts.filter(x => x.failures.length)) L.push(`- ${o.row.id.slice(0, 8)} ${x.tier}: ${x.failures.join(' | ')}`)
  L.push('', '## Sentences that passed only because of the new rules (read each one)', '')
  for (const o of ran) for (const h of newlyAccepted(o, playbook)) L.push(`- ${o.row.id.slice(0, 8)} ${h}`)
  fs.writeFileSync(file, L.join('\n'))
}

const TIER_LABEL: Record<string, string> = { personalised: 'personalised', semi_personalised: 'semi-personalised', template: 'template (last resort)' }

function writeReadingFile(file: string, outcomes: Outcome[], meta: { spent: number; cap: number; stoppedAt: string | null; eligible: number; playbookSource: string }) {
  const L: string[] = []
  L.push('# Writer v2: 20 sequences as sent', '')
  L.push('Each sequence is shown exactly as upload would compose it: greeting, body, sign-off and opt-out footer. The tier, the facts used and any check failures follow in the key after all of them.', '')
  outcomes.forEach((o, i) => {
    L.push(`## ${i + 1}. ${o.row.first_name ?? 'unknown'} at ${o.row.company_name ?? 'unknown company'}`, '')
    if (!o.composed) { L.push(`(not composed: ${o.error ?? 'unknown'})`, ''); return }
    for (const e of o.composed.emails) {
      L.push(`**Email ${e.sequence_position}**${e.subject_line ? `  Subject: ${e.subject_line}` : ''}`, '')
      const body = e.body.replace(/\{\{first_name\}\}/g, o.row.first_name ?? 'there')
      L.push(...body.split('\n').map(l => (l ? `> ${l}` : '>')), '')
    }
  })
  L.push('---', '', '# Key', '')
  const split = outcomes.reduce<Record<string, number>>((acc, o) => { const t = o.record?.tier ?? 'error'; acc[t] = (acc[t] ?? 0) + 1; return acc }, {})
  L.push(`Writer model ${WRITER_V2_MODEL}. Playbook from the ${meta.playbookSource === 'file' ? 'local trial file (the playbook suggestion cannot be filed while another messaging suggestion is pending)' : 'active messaging document'}.`)
  L.push(`${meta.eligible} prospects eligible; ${outcomes.length} run. Spent $${meta.spent.toFixed(3)} of the $${meta.cap} cap.${meta.stoppedAt ? ` STOPPED EARLY: ${meta.stoppedAt}` : ''}`, '')
  L.push('## Tier split', '')
  for (const [tier, count] of Object.entries(split)) L.push(`- ${TIER_LABEL[tier] ?? tier}: ${count}`)
  const firstTry = outcomes.filter(o => o.record && o.record.tier !== 'template' && o.record.attempts.length === 1).length
  L.push('', `Passed on the first call: ${firstTry} of ${outcomes.length}.`, '')
  L.push('## Per sequence', '')
  outcomes.forEach((o, i) => {
    const r = o.record
    L.push(`### ${i + 1}. ${o.row.first_name ?? 'unknown'} at ${o.row.company_name ?? 'unknown'} (${o.row.id})`, '')
    if (!r) { L.push(`- ERROR: ${o.error}`, ''); return }
    L.push(`- Tier: ${TIER_LABEL[r.tier]}. Calls: ${r.attempts.length}. Cost: $${o.cost.toFixed(4)}.`)
    if (r.fact_used) L.push(`- Fact used: ${r.fact_used.fact_id}${r.fact_used.quote ? `, quoting "${r.fact_used.quote}"` : ''}`)
    if (r.link_sentence) L.push(`- Link: ${r.link_sentence}`)
    if (r.angles.length) L.push(`- Angles: ${r.angles.map(a => `E${a.email} ${a.angle}`).join('; ')}`)
    const failed = r.attempts.filter(a => a.failures.length > 0)
    if (failed.length === 0) L.push('- Check failures: none')
    else failed.forEach((a, k) => L.push(`- Check failures, ${a.tier} attempt ${k + 1}:${a.failures.map(f => `\n  - ${f}`).join('')}`))
    L.push(r.copied_phrases.length ? `- Copied phrases (report only):${r.copied_phrases.map(c => `\n  - ${c}`).join('')}` : '- Copied phrases: none')
    if (o.error) L.push(`- COMPOSE FAILED: ${o.error}`)
    L.push('')
  })
  fs.writeFileSync(file, L.join('\n'))
}

main().catch(e => { process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1) })
