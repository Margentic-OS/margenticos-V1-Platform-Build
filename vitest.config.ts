import { defineConfig } from 'vitest/config'
import path from 'path'
import fs from 'fs'

// ═══════════════════════════════════════════════════════════════════════════
// THE TEST DATABASE CREDENTIALS, LOADED HERE SO `npm test` MEANS ONE THING
//
// The seven database integration files read TEST_SUPABASE_URL and
// TEST_SUPABASE_SERVICE_ROLE_KEY. Those live in .env.test.local, which is
// gitignored, and nothing loaded it. So `npm test` and
// `npx dotenv -e .env.test.local -- npx vitest run` ran DIFFERENT SUITES from
// the same repository and neither invocation said so.
//
// Measured on this commit's parent: the plain command exited 1 with 11 failures
// and 35 skipped; the wrapped command exited 0 with 2 skipped. The 11 were not
// the interesting part. The 33 tests that quietly moved into "skipped" were: a
// suite reporting 2449 passed and skipping its cross-organisation boundary
// checks looks far healthier than one that fails, and those are exactly the
// tests that must never be quietly absent.
//
// Reading the file here rather than requiring the dotenv wrapper makes the
// plain command correct, and leaves the wrapped command working unchanged:
// anything already in process.env wins, so the wrapper still takes precedence.
//
// NOTHING SECRET IS IN THIS FILE. It is read from a gitignored path at run
// time. The repository is public and the rule above still stands.
//
// This does NOT weaken the production guard. vitest.setup.ts deletes
// NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from process.env
// before any test file is imported, and test-database.ts allowlists the one
// non-production project ref. Only the two TEST_ keys are read here, by name.
// A .env.test.local that also held production credentials could not smuggle
// them through: they are not in this list.

const TEST_DATABASE_KEYS = ['TEST_SUPABASE_URL', 'TEST_SUPABASE_SERVICE_ROLE_KEY'] as const
const TEST_ENV_FILE = '.env.test.local'

const THE_COMMAND = 'npx dotenv -e .env.test.local -- npx vitest run'

/**
 * Read only the named keys out of the env file. Deliberately a few lines rather
 * than a dotenv dependency: the file is two assignments, and `dotenv` is not a
 * direct devDependency here, only a transitive one under dotenv-cli.
 */
function readTestEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const [, key, rawValue] = match
    if (!(TEST_DATABASE_KEYS as readonly string[]).includes(key)) continue
    out[key] = rawValue.trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
  }
  return out
}

/**
 * Resolve the two test-database keys, or fail NOW with the command to run.
 *
 * Failing at config load is the point. The old behaviour was 11 identical
 * throws arriving 30 seconds in, one per test file, interleaved with 2449
 * passes, each naming the fix in a stack trace nobody reads to the end.
 */
function resolveTestDatabaseEnv(): Record<string, string> {
  const fromFile = fs.existsSync(TEST_ENV_FILE) ? readTestEnvFile(TEST_ENV_FILE) : {}

  const resolved: Record<string, string> = {}
  for (const key of TEST_DATABASE_KEYS) {
    // process.env first: the dotenv wrapper, or an exported shell variable,
    // must keep overriding the file.
    const value = process.env[key] ?? fromFile[key]
    if (value) resolved[key] = value
  }

  const missing = TEST_DATABASE_KEYS.filter(key => !resolved[key])
  if (missing.length > 0) {
    throw new Error(
      `\n[vitest.config] Cannot run the suite: missing ${missing.join(', ')}.\n\n` +
        `  Seven test files talk to a real database, and it must NOT be production.\n` +
        `  Put the credentials in ${TEST_ENV_FILE} (gitignored, never committed).\n\n` +
        `  This config reads that file automatically, so plain \`npm test\` works once\n` +
        `  it exists. To pass them some other way instead:\n\n` +
        `      ${THE_COMMAND}\n\n` +
        `  See docs/testing-database.md.\n` +
        `  Failing here is correct. Running the other 2449 tests and reporting the\n` +
        `  database ones as "skipped" is what this replaces.\n`,
    )
  }

  return resolved
}

const testDatabaseEnv = resolveTestDatabaseEnv()

export default defineConfig({
  test: {
    environment: 'node',

    // Runs before EVERY test file. Strips production Supabase credentials from
    // process.env so no test can reach the live database, whatever the caller
    // exported or loaded with `dotenv -e .env.local`. See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],

    // PINNED, NOT INHERITED. These are vitest 4's current defaults, and the
    // isolation this suite's safety depends on is a property of them rather than
    // of anything we wrote. Stated explicitly so that turning them off — which is
    // the obvious speed knob for a 122-file suite — is a visible decision with
    // this comment attached, instead of a one-word config change.
    //
    // With isolate: false or pool: 'threads', every file in a worker shares one
    // process.env. The two module-scope dotenv.config() callers described in
    // vitest.setup.ts would then load .env.local into the SAME environment as the
    // database integration files. The poisoning in vitest.setup.ts is what makes
    // that survivable; this pinning is the second layer.
    pool: 'forks',
    isolate: true,

    // ═══════════════════════════════════════════════════════════════════════
    // TEST-ONLY ENVIRONMENT. READ THE SECOND HALF OF THIS COMMENT BEFORE
    // ADDING ANYTHING HERE.
    //
    // WHY THIS EXISTS. src/lib/email/client.ts throws at MODULE SCOPE when
    // RESEND_API_KEY is unset:
    //
    //     if (!process.env.RESEND_API_KEY) {
    //       throw new Error('RESEND_API_KEY is required but not set.')
    //     }
    //
    // Any test file whose import graph reaches that module therefore fails to
    // IMPORT, and a file that fails to import reports no test count at all. So
    // 36 tests were invisible rather than red: the suite said "1679 passed, 4
    // failed" and looked healthy while 30 Calendly webhook tests and 6
    // auto-approve tests had never executed a single assertion.
    //
    // Those 36 need no database and no network. They already mock their
    // senders. They failed on the presence of a string.
    //
    // ── THE VALUE IS DELIBERATELY NOT A PLAUSIBLE KEY ──
    //
    // No `re_` prefix, which is the real Resend format. If this ever escaped a
    // test process, Resend would reject it as malformed rather than authenticate
    // as somebody. A test fixture that could work against a real account is not
    // a test fixture.
    //
    // ═══════════════════════════════════════════════════════════════════════
    // WHAT MUST NOT BE ADDED HERE, AND WHY
    //
    // NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ARE MISSING ON
    // PURPOSE. DO NOT ADD THEM.
    //
    // Adding them would not "fix" the remaining 38 blocked tests. It would point
    // them at the ONLY DATABASE THIS PROJECT HAS, which is production. Those
    // tests INSERT and DELETE prospects, campaigns and organisations: 27 of them
    // write, and handleUploadLeads.compliance.test.ts alone issues 3 deletes and
    // 6 inserts. Running them against production would destroy live client data
    // in the course of proving the code is safe.
    //
    // ── RESOLVED 2026-08-27. THE DECISION THIS PARAGRAPH WAS WAITING ON ──
    //
    // The paragraph above used to end "the 38 stay blocked until they have a
    // database that is not production, and the decision is open". They now have
    // one: Supabase project tidqheqjzvwmrrrebzir, free plan, eu-west-1, restored
    // from supabase/baseline/schema.sql with a verified catalog match against
    // production. It holds schema and no client data.
    //
    // The seven integration files now read TEST_SUPABASE_URL and
    // TEST_SUPABASE_SERVICE_ROLE_KEY through src/test-utils/test-database.ts,
    // which allowlists that one project ref plus a local stack and refuses
    // everything else, production loudest of all.
    //
    // NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are STILL absent
    // here, and the instruction above still stands. It is now enforced rather
    // than merely written down: vitest.setup.ts DELETES both from process.env
    // before any test file is imported, so adding them here, exporting them in a
    // shell, or running `dotenv -e .env.local -- vitest` no longer reaches the
    // live database.
    //
    // Credentials live in .env.test.local, which is gitignored. This repository
    // is PUBLIC; nothing secret belongs in this file. See docs/testing-database.md.
    //
    // ANTHROPIC_API_KEY, APOLLO_API_KEY and BRAVE_SEARCH_API_KEY are also absent
    // on purpose. Those throws are all INSIDE functions rather than at module
    // scope, so they block no imports, and supplying them would let a stray test
    // spend real money.
    env: {
      RESEND_API_KEY: 'FAKE-TEST-KEY-NOT-A-REAL-RESEND-KEY-DO-NOT-USE',

      // TEST_SUPABASE_URL and TEST_SUPABASE_SERVICE_ROLE_KEY, read from
      // .env.test.local at the top of this file. Not literals, and not the
      // production pair the block above refuses. See resolveTestDatabaseEnv.
      ...testDatabaseEnv,
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
