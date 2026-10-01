#!/usr/bin/env npx tsx
// The ADR-061 settings comparison, by hand.
//
//   npx dotenv -e .env.local -- npx tsx scripts/propose-icp-filter-spec.ts
//   npx dotenv -e .env.local -- npx tsx scripts/propose-icp-filter-spec.ts --apply <document-id>...
//
// WITH NO ARGUMENTS it reports and changes nothing. For every active ICP it says whether
// the client has live search settings, whether they carry an approval stamp, whether a
// proposal is waiting, and whether the document's targeting fields still match the ones
// the live settings were built from. It calls no model.
//
// WITH --apply it runs proposeIcpFilterSpec for the document ids NAMED ON THE COMMAND LINE
// and no others. That is the same function every ICP promotion runs. It can call a model,
// which costs money, and the most it ever does is file a PROPOSAL beside the live
// settings. It never changes what a client is sourced with. Use it to retry a proposal
// that failed, which the log line for that failure names this script for.
//
// It replaces scripts/backfill-icp-filter-spec.ts, which derived settings straight onto
// active ICPs that had none. Under ADR-061 nothing writes live settings without approval,
// so a client with none gets a proposal like everybody else.
//
// It prints ids, versions and field PATHS. Never the text of a document.
import { createClient } from '@supabase/supabase-js'
import {
  proposeIcpFilterSpec,
  readCurrentTargetingInputs,
} from '../src/lib/sourcing/propose-icp-filter-spec'
import { compareTargetingInputs, readStoredTargetingInputs } from '../src/lib/sourcing/targeting-inputs'
import type { ICPFilterSpec } from '../src/lib/agents/icp-filter-spec'

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
    .select('id, organisation_id, version, content, icp_filter_spec, icp_filter_spec_proposed, icp_filter_spec_approved_at')
    .eq('document_type', 'icp')
    .eq('status', 'active')
    .order('created_at', { ascending: true })
  if (error) {
    console.error('Could not read strategy_documents:', error.message)
    process.exit(1)
  }

  console.log(`\n${docs?.length ?? 0} active ICP document(s)\n`)
  for (const doc of docs ?? []) {
    const live = doc.icp_filter_spec as ICPFilterSpec | null
    const read = await readCurrentTargetingInputs(supabase, doc.organisation_id, doc.content)
    let verdict: string
    if ('error' in read) {
      verdict = `COULD NOT READ the targeting fields (${read.step}: ${read.error})`
    } else if (!live) {
      verdict = 'no live settings: the next comparison files a first proposal'
    } else {
      const change = compareTargetingInputs(readStoredTargetingInputs(live.targeting_inputs), read.inputs)
      verdict = change.unknown_before
        ? 'live settings carry no record of their targeting fields: the next comparison files a proposal'
        : change.changed
          ? `targeting fields differ from the live settings: ${change.paths.join(', ')}`
          : 'targeting fields match the live settings'
    }
    console.log(
      `  ${doc.id}  org=${doc.organisation_id}  v${doc.version}\n` +
      `      live settings: ${live ? 'yes' : 'NO'}   approved: ${doc.icp_filter_spec_approved_at ?? 'not stamped'}   ` +
      `proposal waiting: ${doc.icp_filter_spec_proposed ? 'YES' : 'no'}\n` +
      `      ${verdict}`,
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
  const active = new Set((docs ?? []).map(d => d.id))
  const unknown = TARGET_IDS.filter(id => !active.has(id))
  if (unknown.length > 0) {
    console.error('These ids are not active ICP documents. Refusing rather than guessing:\n  ' + unknown.join('\n  '))
    process.exit(1)
  }

  console.log(`\nRunning the comparison for ${TARGET_IDS.length} named document(s)...\n`)
  for (const id of TARGET_IDS) {
    const outcome = await proposeIcpFilterSpec(supabase, id)
    console.log(`  ${id}  ->  ${JSON.stringify(outcome)}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
