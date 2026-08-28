// Restores supabase/baseline/schema.sql into a SCRATCH Supabase project and reports
// whether it actually executes.
//
//   RESTORE_TEST_PROJECT_REF=<scratch ref> \
//     dotenv -e .env.local -- npx tsx scripts/restore-baseline-test.ts
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS
//
// The baseline is the disaster recovery plan for a database the migrations CANNOT
// rebuild. Until 2026-08-27 it had never been restored, and the file said so. On that
// day it was restored for the first time, into a scratch project, and it FAILED FIVE
// TIMES. Every failure was in the generator, not in the database:
//
//   1. 42501 / a live webhook secret in the dump      fixed by scrub() in the generator
//   2. 42P01 ALTER SEQUENCE ... OWNED BY before its table
//   3. 42883 fail_job calls job_queue_backoff, and f sorts before j
//   4. 3F000 schema supabase_functions does not exist on a fresh project
//   5. the same trigger again, once the schema guard was in place
//
// Those fixes were then described in three code comments. A comment is not a test. This
// script is the artefact that lets the next person re-run the thing rather than trust the
// comments, and it is the reason the fixes sat uncommitted for six hours with nobody able
// to confirm them.
//
// ═══════════════════════════════════════════════════════════════════════════
// TWO MODES, AND THE FIRST ONE NEEDS NO DATABASE
//
//   checkRestoreInvariants()  static. Reads the committed file and asserts the four
//                             properties those fixes established. Runs in vitest, with no
//                             credentials, on every commit.
//   the CLI                   the real thing. Executes the file against a scratch project
//                             and reads the object counts back.
//
// The static half exists because it is the half that keeps running. It cannot prove the
// file executes. It CAN prove that a future regeneration has not silently undone a fix,
// which is the failure this project keeps having.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PRODUCTION_REF = 'hjpvnvjryxdjcfdsfhzy'
const BASELINE = join(process.cwd(), 'supabase', 'baseline', 'schema.sql')

// ── The static half ──────────────────────────────────────────────────────────

/**
 * Returns a list of failures, empty when the file is well formed.
 *
 * NON-VACUITY IS CHECKED FIRST, and it is not decoration. Three of these four checks are
 * of the form "every X is after Y". Over a file with no X they pass, silently and for
 * ever. That is the shape that has cost this project the most time: a check that reports
 * success because it had nothing to look at. So an empty or truncated baseline is a
 * FAILURE here, not a pass.
 */
export function checkRestoreInvariants(sql: string): string[] {
  const failures: string[] = []
  const lines = sql.split('\n')
  const lineOf = (re: RegExp, last = false): number => {
    const hits = lines.map((l, i) => (re.test(l) ? i : -1)).filter(i => i >= 0)
    return hits.length === 0 ? -1 : last ? hits[hits.length - 1] : hits[0]
  }

  // 0. NON-VACUITY.
  const tableCount = lines.filter(l => /^CREATE TABLE /.test(l)).length
  const funcCount = lines.filter(l => /^CREATE OR REPLACE FUNCTION /.test(l)).length
  const triggerCount = lines.filter(l => !l.trim().startsWith('--') && /CREATE TRIGGER /.test(l)).length
  if (tableCount < 10 || funcCount < 10 || triggerCount < 1) {
    failures.push(
      `the baseline looks empty or truncated (${tableCount} tables, ${funcCount} functions, ` +
      `${triggerCount} triggers), so the checks below would pass over nothing. Regenerate it.`
    )
    return failures
  }

  // 1. SEQUENCE OWNERSHIP AFTER THE TABLES. ALTER SEQUENCE ... OWNED BY names a COLUMN,
  //    so the table has to exist. Emitting it beside CREATE SEQUENCE, which correctly
  //    precedes the tables, made the first two statements of every restore fail (42P01).
  const lastCreateTable = lineOf(/^CREATE TABLE /, true)
  const firstOwnedBy = lineOf(/^ALTER SEQUENCE .* OWNED BY /)
  if (firstOwnedBy >= 0 && firstOwnedBy < lastCreateTable) {
    failures.push(
      `ALTER SEQUENCE ... OWNED BY at line ${firstOwnedBy + 1} comes before the last ` +
      `CREATE TABLE at line ${lastCreateTable + 1}. The restore will fail with 42P01.`
    )
  }

  // 2. FUNCTION BODY VALIDATION OFF AROUND THE FUNCTIONS. Functions are emitted
  //    alphabetically and plpgsql validates a body at CREATE time, so a function calling
  //    one that sorts later fails (42883). fail_job calls job_queue_backoff.
  const setOff = lineOf(/^SET check_function_bodies = off;/)
  const resetBodies = lineOf(/^RESET check_function_bodies;/)
  const firstFunc = lineOf(/^CREATE OR REPLACE FUNCTION /)
  const lastFunc = lineOf(/^CREATE OR REPLACE FUNCTION /, true)
  if (setOff < 0 || resetBodies < 0) {
    failures.push(
      'the functions section is not bracketed by SET check_function_bodies = off / RESET. ' +
      'Alphabetical emission means a function calling one that sorts later fails with 42883.'
    )
  } else if (setOff > firstFunc || resetBodies < lastFunc) {
    failures.push(
      `SET check_function_bodies = off (line ${setOff + 1}) and RESET (line ${resetBodies + 1}) ` +
      `do not bracket the functions (lines ${firstFunc + 1} to ${lastFunc + 1}).`
    )
  }

  // 3. PLATFORM-SCHEMA TRIGGERS GUARDED. supabase_functions only exists once Database
  //    Webhooks have been enabled in the dashboard. A fresh project fails with 3F000.
  const unguarded: number[] = []
  let insideGuard = false
  lines.forEach((line, i) => {
    if (/^DO \$baseline\$/.test(line)) insideGuard = true
    if (/^\$baseline\$;/.test(line)) insideGuard = false
    // COMMENTS ARE NOT STATEMENTS. The file's own header explains what the webhook
    // trigger is and names the schema while doing it, and the first version of this check
    // reported that sentence as an unguarded statement. Caught by the test on its first run.
    const isComment = line.trim().startsWith('--')
    if (!isComment && line.includes('supabase_functions.') && !insideGuard) unguarded.push(i + 1)
  })
  if (unguarded.length > 0) {
    failures.push(
      `${unguarded.length} statement(s) reference schema supabase_functions outside a guarded ` +
      `DO block (line ${unguarded[0]}). A fresh project will fail with 3F000.`
    )
  }

  // 4. NO SECRETS. The reason this generator exists at all.
  const secretShaped: Array<[string, RegExp]> = [
    ['64-char hex', /\b[0-9a-f]{64}\b/],
    ['32-char hex', /\b[0-9a-f]{32}\b/],
    ['JWT', /\beyJ[A-Za-z0-9_-]{20,}/],
    ['bearer literal', /Bearer\s+[A-Za-z0-9_.-]{20,}/],
  ]
  for (const [label, re] of secretShaped) {
    if (re.test(sql)) failures.push(`the baseline contains a ${label}. It must never be committed.`)
  }

  return failures
}

// ── The live half ────────────────────────────────────────────────────────────

async function query(ref: string, sql: string): Promise<unknown> {
  const token = process.env.SUPABASE_ACCESS_TOKEN
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is not set')
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`${res.status}: ${body.slice(0, 1200)}`)
  return JSON.parse(body)
}

async function main() {
  const sql = readFileSync(BASELINE, 'utf8')
  const commit = process.argv.includes('--commit')

  console.log('── static invariants ──')
  const failures = checkRestoreInvariants(sql)
  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL  ${f}`)
    process.exit(1)
  }
  console.log('  all four pass (non-vacuity, sequence order, function bodies, trigger guard)')

  const ref = process.env.RESTORE_TEST_PROJECT_REF
  if (!ref) {
    console.log('\nRESTORE_TEST_PROJECT_REF is not set, so the live restore was skipped.')
    console.log('Point it at a scratch Supabase project to run the real thing.')
    return
  }

  // THE GUARD THAT MATTERS. This executes ~3,300 lines of DDL, and in rehearsal mode it
  // drops the public schema first. Rollback makes that safe, but the exclusive lock it
  // takes on the way is not something to do to a live database, and a typo is enough.
  if (ref === PRODUCTION_REF) {
    console.error(`\nREFUSING TO RUN: ${ref} is the PRODUCTION project.`)
    console.error('This script runs against a scratch project or nothing.')
    process.exit(1)
  }

  const readBack = `SELECT
       (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relkind='r') AS tables,
       (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relkind IN ('v','m')) AS views,
       (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public') AS functions,
       (SELECT count(*)::int FROM pg_policies WHERE schemaname='public') AS policies,
       (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND NOT t.tgisinternal) AS triggers,
       (SELECT count(*)::int FROM pg_indexes WHERE schemaname='public') AS indexes`

  if (commit) {
    // ── COMMIT MODE: an actual restore, for provisioning a replacement database. ──
    console.log(`\n── target ${ref}, COMMIT mode ──`)
    const before = (await query(ref, `SELECT count(*)::int AS n FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','v','m')`)) as Array<{ n: number }>
    if (before[0].n > 0) {
      // NOT DROPPED AUTOMATICALLY in this mode. A committed destructive statement needs a
      // human deciding to run it, and this script cannot know the objects are disposable.
      console.error(`\nREFUSING TO RUN: public already holds ${before[0].n} object(s) on ${ref}.`)
      console.error('Reset it yourself, having checked the ref, or drop --commit to rehearse:')
      console.error('\n  DROP SCHEMA public CASCADE; CREATE SCHEMA public;\n')
      process.exit(1)
    }
    const after = (await query(ref, `${sql}\n${readBack};`)) as Array<Record<string, number>>
    console.log('  RESTORED AND COMMITTED')
    console.log(`  read back: ${JSON.stringify(after[0])}`)
    return
  }

  // ── REHEARSAL MODE, THE DEFAULT ──────────────────────────────────────────────
  //
  // The whole restore runs inside ONE transaction that always rolls back, so the target is
  // byte-identical afterwards and the test is repeatable against a project that already
  // holds a previous restore. Postgres DDL is transactional, which is what makes this
  // possible; the same reasoning as CLAUDE.md's BEGIN ... ROLLBACK rule for diagnostics.
  //
  // Verified against the Management API before relying on it: a CREATE TABLE inside such a
  // transaction was visible to a SELECT in the same transaction and absent afterwards.
  //
  // DROP SCHEMA public CASCADE goes first because a restore is only proved by running
  // against an EMPTY schema. Against a populated one, CREATE TABLE IF NOT EXISTS and
  // CREATE OR REPLACE VIEW would skip most of the file and report a success that means
  // nothing.
  console.log(`\n── target ${ref}, REHEARSAL (rolled back, nothing is kept) ──`)
  let rows: Array<Record<string, number>>
  try {
    rows = (await query(ref, [
      'BEGIN;',
      'DROP SCHEMA public CASCADE;',
      'CREATE SCHEMA public;',
      sql,
      `${readBack};`,
      'ROLLBACK;',
    ].join('\n'))) as Array<Record<string, number>>
  } catch (err) {
    console.error('  RESTORE FAILED (and the transaction rolled back, so the target is untouched)')
    console.error(`  ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  console.log('  RESTORED, then rolled back')
  console.log(`  read back inside the transaction: ${JSON.stringify(rows[0])}`)
  console.log('\nThe trigger count is expected to be ONE SHORT of the header\'s coverage count.')
  console.log('That is the Database Webhook trigger, guarded on a platform schema a fresh')
  console.log('project does not have. It raises a warning and skips, by design.')
}

// Only run the CLI when invoked directly, so vitest can import the static half.
if (process.argv[1] && process.argv[1].endsWith('restore-baseline-test.ts')) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
