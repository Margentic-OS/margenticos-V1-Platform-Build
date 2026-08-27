// The only sanctioned way for a test to obtain a database client.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// Seven integration test files built a SERVICE-ROLE client straight from
// NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY and then INSERTed. A
// service-role key bypasses RLS entirely, so whatever project those variables
// happened to name was fully writable by the suite.
//
// On this machine those variables name PRODUCTION. On 2026-08-09 that is exactly
// what happened: monitor-acknowledge.test.ts inserts an organisation called
// 'Archived Test Active' with slug `archived-test-active-${Date.now()}`, and eight
// such organisations were still sitting in the production database on 2026-08-27,
// their slug timestamps decoding to their own created_at values to the second.
// They survived because cleanup only runs when a test COMPLETES: an interrupted
// run strands its rows.
//
// The pollution vector was never a plain `vitest run`. Vitest does not load .env.
// It was the invocation those files documented in their own headers:
//
//     npx dotenv -e .env.local -- npx vitest run <file>
//
// which loads production credentials into process.env before vitest starts.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE RULE: AN ALLOWLIST, NOT A DENYLIST
//
// It would be easier to refuse the one production ref we know about. That is the
// weaker control, and it fails in the direction that costs money: a SECOND
// production project, a restored clone, or a typo'd ref would all sail through a
// denylist because none of them is the string being denied.
//
// So the permitted set is closed. A test database must be either:
//   - the dedicated test project ref, or
//   - a local Supabase stack on localhost / 127.0.0.1
//
// Anything else is refused, including production, including a ref nobody has
// thought of yet. Widening this set is a deliberate edit to this constant, which
// is the point.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

/** Supabase project ref of the dedicated integration-test database. Holds schema, no client data. */
export const TEST_PROJECT_REF = 'tidqheqjzvwmrrrebzir'

/**
 * Production project ref. Named ONLY so the refusal message can say "this is
 * production" instead of "this is not allowed". The allowlist above is what
 * actually does the blocking; removing this constant would not weaken it.
 */
export const PRODUCTION_PROJECT_REF = 'hjpvnvjryxdjcfdsfhzy'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Extracts the Supabase project ref from a URL, or null for a local stack / unparseable input. */
export function projectRefFromUrl(rawUrl: string): string | null {
  let host: string
  try {
    host = new URL(rawUrl).hostname
  } catch {
    return null
  }
  if (LOCAL_HOSTS.has(host)) return null
  const match = host.match(/^([a-z0-9]{20})\.supabase\.(co|in)$/i)
  return match ? match[1].toLowerCase() : null
}

function isLocalStack(rawUrl: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(rawUrl).hostname)
  } catch {
    return false
  }
}

/**
 * Throws unless `url` names a database the test suite is permitted to touch.
 *
 * `context` is included in the message so a failure names the caller rather than
 * this module. Exported because vitest.setup.ts applies the same rule to the
 * ambient environment before any test file is imported.
 */
export function assertTestDatabase(url: string, context: string): void {
  if (!url || !url.trim()) {
    throw new Error(
      `[test-database] ${context}: database URL is empty. ` +
        `Set TEST_SUPABASE_URL. There is no fallback, by design.`,
    )
  }

  if (isLocalStack(url)) return

  const ref = projectRefFromUrl(url)

  if (ref === PRODUCTION_PROJECT_REF) {
    throw new Error(
      `[test-database] ${context}: REFUSING TO RUN AGAINST PRODUCTION.\n` +
        `  The URL names project ${PRODUCTION_PROJECT_REF}, which is the live database.\n` +
        `  These tests INSERT and DELETE with a service-role key, which bypasses RLS.\n` +
        `  Point TEST_SUPABASE_URL at the test project (${TEST_PROJECT_REF}) instead.`,
    )
  }

  if (ref !== TEST_PROJECT_REF) {
    throw new Error(
      `[test-database] ${context}: refusing an unrecognised database.\n` +
        `  Project ref: ${ref ?? '(could not parse a Supabase ref from the URL)'}\n` +
        `  Permitted: the test project ${TEST_PROJECT_REF}, or a local stack on localhost.\n` +
        `  This is an allowlist. If you genuinely added a new test database, add its ref\n` +
        `  to TEST_PROJECT_REF in src/test-utils/test-database.ts deliberately.`,
    )
  }
}

/** Reads the test-database credentials, failing loudly rather than falling back to anything. */
export function requireTestDatabaseCredentials(context: string): { url: string; serviceRoleKey: string } {
  const url = process.env.TEST_SUPABASE_URL
  const serviceRoleKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY

  // Deliberately NOT falling back to NEXT_PUBLIC_SUPABASE_URL. A fallback is how
  // this suite reached production in the first place: the variable that happened
  // to be set was the live one.
  if (!url || !serviceRoleKey) {
    const missing = [
      !url && 'TEST_SUPABASE_URL',
      !serviceRoleKey && 'TEST_SUPABASE_SERVICE_ROLE_KEY',
    ].filter(Boolean).join(', ')

    throw new Error(
      `[test-database] ${context}: missing ${missing}.\n` +
        `  These integration tests need a database that is NOT production.\n` +
        `  Put the credentials in .env.test.local (gitignored, never committed) and run:\n` +
        `      npx dotenv -e .env.test.local -- npx vitest run\n` +
        `  See docs/testing-database.md. Failing here is correct; falling back is not.`,
    )
  }

  assertTestDatabase(url, context)
  return { url, serviceRoleKey }
}

// REMOVED: hasTestDatabase(), which returned true/false "so a suite can skip
// rather than fail". It had zero callers, and it pointed the wrong way. A suite
// that skips on missing configuration is the exact defect documented in BACKLOG
// under "a test that degrades to a no-op on missing config is asserting nothing":
// it reports green while proving nothing. These tests must FAIL when they cannot
// reach a database. Exporting a helper that makes skipping easy is an invitation
// to reintroduce the thing this module exists to prevent.

/**
 * Points modules that build their OWN client at the test database.
 *
 * Some production modules deliberately construct a service-role client internally
 * rather than accepting one, so a caller cannot hand them a session client by
 * mistake. getClientVisibleReplies, getOperatorRepliesForOrg and
 * getClientVisibleCampaignMetrics all do this, and all three read
 * NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, throwing if the key is
 * absent.
 *
 * vitest.setup.ts deletes exactly those variables. That is correct and is the
 * whole point, but it means a test seeding fixtures through the test client while
 * calling one of those functions would fail with
 * "getClientVisibleReplies: SUPABASE_SERVICE_ROLE_KEY is not set".
 *
 * So a test that exercises one of those functions must re-populate the names they
 * read, pointed at the TEST database. Writing the production variable NAMES is
 * safe here precisely because the VALUES are the test project's, and
 * requireTestDatabaseCredentials has already refused anything else.
 *
 * Call this only from a test that invokes such a function, and only after
 * createTestServiceClient has validated the target.
 */
export function bridgeEnvForSelfClientingModules(context: string): void {
  const { url, serviceRoleKey } = requireTestDatabaseCredentials(context)
  process.env.NEXT_PUBLIC_SUPABASE_URL = url
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey
}

/**
 * Builds the service-role client the integration tests use.
 *
 * Validates on EVERY call rather than once at module load, because the two opt-in
 * tests that call dotenv.config() themselves mutate process.env after setup has
 * already run. Checking at construction time is the only moment guaranteed to see
 * the values the client will actually be built from.
 */
export function createTestServiceClient(context: string): SupabaseClient<Database> {
  const { url, serviceRoleKey } = requireTestDatabaseCredentials(context)
  return createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
