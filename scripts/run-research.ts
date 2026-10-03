#!/usr/bin/env npx tsx
/**
 * Run prospect research for one organisation, from the command line.
 *
 * Run with:
 *   npx tsx --env-file=.env.local scripts/run-research.ts --org <uuid> --scope unresearched
 *
 * This calls the SAME entry point the operator dashboard calls
 * (src/lib/operator/research-batch-entry.ts), so a run from here and a click in the
 * dashboard make identical decisions about caps, archived organisations, concurrent runs
 * and overwriting finished copy.
 *
 * It replaces src/lib/agents/run-dogfood-batch-2.ts, which hardcoded one organisation id
 * and eleven prospect ids. Nothing is hardcoded here.
 *
 * WHAT THIS CAN DO THAT THE DASHBOARD CANNOT
 *
 *   --allow-overwrite-trigger
 *     Researching a prospect that already has a personalisation trigger REPLACES that copy
 *     with newly generated wording, and CLEARS it outright when the judge holds. That is a
 *     legitimate thing to want and a bad thing to do by accident, so it lives behind this
 *     flag and no dashboard control can set it. If the copy has already been sent, the
 *     stored record will no longer match what the prospect received.
 *
 *   --fresh
 *     Fetches all four sources again instead of reusing findings already on file. This is
 *     the expensive half of a run. The default reuses, deliberately: on 2026-08-20 the old
 *     fetch-always default turned 13 prospects into 176 research runs and 22 USD in one day.
 *
 * THE SPEND CAP
 *
 *   --max-usd <n>
 *     The most this run may spend, in US dollars. 3 when it is left off. This script has no
 *     meter: the research pipeline prices nothing back to its caller while it runs. So the
 *     cap is applied BEFORE the run. The worst case for the selected prospects is worked
 *     out, printed, and the run is refused when it is over the cap. Nothing is researched
 *     or queued by a refused run. It applies to a queued run too. QUEUING IS NOT FREE IN
 *     THIS PROCESS: before a job is queued the competitor check runs here, and where it
 *     asks the model about a company that question is paid for by this process (at most 60
 *     questions a run, each a little over a cent at its worst). Queuing then commits the
 *     worker to spending the rest. Both are allowed for in the worst case checked against
 *     the cap.
 *     After an inline run, what the usage ledger recorded is printed beside the cap.
 *
 * EVERY FLAG THAT TAKES A VALUE TAKES A SPACE: --ids a,b, not --ids=a,b. The equals form of
 * any of them is refused before anything is paid for, because it would otherwise not be
 * read at all: --ids=a,b would fall to the whole scope, --scope=researched to the default
 * scope, and --max-usd=1 to the default cap. Until 2026-10-02 only --max-usd was refused.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { resolveResearchRouting } from '@/lib/operator/research-path'
import { enqueueResearchForOrganisation, selectProspectsForResearch } from '@/lib/queue/enqueue/research'
import { STORED_FINDINGS_MAX_AGE_DAYS } from '@/lib/agents/prospect-research-agent-v2'
import { SYNTHESIS_MAX_OUTPUT_TOKENS } from '@/lib/agents/research/synthesize'
import {
  RunSpend, parseCapUsd, researchFetchWorstCaseUsd, researchUsageRowUsd, valueFlagProblems, type ResearchUsageRow,
} from '@/lib/operator/run-spend'
import {
  runResearchBatchForOrg,
  RESEARCH_MAX_PROSPECTS,
  type ResearchScope,
} from '@/lib/operator/research-batch-entry'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

/**
 * The flags of this script that take a value. Each is read ONLY as --name value. EVERY
 * NAME arg() IS CALLED WITH BELONGS HERE: one left off is a flag whose equals form is
 * dropped without a word. A test reads this file and holds the two in step.
 */
const VALUE_FLAGS = ['org', 'scope', 'ids', 'runtime-budget', 'max-usd'] as const

// ─── What one prospect can cost, for the check made BEFORE the run ───────────
//
// ESTIMATES, NOT A METER. Two figures, each the sum of recorded costs with room for the
// retries this pipeline is known to make. They are deliberately high: this check is the
// only cap the run has, and a guard that errs low is watched and reassures.
//
// A PROSPECT REUSING FINDINGS ON FILE: $0.10. No source is fetched and nothing is
// synthesised. What is paid:
//     writer, floor judge, judge   about $0.03, measured on writer-only re-runs of a
//                                  20-prospect cohort on 2026-10-01 (the operator's run
//                                  notes; not recorded in this repository). Doubled to
//                                  $0.06, because a retry runs the writer again.
//     then ONE of                  follow-ups, about $0.008 each as recorded in
//                                  scripts/backfill-followups.ts, when the opening won; or
//                                  the firm-fact extraction, at most $0.02
//                                  (FIRM_FACT_CEILING_USD), when it did not. Never both.
//                                  Allowed for at $0.02.
//     the competitor check         about a tenth of a cent a question as recorded in
//                                  scripts/run-competitor-screen.ts. Allowed for at $0.01.
//   0.06 + 0.02 + 0.01 = $0.09, rounded up.
//
// A PROSPECT FETCHING EVERY SOURCE: COMPUTED, $1.00 at the time of writing.
//     everything but synthesis     about $0.08. A whole research run is about $0.26, the
//                                  same cohort's full run on 2026-10-01 ($5.27 over 20,
//                                  the operator's run notes). The figure this repository
//                                  records is lower, about $0.21 to $0.22
//                                  (cost-constants.ts, measured 2026-09-14); the higher
//                                  and newer one is used. Of that, an average synthesis is
//                                  about $0.18 (cost-constants.ts). It is taken out here
//                                  because synthesis is priced at its ceiling below.
//     firm fact, competitor check  $0.02 and $0.01, as above.
//     TWO syntheses, each at the   SYNTHESIS_MAX_OUTPUT_TOKENS at the research model's
//     OUTPUT CEILING, full price   full output price: 24,000 tokens at $15 a million is
//                                  $0.36 each. A synthesis answer cut off at the ceiling
//                                  is retried once and both are billed (ADR-059), and that
//                                  happened to 2 of 7 on 2026-09-14, so it is priced in,
//                                  not treated as rare. The retry can be cut off as well.
//     the INPUT of those two       on a COLD cache: the system prefix written to cache
//     syntheses                    (SYNTHESIS_SYSTEM_PREFIX_TOKENS at $3.75 a million) and
//                                  the prospect's own part (SYNTHESIS_USER_TOKENS at $3),
//                                  about $0.04 each. An answer that long can outlive the
//                                  cache's five minutes, so the retry may write it again.
//   0.08 + 0.02 + 0.01 + 2 x 0.36 + 2 x 0.04 = $0.91, rounded up to the next ten cents.
//   Until the second fix round of 2026-10-02 the input side was left to the rounding and
//   the figure was $0.90, under the $0.91 it has to cover.
//
// UNTIL 2026-10-02 THIS WAS A FIXED $0.50, AND IT WAS NOT A WORST CASE. It priced the
// discarded answer as "one more synthesis, about $0.18", which is an AVERAGE answer of
// about 11,700 output tokens. An answer that reaches the ceiling is billed for all 24,000:
// $0.36, not $0.18. So a prospect whose answer was cut off once cost about $0.65, one whose
// retry was cut off too about $0.83, and six of them were admitted under a $3 cap. The
// arithmetic now lives in researchFetchWorstCaseUsd (src/lib/operator/run-spend.ts) and is
// worked out from the ceiling and the price table, so it moves when either does.
//
// A queued run is priced at the same figures. The Batch API bills synthesis at half, so
// that over-states it, which is the direction a spend guard has to err.
//
// IF THESE DRIFT, the closing line of an inline run says so: it prints what the usage
// ledger recorded, and flags a run that spent more than its cap.
const REUSE_WORST_USD = 0.10
/** A whole run less an average synthesis (0.26 - 0.18), the firm fact, the competitor check. */
const FETCH_OTHER_THAN_SYNTHESIS_USD = 0.08 + 0.02 + 0.01
/**
 * The cached system prefix of one synthesis request: "measured at roughly 8,500 tokens"
 * (the comment on the retry instruction in src/lib/agents/research/synthesize.ts).
 */
const SYNTHESIS_SYSTEM_PREFIX_TOKENS = 8_500
/**
 * The rest of one synthesis request, the prospect's own sources: about 3,000 tokens. Derived,
 * not counted: one whole request measured about 46 KB on 2026-09-23 (the real request
 * builder run over every batch entry in production), and the system prefix above is most of
 * it. If a request grows, raise this; the worst case moves with it.
 */
const SYNTHESIS_USER_TOKENS = 3_000
const FETCH_WORST_USD = researchFetchWorstCaseUsd({
  otherThanSynthesisUsd: FETCH_OTHER_THAN_SYNTHESIS_USD,
  synthesisMaxOutputTokens: SYNTHESIS_MAX_OUTPUT_TOKENS,
  synthesisSystemPrefixTokens: SYNTHESIS_SYSTEM_PREFIX_TOKENS,
  synthesisUserTokens: SYNTHESIS_USER_TOKENS,
})

type Read<T> = ({ ok: true } & T) | { ok: false; error: string }

/**
 * How many of these prospects have findings on file that a reuse run would use.
 *
 * The run does NOT reuse for a prospect with nothing usable inside the reuse window: it
 * falls back to fetching every source, at several times the price, and says so only in the
 * log. `--scope unresearched` is that case for every prospect. So "reuse is the default"
 * cannot be taken as "this run reuses", and the mix is counted.
 *
 * THE SAME READ research-batch-entry.ts makes for its runtime estimate (estimateSeconds),
 * copied because that function is not exported. Two copies of one question is the wrong
 * shape; the fix is to export the count from there and delete this.
 *
 * Read in groups of 40, the entry point's own ceiling, so one read cannot return more rows
 * than the API hands back at once. A truncated read would miss prospects, and a missed
 * prospect is counted as fetching, so it errs high.
 */
async function countWithStoredFindings(
  supabase: SupabaseClient,
  organisationId: string,
  ids: string[],
): Promise<Read<{ count: number }>> {
  const cutoff = new Date(Date.now() - STORED_FINDINGS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const withFindings = new Set<string>()
  for (let from = 0; from < ids.length; from += 40) {
    const { data, error } = await supabase
      .from('prospect_research_results')
      .select('prospect_id')
      .eq('organisation_id', organisationId)
      .in('prospect_id', ids.slice(from, from + 40))
      .gte('created_at', cutoff)
      .not('candidates', 'is', null)
      .neq('candidates', '[]')
    if (error) return { ok: false, error: error.message }
    for (const row of data ?? []) withFindings.add(row.prospect_id as string)
  }
  return { ok: true, count: ids.filter(id => withFindings.has(id)).length }
}

/** When the newest CLI usage row for this organisation was written. Null when there is none. */
async function newestCliUsageRow(supabase: SupabaseClient, organisationId: string): Promise<Read<{ at: string | null }>> {
  const { data, error } = await supabase
    .from('research_usage')
    .select('created_at')
    .eq('organisation_id', organisationId)
    .eq('path', 'cli')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) return { ok: false, error: error.message }
  return { ok: true, at: (data?.[0]?.created_at as string | undefined) ?? null }
}

/**
 * What the usage ledger recorded for this organisation's CLI runs after `since`.
 *
 * `since` is the database's own timestamp of the newest row before the run, not this
 * machine's clock, so a clock that disagrees with the database cannot drop or add rows.
 */
async function ledgerSpendSince(
  supabase: SupabaseClient,
  organisationId: string,
  since: string | null,
): Promise<Read<{ usd: number; rows: number; unpriced: number }>> {
  let query = supabase
    .from('research_usage')
    .select('synthesis, opening, followups, web_search, synthesis_batched, firm_fact')
    .eq('organisation_id', organisationId)
    .eq('path', 'cli')
  if (since) query = query.gt('created_at', since)
  const { data, error } = await query
  if (error) return { ok: false, error: error.message }
  let usd = 0
  let unpriced = 0
  for (const row of (data ?? []) as ResearchUsageRow[]) {
    const cost = researchUsageRowUsd(row)
    if (cost === null) unpriced++
    else usd += cost
  }
  return { ok: true, usd, rows: (data ?? []).length, unpriced }
}

function usage(message: string): never {
  console.error(`\n${message}\n`)
  console.error('Usage:')
  console.error('  npx tsx --env-file=.env.local scripts/run-research.ts --org <uuid> [options]')
  console.error('')
  console.error('  --org                       organisation id. Required. Must not be archived.')
  console.error('  --scope                     unresearched (default) or researched.')
  console.error('  --ids                       comma-separated prospect ids. Overrides --scope.')
  console.error('  --fresh                     fetch every source again instead of reusing findings on file.')
  console.error('  --allow-overwrite-trigger   permit overwriting copy that already exists. Read the header.')
  console.error('  --no-followups              inline runs only: do not write the personalised Emails 2 and 3.')
  console.error('  --runtime-budget <seconds>  raise the 240s admission budget. CLI only; the 240s default')
  console.error('                              guards a Vercel 300s limit a command line does not have.')
  console.error('  --max-usd <usd>             the most this run may spend. Default 3. The worst case for the')
  console.error('                              selected prospects is checked against it before anything is paid for:')
  console.error(`                              $${REUSE_WORST_USD.toFixed(2)} a prospect reusing findings, $${FETCH_WORST_USD.toFixed(2)} a prospect fetching`)
  console.error('                              every source (two full-length syntheses on a cold cache).')
  console.error('')
  console.error(`  At most ${RESEARCH_MAX_PROSPECTS} prospects per run, and fewer when sources must be fetched.`)
  console.error('')
  process.exit(1)
}

async function main() {
  // REFUSED BEFORE ANYTHING IS READ: a value flag written with an equals sign. arg() reads
  // the argument AFTER the flag, so --ids=a,b is one argument it does not recognise and the
  // run would go ahead as if it had not been typed: the whole scope instead of the named
  // few, the default scope, the default budget, or the default cap, which is the expensive
  // mistake whenever the cap somebody typed was lower.
  const misread = valueFlagProblems(process.argv.slice(2), VALUE_FLAGS, 'space')
  if (misread.length > 0) usage(`${misread.join('.\n')}.`)

  const orgId = arg('org')
  if (!orgId) usage('Missing --org.')

  const scopeRaw = arg('scope') ?? 'unresearched'
  if (scopeRaw !== 'unresearched' && scopeRaw !== 'researched') {
    usage(`--scope must be unresearched or researched, got "${scopeRaw}".`)
  }
  const scope = scopeRaw as ResearchScope

  const idsRaw = arg('ids')
  const prospectIds = idsRaw
    ? idsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : undefined

  const useStoredFindings = !flag('fresh')
  const allowOverwriteTrigger = flag('allow-overwrite-trigger')
  const noFollowups = flag('no-followups')

  // CLI-ONLY RUNTIME BUDGET. See ResearchBatchEntryInput.runtime_budget_seconds: the 240s
  // default guards a Vercel 300s function limit that a command line does not have. Same
  // shape as --allow-overwrite-trigger above, and for the same reason.
  const budgetRaw = arg('runtime-budget')
  const runtimeBudgetSeconds = budgetRaw === undefined ? undefined : Number(budgetRaw)
  if (runtimeBudgetSeconds !== undefined && (!Number.isFinite(runtimeBudgetSeconds) || runtimeBudgetSeconds <= 0)) {
    usage(`--runtime-budget must be a positive number of seconds, got "${budgetRaw}".`)
  }

  // THE SPEND CAP. Its equals form was refused at the top of main with the other flags.
  const spend = (() => {
    try {
      return new RunSpend(parseCapUsd(arg('max-usd')))
    } catch (err) {
      return usage(err instanceof Error ? err.message : String(err))
    }
  })()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) usage('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Pass --env-file=.env.local.')
  if (!process.env.ANTHROPIC_API_KEY) usage('ANTHROPIC_API_KEY must be set.')

  const supabase = createClient(url, key)

  const { data: org } = await supabase
    .from('organisations')
    .select('name')
    .eq('id', orgId)
    .single()

  console.log('')
  console.log('  Research run')
  console.log(`  Organisation : ${org?.name ?? 'unknown'} (${orgId})`)
  console.log(`  Selection    : ${prospectIds ? `${prospectIds.length} explicit ids` : scope}`)
  console.log(`  Sources      : ${useStoredFindings ? 'reuse findings on file where available' : 'FETCH EVERY SOURCE'}`)
  if (allowOverwriteTrigger) {
    console.log('  OVERWRITE    : ON. Existing personalisation copy will be replaced or cleared.')
  }
  console.log('  Calls the Anthropic API. Costs real money.')
  console.log(`  Spend cap    : $${spend.capUsd.toFixed(2)} (--max-usd)`)
  console.log('')

  // ── WHICH PATH, THE SAME DECISION THE DASHBOARD MAKES ─────────────────────
  //
  // Until 2026-09-25 this script always ran INLINE, whatever the queue flags said, because
  // the routing lived in the HTTP route and nothing here read it. queue_research_sources had
  // been true since 2026-09-14, so the Batch API path — which bills synthesis at 50% — was
  // switched on for eleven days while all 300 CLI-driven runs of 2026-09-23 to 25 paid full
  // price. Synthesis is 90.6% of a prospect's Anthropic cost, so that is about $0.10 each.
  //
  // freshPolicy 'inline' is the ONE difference from the route, and it is what --fresh is
  // for: a queued job carries no per-job options and always reuses stored findings, so a
  // fresh fetch cannot be queued. The route refuses it and points here. This is here.
  const routing = await resolveResearchRouting(supabase, {
    useStoredFindings,
    freshPolicy: 'inline',
  })

  if (routing.kind === 'refuse') {
    console.error('')
    console.error(`  REFUSED: ${routing.reason}`)
    console.error('')
    process.exit(1)
  }

  // ── THE SPEND CHECK, BEFORE ANYTHING IS PAID FOR OR QUEUED ─────────────────
  //
  // Who the run would research, as far as can be known before it selects them:
  //
  //   --ids           the ids as typed. The entry point's own gates can only remove some,
  //                   which lowers the cost, so this is an upper bound.
  //   a scope run     the population selectProspectsForResearch reads. It is the function
  //                   the queue path selects with and it writes nothing. The inline path
  //                   selects by the same rules but does not leave out a prospect held by
  //                   a live job elsewhere, so for an inline run those are added back, and
  //                   counted as fetching because their ids are not returned.
  //
  // The count is read a moment before the run reads it again. A prospect added in between
  // is not in the estimate. That gap is seconds wide and is accepted.
  const willQueue = routing.kind === 'queue' && !prospectIds
  let estimateIds: string[]
  let unlisted = 0
  if (prospectIds) {
    estimateIds = [...new Set(prospectIds)]
  } else {
    const read = await selectProspectsForResearch(supabase, orgId, scope)
    if (!read.ok) {
      console.error('')
      console.error(`  REFUSED: ${read.error}`)
      console.error('')
      process.exit(1)
    }
    estimateIds = read.selection.enqueueable
    if (!willQueue) unlisted = read.selection.skippedLiveElsewhere
  }

  // FAILS HIGH. A read that errors counts every prospect as fetching, so a database fault
  // produces a refusal and never an admitted run that was priced as cheap.
  const stored = useStoredFindings && estimateIds.length > 0
    ? await countWithStoredFindings(supabase, orgId, estimateIds)
    : { ok: true as const, count: 0 }
  const reusing = stored.ok ? stored.count : 0
  const fetching = estimateIds.length - reusing + unlisted
  const worstCaseUsd = reusing * REUSE_WORST_USD + fetching * FETCH_WORST_USD
  const arithmetic =
    `${reusing} reusing findings on file x $${REUSE_WORST_USD.toFixed(2)} + ` +
    `${fetching} fetching every source x $${FETCH_WORST_USD.toFixed(2)}`

  if (!stored.ok) console.log(`  Stored findings could not be counted (${stored.error}), so every prospect is priced as fetching.`)
  console.log(`  Worst case   : $${worstCaseUsd.toFixed(2)} = ${arithmetic}`)
  console.log('                 An estimate from recorded costs, not a meter. See the top of this script.')
  console.log('                 A fetching prospect is priced at two syntheses cut off at full length, on a cold cache.')

  if (!spend.canAfford(worstCaseUsd)) {
    console.error('')
    console.error(`  REFUSED: the worst case for this run is $${worstCaseUsd.toFixed(2)}, over the $${spend.capUsd.toFixed(2)} cap.`)
    console.error(`           ${arithmetic}`)
    console.error(`           Nothing was researched${willQueue ? ' or queued' : ''} and nothing was spent.`)
    console.error(`           Run fewer prospects with --ids, or raise the cap: --max-usd ${Math.ceil(worstCaseUsd)}`)
    console.error('')
    process.exit(1)
  }

  // Explicit ids cannot be enqueued: enqueueResearchForOrganisation selects by SCOPE, and
  // there is no ids-based enqueue. Said out loud rather than silently downgraded, because
  // the whole point of this change is that the expensive path is never taken by accident.
  if (routing.kind === 'queue' && prospectIds) {
    console.log('  PATH         : INLINE. --ids cannot be enqueued (enqueue selects by scope).')
    console.log('                 Synthesis pays FULL price. Use --scope to get the batch discount.')
  }

  if (routing.kind === 'queue' && !prospectIds) {
    const enqueued = await enqueueResearchForOrganisation(
      supabase, orgId, scope, 'cli:run-research', undefined, routing.jobType,
    )
    if (!enqueued.ok) {
      console.error('')
      console.error(`  REFUSED: ${enqueued.error}`)
      console.error('')
      process.exit(1)
    }
    console.log('')
    console.log(`  PATH         : QUEUE${routing.batched ? ' (Batch API, synthesis at 50%)' : ' (single job, standard price)'}`)
    console.log(`  Job type     : ${routing.jobType}`)
    console.log(`  Selected     : ${enqueued.selected}`)
    console.log(`  Queued       : ${enqueued.created}`)
    console.log(`  Already queued: ${enqueued.alreadyQueued}`)
    if (enqueued.competitorNote) console.log(`  Not queued   : ${enqueued.competitorNote}`)
    console.log('')
    // THE LINE THIS REPLACES said no money had moved yet. Some may have: the competitor
    // check ran in this process before anything was queued, and each company it asked the
    // model about was a paid question. Nothing here meters it: it writes no usage row.
    console.log('  The queue worker processes these. Nothing was researched by this process.')
    console.log('  ALREADY SPENT HERE: whatever the competitor check asked the model before queuing (about a')
    console.log('  tenth of a cent a question, a little over a cent at its worst). It is not in the usage ledger.')
    console.log(`  The worst case above ($${worstCaseUsd.toFixed(2)} against a $${spend.capUsd.toFixed(2)} cap) covers that, and what the worker may go on to spend.`)
    console.log('')
    return
  }

  if (routing.kind === 'inline') {
    console.log(`  PATH         : INLINE (${routing.reason === 'explicit_fresh' ? '--fresh, cannot be queued' : 'queue flags off'})`)
    console.log('                 Synthesis pays FULL price, about 2x the batch rate.')
  }

  // Where the usage ledger stood before the run, so what this run added can be read back.
  const before = await newestCliUsageRow(supabase, orgId)

  /**
   * What the run actually spent, as far as the ledger knows. THE PRE-FLIGHT CHECK ABOVE IS
   * STILL THE ONLY CAP: this is read after the money is gone, and exists so an estimate
   * that has drifted low is seen on the run where it happened.
   */
  const printLedgerSpend = async (completed: number | null) => {
    const read = before.ok ? await ledgerSpendSince(supabase, orgId, before.at) : before
    if (!read.ok) {
      console.log(`  Spent (ledger)      : NOT READ (${read.error}). The worst case above is the only figure for this run.`)
      return
    }
    spend.add(read.usd)
    console.log(`  Spent (ledger)      : ${spend.summary()}, from ${read.rows} usage row(s) written by CLI runs for this organisation since this run started`)
    console.log('                        Model calls and search fees. Not in the ledger: the profile-posts fetch (about a cent')
    console.log('                        a fetching prospect), the competitor check, and anything a failed prospect spent.')
    if (read.unpriced > 0) {
      console.log(`  NOT PRICED          : ${read.unpriced} of those rows could not be read, so the figure above is a floor.`)
    }
    // A zero with work done is the ledger not answering, not a free run.
    if (read.rows === 0 && completed !== null && completed > 0) {
      console.log(`  NOT TO BE TRUSTED   : ${completed} prospect(s) completed and no usage row was found for them.`)
    }
    if (spend.spent > spend.capUsd) {
      console.log('  OVER THE CAP        : this run spent more than --max-usd allowed. The per-prospect worst cases at the')
      console.log('                        top of this script are too low and need raising.')
    }
  }

  const result = await runResearchBatchForOrg({
    // This is the CLI. Recorded per prospect so CLI spend is separable from product spend.
    research_path: 'cli',
    supabase,
    organisation_id: orgId,
    scope,
    prospect_ids: prospectIds,
    use_stored_findings: useStoredFindings,
    ...(runtimeBudgetSeconds !== undefined ? { runtime_budget_seconds: runtimeBudgetSeconds } : {}),
    allow_overwrite_trigger: allowOverwriteTrigger,
    // The command line has no HTTP ceiling, so it writes the personalised follow-ups in the
    // same run. Without them a prospect with a personalised Email 1 is HELD at upload until
    // scripts/backfill-followups.ts has written one. --no-followups turns it off.
    write_followups: !noFollowups,
  })

  if (!result.ok) {
    console.error('')
    console.error(`  REFUSED OR FAILED: ${result.error}`)
    console.error('')
    // A run that failed part-way has still spent. A run that was refused shows no rows.
    await printLedgerSpend(null)
    console.error('')
    process.exit(1)
  }

  const s = result.summary

  console.log('')
  console.log(`  Selected            : ${result.prospects_selected}`)
  if (result.competitor_note) console.log(`  Not researched      : ${result.competitor_note}`)
  console.log(`  Completed           : ${s.completed}`)
  console.log(`  Failed              : ${s.failed}`)
  console.log(`  Skipped             : ${s.skipped}`)
  console.log(`  Distinct questions  : ${s.distinct_questions}`)
  console.log(`  Abstract noun hits  : ${s.abstract_noun_total} (report only)`)
  await printLedgerSpend(s.completed)

  if (s.bridge_frame_collisions.length > 0 || s.question_collisions.length > 0) {
    console.log('')
    console.log(`  GATE DEFECT: ${s.bridge_frame_collisions.length} repeated bridges, ${s.question_collisions.length} repeated questions.`)
    console.log('  These should be zero. A non-empty count means the uniqueness gate failed.')
  }

  if (s.failures.length > 0) {
    console.log('')
    console.log('  FAILURES:')
    for (const f of s.failures) {
      console.log(`    ${f.prospect_id} — ${f.error}`)
    }
  }

  console.log('')
}

main().catch(err => {
  console.error('Research run crashed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
