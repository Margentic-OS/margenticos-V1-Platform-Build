// Proof harness for the research button's count.
//
// Prints, for every active organisation, the number the OLD dashboard predicate produced
// beside the number the action's own selection function produces. They are supposed to
// differ: that difference IS the defect this exists to measure.
//
// READ ONLY. Three SELECTs per organisation and no writes of any kind. Safe to run against
// production, which is the point: a proof taken against a fixture proves the fixture.
//
// Run:  npx dotenv -e .env.local -- npx tsx scripts/prove-research-verdict.ts

import { createClient } from '@supabase/supabase-js'
import { getResearchVerdict } from '../src/lib/operator/research-verdict'
import { selectProspectsForResearch } from '../src/lib/queue/enqueue/research'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. ' +
      'Run via: npx dotenv -e .env.local -- npx tsx scripts/prove-research-verdict.ts',
    )
  }

  const supabase = createClient(url, key)

  const { data: orgs, error } = await supabase
    .from('organisations')
    .select('id, name')
    .is('archived_at', null)
    .order('name')
  if (error) throw new Error(`Could not read organisations: ${error.message}`)

  const rows: Array<Record<string, string>> = []

  for (const org of orgs ?? []) {
    // THE OLD PREDICATE, reproduced verbatim from what the page used to compute:
    //   current_research_result_id IS NULL AND suppressed = false
    const { count: oldLabel, error: oldError } = await supabase
      .from('prospects')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', org.id)
      .is('current_research_result_id', null)
      .eq('suppressed', false)
    if (oldError) throw new Error(`Old-predicate count failed: ${oldError.message}`)

    const read = await selectProspectsForResearch(supabase, org.id, 'unresearched')
    const verdict = await getResearchVerdict(supabase, org.id)

    rows.push({
      organisation: org.name,
      'old label': String(oldLabel ?? 0),
      'after tier gate': read.ok ? String(read.selection.selected) : 'n/a',
      'eligible': read.ok ? String(read.selection.eligible) : 'n/a',
      'held by a live job': read.ok ? String(read.selection.skippedLiveElsewhere) : 'n/a',
      'NEW LABEL (actionable)': String(verdict.actionable),
      agree: String(oldLabel ?? 0) === String(verdict.actionable) ? 'yes' : 'NO',
      'blocked reason': verdict.blocked ? verdict.blocked.slice(0, 70) + '...' : '-',
      'skipped': verdict.skippedBreakdown ?? '-',
      path: verdict.path,
    })
  }

  // eslint-disable-next-line no-console -- a proof harness prints to a terminal by design
  console.table(rows)
}

main().catch(err => {
  // eslint-disable-next-line no-console -- see above
  console.error(err)
  process.exit(1)
})
