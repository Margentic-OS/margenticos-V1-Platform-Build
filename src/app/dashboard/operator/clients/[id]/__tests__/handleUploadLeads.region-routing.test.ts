// Regional campaigns, driven through the real upload action.
//
// Operator instruction 2026-10-05: GB and IE prospects go to the UK/IE campaign (08:00 to
// 18:00 Europe/London), everything else, including an unknown country, to the US campaign.
// campaign-routing.test.ts proves the router. This file proves the JOIN: the action reads
// each prospect's country and each campaign's region, and the batch handed to the sending
// tool for each campaign holds exactly the prospects routed to it.
//
// It also pins the shell check, which read a join the prospect select never fetched and so
// skipped every campaign. A second campaign that has not been synced must not take leads.
//
// Harness copied from handleUploadLeads.thread-hold.test.ts: everything downstream of the
// database is a stand-in, the action's own control flow is real.

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

// The provider's campaign controls, in memory. Calls are recorded in order.
const provider = vi.hoisted(() => ({ calls: [] as string[], limits: {} as Record<string, number | null> }))
vi.mock('@/lib/integrations/handlers/instantly/campaign-controls', () => ({
  createCampaignControls: () => ({
    readDailyLimit: async (ext: string) => { provider.calls.push(`read ${ext}`); return provider.limits[ext] ?? null },
    setDailyLimit: async (ext: string, n: number) => { provider.calls.push(`set ${ext} ${n}`); provider.limits[ext] = n },
    activate: async (ext: string) => { provider.calls.push(`activate ${ext}`) },
  }),
}))

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
  country: string | null
  outbound_upload_status: string
  outbound_upload_error: string | null
  /** What the real select reads as `opening_judge:trigger_data->judge`. */
  opening_judge?: unknown
}

let prospects: Row[] = []
/** The client's campaigns, as the action's select returns them. */
let campaigns: Array<{ id: string; external_id: string; shell_step_count: number | null; shell_segment_id: string | null; region_countries: string[] | null } & Record<string, unknown>> = []
/** organisations.outbound_daily_cap for the client under test. */
let dailyCap: number | null = null
/** Rows written to campaign_automation_log, and updates written to campaigns. */
let automationLog: Array<Record<string, unknown>> = []
let campaignUpdates: Array<{ id: unknown; patch: Record<string, unknown> }> = []
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
  if (table === 'campaign_automation_log') {
    if (kind === 'session') throw new Error('permission denied for table campaign_automation_log')
    return { insert: async (row: Record<string, unknown>) => { automationLog.push(row); return { error: null } } }
  }
  if (table === 'campaigns') {
    const b: any = {
      select: () => b, eq: () => b, in: () => b,
      update: (patch: Record<string, unknown>) => {
        const u: any = { eq: (c: string, v: unknown) => { if (c === 'id') campaignUpdates.push({ id: v, patch }); return u }, then: (r: any) => r({ error: null }) }
        return u
      },
      then: (r: any) => r({ data: campaigns.map(c => ({ ...c })), error: null }),
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
        : { data: filters.id === ORG ? { ...hold, outbound_daily_cap: dailyCap } : null, error: null }),
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

function seed(countries: Record<string, string | null>) {
  prospects = Object.entries(countries).map(([id, country]) => ({
    id, organisation_id: ORG, email: `${id}@example.invalid`, first_name: 'Sam', last_name: 'Reader',
    company_name: 'A Company', job_title: 'Owner', segment_id: null, country,
    outbound_upload_status: 'pending', outbound_upload_error: null,
    opening_judge: HELD_TO_REASON,
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


const US = { id: 'campaign-us', external_id: 'ext-us', shell_step_count: 4, shell_segment_id: null, region_countries: null }
const UKIE = { id: 'campaign-ukie', external_id: 'ext-ukie', shell_step_count: 4, shell_segment_id: null, region_countries: ['GB', 'IE'] }

/** campaign external id -> the prospect ids handed to the sending tool for it. */
function batches(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [, ext, leads, campaignId] of upload.fn.mock.calls as Array<[string, string, Array<{ email: string }>, string]>) {
    out[ext] = leads.map(l => l.email.split('@')[0]).sort()
    // The internal id travels with the batch: it is what prospects.campaign_id is set to.
    expect(campaignId).toBe(ext === 'ext-us' ? 'campaign-us' : 'campaign-ukie')
  }
  return out
}

beforeEach(() => {
  campaigns = [US, UKIE]
  compose.fn.mockImplementation(async ({ prospect_id }: { prospect_id: string }) =>
    composed(prospect_id, 'template', { 2: 'none_stored', 3: 'none_stored' }))
})

describe('handleUploadLeads: a prospect goes to the campaign for its country', () => {
  it('PLANTED: GB and IE to UK/IE; US, CA, DE and unknown to the catch-all', async () => {
    seed({ gb: 'GB', ie: 'IE', us: 'US', ca: 'CA', de: 'DE', unknown: null })

    const result = await handleUploadLeads(ORG)
    if (!result.ok) throw new Error(`expected an upload, got: ${result.error}`)

    expect(batches()).toEqual({ 'ext-ukie': ['gb', 'ie'], 'ext-us': ['ca', 'de', 'unknown', 'us'] })
  })

  it('a client with one catch-all campaign routes everyone to it, as before regions (control)', async () => {
    campaigns = [US]
    seed({ gb: 'GB', us: 'US', unknown: null })

    const result = await handleUploadLeads(ORG)
    if (!result.ok) throw new Error(`expected an upload, got: ${result.error}`)

    expect(batches()).toEqual({ 'ext-us': ['gb', 'unknown', 'us'] })
  })

  it('PLANTED: an ambiguous region setup sends nothing and says why on every row', async () => {
    campaigns = [US, { ...UKIE, region_countries: null }]
    seed({ gb: 'GB', us: 'US' })

    const result = await handleUploadLeads(ORG)

    expect(result.ok).toBe(false)
    expect(upload.fn).not.toHaveBeenCalled()
    for (const id of ['gb', 'us']) {
      expect(row(id).outbound_upload_status).toBe('failed')
      expect(row(id).outbound_upload_error).toMatch(/ambiguous/)
    }
  })

  it('PLANTED: a UK/IE campaign with no synced shell takes no leads; the US batch still goes', async () => {
    campaigns = [US, { ...UKIE, shell_step_count: null }]
    seed({ gb: 'GB', us: 'US' })

    const result = await handleUploadLeads(ORG)
    if (!result.ok) throw new Error(`expected an upload, got: ${result.error}`)

    expect(batches()).toEqual({ 'ext-us': ['us'] })
    expect(result.shellBlockedCampaigns).toEqual([
      { campaignExternalId: 'ext-ukie', reason: 'no_shell', docStepCount: 4, shellStepCount: null },
    ])
  })

  it('PLANTED: a campaign whose shell has a different step count takes no leads', async () => {
    campaigns = [{ ...US, shell_step_count: 3 }, UKIE]
    seed({ gb: 'GB', us: 'US' })

    const result = await handleUploadLeads(ORG)
    if (!result.ok) throw new Error(`expected an upload, got: ${result.error}`)

    expect(batches()).toEqual({ 'ext-ukie': ['gb'] })
    expect(result.shellBlockedCampaigns).toEqual([
      { campaignExternalId: 'ext-us', reason: 'shell_out_of_sync', docStepCount: 4, shellStepCount: 3 },
    ])
  })

  it('the action selects the prospect country it routes on', async () => {
    seed({ us: 'US' })
    await handleUploadLeads(ORG)
    expect(prospectSelects.some(s => /\bcountry\b/.test(s))).toBe(true)
  })
})


// ── A regional campaign switches itself on with its first leads (2026-10-05) ──
describe('handleUploadLeads: automatic activation of a regional campaign', () => {
  const PAUSED_UKIE = { ...UKIE, name: 'UK/IE', status: 'paused', sent_count: 0, auto_activated_at: null, daily_limit_share: 15 }
  const LIVE_US = { ...US, name: 'US', status: 'active', sent_count: 812, auto_activated_at: null, daily_limit_share: null }

  beforeEach(() => {
    provider.calls.length = 0
    provider.limits = { 'ext-us': 90, 'ext-ukie': 15 }
    automationLog = []
    campaignUpdates = []
    dailyCap = 90
  })

  it('PLANTED: GB leads reach the paused UK/IE campaign: US lowered to 75, UK/IE activated, both logged with the service client', async () => {
    campaigns = [LIVE_US, PAUSED_UKIE]
    seed({ gb: 'GB', us: 'US' })

    const result = await handleUploadLeads(ORG)
    if (!result.ok) throw new Error(`expected an upload, got: ${result.error}`)

    // The leads went out first, and the activation came after them.
    expect(batches()).toEqual({ 'ext-ukie': ['gb'], 'ext-us': ['us'] })
    expect(provider.calls.filter(c => !c.startsWith('read'))).toEqual(['set ext-us 75', 'activate ext-ukie'])
    expect(automationLog.map(r => [r.action, r.campaign_id, r.from_value, r.to_value, r.organisation_id])).toEqual([
      ['daily_limit_set', 'campaign-us', '90', '75', ORG],
      ['activated', 'campaign-ukie', 'paused', 'active', ORG],
    ])
    expect(campaignUpdates).toEqual([{ id: 'campaign-ukie', patch: expect.objectContaining({ status: 'active', auto_activated_at: expect.any(String) }) }])
    expect(result.campaignAutomation?.map(e => e.action)).toEqual(['daily_limit_set', 'activated'])
  })

  it('PLANTED: an upload with no GB or IE prospect leaves UK/IE paused and US at 90', async () => {
    campaigns = [LIVE_US, PAUSED_UKIE]
    seed({ us: 'US', unknown: null })

    const result = await handleUploadLeads(ORG)
    if (!result.ok) throw new Error(`expected an upload, got: ${result.error}`)

    expect(provider.calls).toEqual([])
    expect(automationLog).toEqual([])
    expect(provider.limits['ext-us']).toBe(90)
  })

  it('PLANTED: a client with no daily cap: leads are uploaded, the campaign stays paused, and the refusal is logged', async () => {
    dailyCap = null
    campaigns = [LIVE_US, PAUSED_UKIE]
    seed({ gb: 'GB' })

    const result = await handleUploadLeads(ORG)
    if (!result.ok) throw new Error(`expected an upload, got: ${result.error}`)

    expect(batches()).toEqual({ 'ext-ukie': ['gb'] })
    expect(provider.calls).toEqual([])
    expect(automationLog).toEqual([expect.objectContaining({ action: 'refused', campaign_id: 'campaign-ukie' })])
  })

  it('a UK/IE campaign already switched on once is never switched on again by an upload', async () => {
    campaigns = [LIVE_US, { ...PAUSED_UKIE, auto_activated_at: '2026-10-06T08:00:00Z' }]
    seed({ gb: 'GB' })

    await handleUploadLeads(ORG)

    expect(provider.calls).toEqual([])
    expect(automationLog).toEqual([])
  })
})
