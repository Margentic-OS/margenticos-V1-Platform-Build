// Empties the integration-test database of the organisations the suite leaves behind.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// Test files seed organisations and delete them on the way out. Cleanup only runs
// when a run COMPLETES, so an interrupted run, a killed worker, or a run from a
// worktree whose copy of a test predates its checked cleanup all strand rows. They
// accumulate, and some of them then change what a later run measures: on
// 2026-09-14 the project held 765 organisations and 56 pending client_revision
// rows, and those 56 were enough to fail mon_006_per_row.test.ts on every run,
// because that file read a database-wide aggregate.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY IT CANNOT REACH PRODUCTION
//
// The client comes from createTestServiceClient, whose allowlist admits only the
// dedicated test project or a local stack and refuses everything else by name.
// That is a structural guarantee, not a promise: there is no argument to this
// script that can point it at another database, and pointing TEST_SUPABASE_URL at
// production makes it throw rather than run.
//
// The organisations go through deleteTestOrganisations, the same checked helper the
// tests use, so the children are cleared in dependency order, every PostgREST error
// is raised rather than discarded, and the rows are read back afterwards. A
// hand-written delete here would reintroduce exactly the 2026-09-04 defect that
// helper exists to prevent.
//
// ═══════════════════════════════════════════════════════════════════════════
// USAGE
//
//   npx dotenv -e .env.test.local -- npx tsx scripts/clean-test-database.ts          (counts only)
//   npx dotenv -e .env.test.local -- npx tsx scripts/clean-test-database.ts --confirm (deletes)
//
// Without --confirm it reports and changes nothing, because a script that empties a
// database on a bare invocation is one tab-completion away from an accident.

import { createTestServiceClient, TEST_PROJECT_REF } from '@/test-utils/test-database'
import { deleteTestOrganisations } from '@/test-utils/delete-test-organisations'

// Ids are sent as a query parameter, so the whole set cannot go in one request.
// Fifty UUIDs is about 1.9KB, comfortably inside any gateway's URL limit.
const BATCH_SIZE = 50

const CONTEXT = 'scripts/clean-test-database.ts'

async function countRows(
  client: ReturnType<typeof createTestServiceClient>,
  table: 'organisations' | 'document_suggestions',
): Promise<number> {
  const { count, error } = await client.from(table).select('*', { count: 'exact', head: true })
  if (error) throw new Error(`could not count ${table}: ${error.code ?? 'no-code'}: ${error.message}`)
  if (count === null) throw new Error(`counting ${table} returned no count, so nothing was measured`)
  return count
}

async function main(): Promise<void> {
  const confirmed = process.argv.includes('--confirm')

  const client = createTestServiceClient(CONTEXT)
  console.log(`target project ref: ${TEST_PROJECT_REF} (allowlisted; production is refused by construction)`)

  const orgsBefore = await countRows(client, 'organisations')
  const suggestionsBefore = await countRows(client, 'document_suggestions')
  console.log(`before: ${orgsBefore} organisations, ${suggestionsBefore} document_suggestions`)

  if (!confirmed) {
    console.log('no --confirm, so nothing was deleted')
    return
  }

  // The stranded mon_006 rows first, by their own marker, so the count that goes in
  // the report is attributable rather than a side effect of the cascade below.
  const { error: suggestionError } = await client
    .from('document_suggestions')
    .delete()
    .like('field_path', 'mon-006-test-%')
  if (suggestionError) {
    throw new Error(
      `could not delete the stranded mon-006 document_suggestions: ` +
        `${suggestionError.code ?? 'no-code'}: ${suggestionError.message}`,
    )
  }
  const suggestionsAfterMarkerSweep = await countRows(client, 'document_suggestions')
  console.log(
    `deleted mon-006 marked rows: ${suggestionsBefore} -> ${suggestionsAfterMarkerSweep} document_suggestions`,
  )

  // Read the ids rather than issuing an unbounded delete, so every organisation
  // removed is one this script has seen, and so the checked helper can do the work.
  const ids: string[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('organisations')
      .select('id')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`could not list organisations: ${error.code ?? 'no-code'}: ${error.message}`)
    if (!data || data.length === 0) break
    ids.push(...data.map((row) => row.id))
    if (data.length < PAGE) break
  }
  console.log(`listed ${ids.length} organisation ids`)

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE)
    await deleteTestOrganisations(client, batch, CONTEXT)
    console.log(`  deleted ${Math.min(i + BATCH_SIZE, ids.length)}/${ids.length}`)
  }

  const orgsAfter = await countRows(client, 'organisations')
  const suggestionsAfter = await countRows(client, 'document_suggestions')
  console.log(`after: ${orgsAfter} organisations, ${suggestionsAfter} document_suggestions`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
