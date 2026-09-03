// Derives icp_filter_spec for live ICP documents that were promoted without one.
//
//   dotenv -e .env.local -- npx tsx scripts/backfill-icp-filter-spec.ts
//   dotenv -e .env.local -- npx tsx scripts/backfill-icp-filter-spec.ts --apply <document-id>...
//
// With no --apply it reports and writes nothing. With --apply it derives a spec for the
// document ids NAMED ON THE COMMAND LINE and no others.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THESE ROWS EXIST
//
// /api/documents/revise promoted a new ICP and never derived its filter spec, while the
// approval path did. So every active ICP with update_trigger 'client_revision' has a NULL
// spec and every one from the suggestion path has one. The code path is fixed; these are
// the rows it produced before it was.
//
// A NULL spec is not silent: the sourcing orchestrator fails loudly on it. So this is
// unblocking work rather than repairing damage.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT IT COSTS, AND THE CHECK THAT MUST HAPPEN BEFORE --apply
//
// persistIcpFilterSpec makes an Anthropic call to derive the buyer criterion, so this
// costs one call per document.
//
// It ALSO re-queues the organisation's previously removed prospects for tiering, per
// ADR-037: a new filter spec is the rule that removed them changing. That is free at the
// moment it runs and commits the NEXT tiering runs to real work, and each re-tiered
// survivor goes on to cost research money. --dry-run prints the number of rows each
// organisation would re-queue so that number is seen before it is caused, not inferred
// from a bill later. Do not run --apply without reading it.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT HAPPENED THE FIRST TIME IT RAN, 2026-09-03
//
// It REFUSED, on the one document it was pointed at, and refusing was right.
//
//   deriveFilterSpec failed: "Distribution Consulting" is not a canonical industry name.
//
// deriveFilterSpec validates every industry in the ICP against CANONICAL_INDUSTRIES and
// throws rather than storing a spec containing a name no handler can translate. That
// document was written before that validation existed, so the content has a problem this
// script cannot fix and must not paper over: adding a canonical industry is a decision
// about the product's vocabulary, not a backfill.
//
// It cost nothing. deriveFilterSpec runs BEFORE deriveBuyerCriterion, which is the only
// Anthropic call in the path, and the catch returns.
//
// So the row is still NULL and that is the correct outcome. Recorded in BACKLOG.
//
// ═══════════════════════════════════════════════════════════════════════════
// SCOPE
//
// ACTIVE documents only. An archived row with a NULL spec is history: nothing reads it,
// and deriving a spec for a superseded version would spend money to write a field onto a
// document that will never be used again.
//
// AND ONLY THE IDS NAMED ON THE COMMAND LINE. The report lists every candidate; applying
// takes an explicit list. That is not ceremony. The candidate list CHANGED between two
// reads twenty minutes apart on 2026-09-03, because somebody working in the live app
// fixed one of the rows underneath it. A script that re-reads the list and acts on
// whatever it finds would have spent a model call on a row that no longer needed one, and
// on a future run could act on a row nobody has looked at.

import { createClient } from '@supabase/supabase-js'
import { persistIcpFilterSpec } from '../src/lib/sourcing/persist-icp-filter-spec'

const APPLY = process.argv.includes('--apply')
const TARGET_IDS = process.argv.slice(2).filter(a => !a.startsWith('--'))

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.')
    process.exit(1)
  }

  const supabase = createClient(url, key)

  const { data: docs, error } = await supabase
    .from('strategy_documents')
    .select('id, organisation_id, version, update_trigger, created_at, organisations(name)')
    .eq('document_type', 'icp')
    .eq('status', 'active')
    .is('icp_filter_spec', null)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Could not read strategy_documents:', error.message)
    process.exit(1)
  }

  if (!docs || docs.length === 0) {
    console.log('No active ICP documents are missing a filter spec. Nothing to do.')
    return
  }

  console.log(`\nBEFORE — ${docs.length} active ICP document(s) with icp_filter_spec NULL\n`)
  for (const doc of docs) {
    const orgName = (doc.organisations as unknown as { name?: string } | null)?.name ?? doc.organisation_id

    const { count } = await supabase
      .from('prospects')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', doc.organisation_id)
      .is('sourced_tier', null)
      .not('tiering_reason', 'is', null)

    console.log(
      `  ${doc.id}  org=${orgName}  v${doc.version}  trigger=${doc.update_trigger}  ` +
      `would_requeue=${count ?? 0}`,
    )
  }

  if (!APPLY) {
    console.log('\nReport only. Re-run with --apply followed by the document ids to act on.\n')
    return
  }

  if (TARGET_IDS.length === 0) {
    console.error('--apply requires one or more document ids. Refusing to act on the whole list.')
    process.exit(1)
  }

  const candidateIds = new Set(docs.map(d => d.id))
  const notCandidates = TARGET_IDS.filter(id => !candidateIds.has(id))
  if (notCandidates.length > 0) {
    console.error(
      'These ids are not active ICP documents with a NULL spec, so there is nothing to ' +
      'derive for them. Refusing rather than guessing:\n  ' + notCandidates.join('\n  '),
    )
    process.exit(1)
  }

  console.log(`\nApplying to ${TARGET_IDS.length} named document(s)...\n`)
  for (const id of TARGET_IDS) {
    console.log(`  deriving for ${id}`)
    await persistIcpFilterSpec(supabase, id)
  }

  const { data: after, error: afterError } = await supabase
    .from('strategy_documents')
    .select('id, organisation_id, version, icp_filter_spec, organisations(name)')
    .eq('document_type', 'icp')
    .eq('status', 'active')
    .order('created_at', { ascending: true })

  if (afterError) {
    console.error('Could not read back:', afterError.message)
    process.exit(1)
  }

  console.log('\nAFTER — every active ICP document\n')
  for (const doc of after ?? []) {
    const orgName = (doc.organisations as unknown as { name?: string } | null)?.name ?? doc.organisation_id
    const spec = doc.icp_filter_spec as Record<string, unknown> | null
    console.log(
      `  ${doc.id}  org=${orgName}  v${doc.version}  ` +
      `spec=${spec ? 'set' : 'NULL'}  ` +
      `criterion=${spec && spec['buyer_criterion'] ? 'set' : 'NULL'}`,
    )
  }
  console.log('')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
