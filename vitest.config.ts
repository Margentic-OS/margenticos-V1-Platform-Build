import { defineConfig } from 'vitest/config'
import path from 'path'

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
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
