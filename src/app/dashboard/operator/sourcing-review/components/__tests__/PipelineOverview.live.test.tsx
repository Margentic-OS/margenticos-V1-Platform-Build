// @vitest-environment jsdom
//
// THE PROOF THAT THE SCREEN FOLLOWS THE DATABASE.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IS REAL HERE, AND WHAT IS NOT. READ THIS BEFORE TRUSTING THE TEST.
//
// The defect was that the page rendered a snapshot and never looked again, so a test whose
// fetch returns canned JSON would prove the canned JSON and nothing else. It would pass
// against a component that re-read a hard-coded object on a timer.
//
// So the fetch here is NOT a stub returning a fixture. It calls getSourcingMetrics against
// the REAL integration database, the same function the route calls, and the test CHANGES
// ROWS IN THAT DATABASE between polls. What is asserted is that numbers written by an
// UPDATE statement appear on screen without the component being re-rendered by the test.
//
//   REAL:  the metrics function, the SQL counts, the database round trip, the poll
//          handler, React's re-render, and the numbers the operator would read.
//   NOT:   the HTTP layer and its operator auth gate. Those are asserted separately by
//          middleware-scope.test.ts and by requireOperator's own callers. A jsdom test
//          cannot issue a cookie-bearing request to a Next route handler, and pretending
//          otherwise would be the same class of dishonesty as mocking the fetch.
//
// THE TICK IS DRIVEN BY visibilitychange, NOT BY FAKE TIMERS. The component polls on an
// interval AND immediately when the tab becomes visible, and both go through the same
// fetchMetrics. Driving the visible path keeps the test deterministic and free of the
// fake-timer-versus-real-network race that would otherwise make it flaky. The interval
// itself is asserted structurally in the last test in this file, which is a weaker claim
// and is labelled as one.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/app/dashboard/operator/sourcing-review/components/__tests__/PipelineOverview.live.test.tsx

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { fetch as undiciFetch } from 'undici'
import type { Database } from '@/types/database'
import { requireTestDatabaseCredentials } from '@/test-utils/test-database'
import { getMetricsForOrganisations, type PipelineMetrics } from '@/lib/operator/sourcing-metrics'
import { PipelineOverview } from '../PipelineOverview'

// ── WHY THIS FILE BUILDS ITS OWN CLIENT INSTEAD OF CALLING createTestServiceClient ──
//
// MEASURED, not assumed. Inside vitest's jsdom environment a bare
// `fetch('https://<test-project>.supabase.co/rest/v1/')` never resolves; it hangs until the
// test times out. Every other database test in this repo runs in the node environment and
// never meets this. undici, which is Node's own HTTP client, reaches the same URL normally
// under jsdom, verified the same way.
//
// Handing undici's fetch to supabase-js directly still hangs, because supabase-js passes a
// jsdom Headers instance and a Request-like first argument that undici does not accept. So
// the adapter below normalises both to plain values before the call. That was found by
// instrumenting the adapter rather than guessed at: with the normalisation in place the
// same query returns 200 with rows in under three seconds.
//
// THE SAFETY CONTROL IS UNCHANGED. requireTestDatabaseCredentials still runs and still
// refuses production and anything not on the allowlist. Only the transport differs.

// Routing only. The data path is deliberately NOT mocked; see the header.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

/**
 * supabase-js over undici, with the arguments normalised. See the note above.
 *
 * Deliberately forwards method, headers and body and nothing else: this is a transport
 * shim for a test, not a general fetch polyfill, and anything it silently dropped would be
 * a filter the test cannot see. Every write this file performs goes through it.
 */
async function undiciTransport(input: unknown, init: Record<string, unknown> = {}) {
  const anyInput = input as { url?: string; headers?: unknown }
  const url = typeof input === 'string' ? input : (anyInput?.url ?? String(input))

  const headers: Record<string, string> = {}
  const rawHeaders = (init?.headers ?? anyInput?.headers) as
    | { forEach?: (cb: (v: string, k: string) => void) => void }
    | Record<string, string>
    | undefined
  if (rawHeaders) {
    if (typeof (rawHeaders as { forEach?: unknown }).forEach === 'function') {
      (rawHeaders as { forEach: (cb: (v: string, k: string) => void) => void })
        .forEach((value, key) => { headers[key] = value })
    } else {
      Object.assign(headers, rawHeaders as Record<string, string>)
    }
  }

  const send = () => undiciFetch(url, {
    method: (init?.method as string) ?? 'GET',
    headers,
    body: init?.body as string | undefined,
  })

  // ── A STALLED REQUEST MUST FAIL LOUDLY, NOT EAT THE TIMEOUT ──
  //
  // Observed while building this: an occasional request to the shared free-tier test
  // project never settles at all. Without this the symptom is "hook timed out in 60000ms"
  // pointing at beforeAll, which says nothing about which call stalled and reads like the
  // code under test is broken.
  //
  // So each attempt is bounded and retried once. A genuine failure still fails; a stall
  // costs REQUEST_TIMEOUT_MS instead of the whole hook budget, and names itself.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await Promise.race([
        send(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`test transport: no response in ${REQUEST_TIMEOUT_MS}ms for ${init?.method ?? 'GET'} ${url}`)),
            REQUEST_TIMEOUT_MS,
          ),
        ),
      ])
      return response as unknown as Response
    } catch (err) {
      if (attempt === 2) throw err
    }
  }
  throw new Error('unreachable')
}

const REQUEST_TIMEOUT_MS = 15_000

/** Room for one real database round trip to complete inside act(). See pollNow. */
const POLL_SETTLE_MS = 3_000

const STAMP = Date.now()
const ORG_NAME = `Pipeline Poll Test ${STAMP}`

let supabase: SupabaseClient<Database>
let orgId: string
const prospectIds: string[] = []

/** Insert one prospect and remember its id for cleanup. */
async function seedProspect(fields: Record<string, unknown>): Promise<string> {
  const { data, error } = await supabase
    .from('prospects')
    .insert({ organisation_id: orgId, ...fields } as never)
    .select('id')
    .single()
  if (error || !data) throw new Error(`seed failed: ${error?.message}`)
  const id = (data as { id: string }).id
  prospectIds.push(id)
  return id
}

/**
 * The metrics for THIS test's organisation only.
 *
 * Scoped rather than filtered afterwards, and the reason is measured: the shared
 * integration database holds 439 active organisations left behind by other suites, so
 * asking for all of them is roughly four thousand round trips per poll and the test times
 * out before it can assert anything. getMetricsForOrganisations is the same code path
 * getSourcingMetrics uses; only the list of organisations differs.
 */
async function metricsForOrg(): Promise<PipelineMetrics[]> {
  return getMetricsForOrganisations(supabase, [{ id: orgId, name: ORG_NAME }])
}

beforeAll(async () => {
  const { url, serviceRoleKey } = requireTestDatabaseCredentials('PipelineOverview.live.test.tsx')
  supabase = createClient<Database>(url, serviceRoleKey, {
    global: { fetch: undiciTransport as unknown as typeof globalThis.fetch },
    // jsdom has no real storage and supabase's session refresh timer serves no purpose in
    // a service-role test. Off, so nothing is left running when the suite finishes.
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: org, error } = await supabase
    .from('organisations')
    .insert({
      name: ORG_NAME,
      slug: `pipeline-poll-test-${STAMP}`,
      founder_first_name: 'Test',
    } as never)
    .select('id')
    .single()
  if (error || !org) throw new Error(`could not create the test organisation: ${error?.message}`)
  orgId = (org as { id: string }).id

  // Three prospects awaiting approval. Nothing enriched, nothing tiered.
  await seedProspect({ sourcing_review_status: 'pending_review' })
  await seedProspect({ sourcing_review_status: 'pending_review' })
  await seedProspect({ sourcing_review_status: 'pending_review' })
}, 60_000)

afterAll(async () => {
  if (prospectIds.length > 0) {
    await supabase.from('prospects').delete().in('id', prospectIds)
  }
  if (orgId) {
    await supabase.from('organisations').delete().eq('id', orgId)
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/**
 * Point window.fetch at the real metrics function against the real test database.
 *
 * This is the seam that keeps the test honest. It replaces the network, not the query:
 * every call runs the SQL counts again and returns whatever the database says at that
 * instant. Counting calls proves the poll fired; the numbers prove it read the database.
 */
function stubFetchWithRealDatabaseReads(): { calls: () => number } {
  let calls = 0

  // The supabase client has its own undici transport (see the note above), so stubbing the
  // global here cannot starve the database reads. Anything else reaching this stub is a
  // request the test did not expect, and it should fail rather than be quietly served.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (!url.includes('/api/operator/sourcing-metrics')) {
      throw new Error(`unexpected fetch in this test: ${url}`)
    }
    calls += 1
    const metrics = await metricsForOrg()
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, metrics }),
    } as unknown as Response
  })
  return { calls: () => calls }
}

/** The failure stub, for the poll path only. */
function stubFetchFailing(status: number) {
  vi.stubGlobal('fetch', async () =>
    ({ ok: false, status, json: async () => ({ error: 'boom' }) }) as unknown as Response)
}

/**
 * Make the tab "become visible", which is one of the two paths into fetchMetrics.
 *
 * THE SETTLE IS NOT PADDING. The poll performs a real HTTP round trip to a remote
 * database, and the state update it produces lands after that. React's act environment
 * defers updates dispatched outside act, so without waiting INSIDE act the assertions run
 * against the pre-poll render and the test reports a working component as broken. Measured
 * while building this: the fetch was provably called and the DOM still showed the seed.
 */
async function pollNow() {
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise(resolve => setTimeout(resolve, POLL_SETTLE_MS))
  })
}

describe('PipelineOverview follows the database while the page is open', () => {
  it('shows a count written by an UPDATE, without being re-rendered', async () => {
    const seed = await metricsForOrg()
    expect(seed).toHaveLength(1)
    expect(seed[0].pending_review_count).toBe(3)

    const { calls } = stubFetchWithRealDatabaseReads()
    render(
      <PipelineOverview metrics={seed} selectedClientId={null} sourcingMaxBatchSize={500} />,
    )

    // The seeded first paint.
    await waitFor(() => expect(screen.getByText('Awaiting approval')).toBeInTheDocument())
    expect(screen.getByText('Awaiting approval').closest('div')!).toHaveTextContent('3')

    // ── CHANGE THE DATABASE WHILE THE PAGE IS OPEN ─────────────────────────
    //
    // Two of the three are approved, exactly as the approve screen would do it. The
    // component is not touched: no re-render, no new props, no state set by the test.
    await supabase
      .from('prospects')
      .update({ sourcing_review_status: 'approved' } as never)
      .in('id', prospectIds.slice(0, 2))

    await pollNow()

    // Awaiting approval fell to 1 and Enriching appeared at 2, both read off the database.
    // The poll definitely happened. Asserted separately from the numbers so a failure says
    // which half broke: no call means the listener never fired, a call with stale numbers
    // means the response was not applied.
    expect(calls()).toBe(1)

    await waitFor(() => {
      expect(screen.getByText('Awaiting approval')).toBeInTheDocument()
      expect(screen.getByText('Enriching')).toBeInTheDocument()
    })

    const awaitingCard = screen.getByText('Awaiting approval').closest('div')!
    const enrichingCard = screen.getByText('Enriching').closest('div')!
    expect(awaitingCard).toHaveTextContent('1')
    expect(enrichingCard).toHaveTextContent('2')

    // And the number the test asserted is the number the database holds. Without this the
    // test could pass against a component that decremented a counter locally.
    const afterUpdate = await metricsForOrg()
    expect(afterUpdate[0].pending_review_count).toBe(1)
    expect(afterUpdate[0].approved_unenriched_count).toBe(2)
  }, 60_000)

  it('follows a SECOND change, so the first was not a one-off re-render', async () => {
    const seed = await metricsForOrg()
    stubFetchWithRealDatabaseReads()
    render(
      <PipelineOverview metrics={seed} selectedClientId={null} sourcingMaxBatchSize={500} />,
    )

    await supabase
      .from('prospects')
      .update({ enrichment_status: 'enriched', sourced_tier: 'tier_1' } as never)
      .in('id', prospectIds.slice(0, 2))
    await pollNow()

    await waitFor(() => expect(screen.getByText('Tier 1')).toBeInTheDocument())
    expect(screen.getByText('Tier 1').closest('div')!).toHaveTextContent('2')

    await supabase
      .from('prospects')
      .update({ sourced_tier: 'tier_2' } as never)
      .in('id', prospectIds.slice(0, 1))
    await pollNow()

    await waitFor(() =>
      expect(screen.getByText('Tier 1').closest('div')!).toHaveTextContent('1'),
    )
    expect(screen.getByText('Tier 2').closest('div')!).toHaveTextContent('1')
  }, 60_000)

  it('a failed poll keeps the last good numbers and says so, rather than showing zeros', async () => {
    const seed = await metricsForOrg()
    const pending = seed[0].pending_review_count

    stubFetchFailing(500)

    render(
      <PipelineOverview metrics={seed} selectedClientId={null} sourcingMaxBatchSize={500} />,
    )
    await pollNow()

    // THE POINT OF THIS TEST. "0 awaiting approval" is how an operator reads "the work is
    // done". It must never be how they read "we could not look".
    await waitFor(() =>
      expect(screen.getByText(/Showing the last good figures/)).toBeInTheDocument(),
    )
    expect(screen.getByText('Awaiting approval').closest('div')!).toHaveTextContent(String(pending))
  }, 60_000)

  it('registers a 30 second interval [STRUCTURAL: asserts the timer, not the refresh]', async () => {
    // Weaker than the tests above and labelled as such. It proves an interval of the right
    // period is installed; the tests above prove what happens when a tick fires.
    const seed = await metricsForOrg()
    stubFetchWithRealDatabaseReads()
    const setInterval = vi.spyOn(globalThis, 'setInterval')

    render(
      <PipelineOverview metrics={seed} selectedClientId={null} sourcingMaxBatchSize={500} />,
    )

    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 30_000)
    setInterval.mockRestore()
  }, 60_000)

  it('does not fetch on mount, because the server render just produced the same numbers', async () => {
    const seed = await metricsForOrg()
    const { calls } = stubFetchWithRealDatabaseReads()

    render(
      <PipelineOverview metrics={seed} selectedClientId={null} sourcingMaxBatchSize={500} />,
    )
    await act(async () => {})

    expect(calls()).toBe(0)
  }, 60_000)
})
