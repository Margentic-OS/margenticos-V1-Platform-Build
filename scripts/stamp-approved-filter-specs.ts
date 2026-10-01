#!/usr/bin/env npx tsx
// ADR-061, rule 9: existing clients keep exactly what they have.
//
//   npx dotenv -e .env.local -- npx tsx scripts/stamp-approved-filter-specs.ts
//   npx dotenv -e .env.local -- npx tsx scripts/stamp-approved-filter-specs.ts \
//       --apply --approved-by <operator users.id> <document-id>...
//
// A client's live search settings were derived before ADR-061 and carry no record of the
// targeting fields they were built from. Without that record the first comparison cannot
// tell whether anything changed, counts it as changed, and files a proposal that re-derives
// everything. This script gives the settings their record and their approval stamp, once,
// so that the first prose edit after ADR-061 does nothing at all, as designed.
//
// ═══ THE CHECK IT MAKES BEFORE IT WILL STAMP ═════════════════════════════════
//
// Storing "these settings were built from these fields" is a CLAIM, and it is only true
// if the live settings are what those fields produce. So for each document this
// re-derives the deterministic part of the settings from the client's CURRENT targeting
// fields, carrying every model-derived part over unchanged, and compares the result with
// what is live. No model is called.
//
//   NO DIFFERENCE   the claim is true. The document can be stamped.
//   A DIFFERENCE    the live settings do not match the current fields. For example a
//                   headcount was typed into intake after the settings were derived, so
//                   the search still uses the range parsed from prose. Stamping would
//                   hide that for good. The script REFUSES the document and prints the
//                   difference. Leave it unstamped: the next comparison then files a
//                   proposal, which is the honest outcome.
//
// THE COMPARISON IS MADE ON WHAT THE SETTINGS DO, not on every stored value. An axis that
// is switched off sends nothing, so a value stored on it changes nothing. Measured on
// production 2026-09-30: one client's settings were derived before the revenue band was
// read from the document, so they store no band, where a derivation today stores the band
// and switches it off because that client is not opted in. The search is identical. That
// difference is PRINTED, as "stored only", and does not refuse the document.
//
// ═══ WHAT IT WRITES, AND WHAT IT CANNOT CHANGE ═══════════════════════════════
//
// With --apply, for the ids NAMED ON THE COMMAND LINE and no others: the same settings
// with one metadata key added (targeting_inputs), plus the approval time and approver.
// The write is guarded: the row must still be active, still unstamped, and unchanged
// since this script read it. It then reads the row back and confirms the
// settings differ from before by that one key and nothing else.
//
// No sourcing handler and no tiering rule reads targeting_inputs, so this cannot change
// who is sourced, and it re-queues nobody.
//
// It prints ids, versions and field names. Never the text of a document.
import { createClient } from '@supabase/supabase-js'
import {
  readCurrentTargetingInputs,
  rederiveCarryingModelParts,
} from '../src/lib/sourcing/propose-icp-filter-spec'
import { diffSettings } from '../src/lib/sourcing/settings-diff'
import type { ICPFilterSpec } from '../src/lib/agents/icp-filter-spec'

const APPLY = process.argv.includes('--apply')
const byIndex = process.argv.indexOf('--approved-by')
const APPROVED_BY = byIndex >= 0 ? process.argv[byIndex + 1] : undefined
const TARGET_IDS = process.argv.slice(2).filter((a, i, all) =>
  !a.startsWith('--') && all[i - 1] !== '--approved-by')

/**
 * The stored fields each switchable axis governs. An axis that is off contributes nothing
 * to the search, whatever is stored under it. Named here, for this one-off script only,
 * because the handler's own table is keyed on the provider's parameter names.
 */
const AXIS_FIELDS: Record<string, string[]> = {
  seniority_levels: ['seniority_levels'],
  keywords: ['keywords'],
  industries_excluded: ['industries_excluded'],
  keywords_excluded: ['keywords_excluded'],
  company_revenue: ['company_revenue_min', 'company_revenue_max'],
}

/** The same settings with every switched-off axis emptied, so two can be compared in effect. */
function inEffect(spec: ICPFilterSpec): ICPFilterSpec {
  const copy = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>
  for (const axis of spec.omitted_axes ?? []) {
    for (const field of AXIS_FIELDS[axis] ?? []) {
      copy[field] = Array.isArray(copy[field]) ? [] : null
    }
  }
  copy.omitted_axes = []
  return copy as unknown as ICPFilterSpec
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v)

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
    .select('id, organisation_id, version, content, updated_at, icp_filter_spec, icp_filter_spec_proposed, icp_filter_spec_approved_at')
    .eq('document_type', 'icp')
    .eq('status', 'active')
    .not('icp_filter_spec', 'is', null)
    .order('created_at', { ascending: true })
  if (error) {
    console.error('Could not read strategy_documents:', error.message)
    process.exit(1)
  }
  if (!docs || docs.length === 0) {
    console.log('No active ICP has live settings. Nothing to stamp.')
    return
  }

  console.log(`\n${docs.length} active ICP document(s) with live settings\n`)
  const stampable = new Map<string, { live: ICPFilterSpec; stamped: ICPFilterSpec; updatedAt: string }>()

  for (const doc of docs) {
    const live = doc.icp_filter_spec as ICPFilterSpec
    const head = `  ${doc.id}  org=${doc.organisation_id}  v${doc.version}`
    if (doc.icp_filter_spec_approved_at) {
      console.log(`${head}\n      already stamped ${doc.icp_filter_spec_approved_at}. Skipped.`)
      continue
    }
    if (live.targeting_inputs) {
      console.log(`${head}\n      settings already carry their targeting fields but no stamp. Skipped: look at it by hand.`)
      continue
    }
    const read = await readCurrentTargetingInputs(supabase, doc.organisation_id, doc.content)
    if ('error' in read) {
      console.log(`${head}\n      REFUSED: could not read the targeting fields (${read.step}: ${read.error}).`)
      continue
    }
    let rebuilt: ICPFilterSpec
    try {
      rebuilt = rederiveCarryingModelParts(live, read.inputs)
    } catch (e) {
      console.log(`${head}\n      REFUSED: the current targeting fields do not derive (${(e as Error).message}).`)
      continue
    }
    const describe = (d: ReturnType<typeof diffSettings>) => [
      ...d.field_changes.map(c => c.kind === 'list'
        ? `${c.field} (+${c.added.length} -${c.removed.length})`
        : `${c.field} (${c.before} -> ${c.after})`),
      ...d.axes_switched_off.map(a => `${a} switched off`),
      ...d.axes_switched_on.map(a => `${a} switched on`),
    ]
    const diff = diffSettings(inEffect(live), inEffect(rebuilt))
    const differences = describe(diff)
    const storedOnly = describe(diffSettings(live, rebuilt)).filter(d => !differences.includes(d))
    if (storedOnly.length > 0) {
      console.log(`${head}\n      stored only, no effect on the search: ${storedOnly.join('; ')}`)
    }
    if (differences.length > 0 || diff.criterion.changed) {
      console.log(
        `${head}\n      REFUSED: the live settings are NOT what the current targeting fields produce.\n` +
        `      ${differences.join('; ') || 'buyer criterion differs'}\n` +
        '      Leave it unstamped. The next comparison files a proposal showing this difference.')
      continue
    }
    console.log(
      `${head}\n      live settings match the current targeting fields. Can be stamped.` +
      (doc.icp_filter_spec_proposed ? ' (a proposal is also waiting on this row)' : ''))
    stampable.set(doc.id, {
      live, stamped: { ...live, targeting_inputs: read.inputs }, updatedAt: doc.updated_at as string,
    })
  }

  if (!APPLY) {
    console.log('\nReport only. Re-run with --apply --approved-by <operator users.id> and the document ids.\n')
    return
  }
  if (!APPROVED_BY || !/^[0-9a-f-]{36}$/.test(APPROVED_BY)) {
    console.error('--apply requires --approved-by <operator users.id>.')
    process.exit(1)
  }
  if (TARGET_IDS.length === 0) {
    console.error('--apply requires one or more document ids. Refusing to act on the whole list.')
    process.exit(1)
  }
  const refused = TARGET_IDS.filter(id => !stampable.has(id))
  if (refused.length > 0) {
    console.error('These ids were not found stampable above. Refusing rather than guessing:\n  ' + refused.join('\n  '))
    process.exit(1)
  }
  const { data: approver, error: approverError } = await supabase
    .from('users').select('id, role').eq('id', APPROVED_BY).maybeSingle()
  if (approverError || !approver || approver.role !== 'operator') {
    console.error('--approved-by must be the id of a user whose role is operator.')
    process.exit(1)
  }

  console.log(`\nStamping ${TARGET_IDS.length} named document(s)...\n`)
  for (const id of TARGET_IDS) {
    const { live, stamped, updatedAt } = stampable.get(id)!
    const { data: written, error: writeError } = await supabase
      .from('strategy_documents')
      .update({
        icp_filter_spec: stamped,
        icp_filter_spec_approved_at: new Date().toISOString(),
        icp_filter_spec_approved_by: APPROVED_BY,
      })
      .eq('id', id)
      .eq('status', 'active')
      .is('icp_filter_spec_approved_at', null)
      // The row must not have changed since it was read above. updated_at is moved by a
      // trigger on every change to the row, so an approval, a proposal or a hand edit that
      // landed in between makes this match nothing, and the row is left alone.
      .eq('updated_at', updatedAt)
      .select('id, icp_filter_spec, icp_filter_spec_approved_at, icp_filter_spec_approved_by')
    if (writeError) { console.error(`  ${id}  FAILED: ${writeError.message}`); process.exit(1) }
    if (!written || written.length !== 1) {
      console.error(`  ${id}  NOT WRITTEN: the row changed since it was read (no longer active, already stamped, or edited).`)
      process.exit(1)
    }
    const after = written[0].icp_filter_spec as ICPFilterSpec
    const { targeting_inputs: _added, ...withoutKey } = after
    const identical = stable(withoutKey) === stable(live)
    console.log(
      `  ${id}  stamped ${written[0].icp_filter_spec_approved_at}\n` +
      `      read back: settings identical apart from the added key = ${identical}`)
    if (!identical) { console.error('  READ-BACK MISMATCH. Stop and look at this row by hand.'); process.exit(1) }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
