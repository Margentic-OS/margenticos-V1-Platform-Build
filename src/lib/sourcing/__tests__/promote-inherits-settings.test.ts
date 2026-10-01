// ADR-061 step 3: a new ICP version inherits the live search settings.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. It reads MIGRATION FILES. Migrations are
// append-only, so this proves what the newest definition of the promote function said on
// the day it was written. A later migration is free to redefine it, and this file follows
// that one, but nothing here reads the live database. The authoritative checks are the
// live test beside this file, which runs the real function against the test database, and
// the read-back of pg_get_functiondef recorded in the migration's status line.
//
// It is kept anyway because it blocks in CI and the live tier does not.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const SIGNATURE = 'FUNCTION public.promote_strategy_doc_version'

/**
 * The newest migration that defines the promote function, comments stripped.
 *
 * `body` is the function's own text and nothing else. The migration around it has other
 * statements, including another SELECT, and a pattern run over the whole file matched that
 * one first. `sql` is the whole file, for the grants, which sit outside the function.
 */
function latestPromoteDefinition(): { file: string; sql: string; body: string } {
  const files = readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.sql'))
    .filter(f => readFileSync(join(MIGRATIONS, f), 'utf8').includes(`CREATE OR REPLACE ${SIGNATURE}`))
    .sort()
  // Guard the guard: over an empty list every assertion below would pass on an empty string.
  expect(files.length, 'no migration defines promote_strategy_doc_version').toBeGreaterThan(0)
  const file = files[files.length - 1]
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
  const start = sql.indexOf(`CREATE OR REPLACE ${SIGNATURE}`)
  const open = sql.indexOf('AS $function$', start)
  const close = sql.indexOf('$function$;', open + 1)
  expect(open, 'the function body was not found').toBeGreaterThan(-1)
  expect(close, 'the end of the function body was not found').toBeGreaterThan(open)
  return { file, sql, body: sql.slice(open, close) }
}

const SETTINGS_COLUMNS = [
  'icp_filter_spec',
  'icp_filter_spec_proposed',
  'icp_filter_spec_approved_at',
  'icp_filter_spec_approved_by',
]

describe('promote_strategy_doc_version, as its newest migration defines it', () => {
  it('reads the four settings columns from the active ICP row', () => {
    const { body } = latestPromoteDefinition()
    // The column list may hold only lowercase names, commas and space. That is what stops
    // the match starting at an EARLIER select in the same function: every other one has an
    // uppercase keyword between its SELECT and this INTO.
    const read = body.match(/SELECT\s+([a-z_,\s]+?)\s+INTO\s+v_spec,\s*v_proposed,\s*v_approved_at,\s*v_approved_by\s+FROM\s+strategy_documents\s+WHERE([\s\S]*?)LIMIT 1/)
    expect(read, 'the function does not read the live settings into its variables').not.toBeNull()
    const [, columns, where] = read!
    expect(columns.split(',').map(c => c.trim())).toEqual(SETTINGS_COLUMNS)
    // From the LIVE row of this organisation's ICP, and no other row.
    expect(where).toMatch(/organisation_id\s*=\s*p_org_id/)
    expect(where).toMatch(/document_type\s*=\s*'icp'/)
    expect(where).toMatch(/status\s*=\s*'active'/)
    expect(where).toMatch(/segment_id IS NOT DISTINCT FROM p_segment_id/)
  })

  it('only does so for ICPs', () => {
    const { body } = latestPromoteDefinition()
    expect(body).toMatch(/IF p_doc_type = 'icp' THEN\s+SELECT\s+icp_filter_spec,/)
  })

  it('writes all four onto the new row, in the insert that creates it', () => {
    const { body } = latestPromoteDefinition()
    const insert = body.match(/INSERT INTO strategy_documents \(([\s\S]*?)\)\s*VALUES \(([\s\S]*?)\)\s*RETURNING \* INTO v_new_doc/)
    expect(insert, 'the insert was not found').not.toBeNull()
    const columns = insert![1].split(',').map(c => c.trim())
    const values = insert![2].split(',').map(v => v.trim())
    expect(columns.length).toBe(values.length)
    const written = Object.fromEntries(columns.map((column, i) => [column, values[i]]))
    expect(written.icp_filter_spec).toBe('v_spec')
    expect(written.icp_filter_spec_proposed).toBe('v_proposed')
    expect(written.icp_filter_spec_approved_at).toBe('v_approved_at')
    expect(written.icp_filter_spec_approved_by).toBe('v_approved_by')
  })

  it('reads the live row BEFORE it archives it', () => {
    // After the archive there is no active row left to read, and the new row would inherit
    // nothing while every other check here still passed.
    const { body } = latestPromoteDefinition()
    const read = body.indexOf('INTO v_spec, v_proposed')
    const archive = body.indexOf("SET status = 'archived'")
    expect(read).toBeGreaterThan(-1)
    expect(archive).toBeGreaterThan(-1)
    expect(read).toBeLessThan(archive)
  })

  it('does not touch the sourcing cursor: ADR-061 moved that to step 4', () => {
    // A cursor that kept its offset while the old path still re-derived the search would
    // point into a different result set and skip records silently. Step 4 removes the
    // re-derivation and adds the re-key in the same rollout, and changes this test then.
    const { body } = latestPromoteDefinition()
    expect(body.length).toBeGreaterThan(500)
    expect(body).not.toMatch(/sourcing_cursors/)
  })

  it('still names all three roles when it restates who may call it', () => {
    const { sql } = latestPromoteDefinition()
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.promote_strategy_doc_version\([^)]*\) FROM PUBLIC/)
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.promote_strategy_doc_version\([^)]*\) FROM anon, authenticated/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.promote_strategy_doc_version\([^)]*\) TO service_role/)
  })
})
