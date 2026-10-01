// ADR-061 step 5: the two database functions that end a proposal's life.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. It reads MIGRATION FILES. Migrations are
// append-only, so this proves what the newest definition of each function said on the day
// it was written. Nothing here reads the live database. The authoritative checks are the
// live test beside this file, which runs the real functions against the test database, and
// the privilege read-back recorded in the migration's status line.
//
// It is kept anyway because it blocks in CI and the live tier does not.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')

/** The newest migration that defines `name`, comments stripped: the whole file, and the body. */
function latestDefinition(name: string): { file: string; sql: string; header: string; body: string } {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`
  const files = readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.sql'))
    .filter(f => readFileSync(join(MIGRATIONS, f), 'utf8').includes(marker))
    .sort()
  // Guard the guard: over an empty list every assertion below would pass on an empty string.
  expect(files.length, `no migration defines ${name}`).toBeGreaterThan(0)
  const file = files[files.length - 1]
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
  const start = sql.indexOf(marker)
  const open = sql.indexOf('AS $function$', start)
  const close = sql.indexOf('$function$;', open + 1)
  expect(open, `the body of ${name} was not found`).toBeGreaterThan(start)
  expect(close, `the end of ${name} was not found`).toBeGreaterThan(open)
  return { file, sql, header: sql.slice(start, open), body: sql.slice(open, close) }
}

const APPROVE = 'approve_icp_filter_spec_proposal'
const REJECT = 'reject_icp_filter_spec_proposal'
const SIGNATURES: Record<string, string> = {
  [APPROVE]: 'uuid, jsonb, jsonb, uuid, boolean, boolean',
  [REJECT]: 'uuid, jsonb',
}

describe.each([APPROVE, REJECT])('%s, as its newest migration defines it', name => {
  it('runs as the caller, so the caller\'s own row security still applies', () => {
    const { header } = latestDefinition(name)
    expect(header).toMatch(/SECURITY INVOKER/)
    expect(header).not.toMatch(/SECURITY DEFINER/)
    expect(header).toMatch(/SET search_path TO 'public'/)
  })

  it('revokes anon and authenticated BY NAME, and grants the service role', () => {
    // REVOKE FROM PUBLIC alone removes nothing on Supabase: the default privileges grant
    // EXECUTE to anon and authenticated explicitly.
    const { sql } = latestDefinition(name)
    const signature = `public.${name}(${SIGNATURES[name]})`
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`)
    expect(sql).toContain(`REVOKE EXECUTE ON FUNCTION ${signature} FROM anon, authenticated;`)
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`)
    expect(sql).not.toMatch(new RegExp(`GRANT[^;]*${name}[^;]*TO[^;]*(anon|authenticated)`))
  })

  it('locks the row, then refuses unless it is an active ICP still carrying the proposal named', () => {
    const { body } = latestDefinition(name)
    expect(body).toMatch(/FROM strategy_documents\s+WHERE id = p_document_id\s+FOR UPDATE;/)
    expect(body).toMatch(/v_doc\.document_type <> 'icp'/)
    expect(body).toMatch(/v_doc\.status <> 'active'/)
    expect(body).toMatch(/v_doc\.icp_filter_spec_proposed IS NULL/)
    expect(body).toMatch(/v_doc\.icp_filter_spec_proposed <> p_expected_proposal/)
  })

  it('makes every check before its first write', () => {
    const { body } = latestDefinition(name)
    const firstWrite = body.search(/\bUPDATE\s+\w+\s+SET\b/)
    expect(firstWrite, 'no write found').toBeGreaterThan(-1)
    const lastRefusal = body.lastIndexOf("'refused'")
    expect(lastRefusal, 'no refusal found').toBeGreaterThan(-1)
    expect(lastRefusal).toBeLessThan(firstWrite)
  })
})

describe(`${APPROVE}: what it writes`, () => {
  it('refuses when the LIVE settings are not the ones the caller judged', () => {
    const { body } = latestDefinition(APPROVE)
    expect(body).toMatch(/v_doc\.icp_filter_spec IS DISTINCT FROM p_expected_live/)
  })

  it('replaces the settings with the stored proposal, clears it, and stamps who and when', () => {
    const { body } = latestDefinition(APPROVE)
    const write = body.match(/UPDATE strategy_documents\s+SET([\s\S]*?)WHERE id = p_document_id;/)
    expect(write, 'the settings write was not found').not.toBeNull()
    const set = write![1]
    // The value written is the one in the locked row, not the copy the caller sent.
    expect(set).toMatch(/icp_filter_spec\s*=\s*v_doc\.icp_filter_spec_proposed/)
    expect(set).toMatch(/icp_filter_spec_proposed\s*=\s*NULL/)
    expect(set).toMatch(/icp_filter_spec_approved_at\s*=\s*now\(\)/)
    expect(set).toMatch(/icp_filter_spec_approved_by\s*=\s*p_approved_by/)
  })

  it('resets the cursor only inside the branch the caller switched on, for this organisation', () => {
    const { body } = latestDefinition(APPROVE)
    const branch = body.match(/IF p_reset_cursor THEN([\s\S]*?)END IF;\s+END IF;/)
    expect(branch, 'the cursor branch was not found').not.toBeNull()
    expect(branch![1]).toMatch(/UPDATE sourcing_cursors\s+SET record_offset\s*=\s*0/)
    expect(branch![1]).toMatch(/WHERE organisation_id = v_doc\.organisation_id;/)
    // And nowhere else in the function.
    expect(body.match(/UPDATE sourcing_cursors/g)).toHaveLength(1)
  })

  it('re-queues only inside the branch the caller switched on, with ADR-037\'s scope', () => {
    const { body } = latestDefinition(APPROVE)
    const branch = body.match(/IF p_requeue THEN([\s\S]*?)END IF;/)
    expect(branch, 'the re-queue branch was not found').not.toBeNull()
    const requeue = branch![1]
    expect(requeue).toMatch(/UPDATE prospects\s+SET tiering_reason = NULL/)
    expect(requeue).toMatch(/WHERE organisation_id = v_doc\.organisation_id/)
    expect(requeue).toMatch(/AND sourced_tier IS NULL/)
    expect(requeue).toMatch(/AND tiering_reason IS NOT NULL/)
    expect(body.match(/UPDATE prospects/g)).toHaveLength(1)
  })

  it('refuses a cursor reset while a sourcing run for that organisation is in flight', () => {
    const { body } = latestDefinition(APPROVE)
    const guard = body.match(/IF p_reset_cursor AND EXISTS \(([\s\S]*?)\) THEN\s+RETURN jsonb_build_object\('applied', false, 'refused', 'sourcing_in_progress'\)/)
    expect(guard, 'the in-flight guard was not found').not.toBeNull()
    expect(guard![1]).toMatch(/FROM sourcing_runs/)
    expect(guard![1]).toMatch(/organisation_id = v_doc\.organisation_id/)
    expect(guard![1]).toMatch(/status\s*=\s*'running'/)
    expect(guard![1]).toMatch(/started_at\s*>\s*now\(\) - interval '15 minutes'/)
  })
})

describe(`${REJECT}: what it writes`, () => {
  it('clears the proposal and writes nothing else', () => {
    const { body } = latestDefinition(REJECT)
    const writes = body.match(/\b(UPDATE|INSERT INTO|DELETE FROM)\s+\w+/g) ?? []
    expect(writes).toEqual(['UPDATE strategy_documents'])
    const write = body.match(/UPDATE strategy_documents\s+SET([\s\S]*?)WHERE id = p_document_id;/)
    expect(write![1].trim()).toBe('icp_filter_spec_proposed = NULL')
  })
})
