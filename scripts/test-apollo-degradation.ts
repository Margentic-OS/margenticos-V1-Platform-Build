// Apollo graceful degradation test script.
// Verifies each error branch in fetchApolloSource using stored fixtures.
// Run with: npx tsx scripts/test-apollo-degradation.ts
//
// No vitest required — uses global.fetch override and manual assertion.
// For contract tests against the real Apollo API, use the verification harness at
// docs/prompts/subscription-activation-verification.md (checks A-1 through A-5).

import error401 from '../src/lib/integrations/handlers/apollo/__fixtures__/error-401.json'
import error403 from '../src/lib/integrations/handlers/apollo/__fixtures__/error-403.json'
import error429 from '../src/lib/integrations/handlers/apollo/__fixtures__/error-429.json'
import peopleMatchSuccess from '../src/lib/integrations/handlers/apollo/__fixtures__/people-match-success.json'

// Minimal prospect context for test calls
const TEST_PROSPECT = {
  id: 'test-id',
  organisation_id: 'test-org',
  segment_id: null,
  first_name: 'Jane',
  last_name: 'Smith',
  company_name: 'Test Co',
  role: 'Founder',
  email: 'jane@test.com',
  linkedin_url: null,
  website_url: null,
}

// Set a dummy API key so the early-exit guard doesn't trigger
process.env.APOLLO_API_KEY = 'test-key-for-degradation-tests'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  PASS: ${label}`)
    passed++
  } else {
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

function mockFetch(status: number, body: object, headers: Record<string, string> = {}): void {
  global.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    }) as unknown as Response
}

async function run(): Promise<void> {
  // Dynamic import so env var is set before the module loads
  const { fetchApolloSource } = await import('../src/lib/agents/research/sources/apollo')

  // ── 401: credential issue ─────────────────────────────────────────────────
  console.log('\n[401] Credential issue')
  mockFetch(401, error401)
  {
    const result = await fetchApolloSource(TEST_PROSPECT)
    assert(result.available === false, 'available is false')
    assert(result.error?.includes('401') ?? false, 'error mentions 401', result.error)
    assert(result.formatted === null, 'formatted is null')
  }

  // ── 403: free tier / insufficient scope ───────────────────────────────────
  console.log('\n[403] Access denied')
  mockFetch(403, error403)
  {
    const result = await fetchApolloSource(TEST_PROSPECT)
    assert(result.available === false, 'available is false')
    assert(result.error?.includes('403') ?? false, 'error mentions 403', result.error)
    assert(result.formatted === null, 'formatted is null')
  }

  // ── 429: rate limited with Retry-After header ─────────────────────────────
  console.log('\n[429] Rate limited (with Retry-After: 60)')
  mockFetch(429, error429, { 'Retry-After': '60' })
  {
    const result = await fetchApolloSource(TEST_PROSPECT)
    assert(result.available === false, 'available is false')
    assert(result.error?.includes('429') ?? false, 'error mentions 429', result.error)
    assert(result.error?.includes('60') ?? false, 'error includes retry-after value', result.error)
    assert(result.formatted === null, 'formatted is null')
  }

  // ── 429: rate limited without Retry-After header ──────────────────────────
  console.log('\n[429] Rate limited (no Retry-After header)')
  mockFetch(429, error429)
  {
    const result = await fetchApolloSource(TEST_PROSPECT)
    assert(result.available === false, 'available is false')
    assert(result.error?.includes('429') ?? false, 'error mentions 429', result.error)
    assert(result.formatted === null, 'formatted is null')
  }

  // ── 500: transient outage ─────────────────────────────────────────────────
  console.log('\n[500] Transient outage')
  mockFetch(500, { error: 'internal_server_error', message: 'Unexpected server error.' })
  {
    const result = await fetchApolloSource(TEST_PROSPECT)
    assert(result.available === false, 'available is false')
    assert(result.error?.includes('500') ?? false, 'error mentions 500', result.error)
    assert(result.formatted === null, 'formatted is null')
  }

  // ── 503: transient outage (another 5xx) ───────────────────────────────────
  console.log('\n[503] Service unavailable')
  mockFetch(503, { error: 'service_unavailable', message: 'Service temporarily unavailable.' })
  {
    const result = await fetchApolloSource(TEST_PROSPECT)
    assert(result.available === false, 'available is false')
    assert(result.error?.includes('503') ?? false, 'error mentions 503', result.error)
    assert(result.formatted === null, 'formatted is null')
  }

  // ── 200: successful response ──────────────────────────────────────────────
  console.log('\n[200] Successful match')
  mockFetch(200, peopleMatchSuccess)
  {
    const result = await fetchApolloSource(TEST_PROSPECT)
    assert(result.available === true, 'available is true')
    assert(result.formatted !== null, 'formatted is non-null')
    assert(typeof result.formatted === 'string' && result.formatted.length > 0, 'formatted has content')
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('FAILED — see above for details')
    process.exit(1)
  } else {
    console.log('All checks passed')
  }
}

run().catch((err) => {
  console.error('Test script threw unexpectedly:', err)
  process.exit(1)
})
