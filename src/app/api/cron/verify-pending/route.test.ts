// THE ORGANISATION PICKER, AND THE STARVATION IT CAUSED.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS IS ACTUALLY TESTING, BECAUSE A ROW COUNT WOULD NOT HAVE CAUGHT IT
//
// The tier gate landed on verifyEnrichedBatch on 2026-09-01 and not on the query that picks
// WHICH ORGANISATION to hand it. Each half was individually defensible and the pair was
// broken: the picker nominated an organisation whose only pending rows the trigger then
// refused, so the sweep selected nothing, wrote a successful heartbeat, and never reached
// any other organisation.
//
// Measured 2026-09-03 in production: the only two rows the picker could see platform-wide
// were both tier-rejected. Roughly 290 firings over two days, every one reporting
// "success: verified 0", every one unable to do anything. It was invisible rather than
// harmless: no second organisation had pending work, so nothing was actually blocked.
//
// A test asserting "zero rows selected" passes in BOTH worlds and proves nothing. The bug is
// about WHICH ORGANISATION IS NOMINATED, so every test below sets up two organisations and
// asserts on the one that gets served.
//
// The fake honours .or(), .limit(), .order() and the !inner join, and is itself tested in
// helpers/fake-prospects-client.test.ts. Do not trust these tests further than that one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { fakeProspectsClient, type FakeRow } from '@/lib/sourcing/__tests__/helpers/fake-prospects-client'
import { myemailverifierHandler } from '@/lib/sourcing/handlers/adapter-myemailverifier'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureCheckIn: vi.fn(() => 'checkin-id'),
  flush: vi.fn(() => Promise.resolve()),
}))

/** Set per test, before POST is called. The mocked createClient hands this back. */
let currentClient: unknown = null

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => currentClient),
}))

const { POST } = await import('./route')

/**
 * A rejection reason deliberately unlike any real one.
 *
 * Rule zero: the gate is on the PRESENCE of a reason, never on its value. A fixture using a
 * real reason string would read as though the value mattered, and would not catch the legacy
 * value already in production that no module lists.
 */
const A_REJECTION = 'a-rejection-reason-the-gate-never-reads'

const STARVED_ORG = 'org-only-rejected-rows'
const WORKING_ORG = 'org-with-real-work'

const ORGANISATIONS = {
  [STARVED_ORG]: { archived_at: null },
  [WORKING_ORG]: { archived_at: null },
}

/** A prospect the first-pass picker can see: enriched, no verdict, has an email. */
function pendingProspect(over: Partial<FakeRow> & { id: string; organisation_id: string }): FakeRow {
  return {
    email: `${over.id}@example.com`,
    country: 'United Kingdom',
    enrichment_status: 'enriched',
    independent_email_status: null,
    independent_verified_at: null,
    verification_attempt_count: 0,
    verification_locked_at: null,
    suppressed: false,
    // Qualified unless a test says otherwise.
    sourced_tier: 'tier_1',
    tiering_reason: 'tier_1 (score 90)',
    ...over,
  }
}

const validVerdict = {
  email: 'a@b.com', status: 'Valid' as const, catch_all: false, disposable_domain: false,
  role_based: false, free_domain: false, greylisted: false, send_eligible: true,
  verified_at: '2026-09-03T00:00:00Z', diagnosis: 'ok',
}

function post() {
  return POST(new NextRequest('http://localhost/api/cron/verify-pending', {
    method: 'POST',
    headers: { authorization: 'Bearer test-cron-secret' },
  }))
}

beforeEach(() => {
  vi.restoreAllMocks()
  process.env.CRON_SECRET = 'test-cron-secret'
})
afterEach(() => vi.restoreAllMocks())

describe('THE STARVATION: an organisation whose only pending rows are tier-rejected', () => {
  /**
   * THE EXACT PRODUCTION SHAPE, and the reason created_at matters.
   *
   * The picker orders by created_at ascending, so the rejected rows are made OLDER than the
   * real work. Without that ordering the test could pass by accident on insertion order and
   * would not be reproducing the bug at all: in production the rejected rows were the oldest
   * pending work on the platform, which is precisely why they captured every sweep.
   */
  const twoOrganisations = () => [
    pendingProspect({
      id: 'rejected-and-oldest', organisation_id: STARVED_ORG,
      created_at: '2026-09-01T17:13:22Z', sourced_tier: null, tiering_reason: A_REJECTION,
    }),
    pendingProspect({
      id: 'also-rejected', organisation_id: STARVED_ORG,
      created_at: '2026-09-01T17:13:23Z', sourced_tier: null, tiering_reason: A_REJECTION,
    }),
    pendingProspect({
      id: 'genuine-pending-work', organisation_id: WORKING_ORG,
      created_at: '2026-09-02T10:00:00Z',
    }),
  ]

  it('nominates the organisation with real work, not the one full of rejected rows', async () => {
    vi.spyOn(myemailverifierHandler, 'execute').mockResolvedValue(validVerdict)
    const fake = fakeProspectsClient(twoOrganisations(), { organisations: ORGANISATIONS })
    currentClient = fake.client

    const response = await post()
    const body = await response.json()

    // THE ASSERTION THAT IS THE WHOLE POINT. Before the gate reached this picker, the older
    // rejected rows won and this read STARVED_ORG on every firing, forever.
    expect(body.organisation_id).toBe(WORKING_ORG)
  })

  it('and its rows ARE selected and verified, so work genuinely flows', async () => {
    // The failure mode of this fix is the same shape as the bug: a picker too strict finds
    // no organisation, does nothing, and reports success. Proving the bad case stops is only
    // half of it. This is the other half.
    const execute = vi.spyOn(myemailverifierHandler, 'execute').mockResolvedValue(validVerdict)
    const fake = fakeProspectsClient(twoOrganisations(), { organisations: ORGANISATIONS })
    currentClient = fake.client

    const body = await (await post()).json()

    expect(body.organisation_id).toBe(WORKING_ORG)
    expect(body.verified).toBe(1)
    expect(execute).toHaveBeenCalledTimes(1)
    // The one address probed is the qualified one, not either rejected one.
    expect(execute.mock.calls[0][0]).toBe('genuine-pending-work@example.com')
  })

  it('never probes a rejected address even when its organisation is nominated anyway', async () => {
    // Belt and braces on the trigger's own gate: with ONLY the starved organisation present,
    // the picker returns nothing and no address is probed.
    const execute = vi.spyOn(myemailverifierHandler, 'execute').mockResolvedValue(validVerdict)
    const fake = fakeProspectsClient(
      twoOrganisations().filter(r => r.organisation_id === STARVED_ORG),
      { organisations: ORGANISATIONS },
    )
    currentClient = fake.client

    const body = await (await post()).json()

    expect(body.organisation_id).toBeNull()
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('the picker still leaves alone what the trigger still accepts', () => {
  it('nominates an organisation whose pending rows have NOT been tiered yet', async () => {
    // excludeTierRejected, not requireTierPresent. Both columns null means tiering has not
    // run, which is not a rejection, and holding these back would make the cheap step wait
    // on the expensive one for no reason. The trigger agrees; the picker must too, or the
    // pair starves in the opposite direction.
    const execute = vi.spyOn(myemailverifierHandler, 'execute').mockResolvedValue(validVerdict)
    const fake = fakeProspectsClient(
      [pendingProspect({
        id: 'never-tiered', organisation_id: WORKING_ORG,
        created_at: '2026-09-02T10:00:00Z', sourced_tier: null, tiering_reason: null,
      })],
      { organisations: ORGANISATIONS },
    )
    currentClient = fake.client

    const body = await (await post()).json()

    expect(body.organisation_id).toBe(WORKING_ORG)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('still excludes archived organisations, which is a separate filter on the same query', async () => {
    // Guarding against a fix that accidentally rewrites the join. This filter predates the
    // tier gate and protects a free tier from being spent on a dead test organisation.
    const execute = vi.spyOn(myemailverifierHandler, 'execute').mockResolvedValue(validVerdict)
    const fake = fakeProspectsClient(
      [pendingProspect({ id: 'in-archived', organisation_id: 'org-archived', created_at: '2026-01-01T00:00:00Z' })],
      { organisations: { ...ORGANISATIONS, 'org-archived': { archived_at: '2026-04-01' } } },
    )
    currentClient = fake.client

    const body = await (await post()).json()

    expect(body.organisation_id).toBeNull()
    expect(execute).not.toHaveBeenCalled()
  })
})
