// The only sanctioned way for a test to remove an organisation it created.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// On 2026-09-04 the test project held 730 organisations. It had been emptied to
// 1 the same day. 582 of them came from one afterEach and 146 from one beforeAll,
// and every run of the suite added more.
//
// Ten cleanup blocks across ten files deleted organisations. Every one of them
// was written like this:
//
//     await supabase.from('organisations').delete().eq('id', testOrgId)
//
// PostgREST answered 409 with a populated `.error`. The bare `await` discarded it.
// The suite reported green while the row it was supposed to remove was still there,
// so the leak had no symptom until someone counted the table.
//
// Two of the ten were failing. The other eight were passing BY LUCK: they happened
// not to create a row in a child table whose foreign key blocks the delete. One of
// them, org-archiving-integration, deleted reply_handling_actions by a single
// signal_id, so a second signal would have started it leaking silently too. Luck is
// not a fix, so all ten call this helper now.
//
// ═══════════════════════════════════════════════════════════════════════════
// BOTH HALVES, IN ONE PLACE
//
// The defect had two halves and fixing either alone leaves the bug reachable:
//
//   1. The delete could not succeed  (a foreign key blocked it)
//   2. The failure could not be seen (the result was never checked)
//
// A cleanup that cannot report its own failure is the defect. The leaked rows are
// only the symptom. So this function does both, and a caller cannot take one
// without the other: it deletes the children in dependency order, AND it throws on
// any error, AND it reads back that the organisations are actually gone.
//
// Deliberately NOT solved by adding ON DELETE CASCADE to the four blocking keys.
// All four are history and attribution tables (agent_runs, reply_handling_actions,
// sourcing_runs, enrichment_runs). Cascading them is a PRODUCTION schema change
// that would make deleting an organisation silently erase its spend and attribution
// history, to solve a problem that only exists in tests. Production archives
// organisations via archived_at and does not hard-delete them, so the cascade would
// buy nothing there and cost the audit trail. Decision taken with Doug, 2026-09-04.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THE ORDER IS NOT OBVIOUS
//
// Four foreign keys block a delete of organisations directly (NO ACTION):
// reply_handling_actions, agent_runs, sourcing_runs, enrichment_runs. Emptying
// those four is not enough, because three of them are themselves pinned:
//
//   prospects.sourcing_run_id            -> sourcing_runs   RESTRICT
//   sourcing_runs.agent_run_id           -> agent_runs      NO ACTION
//   prospect_research_results.run_id     -> agent_runs      NO ACTION
//   reply_drafts.prospect_id             -> prospects       NO ACTION
//   reply_handling_actions.prospect_id   -> prospects       NO ACTION
//
// So prospects must go before sourcing_runs, and sourcing_runs and
// prospect_research_results must both go before agent_runs, and reply_drafts and
// reply_handling_actions must both go before prospects. That is the order below.
// Every table in it carries a NOT NULL organisation_id, so one filter clears each.
//
// Everything else reachable from an organisation is ON DELETE CASCADE or SET NULL
// and needs no help.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT HAPPENS WHEN THIS LIST GOES STALE
//
// This list is maintained by hand, which is the shape that drifts. It is not paired
// with a registry test, because it does not need one: the check runs at RUNTIME on
// every single cleanup. If a new NO ACTION foreign key to organisations is added
// tomorrow, the final delete fails with 23503, this function throws naming the exact
// constraint and table from the error, and the suite goes red on the next run. A
// static test could only prove the list matched the schema on the day it was written;
// the read-back proves it on every run.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

/**
 * Child tables that pin an organisation, in the order they must be emptied.
 * See the dependency derivation above before changing this.
 */
const CHILD_TABLES_IN_DELETE_ORDER = [
  'reply_drafts',
  'reply_handling_actions',
  'prospect_research_results',
  'prospects',
  'sourcing_runs',
  'enrichment_runs',
  'agent_runs',
] as const

function describeError(error: { code?: string; message: string; details?: string | null }): string {
  const parts = [`${error.code ?? 'no-code'}: ${error.message}`]
  if (error.details) parts.push(error.details)
  return parts.join('\n  ')
}

/**
 * Deletes the given test organisations and everything pinning them, and THROWS if
 * it cannot. Ignores null/undefined ids, so a caller whose beforeAll threw partway
 * can pass its variables straight in without guarding each one.
 *
 * `context` names the calling test file, so a failure points at the test that
 * leaked rather than at this module.
 */
export async function deleteTestOrganisations(
  supabase: SupabaseClient<Database>,
  organisationIds: ReadonlyArray<string | null | undefined>,
  context: string,
): Promise<void> {
  const ids = organisationIds.filter((id): id is string => Boolean(id))
  if (ids.length === 0) return

  // Loosely typed for the loop only. The generated Database type gives each table a
  // different row shape, so a single .from(table) over a union of table names does
  // not typecheck. The table names themselves are still checked: they come from the
  // `as const` list above, which is typed against Database below.
  const client = supabase as SupabaseClient

  for (const table of CHILD_TABLES_IN_DELETE_ORDER) {
    const { error } = await client.from(table).delete().in('organisation_id', ids)
    if (error) {
      throw new Error(
        `[test-cleanup] ${context}: could not clear ${table} for organisation(s) ${ids.join(', ')}.\n` +
          `  ${describeError(error)}\n` +
          `  Cleanup must not fail silently. Fix the cause; do not swallow this.`,
      )
    }
  }

  const { error: orgError } = await client.from('organisations').delete().in('id', ids)
  if (orgError) {
    throw new Error(
      `[test-cleanup] ${context}: could not delete organisation(s) ${ids.join(', ')}.\n` +
        `  ${describeError(orgError)}\n` +
        (orgError.code === '23503'
          ? `  A foreign key still pins the organisation. The table is named in the detail\n` +
            `  line above. Add it to CHILD_TABLES_IN_DELETE_ORDER in\n` +
            `  src/test-utils/delete-test-organisations.ts, in an order that respects its own\n` +
            `  dependencies, rather than deleting the rows from the calling test.`
          : `  Cleanup must not fail silently. Fix the cause; do not swallow this.`),
    )
  }

  // Read the result back rather than assuming it. A delete that matched no rows
  // returns no error, so "no error" is not the same as "the row is gone".
  const { data: survivors, error: readError } = await client
    .from('organisations')
    .select('id')
    .in('id', ids)

  if (readError) {
    throw new Error(
      `[test-cleanup] ${context}: deleted organisation(s) ${ids.join(', ')} but could not ` +
        `confirm they are gone.\n  ${describeError(readError)}`,
    )
  }

  if (survivors && survivors.length > 0) {
    throw new Error(
      `[test-cleanup] ${context}: the delete reported success and ` +
        `${survivors.length} organisation(s) are still present: ` +
        `${survivors.map((row: { id: string }) => row.id).join(', ')}.\n` +
        `  This is the exact shape of the 2026-09-04 leak. Do not ignore it.`,
    )
  }
}

/** Convenience wrapper for the common single-organisation case. */
export async function deleteTestOrganisation(
  supabase: SupabaseClient<Database>,
  organisationId: string | null | undefined,
  context: string,
): Promise<void> {
  await deleteTestOrganisations(supabase, [organisationId], context)
}

// Compile-time check that every name above is a real table in the generated schema.
// If a table is renamed or removed, this fails at `tsc --noEmit` rather than at 2am
// in a cleanup block.
type _ChildTablesAreRealTables =
  (typeof CHILD_TABLES_IN_DELETE_ORDER)[number] extends keyof Database['public']['Tables']
    ? true
    : never
const _childTablesAreRealTables: _ChildTablesAreRealTables = true
void _childTablesAreRealTables
