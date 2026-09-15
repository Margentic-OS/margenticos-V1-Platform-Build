// Can we rebuild the database from what is in this repo?
//
//   node scripts/migration-replay/replay.mjs baseline     # the REAL recovery path
//   node scripts/migration-replay/replay.mjs migrations-only
//   node scripts/migration-replay/replay.mjs baseline 20260828   # explicit cutoff
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// Until 2026-09-15 nothing had ever answered that question. The baseline had been
// RESTORED once, on 2026-08-27, into a scratch Supabase project, which proved it was
// executable on the day. Nothing checked it again, and nothing had ever replayed the
// migration set at all.
//
// The first run found that `supabase/migrations/` CANNOT rebuild an empty database: the
// very first file fails with `relation "organisations" does not exist`, because the core
// tables were created outside the migrations directory in April 2026. So the baseline is
// not a convenience, it is the only route back, and this script is how that stays true.
//
// ═══════════════════════════════════════════════════════════════════════════
// IT NEEDS PGlite, AND DELIBERATELY DOES NOT DEPEND ON IT
//
// There is no Docker, psql or local Postgres on this machine, so `supabase db start`
// cannot run. PGlite is a real PostgreSQL (WASM, in-process) and is enough.
//
// It is NOT in package.json on purpose. Vercel installs devDependencies during the build,
// and this is a large WASM package the build has no use for. This repo has already been
// bitten twice by node_modules behaviour during deploys (the postgrest patch and the
// build cache), so the dependency stays out and the script asks for it when run:
//
//   npm i --no-save @electric-sql/pglite
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT IT CANNOT TELL YOU
//
// PGlite has no pg_cron, pg_net, pgcrypto, uuid-ossp, supabase_vault or
// pg_stat_statements, and no Supabase platform schemas. bootstrap.mjs stubs the roles,
// schemas and functions our SQL calls, so that a failure is attributable to OUR SQL
// rather than to a missing extension. Anything still failing after that is worth reading.
//
// A clean replay proves the statements are VALID and ORDERED. It does not prove the
// result is byte-identical to production. Only a real restore does that; see
// scripts/restore-baseline-test.ts.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { splitStatements } from './split.mjs'
import { BOOTSTRAP } from './bootstrap.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const MIG = path.join(REPO, 'supabase', 'migrations')
const BASELINE = path.join(REPO, 'supabase', 'baseline', 'schema.sql')

let PGlite
try {
  ({ PGlite } = await import('@electric-sql/pglite'))
} catch {
  console.error(
    'This script needs PGlite, which is deliberately not a dependency of this repo.\n' +
    'Run:  npm i --no-save @electric-sql/pglite\n' +
    'See the header of this file for why it is not in package.json.'
  )
  process.exit(1)
}

const mode = process.argv[2] || 'baseline'

// The cutoff defaults to the baseline's OWN capture date, read from its header, rather
// than to a constant that would silently rot. Line 3 reads:
//   -- Captured YYYY-MM-DD HH:MM UTC from the LIVE database, read-only.
// Using the filesystem mtime here would be wrong: for a git-tracked file that is the last
// checkout, not the capture. That mistake was made once already, on 2026-09-15, and it
// produced a confident and completely incorrect finding.
function baselineCutoff() {
  const head = fs.readFileSync(BASELINE, 'utf8').slice(0, 400)
  const m = /Captured (\d{4})-(\d{2})-(\d{2})/.exec(head)
  if (!m) throw new Error('could not read the capture date from the baseline header')
  return `${m[1]}${m[2]}${m[3]}`
}

const db = await PGlite.create()

// ── Bootstrap, then PROVE it produced a usable environment ──────────────────
let bootFailed = 0
for (const stmt of BOOTSTRAP) {
  try { await db.exec(stmt) } catch { bootFailed++ }
}
const ctl = await db.query(`select
  (select count(*) from pg_roles where rolname in ('anon','authenticated','service_role')) as roles,
  (select count(*) from pg_namespace where nspname in ('auth','cron','net')) as schemas,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='auth' and p.proname='uid') as authuid`)
const c = ctl.rows[0]
console.log(`BOOTSTRAP CONTROL: roles=${c.roles}/3 schemas=${c.schemas}/3 auth.uid=${c.authuid}/1 (${bootFailed} stmts failed, some are expected)`)
if (c.roles !== 3 || c.schemas !== 3 || c.authuid !== 1) {
  console.error('BOOTSTRAP IS BROKEN — every result below would be meaningless. Stopping.')
  process.exit(1)
}

// ── NEGATIVE CONTROL: prove the harness can DETECT a bad statement ──────────
// Without this a clean run is indistinguishable from a harness that silently swallows
// everything, which is the failure shape this repo keeps meeting.
let detected = false
try { await db.exec('ALTER TABLE auth.users ADD COLUMN probe_col TEXT NULLABLE') }
catch (e) { detected = /NULLABLE/.test(e.message) }
console.log(`HARNESS CONTROL: known-bad statement ${detected ? 'DETECTED' : 'NOT DETECTED — harness is blind'}`)
if (!detected) process.exit(1)

const all = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()
const cutoff = process.argv[3] || (mode === 'baseline' ? baselineCutoff() : null)
const files = mode === 'baseline' ? all.filter(f => f >= cutoff) : all

console.log(`\nMODE: ${mode}`)
if (mode === 'baseline') console.log(`BASELINE CUTOFF (from its own header): ${cutoff}`)
console.log(`FILES: ${files.length} of ${all.length}\n`)

async function runSqlFile(file) {
  const stmts = splitStatements(fs.readFileSync(file, 'utf8'))
  const errors = []
  for (const s of stmts) {
    try { await db.exec(s) }
    catch (e) {
      errors.push({ msg: String(e.message).split('\n')[0], stmt: s.slice(0, 90).replace(/\s+/g, ' ') })
      // A failed statement leaves the session in an aborted transaction, and every later
      // statement then reports "current transaction is aborted" instead of its own error.
      // Without this reset one early failure invents dozens of phantom ones: the first
      // run of this script reported 655 failures where there were 624.
      try { await db.exec('ROLLBACK') } catch { /* nothing open */ }
    }
  }
  return { statements: stmts.length, errors }
}

if (mode === 'baseline') {
  const r = await runSqlFile(BASELINE)
  console.log(`BASELINE: ${r.statements} statements, ${r.errors.length} failed`)
  for (const m of [...new Set(r.errors.map(e => e.msg))]) console.log(`    ${m}`)
  console.log('')
}

const failedFiles = []
let totalStmts = 0
for (const f of files) {
  const r = await runSqlFile(path.join(MIG, f))
  totalStmts += r.statements
  if (r.errors.length) failedFiles.push({ file: f, ...r })
}

// The three classes mean completely different things and must not be added together.
function classify(msg) {
  if (/extension "[^"]+" is not available/.test(msg)) return 'ENVIRONMENT (PGlite limit)'
  if (/current transaction is aborted/.test(msg)) return 'CASCADE'
  if (/syntax error/.test(msg)) return 'SYNTAX'
  if (/does not exist/.test(msg)) return 'MISSING PRIOR OBJECT'
  return 'OTHER'
}
const byClass = {}
for (const f of failedFiles) for (const e of f.errors) {
  const k = classify(e.msg); byClass[k] = (byClass[k] || 0) + 1
}

console.log('FAILURE CLASSES:')
for (const [k, v] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(v).padStart(4)}  ${k}`)
}
const syntax = failedFiles.flatMap(f => f.errors.filter(e => classify(e.msg) === 'SYNTAX').map(e => `${f.file}: ${e.msg}`))
console.log(`\nSYNTAX ERRORS (ours, always): ${syntax.length}`)
for (const s of syntax) console.log(`   ${s}`)

console.log(`\nREPLAYED: ${files.length} files, ${totalStmts} statements`)
console.log(`FILES WITH A FAILURE: ${failedFiles.length}`)

if (process.env.VERBOSE) {
  for (const f of failedFiles) {
    console.log(`\n── ${f.file}  (${f.errors.length}/${f.statements})`)
    for (const e of f.errors.slice(0, 3)) console.log(`     ${e.msg}`)
  }
}

process.exit(syntax.length > 0 ? 1 : 0)
