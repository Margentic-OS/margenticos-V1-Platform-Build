// Outbound brief and template generation, run by the operator from the command line.
//
// Two steps, each writing the SAME pending messaging suggestion. There can only be one
// pending suggestion per organisation and document type (unique index
// document_suggestions_org_type_pending_unique), so the brief and the regenerated
// templates travel together and are approved together, as one document version.
//
//   1. Land the brief:
//        npx tsx scripts/run-outbound-template-agent.ts --org <id> --brief <brief.json>
//      Creates a pending messaging suggestion: the live document's content unchanged,
//      plus content.outbound_brief. Nothing else changes, and nothing ships.
//      The brief file is read from disk and never committed: it is client data, and the
//      repository is public. Keep it under .writer-export/, which is gitignored.
//
//   2. Regenerate the templates from the brief:
//        npx tsx scripts/run-outbound-template-agent.ts --org <id> --generate [--out <file>]
//      Reads the brief from that pending suggestion (never from any other document),
//      generates one variant per lead angle, and rewrites the SAME pending suggestion's content to the
//      brief plus the new templates. firm_fact_tier.enabled is CARRIED FORWARD from the
//      pending suggestion (which took it from the live document when the brief was landed),
//      so a regeneration never switches a client's tier off behind the operator's back.
//      Until 2026-10-02 it was written false on every run.
//      --draft writes with the cheaper draft model. Every check and the scope judge are the
//      same; the suggestion records the model this run wrote with.
//      --written-by "<text>" records <text> as the writer instead, in generated_by_model and
//      in the suggestion's reason. For lines this run did not write as they stand: variants
//      kept from a draft run, or finished by hand from a model's draft. Without it the record
//      names this run's model, which is untrue of anything it only kept.
//      --max-usd <n> stops PAYING once n dollars have been spent (default 3). The spend is
//      checked before each writing call and each judge round, never during one, so a run can
//      end up to one writing call or one judge round over n. A run stopped by the cap saves
//      its attempt like any failed run.
//      --out writes the result as JSON for the reading report (keep it gitignored).
//      --brief <file> with --generate replaces the pending brief (a correction before approval).
//      --keep A,B keeps those variants and regenerates the rest. They are read from the
//      pending suggestion, or with --keep-from <file> from a failed run's saved attempt.
//      A run that fails ALWAYS saves its attempt (to <out>.failed.json, or under
//      .writer-export/), because a failed run stores nothing in the suggestion and its
//      passing variants would otherwise be lost and paid for again.
//
//   3. Switch the firm-fact tier for THIS client:
//        npx tsx scripts/run-outbound-template-agent.ts --org <id> --tier on   (or off)
//      THE PER-CLIENT SWITCH. The tier is on for a client when that client's messaging
//      document says firm_fact_tier.enabled = true, and for no other client. This sets it
//      in the pending messaging suggestion; with none pending it creates one that is the
//      live document with only that value changed. Either way it takes effect when the
//      suggestion is approved, like any other change to the document, and it is carried
//      through every later regeneration. With --generate, --tier sets it in the same run.
//      ON IS REFUSED for a document that cannot use it: the brief must validate, the opener
//      frames must exist, and every variant must carry its lines at the brief's version.
//      Switched on without them, research pays for a firm fact per prospect that composition
//      then cannot put in any email. The switch is added to the suggestion's reason and
//      revision note, so the version history says it happened.
//      --tier beside --brief alone is REFUSED: land the brief, then switch the tier.
//
// EVERY FLAG IS READ AND CHECKED FIRST, before anything is read or paid for. Until
// 2026-10-02 --tier was read only after a paid run had finished, so "--tier On" failed
// after the money was spent and the result had to be stored with a re-judged --keep run;
// and beside --brief it was not read at all.
//
// Service role. Operator only. Never approves anything: approval stays in the dashboard.

import * as fs from 'fs'
import * as path from 'path'

const envPath = path.join(process.cwd(), '.env.local')
for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eq = trimmed.indexOf('=')
  if (eq === -1) continue
  const key = trimmed.slice(0, eq).trim()
  if (!process.env[key]) process.env[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
}

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  buildMessagingContent,
  fetchSenderSignoff,
  generateOutboundTemplates,
  OutboundTemplateFailure,
  OUTBOUND_TEMPLATE_DRAFT_MODEL,
  OUTBOUND_TEMPLATE_MODEL,
  templateRunCostUsd,
} from '../src/agents/outbound-template-agent'
import { parseCapUsd } from '../src/lib/operator/run-spend'
import { readBrief, validateOutboundBrief, type OutboundBrief } from '../src/lib/outbound-brief/brief'
import type { VariantLines } from '../src/lib/outbound-templates/template-shape'

/** A flag's value. A flag given with nothing after it, or with another flag after it, is refused: it is not "absent". */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return undefined
  const value = process.argv[i + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value after it`)
  return value
}

/** --tier on | off. Undefined when the flag is absent: the value in hand is kept. */
function tierArg(): boolean | undefined {
  const value = arg('tier')
  if (value === undefined) return undefined
  if (value === 'on') return true
  if (value === 'off') return false
  throw new Error(`--tier takes "on" or "off", got "${value}"`)
}

/** Everything a run is told on the command line, read and checked before anything else happens. */
interface RunFlags {
  generate: boolean
  briefPath: string | undefined
  tier: boolean | undefined
  draft: boolean
  maxUsd: number
  writtenBy: string | undefined
}

function readFlags(): RunFlags {
  const generate = process.argv.includes('--generate')
  const flags: RunFlags = {
    generate,
    briefPath: arg('brief'),
    tier: tierArg(),
    draft: process.argv.includes('--draft'),
    maxUsd: parseCapUsd(arg('max-usd')),
    writtenBy: arg('written-by')?.trim(),
  }
  if (flags.writtenBy === '') throw new Error('--written-by needs the name of whoever wrote the lines')
  // A flag that only a generation run reads is refused anywhere else, by name: left alone it
  // would be ignored, and the person who typed it told nothing.
  for (const name of ['draft', 'max-usd', 'written-by', 'keep', 'keep-from', 'out']) {
    if (!generate && process.argv.includes(`--${name}`)) throw new Error(`--${name} is read only with --generate`)
  }
  if (flags.briefPath && !generate && flags.tier !== undefined) {
    throw new Error('--tier beside --brief alone is refused: land the brief first, then run --tier on its own, or pass --tier with --generate')
  }
  return flags
}

/**
 * The "unnatural" quotes the scope judge gave that are not in the line it named. They failed
 * nothing, and may still point at a real slip the judge misquoted: read those lines.
 */
function printUnplacedQuotes(quotes: ReadonlyArray<{ variant: string; line: string; quote: string }> | undefined) {
  if (!quotes || quotes.length === 0) return
  console.log(`The scope judge called ${quotes.length} phrase${quotes.length === 1 ? '' : 's'} unnatural that ${quotes.length === 1 ? 'is' : 'are'} not in the line it named. Nothing failed for ${quotes.length === 1 ? 'it' : 'them'}; read those lines:`)
  for (const q of quotes) console.log(`  ${q.variant} ${q.line}: "${q.quote}"`)
}

const tierIsOn = (content: Record<string, unknown>) =>
  (content.firm_fact_tier as { enabled?: unknown } | undefined)?.enabled === true

async function activeMessagingDoc(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('id, version, content, plain_text, segment_id')
    .eq('organisation_id', orgId)
    .eq('document_type', 'messaging')
    .eq('status', 'active')
    .is('segment_id', null)
    .maybeSingle()
  if (error || !data) throw new Error(`no active default-segment messaging document for ${orgId}`)
  return data as { id: string; version: string; content: Record<string, unknown>; plain_text: string | null; segment_id: string | null }
}

async function pendingMessagingSuggestion(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase
    .from('document_suggestions')
    .select('id, suggested_value, revision_note, suggestion_reason')
    .eq('organisation_id', orgId)
    .eq('document_type', 'messaging')
    .eq('status', 'pending')
    .maybeSingle()
  if (error) throw new Error(`reading pending suggestion: ${error.message}`)
  return data as { id: string; suggested_value: string; revision_note: string | null; suggestion_reason: string | null } | null
}

// How this script recognises its own pending suggestion. Not update_trigger: that column
// has a CHECK allowing only 'signal_suggestion' and 'client_revision', and neither is true
// of this write. The revision note is what the version history shows, so it is also the
// honest label for the version this becomes.
const BRIEF_NOTE_PREFIX = 'Outbound brief v'

async function landBrief(supabase: SupabaseClient, orgId: string, briefPath: string) {
  const brief = JSON.parse(fs.readFileSync(briefPath, 'utf-8')) as OutboundBrief
  const problems = validateOutboundBrief(brief)
  if (problems.length > 0) throw new Error(`brief is not valid:\n- ${problems.join('\n- ')}`)
  if (await pendingMessagingSuggestion(supabase, orgId)) {
    throw new Error('a messaging suggestion is already pending for this organisation; approve or reject it first')
  }
  const doc = await activeMessagingDoc(supabase, orgId)
  const content = { ...doc.content, outbound_brief: brief }
  const { data, error } = await supabase.from('document_suggestions').insert({
    organisation_id: orgId,
    segment_id: null,
    document_id: doc.id,
    document_type: 'messaging',
    field_path: 'full_document',
    current_value: doc.plain_text,
    suggested_value: JSON.stringify(content),
    suggestion_reason:
      `Outbound brief v${brief.brief_version} added to the messaging document (Round 7 of the firm-fact tier plan). ` +
      `Templates are unchanged in this step. Unconfirmed items: ${brief.unconfirmed_items.join(', ') || 'none'}.`,
    confidence_level: 'high',
    signal_count: 0,
    status: 'pending',
    generated_by_model: null,
    revision_note: `${BRIEF_NOTE_PREFIX}${brief.brief_version} added`,
  }).select('id').single()
  if (error) throw new Error(`insert failed: ${error.message}`)
  console.log(`Pending messaging suggestion ${data.id}: live v${doc.version} content plus outbound_brief v${brief.brief_version}.`)
}

async function generate(supabase: SupabaseClient, orgId: string, outPath: string | undefined, flags: RunFlags) {
  const pending = await pendingMessagingSuggestion(supabase, orgId)
  if (!pending) throw new Error('no pending messaging suggestion; land the brief first with --brief')
  // Either note is this script's: a suggestion --tier created holds the live document with
  // the switch changed, and regenerating into it is what "carried through every later
  // regeneration" means. Until 2026-10-02 only the brief's note was accepted, and such a
  // suggestion was refused as "not created by this script".
  if (!pending.revision_note?.startsWith(BRIEF_NOTE_PREFIX) && !pending.revision_note?.startsWith(TIER_NOTE_PREFIX)) {
    throw new Error(`the pending messaging suggestion was not created by this script (revision note "${pending.revision_note}"); refusing to overwrite it`)
  }
  const pendingContent = JSON.parse(pending.suggested_value) as Record<string, unknown>
  // --brief with --generate replaces the pending brief (a correction before approval).
  const briefPath = flags.briefPath
  const read = readBrief(briefPath ? { outbound_brief: JSON.parse(fs.readFileSync(briefPath, 'utf-8')) } : pendingContent)
  if (!read.brief) {
    // Say WHY. "No valid brief" with the reasons thrown away sent the reader to look for a
    // brief that was sitting right there in an older shape.
    throw new Error(read.present
      ? `the outbound brief (${briefPath ? '--brief file' : 'pending suggestion'}) is not valid:\n- ${read.problems.join('\n- ')}`
      : `no outbound_brief in the ${briefPath ? '--brief file' : 'pending suggestion'}`)
  }
  const brief = read.brief

  const { maxUsd } = flags
  const signoff = await fetchSenderSignoff(supabase, orgId)
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing')

  const started = Date.now()
  let result
  try {
    // --keep A,C keeps those variants (and the opener frames): from the pending suggestion,
    // or with --keep-from from a failed run's saved attempt. Kept variants are never
    // trusted: the generator re-checks and re-judges them like any other.
    const keepKeys = (arg('keep') ?? '').split(',').map(k => k.trim()).filter(Boolean)
    let keep: { opener_frames: string[]; variants: Record<string, VariantLines> } | undefined
    if (keepKeys.length > 0) {
      const keepFrom = arg('keep-from')
      let frames: string[] | undefined
      let source: Record<string, VariantLines | undefined>
      if (keepFrom) {
        const saved = JSON.parse(fs.readFileSync(keepFrom, 'utf-8')) as { opener_frames?: string[]; variants?: Record<string, VariantLines> }
        frames = saved.opener_frames
        source = saved.variants ?? {}
      } else {
        const pv = (pendingContent.variants ?? {}) as Record<string, { lines?: VariantLines }>
        frames = pendingContent.opener_frames as string[] | undefined
        source = Object.fromEntries(Object.entries(pv).map(([k, v]) => [k, v.lines]))
      }
      const missing = keepKeys.filter(k => !source[k]?.email1)
      if (!frames || missing.length > 0) {
        throw new Error(`cannot keep ${missing.join(', ') || 'the opener frames'}: not in ${keepFrom ?? 'the pending suggestion'}`)
      }
      keep = { opener_frames: frames, variants: Object.fromEntries(keepKeys.map(k => [k, source[k]!])) }
    }
    result = await generateOutboundTemplates({
      brief, signoff, apiKey, keep, maxUsd,
      ...(flags.draft ? { model: OUTBOUND_TEMPLATE_DRAFT_MODEL } : {}),
    })
  } catch (err) {
    if (err instanceof OutboundTemplateFailure) {
      const failedPath = outPath
        ? outPath.replace(/\.json$/, '.failed.json')
        : path.join(process.cwd(), '.writer-export', `templates-failed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
      fs.mkdirSync(path.dirname(failedPath), { recursive: true })
      fs.writeFileSync(failedPath, JSON.stringify(err.attempt, null, 2))
      console.log(`Spend: $${templateRunCostUsd(err.attempt.usage).toFixed(2)} at full price, of a $${maxUsd.toFixed(2)} cap.`)
      printUnplacedQuotes(err.attempt.unnatural_not_in_line)
      const passed = Object.keys(err.attempt.variants).filter(k => !err.attempt.dropped[k])
      console.log(`Failed attempt written to ${failedPath}`)
      if (passed.length > 0) console.log(`To keep what passed: --generate --keep ${passed.join(',')} --keep-from ${failedPath}`)
    }
    throw err
  }
  // SAVED BEFORE ANYTHING ELSE CAN FAIL. A passing result is paid for and exists only in
  // memory here; the three steps below (reading the live document, building the content,
  // writing the suggestion) can each throw, and each used to take the result with it.
  // In the shape --keep-from reads, so every variant can be kept on a rerun.
  const savedPath = outPath
    ? outPath.replace(/\.json$/, '.result.json')
    : path.join(process.cwd(), '.writer-export', `templates-result-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.mkdirSync(path.dirname(savedPath), { recursive: true })
  fs.writeFileSync(savedPath, JSON.stringify(result, null, 2))
  console.log(`Result saved to ${savedPath} before the suggestion is written.`)

  const doc = await activeMessagingDoc(supabase, orgId)
  // THE SWITCH IS CARRIED, NEVER RESET. --tier sets it; otherwise it is whatever the pending
  // suggestion holds, which is what the live document held when the brief was landed. ON
  // needs no check here: this run has just built the frames and every variant's lines from
  // this brief, which is everything setTier checks.
  const tierEnabled = flags.tier ?? tierIsOn(pendingContent)
  const content = buildMessagingContent({ base: doc.content, brief, result, signoff, firmFactTierEnabled: tierEnabled })
  // WHO WROTE IT, AS THE OPERATOR SAYS when this run only kept lines written elsewhere.
  const writer = flags.writtenBy ?? result.model ?? OUTBOUND_TEMPLATE_MODEL

  const droppedNote = Object.keys(result.dropped).length > 0
    ? ` Dropped after repairs: ${Object.entries(result.dropped).map(([k, r]) => `${k} (${r.length} failures)`).join(', ')}.`
    : ''
  const { error } = await supabase.from('document_suggestions').update({
    suggested_value: JSON.stringify(content),
    generated_by_model: writer,
    suggestion_reason:
      `Outbound brief v${brief.brief_version} plus templates regenerated from the brief only by outbound-template-agent, ` +
      `written by ${writer}, old templates hidden from the agent. Variants: ${Object.keys(result.variants).sort().join(', ')}.` +
      droppedNote + ` Firm-fact tier ${tierEnabled ? 'ON' : 'OFF'} for this client in this document.`,
    revision_note: `${BRIEF_NOTE_PREFIX}${brief.brief_version} and templates generated from it`,
  }).eq('id', pending.id).eq('status', 'pending')
  if (error) throw new Error(`update failed: ${error.message}`)

  console.log(`Suggestion ${pending.id} updated. ${result.calls} model calls, ${Math.round((Date.now() - started) / 1000)}s.`)
  console.log(`Spend: $${templateRunCostUsd(result.usage).toFixed(2)} at full price, of a $${maxUsd.toFixed(2)} cap. Writer: ${writer}. Firm-fact tier: ${tierEnabled ? 'ON' : 'OFF'}.`)
  console.log('Usage:', JSON.stringify(result.usage))
  printUnplacedQuotes(result.unnatural_not_in_line)
  if (Object.keys(result.dropped).length > 0) console.log('Dropped:', JSON.stringify(result.dropped, null, 2))
  // Every exclusion the scope judge raises is a failure, so a variant that is here passed
  // with none: the judge ran clean on every line of the stored wording.
  console.log(`Scope judge: clean on all ${Object.keys(result.variants).length} variants (any exclusion, claim beyond scope or unanswered line fails a variant).`)
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({ suggestion_id: pending.id, signoff, content, dropped: result.dropped, usage: result.usage }, null, 2))
    console.log(`Wrote ${outPath}`)
  }
}

/**
 * Why the firm-fact tier cannot be switched ON for this document content, or nothing.
 *
 * Research pays for a firm fact for every researched prospect once the switch is on and a
 * brief is there. Composition can use one only with opener frames and every variant's lines
 * at the brief's version: without them each prospect falls back to the template, and every
 * fact bought is wasted. Refused here, where it costs nothing.
 */
function whyTierCannotRun(content: Record<string, unknown>): string[] {
  const read = readBrief(content)
  if (!read.brief) {
    return [read.present ? `the outbound brief is not valid: ${read.problems.join('; ')}` : 'the document holds no outbound brief']
  }
  const problems: string[] = []
  const frames = content.opener_frames
  if (!Array.isArray(frames) || !frames.some(frame => typeof frame === 'string' && frame.trim() !== '')) {
    problems.push('the document holds no opener frames')
  }
  const variants = (content.variants ?? {}) as Record<string, { lines?: { brief_version?: unknown } }>
  if (Object.keys(variants).length === 0) problems.push('the document holds no variants')
  for (const [key, variant] of Object.entries(variants)) {
    if (variant?.lines?.brief_version !== read.brief.brief_version) {
      problems.push(`variant ${key} carries no lines at brief v${read.brief.brief_version}: regenerate the templates from the brief with --generate`)
    }
  }
  return problems
}

const TIER_NOTE_PREFIX = 'Firm-fact tier switched '

/**
 * The per-client switch. Sets firm_fact_tier.enabled in the pending messaging suggestion,
 * or, with none pending, creates one that is the live document with only that value
 * changed. Nothing takes effect until the suggestion is approved.
 */
async function setTier(supabase: SupabaseClient, orgId: string, enabled: boolean) {
  const refuseOn = (content: Record<string, unknown>, where: string) => {
    const problems = enabled ? whyTierCannotRun(content) : []
    if (problems.length > 0) throw new Error(`refusing to switch the firm-fact tier ON: ${where}:\n- ${problems.join('\n- ')}`)
  }
  const pending = await pendingMessagingSuggestion(supabase, orgId)
  if (pending) {
    const content = JSON.parse(pending.suggested_value) as Record<string, unknown>
    if (tierIsOn(content) === enabled) {
      console.log(`Suggestion ${pending.id} already holds the firm-fact tier ${enabled ? 'ON' : 'OFF'}. Nothing written.`)
      return
    }
    refuseOn(content, `pending suggestion ${pending.id}`)
    // THE SWITCH IS SAID WHERE THE HISTORY READS IT. Until 2026-10-02 only the content
    // changed, and the suggestion's reason and note still described whatever made it.
    const note = `${TIER_NOTE_PREFIX}${enabled ? 'on' : 'off'}`
    const { error } = await supabase.from('document_suggestions')
      .update({
        suggested_value: JSON.stringify({ ...content, firm_fact_tier: { enabled } }),
        suggestion_reason: `${pending.suggestion_reason ? `${pending.suggestion_reason} ` : ''}Firm-fact tier then switched ${enabled ? 'ON' : 'OFF'} for this client.`,
        revision_note: pending.revision_note ? `${pending.revision_note}; ${note}` : note,
      })
      .eq('id', pending.id).eq('status', 'pending')
    if (error) throw new Error(`update failed: ${error.message}`)
    console.log(`Suggestion ${pending.id}: firm-fact tier set ${enabled ? 'ON' : 'OFF'} for this client. It takes effect when the suggestion is approved.`)
    return
  }
  const doc = await activeMessagingDoc(supabase, orgId)
  if (tierIsOn(doc.content) === enabled) {
    console.log(`The live messaging document (v${doc.version}) already holds the firm-fact tier ${enabled ? 'ON' : 'OFF'}. Nothing written.`)
    return
  }
  refuseOn(doc.content, `the live messaging document (v${doc.version})`)
  const { data, error } = await supabase.from('document_suggestions').insert({
    organisation_id: orgId,
    segment_id: null,
    document_id: doc.id,
    document_type: 'messaging',
    field_path: 'full_document',
    current_value: doc.plain_text,
    suggested_value: JSON.stringify({ ...doc.content, firm_fact_tier: { enabled } }),
    suggestion_reason: `Firm-fact tier switched ${enabled ? 'ON' : 'OFF'} for this client. The brief and every template are unchanged.`,
    confidence_level: 'high',
    signal_count: 0,
    status: 'pending',
    generated_by_model: null,
    revision_note: `${TIER_NOTE_PREFIX}${enabled ? 'on' : 'off'}`,
  }).select('id').single()
  if (error) throw new Error(`insert failed: ${error.message}`)
  console.log(`Pending messaging suggestion ${data.id}: live v${doc.version} with the firm-fact tier ${enabled ? 'ON' : 'OFF'}. Approve it to make it live.`)
}

async function main() {
  const orgId = arg('org')
  if (!orgId) throw new Error('--org <organisation id> is required')
  // Before the database is opened: a typo costs nothing.
  const flags = readFlags()
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })
  if (flags.generate) return generate(supabase, orgId, arg('out'), flags)
  if (flags.briefPath) return landBrief(supabase, orgId, flags.briefPath)
  if (flags.tier !== undefined) return setTier(supabase, orgId, flags.tier)
  throw new Error('pass --brief <file>, --generate, or --tier on|off')
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
