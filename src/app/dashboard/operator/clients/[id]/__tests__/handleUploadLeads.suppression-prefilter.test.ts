// The send-gate pre-filter, driven end to end through the real server action.
//
// WHAT THIS EXISTS TO CATCH, measured in production 2026-08-28:
//
//   Send gate pre-filter failed: global suppression check failed:
//   permission denied for table suppressed_emails
//
// handleUploadLeads passed its SESSION client to findBlockedProspects. suppressed_emails
// is service-role only by design: RLS enabled, zero policies, SELECT revoked from anon
// and authenticated BY NAME (verified live). The session client authenticates as
// `authenticated`, so the read is denied outright.
//
// TypeScript could not catch it. findBlockedProspects declares its parameter as
// `SupabaseServiceClient`, which is a bare alias for `SupabaseClient<Database>` — the
// exact type the session client has. The name says service role; the type does not
// enforce it. So the guard has to be a test, and the test has to model the GRANT, not
// just the data.
//
// Hence the session fake below REFUSES suppressed_emails with the real Postgres error.
// Pass the wrong client again and these tests fail with the production message rather
// than passing on data a real session client could never have read.
//
// The behavioural assertion is deliberately about the CLAIM, not about the return value:
// a suppressed address must never be transitioned pending -> uploading, because that is
// the transition that puts it into the send pipeline. Asserting `ok` would pass even if
// the suppressed prospect were claimed and sent.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`unexpected redirect to ${to}`) },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  flush: vi.fn(() => Promise.resolve()),
  // Must actually invoke the callback, or the action under test never runs.
  withServerActionInstrumentation: (_name: string, cb: () => unknown) => cb(),
}))

// Downstream of the claim. Stubbed so the test cannot reach composition or the outbound
// provider; if the pre-filter regressed such that execution got that far, a call here
// would be a loud failure rather than a silent send.
vi.mock('@/lib/integrations/handlers/instantly/validateCampaign', () => ({
  validateCampaign: vi.fn(() => { throw new Error('validateCampaign must not be reached') }),
}))
vi.mock('@/lib/integrations/handlers/instantly/uploadLeads', () => ({
  uploadLeads: vi.fn(() => { throw new Error('uploadLeads must not be reached') }),
}))
vi.mock('@/lib/integrations/handlers/instantly/orderMailboxes', () => ({
  orderMailboxes: vi.fn(),
}))
vi.mock('@/lib/integrations/handlers/instantly/syncSequenceShell', () => ({
  syncSequenceShell: vi.fn(),
  getDocStepCount: vi.fn(() => 4),
}))
vi.mock('@/lib/approval/assertStrategyApproved', () => ({
  assertStrategyApproved: vi.fn(() => ({ ok: true })),
}))
vi.mock('@/lib/composition/compose-sequence', () => ({
  fetchComposeDocs: vi.fn(),
  composeSequence: vi.fn(() => { throw new Error('composeSequence must not be reached') }),
  getComposeServiceClient: vi.fn(),
}))
vi.mock('@/lib/composition/custom-variables', () => ({
  composedToVariables: vi.fn(),
  assertCompleteVariables: vi.fn(),
}))
vi.mock('@/lib/email/send', () => ({ sendTransactionalEmail: vi.fn() }))

const ORG = 'org-under-test'
const CLEAN_ID = 'prospect-clean'
const SUPPRESSED_ID = 'prospect-suppressed'
const SUPPRESSED_EMAIL = 'bounced@example.invalid'
const CLEAN_EMAIL = 'reachable@example.invalid'

// Ids transitioned pending -> uploading by the claim. This is the observation that
// matters: presence here means the address entered the send pipeline.
let claimedIds: string[] = []

interface ProspectRow {
  id: string
  organisation_id: string
  email: string
  suppressed: boolean
  client_review_status: string
  outbound_upload_status: string
  sourced_tier: string | null
  email_send_eligible: boolean
}

let prospects: ProspectRow[] = []

// Counts every attempt to read suppressed_emails through the SESSION client. Any
// non-zero value means some call site is using the wrong client, whether or not that
// site happens to fail the behavioural assertions below.
let sessionSuppressedEmailReads = 0

// Emails present in suppressed_emails and not revoked.
let suppressions: { email: string; revoked_at: string | null }[] = []

/* eslint-disable @typescript-eslint/no-explicit-any */

function prospectsBuilder(mode: 'select' | 'update', patch?: Record<string, unknown>) {
  const eqs: [string, unknown][] = []
  const notNullCols: string[] = []
  let inIds: string[] | null = null
  let notIn: string[] = []

  function selected() {
    return prospects.filter(r =>
      eqs.every(([c, v]) => (r as any)[c] === v) &&
      notNullCols.every(c => (r as any)[c] !== null && (r as any)[c] !== undefined) &&
      (inIds === null || inIds.includes(r.id)) &&
      !notIn.includes(r.id)
    )
  }

  const builder: any = {
    select: () => builder,
    eq: (c: string, v: unknown) => { eqs.push([c, v]); return builder },
    // `.in('id', ids)` scopes gate 1 to the candidate set. Honoured, not swallowed:
    // drop it from production and gate 1 would inspect every prospect in the org.
    in: (_c: string, v: string[]) => { inIds = v; return builder },
    not: (c: string, op: string, v: string) => {
      if (c === 'id' && op === 'in') {
        notIn = v.replace(/^\(|\)$/g, '').split(',').filter(Boolean)
      } else if (op === 'is') {
        notNullCols.push(c)
      }
      return builder
    },
    lt: () => builder,
    is: () => builder,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    // Gate 1 terminates on `.or('suppressed.eq.true,client_review_status.eq.rejected')`.
    or: (_expr: string) => Promise.resolve({
      data: selected()
        .filter(r => r.suppressed === true || r.client_review_status === 'rejected')
        .map(r => ({ id: r.id, suppressed: r.suppressed, client_review_status: r.client_review_status })),
      error: null,
    }),
    then: (resolve: (v: unknown) => unknown) => resolve(run()),
  }

  function run() {
    const rows = selected()
    if (mode === 'update') {
      for (const r of rows) Object.assign(r, patch)
      if ((patch as any)?.outbound_upload_status === 'uploading') {
        claimedIds.push(...rows.map(r => r.id))
      }
    }
    return { data: rows.map(r => ({ id: r.id, email: r.email })), error: null }
  }

  return builder
}

function baseTables(table: string): any {
  if (table === 'users') {
    return {
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { role: 'operator' }, error: null }) }) }),
    }
  }
  if (table === 'segments') {
    return {
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    }
  }
  if (table === 'campaigns') {
    // No campaigns configured, so the action stops after the claim and never composes.
    const b: any = { select: () => b, eq: () => b, in: () => b, then: (r: any) => r({ data: [], error: null }) }
    return b
  }
  if (table === 'prospects') {
    return {
      select: () => prospectsBuilder('select'),
      update: (patch: Record<string, unknown>) => prospectsBuilder('update', patch),
    }
  }
  return null
}

// The SESSION client. Mirrors the live grants: it can read prospects, and it is DENIED
// suppressed_emails with the exact Postgres error production returned.
function makeSessionClient() {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'operator-1' } } }) },
    from(table: string) {
      if (table === 'suppressed_emails') {
        sessionSuppressedEmailReads += 1
        const b: any = {
          select: () => b, in: () => b, is: () => b,
          then: (resolve: (v: unknown) => unknown) =>
            resolve({ data: null, error: { message: 'permission denied for table suppressed_emails' } }),
        }
        return b
      }
      const t = baseTables(table)
      if (!t) throw new Error(`session client: unexpected table ${table}`)
      return t
    },
  } as any
}

// The SERVICE-ROLE client. Reads suppressed_emails, honouring both real filters:
// the `.in('email', batch)` batch and the `.is('revoked_at', null)` revocation filter.
function makeServiceClient() {
  return {
    from(table: string) {
      if (table === 'suppressed_emails') {
        const state: { emails?: string[] } = {}
        let revokedFilterApplied = false
        const b: any = {
          select: () => b,
          in: (_c: string, v: string[]) => { state.emails = v; return b },
          is: (c: string, v: unknown) => {
            if (c === 'revoked_at' && v === null) revokedFilterApplied = true
            return b
          },
          then: (resolve: (v: unknown) => unknown) => {
            const rows = suppressions.filter(s =>
              (state.emails ?? []).includes(s.email) &&
              // Honoured, not assumed: drop `.is('revoked_at', null)` from production
              // and a revoked address starts suppressing again, which this catches.
              (revokedFilterApplied ? s.revoked_at === null : true)
            )
            return resolve({ data: rows.map(s => ({ email: s.email })), error: null })
          },
        }
        return b
      }
      const t = baseTables(table)
      if (!t) throw new Error(`service client: unexpected table ${table}`)
      return t
    },
  } as any
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => makeSessionClient()),
}))
vi.mock('@/lib/supabase/service-role', () => ({
  createServiceRoleClient: vi.fn(async () => makeServiceClient()),
}))

import { handleUploadLeads } from '../actions'

function seed() {
  claimedIds = []
  sessionSuppressedEmailReads = 0
  prospects = [
    {
      id: CLEAN_ID, organisation_id: ORG, email: CLEAN_EMAIL, suppressed: false,
      client_review_status: 'approved', outbound_upload_status: 'pending',
      sourced_tier: 'tier_1', email_send_eligible: true,
    },
    {
      id: SUPPRESSED_ID, organisation_id: ORG, email: SUPPRESSED_EMAIL, suppressed: false,
      client_review_status: 'approved', outbound_upload_status: 'pending',
      sourced_tier: 'tier_1', email_send_eligible: true,
    },
  ]
  // Mirrors the shape of the one real production row from the bounce proof: a
  // normalised address, live (not revoked).
  suppressions = [{ email: SUPPRESSED_EMAIL, revoked_at: null }]
}

beforeEach(() => { seed(); vi.clearAllMocks() })

describe('handleUploadLeads suppression pre-filter', () => {
  it('never claims a globally suppressed address, and does claim a clean one', async () => {
    await handleUploadLeads(ORG)

    expect(claimedIds).toContain(CLEAN_ID)
    // The assertion this file exists for.
    expect(claimedIds).not.toContain(SUPPRESSED_ID)
  })

  it('reads suppressed_emails with the service-role client, not the session client', async () => {
    // If the action passes the session client, that fake returns the real
    // `permission denied` error, the gate fails closed, and no claim happens at all.
    const result = await handleUploadLeads(ORG)

    if (!result.ok) {
      expect(result.error).not.toContain('permission denied for table suppressed_emails')
    }
    // A claim happening at all proves the gate completed, which it can only do with a
    // client that can read the table.
    expect(claimedIds.length).toBeGreaterThan(0)
    // Covers every call site actually reached in this harness, not just the pre-filter.
    expect(sessionSuppressedEmailReads).toBe(0)
  })

  it('a revoked suppression stops blocking', async () => {
    suppressions = [{ email: SUPPRESSED_EMAIL, revoked_at: '2026-08-01T00:00:00Z' }]

    await handleUploadLeads(ORG)

    expect(claimedIds).toContain(SUPPRESSED_ID)
  })
})
