// D2b: an address already on the global suppression list is never a paid probe.
//
// A bounce writes suppressed_emails and never prospects.suppressed, so the candidate read still
// returns a prospect whose address is known to be dead, with suppressed = false. Each one was a
// billed second-pass probe. This suite plants that exact shape and checks three things:
//   1. The listed candidate is never probed.
//   2. It is retired from the candidate set, through the existing attempt bound, with a reason
//      on the row, so it cannot starve the batch on the next run.
//   3. A failed suppression read stops the run before anything is probed.
// Each block has a control: an unlisted candidate in the same batch IS probed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runSecondPassBatch } from '../second-pass-trigger'
import { bouncerHandler } from '../handlers/adapter-bouncer'
import { SECOND_PASS_WORTH_PAYING_FOR } from '../verification-verdict'
import { MYEMAILVERIFIER_PROVIDER_KEY } from '../handlers/adapter-myemailverifier'
import { fakeProspectsClient, type FakeRow } from './helpers/fake-prospects-client'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

const ORG = 'org-1'
const WORTH_PAYING_FOR = SECOND_PASS_WORTH_PAYING_FOR[0]
const MAX_ATTEMPTS = 2

function candidate(id: string): FakeRow {
  return {
    id,
    organisation_id: ORG,
    email: `${id}@example.invalid`,
    country: null,
    suppressed: false,
    independent_email_status: WORTH_PAYING_FOR,
    verification_provider: MYEMAILVERIFIER_PROVIDER_KEY,
    second_pass_status: null,
    second_pass_attempt_count: 0,
    second_pass_locked_at: null,
    sourced_tier: 'tier_1',
    tiering_reason: null,
  }
}

const probeResult = {
  email: 'unused@example.invalid',
  raw_status: 'deliverable',
  verdict: 'deliverable' as const,
  reason: 'accepted_email',
  score: 90,
  accept_all: true,
  provider: 'mail-host',
  verified_at: '2026-10-05T00:00:00.000Z',
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('an address on the suppression list is not probed', () => {
  it('a listed candidate is never probed, and an unlisted one in the same batch is', async () => {
    const probe = vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(probeResult)
    const { client } = fakeProspectsClient(
      [candidate('bounced'), candidate('fine')],
      { count: 0, suppressedEmails: ['bounced@example.invalid'] },
    )

    await runSecondPassBatch(client as unknown as SupabaseClient, ORG, 10)

    const probedAddresses = probe.mock.calls.map(call => call[0])
    expect(probedAddresses).not.toContain('bounced@example.invalid')
    // CONTROL: the same batch does probe the unlisted address, so the zero above means something.
    expect(probedAddresses).toEqual(['fine@example.invalid'])
  })

  it('the listed candidate is retired through the attempt bound, with a reason on the row', async () => {
    vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(probeResult)
    const { client, applied } = fakeProspectsClient(
      [candidate('bounced'), candidate('fine')],
      { count: 0, suppressedEmails: ['bounced@example.invalid'] },
    )

    await runSecondPassBatch(client as unknown as SupabaseClient, ORG, 10)

    const retirement = applied.find(a => a.payload.second_pass_error === 'address_on_global_suppression_list')
    expect(retirement).toBeDefined()
    expect(retirement!.ids).toEqual(['bounced'])
    expect(retirement!.payload.second_pass_attempt_count).toBe(MAX_ATTEMPTS)
    // The send verdict is not written here. The send gate blocks the address on its own, and
    // ADR-034 freezes the verdict on the row.
    expect(retirement!.payload).not.toHaveProperty('email_send_eligible')
  })

  it('CONTROL: with nothing on the list, no retirement is written and both candidates are probed', async () => {
    const probe = vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(probeResult)
    const { client, applied } = fakeProspectsClient(
      [candidate('bounced'), candidate('fine')],
      { count: 0, suppressedEmails: [] },
    )

    await runSecondPassBatch(client as unknown as SupabaseClient, ORG, 10)

    expect(probe).toHaveBeenCalledTimes(2)
    expect(applied.some(a => a.payload.second_pass_error === 'address_on_global_suppression_list')).toBe(false)
  })
})

describe('a suppression list we cannot read stops the run', () => {
  it('throws before any candidate is probed', async () => {
    const probe = vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(probeResult)
    const { client } = fakeProspectsClient(
      [candidate('p1'), candidate('p2')],
      { count: 0, suppressedEmailsError: 'Gateway Timeout' },
    )

    // The batch records a thrown error as a FAILED run, which the cron route pages on. It is not
    // swallowed as a quiet empty run.
    const run = await runSecondPassBatch(client as unknown as SupabaseClient, ORG, 10)

    expect(run.status).toBe('failed')
    expect(run.error_message).toMatch(/global suppression lookup failed: Gateway Timeout/)
    expect(probe).not.toHaveBeenCalled()
  })

  it('CONTROL: the same batch with a readable list is probed, so the zero above is the read failing', async () => {
    const probe = vi.spyOn(bouncerHandler, 'execute').mockResolvedValue(probeResult)
    const { client } = fakeProspectsClient(
      [candidate('p1'), candidate('p2')],
      { count: 0, suppressedEmails: [] },
    )

    await runSecondPassBatch(client as unknown as SupabaseClient, ORG, 10)

    expect(probe).toHaveBeenCalledTimes(2)
  })
})
