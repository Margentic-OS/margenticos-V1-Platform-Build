#!/usr/bin/env npx tsx
/**
 * What share of a client's LIVE search is a good fit, measured on a sample.
 *
 *   npx tsx --env-file=.env.local scripts/run-search-tuner.ts --org <uuid> [--sample 80] [--cap-searches 400] [--no-persist]
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 *
 * The sampler was written, tested and left with no caller: no CLI, no route, nothing
 * scheduled. So the question it answers — is this client's search finding the right people —
 * was answered instead by grading every prospect during research, at roughly $0.19 each. That
 * is a sampling question being paid for per head.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IT COSTS, AND WHAT IT DOES NOT TOUCH
 *
 * Drawing the sample is FREE: the provider's people-search consumes no credits. The spend is
 * one web lookup per sampled row that the name alone could not decide, measured at about
 * $0.022 a row, plus the batched judge calls. A sample of 80 is about $1.85; of 30, about
 * $0.70. Both caps are enforced inside the run.
 *
 * It writes NOTHING to a client's spec, documents or prospects. The only rows it creates are
 * its own record in tuning_runs and tuning_rounds, and one agent_runs row for the in-flight
 * guard.
 */

import { createClient } from '@supabase/supabase-js'
import { runSearchTuner } from '@/lib/tuner/search-tuner'
import { writeSearchTunerRecord } from '@/lib/tuner/record'
import { readStoredFitDimensions } from '@/lib/agents/research/fit-dimensions'
import { DEFAULT_SAMPLE_SIZE } from '@/lib/tuner/spread-sample'
import { DEFAULT_SPEND_CAP_SEARCHES } from '@/lib/tuner/run-budget'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

function usage(message: string): never {
  console.error(`\n${message}\n\nUsage: npx tsx --env-file=.env.local scripts/run-search-tuner.ts --org <uuid> [--sample ${DEFAULT_SAMPLE_SIZE}] [--cap-searches ${DEFAULT_SPEND_CAP_SEARCHES}] [--no-persist]\n`)
  process.exit(1)
}

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)

async function main() {
  const organisationId = arg('org') ?? usage('Missing --org.')
  const sampleSize = Number(arg('sample') ?? DEFAULT_SAMPLE_SIZE)
  const spendCapSearches = Number(arg('cap-searches') ?? DEFAULT_SPEND_CAP_SEARCHES)
  if (!(sampleSize > 0)) usage('--sample must be a positive number.')

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  // WHICH STANDARD THIS RUN WILL GRADE AGAINST, read the same way the run reads it, so the
  // recorded label cannot disagree with what actually happened.
  const { data: doc } = await supabase
    .from('strategy_documents')
    .select('icp_filter_spec')
    .eq('organisation_id', organisationId).eq('document_type', 'icp').eq('status', 'active')
    .single()
  const stored = readStoredFitDimensions(
    (doc?.icp_filter_spec as { fit_dimensions?: unknown } | null)?.fit_dimensions,
  )
  const rubricSource = stored.dimensions ? 'stored_conditions' as const : 'derived_this_run' as const
  console.log(
    stored.dimensions
      ? `Grading against the ${stored.dimensions.length} conditions stored on this client's settings.`
      : `No stored conditions${stored.problem ? ` (${stored.problem})` : ''}: this run derives a rubric, which costs one model call and is not comparable with another run's.`,
  )

  const startedAt = new Date().toISOString()
  const result = await runSearchTuner({ supabase, organisationId, sampleSize, spendCapSearches })

  console.log(`\n${result.terminalState}: ${result.terminalReason}`)
  console.log(`reachable ${result.baselineReachable ?? '—'}, with the buyer constraints relaxed ${result.ceilingReachable ?? '—'}`)

  for (const round of result.rounds) {
    if (!round.fit) continue
    const f = round.fit
    console.log(
      `\nround ${round.index}: ${f.best} best, ${f.acceptable} acceptable, ${f.neither} neither, ` +
      `${f.cannotEstablish} could not be established, of ${f.sampled} sampled`,
    )
    console.log(
      `  fit of those established: ${pct(f.fitOfResolved)}` +
      (f.interval ? `  (95% interval ${pct(f.interval.low)} to ${pct(f.interval.high)}, on ${f.resolved} rows)` : ''),
    )
    if (f.fitOfResolved === null) console.log(`  ${f.note}`)
    if (f.lowSignal) console.log('  LOW SIGNAL: more than half the sample could not be established.')
  }

  console.log(`\ncost: ${result.billableSearches} billable searches, ${result.modelCalls} model calls, ${result.providerCalls} free provider calls`)
  for (const note of result.notes) console.log(`  - ${note}`)

  if (flag('no-persist')) {
    console.log('\nnot persisted (--no-persist)')
    return
  }
  const { runId } = await writeSearchTunerRecord({
    supabase, organisationId, result, startedAt, sampleSize, rubricSource,
  })
  console.log(runId ? `\nrecorded as tuning_runs ${runId}` : '\nNOT RECORDED: the write failed, see the log above')
}

main().then(() => process.exit(0)).catch(e => { console.error('FAILED: ' + (e instanceof Error ? e.message : e)); process.exit(1) })
