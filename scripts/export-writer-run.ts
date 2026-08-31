// Re-runs the writer over prospects that already hold copy, and WRITES NOTHING.
//
//   npx tsx --env-file=.env.local scripts/export-writer-run.ts <prospect_id> [<prospect_id> ...]
//   npx tsx --env-file=.env.local scripts/export-writer-run.ts --with-question
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// Comparing the writer before and after a prompt change needs the same prospects run
// twice. The existing path cannot do that. run-research.ts --allow-overwrite-trigger
// REPLACES the stored copy on a win and CLEARS it on a hold, and the prospects worth
// measuring are exactly the ones already holding copy. Measuring them with that tool
// destroys the thing being measured, and the second measurement then has no baseline.
//
// So this reproduces the paid half of a reuse run and stops before the two writes.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THE OUTPUT CONTAINS, AND WHY IT IS NOT COMMITTED
//
// Both files hold REAL PROSPECT TEXT: the copy the writer produced for a named prospect,
// now including the attempts that were rejected, and the copy already stored against that
// prospect's row. They go to .writer-export/, which is in .gitignore, and that is the
// whole of the mechanism. Nothing here writes anywhere else and nothing here commits.
//
// If the output directory is ever moved, move the .gitignore entry in the same edit. A
// diagnostic file naming a real person is exactly the thing this repository being PUBLIC
// makes expensive, and the gitignore entry is the only thing standing between the two.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY IT CANNOT WRITE, WHICH IS A STRUCTURAL CLAIM AND NOT AN INTENTION
//
// Two independent mechanisms, because the two failure modes are different.
//
// 1. THE PAID PATH HAS NO DATABASE CLIENT AT ALL. produceOpening takes no SupabaseClient
//    parameter, and neither does anything it calls: write-opening.ts constructs an
//    Anthropic client and nothing else. There is no connection in scope for the writer,
//    the floor or the judge to write through. This is stronger than withholding
//    permission from a client, because there is no client.
//
//    The writes live in the CALLER, not in produceOpening: storeResearchResult and
//    updateProspect in prospect-research-agent-v2.ts, and updateProspect is the only
//    write site for the three personalisation columns. This file is a second caller that
//    stops one line earlier.
//
// 2. THE SCRIPT'S OWN READS GO THROUGH A CLIENT THAT CANNOT EXPRESS A WRITE. The script
//    still has to read four things, so it needs a client for those. readOnlyClient wraps
//    a service-role client in a Proxy with an ALLOWLIST of read methods. insert, update,
//    upsert, delete and rpc are not on it, and neither is anything else: an unlisted
//    method THROWS rather than passing through.
//
//    The allowlist direction is the point. A denylist of write verbs passes anything it
//    was not told about, which is the shape of a fake that silently accepts a call it
//    does not implement and reports success. This one fails loudly on the unknown.
//
//    It is also what catches the real hazard, which is not a stray insert written here.
//    It is calling a production helper that writes as a side effect. loadProspectContext
//    STAMPS prospects.segment_id when it finds it null, and startAgentRun inserts a row.
//    Neither is called below, and if either ever were, the proxy turns a silent write
//    into an immediate throw.
//
// THE ONE GAP, STATED RATHER THAN GLOSSED. loadClientContext builds its own service-role
// client internally, so the proxy does not cover it. It was read instead: it performs
// three selects across segments, organisations and strategy_documents, and no write. That
// is an inspection, which is weaker than a structural guarantee, which is why the
// before-and-after column comparison below is the receipt that actually settles it.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IT REPRODUCES, AND THE TWO PLACES IT DELIBERATELY DIFFERS
//
// Reproduced exactly: stored-findings selection (loadStoredFindings, the same function
// the agent calls, not a copy of its ordering), the approved messaging document, the
// variant, the buyer precedence, and writer, floor and judge via produceOpening.
//
// Differs 1: NO SOURCE CALLS. Findings come off the row, so Apollo, Apify, the website
// and web search are never touched. That is what a reuse run does too.
//
// Differs 3: THE MESSAGING DOCUMENT CAN BE PINNED, and for a comparison it must be.
// By default the production rule applies: the active AND client-approved document, via
// fetchApprovedMessagingDoc. --messaging-doc-id=<uuid> reads a named document instead.
//
// The brief the writer is given is the other half of what it produces. A run against a
// different document is not a rerun of the writer, it is a comparison of two things at
// once, and the difference cannot afterwards be attributed to either. So the document id
// and version are RECORDED PER PROSPECT, and a comparison across two runs should assert
// they match before reading anything else into the copy.
//
// Differs 2: RUNS SERIALLY. Production fans out. Serial gives the prompt cache the best
// possible hit rate, so the measured cost here is a FLOOR: a concurrent batch pays a few
// extra cache writes at the head. Stated because the cost figure is a deliverable.

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import { loadStoredFindings } from '@/lib/agents/prospect-research-agent-v2'
import {
  produceOpening,
  resolveVariantId,
  loadClientName,
  type MessagingContent,
} from '@/lib/agents/research/produce-opening'
import type { AttemptObservation, JudgeComparison } from '@/lib/agents/research/write-opening'
import { loadClientContext } from '@/lib/agents/research/synthesize'
import { fetchApprovedMessagingDoc } from '@/lib/composition/compose-sequence'
import { BatchUniquenessRegistry } from '@/lib/agents/research/batch-uniqueness'
import type { ProspectContext, TokenUsage } from '@/lib/agents/research/types'

// ─── Pricing ─────────────────────────────────────────────────────────────────
//
// Writer, floor and judge are all Sonnet 4.6 (WRITER_MODEL and JUDGE_MODEL in
// write-opening.ts). Published rates, and the cache multipliers Anthropic applies to the
// input rate: a 5-minute cache write is 1.25x input, a cache read is 0.1x input.
//
// A DERIVED FIGURE, NOT AN INVOICE. Per the standing rule that the Anthropic console is
// the ground truth for cost, this number is checked against a console day filtered to the
// run before it is quoted to anyone. It is computed from the usage the API itself
// returned, which is the closest a script can get, and it is still not the bill.
export const USD_PER_MTOK = {
  input:       3.00,
  output:     15.00,
  cacheWrite:  3.75,
  cacheRead:   0.30,
} as const

export function usdForUsage(usage: TokenUsage): number {
  return (
      usage.input_tokens                * USD_PER_MTOK.input
    + usage.output_tokens               * USD_PER_MTOK.output
    + usage.cache_creation_input_tokens * USD_PER_MTOK.cacheWrite
    + usage.cache_read_input_tokens     * USD_PER_MTOK.cacheRead
  ) / 1_000_000
}

// ─── The read-only client ────────────────────────────────────────────────────

/** Methods that read. Everything absent from this set throws, including the write verbs. */
const ALLOWED_BUILDER_METHODS = new Set([
  'select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'filter',
  'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'contains', 'overlaps',
  'order', 'limit', 'range', 'single', 'maybeSingle', 'returns', 'abortSignal',
  'then', 'catch', 'finally',
])

/**
 * Methods that end the chain by handing back something that is no longer a query builder.
 * Their result is returned RAW. Wrapping a Promise in the builder proxy would make its own
 * `then` an unlisted method and deadlock every await in this file.
 */
const TERMINAL_METHODS = new Set(['then', 'catch', 'finally'])

function refuse(what: string): never {
  throw new Error(
    `export-writer-run: ${what} was called on the read-only client. ` +
    'This script must not write. If a read genuinely needs this method, add it to ' +
    'ALLOWED_BUILDER_METHODS deliberately; do not widen the proxy to make an error go away.',
  )
}

function readOnlyBuilder<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      // Symbols are internal plumbing (Symbol.toStringTag, async iteration) and carry no
      // write capability. Passed through so the builder keeps behaving like itself.
      if (typeof prop === 'symbol') return Reflect.get(t, prop, receiver)
      const name = String(prop)
      if (!ALLOWED_BUILDER_METHODS.has(name)) refuse(`query.${name}`)

      const value = Reflect.get(t, prop, receiver)
      if (typeof value !== 'function') return value

      return (...args: unknown[]) => {
        // Bound to the RAW target, never to the proxy, so supabase-js reading its own
        // internal fields does not trip the allowlist. Only this file's property access
        // is policed, which is exactly the surface worth policing.
        const out = (value as (...a: unknown[]) => unknown).apply(t, args)
        if (TERMINAL_METHODS.has(name)) return out
        return out && typeof out === 'object' ? readOnlyBuilder(out as object) : out
      }
    },
  })
}

/**
 * A service-role client that can only reach `.from(...).select(...)`.
 *
 * rpc is refused along with the write verbs: a SECURITY DEFINER function is a write path
 * that does not look like one, and several in this database exist precisely to mutate.
 */
export function readOnlyClient(url: string, serviceKey: string): SupabaseClient {
  const real = createClient(url, serviceKey)
  const guarded = new Proxy(real as unknown as Record<string, unknown>, {
    get(t, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop, receiver)
      const name = String(prop)
      if (name !== 'from') refuse(`client.${name}`)
      return (table: string) => readOnlyBuilder((real.from as (x: string) => object)(table))
    },
  })
  return guarded as unknown as SupabaseClient
}

// ─── Gate classification ─────────────────────────────────────────────────────
//
// Gate failures are free-text sentences written for a model to act on, so counting them
// by gate needs a mapping from that text back to the check that produced it. Each needle
// below is taken from the literal in the gate that emits it.
//
// AN UNRECOGNISED FAILURE IS COUNTED UNDER 'unclassified' AND PRINTED IN FULL. It is not
// dropped and it is not folded into a neighbour. A classifier that silently discards what
// it does not recognise reports a clean histogram of an incomplete count, and the gap is
// invisible in exactly the case that matters, which is a gate added after this was written.
const GATE_PATTERNS: ReadonlyArray<readonly [string, string]> = [
  ['length',                'hard cap of'],
  ['length',                'words, cap is'],
  ['names_prospect',        'names the prospect'],
  ['untraceable_claim',     'claims not traceable to any finding'],
  ['sentence_initial_name', 'opens a sentence with a name'],
  ['firmographic',          "from the prospect's record"],
  ['question_marks',        'question marks'],
  ['offer_line_echo',       'repeats the approved offer line'],
  ['no_finite_verb',        'contains a sentence with no verb'],
  ['missing_question',      'writer returned no closing question'],
  ['missing_observation',   'writer returned no observation'],
  ['missing_bridge',        'writer returned no bridge'],
]

export function classifyGateFailure(failure: string): string {
  for (const [code, needle] of GATE_PATTERNS) {
    if (failure.includes(needle)) return code
  }
  return 'unclassified'
}

// ─── Per-prospect record ─────────────────────────────────────────────────────

interface ProspectRecord {
  prospect_id: string
  organisation_id: string
  variant_id: string
  /**
   * The document the writer was briefed with. RECORDED because it is the other half of
   * what the writer produced: two runs against different documents are not comparable,
   * and this is what lets a later comparison prove they were the same before reading
   * anything into the copy.
   */
  messaging_doc_id: string
  messaging_doc_version: string | null
  /** The research result the findings were reused from, and how many it carried. */
  source_result_id: string
  candidate_count: number
  strong_material: boolean

  observation: string | null
  bridge: string | null
  question: string | null
  subject: string | null

  judge_won: boolean
  judge_reasoning: string
  /** The final attempt's deterministic failures, in the order the gates ran. */
  gate_failures: string[]
  /**
   * Every attempt, so gate failures on rescued attempts are counted rather than lost.
   *
   * NOW CARRIES THE TEXT OF EVERY ATTEMPT, the rejected ones included. Four prospects fell
   * back to template in the last run and the losing words survived nowhere, so those four
   * failures could be counted and not read. The observation, bridge, question and subject
   * of each attempt are on the observation itself, alongside the judge's verdict on the
   * attempts that reached one.
   */
  attempts: AttemptObservation[]
  retries_used: number
  /**
   * EVERY COMPARISON IN FULL, not the length of the array.
   *
   * This field used to be `opening.comparisons.length`. A prospect that lost the first
   * comparison and was rewritten had two verdicts and this recorded the digit 2, so the
   * reasoning on the non-final one was thrown away by the export after the loop had gone
   * to the trouble of keeping it. `comparison_count` below is the number, for anyone who
   * only wanted that.
   */
  comparisons: JudgeComparison[]
  comparison_count: number

  usage: TokenUsage
  usd: number

  /**
   * The three columns this script must not touch, read before and after the run. Equal
   * values are the proof; the script asserting it does not write is not.
   */
  stored_before: { trigger: string | null; question: string | null; subject: string | null }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`export-writer-run: ${name} is not set`)
  return v
}

async function readProspectIds(supabase: SupabaseClient, withQuestion: boolean, argv: string[]): Promise<string[]> {
  if (!withQuestion) return argv
  const { data, error } = await supabase
    .from('prospects')
    .select('id')
    .not('personalisation_question', 'is', null)
    .order('id')
  if (error) throw new Error(`could not list prospects: ${error.message}`)
  return (data ?? []).map(r => r.id as string)
}

/**
 * The messaging document the writer is briefed with.
 *
 * Pinned: read by id, WITHOUT the active-and-approved filter, because the document a
 * baseline needs is usually one that has since been archived. Unpinned: the production
 * rule exactly, by calling the function production calls.
 */
async function loadMessaging(
  supabase: SupabaseClient,
  clientId: string,
  segmentId: string | null,
  pinnedDocId: string | null,
): Promise<{ content: MessagingContent; doc_id: string; version: string | null }> {
  if (!pinnedDocId) {
    const doc = await fetchApprovedMessagingDoc(supabase as never, clientId, segmentId)
    return { content: doc.content as MessagingContent, doc_id: doc.doc_id, version: null }
  }
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('id, content, version, organisation_id, document_type')
    .eq('id', pinnedDocId)
    .single()
  if (error || !data) throw new Error(`pinned messaging document not found: ${pinnedDocId}`)
  // Agent isolation, per CLAUDE.md: a pinned id is operator input and must still be
  // proved to belong to this client before its copy is put in front of this prospect.
  if (data.organisation_id !== clientId) {
    throw new Error(`pinned document ${pinnedDocId} belongs to another organisation`)
  }
  if (data.document_type !== 'messaging') {
    throw new Error(`pinned document ${pinnedDocId} is a ${data.document_type} document, not messaging`)
  }
  return {
    content: data.content as MessagingContent,
    doc_id: data.id as string,
    version: (data.version ?? null) as string | null,
  }
}

async function runOne(
  supabase: SupabaseClient,
  apiKey: string,
  prospectId: string,
  uniqueness: BatchUniquenessRegistry,
  pinnedDocId: string | null,
): Promise<ProspectRecord | null> {
  // A PLAIN SELECT, NOT loadProspectContext. That helper stamps prospects.segment_id when
  // it finds it null, which is correct for the agents and is a WRITE. The proxy would
  // throw on it, but not calling it at all is the better answer: a tool whose claim is
  // that it writes nothing should not depend on a guard firing.
  const { data: p, error } = await supabase
    .from('prospects')
    .select('id, organisation_id, segment_id, variant_id, first_name, last_name, company_name, role, job_title, email, linkedin_url, website_url, personalisation_trigger, personalisation_question, personalisation_subject')
    .eq('id', prospectId)
    .single()
  if (error || !p) throw new Error(`prospect not found: ${prospectId}`)

  const clientId = p.organisation_id as string
  const ctx: ProspectContext = {
    id:              p.id as string,
    organisation_id: clientId,
    segment_id:      (p.segment_id ?? null) as string | null,
    first_name:      (p.first_name ?? null) as string | null,
    last_name:       (p.last_name ?? null) as string | null,
    company_name:    (p.company_name ?? null) as string | null,
    role:            (p.role ?? null) as string | null,
    job_title:       (p.job_title ?? null) as string | null,
    email:           (p.email ?? null) as string | null,
    linkedin_url:    (p.linkedin_url ?? null) as string | null,
    website_url:     (p.website_url ?? null) as string | null,
  }

  // The same selection the agent uses, called rather than reimplemented. Its ordering is
  // deliberately not "most recent" and a local copy of that rule would be one more pair
  // of implementations with nothing keeping them in step.
  const stored = await loadStoredFindings(supabase as never, prospectId, clientId)
  if (!stored || stored.candidates.length === 0) {
    console.log(`  SKIPPED ${prospectId}: no stored findings with candidates. A reuse run has nothing to write from.`)
    return null
  }

  const messaging = await loadMessaging(supabase, clientId, ctx.segment_id, pinnedDocId)
  const variantId = resolveVariantId(ctx.id, (p.variant_id ?? null) as string | null, messaging.content)
  const clientCtx = await loadClientContext(clientId, ctx.segment_id)

  const attempts: AttemptObservation[] = []
  const opening = await produceOpening({
    apiKey,
    clientName: await loadClientName(supabase as never, clientId),
    ctx,
    candidates: stored.candidates,
    messagingContent: messaging.content,
    variantId,
    icpBuyerTitle: clientCtx.buyerTitle,
    uniqueness,
    onAttempt: o => attempts.push(o),
  })

  return {
    prospect_id:      prospectId,
    organisation_id:  clientId,
    variant_id:       variantId,
    messaging_doc_id:      messaging.doc_id,
    messaging_doc_version: messaging.version,
    source_result_id: stored.result_id,
    candidate_count:  stored.candidates.length,
    strong_material:  opening.strong_material,
    observation:      opening.observation,
    bridge:           opening.bridge,
    question:         opening.question,
    subject:          opening.subject,
    judge_won:        opening.written_won,
    judge_reasoning:  opening.judge_reasoning,
    gate_failures:    opening.gate_failures,
    attempts,
    retries_used:     opening.retries_used,
    comparisons:      opening.comparisons,
    comparison_count: opening.comparisons.length,
    usage:            opening.usage,
    usd:              usdForUsage(opening.usage),
    stored_before: {
      trigger:  (p.personalisation_trigger  ?? null) as string | null,
      question: (p.personalisation_question ?? null) as string | null,
      subject:  (p.personalisation_subject  ?? null) as string | null,
    },
  }
}

/** The side-by-side rendering. Old copy on the left, this run's on the right. */
function renderText(records: ProspectRecord[], startedAt: string): string {
  const L: string[] = []
  const rule = (ch: string) => ch.repeat(78)

  L.push(rule('='))
  L.push(`WRITER RE-RUN, READ ONLY. ${startedAt}`)
  L.push(`${records.length} prospects. No database write was performed.`)
  L.push(rule('='))

  for (const r of records) {
    L.push('')
    L.push(rule('-'))
    L.push(`PROSPECT ${r.prospect_id}   variant ${r.variant_id}   findings from ${r.source_result_id}`)
    L.push(`messaging document ${r.messaging_doc_id}${r.messaging_doc_version ? ` v${r.messaging_doc_version}` : ''}`)
    L.push(`candidates ${r.candidate_count}   strong_material ${r.strong_material}   retries ${r.retries_used}   comparisons ${r.comparison_count}`)
    L.push(rule('-'))

    L.push('')
    L.push('  STORED (unchanged by this run)')
    L.push(`    trigger : ${JSON.stringify(r.stored_before.trigger)}`)
    L.push(`    question: ${JSON.stringify(r.stored_before.question)}`)
    L.push(`    subject : ${JSON.stringify(r.stored_before.subject)}`)

    L.push('')
    L.push(`  THIS RUN  judge ${r.judge_won ? 'WON (would have shipped)' : 'LOST (template would ship)'}`)
    L.push(`    observation: ${JSON.stringify(r.observation)}`)
    L.push(`    bridge     : ${JSON.stringify(r.bridge)}`)
    L.push(`    question   : ${JSON.stringify(r.question)}`)
    L.push(`    subject    : ${JSON.stringify(r.subject)}`)

    L.push('')
    L.push(`  JUDGE: ${r.judge_reasoning}`)

    if (r.gate_failures.length > 0) {
      L.push('')
      L.push('  GATE FAILURES ON THE FINAL ATTEMPT, in gate order:')
      r.gate_failures.forEach((f, i) => L.push(`    ${i + 1}. [${classifyGateFailure(f)}] ${f}`))
    }

    L.push('')
    L.push('  ATTEMPTS, INCLUDING THE REJECTED ONES:')
    for (const a of r.attempts) {
      const gates = a.gate_failures.map(f => classifyGateFailure(f)).join(', ')
      L.push(`    attempt ${a.attempt}: ${a.kind}${gates ? ` (${gates})` : ''}`)
      // The words that failed. Printed under every attempt rather than only the losing
      // ones: a rescued attempt's text is what the retry was measured against, and reading
      // the pair is the only way to see what the feedback actually changed.
      L.push(`      observation: ${JSON.stringify(a.observation)}`)
      L.push(`      bridge     : ${JSON.stringify(a.bridge)}`)
      L.push(`      question   : ${JSON.stringify(a.question)}`)
      L.push(`      subject    : ${JSON.stringify(a.subject)}`)
      if (a.subject_discarded !== null) {
        L.push(`      subject rejected by its own soft gate: ${JSON.stringify(a.subject_discarded)}`)
      }
      if (a.judge_reasoning !== null) {
        L.push(`      judge ${a.judge_written_won ? 'WON' : 'lost'}: ${a.judge_reasoning}`)
      }
      if (a.gate_failures.length > 0) {
        a.gate_failures.forEach(f => L.push(`      gate [${classifyGateFailure(f)}] ${f}`))
      }
    }

    // EVERY COMPARISON, not just the final one. r.judge_reasoning above is the last
    // verdict; a rewritten prospect has an earlier one and it is the more interesting of
    // the two, because it is the verdict the rewrite was answering.
    if (r.comparisons.length > 0) {
      L.push('')
      L.push('  COMPARISONS, in order:')
      r.comparisons.forEach((c, i) => {
        L.push(`    ${i + 1}. written was ${c.written_label}, judge chose ${c.chosen_label} ` +
               `-> written ${c.written_won ? 'WON' : 'lost'}`)
        L.push(`       ${c.reason}`)
        L.push(`       floor: ${c.floor.claims_private ? 'DISQUALIFIED' : 'passed'} - ${c.floor.reason}`)
      })
    }

    L.push('')
    L.push(`  USAGE: ${r.usage.calls} calls, in ${r.usage.input_tokens}, out ${r.usage.output_tokens}, ` +
           `cache write ${r.usage.cache_creation_input_tokens}, cache read ${r.usage.cache_read_input_tokens}`)
    L.push(`  COST : $${r.usd.toFixed(4)}  (derived from returned usage, not an invoice)`)
  }

  return L.join('\n') + '\n'
}

async function main() {
  const argv = process.argv.slice(2)
  const withQuestion = argv.includes('--with-question')
  const pinnedDocId = argv.find(a => a.startsWith('--messaging-doc-id='))?.split('=')[1] ?? null
  const ids = argv.filter(a => !a.startsWith('--'))
  if (!withQuestion && ids.length === 0) {
    console.error('usage: npx tsx --env-file=.env.local scripts/export-writer-run.ts <prospect_id>... | --with-question [--messaging-doc-id=<uuid>]')
    process.exit(2)
  }

  const supabase = readOnlyClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))
  const apiKey = env('ANTHROPIC_API_KEY')

  const targets = await readProspectIds(supabase, withQuestion, ids)
  console.log(`export-writer-run: ${targets.length} prospects. Writer, floor and judge run per prospect. PAID. Nothing is written.`)
  console.log(pinnedDocId
    ? `messaging document PINNED to ${pinnedDocId}. The active-and-approved rule is bypassed.`
    : 'messaging document resolved by the production rule (active AND client-approved).')

  // ONE REGISTRY FOR THE RUN, which is what a production batch has. A per-prospect
  // registry would only ever reserve against itself, so the bridge and question
  // uniqueness gate could never fire and the gate counts would be wrong by omission.
  const uniqueness = new BatchUniquenessRegistry()

  const startedAt = new Date().toISOString()
  const records: ProspectRecord[] = []
  for (const [i, id] of targets.entries()) {
    console.log(`[${i + 1}/${targets.length}] ${id}`)
    const rec = await runOne(supabase, apiKey, id, uniqueness, pinnedDocId)
    if (rec) {
      records.push(rec)
      console.log(`  judge ${rec.judge_won ? 'WON' : 'lost'}  retries ${rec.retries_used}  $${rec.usd.toFixed(4)}`)
    }
  }

  // ── Aggregates ──
  const won = records.filter(r => r.judge_won).length
  const totalUsd = records.reduce((t, r) => t + r.usd, 0)
  const gateCounts = new Map<string, number>()
  const unclassified: string[] = []
  for (const r of records) {
    for (const a of r.attempts) {
      for (const f of a.gate_failures) {
        const code = classifyGateFailure(f)
        gateCounts.set(code, (gateCounts.get(code) ?? 0) + 1)
        if (code === 'unclassified') unclassified.push(f)
      }
    }
  }
  const retryDist = new Map<number, number>()
  for (const r of records) retryDist.set(r.retries_used, (retryDist.get(r.retries_used) ?? 0) + 1)

  const summary = {
    started_at: startedAt,
    messaging_doc_pinned: pinnedDocId,
    messaging_docs_used: [...new Set(records.map(r => `${r.messaging_doc_id}${r.messaging_doc_version ? ` v${r.messaging_doc_version}` : ''}`))],
    prospects_run: records.length,
    prospects_requested: targets.length,
    judge_wins: won,
    judge_win_rate: records.length > 0 ? won / records.length : null,
    total_usd: totalUsd,
    usd_per_prospect: records.length > 0 ? totalUsd / records.length : null,
    gate_failure_counts: Object.fromEntries([...gateCounts].sort((a, b) => b[1] - a[1])),
    unclassified_gate_failures: unclassified,
    retries_used_distribution: Object.fromEntries([...retryDist].sort((a, b) => a[0] - b[0])),
    total_usage: records.reduce((t, r) => ({
      input_tokens:                t.input_tokens + r.usage.input_tokens,
      output_tokens:               t.output_tokens + r.usage.output_tokens,
      cache_creation_input_tokens: t.cache_creation_input_tokens + r.usage.cache_creation_input_tokens,
      cache_read_input_tokens:     t.cache_read_input_tokens + r.usage.cache_read_input_tokens,
      calls:                       t.calls + r.usage.calls,
    }), { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, calls: 0 }),
    notes: [
      'Nothing was written. produceOpening receives no database client; the script reads through an allowlist proxy.',
      'Ran serially, so the prompt cache hit rate is the best available and the cost is a floor for a concurrent batch.',
      'Cost is derived from usage returned by the API. The Anthropic console is the ground truth.',
      'Records carry real prospect text for every attempt, rejected attempts included. .writer-export/ is gitignored; do not commit these files.',
    ],
  }

  const stamp = startedAt.replace(/[:.]/g, '-')
  const outDir = path.join(process.cwd(), '.writer-export')
  fs.mkdirSync(outDir, { recursive: true })
  const jsonPath = path.join(outDir, `writer-run-${stamp}.json`)
  const textPath = path.join(outDir, `writer-run-${stamp}.txt`)
  fs.writeFileSync(jsonPath, JSON.stringify({ summary, records }, null, 2))
  fs.writeFileSync(textPath, renderText(records, startedAt))

  console.log('\n' + '='.repeat(78))
  console.log(`judge win rate      ${won}/${records.length}` +
    (records.length ? ` = ${(100 * won / records.length).toFixed(1)}%` : ''))
  console.log(`cost                $${totalUsd.toFixed(4)} total` +
    (records.length ? `, $${(totalUsd / records.length).toFixed(4)} per prospect` : ''))
  console.log(`gate failures       ${JSON.stringify(summary.gate_failure_counts)}`)
  console.log(`retries used        ${JSON.stringify(summary.retries_used_distribution)}`)
  if (unclassified.length > 0) {
    console.log(`\nUNCLASSIFIED GATE FAILURES (${unclassified.length}). Add a pattern for each:`)
    for (const u of [...new Set(unclassified)]) console.log(`  ${u}`)
  }
  console.log(`\nwrote ${jsonPath}`)
  console.log(`wrote ${textPath}`)
  console.log('NOTHING WAS WRITTEN TO THE DATABASE.')
}

// Only run when invoked as a script. Importing it from a test must not fire a paid run.
if (process.argv[1] && process.argv[1].includes('export-writer-run')) {
  main().catch(err => {
    console.error('export-writer-run failed:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
