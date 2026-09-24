#!/usr/bin/env npx tsx
/**
 * Give every trigger in an existing ICP its own reason, drafted by the model from that
 * client's own documents.
 *
 * GENERIC. Nothing in this file names a client, a market, a service or a buyer. It reads the
 * document identified by --doc, sends that document's own content, and writes a JSON file
 * for review. Run it for any client whose ICP predates the reason field.
 *
 * WHY A TARGETED CALL AND NOT A REGENERATION. Re-running the ICP generator would produce a
 * different trigger LIST. The list here is already approved; what is missing is the reason
 * on each one. This preserves the triggers and adds to them.
 *
 * IT WRITES NOTHING TO THE DATABASE. Output goes to a file, for a human to read before any
 * suggestion is landed.
 *
 *   npx tsx --env-file=.env.local scripts/derive-trigger-reasons.ts --doc <uuid> --out <path>
 */

import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { writeFileSync } from 'node:fs'
import { findEvidenceFaults, evidenceFaultFeedback, TRIGGER_REASON_MAX_WORDS } from '@/agents/trigger-evidence-gate'

const MODEL = 'claude-opus-4-6'

/**
 * ═══ THE GATE CANNOT DEMAND A FIX THIS SCRIPT WILL NOT SEND ═══════════════════
 *
 * findEvidenceFaults judges the WHOLE trigger object. This script rewrites two of its
 * three fields: the sentence and the reason. `evidence_to_find` is carried through
 * byte-identical, deliberately, because the evidence list is approved content and
 * re-deriving it is a different job.
 *
 * So a fault on an evidence line is one the model is never shown, never asked to repair,
 * and could not repair if it were. Gating on it makes the loop unwinnable: seven attempts
 * burn seven calls, every one of them rejected for a line none of them wrote, and nothing
 * is written. Measured 2026-09-24 on two separate clients' live ICPs, both of which
 * carried a pre-existing evidence fault and neither of which could be given reasons at all.
 *
 * These three kinds are produced ONLY inside the `for (const raw of evidence)` loop in
 * findEvidenceFaults. They cannot arise from a reason or a trigger sentence, so exempting
 * them here cannot hide a fault in the text this script does write. The test alongside
 * this constant is what keeps that true as the gate grows.
 *
 * They are NOT ignored. They are reported on every attempt and recorded in the output
 * file, because they are real faults in the document, owed a separate repair that changes
 * the evidence list on purpose.
 */
export const CARRIED_FAULT_KINDS: ReadonlySet<string> = new Set(['figure', 'absence', 'record_field'])



function arg(n: string): string | undefined {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/**
 * THE SHAPE RULE, AND NOTHING ELSE. This is the same rule as HOW TO WRITE TRIGGERS in the
 * ICP prompt, stated for a targeted call. It says what a reason must BE. It never says what
 * any client's reasons are, and it carries no example, because an example in a prompt is
 * lifted verbatim into output often enough that this project bans them outright.
 */
const SYSTEM = `You are given a client's own strategy documents and the trigger list from their
ICP. Each trigger is one thing that happens at a prospect company and is visible from outside.

Your job is to write, for each trigger, ONE short principle saying why that event creates a
need for what THIS client sells. Derive it from the documents you are given and from nothing
else.

Every reason must be:

  UNDER ${TRIGGER_REASON_MAX_WORDS} WORDS, in plain words a stranger would use.

  TRUE FOR ANY COMPANY THE TRIGGER DESCRIBES. If it only holds for companies of a certain
  size, or run a certain way, it is a guess and not the reason.

  FREE OF ANY CLAIM ABOUT WHO DOES THE SELLING. Not who owns pipeline, not who handles
  outreach, not whether anyone has been hired to. You do not know how a company is staffed.

  FREE OF ANY CLAIM ABOUT ANYONE'S TIME. Not busy, not stretched, not short of hours, not
  absorbed in delivery. You do not know how anyone's week goes.

  A CONSEQUENCE OF THE EVENT. What is now true, or now needed, that was not before.

  IT DESCRIBES A NEED THIS CLIENT'S SERVICE DIRECTLY MEETS, as their own positioning
  document describes that service. Read what the service does and name a need it does. Do
  not assume it does anything the document does not say.

  THE COMMONEST WAY TO BREAK THIS is to name a need about the prospect's OWN AUDIENCE: their
  readers, listeners, attendees, followers, subscribers or site visitors. Unless the
  positioning document says this client contacts a prospect's existing audience, a reason
  about converting that audience describes work nobody is offering, and the copy written
  from it promises it.

  ABOUT THE PROSPECT'S NEED, NEVER ABOUT THE SENDER'S OFFER. Say what the event leaves the
  company needing. Do not say what this client's service does, why it works, or what it
  converts.

  FREE OF ANY ASSERTION THE EVENT DOES NOT ESTABLISH. The event is all you know. You do not
  know what their pipeline does, what they already have running, or what they lack.

  FREE OF ANY JUDGEMENT ON WHAT THEY HAVE DONE. Not wasted, not missed, not squandered.

  PLAIN WORDS, SHORT ONES. It must read at a reading grade of 6 or below. Strategy vocabulary
  fails that on its own: pipeline generation, inbound interest, credibility anchor,
  conversion, systematic, qualified conversations, revenue expectations. Prefer one-syllable
  and two-syllable words and keep the sentence short.

You must also return the trigger SENTENCE with any inference clause removed. A trigger
sentence names the event only. Clauses beginning "signalling", "suggesting", "leaving",
"creating" or "which means" are the reason in the wrong place: move that meaning into the
reason, in your own words, under the rules above, and return the sentence naming only what
happened.

Return ONLY this JSON, with one entry per trigger, in the order given:

{"triggers":[{"index":1,"trigger":"the event, with no inference clause","reason":"under ${TRIGGER_REASON_MAX_WORDS} words"}]}`

/**
 * THE POSITIONING DOCUMENT AS PLAIN TEXT, every string value in it, so a quoted sentence can
 * be checked against the whole document rather than one field somebody remembered to include.
 */
function flattenStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) flattenStrings(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) flattenStrings(v, out)
  return out
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim()
}

export interface ReasonVerdict {
  index: number
  supported: boolean
  /** The sentence from the positioning document that names the work meeting this need. */
  quote: string
  /** Why it is unsupported. Empty when supported. */
  explanation: string
}

/**
 * A REASON MUST POINT AT THE WORK THAT MEETS IT.
 *
 * The syntactic gates cannot tell "a need this service meets" from "a need something else
 * would meet": word count, reading grade and the capacity patterns all pass a reason
 * describing work nobody is offering. Three reasons survived every one of them while
 * describing follow-up of the prospect's own audience, which this client does not do.
 *
 * So the check is a second model call that has to POINT: for each reason, quote the sentence
 * of the client's own positioning document that names the work meeting that need. A reason it
 * cannot point for is rejected.
 *
 * THE QUOTE IS VERIFIED IN CODE. A verifier that can invent its evidence is not a verifier,
 * so a quote that does not appear in the positioning document counts as no quote at all.
 */
export function checkQuotesAreReal(
  verdicts: ReasonVerdict[],
  positioningText: string,
): ReasonVerdict[] {
  const haystack = normalise(positioningText)
  return verdicts.map(v => {
    if (!v.supported) return v
    const quote = normalise(v.quote ?? '')
    if (quote.length >= 20 && haystack.includes(quote)) return v
    return {
      ...v,
      supported: false,
      explanation: v.quote
        ? `the sentence quoted as support does not appear in the positioning document: "${v.quote}"`
        : 'marked supported but quoted no sentence',
    }
  })
}


const VERIFIER_SYSTEM = `You are checking whether each REASON describes a need that this
client's service actually meets.

You are given the client's positioning document and a list of reasons. For each reason, find
the SENTENCE in the positioning document that names the work meeting that need, and quote it
EXACTLY as it appears. Copy it character for character. Do not paraphrase it, do not join two
sentences, and do not quote a sentence you cannot find.

If no sentence in the document names work that meets the need, the reason is UNSUPPORTED.
Say so and explain in one sentence what the reason asks for that the document does not offer.

JUDGE THE WORK, NOT THE SITUATION. The reason names a NEED. Your only question is whether the
document describes work that MEETS that need. It does not matter whether the document mentions
the event that created the need, that kind of company, or that moment in a company's life: a
trigger is a reason to call NOW, and the document is not expected to list them.

  SUPPORTED: the need is "reach buyers who have not heard of them" and the document says the
  client reaches new buyers. Same work, whatever prompted the need.

  UNSUPPORTED: the need is "convert the people who already follow them" and the document says
  the client reaches new buyers. Different work: one starts conversations with strangers, the
  other follows up an audience the prospect already built.

So be strict about WHOSE PEOPLE the need is about, and about what is done to them, and
indifferent to everything else. If you find yourself rejecting a reason because the document
does not mention the trigger, the award, the launch or the hire, you are judging the
situation, and the answer is SUPPORTED.

Return ONLY this JSON:

{"verdicts":[{"index":1,"supported":true,"quote":"the sentence, exactly","explanation":""}]}`

/**
 * WHAT THE CALL COST, printed rather than assumed. A script that spends money and says
 * nothing about it makes a budget impossible to hold to: the only record was the vendor
 * console, hours later. Purely a log line, so nothing about the derivation changes.
 */
function logUsage(label: string, usage: unknown): void {
  const u = (usage ?? {}) as Record<string, number | undefined>
  console.log(
    `  [usage] ${label} in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} ` +
    `cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0}`,
  )
}

export async function verifyReasons(
  client: Anthropic,
  positioningText: string,
  reasons: Array<{ index: number; trigger: string; reason: string }>,
): Promise<ReasonVerdict[]> {
  const res = await client.messages.create({
    model: MODEL, max_tokens: 3000, temperature: 0,
    system: VERIFIER_SYSTEM,
    messages: [{ role: 'user', content: [
      `THE CLIENT'S POSITIONING DOCUMENT:\n${positioningText}`,
      `THE REASONS:\n${JSON.stringify(reasons, null, 2)}`,
    ].join('\n\n') }],
  })
  logUsage('verifier', res.usage)
  const text = res.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  const parsed = JSON.parse(json) as { verdicts: ReasonVerdict[] }
  return checkQuotesAreReal(parsed.verdicts ?? [], positioningText)
}

async function main() {
  const docId = arg('doc')
  const out = arg('out')
  if (!docId || !out) {
    console.error('Usage: --doc <strategy_documents.id> --out <path.json>')
    process.exit(1)
  }

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const { data: doc, error } = await sb
    .from('strategy_documents')
    .select('id, organisation_id, document_type, version, status, content')
    .eq('id', docId).single()
  if (error || !doc) throw new Error(`could not read document ${docId}: ${error?.message}`)
  // THE ACTIVE VERSION OR NOTHING. Pointed at a superseded version this script reported
  // eight reasons missing and two inference clauses present, all of which were that old
  // version's real state and none of which was true of the live document. A derivation that
  // silently reads the wrong version produces a suggestion against copy nobody is using.
  if (doc.status !== 'active') {
    throw new Error(
      `document ${docId} is "${doc.status}", not active. Re-derivation must read the live ` +
      `document: pass the id of the active ${doc.document_type} for this organisation.`,
    )
  }

  const content = doc.content as Record<string, unknown>
  const tier1 = (content.tier_1 ?? {}) as Record<string, unknown>
  const allTriggers = Array.isArray(tier1.triggers) ? tier1.triggers as Array<Record<string, unknown>> : []
  if (allTriggers.length === 0) throw new Error('that document has no tier_1.triggers')

  // A SUBSET, BY 1-BASED POSITION. Re-deriving the whole list to fix three of them would
  // rewrite eight reasons that were read and approved, and a reason nobody asked to change
  // changing anyway is how an approval stops meaning anything.
  const onlyArg = arg('only')
  const only = onlyArg ? new Set(onlyArg.split(',').map(n => Number(n.trim()))) : null
  const triggers = allTriggers.filter((_t, i) => !only || only.has(i + 1))
  if (only) console.log(`re-deriving ${triggers.length} of ${allTriggers.length}: positions ${[...only].join(', ')}`)

  // THE CLIENT'S OWN DOCUMENTS, as context. Their positioning says what they sell, which is
  // the half of "why this creates a need" that the ICP alone cannot supply.
  const { data: others } = await sb
    .from('strategy_documents')
    .select('document_type, content')
    .eq('organisation_id', doc.organisation_id)
    .in('document_type', ['positioning', 'tov'])
    .eq('status', 'active')

  // ═══ THE REASON BEING REWRITTEN IS HIDDEN, NOT JUST OMITTED FROM THE TRIGGER LIST ═══
  //
  // THE TRIGGERS block below has always sent {index, trigger} and no reason. The documents
  // block sent `tier_1` WHOLE, and tier_1.triggers carries every reason, so the model read
  // the very sentence it was asked to replace and handed it back: on 2026-09-24 one reason
  // came back byte-identical and another changed a single word.
  //
  // This is the same failure as the trigger generator copying the previous version's
  // triggers until they were hidden from it. A model shown the answer returns the answer,
  // and no instruction to ignore it has ever worked here. The fix is the same one: stop
  // showing it.
  //
  // ONLY THE ONES BEING REWRITTEN are redacted. The rest keep their reasons, because they
  // are real content about this client and the model needs to know what the list already
  // covers to avoid writing the same need twice.
  const redactedTier1 = {
    ...tier1,
    triggers: allTriggers.map((t, i) => {
      if (!only || !only.has(i + 1)) return t
      const { reason: _hidden, ...withoutReason } = t as Record<string, unknown>
      return withoutReason
    }),
  }

  const context = {
    icp_tier_1: redactedTier1,
    other_documents: (others ?? []).map(d => ({ type: d.document_type, content: d.content })),
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, timeout: 300_000, maxRetries: 2 })

  const positioningText = flattenStrings(
    (others ?? []).find(d => d.document_type === 'positioning')?.content ?? {},
  ).join('\n')
  if (!positioningText.trim()) {
    throw new Error('no ACTIVE positioning document for this organisation: a reason cannot be verified against nothing')
  }

  let verdictsForOutput: ReasonVerdict[] = []
  let feedback: string | null = null
  // SEVEN ATTEMPTS, quoting the offending items each time. The same shape the ICP generator's
  // own gate uses: the rule is already in the system prompt, and what the model has not been
  // shown is which of its own lines broke it.
  //
  // SEVEN RATHER THAN TWO because a reading grade of 6 inside 15 words is a genuinely tight
  // target, and the first run under it failed all eleven at grades of 10 to 14. A gate that
  // is hard to satisfy needs more chances to satisfy it, or it becomes a gate nobody can
  // pass and therefore a gate somebody exempts.
  // The same loop serves both checks. A verifier rejection sets feedback and continues,
  // so a reason that cannot point at the document is redrafted with the reason quoted back.
  for (let attempt = 0; attempt < 7; attempt++) {
    const user = [
      `THE CLIENT'S DOCUMENTS:\n${JSON.stringify(context, null, 2)}`,
      `THE TRIGGERS, in order:\n${JSON.stringify(triggers.map((t, i) => ({ index: i + 1, trigger: t.trigger })), null, 2)}`,
      feedback ? `\nYOUR PREVIOUS ANSWER BROKE THE RULES:\n${feedback}\n\nRewrite every entry so none of them does.` : '',
    ].filter(Boolean).join('\n\n')

    const res = await client.messages.create({
      model: MODEL, max_tokens: 4000, temperature: 0,
      system: SYSTEM, messages: [{ role: 'user', content: user }],
    })
    logUsage(`draft attempt ${attempt + 1}`, res.usage)
    const text = res.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
    const parsed = JSON.parse(json) as { triggers: Array<{ index: number; trigger: string; reason: string }> }

    // Rebuild the full trigger objects: the model returns only the sentence and the reason,
    // and evidence_to_find is carried forward untouched.
    // MERGED BACK INTO THE FULL LIST at its original positions, so the untouched ones are
    // carried through byte-identical and the output is a complete tier_1.triggers.
    const rewritten = triggers.map((t, i) => {
      const got = parsed.triggers.find(p => p.index === i + 1)
      return {
        trigger: got?.trigger?.trim() || String(t.trigger),
        reason: got?.reason?.trim() ?? '',
        evidence_to_find: t.evidence_to_find,
      }
    })
    let next = 0
    const merged = allTriggers.map((t, i) => (!only || only.has(i + 1)) ? rewritten[next++] : t)

    const allFaults = findEvidenceFaults(merged)
    const faults = allFaults.filter(f => !CARRIED_FAULT_KINDS.has(f.kind))
    const carried = allFaults.filter(f => CARRIED_FAULT_KINDS.has(f.kind))
    console.log(`attempt ${attempt + 1}: ${faults.length} gate fault(s)` +
      (carried.length ? `, ${carried.length} carried fault(s) on evidence this script does not rewrite` : ''))
    for (const c of carried) console.log(`  [carried, not blocking] trigger ${c.trigger_index} ${c.kind}: ${c.detail} — "${c.evidence}"`)
    if (faults.length === 0) {
      // ── THE SECOND CHECK: does the service actually do this? ──────────────
      const verdicts = await verifyReasons(client, positioningText,
        rewritten.map((t, i) => ({ index: [...(only ?? [])][i] ?? i + 1, trigger: t.trigger, reason: t.reason })))
      const unsupported = verdicts.filter(v => !v.supported)
      for (const v of verdicts) {
        console.log(`  reason ${v.index}: ${v.supported ? 'SUPPORTED' : 'UNSUPPORTED'}`)
        if (v.supported) console.log(`     quote: "${v.quote}"`)
        else console.log(`     why:   ${v.explanation}`)
      }
      if (unsupported.length > 0) {
        feedback = [
          `${unsupported.length} reason(s) describe work this client's positioning document does not say they do.`,
          'Rewrite those so the need is one the service meets, as the document describes it.',
          '',
          ...unsupported.map(v => `  reason ${v.index}: ${v.explanation}`),
        ].join('\n')
        console.log(`\n${feedback}\n`)
        continue
      }
      verdictsForOutput = verdicts
    }
    if (faults.length === 0) {
      writeFileSync(out, JSON.stringify({
        document_id: docId, version: doc.version, triggers: merged, verdicts: verdictsForOutput,
        // Recorded so the human reading this file sees the faults the run could not repair.
        carried_faults: carried,
      }, null, 2))
      console.log(`wrote ${out}`)
      for (const [i, m] of merged.entries()) {
        console.log(`\n${i + 1}. ${m.trigger}\n   REASON: ${m.reason}`)
      }
      return
    }
    console.log(evidenceFaultFeedback(faults))
    feedback = evidenceFaultFeedback(faults)
  }
  console.error('\nEvery attempt failed the gate. Nothing written.')
  process.exit(1)
}

// ONLY WHEN RUN AS A SCRIPT. Importing this file to reuse verifyReasons or
// checkQuotesAreReal must not start a derivation, which is what it did the first time a
// test tried to import it.
if (process.argv[1] && process.argv[1].includes('derive-trigger-reasons')) {
  main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
}
