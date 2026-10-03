// The operator's final reading file before upload: whole four-email sequences, as real
// prospects would receive them. Two modes:
//
//   SAMPLING (the default): up to --per-tier sequences for each tier, picked by what each
//   prospect's stored data suggests.
//   A NAMED COHORT (--ids a,b,c): exactly those prospects, once each, in the order given,
//   whatever tier each composes as. Nothing is sampled and nothing is left out.
//
//   npx tsx scripts/sequence-reading-report.ts --org <id> --out <file.md> [--facts <a.json,b.json>] [--per-tier 4] [--tiers firm_fact,template]
//   npx tsx scripts/sequence-reading-report.ts --org <id> --out <file.md> --ids <id,id,id> [--live]
//
// --exclude-ids <id,id> leaves prospects out of a SAMPLE, for those the competitor screen
// would exclude. --tiers limits a SAMPLE to the named tiers (research, firm_fact, template).
// Neither may be combined with --ids: a named cohort is shown whole, and a flag that could
// quietly drop one of the named prospects is refused.
// --mix-rungs shows tier 2's specific facts and broad lines in turn.
// A personalised sequence is shown with whether the upload would HOLD it and why: for no
// follow-up carrying its thread, or because its Email 1 was not written to one of the
// client's approved trigger reasons as they read today.
//
// Operator spec, 2026-09-30: 12 complete sequences (4 tier 1, 4 tier 2, 4 tier 3) from real
// prospects, no source notes, one PASS / PASS WITH NOTE / FAIL line per whole sequence.
//
// HOW IT STAYS HONEST.
//   - Every sequence is built by composeSequence itself, in DRY RUN. Nothing is written: no
//     variant assignment, no document id, no fact.
//   - WHICH DOCUMENT. By default the PENDING messaging suggestion with firm_fact_tier
//     treated as on: what composition would send once that suggestion is approved and the
//     tier switched on. With --live, the ACTIVE messaging document, switch as it stands.
//     ONE LIMIT ON "AS IT STANDS": --live reads the organisation-wide document (no segment)
//     for every prospect, while the upload reads a prospect's own segment's document first.
//     For a client with one document they are the same; for a segmented client this file
//     can show copy a prospect in a segment would not receive. --facts is refused with
//     --live: a fact read in a dry run and never stored is not how things stand either.
//   - The tier printed is the tier composeSequence returned, never the tier this script
//     expected. In a sample, a prospect that was picked for one tier and composed as another
//     is listed at the foot as such and not shown.
//   - Prospects not yet uploaded come first in every tier of a sample, because they are the
//     ones this copy could actually reach.
//   - --followups: for a personalised (tier 1) sequence, Emails 2 and 3 are written IN DRY
//     RUN by the same function the follow-up backfill runs, against this suggestion, and
//     composed through the same fingerprint check as stored copy. It shows the sequence as
//     it would send once the suggestion is approved and the backfill has run. It is PAID
//     (the follow-up writer's calls) and stores nothing. Without the flag a personalised
//     sequence shows the follow-ups stored today, which against a new document are stale,
//     so the templates show and the upload would hold the prospect.
//   - Each tier 2 heading says which rung of the ladder the opener came from (their site's
//     specific clause, the kind of firm their site states, or the kind of firm built from
//     their stored record), and the file ends with how each personalised sequence's
//     follow-ups were arrived at.
//
// KNOWN LIMIT: A SAMPLE SHOWS A RECORD-BUILT (PEER RUNG) EMAIL ONLY FOR A TIER 2 CANDIDATE
// WHOSE OWN FACT GAVE NO USABLE RUNG. Tier 2 candidates are prospects with a usable stored
// fact; one whose fact holds only a tagline clause, or whose own rungs fail with their real
// words, composes on the peer rung and is shown. A prospect with NO fact is never sampled as
// tier 2: it is picked as a template candidate, and when it composes as tier 2 from its
// record it is dropped from the sample and listed at the foot. To read those emails, name
// the prospects with --ids. (Corrected 2026-10-02: this said a sample never shows one.)
//
// --review runs the copy reviewer (PAID, report mode) over each tier 2 Email 1 whose opener
// came from their site. A record-built opener is skipped: the reviewer is given the site's
// own words as evidence, and for that rung there are none.
//
// THE OUTPUT NAMES REAL PEOPLE AND FIRMS. Write it under .writer-export/ (gitignored). Never
// commit it and never paste it into Notion. This script holds no names.

import * as fs from 'fs'
import * as path from 'path'

for (const line of fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const eq = t.indexOf('=')
  if (eq > 0 && !process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
}

import { execSync } from 'child_process'
import { createClient } from '@supabase/supabase-js'
import { composeSequence, type ComposeDocs, type ComposedSequence } from '../src/lib/composition/compose-sequence'
import { readBrief } from '../src/lib/outbound-brief/brief'
import type { FirmFactRecord } from '../src/lib/agents/research/firm-fact'
import { FIRM_FACT_CHECKS_VERSION } from '../src/lib/agents/research/firm-fact-checks'
import { reviewCopy } from '../src/lib/agents/research/copy-reviewer'
import { loadClientName } from '../src/lib/agents/research/produce-opening'
import { followupsForStoredEmail1, STORED_EMAIL1_COLUMNS, type StoredEmail1Row } from './backfill-followups'
import { threadVerdict } from '../src/lib/composition/thread-carried'
import { loadTriggersChecked, openingReasonVerdict } from '../src/lib/composition/opening-reason'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

interface ProspectRow {
  id: string
  first_name: string | null
  company_name: string | null
  outbound_upload_status: string | null
  personalisation_trigger: string | null
  firm_fact: FirmFactRecord | null
}

const TIER_LABEL: Record<string, string> = {
  research: 'Tier 1 (personalised)',
  firm_fact: 'Tier 2 (firm fact)',
  template: 'Tier 3 (template)',
}

async function main() {
  const orgId = arg('org')
  const out = arg('out')
  const perTier = Number(arg('per-tier') ?? '4')
  const factFiles = (arg('facts') ?? '').split(',').filter(Boolean)
  if (!orgId || !out) throw new Error('--org and --out are required')
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  // WHICH DOCUMENT. By default the PENDING suggestion with the tier treated as on. With
  // --live, the ACTIVE document exactly as it stands, switch included: what a prospect
  // would receive if uploaded now. Until 2026-10-02 only the first existed, so this script
  // could not be run after an approval.
  const live = process.argv.includes('--live')
  // --live says "as it stands". A fact read in a dry run and never stored is not how things
  // stand, and until 2026-10-02 it was stood in anyway, under that label.
  if (live && factFiles.length > 0) throw new Error('--facts cannot be combined with --live: --live shows each prospect with the fact stored on it today, and a dry-run fact is not stored')
  let content: Record<string, unknown>
  let docId: string
  let docLabel: string
  if (live) {
    const { data: doc, error } = await supabase.from('strategy_documents').select('id, version, content')
      .eq('organisation_id', orgId).eq('document_type', 'messaging').eq('status', 'active').is('segment_id', null).maybeSingle()
    if (error || !doc) throw new Error('no active messaging document')
    content = doc.content as Record<string, unknown>
    docId = doc.id as string
    const on = (content.firm_fact_tier as { enabled?: unknown } | undefined)?.enabled === true
    docLabel = `the LIVE organisation-wide messaging document (version ${doc.version}), with the firm-fact tier ${on ? 'on' : 'OFF'} as it stands; a prospect in a segment with its own document would receive that one`
  } else {
    const { data: pending, error } = await supabase.from('document_suggestions').select('id, suggested_value')
      .eq('organisation_id', orgId).eq('document_type', 'messaging').eq('status', 'pending').single()
    if (error || !pending) throw new Error('no pending messaging suggestion (pass --live to read the active document)')
    content = { ...JSON.parse(pending.suggested_value), firm_fact_tier: { enabled: true } }
    docId = pending.id
    docLabel = `pending messaging suggestion ${pending.id} with the firm-fact tier treated as on`
  }
  const read = readBrief(content)
  if (!read.brief) {
    throw new Error(read.present
      ? `the outbound brief in the document is not valid:\n- ${read.problems.join('\n- ')}`
      : 'the document has no outbound brief')
  }
  const docs = { messagingDoc: content, messagingDocId: docId } as unknown as ComposeDocs
  // --ids a,b,c: exactly these prospects, once each, in this order, whatever tier each
  // composes as. For a fixed cohort read after a run: nothing is sampled and nothing is
  // left out. So the two flags that leave prospects out of a sample are refused beside it.
  // Until 2026-10-02 they were honoured: `--ids X --tiers firm_fact` dropped a prospect
  // with no stored fact that composes from its record, with no line anywhere saying so.
  const onlyIds = [...new Set((arg('ids') ?? '').split(',').map(t => t.trim()).filter(Boolean))]
  if (onlyIds.length > 0 && (arg('tiers') !== undefined || arg('exclude-ids') !== undefined)) {
    throw new Error('--ids cannot be combined with --tiers or --exclude-ids: a named cohort is shown whole. Take the prospect out of --ids instead')
  }

  // Facts read in a dry run from uploaded prospects, keyed by prospect. Latest file wins.
  const dryFacts = new Map<string, FirmFactRecord>()
  for (const f of factFiles) {
    for (const o of JSON.parse(fs.readFileSync(f, 'utf-8')) as Array<{ prospect_id: string; record: FirmFactRecord }>) {
      dryFacts.set(o.prospect_id, o.record)
    }
  }

  const { data: rows, error: rowsError } = await supabase.from('prospects')
    .select('id, first_name, company_name, outbound_upload_status, personalisation_trigger, firm_fact, segment_id, opening_judge:trigger_data->judge')
    .eq('organisation_id', orgId)
    .not('current_research_result_id', 'is', null)
    .order('id', { ascending: true })
    .limit(1000)
  if (rowsError) throw new Error(rowsError.message)
  const everyProspect = (rows ?? []) as ProspectRow[]
  const missingIds = onlyIds.filter(id => !everyProspect.some(p => p.id === id))
  if (missingIds.length > 0) throw new Error(`--ids names prospects that are not researched prospects of this organisation: ${missingIds.join(', ')}`)
  const prospects = onlyIds.length > 0
    ? onlyIds.map(id => everyProspect.find(p => p.id === id)!)
    : everyProspect.sort((a, b) => (a.outbound_upload_status === 'pending' ? 0 : 1) - (b.outbound_upload_status === 'pending' ? 0 : 1))

  // Rule 9 (2026-10-01): a fact that passed qualifies for tier 2 with or without a customer
  // group. The version must be current, as composition requires.
  const usable = (r: FirmFactRecord | null | undefined) => !!r && r.passed === true && r.version === FIRM_FACT_CHECKS_VERSION
  const wanted: Record<string, ProspectRow[]> = {
    research: prospects.filter(p => p.personalisation_trigger?.trim()),
    firm_fact: prospects.filter(p => !p.personalisation_trigger?.trim() && (usable(p.firm_fact) || usable(dryFacts.get(p.id)))),
    template: prospects.filter(p => !p.personalisation_trigger?.trim() && !usable(p.firm_fact) && !usable(dryFacts.get(p.id))),
  }

  // --mix-rungs: show the two rungs of tier 2 in turn. Candidates come in id order, and by
  // chance the first six can all be specific facts, which shows the reader nothing of the
  // broad line. A fact with no specific clause can only compose as the broad line.
  if (process.argv.includes('--mix-rungs')) {
    const factOf = (p: ProspectRow) => (usable(p.firm_fact) ? p.firm_fact : dryFacts.get(p.id)) as { does?: string | null } | null | undefined
    const broadOnly = wanted.firm_fact.filter(p => !factOf(p)?.does)
    const withSpecific = wanted.firm_fact.filter(p => !!factOf(p)?.does)
    const mixed: ProspectRow[] = []
    for (let i = 0; i < Math.max(broadOnly.length, withSpecific.length); i++) {
      if (withSpecific[i]) mixed.push(withSpecific[i])
      if (broadOnly[i]) mixed.push(broadOnly[i])
    }
    wanted.firm_fact = mixed
  }

  const withFollowups = process.argv.includes('--followups')
  const clientName = withFollowups ? await loadClientName(supabase as never, orgId) : ''
  const followupNotes: string[] = []
  const review = process.argv.includes('--review')
  const reviewNotes: string[] = []
  let positioningText = ''
  if (review) {
    const { data: positioning } = await supabase.from('strategy_documents').select('plain_text, content')
      .eq('organisation_id', orgId).eq('document_type', 'positioning').eq('status', 'active').is('segment_id', null).maybeSingle()
    positioningText = positioning?.plain_text ?? JSON.stringify(positioning?.content ?? {})
  }
  const sha = execSync('git rev-parse --short HEAD').toString().trim()
  const lines: string[] = []
  const counts: Record<string, { shown: number; pending: number }> = {}
  const fellBack: string[] = []
  let n = 0
  const body: string[] = []

  const onlyTiers = (arg('tiers') ?? '').split(',').map(t => t.trim()).filter(Boolean)
  // --exclude-ids: prospects to leave out, by id. For the ones the competitor screen would
  // exclude once it has been run with --commit: this file is built before that, and a
  // sequence written to a competitor is not one a prospect would receive.
  const excludeIds = new Set((arg('exclude-ids') ?? '').split(',').map(t => t.trim()).filter(Boolean))
  // WHO IS COMPOSED, IN WHAT ORDER. A sample walks the three buckets in turn. A named
  // cohort walks the ids as given, once each: the bucket is then only what says which
  // stored data to compose the prospect with (a dry-run fact, written follow-ups), never
  // a reason to skip or reorder it. Until 2026-10-02 a cohort was walked bucket by bucket
  // too, so the file came out in bucket order and not in the order asked for.
  type Bucket = 'research' | 'firm_fact' | 'template'
  const BUCKETS: readonly Bucket[] = ['research', 'firm_fact', 'template']
  const bucketOf = (p: ProspectRow): Bucket => BUCKETS.find(tier => wanted[tier].includes(p)) ?? 'template'
  const picks: Array<{ tier: Bucket; p: ProspectRow }> = onlyIds.length > 0
    ? prospects.map(p => ({ tier: bucketOf(p), p }))
    : BUCKETS.filter(tier => onlyTiers.length === 0 || onlyTiers.includes(tier)).flatMap(tier => wanted[tier].map(p => ({ tier, p })))
  for (const tier of BUCKETS) if (onlyTiers.length === 0 || onlyTiers.includes(tier)) counts[tier] = { shown: 0, pending: 0 }
  const seenVariantsByTier = new Map<Bucket, Map<string, number>>()
  for (const { tier, p } of picks) {
    const seenVariants = seenVariantsByTier.get(tier) ?? new Map<string, number>()
    seenVariantsByTier.set(tier, seenVariants)
    if (onlyIds.length === 0 && counts[tier].shown >= perTier) continue
    if (excludeIds.has(p.id)) continue
    const isPending = p.outbound_upload_status === 'pending'
    // A stored fact is used as it stands. A dry-run fact stands in only where none is stored.
    const dryRun: NonNullable<Parameters<typeof composeSequence>[0]['dryRun']> =
      tier === 'firm_fact' && !usable(p.firm_fact) ? { firmFact: dryFacts.get(p.id) } : {}
    // What the follow-up backfill WOULD store for this prospect against this suggestion.
    let followupNote: string | null = null
    if (withFollowups && tier === 'research') {
      const { data: full } = await supabase.from('prospects')
        .select(STORED_EMAIL1_COLUMNS)
        .eq('organisation_id', orgId).eq('id', p.id).single()
      const written = full
        ? await followupsForStoredEmail1({
            supabase, orgId, row: full as unknown as StoredEmail1Row, content, clientName, apiKey: process.env.ANTHROPIC_API_KEY!,
          })
        : null
      if (written?.status === 'ran') {
        dryRun.followups = {
          email2: written.result.email2.prose, email3: written.result.email3.prose, email1Fingerprint: written.fingerprint,
        }
        const why = (o: { prose: string | null; failures: string[] }) =>
          o.prose !== null ? 'written' : `rejected by its checks (${o.failures[0]?.slice(0, 110) ?? 'no reason recorded'})`
        followupNote = `written in dry run for this file. Email 2: ${why(written.result.email2)}. Email 3: ${why(written.result.email3)}.`
      } else if (written?.status === 'skipped') {
        followupNote = `not written: ${written.reason}.`
      }
    }
    let seq: ComposedSequence
    try {
      seq = await composeSequence({ prospect_id: p.id, client_id: orgId, preloadedDocs: docs, dryRun })
    } catch (err) {
      // BY ID: in a named cohort this line is the only trace of that prospect in the file.
      fellBack.push(`Prospect ${p.id}, a ${TIER_LABEL[tier]} candidate, could not be composed: ${err instanceof Error ? err.message : err}`)
      continue
    }
    // A prospect is picked for the tier its stored data suggests and LABELLED by the tier
    // it composed as. Sampling drops a candidate whose tier differs (it is reported
    // below); a named cohort (--ids) shows every prospect as it came out. The peer rung
    // is why this matters: a prospect with no stored fact is picked as a template
    // candidate and composes as tier 2, from its record.
    const composedTier = seq.opening.tier
    if (composedTier !== tier && onlyIds.length === 0) {
      // A template detail carries `reason`; a tier 2 detail carries its rung, and for the
      // record-built rung why no rung from a stored fact shipped. Until 2026-10-02 only the
      // first was read, so a template candidate that composed from its record had no note.
      const why = (seq.opening.detail as { reason?: string; violations?: string[]; rung?: string; fact_reason?: string } | null)
      const note = why?.reason
        ? ` (${why.reason}${why.violations ? `: ${why.violations.join('; ')}` : ''})`
        : why?.rung ? ` (rung: ${why.rung}${why.fact_reason ? `; no rung from a stored fact: ${why.fact_reason}` : ''})` : ''
      fellBack.push(`A ${TIER_LABEL[tier]} candidate composed as ${TIER_LABEL[composedTier]}${note}`)
      continue
    }
    // Spread across variants: no more than two of one variant per tier.
    const variantKey = seq.variant_id ?? 'writer v2'
    if (onlyIds.length === 0 && (seenVariants.get(variantKey) ?? 0) >= 2) continue
    seenVariants.set(variantKey, (seenVariants.get(variantKey) ?? 0) + 1)
    counts[composedTier] ??= { shown: 0, pending: 0 }
    counts[composedTier].shown++
    if (isPending) counts[composedTier].pending++
    n++
    // The rung of the ladder a tier 2 opener came from: the specific fact from their site,
    // the broad line about what kind of firm their site says it is, or the same line built
    // from their stored record.
    const rung = composedTier === 'firm_fact' ? ((seq.opening.detail as { rung?: string } | null)?.rung ?? 'specific') : null
    const RUNG_LABEL: Record<string, string> = {
      specific: ', a specific fact from their site)',
      broad: ', the kind of firm their site says they are)',
      peer: ', the kind of firm their stored record says they are)',
    }
    const label = rung ? TIER_LABEL[composedTier].replace(')', RUNG_LABEL[rung] ?? `, ${rung})`) : TIER_LABEL[composedTier]
    const templateWhy = composedTier === 'template' ? (seq.opening.detail as { reason?: string; peer_reason?: string } | null) : null
    body.push(`## ${n}. ${label} · ${p.company_name ?? 'unknown'} · variant ${seq.variant_id} · ${isPending ? 'not yet uploaded' : 'already uploaded (read only)'}`)
    if (templateWhy && onlyIds.length > 0) {
      body.push('')
      body.push(`Why the plain template: ${templateWhy.reason ?? 'unknown'}${templateWhy.peer_reason ? `; no line from the stored record either (${templateWhy.peer_reason})` : ''}.`)
    }
    if (composedTier === 'research') {
      const position = (k: 2 | 3) => seq.followups.positions[k]?.mode === 'generated'
        ? 'personalised'
        : `template (${seq.followups.positions[k]?.fell_back_reason ?? 'none_stored'})`
      // WOULD THE UPLOAD SEND THIS? The same two verdicts the upload reads.
      const triggers = await loadTriggersChecked(supabase, orgId, (p as { segment_id?: string | null }).segment_id ?? null)
      if (!triggers.ok) throw new Error(triggers.error)
      const reasonVerdict = openingReasonVerdict({ tier: seq.opening.tier, judge: (p as { opening_judge?: unknown }).opening_judge, triggers: triggers.triggers })
      const thread = threadVerdict(seq)
      const held = !reasonVerdict.ok
        ? `HELD AT UPLOAD: Email 1 was not written to a current approved trigger reason (${reasonVerdict.why}). Its research must be run again.`
        : !thread.carried
          ? 'HELD AT UPLOAD until the follow-up backfill has written a personalised Email 2 or 3.'
          : 'Would upload.'
      followupNotes.push(
        `Sequence ${n}: Email 2 ${position(2)}; Email 3 ${position(3)}.` +
        (followupNote ? ` Follow-ups ${followupNote}` : ' Follow-ups as stored today, not rewritten for this file.') +
        ` ${held}`,
      )
    }
    body.push('')
    for (const e of [...seq.emails].sort((a, b) => a.sequence_position - b.sequence_position)) {
      body.push(`**Email ${e.sequence_position}**${e.subject_line ? ` · subject: ${e.subject_line}` : ' · same thread'}`)
      body.push('')
      body.push(e.body.replace(/\{\{first_name\}\}/g, p.first_name ?? '{{first_name}}').split('\n').map(l => `> ${l}`).join('\n'))
      body.push('')
    }
    body.push(`Verdict: VERDICT_${n}`)
    body.push('')

    // --review: the copy reviewer over a firm-fact Email 1, REPORT MODE. Printed to the
    // console for whoever writes the verdicts; never written into the reading file,
    // which carries no source notes. The category this is for is opener_pain_disconnect.
    //
    // NOT FOR THE PEER RUNG. Its opener was built from the stored record, so there is no
    // quote from the site to give the reviewer: until 2026-10-02 a peer-rung prospect
    // named with --ids was sent for a paid review against the evidence line `""`.
    if (review && composedTier === 'firm_fact' && rung !== 'peer') {
      const fact = usable(p.firm_fact) ? p.firm_fact : dryFacts.get(p.id)
      const e1 = seq.emails.find(e => e.sequence_position === 1)!
      const reviewed = await reviewCopy({
        apiKey: process.env.ANTHROPIC_API_KEY!,
        position: 1,
        body: e1.body.replace(/\{\{first_name\}\}/g, p.first_name ?? 'there'),
        findingsEvidence: `1. From the firm's own website: "${fact?.quote ?? ''}"`,
        positioningText,
        prospectId: p.id,
        readerNames: [p.first_name],
      })
      const fails = Object.entries(reviewed.hardFails).filter(([, v]) => v.failed).map(([id, v]) => `${id}: "${v.quote}" (${v.why})`)
      reviewNotes.push(`Sequence ${n} (${p.company_name}): ${fails.length === 0 ? 'no reviewer flags' : fails.join(' || ')}`)
    }
  }

  lines.push(`# Reading file: ${n} sequences as prospects would receive them`)
  lines.push('')
  lines.push(`Built ${new Date().toISOString().slice(0, 16)} UTC from branch firm-fact-tier at ${sha}, by composeSequence in dry run against ${docLabel}. Nothing was written to any prospect. Contains real names: never commit, never paste into Notion.`)
  lines.push('')
  lines.push('One line per whole sequence: PASS / PASS WITH NOTE / FAIL, judged on: human-sounding, clear picture, easy to read, coherent, ties together across emails, gives a reason to reply. The verdict lines are mine; overwrite them with yours. Nothing uploads until you approve.')
  lines.push('')
  lines.push(`Shown: ${Object.entries(counts).map(([t, c]) => `${TIER_LABEL[t]} ${c.shown} (${c.pending} not yet uploaded)`).join('; ')}.`)
  lines.push('')
  lines.push(...body)
  if (followupNotes.length > 0) {
    lines.push('## Follow-ups on the personalised sequences')
    lines.push('')
    lines.push('A personalised Email 1 is not uploaded unless Email 2 or Email 3 is personalised too. Where both show as template below, the upload would hold that prospect until the follow-up backfill has run.')
    lines.push('')
    for (const f of followupNotes) lines.push(`- ${f}`)
    lines.push('')
  }
  if (fellBack.length > 0) {
    lines.push('## Candidates that did not compose in the tier they were picked for')
    lines.push('')
    for (const f of fellBack) lines.push(`- ${f}`)
    lines.push('')
  }
  fs.writeFileSync(out, lines.join('\n'))
  if (reviewNotes.length > 0) console.log(`COPY REVIEWER (report mode, firm-fact Email 1s):\n${reviewNotes.join('\n')}`)
  console.log(`Wrote ${out}: ${n} sequences. ${JSON.stringify(counts)}. Fell back: ${fellBack.length}`)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
