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

  const content = doc.content as Record<string, unknown>
  const tier1 = (content.tier_1 ?? {}) as Record<string, unknown>
  const triggers = Array.isArray(tier1.triggers) ? tier1.triggers as Array<Record<string, unknown>> : []
  if (triggers.length === 0) throw new Error('that document has no tier_1.triggers')

  // THE CLIENT'S OWN DOCUMENTS, as context. Their positioning says what they sell, which is
  // the half of "why this creates a need" that the ICP alone cannot supply.
  const { data: others } = await sb
    .from('strategy_documents')
    .select('document_type, content')
    .eq('organisation_id', doc.organisation_id)
    .in('document_type', ['positioning', 'tov'])
    .eq('status', 'active')

  const context = {
    icp_tier_1: tier1,
    other_documents: (others ?? []).map(d => ({ type: d.document_type, content: d.content })),
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, timeout: 300_000, maxRetries: 2 })

  let feedback: string | null = null
  // SEVEN ATTEMPTS, quoting the offending items each time. The same shape the ICP generator's
  // own gate uses: the rule is already in the system prompt, and what the model has not been
  // shown is which of its own lines broke it.
  //
  // SEVEN RATHER THAN TWO because a reading grade of 6 inside 15 words is a genuinely tight
  // target, and the first run under it failed all eleven at grades of 10 to 14. A gate that
  // is hard to satisfy needs more chances to satisfy it, or it becomes a gate nobody can
  // pass and therefore a gate somebody exempts.
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
    const merged = triggers.map((t, i) => {
      const got = parsed.triggers.find(p => p.index === i + 1)
      return {
        trigger: got?.trigger?.trim() || String(t.trigger),
        reason: got?.reason?.trim() ?? '',
        evidence_to_find: t.evidence_to_find,
      }
    })

    const faults = findEvidenceFaults(merged)
    console.log(`attempt ${attempt + 1}: ${faults.length} gate fault(s)`)
    if (faults.length === 0) {
      writeFileSync(out, JSON.stringify({ document_id: docId, version: doc.version, triggers: merged }, null, 2))
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

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
