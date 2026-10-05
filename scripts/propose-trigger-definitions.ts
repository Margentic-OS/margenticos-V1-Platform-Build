#!/usr/bin/env npx tsx
/**
 * Propose a written DEFINITION for each of a client's ICP triggers, as a pending ICP
 * suggestion for the operator to approve. Added 2026-10-03.
 *
 * WHAT A DEFINITION IS FOR. Each trigger carries a reason (why the event matters). Nothing
 * said what the event IS, and a one-line trigger is read generously: a blog post introducing
 * a new team member matched a hiring trigger without anyone checking the role. A definition
 * says what counts and what does not, synthesis is shown it, and the fact a personalised
 * opening rests on is read against it before the writer runs. See
 * src/lib/agents/research/trigger-definition.ts.
 *
 * WHAT THIS WRITES. One PENDING document_suggestions row for document_type 'icp' whose
 * suggested_value is the LIVE ICP content with ONLY `definition` added to each trigger.
 * Every other leaf is byte-identical, and the script checks that before it writes. Nothing
 * else is written, nothing is approved, and no model is called.
 *
 * WHY THE SEARCH IS UNTOUCHED (ADR-061). Triggers are prose, not targeting fields. On
 * approval the new version inherits the live search settings byte-exact and
 * proposeIcpFilterSpec finds no targeting change, so no search proposal is filed, nobody is
 * re-queued and the cursor stays where it is. The script runs that same comparison
 * (compareTargetingInputs) and refuses if it says otherwise.
 *
 * Approval does mark the client's downstream documents STALE, as every ICP promotion does
 * (ADR-047). That is a flag for the operator, never a regeneration.
 *
 * THE FILE maps each trigger's EXACT current wording to its definition:
 *
 *   { "A new site is opened.": "Counts: ... Does not count: ...", ... }
 *
 * It must cover every live trigger and name no other. A definition keyed to wording that has
 * since changed would attach to nothing, so a mismatch in either direction refuses.
 *
 * Usage (dry run, the default: reads, prints, writes nothing):
 *   npx dotenv -e .env.local -- npx tsx scripts/propose-trigger-definitions.ts --org <id> --file <json>
 * Files the pending suggestion:
 *   ... --commit [--written-by "<who drafted the definitions>"] [--segment <segment id>]
 *
 * --written-by is recorded in generated_by_model, which the version history carries. Omitted,
 * it is null, as for any suggestion no model wrote.
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { compareTargetingInputs, targetingInputs } from '../src/lib/sourcing/targeting-inputs'
import { readBuyerProfile } from '../src/lib/intake/buyer-profile-store'
import { statedHeadcount } from '../src/lib/intake/buyer-profile-authority'

/** Every leaf path of a value, with the leaf serialised. */
function leaves(value: unknown, path: string, out: Map<string, string>): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => leaves(item, `${path}[${i}]`, out))
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      leaves(child, path ? `${path}.${key}` : key, out)
    }
  } else {
    out.set(path, JSON.stringify(value ?? null))
  }
}

/** The leaf paths that differ between two documents, sorted. */
export function changedLeafPaths(before: unknown, after: unknown): string[] {
  const a = new Map<string, string>()
  const b = new Map<string, string>()
  leaves(before, '', a)
  leaves(after, '', b)
  return [...new Set([...a.keys(), ...b.keys()])].filter(p => a.get(p) !== b.get(p)).sort()
}

/**
 * The live ICP content with each trigger's definition added, or the reasons it cannot be.
 * PURE, and it never mutates its input: the input is the baseline every check compares to.
 *
 * EXACT WORDING, not trimmed or case-folded. The upload gate and the research path both find
 * a trigger by its wording, so a near match here would be a definition the rest of the
 * system would say belongs to a different trigger.
 */
export function addTriggerDefinitions(
  content: unknown,
  definitions: Record<string, string>,
): { content: unknown; problems: string[] } {
  const problems: string[] = []
  const copy = JSON.parse(JSON.stringify(content ?? null)) as { tier_1?: { triggers?: unknown } } | null
  const triggers = copy?.tier_1?.triggers
  if (!Array.isArray(triggers) || triggers.length === 0) {
    return { content, problems: ['the live ICP has no tier_1.triggers to define'] }
  }

  const live: string[] = []
  triggers.forEach((t, i) => {
    if (!t || typeof t !== 'object' || typeof (t as { trigger?: unknown }).trigger !== 'string') {
      // A bare-string trigger has nowhere to put a definition without changing its shape,
      // and changing the shape is more than a wording edit.
      problems.push(`trigger ${i + 1} is not an object with a "trigger" field; it cannot carry a definition`)
      return
    }
    const wording = (t as { trigger: string }).trigger
    live.push(wording)
    if (!Object.prototype.hasOwnProperty.call(definitions, wording)) {
      problems.push(`live trigger ${i + 1} has no definition in the file: "${wording}"`)
      return
    }
    const definition = definitions[wording]
    if (typeof definition !== 'string' || definition.trim() === '') {
      problems.push(`the definition for live trigger ${i + 1} is empty: "${wording}"`)
      return
    }
    ;(t as Record<string, unknown>).definition = definition.trim()
  })
  for (const key of Object.keys(definitions)) {
    if (!live.includes(key)) problems.push(`the file defines a trigger that is not in the live ICP: "${key}"`)
  }

  // THE WORDING-EDIT GUARANTEE, checked rather than assumed: every leaf that differs is a
  // definition on a trigger.
  const stray = changedLeafPaths(content, copy).filter(p => !/^tier_1\.triggers\[\d+\]\.definition$/.test(p))
  if (stray.length > 0) problems.push(`something other than a definition would change: ${stray.join(', ')}`)

  return { content: copy, problems }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const orgId = arg('org')
  const file = arg('file')
  const segment = arg('segment')
  const writtenBy = arg('written-by') ?? null
  const commit = process.argv.includes('--commit')
  if (!orgId || !file) {
    console.error('Usage: --org <organisation id> --file <definitions.json> [--segment <id>] [--commit] [--written-by "<text>"]')
    process.exit(1)
  }

  const definitions = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
  if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) {
    throw new Error('the file must be one JSON object mapping each trigger\'s exact wording to its definition')
  }

  const supabase = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  // THE ACTIVE ICP, AND ONLY ONE. A client with several segments has an ICP per segment, and
  // a proposal against the wrong one would define triggers nobody is researching against.
  let query = supabase
    .from('strategy_documents')
    .select('id, version, segment_id, content, plain_text')
    .eq('organisation_id', orgId)
    .eq('document_type', 'icp')
    .eq('status', 'active')
  if (segment) query = query.eq('segment_id', segment)
  const { data: docs, error } = await query
  if (error) throw new Error(`could not read the active ICP: ${error.message}`)
  if (!docs || docs.length !== 1) {
    throw new Error(`expected exactly one active ICP, found ${docs?.length ?? 0}` +
      `${docs && docs.length > 1 ? ` (segments: ${docs.map(d => d.segment_id ?? 'default').join(', ')}); pass --segment` : ''}`)
  }
  const doc = docs[0]

  const { content, problems } = addTriggerDefinitions(doc.content, definitions)

  const triggers = ((content as { tier_1?: { triggers?: Array<{ trigger?: string; reason?: string; definition?: string }> } })
    .tier_1?.triggers) ?? []
  console.log(`\nLive ICP ${doc.id} (v${doc.version}, segment ${doc.segment_id ?? 'default'}): ${triggers.length} triggers\n`)
  triggers.forEach((t, i) => {
    console.log(`${i + 1}. ${t.trigger}`)
    console.log(`   REASON:     ${t.reason ?? ''}`)
    console.log(`   DEFINITION: ${t.definition ?? '(none in the file)'}\n`)
  })

  if (problems.length > 0) {
    console.error(`REFUSED. Nothing written.\n- ${problems.join('\n- ')}`)
    process.exit(1)
  }

  // ADR-061, CHECKED ON THE REAL DOCUMENTS. The two inputs outside the document belong to
  // the organisation and are the same on both sides, so they cannot be what differs.
  const { data: org, error: orgError } = await supabase
    .from('organisations').select('sourcing_revenue_filter_enabled').eq('id', orgId).single()
  if (orgError) throw new Error(`could not read the organisation: ${orgError.message}`)
  const outside = {
    statedHeadcount: statedHeadcount(await readBuyerProfile(supabase, orgId)),
    revenueFilterEnabled: org?.sourcing_revenue_filter_enabled === true,
  }
  const change = compareTargetingInputs(targetingInputs(doc.content, outside), targetingInputs(content, outside))
  const changed = changedLeafPaths(doc.content, content)
  console.log(`Leaves that change: ${changed.length}, every one a trigger definition.`)
  console.log(`Targeting change under ADR-061: ${change.changed ? `YES (${change.paths.join(', ')})` : 'NO'}`)
  if (change.changed) {
    console.error('REFUSED. A definition must not change a targeting field. Nothing written.')
    process.exit(1)
  }

  // ONE PENDING ICP SUGGESTION AT A TIME. The database enforces it too (a unique partial
  // index on organisation, type and pending status), but a refusal that names the reason is
  // better than a constraint error.
  const { data: pending, error: pendingError } = await supabase
    .from('document_suggestions')
    .select('id')
    .eq('organisation_id', orgId)
    .eq('document_type', 'icp')
    .eq('status', 'pending')
  if (pendingError) throw new Error(`could not read pending suggestions: ${pendingError.message}`)
  if ((pending ?? []).length > 0) {
    console.error(`REFUSED. An ICP suggestion is already pending for this organisation (${pending!.map(p => p.id).join(', ')}). Approve or reject it first. Nothing written.`)
    process.exit(1)
  }

  if (!commit) {
    console.log('\nDry run. Nothing written. Add --commit to file the pending ICP suggestion.')
    return
  }

  // SHAPED AS THE ICP AGENT SHAPES ITS OWN (src/agents/icp-generation-agent.ts): the whole
  // document in suggested_value, the live version's plain text as current_value,
  // update_trigger left to its column default.
  const { data: inserted, error: insertError } = await supabase.from('document_suggestions').insert({
    organisation_id: orgId,
    segment_id: doc.segment_id,
    document_id: doc.id,
    document_type: 'icp',
    field_path: 'full_document',
    current_value: doc.plain_text,
    suggested_value: JSON.stringify(content),
    suggestion_reason:
      `Every trigger now carries a written definition: what counts as that event and what does not. ` +
      `Wording only. The triggers, their reasons and every other field are unchanged, so the search ` +
      `settings are untouched (ADR-061). Research reads the chosen fact against its trigger's ` +
      `definition before writing a personalised opening, and holds the opening when the fact is outside it.`,
    confidence_level: 'high',
    signal_count: 0,
    status: 'pending',
    generated_by_model: writtenBy,
    revision_note: 'Trigger definitions added',
  }).select('id').single()
  if (insertError) throw new Error(`insert failed: ${insertError.message}`)
  console.log(`\nPending ICP suggestion ${inserted.id}: live v${doc.version} with ${triggers.length} trigger definitions added. Approve it to make it live.`)
}

// ONLY WHEN RUN AS A SCRIPT, so the test can import the pure functions above.
if (process.argv[1] && process.argv[1].includes('propose-trigger-definitions')) {
  main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
}
