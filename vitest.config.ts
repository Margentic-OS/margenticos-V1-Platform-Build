import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',

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
    // The 38 stay blocked until they have a database that is not production.
    // Options were costed on 2026-08-26 (Supabase branch at $0.01344/hour, a
    // second project at $0/month, local Docker) and the decision is open. Until
    // it is made, blocked is the correct state and is safer than green.
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
