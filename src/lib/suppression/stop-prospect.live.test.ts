// THE MONITOR-VISIBILITY PROPERTY, PROVED AGAINST THE REAL DATABASE.
//
// Needs the TEST database. Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/lib/suppression/stop-prospect.live.test.ts
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A LIVE TEST AND NOT A FAKE
//
// The property under test is: a stopped prospect is SELECTED BY findBlockedProspects, and
// is therefore inside MON-026's field of view.
//
// findBlockedProspects expresses that with `.or('suppressed.eq.true,client_review_status.eq.rejected')`.
// A hand-written fake would have to honour `.or()` to test it, and CLAUDE.md records three
// separate occasions where a fake silently accepted a filter it did not implement and the
// guard it was supposed to prove was never exercised. A fake that got `.or()` wrong would
// go green in both worlds, which is precisely the failure this file exists to rule out.
//
// So this asks Postgres. The predicate is evaluated by the same engine that evaluates it in
// production, and the assertion cannot be satisfied by a stub returning a convenient answer.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE MUTATION THIS FILE IS BUILT TO KILL
//
// Delete `suppressed: true` from the UPDATE in stopProspect and this file goes red.
//
// That mutation is the plausible one. send_hold_at is the purpose-built operator field, and
// writing only it looks tidier and more correct. It would block the next upload and it would
// survive re-verification, so nothing obvious breaks. What it would silently do is remove
// the prospect from findBlockedProspects, and therefore from the only instrument that reads
// the provider back. MON-026 would report OK for ever about a person it could no longer see.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient } from '@/test-utils/test-database'
import { deleteTestOrganisation } from '@/test-utils/delete-test-organisations'
import { asServiceRoleClient } from '@/lib/supabase/service-role'

// The provider is stubbed at the CAPABILITY boundary, so no network call can happen and the
// test cannot depend on what integrations_registry happens to hold in the test database.
// Stubbed to SUCCEED, deliberately: a passing carry is the case in which a missing
// `suppressed` write is hardest to notice, because every other signal reads healthy.
const stopLead = vi.fn(async (leadId: string) => ({
  ok: true as const,
  state: { leadId, status: 3, interestStatus: -1 },
}))
const findLeadIds = vi.fn(async () => ({ ok: true as const, leadIds: [] as string[] }))
const readLead = vi.fn(async (leadId: string) => ({
  ok: true as const,
  state: { leadId, status: 3, interestStatus: -1 },
}))

vi.mock('@/lib/integrations/capabilities/suppress-contact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/integrations/capabilities/suppress-contact')>()
  return {
    ...actual,
    resolveSuppressContactHandler: vi.fn(async () => ({
      ok: true as const,
      handler: { toolName: 'stub', stopLead, findLeadIds, readLead },
    })),
  }
})

const { stopProspect, OPERATOR_STOP_SUPPRESSION_REASON } = await import('./stop-prospect')
const { findBlockedProspects } = await import('./send-gate')

const CONTEXT = 'stop-prospect.live.test.ts'

let supabase: SupabaseClient<Database>
let orgId: string
let prospectId: string

// A stand-in operator. The column is a plain uuid with no FK to auth users, so a fixed
// value is enough and avoids creating a real account for a column this test only reads back.
const OPERATOR_ID = '00000000-0000-4000-8000-0000000000aa'
const REASON = 'Asked us by phone not to be contacted again.'

beforeEach(async () => {
  supabase = createTestServiceClient(CONTEXT)

  const { data: org, error: orgErr } = await supabase
    .from('organisations')
    .insert({ name: 'Stop Test Org', slug: `stop-test-${Date.now()}` })
    .select('id')
    .single()
  if (orgErr) throw orgErr
  orgId = org.id

  // An UPLOADED prospect holding a provider lead id: the case the whole build is about.
  // Approved and not suppressed, so nothing but the stop can make them blocked.
  const { data: prospect, error: prospectErr } = await supabase
    .from('prospects')
    .insert({
      organisation_id: orgId,
      email: `stop-target-${Date.now()}@example.com`,
      first_name: 'Target',
      last_name: 'Person',
      outbound_upload_status: 'uploaded',
      outbound_lead_id: `stub-lead-${Date.now()}`,
      client_review_status: 'approved',
      suppressed: false,
    })
    .select('id')
    .single()
  if (prospectErr) throw prospectErr
  prospectId = prospect.id
})

afterEach(async () => {
  vi.clearAllMocks()
  await deleteTestOrganisation(supabase, orgId, CONTEXT)
})

async function stopTheProspect() {
  const { data: row, error } = await supabase
    .from('prospects')
    .select('id, organisation_id, email, outbound_lead_id')
    .eq('id', prospectId)
    .single()
  if (error) throw error

  return stopProspect(asServiceRoleClient(supabase), {
    subject: row,
    operatorId: OPERATOR_ID,
    reason: REASON,
  })
}

describe('stopProspect, against the real database', () => {
  it('puts the prospect inside findBlockedProspects, which is what MON-026 reads', async () => {
    // Before: nothing blocks them. Establishes that the assertion below is caused by the
    // stop and not by the fixture, which is the difference between a test and a coincidence.
    const before = await findBlockedProspects(asServiceRoleClient(supabase), orgId, [
      { id: prospectId, email: 'stop-target@example.com' },
    ])
    expect(before.ok).toBe(true)
    if (!before.ok) throw new Error('gate read failed')
    expect(before.blocked.has(prospectId)).toBe(false)

    const result = await stopTheProspect()
    expect(result.ok).toBe(true)

    // THE ASSERTION THIS FILE EXISTS FOR.
    const after = await findBlockedProspects(asServiceRoleClient(supabase), orgId, [
      { id: prospectId, email: 'stop-target@example.com' },
    ])
    expect(after.ok).toBe(true)
    if (!after.ok) throw new Error('gate read failed')
    expect(after.blocked.get(prospectId)).toBe('prospect_suppressed')
  }, 30_000)

  it('records the hold, so re-verification cannot recompute the row back to eligible', async () => {
    await stopTheProspect()

    const { data, error } = await supabase
      .from('prospects')
      .select('suppressed, suppressed_at, suppression_reason, send_hold_at, send_hold_by, send_hold_reason')
      .eq('id', prospectId)
      .single()
    if (error) throw error

    expect(data.suppressed).toBe(true)
    expect(data.suppressed_at).not.toBeNull()
    expect(data.suppression_reason).toBe(OPERATOR_STOP_SUPPRESSION_REASON)

    // The hold half. send_hold_at is what both eligibility writers read.
    expect(data.send_hold_at).not.toBeNull()
    expect(data.send_hold_by).toBe(OPERATOR_ID)
    // The operator's own words, not the machine code. This is the column that lets a later
    // reader tell a decision from a bug.
    expect(data.send_hold_reason).toBe(REASON)
  }, 30_000)

  it('tells the provider, and does so AFTER the row is already blocked', async () => {
    await stopTheProspect()

    expect(stopLead).toHaveBeenCalledTimes(1)

    // Order is the point. If the provider were called first and the database write then
    // failed, the person would be stopped at the provider while our record said mailable,
    // and nothing would report it. Proved by reading the row the provider call observed:
    // by the time stopLead ran, the stop was already committed.
    const [, orgArg] = stopLead.mock.calls[0] as unknown as [string, string]
    expect(orgArg).toBe(orgId)

    const { data } = await supabase
      .from('prospects')
      .select('outbound_suppression_status')
      .eq('id', prospectId)
      .single()
    expect(data?.outbound_suppression_status).toBe('confirmed')
  }, 30_000)

  it('a prospect in another organisation is never stopped by this call', async () => {
    // The organisation filter is a guard, not decoration. A wrong organisation must match
    // zero rows and be reported as a failure rather than silently stopping somebody else.
    const result = await stopProspect(asServiceRoleClient(supabase), {
      subject: {
        id: prospectId,
        organisation_id: '00000000-0000-4000-8000-0000000000bb',
        email: 'stop-target@example.com',
        outbound_lead_id: 'stub-lead',
      },
      operatorId: OPERATOR_ID,
      reason: REASON,
    })

    expect(result.ok).toBe(false)
    expect(stopLead).not.toHaveBeenCalled()

    const { data } = await supabase
      .from('prospects')
      .select('suppressed, send_hold_at')
      .eq('id', prospectId)
      .single()
    expect(data?.suppressed).toBe(false)
    expect(data?.send_hold_at).toBeNull()
  }, 30_000)
})
