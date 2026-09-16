// THE TIER LABEL MUST MATCH THE WORLD.
//
// The suite runs in two tiers, selected purely by filename (vitest.config.ts):
//
//   *.live.test.*   talks to the test database
//   everything else deterministic, and the only tier CI blocks on
//
// A filename is a declaration, and declarations drift. The dangerous direction is a
// file that reaches the database and is NOT named for it: it lands in the tier that
// is supposed to need no credentials, where it fails on a runner that has none, or
// worse, contends for the shared test database and fails intermittently for reasons
// that belong to no branch.
//
// So this walks the import graph and checks the label against what the code actually
// reaches, rather than trusting either a list or the name.
//
// MEASURED 2026-09-16: eleven files reached the database while named as ordinary
// tests. They were, exactly, the eleven that had been failing intermittently across
// six full runs. The flakiness and the mislabelling were the same set.
//
// THE MARKER IS THE CREDENTIAL READER, NOT THE MODULE NAME. Importing
// test-database does not mean needing a database: production-isolation.test.ts
// imports its pure helpers to test them and connects to nothing. Keying on the
// module name marked that file as live and would have pulled a structural guard out
// of the blocking tier for no reason.

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const SEARCH_ROOTS = ['src', 'tests']

const TEST_DATABASE_MODULE = path.join(ROOT, 'src/test-utils/test-database.ts')

/** The one function that reads the credentials. Everything else is derived from it. */
const CREDENTIAL_READER = 'requireTestDatabaseCredentials'

/**
 * The exports of test-database.ts that ACQUIRE A CONNECTION, derived by reading that
 * module rather than listed here.
 *
 * A hardcoded list of three names would be a second list to keep in step, and the
 * drift is silent: a fourth helper that opens a connection would be invisible to this
 * check, and every file using it would land in the blocking tier.
 *
 * Importing this module is NOT itself a database dependency, which is why the symbols
 * matter rather than the module name. test-database also exports pure helpers
 * (projectRefFromUrl, assertTestDatabase, the two project refs), and
 * production-isolation.test.ts imports exactly those to test them while connecting to
 * nothing. Keying on the module would have pulled a structural guard out of CI.
 */
function connectionAcquiringExports(): string[] {
  const source = fs.readFileSync(TEST_DATABASE_MODULE, 'utf8')
  const found = new Set<string>([CREDENTIAL_READER])
  // Split on export boundaries; a block counts if its body calls the reader.
  const blocks = source.split(/\n(?=export (?:async )?(?:function|const) )/)
  for (const block of blocks) {
    const name = /^export (?:async )?(?:function|const) ([A-Za-z0-9_]+)/.exec(block)?.[1]
    if (!name) continue
    const body = block.slice(block.indexOf('\n'))
    if (body.includes(`${CREDENTIAL_READER}(`)) found.add(name)
  }
  return [...found]
}

const ACQUIRERS = connectionAcquiringExports()
const DATABASE_MARKER = new RegExp(
  `(?:${ACQUIRERS.join('|')})\\s*\\(|process\\.env\\.TEST_SUPABASE`,
)

const IMPORT = /from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/g
const TEST_FILE = /\.test\.(ts|tsx)$/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (TEST_FILE.test(entry.name)) out.push(full)
  }
  return out
}

function resolveImport(spec: string, from: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec)
  else return null
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx', '']) {
    const candidate = base + ext
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * Source with comments and string literals removed, for MARKER matching only.
 *
 * A file that tests the database guard naturally quotes its vocabulary:
 * production-isolation.test.ts contains `createTestServiceClient()` inside an error
 * message and `process.env.TEST_SUPABASE_URL` inside a fixture it feeds to its own
 * detector. Both are text, neither is a call, and matching raw source marked that
 * file live. Imports are still read from the RAW text, because those live in strings
 * by definition.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
}

const reachCache = new Map<string, boolean>()

function reachesDatabase(file: string, seen = new Set<string>()): boolean {
  const cached = reachCache.get(file)
  if (cached !== undefined) return cached
  if (seen.has(file)) return false
  seen.add(file)

  let source: string
  try { source = fs.readFileSync(file, 'utf8') } catch { return false }

  // The definition site is not a use. test-database.ts contains every acquirer by
  // definition; counting it would make any importer of its PURE helpers look live.
  if (file !== TEST_DATABASE_MODULE && DATABASE_MARKER.test(codeOnly(source))) {
    reachCache.set(file, true); return true
  }

  IMPORT.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IMPORT.exec(source)) !== null) {
    const spec = match[1] ?? match[2]
    const resolved = spec ? resolveImport(spec, file) : null
    if (resolved && reachesDatabase(resolved, seen)) { reachCache.set(file, true); return true }
  }
  reachCache.set(file, false)
  return false
}

const testFiles = SEARCH_ROOTS.flatMap(r => {
  const dir = path.join(ROOT, r)
  return fs.existsSync(dir) ? walk(dir) : []
})
const isLive = (f: string) => f.includes('.live.test.')

describe('the tier label matches what the file actually reaches', () => {
  // GUARDS ITSELF FIRST. Every assertion below passes vacuously over an empty set,
  // and a scan that silently found nothing is the exact defect this file exists to
  // catch. See the many entries in CLAUDE.md about checks that cannot fail.
  it('found a plausible number of test files, and some of each tier', () => {
    expect(testFiles.length).toBeGreaterThan(200)
    expect(testFiles.filter(isLive).length).toBeGreaterThan(0)
    expect(testFiles.filter(f => !isLive(f)).length).toBeGreaterThan(0)
  })

  it('derived the connection-acquiring exports, rather than finding none', () => {
    expect(ACQUIRERS).toContain(CREDENTIAL_READER)
    expect(ACQUIRERS.length).toBeGreaterThan(1)
    // The pure helpers must NOT be in it, or the check degenerates to the module name.
    expect(ACQUIRERS).not.toContain('projectRefFromUrl')
    expect(ACQUIRERS).not.toContain('assertTestDatabase')
  })

  it('can detect a database reach at all', () => {
    const live = testFiles.filter(isLive)
    expect(live.some(f => reachesDatabase(f))).toBe(true)
  })

  // THE ONE THAT MATTERS. A file here runs in the blocking tier on a runner with no
  // credentials, and fails there for a reason that has nothing to do with the change
  // being tested.
  it('no file reaches the database without being named *.live.test.*', () => {
    const mislabelled = testFiles
      .filter(f => !isLive(f) && reachesDatabase(f))
      .map(f => path.relative(ROOT, f))
    expect(mislabelled,
      `These reach the test database but are not named for it. Rename each to ` +
      `*.live.test.ts so the deterministic tier stays deterministic:\n  ` +
      mislabelled.join('\n  '),
    ).toEqual([])
  })

  // The cheaper direction: harmless, but it costs coverage in CI for nothing.
  it('no file is named *.live.test.* without reaching the database', () => {
    const overLabelled = testFiles
      .filter(f => isLive(f) && !reachesDatabase(f))
      .map(f => path.relative(ROOT, f))
    expect(overLabelled,
      `These are named live but reach no database, so they sit out of the blocking ` +
      `tier for nothing:\n  ` + overLabelled.join('\n  '),
    ).toEqual([])
  })
})
