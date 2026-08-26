// Batch-vs-inline parity harness. ONE-OFF VERIFICATION TOOL, NOT A MONITOR.
//
//   npx tsx --env-file=.env.local scripts/verify-batch-parity.ts <prospect_id> [<prospect_id> ...]
//
// ═════════════════════════════════════════════════════════════════════════════
// THE FAILURE MODE THIS EXISTS FOR
//
// Three of the four batch failure modes announce themselves. Cache collapse shows up in
// reads_per_write. A stalled batch reddens MON-021. Errored entries appear per-entry in
// the ledger.
//
// The fourth does not. If a snapshot column is wrong or missing, phase 2 feeds the writer
// different material and produces a DIFFERENT OPENING with nothing failing. Same write
// rate, same counts, same green dashboard, different copy. No counter moves. Nothing in
// the system can see it, because from the inside a different-but-valid opening looks
// exactly like a correct one.
//
// So it needs a tool that compares against the other path rather than against itself.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY IT IS A SCRIPT AND NOT A ROUTE
//
// It runs the synthesis model a second time for a prospect that has already been through
// the pipeline, which costs money and produces output that must never be stored. A route
// is reachable; a script under scripts/ is not. Next builds src/app only, so nothing here
// is routable, and tsconfig includes **/*.ts so it is still type-checked.
//
// IT WRITES NOTHING, and that was made true rather than assumed. No agent_runs row, no
// prospect_research_results row, no prospect update. It calls synthesizeResearch and
// produceOpening, both read-only against the database (verified: write-opening.ts contains
// no supabase client, no insert and no update), and it never calls storeResearchResult or
// updateProspect.
//
// It also deliberately does NOT call loadProspectContext, which every other caller uses.
// That function stamps prospects.segment_id when it finds it null, which is correct for
// the agents and is a WRITE. A prospect that reached phase 1 already has a segment so the
// stamp would not fire, but "would not fire" is not "cannot fire". The prospect is read
// with a plain select instead.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE THREE COMPARISONS, AND WHY THREE
//
// A naive A/B would be worse than useless. The writer and the synthesis model are
// SAMPLED, so running the inline path twice on identical inputs produces different prose.
// A harness that diffs raw output would therefore report a difference every single time
// and could never distinguish "the snapshot is wrong" from "the model chose other words".
// It would cry wolf until nobody read it.
//
// So the model variance is isolated rather than averaged over:
//
//   C1  SNAPSHOT vs LIVE INPUTS, over the SAME stored Message.  FREE. EXACT. DETERMINISTIC.
//       synthesisFromMessage is pure. Feed it the stored Message twice, once with the
//       snapshotted client context and recency signal and once with the ones derived from
//       live state now. Any difference is a snapshot-vs-live divergence and NOTHING ELSE:
//       no model call is involved. THIS IS THE REAL DETECTOR.
//
//   C2  WRITER INPUTS.  FREE. EXACT. DETERMINISTIC.
//       The p3, cta and template opening the writer is briefed with, and the composed
//       Email 1 artifact the judge reads, built from the snapshotted messaging document
//       versus the currently approved one. A difference here is the silent-copy risk
//       arriving: same writer, different brief.
//
//   C3  FULL INLINE RUN vs the stored batch result.  PAID. NOT DETERMINISTIC.
//       What was actually asked for, and it is reported last and labelled, because a
//       difference here is only evidence when C1 and C2 are clean. If C1 and C2 are clean
//       and C3 differs, that is the model sampling, not the pipeline.
//
// A difference in C1 or C2 is a DEFECT. The script prints both values raw and STOPS. It
// does not rank, soften or explain the difference, because the whole point is that the
// person reading it has not yet decided what it means.

import { createClient } from '@supabase/supabase-js'
import type { Message } from '@anthropic-ai/sdk/resources/messages'
import {
  buildSynthesisRequest,
  synthesisFromMessage,
  synthesizeResearch,
  type ClientDocContext,
  type DetectedSignal,
} from '@/lib/agents/research/synthesize'
import { produceOpening, type MessagingContent } from '@/lib/agents/research/produce-opening'
import { fetchApprovedMessagingDoc, getVariantEmail1Frame, composeEmail1WithOpening } from '@/lib/composition/compose-sequence'
import type { RawSourceData, SynthesisOutput } from '@/lib/agents/research/types'

function client() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('verify-batch-parity: missing Supabase env vars')
  return createClient(url, key)
}

/** Stable stringify so key order can never masquerade as a difference. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val as Record<string, unknown>).sort().reduce((acc, k) => {
        acc[k] = (val as Record<string, unknown>)[k]; return acc
      }, {} as Record<string, unknown>)
    }
    return val
  }, 2)
}

interface Diff { field: string; a: string; b: string }

function diffObjects(a: Record<string, unknown>, b: Record<string, unknown>, skip: string[] = []): Diff[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  const out: Diff[] = []
  for (const k of keys) {
    if (skip.includes(k)) continue
    const av = canon(a[k]), bv = canon(b[k])
    if (av !== bv) out.push({ field: k, a: av, b: bv })
  }
  return out
}

function reportAndStop(label: string, diffs: Diff[]): never {
  console.error(`\n${'█'.repeat(78)}`)
  console.error(`DIFFERENCE FOUND IN ${label}. STOPPING.`)
  console.error('This is deterministic. No model call is involved, so this is not sampling.')
  console.error('█'.repeat(78))
  for (const d of diffs) {
    console.error(`\n── field: ${d.field}`)
    console.error(`   SNAPSHOT (what phase 2 used):\n${d.a}`)
    console.error(`   LIVE NOW (what the inline path would use):\n${d.b}`)
  }
  console.error('\nReported raw and not interpreted, deliberately.')
  process.exit(1)
}

async function run(prospectId: string): Promise<void> {
  const supabase = client()
  console.log(`\n${'═'.repeat(78)}\nPROSPECT ${prospectId}\n${'═'.repeat(78)}`)

  const { data: entryRow, error } = await supabase
    .from('synthesis_batch_entries')
    .select('id, organisation_id, prospect_id, state, raw_sources, detected_signal, client_context, client_name, segment_id, variant_id, messaging_doc_id, messaging_doc_version, messaging_content, response_message')
    .eq('prospect_id', prospectId)
    .in('state', ['collected', 'succeeded'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`could not read the batch entry: ${error.message}`)
  if (!entryRow) {
    console.log('SKIPPED: no collected batch entry. This prospect has not been through the batch path.')
    return
  }
  const entry = entryRow as unknown as {
    id: string; organisation_id: string; raw_sources: RawSourceData
    detected_signal: DetectedSignal; client_context: ClientDocContext
    client_name: string; segment_id: string | null; variant_id: string
    messaging_doc_id: string; messaging_doc_version: string
    messaging_content: MessagingContent; response_message: Message | null
  }

  if (!entry.response_message) {
    console.log('SKIPPED: entry has no response_message (errored or expired). Nothing to compare.')
    return
  }

  const clientId = entry.organisation_id

  // A PLAIN READ, NOT loadProspectContext, and the difference matters for this script's
  // central claim. loadProspectContext STAMPS prospects.segment_id when it finds it null.
  // That is correct for the agents and it is a WRITE, so a verification tool that says it
  // writes nothing must not call it. In practice a prospect that has been through phase 1
  // already has a segment, so the stamp would not fire, but "would not fire" is not the
  // same as "cannot fire" and this file's whole value is being trustworthy about what it
  // touches. segment_id comes from the snapshot regardless, which is what phase 2 uses.
  const { data: p, error: pErr } = await supabase
    .from('prospects')
    .select('id, first_name, last_name, company_name, role, email, linkedin_url, website_url, organisation_id')
    .eq('id', prospectId)
    .eq('organisation_id', clientId)
    .single()
  if (pErr || !p) throw new Error(`prospect not found: ${prospectId}`)

  const ctx = {
    id:              p.id as string,
    organisation_id: p.organisation_id as string,
    segment_id:      entry.segment_id,
    first_name:      p.first_name as string | null,
    last_name:       p.last_name as string | null,
    company_name:    p.company_name as string | null,
    role:            p.role as string | null,
    email:           p.email as string | null,
    linkedin_url:    p.linkedin_url as string | null,
    website_url:     p.website_url as string | null,
  }

  // ── C1: SNAPSHOT vs LIVE INPUTS over the same stored Message ────────────────
  // Free, exact, no model call. buildSynthesisRequest derives clientCtx from the database
  // and detectedSignal from the sources plus the CLOCK, which is exactly what phase 2
  // refuses to do and why the snapshot exists.
  const live = await buildSynthesisRequest(ctx, entry.raw_sources, clientId, { ttl: '1h' })

  const fromSnapshot = synthesisFromMessage(entry.response_message, ctx, entry.client_context, entry.detected_signal)
  const fromLive     = synthesisFromMessage(entry.response_message, ctx, live.clientCtx,       live.detectedSignal)

  // usage is identical by construction (same Message); excluded only to keep the diff
  // about material rather than about a field that cannot vary.
  const c1 = diffObjects(
    fromSnapshot as unknown as Record<string, unknown>,
    fromLive as unknown as Record<string, unknown>,
    ['usage'],
  )

  console.log('\n── C1  snapshot vs live inputs, same stored Message (deterministic) ──')
  console.log(`   client_context   identical: ${canon(entry.client_context) === canon(live.clientCtx)}`)
  console.log(`   detected_signal  identical: ${canon(entry.detected_signal) === canon(live.detectedSignal)}`)
  console.log(`   SynthesisOutput  identical: ${c1.length === 0}`)
  console.log(`   trigger_text BYTE-IDENTICAL: ${fromSnapshot.trigger_text === fromLive.trigger_text}`)
  if (c1.length > 0) reportAndStop('C1 (SynthesisOutput from snapshot vs live inputs)', c1)

  // ── C2: the writer's brief ─────────────────────────────────────────────────
  const liveDoc = await fetchApprovedMessagingDoc(supabase, clientId, ctx.segment_id)
  const snapFrame = getVariantEmail1Frame(entry.messaging_content, entry.variant_id)
  const liveFrame = getVariantEmail1Frame(liveDoc.content as MessagingContent, entry.variant_id)

  const probe = 'PARITY-PROBE-OPENING'
  const snapArtifact = composeEmail1WithOpening(entry.messaging_content, entry.variant_id, probe, null, ctx.first_name).body
  const liveArtifact = composeEmail1WithOpening(liveDoc.content as MessagingContent, entry.variant_id, probe, null, ctx.first_name).body

  const c2 = diffObjects(
    { p3: snapFrame.p3, cta: snapFrame.cta, templateOpening: snapFrame.authoredOpening, composedEmail1: snapArtifact },
    { p3: liveFrame.p3, cta: liveFrame.cta, templateOpening: liveFrame.authoredOpening, composedEmail1: liveArtifact },
  )

  console.log('\n── C2  writer brief: snapshotted document vs currently approved (deterministic) ──')
  console.log(`   snapshot doc: ${entry.messaging_doc_id} v${entry.messaging_doc_version}`)
  console.log(`   live doc:     ${liveDoc.doc_id}`)
  console.log(`   doc_id changed since phase 1: ${liveDoc.doc_id !== entry.messaging_doc_id}`)
  console.log(`   writer brief identical: ${c2.length === 0}`)
  if (c2.length > 0) reportAndStop('C2 (writer brief from snapshotted vs live messaging document)', c2)

  // ── C3: full inline run. PAID. NOT DETERMINISTIC. ──────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('verify-batch-parity: ANTHROPIC_API_KEY not set')

  console.log('\n── C3  full inline run vs stored batch result (PAID, model is sampled) ──')
  const inlineSynthesis: SynthesisOutput = await synthesizeResearch(ctx, entry.raw_sources, clientId)

  const c3 = diffObjects(
    fromSnapshot as unknown as Record<string, unknown>,
    inlineSynthesis as unknown as Record<string, unknown>,
    ['usage'],
  )
  console.log(`   SynthesisOutput identical: ${c3.length === 0}`)
  console.log(`   trigger_text BYTE-IDENTICAL: ${fromSnapshot.trigger_text === inlineSynthesis.trigger_text}`)
  if (c3.length > 0) {
    console.log(`   fields differing: ${c3.map(d => d.field).join(', ')}`)
    for (const d of c3) {
      console.log(`\n   ── ${d.field}`)
      console.log(`      BATCH:  ${d.a}`)
      console.log(`      INLINE: ${d.b}`)
    }
    console.log('\n   NOT AUTOMATICALLY A DEFECT. C1 and C2 above are clean, so the inputs were')
    console.log('   identical and this is the synthesis model sampling differently. It is')
    console.log('   printed in full so a human decides, not the script.')
  }

  const openingBatch = await produceOpening({
    apiKey, clientName: entry.client_name, ctx,
    candidates: fromSnapshot.candidates, messagingContent: entry.messaging_content, variantId: entry.variant_id,
  })
  const openingInline = await produceOpening({
    apiKey, clientName: entry.client_name, ctx,
    candidates: inlineSynthesis.candidates, messagingContent: liveDoc.content as MessagingContent, variantId: entry.variant_id,
  })

  console.log('\n── the shipped opening ──')
  console.log(`   BATCH  written_won=${openingBatch.written_won}  opening: ${JSON.stringify(openingBatch.opening)}`)
  console.log(`   INLINE written_won=${openingInline.written_won}  opening: ${JSON.stringify(openingInline.opening)}`)
  console.log(`   opening BYTE-IDENTICAL: ${openingBatch.opening === openingInline.opening}`)
  console.log(`   question BYTE-IDENTICAL: ${openingBatch.question === openingInline.question}`)

  console.log('\n── VERDICT ──')
  console.log('   C1 deterministic snapshot parity: PASS')
  console.log('   C2 deterministic writer brief:    PASS')
  console.log(`   C3 model output identical:        ${c3.length === 0 ? 'yes' : 'no (sampling, see above)'}`)
  console.log('   NOTHING WAS WRITTEN. No research row, no prospect update, no agent_runs row.')
}

async function main() {
  const ids = process.argv.slice(2)
  if (ids.length === 0) {
    console.error('usage: npx tsx --env-file=.env.local scripts/verify-batch-parity.ts <prospect_id> [<prospect_id> ...]')
    process.exit(2)
  }
  console.log(`Comparing ${ids.length} prospect(s). C3 makes PAID model calls per prospect.`)
  for (const id of ids) await run(id)
  console.log('\nAll prospects compared. No deterministic difference found.')
}

main().catch(err => {
  console.error('verify-batch-parity failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
