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
import { flattenPositioningText } from '@/lib/agents/research/positioning-text'
import { checkNeedMatchesOffer, type CheckedNeed } from '@/lib/agents/research/need-matches-offer'

const MODEL = 'claude-opus-4-6'

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
export const SYSTEM = `You are given a client's own strategy documents and the trigger list from their
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

  BE PRECISE ABOUT WHOSE PEOPLE THE NEED IS ABOUT, and about what is done to them. Two needs
  can name the same people and different work, or the same work and different people, and
  only one of them may be the work this client does. The document decides, not you.

  ABOUT THE PROSPECT'S NEED, NEVER ABOUT THE SENDER'S OFFER. Say what the event leaves the
  company needing. Do not say what this client's service does, why it works, or what it
  converts.

  FREE OF ANY ASSERTION THE EVENT DOES NOT ESTABLISH. The event is all you know. You do not
  know what their pipeline does, what they already have running, or what they lack.

  FREE OF ANY JUDGEMENT ON WHAT THEY HAVE DONE. Not wasted, not missed, not squandered.

  PLAIN WORDS, SHORT ONES. It must read at a reading grade of 6 or below. Multi-syllable
  business abstractions fail that on their own, and a noun built out of a verb is the usual
  culprit. Prefer one-syllable and two-syllable words and keep the sentence short.

You must also return the trigger SENTENCE with any inference clause removed. A trigger
sentence names the event only. Clauses beginning "signalling", "suggesting", "leaving",
"creating" or "which means" are the reason in the wrong place: move that meaning into the
reason, in your own words, under the rules above, and return the sentence naming only what
happened.

Return ONLY this JSON, with one entry per trigger, in the order given:

{"triggers":[{"index":1,"trigger":"the event, with no inference clause","reason":"under ${TRIGGER_REASON_MAX_WORDS} words"}]}`

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

  // ═══ THE SAME CORPUS AND THE SAME CHECK THE COPY GATES USE ═══
  //
  // flattenPositioningText numbers and labels each leaf, and checkNeedMatchesOffer requires
  // the model to CITE one. This file used to carry its own whole-document quote search, and
  // two implementations of "does the document support this" are two things to keep in step.
  // The line-scoped one is also strictly stronger: a quote can be genuine and lifted from a
  // line describing what OTHER providers do.
  //
  // FIXING IT HERE IS THE POINT. A reason is written once per client and every email that
  // client sends argues from it, so a reason naming work nobody does is the SOURCE of the
  // fault the copy gates were catching one email at a time.
  const positioningText = flattenPositioningText(
    (others ?? []).find(d => d.document_type === 'positioning')?.content ?? {},
  )
  if (!positioningText.trim()) {
    throw new Error('no ACTIVE positioning document for this organisation: a reason cannot be verified against nothing')
  }

  let verdictsForOutput: CheckedNeed[] = []
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

    const faults = findEvidenceFaults(merged)
    console.log(`attempt ${attempt + 1}: ${faults.length} gate fault(s)`)
    if (faults.length === 0) {
      // ── THE SECOND CHECK: does the client's own document say they do this? ──
      //
      // The reason is the TEXT, the trigger only the heading. The need lives in the reason;
      // the trigger is the event, and the prompt's own rule is to judge the work rather than
      // the situation, so putting the event in front of the model as content invites the
      // mistake the rule exists to stop.
      const positions = rewritten.map((_t, i) => (only ? [...only][i] : i + 1))
      const nm = await checkNeedMatchesOffer({
        apiKey: process.env.ANTHROPIC_API_KEY!,
        positioningText,
        sections: rewritten.map((t, i) => ({
          id: positions[i],
          heading: `Trigger ${positions[i]}: ${t.trigger}`,
          text: t.reason,
        })),
        shown: `${rewritten.length} trigger reason${rewritten.length === 1 ? '' : 's'}`,
        labelOf: id => `reason ${id}`,
        prospectId: `icp-${docId}`,
      })
      for (const n of nm.needs) {
        const cited = n.line !== null
        console.log(`  reason ${n.id}: ${cited ? `cites line ${n.line}` : 'NO CITATION'}`)
        console.log(cited ? `     quote: "${n.quote}"` : `     why:   ${n.why}`)
      }
      if (nm.failures.length > 0) {
        feedback = [
          `${nm.failures.length} reason(s) name a need this client's positioning document does not`,
          'support. Rewrite those so the need is one the document names work for.',
          '',
          ...nm.failures.map(f => `  ${f}`),
        ].join('\n')
        console.log(`\n${feedback}\n`)
        continue
      }
      verdictsForOutput = nm.needs
    }
    if (faults.length === 0) {
      writeFileSync(out, JSON.stringify({ document_id: docId, version: doc.version, triggers: merged, verdicts: verdictsForOutput }, null, 2))
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

// ONLY WHEN RUN AS A SCRIPT. Importing this file must not start a derivation, which is what
// it did the first time a test tried to import it.
if (process.argv[1] && process.argv[1].includes('derive-trigger-reasons')) {
  main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
}
