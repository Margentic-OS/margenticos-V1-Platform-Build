#!/usr/bin/env npx tsx
/**
 * THE DRY RUN OF THE TWO RESEARCH ARMS: six named prospects, three per arm, through the real batch route.
 *
 *   npx tsx --env-file=.env.local scripts/research-arm-dry-run.ts --org <uuid> --ids a,b,c,d,e,f [--max-usd 2]
 *
 * It does what production does, with the same functions: store a balanced plan, enqueue phase 1 by
 * id, run the queue worker, submit the Anthropic batch, collect it, and read back what each arm cost.
 * It sends nothing: research writes rows and spends money; uploading is a separate action.
 *
 * REFUSES TO START unless all of these hold, and says which one failed:
 *   - exactly six distinct prospect ids, all in this organisation, none suppressed, none researched
 *     before (a reuse run makes no synthesis call, so it could not show an arm)
 *   - the batch route is the live research path (queue_research_sources on, and not half-enabled)
 *   - no other batch work is in flight for this organisation (queued research jobs or pending batch
 *     entries for other prospects, which the sweep would submit and bill under this run's name)
 *   - the projected spend is within --max-usd
 *   - all six pass the research eligibility gate and the competitor check
 *
 * THE CAP IS A PROJECTION, NOT A METER. The batch route bills after the fact, so the cap is checked
 * against PROJECTED_PER_PROSPECT_USD x 6 before anything is queued. The ledger is read back at the
 * end and printed beside the cap; an overrun is printed as an overrun, not hidden.
 */

import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { resolveResearchRouting } from '@/lib/operator/research-path'
import { enqueueResearchForOrganisation, selectProspectsForResearch } from '@/lib/queue/enqueue/research'
import { runWorker } from '@/lib/queue/run-worker'
import { runSynthesisBatchSweep } from '@/lib/agents/research/batch-sweep'
import { storeBalancedPlan } from '@/lib/agents/research/research-arm-store'
import { buildArmReport, type ArmReportRow } from '@/lib/operator/research-arm-report'
import { researchUsageRowUsd, type ResearchUsageRow } from '@/lib/operator/run-spend'
import { armOf, type ResearchArm } from '@/lib/agents/research/research-arm'

/**
 * Measured per prospect on the batch route, 2026-10-01 to 2026-10-05, from research_usage and the
 * cost-arm notes: sources about $0.08, one batched synthesis about $0.10, writer and judges about
 * $0.03, follow-ups and firm fact about $0.02. Rounded up to $0.23. A projection, stated as one.
 */
const PROJECTED_PER_PROSPECT_USD = 0.23
const PROSPECTS = 6
const DEADLINE_MINUTES = 100
const POLL_SECONDS = 60
const WORKER_BUDGET_SECONDS = 200

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function refuse(reason: string): never {
  console.error('')
  console.error(`  REFUSED: ${reason}`)
  console.error('  Nothing was queued, no arm was stored and nothing was spent.')
  console.error('')
  process.exit(1)
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  const orgId = arg('org')
  if (!orgId) refuse('Missing --org.')
  const idsRaw = arg('ids')
  if (!idsRaw) refuse('Missing --ids. Give six prospect ids, separated by commas.')
  const ids = idsRaw.split(',').map(s => s.trim()).filter(Boolean)
  if (ids.length !== PROSPECTS || new Set(ids).size !== PROSPECTS) {
    refuse(`--ids must name exactly ${PROSPECTS} distinct prospects, got ${ids.length} (${new Set(ids).size} distinct).`)
  }
  const capRaw = arg('max-usd') ?? '2'
  const capUsd = Number(capRaw)
  if (!Number.isFinite(capUsd) || capUsd <= 0) refuse(`--max-usd must be a positive number, got "${capRaw}".`)

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!url || !key || !apiKey) refuse('NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ANTHROPIC_API_KEY must be set. Pass --env-file=.env.local.')
  const supabase = createClient(url, key)
  const anthropic = new Anthropic({ apiKey })

  // ── 1. The organisation and the six prospects ──────────────────────────────
  const { data: org } = await supabase.from('organisations').select('name').eq('id', orgId).is('archived_at', null).maybeSingle()
  if (!org) refuse(`Organisation ${orgId} not found or archived.`)

  const { data: prospects, error: pError } = await supabase
    .from('prospects')
    .select('id, suppressed, research_arm, current_research_result_id')
    .eq('organisation_id', orgId)
    .in('id', ids)
  if (pError) refuse(`Could not read the prospects: ${pError.message}`)
  if ((prospects ?? []).length !== PROSPECTS) refuse(`${(prospects ?? []).length} of ${PROSPECTS} ids are in this organisation.`)
  const suppressed = (prospects ?? []).filter(p => p.suppressed === true).map(p => p.id)
  if (suppressed.length > 0) refuse(`${suppressed.length} prospect(s) are suppressed.`)
  const alreadyArmed = (prospects ?? []).filter(p => p.research_arm != null).map(p => p.id)
  if (alreadyArmed.length > 0) refuse(`${alreadyArmed.length} prospect(s) already hold an arm. A dry run needs fresh prospects.`)

  const { data: priorRows, error: priorError } = await supabase
    .from('prospect_research_results')
    .select('prospect_id')
    .eq('organisation_id', orgId)
    .in('prospect_id', ids)
  if (priorError) refuse(`Could not check for prior research: ${priorError.message}`)
  if ((priorRows ?? []).length > 0) refuse(`${new Set((priorRows ?? []).map(r => r.prospect_id)).size} prospect(s) already have research. A reuse run makes no synthesis call, so it cannot show an arm.`)

  // ── 2. The batch route must be the live path ───────────────────────────────
  const routing = await resolveResearchRouting(supabase, { useStoredFindings: true, freshPolicy: 'inline' })
  if (routing.kind !== 'queue' || routing.jobType !== 'research_sources' || !routing.batched) {
    refuse(`The batch route is not the live research path (routing: ${JSON.stringify(routing)}). Turn on queue_research_sources first.`)
  }

  // ── 3. Nothing else in flight for this organisation ───────────────────────
  const { data: inFlight, error: flightError } = await supabase
    .from('job_queue')
    .select('id, prospect_id, job_type, state')
    .eq('organisation_id', orgId)
    .in('job_type', ['research', 'research_sources', 'research_collect'])
    .in('state', ['queued', 'claimed'])
  if (flightError) refuse(`Could not read the queue: ${flightError.message}`)
  const foreignJobs = (inFlight ?? []).filter(j => !ids.includes(j.prospect_id as string))
  if (foreignJobs.length > 0) refuse(`${foreignJobs.length} other research job(s) are queued or running for this organisation. The sweep would bill them under this run.`)

  const { data: pending, error: pendingError } = await supabase
    .from('synthesis_batch_entries')
    .select('prospect_id')
    .eq('organisation_id', orgId)
    .eq('state', 'pending_submission')
  if (pendingError) refuse(`Could not read pending batch entries: ${pendingError.message}`)
  const foreignPending = (pending ?? []).filter(e => !ids.includes(e.prospect_id as string))
  if (foreignPending.length > 0) refuse(`${foreignPending.length} other batch entries are waiting to be submitted for this organisation.`)

  // ── 4. The projection, against the cap ────────────────────────────────────
  const projected = PROSPECTS * PROJECTED_PER_PROSPECT_USD
  console.log('')
  console.log('  Research-arm dry run')
  console.log(`  Organisation : ${org?.name} (${orgId})`)
  console.log(`  Prospects    : ${PROSPECTS}, three per arm`)
  console.log(`  Projected    : $${projected.toFixed(2)} = ${PROSPECTS} x $${PROJECTED_PER_PROSPECT_USD.toFixed(2)} (a projection, see the top of this script)`)
  console.log(`  Cap          : $${capUsd.toFixed(2)} (--max-usd)`)
  if (projected > capUsd) refuse(`the projected spend $${projected.toFixed(2)} is over the $${capUsd.toFixed(2)} cap.`)

  // ── 5. Eligibility, then the plan, then the enqueue ───────────────────────
  const selected = await selectProspectsForResearch(supabase, orgId, 'unresearched', 5000, ids)
  if (!selected.ok) refuse(selected.error)
  if (selected.selection.enqueueable.length !== PROSPECTS) {
    refuse(`only ${selected.selection.enqueueable.length} of ${PROSPECTS} pass the research eligibility gate (${JSON.stringify(selected.selection.skippedReasons)}).`)
  }

  const startedAt = new Date().toISOString()
  const plan = await storeBalancedPlan(supabase, orgId, ids)
  const planLine = (arm: ResearchArm) => ids.filter(id => plan.get(id) === arm).map(id => id.slice(0, 8)).join(', ')
  console.log(`  Arm A (short): ${planLine('short_reasoning')}`)
  console.log(`  Standard     : ${planLine('standard')}`)

  const enqueued = await enqueueResearchForOrganisation(
    supabase, orgId, 'unresearched', 'cli:research-arm-dry-run', undefined, 'research_sources', ids,
  )
  if (!enqueued.ok) refuse(enqueued.error)
  if (enqueued.created !== PROSPECTS) {
    refuse(`only ${enqueued.created} of ${PROSPECTS} were queued (${enqueued.competitorNote ?? 'no note'}). The arms are stored on the six prospects; a later real run will reuse them.`)
  }
  console.log(`  Queued       : ${enqueued.created}`)
  console.log('')

  // ── 6. Drive the real pipeline until every prospect has a research row, or the deadline ─
  const deadline = Date.now() + DEADLINE_MINUTES * 60_000
  let done = 0
  for (;;) {
    await runWorker({ supabase, workerId: 'research-arm-dry-run', budgetSeconds: WORKER_BUDGET_SECONDS })
    const sweep = await runSynthesisBatchSweep(supabase, anthropic)
    if (sweep.errors.length > 0) console.log(`  sweep errors : ${sweep.errors.join('; ')}`)

    const { data: rows } = await supabase
      .from('prospect_research_results')
      .select('prospect_id')
      .eq('organisation_id', orgId)
      .in('prospect_id', ids)
      .gte('created_at', startedAt)
    done = new Set((rows ?? []).map(r => r.prospect_id)).size
    console.log(`  ${new Date().toISOString()}  research rows for the six: ${done}/${PROSPECTS}`)
    if (done >= PROSPECTS || Date.now() > deadline) break
    await sleep(POLL_SECONDS * 1000)
  }

  // ── 7. What each arm cost, read back from the ledger ───────────────────────
  const { data: results } = await supabase
    .from('prospect_research_results')
    .select('id, prospect_id, research_arm, signal_relevance, icp_fit, synthesis_batch_id')
    .eq('organisation_id', orgId)
    .in('prospect_id', ids)
    .gte('created_at', startedAt)
  const resultIds = (results ?? []).map(r => r.id as string)
  const { data: usage } = await supabase
    .from('research_usage')
    .select('research_result_id, synthesis, opening, followups, web_search, synthesis_batched, firm_fact')
    .in('research_result_id', resultIds)
  const usdByResult = new Map<string, number | null>()
  for (const row of usage ?? []) {
    usdByResult.set(row.research_result_id as string, researchUsageRowUsd(row as ResearchUsageRow))
  }

  const rows: ArmReportRow[] = (results ?? []).map(r => ({
    research_arm: armOf(r.research_arm as string | null),
    signal_relevance: r.signal_relevance as string | null,
    icp_fit: r.icp_fit as string | null,
    sourced_tier: null,
    usd: usdByResult.get(r.id as string) ?? null,
  }))
  const report = buildArmReport(rows)
  const totalUsd = rows.reduce((sum, r) => sum + (r.usd ?? 0), 0)

  // Evidence that the arm reached the model: the synthesis output per arm. The instruction is only
  // in the short arm's user message, so if it did not reach Anthropic the two means would match.
  const armOfResult = new Map((results ?? []).map(r => [r.id as string, armOf(r.research_arm as string | null)]))
  const outputTokens: Record<ResearchArm, number[]> = { standard: [], short_reasoning: [] }
  for (const row of usage ?? []) {
    const arm = armOfResult.get(row.research_result_id as string)
    const syn = row.synthesis as { output_tokens?: unknown } | null
    if (arm && typeof syn?.output_tokens === 'number') outputTokens[arm].push(syn.output_tokens)
  }
  const meanOutput = (xs: number[]) => (xs.length === 0 ? 'n/a' : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length).toString())

  console.log('')
  console.log('  RESULT, the six prospects')
  for (const arm of ['standard', 'short_reasoning'] as const) {
    const line = report[arm]
    const per = line.researches > 0 ? line.usd / line.researches : null
    console.log(`  ${arm.padEnd(16)} researched ${line.researches}  personalised ${line.personalised}  fit ${JSON.stringify(line.fitGrades)}`)
    console.log(`  ${''.padEnd(16)} cost per prospect $${per === null ? 'n/a' : per.toFixed(4)}  (${line.costed} costed, ${line.unpriced} unpriced)`)
    console.log(`  ${''.padEnd(16)} synthesis output tokens, mean ${meanOutput(outputTokens[arm])} over ${outputTokens[arm].length}`)
  }
  console.log('')
  console.log(`  Spent (ledger) : $${totalUsd.toFixed(4)} against the $${capUsd.toFixed(2)} cap${totalUsd > capUsd ? '  OVER THE CAP' : ''}`)
  if (done < PROSPECTS) {
    console.log(`  INCOMPLETE: ${done} of ${PROSPECTS} finished before the ${DEADLINE_MINUTES}-minute deadline. The batch may still be running; re-run the report, do not re-run the dry run.`)
  }
  console.log('')
}

main().catch(err => {
  console.error('research-arm dry run failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
