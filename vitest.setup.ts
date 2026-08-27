// Runs before EVERY test file. Its whole job is to make production unreachable.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY A SETUP FILE AND NOT JUST THE HELPER
//
// src/test-utils/test-database.ts refuses a non-test database at the moment a
// client is constructed. That protects every test that goes through the helper,
// which is all seven integration files.
//
// It does NOT protect against a test file that ignores the helper and builds its
// own client from NEXT_PUBLIC_SUPABASE_URL, which is precisely what all seven did
// before this change and what a new file would do by copying an old pattern.
//
// So this file removes the production credentials from the environment entirely,
// before any test module is imported. After this runs, a test that reaches for
// NEXT_PUBLIC_SUPABASE_URL finds undefined and fails loudly at client
// construction, rather than silently connecting to the live database.
//
// The two controls are deliberately different in kind. The helper is a check on a
// value. This is the removal of the value. A check can be bypassed by not calling
// it; a variable that is not there cannot be read by anyone.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE VECTOR THIS CLOSES
//
// A plain `vitest run` never loaded .env, so it was never the problem. The
// documented invocation in those files' own headers was:
//
//     npx dotenv -e .env.local -- npx vitest run <file>
//
// which puts live credentials into process.env before vitest starts. That command
// is now safe: the variables are stripped here before any test sees them.

import { assertTestDatabase } from '@/test-utils/test-database'

// Deliberately awkward to type, so it cannot be set casually or by muscle memory.
const OVERRIDE_KEY = 'ALLOW_PRODUCTION_DB_ACCESS'
const OVERRIDE_VALUE = 'i-understand-this-can-write-to-production'

const PRODUCTION_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  // SUPABASE_URL is a SEPARATE variable, not a prefix-less alias, and missing it
  // would have left a hole. get-client-visible-campaign-metrics.test.ts read this
  // one rather than the NEXT_PUBLIC_ name, and it inserts organisations.
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
]

const overridden = process.env[OVERRIDE_KEY] === OVERRIDE_VALUE

// ═══════════════════════════════════════════════════════════════════════════
// POISON, DO NOT DELETE. THIS IS THE WHOLE TRICK.
//
// The obvious implementation is `delete process.env[key]`, and it is WRONG here
// in a way that is worse than doing nothing, because it hands the value back.
//
// Two test files call dotenv at MODULE SCOPE:
//   src/lib/sourcing/__tests__/eligibility-against-live-data.test.ts:21
//   src/lib/agents/research/__tests__/cache-receipt.test.ts:24
//     dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })
//
// Both are gated by describe.runIf(...), but runIf is evaluated at COLLECTION,
// which requires the module body to execute first. So that dotenv.config() call
// runs on EVERY ordinary `vitest run`, opt-in flag set or not.
//
// dotenv.config() without `override: true` does not overwrite keys that are set.
// It fills in keys that are ABSENT. Deleting the four variables makes them
// absent, so dotenv immediately puts them back, WITH PRODUCTION VALUES, in that
// worker. The deletion does not merely fail to protect: it creates the vacuum.
//
// Assigning a value instead means the keys are present, so dotenv leaves them
// alone. The value is an unusable .invalid host, so anything that reads one
// fails fast with a name that says where it came from.
const POISON_URL = 'https://production-access-blocked-by-vitest-setup.invalid'
const POISON_KEY = 'BLOCKED-BY-VITEST-SETUP-NOT-A-REAL-KEY'

if (!overridden) {
  for (const key of PRODUCTION_VARS) {
    process.env[key] = key.endsWith('_URL') ? POISON_URL : POISON_KEY
  }
} else {
  // The escape hatch exists for the two opt-in, read-only diagnostics that
  // legitimately report on live data (RUN_ELIGIBILITY_REPORT, RUN_CACHE_PROBE).
  // It is loud on purpose: if this line is in the output of an ordinary run,
  // something is wrong.
  console.warn(
    `[vitest.setup] ${OVERRIDE_KEY} is set. Production credentials are NOT stripped ` +
      `for this run. Only the opt-in read-only diagnostics should ever need this.`,
  )
}

// Whatever TEST_SUPABASE_URL names, it must be an allowlisted test database.
// Checked here as well as in the helper so a wrong value fails at startup with a
// clear message, rather than midway through a suite inside somebody's beforeAll.
if (process.env.TEST_SUPABASE_URL) {
  assertTestDatabase(process.env.TEST_SUPABASE_URL, 'vitest.setup (TEST_SUPABASE_URL)')
}
