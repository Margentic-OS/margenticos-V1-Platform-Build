#!/usr/bin/env npx tsx
// Report only. Says whether moving a client's ICP from one version to another changes a
// targeting field (ADR-061), and names the fields. Reads two rows. Writes nothing and calls
// no model and no provider.
//
// It runs the REAL comparison, `compareTargetingInputs`, on real documents. That is the
// point: a fixture proves the comparison on a document somebody wrote for the test, and
// this proves it on the documents the question is actually about, without committing a
// client's document to the repository.
//
// Usage:
//   npx dotenv -e .env.local -- npx tsx scripts/show-targeting-change.ts \
//     --from <strategy_documents.id> --to <strategy_documents.id>
//   npx dotenv -e .env.local -- npx tsx scripts/show-targeting-change.ts \
//     --suggestion <document_suggestions.id>
//
// With --suggestion, "from" is the document the suggestion would replace.
//
// It prints PATHS and COUNTS, never the text of a document.
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { compareTargetingInputs, targetingInputs } from '../src/lib/sourcing/targeting-inputs'
import { readBuyerProfile } from '../src/lib/intake/buyer-profile-store'
import { statedHeadcount } from '../src/lib/intake/buyer-profile-authority'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** Every leaf path of a document, with its value serialised, for a whole-document diff. */
function leaves(value: unknown, path: string, out: Map<string, string>): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => leaves(item, `${path}[${i}]`, out))
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      leaves(child, path ? `${path}.${key}` : key, out)
    }
  } else {
    out.set(path, JSON.stringify(value ?? null))
  }
}

async function main() {
  const suggestionId = arg('suggestion')
  let fromId = arg('from')
  const toId = arg('to')
  if (!suggestionId && !(fromId && toId)) {
    console.error('Give --from <id> --to <id>, or --suggestion <id>.')
    process.exit(1)
  }

  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  let toContent: unknown
  let toLabel: string
  if (suggestionId) {
    const { data: suggestion, error } = await supabase
      .from('document_suggestions')
      .select('id, document_id, document_type, field_path, status, suggested_value')
      .eq('id', suggestionId)
      .single()
    if (error || !suggestion) throw new Error(`suggestion not found: ${error?.message ?? suggestionId}`)
    if (suggestion.document_type !== 'icp' || suggestion.field_path !== 'full_document') {
      throw new Error(
        `suggestion is ${suggestion.document_type}/${suggestion.field_path}; this script reads ` +
        'whole-document ICP suggestions only.')
    }
    if (!suggestion.document_id) throw new Error('suggestion names no document to replace')
    fromId = suggestion.document_id
    toContent = JSON.parse(suggestion.suggested_value ?? 'null')
    toLabel = `suggestion ${suggestion.id} (${suggestion.status})`
  } else {
    const { data: to, error } = await supabase
      .from('strategy_documents').select('id, version, status, content, document_type')
      .eq('id', toId!).single()
    if (error || !to) throw new Error(`--to document not found: ${error?.message ?? toId}`)
    if (to.document_type !== 'icp') throw new Error('--to is not an ICP')
    toContent = to.content
    toLabel = `document ${to.id} (v${to.version}, ${to.status})`
  }

  const { data: from, error: fromError } = await supabase
    .from('strategy_documents')
    .select('id, version, status, content, document_type, organisation_id')
    .eq('id', fromId!).single()
  if (fromError || !from) throw new Error(`from document not found: ${fromError?.message ?? fromId}`)
  if (from.document_type !== 'icp') throw new Error('from document is not an ICP')

  // The two inputs outside the document. They belong to the organisation, so they are the
  // same on both sides of this comparison and cannot be what differs here.
  const { data: org, error: orgError } = await supabase
    .from('organisations').select('sourcing_revenue_filter_enabled')
    .eq('id', from.organisation_id).single()
  if (orgError) throw new Error(`could not read the organisation: ${orgError.message}`)
  const outside = {
    statedHeadcount: statedHeadcount(await readBuyerProfile(supabase, from.organisation_id)),
    revenueFilterEnabled: org?.sourcing_revenue_filter_enabled === true,
  }

  const before = targetingInputs(from.content, outside)
  const after = targetingInputs(toContent, outside)
  const change = compareTargetingInputs(before, after)

  const a = new Map<string, string>()
  const b = new Map<string, string>()
  leaves(from.content, '', a)
  leaves(toContent, '', b)
  const differing = [...new Set([...a.keys(), ...b.keys()])].filter(p => a.get(p) !== b.get(p)).sort()

  console.log(`\nfrom  document ${from.id} (v${from.version}, ${from.status})`)
  console.log(`to    ${toLabel}`)
  console.log(`\nwhole document: ${differing.length} of ${new Set([...a.keys(), ...b.keys()]).size} leaves differ`)
  for (const path of differing) console.log(`  ${path}`)
  console.log(`\nTARGETING CHANGE: ${change.changed ? 'YES' : 'NO'}`)
  for (const path of change.paths) console.log(`  ${path}`)
  if (change.changed) {
    console.log(
      `\nwould rebuild: geography=${change.geography} buyer criterion=${change.buyer} ` +
      `fit dimensions=${change.document} outside inputs changed=${change.outside}`)
  } else {
    console.log('\nNo targeting field differs. Under ADR-061 this edit files no proposal, calls no')
    console.log('model, and leaves the search settings as they are.')
  }
}
main().catch(e => { console.error(e); process.exit(1) })
