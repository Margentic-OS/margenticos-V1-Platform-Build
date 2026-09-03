// LIVE PROOF RUN for the document versioning work. Not a test: it drives the real agent,
// the real promotion function and the real revert against a real organisation.
//
//   dotenv -e .env.local -- npx tsx scripts/proof-document-versions.ts
//
// Target is the DRY RUN TEST organisation and the voice guide, chosen because the voice
// guide is org-level (no segment scoping to confuse the history), has no filter spec to
// derive, and is the document where a note like "be more formal" should visibly change
// the output if the note is reaching the model at all.
//
// WHAT IT PROVES, in Doug's numbering:
//   1  five regenerations with five different notes, then revert to version 2, and the
//      live document is version 2's content
//   2  two different notes produce different output. If they do not, the note is not
//      reaching the agent and this is reported as a FAILURE, not a caveat
//   3  every version listed with its own note, distinguishable
//   5  the live document never changes while a generation is running
//   6  promoting the voice guide marks messaging stale, with nothing regenerating
//
// It writes real versions to a real organisation. That is the point: the alternative is
// reading the code and believing it.

import { createClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { runTovGenerationAgent } from '../src/agents/tov-generation-agent'

// --revert-only re-runs proofs 1 and 3 against the versions an earlier run already
// produced. It exists because the first attempt at proof 1 failed on a CHECK constraint
// AFTER the five generations had succeeded, and repeating five model calls to re-test the
// step that failed would have been waste, not rigour.
const REVERT_ONLY = process.argv.includes('--revert-only')

const ORG_ID = 'a2b621fc-4c9d-43d9-9af4-1253ff49d12d' // DRY RUN TEST
const DOC_TYPE = 'tov'
// A real operator user. The system id the auto-approve cron uses
// (00000000-...-0001) is not a row in users on this database, and
// document_suggestions.reviewed_by has a foreign key to it, so the first run of this
// script failed on document_suggestions_reviewed_by_fkey. Worth knowing: the hourly
// auto-approve cron would hit exactly the same constraint if it ever had a suggestion to
// approve. Recorded in BACKLOG.
const REVIEWER_ID = 'eee3436d-b77c-4670-af27-a91d737672b7'

// Five notes that ask for five different things, so "the output changed" cannot be
// explained by run-to-run noise alone. RULE ZERO: no industry, sector, country, company
// or job title in any of them.
const NOTES = [
  'Make every section noticeably more formal than it is now.',
  'Make every section noticeably more casual and conversational than it is now.',
  'Cut the length of every section roughly in half. Keep the meaning.',
  'Add a short worked example to each section that has none.',
  'Remove all hedging language. State things directly.',
]

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12)
}

function line(s = '') { console.log(s) }

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not set')
  const supabase = createClient(url, key)

  const org = await supabase.from('organisations').select('name').eq('id', ORG_ID).single()
  line(`ORGANISATION: ${org.data?.name} (${ORG_ID})`)
  line(`DOCUMENT:     ${DOC_TYPE}`)
  line()

  async function liveDoc() {
    const { data } = await supabase
      .from('strategy_documents')
      .select('id, version, content, status')
      .eq('organisation_id', ORG_ID).eq('document_type', DOC_TYPE).eq('status', 'active')
      .maybeSingle()
    return data
  }

  async function messagingStale() {
    const { data } = await supabase
      .from('strategy_documents')
      .select('id, version, is_stale')
      .eq('organisation_id', ORG_ID).eq('document_type', 'messaging').eq('status', 'active')
      .maybeSingle()
    return data
  }

  line('══ BEFORE ══════════════════════════════════════════════════════════════')
  const before = await liveDoc()
  line(`  live voice guide: v${before?.version} id=${before?.id} content=${hash(before?.content)}`)
  const msgBefore = await messagingStale()
  line(`  live messaging:   v${msgBefore?.version} is_stale=${msgBefore?.is_stale}`)
  line()

  // ── PROOF 5 + the five regenerations ──────────────────────────────────────
  const produced: Array<{ note: string; version: string; id: string; contentHash: string }> = []

  if (!REVERT_ONLY) {
  // A pending suggestion left behind by an earlier attempt would block the first
  // regeneration on the idempotency index, so clear one if it is there.
  const { data: leftover } = await supabase
    .from('document_suggestions')
    .select('id')
    .eq('organisation_id', ORG_ID).eq('document_type', DOC_TYPE).eq('status', 'pending')
    .maybeSingle()
  if (leftover) {
    line(`  clearing a leftover pending suggestion from an earlier attempt: ${leftover.id}`)
    const { data: promotedLeftover, error: leftoverError } = await supabase.rpc('approve_document_suggestion', {
      p_suggestion_id: leftover.id,
      p_reviewer_id: REVIEWER_ID,
    })
    if (leftoverError) throw new Error(`could not clear leftover suggestion — ${leftoverError.message}`)
    const pl = promotedLeftover as unknown as { version: string; revision_note: string | null }
    line(`  leftover promoted to v${pl.version} note="${pl.revision_note}"`)
    line()
  }

  for (let i = 0; i < NOTES.length; i++) {
    const note = NOTES[i]
    line(`── run ${i + 1}/${NOTES.length} ─────────────────────────────────────────────`)
    line(`  note: "${note}"`)

    const liveBeforeRun = await liveDoc()

    const started = Date.now()
    await runTovGenerationAgent({
      organisation_id: ORG_ID,
      supabase,
      is_refresh: true,
      regeneration_notes: { operator_note: note },
    })
    const elapsed = Math.round((Date.now() - started) / 1000)

    // PROOF 5: the agent has finished and written a SUGGESTION. Nothing has been
    // promoted. The live document must be byte-identical to what it was before the run.
    const liveAfterAgent = await liveDoc()
    const unchanged =
      liveAfterAgent?.id === liveBeforeRun?.id &&
      hash(liveAfterAgent?.content) === hash(liveBeforeRun?.content)
    line(`  agent finished in ${elapsed}s. live document during generation: ` +
         `${unchanged ? 'UNCHANGED' : 'CHANGED — PROOF 5 FAILS'} ` +
         `(v${liveAfterAgent?.version} ${hash(liveAfterAgent?.content)})`)
    if (!unchanged) throw new Error('PROOF 5 FAILED: the live document changed mid-generation')

    const { data: suggestion } = await supabase
      .from('document_suggestions')
      .select('id, revision_note')
      .eq('organisation_id', ORG_ID).eq('document_type', DOC_TYPE).eq('status', 'pending')
      .maybeSingle()

    if (!suggestion) throw new Error(`run ${i + 1}: no pending suggestion was written`)
    line(`  suggestion ${suggestion.id} revision_note="${suggestion.revision_note}"`)

    const { data: newDoc, error: rpcError } = await supabase.rpc('approve_document_suggestion', {
      p_suggestion_id: suggestion.id,
      p_reviewer_id: REVIEWER_ID,
    })
    if (rpcError) throw new Error(`run ${i + 1}: approve failed — ${rpcError.message}`)

    const promoted = newDoc as unknown as { id: string; version: string; content: unknown; revision_note: string | null }
    line(`  promoted to v${promoted.version} content=${hash(promoted.content)} note="${promoted.revision_note}"`)
    produced.push({ note, version: promoted.version, id: promoted.id, contentHash: hash(promoted.content) })
    line()
  }

  } // end !REVERT_ONLY

  // ── PROOF 6: downstream staleness ─────────────────────────────────────────
  line('══ PROOF 6 — downstream marked stale, nothing regenerated ══════════════')
  const msgAfter = await messagingStale()
  line(`  live messaging: v${msgAfter?.version} is_stale=${msgAfter?.is_stale} (was ${msgBefore?.is_stale})`)
  line(`  messaging document id unchanged: ${msgAfter?.id === msgBefore?.id}`)
  const { count: msgVersions } = await supabase
    .from('strategy_documents')
    .select('id', { count: 'exact', head: true })
    .eq('organisation_id', ORG_ID).eq('document_type', 'messaging')
  line(`  messaging versions in total: ${msgVersions} (unchanged means nothing regenerated)`)
  line()

  // ── PROOF 3: every version listed with its own note ───────────────────────
  line('══ PROOF 3 — the version history ═══════════════════════════════════════')
  const { data: history } = await supabase
    .from('strategy_documents')
    .select('id, version, status, created_at, update_trigger, revision_note')
    .eq('organisation_id', ORG_ID).eq('document_type', DOC_TYPE)
    .order('created_at', { ascending: false })

  for (const row of history ?? []) {
    line(`  v${row.version.padEnd(3)} ${row.status.padEnd(9)} ${row.update_trigger ?? '-'}`)
    line(`        note: ${row.revision_note ?? '(none)'}`)
  }
  const notes = (history ?? []).map(r => r.revision_note).filter(Boolean)
  line(`  distinct notes: ${new Set(notes).size} of ${notes.length}`)
  line()

  // ── PROOF 2: different notes produce different output ─────────────────────
  line('══ PROOF 2 — does the note reach the agent ═════════════════════════════')
  const hashes = produced.map(p => p.contentHash)
  const distinct = new Set(hashes).size
  if (REVERT_ONLY) line('  (skipped: --revert-only, see the full run for this proof)')
  for (const p of produced) line(`  v${p.version} ${p.contentHash}  "${p.note.slice(0, 55)}"`)
  line(`  distinct outputs: ${distinct} of ${hashes.length}`)
  if (!REVERT_ONLY && distinct < hashes.length) {
    line('  RESULT: FAILURE. At least two different notes produced identical output.')
    line('          The note is not reaching the agent and everything else here is decoration.')
  } else if (!REVERT_ONLY) {
    line('  RESULT: PASS. Every note produced a different document.')
  }
  line()

  // ── PROOF 1: revert to version 2 ──────────────────────────────────────────
  line('══ PROOF 1 — revert to version 2 ═══════════════════════════════════════')
  const { data: v2 } = await supabase
    .from('strategy_documents')
    .select('id, version, content, revision_note')
    .eq('organisation_id', ORG_ID).eq('document_type', DOC_TYPE).eq('version', '2')
    .maybeSingle()

  if (!v2) throw new Error('no version 2 to revert to')
  line(`  target: v2 id=${v2.id} content=${hash(v2.content)}`)
  line(`  live before revert: v${(await liveDoc())?.version} content=${hash((await liveDoc())?.content)}`)

  const { data: reverted, error: revertError } = await supabase.rpc('revert_strategy_doc_version', {
    p_document_id: v2.id,
  })
  if (revertError) throw new Error(`revert failed — ${revertError.message}`)
  const rev = reverted as unknown as { id: string; version: string; content: unknown; revision_note: string }

  const nowLive = await liveDoc()
  const matches = hash(nowLive?.content) === hash(v2.content)
  line(`  live after revert:  v${nowLive?.version} content=${hash(nowLive?.content)}`)
  line(`  new version note:   "${rev.revision_note}"`)
  line(`  content equals version 2: ${matches ? 'YES' : 'NO — PROOF 1 FAILS'}`)
  line(`  version 2 still present in history: ${(await supabase
      .from('strategy_documents').select('id', { count: 'exact', head: true })
      .eq('id', v2.id)).count === 1}`)
  line()

  line('══ FINAL STATE ═════════════════════════════════════════════════════════')
  const { data: final } = await supabase
    .from('strategy_documents')
    .select('version, status, update_trigger, revision_note')
    .eq('organisation_id', ORG_ID).eq('document_type', DOC_TYPE)
    .order('created_at', { ascending: true })
  for (const row of final ?? []) {
    line(`  v${String(row.version).padEnd(3)} ${String(row.status).padEnd(9)} ${row.update_trigger ?? '-'}  ${row.revision_note ?? '(no note)'}`)
  }
}

main().catch(err => { console.error('\nPROOF RUN FAILED:', err); process.exit(1) })
