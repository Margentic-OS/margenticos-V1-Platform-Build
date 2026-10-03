// Which Email 1 tier every researched prospect would receive, and why. Free: no model call.
//
//   npx tsx scripts/tier-census.ts --org <id> [--facts <a.json,b.json>] [--out <file.json>]
//
// Composes EVERY researched, tiered, unsuppressed prospect in DRY RUN against the pending
// messaging suggestion with the firm-fact tier treated as on, and counts what came back:
//
//   - the tier and, for the firm-fact tier, the rung of the ladder: specific (a clause
//     from their site), broad (the kind of firm their site says they are) or peer (the
//     kind of firm built from their stored record, with no model)
//   - for every prospect that falls to the template, a REASON CODE (operator note 6,
//     2026-10-01: "report a reason code for every tier 3 prospect"). It has two halves
//     since the peer rung exists: why no rung from the stored FACT shipped, then after
//     "; record:" why the line built from the stored RECORD did not either. Where
//     composition says the stored fact did not pass, the fact's own reason is appended,
//     because "did not pass" covers an unusable site, an identity mismatch and a failed
//     faithfulness check, and those need different actions.
//   - for every personalised prospect, whether each follow-up would be personalised and,
//     where it would not, why (operator note 4), and whether the upload would hold it:
//     for no follow-up carrying its thread, or because the opening was not written to one
//     of the client's approved trigger reasons as they read today (operator note 5).
//
// Nothing is written. The reading file shows a dozen sequences; this is the whole cohort,
// which is what a rate has to be computed over.
//
// --facts stands in firm facts read in a dry run from already-uploaded prospects, as the
// reading report does. --out writes one row per prospect, WITH COMPANY NAMES: keep it under
// .writer-export/, which is gitignored, and never commit it.

import * as fs from 'fs'
import * as path from 'path'

for (const line of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const eq = t.indexOf('=')
  if (eq > 0 && !process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
}

import { createClient } from '@supabase/supabase-js'
import { composeSequence, type ComposeDocs } from '../src/lib/composition/compose-sequence'
import { threadVerdict } from '../src/lib/composition/thread-carried'
import { loadTriggersChecked, openingReasonVerdict } from '../src/lib/composition/opening-reason'
import type { TriggerWithReason } from '../src/lib/agents/research/approved-reason'
import { readBrief } from '../src/lib/outbound-brief/brief'
import type { FirmFactRecord } from '../src/lib/agents/research/firm-fact'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

interface Row {
  id: string
  company_name: string | null
  outbound_upload_status: string | null
  personalisation_trigger: string | null
  firm_fact: FirmFactRecord | null
  segment_id: string | null
  /** prospects.trigger_data.judge: what the stored Email 1 was held to. */
  opening_judge: unknown
}

interface CensusRow {
  prospect_id: string
  company_name: string | null
  uploaded: boolean
  tier: string
  rung: string | null
  /** For a template Email 1: why it is not tier 2. */
  reason: string | null
  email2: string
  email3: string
  /** Held because neither follow-up carries Email 1's thread. The backfill is the remedy. */
  held_for_thread: boolean
  /** Held because Email 1 was not written to a current approved reason. Null when it was. Research again is the remedy. */
  held_for_reason: string | null
  held_at_upload: boolean
}

function tally(values: string[]): string {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'
}

async function main() {
  const orgId = arg('org')
  const out = arg('out')
  const factFiles = (arg('facts') ?? '').split(',').filter(Boolean)
  if (!orgId) throw new Error('--org is required')
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  // WHICH DOCUMENT. By default the PENDING suggestion with the tier treated as on: what
  // would happen if it were approved and switched on. With --live, the ACTIVE document
  // exactly as it stands, switch included: what happens today. Until 2026-10-02 only the
  // first existed, so the census stopped working the moment a suggestion was approved.
  const live = process.argv.includes('--live')
  let content: Record<string, unknown>
  let docId: string
  let docLabel: string
  if (live) {
    const { data: doc, error } = await supabase.from('strategy_documents').select('id, version, content')
      .eq('organisation_id', orgId).eq('document_type', 'messaging').eq('status', 'active').is('segment_id', null).maybeSingle()
    if (error || !doc) throw new Error('no active messaging document')
    content = doc.content as Record<string, unknown>
    docId = doc.id as string
    docLabel = `the live messaging document (version ${doc.version}), switch as it stands: ${(content.firm_fact_tier as { enabled?: unknown } | undefined)?.enabled === true ? 'ON' : 'OFF'}`
  } else {
    const { data: pending, error } = await supabase.from('document_suggestions').select('id, suggested_value')
      .eq('organisation_id', orgId).eq('document_type', 'messaging').eq('status', 'pending').single()
    if (error || !pending) throw new Error('no pending messaging suggestion (pass --live to read the active document)')
    content = { ...JSON.parse(pending.suggested_value), firm_fact_tier: { enabled: true } }
    docId = pending.id
    docLabel = `pending suggestion ${pending.id}, with the firm-fact tier treated as ON`
  }
  const read = readBrief(content)
  if (!read.brief) {
    throw new Error(read.present
      ? `the outbound brief in the document is not valid:\n- ${read.problems.join('\n- ')}`
      : 'the document has no outbound brief')
  }
  const docs = { messagingDoc: content, messagingDocId: docId } as unknown as ComposeDocs
  console.log(`\n  Composed against ${docLabel}.`)

  const dryFacts = new Map<string, FirmFactRecord>()
  for (const f of factFiles) {
    for (const o of JSON.parse(fs.readFileSync(f, 'utf-8')) as Array<{ prospect_id: string; record: FirmFactRecord }>) {
      dryFacts.set(o.prospect_id, o.record)
    }
  }

  // Paged: one read returns at most 1,000 rows and says nothing about the rest.
  const rows: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error: readError } = await supabase.from('prospects')
      .select('id, company_name, outbound_upload_status, personalisation_trigger, firm_fact, segment_id, opening_judge:trigger_data->judge')
      .eq('organisation_id', orgId)
      .eq('suppressed', false)
      .not('current_research_result_id', 'is', null)
      .not('sourced_tier', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + 999)
    if (readError) throw new Error(readError.message)
    rows.push(...((data ?? []) as Row[]))
    if ((data ?? []).length < 1000) break
  }

  // The client's approved trigger reasons, once per segment, through the same checked read
  // the upload uses. A failed read stops the census: it is never "no approved reasons".
  const triggersBySegment = new Map<string | null, TriggerWithReason[]>()
  const triggersFor = async (segmentId: string | null) => {
    const cached = triggersBySegment.get(segmentId)
    if (cached) return cached
    const read = await loadTriggersChecked(supabase, orgId, segmentId)
    if (!read.ok) throw new Error(read.error)
    triggersBySegment.set(segmentId, read.triggers)
    return read.triggers
  }

  const census: CensusRow[] = []
  let failed = 0
  for (const p of rows) {
    const uploaded = p.outbound_upload_status !== null && p.outbound_upload_status !== 'pending'
    // A stored fact is used as it stands. A dry-run fact stands in only where none is stored.
    const dry = !p.firm_fact && dryFacts.has(p.id) ? { firmFact: dryFacts.get(p.id) } : {}
    try {
      const seq = await composeSequence({ prospect_id: p.id, client_id: orgId, preloadedDocs: docs, dryRun: dry })
      const detail = (seq.opening.detail ?? {}) as { rung?: string; reason?: string; peer_reason?: string }
      const fact = p.firm_fact ?? dryFacts.get(p.id) ?? null
      // `reason` is about the stored fact and `peer_reason` about the line built from the
      // stored record: two fields since 2026-10-02. Before that a failed peer attempt
      // overwrote `reason` with its own failure, so the comparison below stopped matching
      // for a fact that did not pass, and the fact's own reason was dropped from the code.
      const factWhy = detail.reason === 'fact_did_not_pass' && fact?.reason
        ? `fact_did_not_pass: ${fact.reason}`
        : detail.reason ?? 'unknown'
      const reason = seq.opening.tier !== 'template'
        ? null
        : detail.peer_reason ? `${factWhy}; record: ${detail.peer_reason}` : factWhy
      const thread = threadVerdict(seq)
      const reasonVerdict = openingReasonVerdict({ tier: seq.opening.tier, judge: p.opening_judge, triggers: await triggersFor(p.segment_id) })
      const position = (n: 2 | 3) => seq.followups.positions[n]?.mode === 'generated'
        ? 'personalised'
        : `template (${seq.followups.positions[n]?.fell_back_reason ?? 'none_stored'})`
      census.push({
        prospect_id: p.id, company_name: p.company_name, uploaded,
        tier: seq.opening.tier, rung: seq.opening.tier === 'firm_fact' ? detail.rung ?? 'specific' : null,
        reason, email2: position(2), email3: position(3),
        held_for_thread: !thread.carried,
        held_for_reason: reasonVerdict.ok ? null : reasonVerdict.why,
        held_at_upload: !thread.carried || !reasonVerdict.ok,
      })
    } catch (err) {
      failed++
      census.push({
        prospect_id: p.id, company_name: p.company_name, uploaded, tier: 'could_not_compose', rung: null,
        reason: err instanceof Error ? err.message.slice(0, 120) : String(err), email2: '-', email3: '-',
        held_for_thread: false, held_for_reason: null, held_at_upload: false,
      })
    }
  }

  for (const [label, group] of [
    ['NOT YET UPLOADED', census.filter(c => !c.uploaded)],
    ['ALREADY UPLOADED (read only; their email is already with the sending tool)', census.filter(c => c.uploaded)],
  ] as const) {
    const research = group.filter(c => c.tier === 'research')
    const fact = group.filter(c => c.tier === 'firm_fact')
    const template = group.filter(c => c.tier === 'template')
    console.log('')
    console.log(`  ${label}: ${group.length}`)
    console.log(`    Tier 1 (personalised)   : ${research.length}`)
    console.log(`    Tier 2 (firm fact)      : ${fact.length}  [${tally(fact.map(c => c.rung ?? 'specific'))}]`)
    console.log(`    Tier 3 (template)       : ${template.length}`)
    console.log(`      reason codes          : ${tally(template.map(c => c.reason ?? 'unknown'))}`)
    if (research.length > 0) {
      const carried = research.filter(c => !c.held_for_thread).length
      const forReason = research.filter(c => c.held_for_reason !== null)
      console.log(`    Tier 1 follow-ups, against this document:`)
      console.log(`      Email 2               : ${tally(research.map(c => c.email2))}`)
      console.log(`      Email 3               : ${tally(research.map(c => c.email3))}`)
      console.log(`      carried by Email 2 or 3: ${carried} of ${research.length}`)
      console.log(`    Tier 1 openings and the approved trigger reason:`)
      console.log(`      written to a current approved reason: ${research.length - forReason.length} of ${research.length}`)
      console.log(`      not, and why          : ${tally(forReason.map(c => c.held_for_reason ?? ''))}`)
      console.log(`    HELD AT UPLOAD          : ${research.filter(c => c.held_at_upload).length} of ${research.length}`)
      console.log(`      for the thread only (the backfill can fix)        : ${research.filter(c => c.held_for_thread && c.held_for_reason === null).length}`)
      console.log(`      for the reason (research must be run again)       : ${forReason.length}`)
    }
  }
  // THE WHOLE COHORT ON ONE LINE, with shares. The operator's target is stated as a share of
  // ALL prospects ("plain template under 10%"), and the two blocks above give counts only.
  {
    const composed = census.filter(c => c.tier !== 'could_not_compose')
    const share = (n: number) => (composed.length === 0 ? '0.0' : ((100 * n) / composed.length).toFixed(1))
    const of = (tier: string, rung?: string) => composed.filter(c => c.tier === tier && (rung === undefined || (c.rung ?? 'specific') === rung)).length
    console.log('')
    console.log(`  ALL PROSPECTS: ${composed.length}`)
    console.log(`    Personalised (research)            : ${of('research')}  (${share(of('research'))}%)`)
    console.log(`    From their site, specific          : ${of('firm_fact', 'specific')}  (${share(of('firm_fact', 'specific'))}%)`)
    console.log(`    From their site, kind of firm      : ${of('firm_fact', 'broad')}  (${share(of('firm_fact', 'broad'))}%)`)
    console.log(`    From their record, kind of firm    : ${of('firm_fact', 'peer')}  (${share(of('firm_fact', 'peer'))}%)`)
    console.log(`    PLAIN TEMPLATE                     : ${of('template')}  (${share(of('template'))}%)`)
  }
  if (failed > 0) console.log(`\n  Could not compose: ${failed}`)
  console.log('')

  if (out) {
    fs.writeFileSync(out, JSON.stringify(census, null, 2))
    console.log(`  Wrote ${out}: ${census.length} rows. It names real firms: do not commit it.`)
    console.log('')
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
