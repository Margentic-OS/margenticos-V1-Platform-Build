#!/usr/bin/env npx tsx
/**
 * Re-run research for a cohort already researched in a known window, RESUMABLY.
 *
 * Run with:
 *   npx tsx --env-file=.env.local scripts/rerun-cohort.ts \
 *     --org <uuid> --cohort-from <ISO> --cutoff <ISO> [--fresh] [--chunk 28] [--dry-run]
 *
 * WHY THIS EXISTS RATHER THAN A LOOP AROUND run-research.ts
 *
 * A re-run of a large cohort is long (a fresh pass is ~47s per prospect) and every
 * prospect in it costs real money at four model calls plus two paid sources. If the
 * process dies half way, the only safe way to continue is to know EXACTLY which prospects
 * already ran. Re-running one that already ran charges for it twice and replaces copy that
 * was just written.
 *
 * RESUME STATE IS READ FROM THE DATABASE, NEVER FROM A FILE.
 *
 * A ledger file is the obvious design and it is the wrong one here. It can be deleted, it
 * can be on a machine that is gone, and it is written by the same process whose death is
 * the thing being recovered from. This repo has the lesson recorded twice over: a guard
 * must detect the WORLD, not a record of what the guard believes it did.
 *
 * So "done" is a fact about the row: a prospect is done when its research_ran_at has moved
 * to at or after --cutoff. The re-run itself sets that, so the marker is written by the
 * work rather than alongside it, and a prospect whose copy the judge CLEARED still counts
 * as done, which is correct: it ran, it cost money, and running it again would charge
 * twice for the same answer.
 *
 * The cohort is derived the same way: prospects whose research_ran_at still sits in the
 * ORIGINAL window [--cohort-from, --cutoff) and that carry personalisation copy. As each
 * one is re-run its timestamp leaves that window, so the pending set shrinks on its own
 * and a second invocation with identical arguments picks up exactly where the first
 * stopped. Nothing is passed between invocations. There is no state to lose.
 *
 * THE CHUNK SIZE IS NOT COSMETIC. Each chunk is one call to runResearchBatchForOrg and
 * therefore ONE BatchUniquenessRegistry: bridges and closing questions are deduplicated
 * within a chunk and not across chunks. A smaller chunk is more resumable and less unique.
 * Chunks also cannot exceed RESEARCH_MAX_PROSPECTS.
 */

import { createClient } from '@supabase/supabase-js'
import { runResearchBatchForOrg, RESEARCH_MAX_PROSPECTS } from '@/lib/operator/research-batch-entry'

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }
const flag = (n: string) => process.argv.includes(`--${n}`)

function die(m: string): never { console.error(`\n  ${m}\n`); process.exit(1) }

async function main() {
  const org = arg('org') ?? die('Missing --org')
  const cohortFrom = arg('cohort-from') ?? die('Missing --cohort-from (ISO timestamp of the ORIGINAL run)')
  const cutoff = arg('cutoff') ?? die('Missing --cutoff (ISO timestamp; work at or after this counts as done)')
  const fresh = flag('fresh')
  const dryRun = flag('dry-run')
  const chunk = Number(arg('chunk') ?? 28)
  if (!Number.isFinite(chunk) || chunk < 1 || chunk > RESEARCH_MAX_PROSPECTS) {
    die(`--chunk must be between 1 and ${RESEARCH_MAX_PROSPECTS}`)
  }
  const budget = Number(arg('runtime-budget') ?? 7200)

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) die('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Pass --env-file=.env.local.')
  if (!process.env.ANTHROPIC_API_KEY) die('ANTHROPIC_API_KEY must be set.')
  const supabase = createClient(url, key)

  // PENDING: still in the original window, still carrying copy.
  const { data: pending, error: e1 } = await supabase
    .from('prospects')
    .select('id, first_name, research_ran_at')
    .eq('organisation_id', org)
    .gte('research_ran_at', cohortFrom)
    .lt('research_ran_at', cutoff)
    .not('personalisation_trigger', 'is', null)
    .order('id')
  if (e1) die(`Could not read pending prospects: ${e1.message}`)

  // DONE: already moved past the cutoff by an earlier invocation of this script.
  const { count: doneCount, error: e2 } = await supabase
    .from('prospects')
    .select('id', { count: 'exact', head: true })
    .eq('organisation_id', org)
    .gte('research_ran_at', cutoff)
  if (e2) die(`Could not count completed prospects: ${e2.message}`)

  const ids = (pending ?? []).map(p => p.id)
  console.log('')
  console.log('  Cohort re-run')
  console.log(`  Organisation   : ${org}`)
  console.log(`  Cohort window  : ${cohortFrom}  ->  ${cutoff}`)
  console.log(`  Already done   : ${doneCount ?? 0}  (research_ran_at >= cutoff)`)
  console.log(`  Still pending  : ${ids.length}`)
  console.log(`  Sources        : ${fresh ? 'FETCH EVERY SOURCE' : 'reuse stored findings'}`)
  console.log(`  Chunk size     : ${chunk}  (one uniqueness registry per chunk)`)
  console.log('')

  if (ids.length === 0) { console.log('  Nothing pending. Cohort complete.\n'); return }
  if (dryRun) { console.log('  --dry-run: stopping before any model call.\n'); return }

  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += chunk) chunks.push(ids.slice(i, i + chunk))

  let ok = 0, failed = 0
  for (const [i, batch] of chunks.entries()) {
    console.log(`  --- chunk ${i + 1}/${chunks.length}: ${batch.length} prospects ---`)
    const started = Date.now()
    const result = await runResearchBatchForOrg({
      supabase,
      organisation_id: org,
      scope: 'researched',
      prospect_ids: batch,
      use_stored_findings: !fresh,
      allow_overwrite_trigger: true,
      runtime_budget_seconds: budget,
    })
    const secs = Math.round((Date.now() - started) / 1000)
    if (result.ok) { ok += batch.length; console.log(`      done in ${secs}s`) }
    else { failed += batch.length; console.error(`      FAILED in ${secs}s: ${result.error}`) }
    // Deliberately keep going: a failed chunk leaves its prospects in the pending window,
    // so re-invoking picks them up. Stopping here would not protect anything.
  }
  console.log(`\n  chunks complete. ok=${ok} failed=${failed}`)
  console.log(`  Re-invoke with identical arguments to resume anything left pending.\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
