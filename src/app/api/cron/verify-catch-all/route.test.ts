// THE PAID SECOND PASS: its organisation picker and its row selector, both tier-gated.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS PAIR MATTERS MORE THAN THE FIRST PASS
//
// The first-pass equivalent of this bug wasted a free tier. Every probe reached from here is
// BILLED. Measured 2026-09-03 against the verification_calls ledger: 6 of the 52 paid calls
// ever made went to prospects tiering had already rejected, and five came back deliverable.
// An address confirmed, at cost, for a prospect that will never be emailed.
//
// Both queries are tested here because gating one and not the other is the bug this whole
// change exists to fix. The picker chooses the organisation and the trigger chooses the
// rows; a filter on one and not the other either spends money or starves.
//
// The fake honours .or(), .limit(), .order() and the !inner join, and is tested in
// helpers/fake-prospects-client.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { fakeProspectsClient, type FakeRow } from '@/lib/sourcing/__tests__/helpers/fake-prospects-client'
import { bouncerHandler } from '@/lib/sourcing/handlers/adapter-bouncer'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureCheckIn: vi.fn(() => 'checkin-id'),
  flush: vi.fn(() => Promise.resolve()),
}))

let currentClient: unknown = null

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => currentClient),
}))

const { POST } = await import('./route')

/** Rule zero: the gate reads the PRESENCE of a reason, never its value. */
const A_REJECTION = 'a-rejection-reason-the-gate-never-reads'

const STARVED_ORG = 'org-only-rejected-rows'
const WORKING_ORG = 'org-with-real-work'
const ORGANISATIONS = {
  [STARVED_ORG]: { archived_at: null },
  [WORKING_ORG]: { archived_at: null },
}

/**
 * A prospect the second pass can see: unsuppressed, has an email, carries a first-pass
 * verdict the second pass is worth paying for, and has never been second-passed.
 */
function secondPassCandidate(
  over: Partial<FakeRow> & { id: string; organisation_id: string },
): FakeRow {
  return {
    email: `${over.id}@example.com`,
    country: 'United Kingdom',
    suppressed: false,
    // 'Catch All' is one of SECOND_PASS_WORTH_PAYING_FOR, derived from the vendor map.
    independent_email_status: 'Catch All',
    verification_provider: 'myemailverifier',
    second_pass_status: null,
    second_pass_attempt_count: 0,
    second_pass_locked_at: null,
    sourced_tier: 'tier_1',
    tiering_reason: 'tier_1 (score 90)',
    ...over,
  }
}

const deliverable = {
  email: 'a@b.com', raw_status: 'deliverable', verdict: 'deliverable' as const,
  reason: 'accepted_email', score: 90, accept_all: false, provider: 'google',
  verified_at: '2026-09-03T00:00:00Z',
}

function post() {
  return POST(new NextRequest('http://localhost/api/cron/verify-catch-all', {
    method: 'POST',
    headers: { authorization: 'Bearer test-cron-secret' },
  }))
}

beforeEach(() => {
  vi.restoreAllMocks()
  process.env.CRON_SECRET = 'test-cron-secret'
  process.env.BOUNCER_API_KEY = 'fake-test-key-not-a-real-bouncer-key'
})
afterEach(() => vi.restoreAllMocks())

describe('THE STARVATION, on the pass that costs money', () => {
  const twoOrganisations = () => [
    secondPassCandidate({
      id: 'rejected-and-oldest', organisation_id: STARVED_ORG,
      created_at: '2026-09-01T17:00:00Z', sourced_tier: null, tiering_reason: A_REJECTION,
    }),
    secondPassCandidate({
      id: 'genuine-backlog', organisation_id: WORKING_ORG,
      created_at: '2026-09-02T10:00:00Z',
    }),
  ]

  it('nominates the organisation with real backlog, not the one full of rejected rows', async () => {
    vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(deliverable)
    currentClient = fakeProspectsClient(twoOrganisations(), { organisations: ORGANISATIONS }).client

    const body = await (await post()).json()

    expect(body.organisation_id).toBe(WORKING_ORG)
  })

  it('and its rows ARE selected and paid for, so work genuinely flows', async () => {
    const execute = vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(deliverable)
    currentClient = fakeProspectsClient(twoOrganisations(), { organisations: ORGANISATIONS }).client

    const body = await (await post()).json()

    expect(body.organisation_id).toBe(WORKING_ORG)
    expect(body.verified).toBe(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0]).toBe('genuine-backlog@example.com')
  })

  it('spends nothing when the only backlog is tier-rejected', async () => {
    // The money assertion. Six real calls were billed for exactly this case.
    const execute = vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(deliverable)
    currentClient = fakeProspectsClient(
      twoOrganisations().filter(r => r.organisation_id === STARVED_ORG),
      { organisations: ORGANISATIONS },
    ).client

    const body = await (await post()).json()

    expect(body.organisation_id).toBeNull()
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('THE ROW SELECTOR: a rejected row inside a nominated organisation is never billed', () => {
  it('probes only the qualified row when both sit in the same organisation', async () => {
    // The picker and the selector are separate queries, so this is the case the picker alone
    // cannot cover: an organisation legitimately nominated for its real backlog, carrying a
    // rejected row alongside it. Without the gate on the selector, that row gets billed.
    const execute = vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(deliverable)
    currentClient = fakeProspectsClient([
      secondPassCandidate({
        id: 'rejected-passenger', organisation_id: WORKING_ORG,
        created_at: '2026-09-01T09:00:00Z', sourced_tier: null, tiering_reason: A_REJECTION,
      }),
      secondPassCandidate({
        id: 'qualified', organisation_id: WORKING_ORG, created_at: '2026-09-02T10:00:00Z',
      }),
    ], { organisations: ORGANISATIONS }).client

    const body = await (await post()).json()

    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0]).toBe('qualified@example.com')
    expect(body.verified).toBe(1)
  })

  it('writes exactly one paid-call ledger row, and it is not for the rejected prospect', async () => {
    // verification_calls is the spend ledger. A row here IS the money. The ledger is what
    // the 6-of-52 measurement was taken from, so it is what the fix has to change.
    vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(deliverable)
    const fake = fakeProspectsClient([
      secondPassCandidate({
        id: 'rejected-passenger', organisation_id: WORKING_ORG,
        created_at: '2026-09-01T09:00:00Z', sourced_tier: null, tiering_reason: A_REJECTION,
      }),
      secondPassCandidate({
        id: 'qualified', organisation_id: WORKING_ORG, created_at: '2026-09-02T10:00:00Z',
      }),
    ], { organisations: ORGANISATIONS })
    currentClient = fake.client

    await post()

    const ledger = fake.inserted.filter(i => i.table === 'verification_calls')
    expect(ledger).toHaveLength(1)
    const rejectedId = 'rejected-passenger'
    expect(ledger.map(l => l.payload.prospect_id)).not.toContain(rejectedId)
  })

  it('still pays for a prospect tiering has not reached yet', async () => {
    // excludeTierRejected, not requireTierPresent, matching every other upstream consumer.
    const execute = vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(deliverable)
    currentClient = fakeProspectsClient(
      [secondPassCandidate({
        id: 'never-tiered', organisation_id: WORKING_ORG,
        created_at: '2026-09-02T10:00:00Z', sourced_tier: null, tiering_reason: null,
      })],
      { organisations: ORGANISATIONS },
    ).client

    const body = await (await post()).json()

    expect(body.organisation_id).toBe(WORKING_ORG)
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
