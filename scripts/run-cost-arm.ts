#!/usr/bin/env npx tsx
/**
 * Run ONE cost arm over a FIXED prospect set, and record what it cost.
 *
 * ═══ WHAT THIS IS FOR ════════════════════════════════════════════════════════
 *
 * Synthesis is 90.6% of a prospect's Anthropic cost, measured over 105 prospects on
 * 2026-09-24. Three arms aim at it, or at the next line down:
 *
 *   ARM_CANDIDATE_CAP=4        write out fewer candidates (84.6% of candidate output
 *                              describes candidates that are not selected)
 *   ARM_SYNTHESIS_MODEL=haiku  a third of the rate
 *   ARM_BRIEF_WEB_SEARCH=true  a lever already built and never switched on here
 *
 * ═══ IT DOES NOT WRITE PRODUCTION DATA. THAT IS THE DESIGN, NOT A LIMITATION ══
 *
 * Synthesis arms RE-SYNTHESISE from raw sources already on file, so only the variable under
 * test changes. They must therefore not write a prospect_research_results row: that row would
 * become the newest one holding evidence, loadStoredFindings would carry an ARM's candidates
 * into the next production run, and a measurement that changes what it measures is not one.
 * It would also put an experiment's verdict beside shipped copy in the audit history.
 *
 * So: no research result, no updateProspect, no personalisation column touched. The database
 * is read through the same read-only proxy export-writer-run.ts uses, which THROWS on any
 * write verb. The single exception is the research_usage ledger row, written with a
 * service-role client and an `arm` label, which is the point of the exercise.
 *
 * ═══ ARM C RE-FETCHES ONE SOURCE, AND ONLY ONE ══════════════════════════════
 *
 * Brief web search changes what is FETCHED, so it cannot be replayed from stored bytes. With
 * --refetch-web-search the runner re-fetches WEB SEARCH ONLY, with brief mode on, and keeps
 * the STORED linkedin, apollo and website results. So exactly one source differs from the
 * control's inputs and everything else is byte-identical.
 *
 * That is better than running arm C as a fresh production batch, for three reasons. It is
 * PAIRED on the same 40 prospects rather than compared across two cohorts. It does not need a
 * send-eligible never-researched cohort, which client zero does not currently have. And it
 * re-fetches one source instead of four, so it costs one web search rather than a full run and
 * cannot re-bill Apify or Apollo at all.
 *
 * THE COST COMPARISON IS AGAINST THE PROSPECT'S OWN STORED SEARCH COUNT. The evidence row
 * carries search_count from when brief was off, so each prospect is its own before-and-after
 * and the population mean (2.83 over 73 prospects) is a cross-check rather than the baseline.
 *
 * Run:
 *   ARM_CANDIDATE_CAP=4 npx tsx --env-file=.env.local scripts/run-cost-arm.ts \
 *     --org <uuid> --ids-file .cost-arms/cohort.txt --arm arm-a-candidate-cap --ceiling 9
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { readOnlyClient, usdForUsage } from './export-writer-run'
import { loadProspectContext } from '@/lib/agents/research/prospect-context'
import { loadEvidenceRecord } from '@/lib/agents/research/evidence-record'
import { synthesizeResearch, loadClientContext } from '@/lib/agents/research/synthesize'
import { writerInputFromSynthesis } from '@/lib/agents/research/writer-input'
import { produceOpening, resolveVariantId, loadClientName } from '@/lib/agents/research/produce-opening'
import { fetchApprovedMessagingDoc } from '@/lib/composition/compose-sequence'
import { BatchUniquenessRegistry } from '@/lib/agents/research/batch-uniqueness'
import { activeArms, briefWebSearch } from '@/lib/agents/research/cost-arms'
import { fetchWebSearchSource } from '@/lib/agents/research/sources/web-search'
import {
  usdForTokens, RESEARCH_SONNET_MODEL, COST_WEB_SEARCH_PER_SEARCH,
} from '@/lib/agents/research/cost-constants'
import type { TokenUsage } from '@/lib/agents/research/types'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function usage(msg: string): never {
  console.error(`\n  ${msg}\n`)
  console.error('  --org <uuid>           organisation')
  console.error('  --ids-file <path>      one prospect id per line. The FIXED set.')
  console.error('  --arm <label>          research_usage.arm, 1 to 64 characters')
  console.error('  --ceiling <usd>        refuse to start another prospect past this. REQUIRED.')
  console.error('  --refetch-web-search   arm C: re-fetch WEB SEARCH only, keeping the other')
  console.error('                         three stored sources. Costs one web search per prospect.')
  console.error('  --out <dir>            reading file directory (default .cost-arms)\n')
  process.exit(1)
}

interface ArmRecord {
  prospect_id: string
  first_name: string | null
  company: string | null
  candidates: number
  selected_source: string | null
  written_won: boolean
  observation: string | null
  question: string | null
  subject: string | null
  gate_failures: string[]
  synthesis_usage: TokenUsage
  opening_usage: TokenUsage
  synthesis_usd: number
  opening_usd: number
  /** Billable searches this run made. Zero on a replay, which fetches nothing. */
  search_count: number
  /** What the SAME prospect's stored evidence recorded, with brief off. The before figure. */
  stored_search_count: number
}

async function main() {
  const orgId = arg('org') ?? usage('--org is required.')
  const idsFile = arg('ids-file') ?? usage('--ids-file is required: the set must be FIXED.')
  const armLabel = arg('arm') ?? usage('--arm is required.')
  const ceilingRaw = arg('ceiling')
  const outDir = arg('out') ?? '.cost-arms'
  const refetchWebSearch = process.argv.includes('--refetch-web-search')

  // ── THE CEILING IS REQUIRED, NOT DEFAULTED ────────────────────────────────
  //
  // A default would be a number nobody chose, applied to a script whose whole job is to spend
  // money on purpose. The tuner learned the same thing: its budget is checked BEFORE a round
  // rather than during one, so a run never stops halfway through a prospect.
  if (!ceilingRaw) usage('--ceiling <usd> is required. This script spends real money.')
  const ceiling = Number(ceilingRaw)
  if (!Number.isFinite(ceiling) || ceiling <= 0) usage(`--ceiling must be a positive number, got "${ceilingRaw}".`)

  if (armLabel.length < 1 || armLabel.length > 64) usage('--arm must be 1 to 64 characters.')

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!url || !key) usage('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.')
  if (!apiKey) usage('ANTHROPIC_API_KEY must be set.')

  const ids = fs.readFileSync(idsFile, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
  if (ids.length === 0) usage(`${idsFile} contains no prospect ids.`)

  const arms = activeArms()

  // ── REFUSE TO RUN AN ARM WITH NO ARM SET ──────────────────────────────────
  //
  // Running the control means deliberately setting no variable, so an empty set is legitimate
  // ONLY when the label says so. Without this, a forgotten env var produces a full-price run
  // labelled as a saving, which is the one result that would be believed and wrong.
  const isControl = /control/i.test(armLabel)
  if (Object.keys(arms).length === 0 && !isControl) {
    usage(
      `--arm is "${armLabel}" but no ARM_* variable is set. Either set one, or name the arm ` +
      '"control" to declare that running unchanged is the intent.',
    )
  }
  if (Object.keys(arms).length > 0 && isControl) {
    usage(`--arm is "${armLabel}" but ${Object.keys(arms).join(', ')} is set. A control changes nothing.`)
  }

  // ── THE TWO HALVES OF ARM C MUST BE SET TOGETHER ──────────────────────────
  //
  // ARM_BRIEF_WEB_SEARCH only affects a FETCH. Setting it without --refetch-web-search is the
  // dangerous direction: the run replays stored bytes, nothing about the search changes, and
  // the rows are labelled as an arm that produced a saving of zero. That reads as "brief mode
  // does not work" when what happened is that brief mode never ran.
  if (briefWebSearch() && !refetchWebSearch) {
    usage(
      'ARM_BRIEF_WEB_SEARCH is set but --refetch-web-search is not. Brief mode only affects a ' +
      'fetch, so this run would replay stored sources and record a saving of zero for an arm ' +
      'that never ran.',
    )
  }
  if (refetchWebSearch && !briefWebSearch()) {
    usage(
      '--refetch-web-search without ARM_BRIEF_WEB_SEARCH would pay for a fresh search and ' +
      'change nothing. If a re-fetch at the CURRENT setting is genuinely wanted, that is a ' +
      'control for arm C and the arm label must say so.',
    )
  }

  const read = readOnlyClient(url, key)
  // A SEPARATE, ORDINARY CLIENT, used for exactly one table. The proxy above throws on every
  // write verb, which is what protects production data; the ledger is the one write this
  // script is allowed to make, so it goes through a client that can.
  const ledger = createClient(url, key)

  console.log('')
  console.log('  Cost arm run')
  console.log(`  Organisation : ${orgId}`)
  console.log(`  Prospects    : ${ids.length} (fixed set from ${idsFile})`)
  console.log(`  Arm label    : ${armLabel}`)
  console.log(`  Arm settings : ${Object.keys(arms).length ? JSON.stringify(arms) : 'NONE (control)'}`)
  console.log(`  Spend ceiling: $${ceiling.toFixed(2)}, checked before each prospect`)
  console.log('  Writes NO research result and NO prospect column. Ledger row only.')
  console.log('')

  const clientName = await loadClientName(read as never, orgId)

  // ── THE MESSAGING DOCUMENT IS SEGMENT-SCOPED, so it cannot be fetched once ──
  //
  // Fetching one document for the whole arm would brief the writer with the wrong variant set
  // for any prospect in another segment, and would differ from what the baseline did. Cached
  // per segment so a 40-prospect arm makes one read per segment rather than forty.
  const messagingBySegment = new Map<string, Awaited<ReturnType<typeof fetchApprovedMessagingDoc>>>()
  async function messagingFor(segmentId: string | null) {
    const k = segmentId ?? '(null)'
    const hit = messagingBySegment.get(k)
    if (hit) return hit
    const doc = await fetchApprovedMessagingDoc(read as never, orgId, segmentId)
    messagingBySegment.set(k, doc)
    return doc
  }

  // One registry for the whole arm, exactly as a production batch has one: the uniqueness
  // gate only exists across prospects, and an arm with no registry would be measured against
  // a baseline that had one.
  const uniqueness = new BatchUniquenessRegistry()

  const records: ArmRecord[] = []
  let spent = 0
  let skippedNoEvidence = 0
  let failed = 0
  // Counted separately as well as into `spent`, because the fee and the Haiku tokens are the
  // two halves of the web-search bill and reporting one without the other is how this project
  // understated a lookup by 10x for a month.
  let webSearchFees = 0
  let webSearchTokenUsd = 0

  for (const [i, prospectId] of ids.entries()) {
    if (spent >= ceiling) {
      console.log(`\n  CEILING REACHED after ${i} prospects ($${spent.toFixed(2)} >= $${ceiling.toFixed(2)}). Stopping.`)
      break
    }

    try {
      // `extras` carries the assigned variant, exactly as the production agent reads it.
      const { ctx, extras } = await loadProspectContext(read as never, prospectId, orgId)

      // Raw sources already on file. NOT a fresh fetch: that is what makes this arm a
      // comparison of one variable rather than of two runs.
      const evidence = await loadEvidenceRecord(read as never, prospectId, orgId)
      if (!evidence) {
        skippedNoEvidence++
        console.log(`  ${i + 1}/${ids.length} ${prospectId} SKIPPED: no stored row holds evidence`)
        continue
      }

      // ── ARM C: ONE SOURCE RE-FETCHED, THREE KEPT ─────────────────────────
      //
      // The stored web search is what this prospect got with brief OFF, so its search_count
      // is the before figure and the fresh one is the after, on the same prospect. The other
      // three sources are the stored bytes, so nothing but the search differs from the
      // control's inputs.
      const storedSearchCount = evidence.raw.web_search.search_count ?? 0
      let raw = evidence.raw
      if (refetchWebSearch) {
        const fresh = await fetchWebSearchSource(ctx)
        raw = { ...evidence.raw, web_search: fresh }
        webSearchFees += fresh.search_count * COST_WEB_SEARCH_PER_SEARCH
        webSearchTokenUsd += usdForTokens(
          { input_tokens: fresh.input_tokens, output_tokens: fresh.output_tokens },
          fresh.model,
        )
      }

      const synthesis = await synthesizeResearch(ctx, raw, orgId)
      const clientCtx = await loadClientContext(orgId, ctx.segment_id)
      const messaging = await messagingFor(ctx.segment_id)
      // THE SAME THREE ARGUMENTS PRODUCTION PASSES. An arm that assigned variants differently
      // from the baseline would be comparing copy written against different frames.
      const variantId = resolveVariantId(ctx.id, extras.variant_id, messaging.content)

      const opening = await produceOpening({
        apiKey,
        clientName,
        ctx,
        ...writerInputFromSynthesis(synthesis),
        messagingContent: messaging.content,
        variantId,
        icpBuyerTitle: clientCtx.buyerTitle,
        uniqueness,
      })

      const synthesisUsage = synthesis.usage
      const openingUsage = opening.usage
      // PRICED AT THE MODEL THE ARM ACTUALLY USED. Arm B changes the rate, so pricing its
      // tokens at Sonnet would report a saving of zero on the arm whose whole point is the rate.
      const synthModel = process.env.ARM_SYNTHESIS_MODEL || RESEARCH_SONNET_MODEL
      const synthesisUsd = usdForTokens(synthesisUsage, synthModel)
      const openingUsd = usdForUsage(openingUsage)
      // The web search is part of what this prospect cost, so the ceiling must see it. Zero
      // when the arm did not re-fetch.
      const searchUsd = refetchWebSearch
        ? raw.web_search.search_count * COST_WEB_SEARCH_PER_SEARCH
          + usdForTokens({ input_tokens: raw.web_search.input_tokens, output_tokens: raw.web_search.output_tokens }, raw.web_search.model)
        : 0
      spent += synthesisUsd + openingUsd + searchUsd

      const selected = synthesis.candidates.find(c => c.id === synthesis.selected_candidate_id)

      records.push({
        prospect_id: prospectId,
        first_name: ctx.first_name ?? null,
        company: ctx.company_name ?? null,
        candidates: synthesis.candidates.length,
        selected_source: (selected as { source?: string } | undefined)?.source ?? null,
        written_won: opening.written_won,
        observation: opening.observation ?? null,
        question: opening.question ?? null,
        subject: opening.subject ?? null,
        gate_failures: opening.gate_failures ?? [],
        synthesis_usage: synthesisUsage,
        opening_usage: openingUsage,
        synthesis_usd: synthesisUsd,
        opening_usd: openingUsd,
        search_count: refetchWebSearch ? raw.web_search.search_count : 0,
        stored_search_count: storedSearchCount,
      })

      // THE LEDGER ROW. research_result_id NULL, which the CHECK permits only because `arm`
      // is set: an arm writes no research result by design.
      const { error } = await ledger.from('research_usage').insert({
        research_result_id: null,
        organisation_id: orgId,
        prospect_id: prospectId,
        path: 'cli',
        arm: armLabel,
        synthesis: { ...synthesisUsage, model: synthModel },
        opening: openingUsage,
        followups: opening.followup_usage ?? null,
        // REAL NUMBERS WHEN THE ARM RE-FETCHED, zeroes otherwise. A zero here is a FACT
        // about a replay run, which fetched nothing and therefore ran no searches, rather
        // than a gap in the record.
        web_search: refetchWebSearch
          ? {
              input_tokens:  raw.web_search.input_tokens,
              output_tokens: raw.web_search.output_tokens,
              model:         raw.web_search.model,
              search_count:  raw.web_search.search_count,
            }
          : { input_tokens: 0, output_tokens: 0, model: null, search_count: 0 },
        synthesis_batched: false,
      } as never)
      if (error) console.error(`  LEDGER WRITE FAILED for ${prospectId}: ${error.message}`)

      console.log(
        `  ${i + 1}/${ids.length} ${prospectId} ` +
        `${opening.written_won ? 'WON ' : 'template'} ` +
        `cands=${synthesis.candidates.length} ` +
        `syn=$${synthesisUsd.toFixed(4)} open=$${openingUsd.toFixed(4)} ` +
        `running=$${spent.toFixed(2)}`,
      )
    } catch (err) {
      failed++
      console.error(`  ${i + 1}/${ids.length} ${prospectId} FAILED: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── The summary and the reading file ──────────────────────────────────────
  fs.mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = path.join(outDir, `${armLabel}-${stamp}`)

  const won = records.filter(r => r.written_won).length
  const summary = {
    arm: armLabel,
    arm_settings: arms,
    organisation_id: orgId,
    ids_file: idsFile,
    prospects_requested: ids.length,
    prospects_run: records.length,
    skipped_no_evidence: skippedNoEvidence,
    failed,
    personalised: won,
    personalised_rate: records.length ? won / records.length : 0,
    total_usd: Number(spent.toFixed(4)),
    usd_per_prospect: records.length ? Number((spent / records.length).toFixed(5)) : 0,
    mean_candidates: records.length
      ? Number((records.reduce((t, r) => t + r.candidates, 0) / records.length).toFixed(2)) : 0,
    mean_synthesis_output_tokens: records.length
      ? Math.round(records.reduce((t, r) => t + r.synthesis_usage.output_tokens, 0) / records.length) : 0,
    // ── ARM C's HEADLINE, PAIRED ───────────────────────────────────────────
    // Each prospect against its own stored count, not against a population mean. Null on a
    // replay run, where no search happened and a zero would read as a 100% saving.
    web_search: refetchWebSearch ? {
      fees_usd: Number(webSearchFees.toFixed(4)),
      token_usd: Number(webSearchTokenUsd.toFixed(4)),
      mean_search_count: records.length
        ? Number((records.reduce((t, r) => t + r.search_count, 0) / records.length).toFixed(3)) : 0,
      mean_stored_search_count: records.length
        ? Number((records.reduce((t, r) => t + r.stored_search_count, 0) / records.length).toFixed(3)) : 0,
      prospects_with_fewer_searches: records.filter(r => r.search_count < r.stored_search_count).length,
      prospects_with_more_searches: records.filter(r => r.search_count > r.stored_search_count).length,
      prospects_unchanged: records.filter(r => r.search_count === r.stored_search_count).length,
    } : null,
    notes: [
      'No research result row and no prospect column was written. Ledger row only.',
      'Synthesis ran on raw sources already on file, so only the arm variable changed.',
      'Cost is derived from returned usage. The Anthropic console is the ground truth.',
    ],
  }

  fs.writeFileSync(`${base}.json`, JSON.stringify({ summary, records }, null, 2))
  fs.writeFileSync(`${base}.reading.md`, renderReading(armLabel, arms, records))

  console.log('')
  console.log(`  Run          : ${records.length} of ${ids.length}`)
  console.log(`  Personalised : ${won} (${(summary.personalised_rate * 100).toFixed(1)}%)`)
  console.log(`  Candidates   : ${summary.mean_candidates} mean`)
  console.log(`  Synth output : ${summary.mean_synthesis_output_tokens} tokens mean`)
  if (refetchWebSearch) {
    const w = summary.web_search!
    console.log(`  Searches     : ${w.mean_search_count} mean, against ${w.mean_stored_search_count} stored (brief off)`)
    console.log(`  Paired       : ${w.prospects_with_fewer_searches} fewer, ${w.prospects_unchanged} same, ${w.prospects_with_more_searches} more`)
    console.log(`  Search cost  : $${w.fees_usd} fees + $${w.token_usd} tokens`)
  }
  console.log(`  Spend        : $${spent.toFixed(2)} ($${summary.usd_per_prospect} per prospect)`)
  console.log(`  Reading file : ${base}.reading.md`)
  console.log('')
}

/** The copy, for a human to read. Winners first, then the ones that fell back. */
function renderReading(arm: string, settings: Record<string, string>, records: ArmRecord[]): string {
  const lines: string[] = [
    `# ${arm}`,
    '',
    `Settings: ${Object.keys(settings).length ? JSON.stringify(settings) : 'none (control)'}`,
    `Generated ${new Date().toISOString()}. ${records.length} prospects.`,
    '',
    'Each prospect below: the observation the writer produced, its question, and what the',
    'research chose. A prospect marked TEMPLATE fell back to the approved copy and the',
    'observation shown is what it WOULD have said.',
    '',
  ]
  for (const r of [...records].sort((a, b) => Number(b.written_won) - Number(a.written_won))) {
    lines.push(`## ${r.first_name ?? '(no name)'} — ${r.company ?? '(no company)'}`)
    lines.push(`\`${r.prospect_id}\`   ${r.written_won ? '**PERSONALISED**' : '**TEMPLATE**'}   ` +
               `candidates ${r.candidates}, chosen from ${r.selected_source ?? 'nothing'}`)
    lines.push('')
    lines.push('```')
    lines.push(r.observation ?? '(no observation)')
    lines.push('')
    lines.push(r.question ?? '(no question)')
    lines.push('```')
    if (r.gate_failures.length > 0) {
      lines.push('')
      lines.push('Gate failures on the final attempt:')
      for (const f of r.gate_failures) lines.push(`- ${f}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

main().catch(err => { console.error(err); process.exit(1) })
