// The thread hold, driven through the real upload action.
//
// Operator note 4 (2026-10-01): a personalised Email 1 is not sent unless Email 2 or
// Email 3 carries it forward. thread-carried.test.ts proves the verdict. This file proves
// the JOIN: the action composes, reads the verdict, and a prospect that fails it is not in
// the batch handed to the sending tool, is not recorded as sent, and goes back to pending
// with the reason on its row.
//
// It also pins the second defect found beside it: the record of what was sent is written
// with the SERVICE-ROLE client. The table is service-role only, the action passed the
// operator's session client for the table's whole life, and every insert was refused and
// swallowed. The session fake below refuses that table the way the grant does.
//
// Everything downstream of the database is a stand-in (composition, the sending tool). The
// action's own control flow is real.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`unexpected redirect to ${to}`) },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  flush: vi.fn(() => Promise.resolve()),
  withServerActionInstrumentation: (_name: string, cb: () => unknown) => cb(),
}))
vi.mock('@/lib/integrations/handlers/instantly/validateCampaign', () => ({ validateCampaign: vi.fn() }))
vi.mock('@/lib/integrations/handlers/instantly/orderMailboxes', () => ({ orderMailboxes: vi.fn() }))
vi.mock('@/lib/integrations/handlers/instantly/syncSequenceShell', () => ({
  syncSequenceShell: vi.fn(),
  getDocStepCount: vi.fn(() => 4),
}))
vi.mock('@/lib/approval/assertStrategyApproved', () => ({
  assertStrategyApproved: vi.fn(async () => ({ approved: true, pendingDocs: [] })),
}))
vi.mock('@/lib/composition/custom-variables', () => ({
  composedToVariables: vi.fn(() => ({ email1_body: 'x' })),
  assertCompleteVariables: vi.fn(),
}))
vi.mock('@/lib/email/send', () => ({ sendTransactionalEmail: vi.fn() }))
vi.mock('@/lib/suppression/send-gate', () => ({
  findBlockedProspects: vi.fn(async () => ({ ok: true, blocked: new Map() })),
}))
// The send gate's filters are not what is under test; the claim is modelled by the fake.
vi.mock('@/lib/sourcing/send-gate', () => ({ applySendGate: (query: unknown) => query }))

const upload = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('@/lib/integrations/handlers/instantly/uploadLeads', () => ({ uploadLeads: upload.fn }))

const compose = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('@/lib/composition/compose-sequence', () => ({
  fetchComposeDocs: vi.fn(async () => ({ messagingDoc: {}, messagingDocId: 'doc-1' })),
  composeSequence: compose.fn,
  getComposeServiceClient: vi.fn(() => ({})),
}))

const record = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('@/lib/composition/record-sent-sequence', () => ({ recordSentSequence: record.fn }))

const ORG = 'org-under-test'

interface Row {
  id: string
  organisation_id: string
  email: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  job_title: string | null
  segment_id: string | null
  outbound_upload_status: string
  outbound_upload_error: string | null
  /** What the real select reads as `opening_judge:trigger_data->judge`. */
  opening_judge?: unknown
}

let prospects: Row[] = []
/** The client's ICP triggers, as the checked read returns them. */
let icpTriggers: unknown[] = []
let icpReadError: string | null = null
/** Every column list asked of prospects, so a test can see what the action selects. */
let prospectSelects: string[] = []
/** The client's upload hold, as organisations holds it. */
let hold: { outbound_upload_hold: boolean; outbound_upload_hold_note: string | null } | null = { outbound_upload_hold: false, outbound_upload_hold_note: null }
let holdReadError: string | null = null

/* eslint-disable @typescript-eslint/no-explicit-any */

/** prospects, in memory. eq and in are HONOURED: an update must land on the row it names. */
function prospectsTable(kind: 'session' | 'service') {
  const build = (patch?: Record<string, unknown>) => {
    const eqs: [string, unknown][] = []
    let inIds: string[] | null = null
    const matches = () => prospects.filter(r =>
      eqs.every(([c, v]) => (r as any)[c] === v) && (inIds === null || inIds.includes(r.id)))
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => { eqs.push([c, v]); return b },
      in: (_c: string, v: string[]) => { inIds = v; return b },
      lt: () => { eqs.push(['outbound_upload_status', '__stale_only__']); return b },
      not: () => b,
      then: (resolve: (v: unknown) => unknown) => {
        const rows = patch
          // The claim is the one update with no id filter: it takes every pending row.
          ? matches().filter(r => inIds !== null || eqs.some(([c]) => c === 'id') || r.outbound_upload_status === 'pending')
          : matches()
        if (patch) for (const r of rows) Object.assign(r, patch)
        return resolve({ data: rows.map(r => ({ ...r })), error: null })
      },
    }
    return b
  }
  void kind
  return {
    select: (columns?: string) => { if (columns) prospectSelects.push(columns); return build() },
    update: (patch: Record<string, unknown>) => build(patch),
  }
}

function tables(kind: 'session' | 'service', table: string): any {
  if (table === 'users') {
    return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { role: 'operator' }, error: null }) }) }) }
  }
  if (table === 'segments') {
    const b: any = { select: () => b, eq: () => b, maybeSingle: () => Promise.resolve({ data: null, error: null }) }
    return b
  }
  if (table === 'campaigns') {
    const b: any = {
      select: () => b, eq: () => b, in: () => b,
      then: (r: any) => r({ data: [{ id: 'campaign-1', external_id: 'ext-1', shell_step_count: 4, shell_segment_id: null }], error: null }),
    }
    return b
  }
  if (table === 'strategy_documents') {
    // The client's active ICP. Filters are recorded so the test can see the read is scoped.
    const filters: Record<string, unknown> = {}
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => { filters[c] = v; return b },
      order: () => b,
      then: (r: any) => r(icpReadError
        ? { data: null, error: { message: icpReadError } }
        : { data: filters.organisation_id === ORG ? [{ segment_id: null, content: { tier_1: { triggers: icpTriggers } } }] : [], error: null }),
    }
    return b
  }
  if (table === 'prospects') return prospectsTable(kind)
  if (table === 'organisations') {
    const filters: Record<string, unknown> = {}
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => { filters[c] = v; return b },
      maybeSingle: () => Promise.resolve(holdReadError
        ? { data: null, error: { message: holdReadError } }
        : { data: filters.id === ORG ? hold : null, error: null }),
    }
    return b
  }
  if (table === 'sent_sequences') {
    // THE GRANT, modelled. authenticated cannot INSERT; service_role can (read live 2026-10-01).
    if (kind === 'session') throw new Error('permission denied for table sent_sequences')
    return { insert: () => Promise.resolve({ error: null }) }
  }
  throw new Error(`${kind} client: unexpected table ${table}`)
}

const sessionClient = {
  __kind: 'session',
  auth: { getUser: () => Promise.resolve({ data: { user: { id: 'operator-1' } } }) },
  from: (table: string) => tables('session', table),
} as any
const serviceClient = { __kind: 'service', from: (table: string) => tables('service', table) } as any

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => sessionClient) }))
vi.mock('@/lib/supabase/service-role', () => ({ createServiceRoleClient: vi.fn(async () => serviceClient) }))

import { handleUploadLeads } from '../actions'
import { findBlockedProspects } from '@/lib/suppression/send-gate'

/** A composed sequence in the shape the action reads: tier, and each follow-up's mode. */
function composed(prospectId: string, tier: 'research' | 'firm_fact' | 'template', modes: { 2: string | null; 3: string | null }) {
  const position = (reason: string | null) => ({ mode: reason === null ? 'generated' : 'template', fell_back_reason: reason })
  return {
    prospect_id: prospectId,
    client_id: ORG,
    variant_id: 'A',
    messaging_doc_id: 'doc-1',
    emails: [],
    opening: { tier, detail: null },
    followups: { arm: 'generated', email1_fingerprint: 'f', positions: { 2: position(modes[2]), 3: position(modes[3]) } },
  }
}

const REASON = 'New equipment has to be kept busy, so more work has to be won.'
/** An opening written under the approved-reason rule, against the reason the client still has. */
const HELD_TO_REASON = { bridge: 'A line.', approved_reason: { state: 'approved', reason: REASON } }

function seed(ids: string[], judges: Record<string, unknown> = {}) {
  prospects = ids.map(id => ({
    id, organisation_id: ORG, email: `${id}@example.invalid`, first_name: 'Sam', last_name: 'Reader',
    company_name: 'A Company', job_title: 'Owner', segment_id: null,
    outbound_upload_status: 'pending', outbound_upload_error: null,
    opening_judge: id in judges ? judges[id] : HELD_TO_REASON,
  }))
}

const row = (id: string) => prospects.find(p => p.id === id)!

beforeEach(() => {
  hold = { outbound_upload_hold: false, outbound_upload_hold_note: null }
  holdReadError = null
  icpTriggers = [{ trigger: 'Added equipment', reason: REASON }]
  icpReadError = null
  prospectSelects = []
  upload.fn.mockReset()
  compose.fn.mockReset()
  record.fn.mockReset()
  record.fn.mockResolvedValue(undefined)
  upload.fn.mockImplementation(async (_org: string, _ext: string, leads: unknown[]) => ({
    created_count: leads.length, duplicated: 0, in_blocklist: 0, invalid_email_count: 0, incomplete_count: 0,
  }))
})

describe('handleUploadLeads: a personalised Email 1 needs a follow-up that carries it', () => {
  it('PLANTED: personalised Email 1, both follow-ups template: HELD, not sent, not recorded, back to pending with the reason', async () => {
    seed(['p-held', 'p-carried'])
    compose.fn.mockImplementation(async ({ prospect_id }: { prospect_id: string }) =>
      prospect_id === 'p-held'
        ? composed('p-held', 'research', { 2: 'none_stored', 3: 'email1_changed' })
        : composed('p-carried', 'research', { 2: null, 3: 'none_stored' }))

    const result = await handleUploadLeads(ORG)

    if (!result.ok) throw new Error(`expected an upload, got: ${result.error}`)
    expect(result.heldWithoutFollowupCount).toBe(1)
    expect(result.compositionFailureCount).toBe(0)

    // Only the prospect whose thread is carried reached the sending tool.
    expect(upload.fn).toHaveBeenCalledTimes(1)
    const leads = upload.fn.mock.calls[0][2] as Array<{ email: string }>
    expect(leads.map(l => l.email)).toEqual(['p-carried@example.invalid'])

    // And only that one was recorded as handed over.
    expect(record.fn.mock.calls.map(c => c[2])).toEqual(['p-carried'])

    // The held prospect is waiting, not failed, and its row says why for each position.
    expect(row('p-held').outbound_upload_status).toBe('pending')
    expect(row('p-held').outbound_upload_error).toMatch(/^personalised_without_followup: /)
    expect(row('p-held').outbound_upload_error).toMatch(/Email 2: none has been written; Email 3: the one on file was written against a different Email 1/)
  })

  it('one personalised follow-up is enough, in either position', async () => {
    seed(['p-two', 'p-three'])
    compose.fn.mockImplementation(async ({ prospect_id }: { prospect_id: string }) =>
      prospect_id === 'p-two'
        ? composed('p-two', 'research', { 2: null, 3: 'none_stored' })
        : composed('p-three', 'research', { 2: 'none_stored', 3: null }))
    const result = await handleUploadLeads(ORG)
    if (!result.ok) throw new Error(`expected an upload, got: ${result.error}`)
    expect(result.heldWithoutFollowupCount).toBe(0)
    expect((upload.fn.mock.calls[0][2] as unknown[]).length).toBe(2)
  })

  it('PLANTED: the rule is about the research tier only: a firm-fact or template Email 1 sends with template follow-ups', async () => {
    seed(['p-fact', 'p-template'])
    compose.fn.mockImplementation(async ({ prospect_id }: { prospect_id: string }) =>
      prospect_id === 'p-fact'
        ? composed('p-fact', 'firm_fact', { 2: 'not_assigned', 3: 'not_assigned' })
        : composed('p-template', 'template', { 2: 'not_assigned', 3: 'not_assigned' }))
    const result = await handleUploadLeads(ORG)
    if (!result.ok) throw new Error(`expected an upload, got: ${result.error}`)
    expect(result.heldWithoutFollowupCount).toBe(0)
    expect((upload.fn.mock.calls[0][2] as unknown[]).length).toBe(2)
  })

  it('PLANTED: when every prospect is held the operator gets the count, not a generic error', async () => {
    seed(['p-held'])
    compose.fn.mockResolvedValue(composed('p-held', 'research', { 2: 'none_stored', 3: 'none_stored' }))
    const result = await handleUploadLeads(ORG)
    expect(result).toMatchObject({ ok: true, outcomes: [], heldWithoutFollowupCount: 1 })
    expect(upload.fn).not.toHaveBeenCalled()
    expect(row('p-held').outbound_upload_status).toBe('pending')
  })

  it('PLANTED: held prospects and a composition failure in one upload, nothing composed: BOTH counts reach the operator', async () => {
    // The all-held return used to require zero composition failures. With one of each the
    // action fell through to a generic "No prospects ready" error carrying neither count,
    // and nothing else displays the reason written on the held row.
    seed(['p-held', 'p-broken'])
    compose.fn.mockImplementation(async ({ prospect_id }: { prospect_id: string }) => {
      if (prospect_id === 'p-broken') throw new Error('composition failed for this one')
      return composed('p-held', 'research', { 2: 'none_stored', 3: 'none_stored' })
    })
    const result = await handleUploadLeads(ORG)
    expect(result).toMatchObject({ ok: true, outcomes: [], heldWithoutFollowupCount: 1, compositionFailureCount: 1 })
    expect(upload.fn).not.toHaveBeenCalled()
  })

  it('PLANTED: the record of what was sent is written with the service-role client, never the session', async () => {
    seed(['p-carried'])
    compose.fn.mockResolvedValue(composed('p-carried', 'research', { 2: null, 3: null }))
    await handleUploadLeads(ORG)
    expect(record.fn).toHaveBeenCalledTimes(1)
    const client = record.fn.mock.calls[0][0] as { __kind: string; from(table: string): unknown }
    expect(client.__kind).toBe('service')
    // The control that makes the line above mean something: the session client really is
    // refused, so a regression would not pass by accident.
    expect(() => sessionClient.from('sent_sequences')).toThrow(/permission denied for table sent_sequences/)
    expect(() => client.from('sent_sequences')).not.toThrow()
  })
})

describe('handleUploadLeads: a personalised Email 1 is sent only if it was held to a current approved reason', () => {
  const carried = (id: string) => composed(id, 'research', { 2: null, 3: null })

  it('positive control: an opening held to the client\'s current reason, with its thread carried, is sent', async () => {
    seed(['p-ok'])
    compose.fn.mockResolvedValue(carried('p-ok'))
    const result = await handleUploadLeads(ORG)
    if (!result.ok) throw new Error(`expected an upload, got: ${result.error}`)
    expect(result.heldWithoutApprovedReasonCount).toBe(0)
    expect((upload.fn.mock.calls[0][2] as unknown[]).length).toBe(1)
  })

  it('PLANTED: an opening written before the rule is HELD even though both its follow-ups are personalised', async () => {
    // The prospect that slipped through the first version of the rule: its thread is
    // carried, so the thread rule passes it, and nothing else looked.
    seed(['p-old', 'p-ok'], { 'p-old': { bridge: 'That usually means more work to win.' } })
    compose.fn.mockImplementation(async ({ prospect_id }: { prospect_id: string }) => carried(prospect_id))
    const result = await handleUploadLeads(ORG)
    if (!result.ok) throw new Error(`expected an upload, got: ${result.error}`)
    expect(result.heldWithoutApprovedReasonCount).toBe(1)
    expect(result.heldWithoutFollowupCount).toBe(0)
    expect((upload.fn.mock.calls[0][2] as Array<{ email: string }>).map(l => l.email)).toEqual(['p-ok@example.invalid'])
    expect(record.fn.mock.calls.map(c => c[2])).toEqual(['p-ok'])
    expect(row('p-old').outbound_upload_status).toBe('pending')
    expect(row('p-old').outbound_upload_error).toMatch(/^opening_without_approved_reason: /)
    expect(row('p-old').outbound_upload_error).toContain('written before openings were held to an approved trigger reason')
  })

  it('PLANTED: an opening held to a reason the client has since reworded is HELD', async () => {
    seed(['p-reworded'], { 'p-reworded': { bridge: 'A line.', approved_reason: { state: 'approved', reason: 'The old wording.' } } })
    compose.fn.mockResolvedValue(carried('p-reworded'))
    const result = await handleUploadLeads(ORG)
    expect(result).toMatchObject({ ok: true, outcomes: [], heldWithoutApprovedReasonCount: 1, heldWithoutFollowupCount: 0 })
    expect(upload.fn).not.toHaveBeenCalled()
    expect(row('p-reworded').outbound_upload_error).toContain('has since been reworded or removed')
  })

  it('PLANTED: the reason hold is reported, not the thread hold, when a prospect fails both', async () => {
    // Told to run the backfill, the operator would be sent to a script that cannot help.
    seed(['p-old'], { 'p-old': null })
    compose.fn.mockResolvedValue(composed('p-old', 'research', { 2: 'none_stored', 3: 'none_stored' }))
    const result = await handleUploadLeads(ORG)
    expect(result).toMatchObject({ ok: true, heldWithoutApprovedReasonCount: 1, heldWithoutFollowupCount: 0 })
    expect(row('p-old').outbound_upload_error).toMatch(/^opening_without_approved_reason: /)
  })

  it('the rule is about the research tier only, and a client with no approved reasons is not held to one (controls)', async () => {
    seed(['p-fact', 'p-template'], { 'p-fact': null, 'p-template': null })
    compose.fn.mockImplementation(async ({ prospect_id }: { prospect_id: string }) =>
      composed(prospect_id, prospect_id === 'p-fact' ? 'firm_fact' : 'template', { 2: 'not_assigned', 3: 'not_assigned' }))
    const tiers = await handleUploadLeads(ORG)
    expect(tiers).toMatchObject({ ok: true, heldWithoutApprovedReasonCount: 0 })

    upload.fn.mockClear()
    icpTriggers = [{ trigger: 'Added equipment', reason: '' }, 'Won an award']
    seed(['p-old'], { 'p-old': null })
    compose.fn.mockResolvedValue(carried('p-old'))
    const noReasons = await handleUploadLeads(ORG)
    expect(noReasons).toMatchObject({ ok: true, heldWithoutApprovedReasonCount: 0 })
    expect((upload.fn.mock.calls[0][2] as unknown[]).length).toBe(1)
  })

  it('PLANTED: a failed read of the trigger reasons stops the upload; it is never read as "no reasons"', async () => {
    seed(['p-old'], { 'p-old': null })
    compose.fn.mockResolvedValue(carried('p-old'))
    icpReadError = 'gateway timeout'
    const result = await handleUploadLeads(ORG)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ error: expect.stringContaining('gateway timeout') })
    expect(upload.fn).not.toHaveBeenCalled()
    // And the claim is released: nothing is left stuck in 'uploading'.
    expect(row('p-old').outbound_upload_status).toBe('pending')
  })

  it('PLANTED: the action asks for the record the verdict reads', async () => {
    seed(['p-ok'])
    compose.fn.mockResolvedValue(carried('p-ok'))
    await handleUploadLeads(ORG)
    expect(prospectSelects.some(columns => columns.includes('opening_judge:trigger_data->judge'))).toBe(true)
  })
})

describe('handleUploadLeads: the reclaim releases only rows still claimed', () => {
  it('PLANTED: a prospect whose composition failed stays failed when the others were held', async () => {
    // The reclaim reset every claimed id to pending, so a row just marked failed read as
    // pending again while the panel said it had been marked failed.
    seed(['p-held', 'p-broken'])
    compose.fn.mockImplementation(async ({ prospect_id }: { prospect_id: string }) => {
      if (prospect_id === 'p-broken') throw new Error('composition failed for this one')
      return composed('p-held', 'research', { 2: 'none_stored', 3: 'none_stored' })
    })
    await handleUploadLeads(ORG)
    // The failure write is not awaited by the action: let it land.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(row('p-broken').outbound_upload_status).toBe('failed')
    expect(row('p-held').outbound_upload_status).toBe('pending')
  })

  // The same rule at the other two places the action releases its claim. Both run AFTER
  // composition, so a prospect already marked failed is among the claimed ids. A review on
  // 2026-10-01 found the fix above had reached one release of three.
  const oneComposesOneThrows = () => {
    seed(['p-ok', 'p-broken'])
    compose.fn.mockImplementation(async ({ prospect_id }: { prospect_id: string }) => {
      if (prospect_id === 'p-broken') throw new Error('composition failed for this one')
      // Personalised, held to a current reason, both follow-ups carried: nothing holds it.
      return composed('p-ok', 'research', { 2: null, 3: null })
    })
  }

  // The check runs TWICE in one upload: before the claim, and again after composition. The
  // planted answer is for the second. The call count is asserted so a test whose planted
  // answer was taken by the first call cannot pass for the wrong reason.
  const finalCheckAnswers = (answer: unknown) => {
    vi.mocked(findBlockedProspects).mockClear()
    vi.mocked(findBlockedProspects)
      .mockResolvedValueOnce({ ok: true, blocked: new Map() } as never)
      .mockResolvedValueOnce(answer as never)
  }

  it('PLANTED: the final check cannot be read: the failed prospect stays failed, the other is released', async () => {
    oneComposesOneThrows()
    finalCheckAnswers({ ok: false, error: 'read failed' })
    const result = await handleUploadLeads(ORG)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(findBlockedProspects).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('Final rejection check failed')
    expect(upload.fn).not.toHaveBeenCalled()
    expect(row('p-broken').outbound_upload_status).toBe('failed')
    expect(row('p-ok').outbound_upload_status).toBe('pending')
  })

  it('PLANTED: the final check rejects the only composed prospect: the failed one stays failed', async () => {
    oneComposesOneThrows()
    finalCheckAnswers({ ok: true, blocked: new Map([['p-ok', 'client_rejected']]) })
    await handleUploadLeads(ORG)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(findBlockedProspects).toHaveBeenCalledTimes(2)
    expect(upload.fn).not.toHaveBeenCalled()
    expect(row('p-broken').outbound_upload_status).toBe('failed')
    expect(row('p-ok').outbound_upload_status).toBe('failed')
  })
})


describe('handleUploadLeads: the upload hold (2026-10-03)', () => {
  it('PLANTED: a held client uploads nothing, claims nothing, and is told why', async () => {
    seed(['p-1', 'p-2'])
    hold = { outbound_upload_hold: true, outbound_upload_hold_note: 'copy is being rewritten' }
    compose.fn.mockImplementation(async ({ prospect_id }: { prospect_id: string }) => composed(prospect_id, 'template', { 2: 'not_assigned', 3: 'not_assigned' }))
    const result = await handleUploadLeads(ORG)
    expect(result).toEqual({ ok: false, error: 'Uploads are on hold for this client (copy is being rewritten). Nothing was uploaded.' })
    expect(upload.fn).not.toHaveBeenCalled()
    expect(compose.fn).not.toHaveBeenCalled()
    expect(prospects.every(p => p.outbound_upload_status === 'pending')).toBe(true)
  })

  it('PLANTED: a hold that cannot be read is treated as a hold', async () => {
    seed(['p-1'])
    holdReadError = 'gateway timeout'
    const result = await handleUploadLeads(ORG)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('could not read whether uploads are held')
    expect(upload.fn).not.toHaveBeenCalled()
  })

  it('a client with no hold uploads as before (control)', async () => {
    seed(['p-1'])
    compose.fn.mockImplementation(async ({ prospect_id }: { prospect_id: string }) => composed(prospect_id, 'template', { 2: 'not_assigned', 3: 'not_assigned' }))
    const result = await handleUploadLeads(ORG)
    if (!result.ok) throw new Error(`expected an upload, got: ${result.error}`)
    expect(upload.fn).toHaveBeenCalledTimes(1)
  })
})

describe('handleUploadLeads: writer v2 (ADR-068)', () => {
  /** What composeSequence throws when a writer v2 client's prospect has nothing that may ship. */
  const notReady = (why: string) => Object.assign(new Error(`writer v2: ${why}`), { name: 'WriterV2NotReadyError', why })
  const v2 = (id: string) => ({
    ...composed(id, 'research', { 2: null, 3: null }),
    variant_id: null,
    opening: { tier: 'writer_v2', detail: null },
    writer: { version: 'v2', tier: 'personalised', playbook_version: 1 },
  })

  it('PLANTED: no shippable sequence is HELD, not failed, with the reason on the row, and never sent', async () => {
    seed(['p-ready', 'p-waiting'])
    compose.fn.mockImplementation(async ({ prospect_id }: { prospect_id: string }) => {
      if (prospect_id === 'p-waiting') throw notReady('no writer v2 sequence has been written for this prospect yet')
      return v2('p-ready')
    })
    const result = await handleUploadLeads(ORG)
    if (!result.ok) throw new Error(`expected an upload, got: ${result.error}`)
    expect(result.heldWithoutWriterV2Count).toBe(1)
    expect(result.compositionFailureCount).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(row('p-waiting').outbound_upload_status).toBe('pending')
    expect(row('p-waiting').outbound_upload_error).toBe('writer v2: no writer v2 sequence has been written for this prospect yet')
    expect((upload.fn.mock.calls[0][2] as Array<{ email: string }>).map(l => l.email)).toEqual(['p-ready@example.invalid'])
  })

  it('PLANTED: the old-path holds do not apply: a v2 sequence with no approved-reason record is sent and recorded', async () => {
    seed(['p-v2'], { 'p-v2': null })
    compose.fn.mockResolvedValue(v2('p-v2'))
    const result = await handleUploadLeads(ORG)
    if (!result.ok) throw new Error(`expected an upload, got: ${result.error}`)
    expect(result.heldWithoutApprovedReasonCount).toBe(0)
    expect(result.heldWithoutFollowupCount).toBe(0)
    expect(upload.fn).toHaveBeenCalledTimes(1)
    expect(record.fn.mock.calls.map(c => c[2])).toEqual(['p-v2'])
  })

  it('every prospect held for writer v2: the operator gets the count, not a generic error', async () => {
    seed(['p-waiting'])
    compose.fn.mockRejectedValue(notReady('the stored writer v2 sequence was written from a trial playbook file, not the approved messaging document'))
    const result = await handleUploadLeads(ORG)
    expect(result).toMatchObject({ ok: true, outcomes: [], heldWithoutWriterV2Count: 1 })
    expect(upload.fn).not.toHaveBeenCalled()
  })
})
