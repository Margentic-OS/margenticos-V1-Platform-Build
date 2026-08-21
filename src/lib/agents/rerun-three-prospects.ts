// Diagnostic re-run for the copy-quality rubric (readability, frame repetition, inference
// direction). Runs prospects through the research agent with a SHARED FrameRegistry so the
// cross-batch sentence-frame check actually has a batch to compare against, and prints every
// candidate with its scores and readability verdict.
//
// This is the only per-candidate view of the six tests and the readability gate. The batch
// entry point reports outcomes; this reports why each candidate won or was demoted.
//
// The organisation and prospect ids USED to be hardcoded here, which is how a diagnostic
// silently becomes a throwaway that only works for one client. They are arguments now.
//
// Run with:
//   npx tsx --env-file=.env.local src/lib/agents/rerun-three-prospects.ts \
//     --org <uuid> --ids <uuid>,<uuid>,<uuid>
//
// WARNING: this calls runProspectResearchAgentV2 directly, which writes
// personalisation_trigger and personalisation_question on every prospect it touches, and
// clears them when the judge holds. It has no overwrite guard. Do not point it at prospects
// whose copy has already been sent. For ordinary runs use scripts/run-research.ts, which
// refuses that case unless explicitly told otherwise.

import { runProspectResearchAgentV2 } from '@/lib/agents/prospect-research-agent-v2'
import { FrameRegistry } from '@/lib/style/sentence-frames'
import { readabilityScore } from '@/lib/style/readability'

const SIX = ['specific', 'verifiable', 'inferential', 'relevant', 'useful', 'non_judgemental'] as const

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function usage(message: string): never {
  console.error(`\n${message}\n`)
  console.error('Usage:')
  console.error('  npx tsx --env-file=.env.local src/lib/agents/rerun-three-prospects.ts --org <uuid> --ids <uuid>,<uuid>')
  console.error('')
  console.error('  --org  organisation id. Required.')
  console.error('  --ids  comma-separated prospect ids. Required.')
  console.error('')
  process.exit(1)
}

async function main() {
  const ORG_ID = arg('org')
  if (!ORG_ID) usage('Missing --org.')

  const idsRaw = arg('ids')
  if (!idsRaw) usage('Missing --ids.')

  const PROSPECTS = idsRaw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(id => ({ name: id.slice(0, 8), id }))

  if (PROSPECTS.length === 0) usage('--ids contained no prospect ids.')

  const registry = new FrameRegistry()
  const triggers: Array<{ name: string; text: string }> = []

  for (const p of PROSPECTS) {
    console.log(`\n${'='.repeat(78)}`)
    console.log(`  ${p.name}  (${p.id})`)
    console.log('='.repeat(78))

    const result = await runProspectResearchAgentV2({ prospect_id: p.id, client_id: ORG_ID })

    console.log(`\nICP fit: ${result.icp_fit} | signal_relevance: ${result.signal_relevance} | confidence: ${result.synthesis_confidence}`)
    console.log(`Qualification: ${result.qualification_status}`)
    console.log(`Sources succeeded: ${result.sources_successful.join(', ') || 'none'}`)
    if (result.demotion_reason) console.log(`DEMOTION: ${result.demotion_reason}`)

    console.log(`\n--- CANDIDATES (${result.candidates.length}) ---`)
    for (const c of result.candidates) {
      const passed = SIX.filter(t => c.scores[t])
      const failed = SIX.filter(t => !c.scores[t])
      const isWinner = c.id === result.selected_candidate_id
      console.log(`\n[${c.id}]${isWinner ? '  *** WINNER ***' : ''}`)
      console.log(`  observation : ${c.observation}`)
      console.log(`  source      : ${c.source}${c.is_composite ? ' (composite)' : ''}`)
      console.log(`  provenance  : ${c.provenance || '(none)'}`)
      console.log(`  date        : ${c.date ?? 'null'}`)
      console.log(`  scores      : ${c.score_total}/6  passed=[${passed.join(', ')}]  failed=[${failed.join(', ') || 'none'}]`)
      console.log(`  model says readable: ${c.model_readable_claim}`)
      console.log(`  readability : hardFail=${c.readability.hard_fail} penalty=${c.readability.penalty} maxSentenceWords=${c.readability.max_sentence_words}`)
      console.log(`                hedges=[${c.readability.hedges.join(', ') || 'none'}]`)
      console.log(`                nominalisation=${(c.readability.nominalisation_density * 100).toFixed(1)}% over=${c.readability.nominalisation_over_threshold}`)
      for (const r of c.readability.reasons) console.log(`                - ${r}`)
      console.log(`  inference   : ${c.inference_direction}`)
      console.log(`  opposite    : ${c.opposite_reading ?? '(none supplied)'}`)
      console.log(`  demoted     : ${c.demoted}`)
      if (c.rejection_reason) console.log(`  rejection   : ${c.rejection_reason}`)
    }

    console.log(`\n--- WINNING OBSERVATION (signal_observation) ---`)
    console.log(`  ${result.signal_observation ?? '(none)'}`)

    console.log(`\n--- TRIGGER TEXT (this is what reaches the email) ---`)
    // NULL when no candidate was selected: the prospect correctly gets no trigger and
    // composition ships the variant's authored opener.
    console.log(`  ${result.trigger_text ?? '(null, no candidate selected)'}`)
    const ts = readabilityScore(result.trigger_text ?? '')
    console.log(`  sentences: ${ts.sentences.length}`)
    ts.sentences.forEach((s, i) => console.log(`    ${i + 1}. (${s.trim().split(/\s+/).length} words) ${s}`))
    console.log(`  hardFail=${ts.hardFail} penalty=${ts.penalty} maxSentenceWords=${ts.maxSentenceWords} hedges=[${ts.hedges.join(', ') || 'none'}]`)
    console.log(`  nominalisation=${(ts.nominalisation.density * 100).toFixed(1)}% over=${ts.nominalisation.exceedsThreshold} matches=[${ts.nominalisation.matches.join(', ') || 'none'}]`)

    const collisions = registry.register(p.name, result.trigger_text ?? '')
    if (collisions.length > 0) {
      for (const c of collisions) console.log(`  FRAME COLLISION: "${c.frame}" (first used by ${c.firstSeenId})`)
    } else {
      console.log(`  frame check: no repeated frame against earlier prospects`)
    }

    triggers.push({ name: p.name, text: result.trigger_text ?? '' })
  }

  console.log(`\n${'='.repeat(78)}`)
  console.log('  CROSS-PROSPECT FRAME SUMMARY')
  console.log('='.repeat(78))
  const all = registry.allCollisions()
  if (all.length === 0) {
    console.log('  No repeated sentence frame across the three prospects.')
  } else {
    for (const c of all) console.log(`  "${c.frame}" : ${c.firstSeenId} then ${c.repeatedById}`)
  }

  console.log('\n  All three triggers:')
  for (const t of triggers) console.log(`    ${t.name}: ${t.text}`)
}

main().catch(err => {
  console.error('RERUN FAILED:', err instanceof Error ? err.stack : String(err))
  process.exit(1)
})
