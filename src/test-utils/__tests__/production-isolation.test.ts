// Structural guard: no test file may build a database client from the production
// environment variables.
//
// The seven integration files were fixed by hand. Nothing stops the eighth being
// written the same way, by copying an existing file, which is exactly how the
// pattern spread to seven in the first place. Vigilance is not a control; this is.
//
// This scans the source tree rather than asserting on behaviour, because the
// failure it prevents has no runtime signature: a test that reads
// NEXT_PUBLIC_SUPABASE_URL passes perfectly well, it just passes against the
// wrong database.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import dotenv from 'dotenv'
import {
  projectRefFromUrl,
  assertTestDatabase,
  TEST_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
} from '../test-database'

const SRC = path.resolve(__dirname, '../..')

// The only files permitted to read production credentials. Both are opt-in,
// read-only diagnostics that report on live data and write nothing:
//   eligibility-against-live-data  SELECTs prospects, gated on RUN_ELIGIBILITY_REPORT
//   cache-receipt                  calls Anthropic, touches no database at all
//
// An earlier version of this comment said "Both still require
// ALLOW_PRODUCTION_DB_ACCESS, because vitest.setup.ts strips the variables
// otherwise." THAT WAS FALSE, and it is worth leaving the correction here rather
// than quietly editing it, because the false version was load-bearing reassurance.
// Both files call dotenv.config() at module scope, which runs on every collection
// regardless of their runIf gate, and dotenv REFILLS keys that are absent. The
// override flag governs only whether setup interferes; it never stopped dotenv.
// vitest.setup.ts now assigns a poison value instead of deleting, which is what
// actually closes it: dotenv will not overwrite a key that is already set.
//
// Adding to this list should feel like a decision.
const ALLOWLIST = new Set([
  'lib/sourcing/__tests__/eligibility-against-live-data.test.ts',
  'lib/agents/research/__tests__/cache-receipt.test.ts',
])

// Longest alternatives first so NEXT_PUBLIC_SUPABASE_URL is never partially
// matched as SUPABASE_URL. SUPABASE_URL is its own variable, not an alias, and
// leaving it out is how the eighth offender stayed hidden.
const PRODUCTION_VARS =
  '(?:NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_URL)'

/**
 * Finds READS of the production env vars, not writes.
 *
 * The distinction matters and the first version of this test missed it. Ten
 * mocked unit tests ASSIGN fake values to these variables
 * (`process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'`) so that
 * module-scope code does not throw, then delete them again. That is safe and
 * normal. A naive match on the variable name flags all ten, and a guard that
 * cries wolf ten times gets its allowlist stuffed until it protects nothing.
 *
 * Only a READ can connect to a database, so only a read is a finding.
 */
function findProductionReads(source: string): string[] {
  const hits: string[] = []
  const re = new RegExp(`(delete\\s+)?process\\.env\\.${PRODUCTION_VARS}\\s*(={1,3})?`, 'g')
  for (const m of source.matchAll(re)) {
    const [full, isDelete, equals] = m
    if (isDelete) continue                    // `delete process.env.X` — removal, not a read
    if (equals === '=') continue              // `process.env.X = '...'` — assignment, not a read
    hits.push(full.trim())                    // bare read, or a comparison such as `=== undefined`
  }
  return hits
}

function testFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      testFiles(full, acc)
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      // This file quotes the forbidden variable names in its own fixtures, so it
      // would flag itself forever. Excluded by path rather than allowlisted, so a
      // real offender can never hide behind the same exemption.
      if (full !== __filename) acc.push(full)
    }
  }
  return acc
}

describe('production isolation', () => {
  const files = testFiles(SRC)

  // Guards itself. A broken scan that finds nothing would otherwise pass forever,
  // which is the same shape of defect this whole file exists to prevent.
  it('finds a plausible number of test files to scan', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('no test file reads production Supabase credentials', () => {
    const offenders = files
      .filter(f => findProductionReads(fs.readFileSync(f, 'utf8')).length > 0)
      .map(f => path.relative(SRC, f))
      .filter(rel => !ALLOWLIST.has(rel))

    expect(
      offenders,
      `These test files read production credentials directly. Use ` +
        `createTestServiceClient() from src/test-utils/test-database.ts instead:\n  ` +
        offenders.join('\n  '),
    ).toEqual([])
  })

  // findProductionReads now carries logic, so it gets its own tests. An
  // over-broad version floods the report and gets allowlisted into uselessness;
  // an over-narrow one silently stops finding anything. Both fail here.
  it('distinguishes reads from writes and deletes', () => {
    expect(findProductionReads(`const u = process.env.NEXT_PUBLIC_SUPABASE_URL`)).toHaveLength(1)
    expect(findProductionReads(`createClient(process.env.SUPABASE_SERVICE_ROLE_KEY!, x)`)).toHaveLength(1)

    expect(findProductionReads(`process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'`)).toHaveLength(0)
    expect(findProductionReads(`  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'`)).toHaveLength(0)
    expect(findProductionReads(`delete process.env.NEXT_PUBLIC_SUPABASE_URL`)).toHaveLength(0)

    // A comparison reads the value, so it counts.
    expect(findProductionReads(`if (process.env.NEXT_PUBLIC_SUPABASE_URL === undefined) {}`)).toHaveLength(1)

    // Unrelated variables are not this guard's business.
    expect(findProductionReads(`const k = process.env.TEST_SUPABASE_URL`)).toHaveLength(0)
  })

  it('every allowlisted file still exists', () => {
    // A stale allowlist entry silently widens the exemption for a path that a
    // future file could reoccupy.
    for (const rel of ALLOWLIST) {
      expect(fs.existsSync(path.join(SRC, rel)), `${rel} is allowlisted but missing`).toBe(true)
    }
  })
})

// Encodes the reason vitest.setup.ts POISONS rather than DELETES. If someone
// "simplifies" it back to `delete process.env[key]`, the second case here goes red
// and says why. Without this, that change looks like a tidy-up and reopens the hole.
describe('poisoning, not deleting, is what blocks a dotenv refill', () => {
  const VAR = 'ISOLATION_PROBE_VAR_NOT_USED_ELSEWHERE'
  const envFile = path.join(os.tmpdir(), `isolation-probe-${process.pid}.env`)

  beforeAll(() => fs.writeFileSync(envFile, `${VAR}=value-from-dotenv-file\n`))
  afterAll(() => { fs.rmSync(envFile, { force: true }); delete process.env[VAR] })

  it('dotenv does NOT overwrite a variable that is already set', () => {
    process.env[VAR] = 'poison-value'
    dotenv.config({ path: envFile })
    expect(process.env[VAR]).toBe('poison-value')
  })

  it('dotenv DOES fill a variable that has been deleted — the hole poisoning closes', () => {
    delete process.env[VAR]
    dotenv.config({ path: envFile })
    expect(process.env[VAR]).toBe('value-from-dotenv-file')
  })
})

describe('assertTestDatabase', () => {
  it('refuses the production project ref by name', () => {
    expect(() =>
      assertTestDatabase(`https://${PRODUCTION_PROJECT_REF}.supabase.co`, 'unit'),
    ).toThrow(/REFUSING TO RUN AGAINST PRODUCTION/)
  })

  it('accepts the designated test project', () => {
    expect(() =>
      assertTestDatabase(`https://${TEST_PROJECT_REF}.supabase.co`, 'unit'),
    ).not.toThrow()
  })

  it('accepts a local Supabase stack', () => {
    expect(() => assertTestDatabase('http://localhost:54321', 'unit')).not.toThrow()
    expect(() => assertTestDatabase('http://127.0.0.1:54321', 'unit')).not.toThrow()
  })

  // The allowlist is the point: an unknown ref is refused even though it is
  // neither production nor the test project. A denylist would let this through.
  it('refuses an unknown project ref that is neither production nor test', () => {
    expect(() =>
      assertTestDatabase('https://abcdefghijklmnopqrst.supabase.co', 'unit'),
    ).toThrow(/refusing an unrecognised database/)
  })

  it('refuses an empty or malformed URL', () => {
    expect(() => assertTestDatabase('', 'unit')).toThrow(/database URL is empty/)
    expect(() => assertTestDatabase('not-a-url', 'unit')).toThrow(/refusing an unrecognised database/)
  })

  it('parses project refs and returns null for local hosts', () => {
    expect(projectRefFromUrl(`https://${TEST_PROJECT_REF}.supabase.co`)).toBe(TEST_PROJECT_REF)
    expect(projectRefFromUrl('http://localhost:54321')).toBeNull()
  })
})
