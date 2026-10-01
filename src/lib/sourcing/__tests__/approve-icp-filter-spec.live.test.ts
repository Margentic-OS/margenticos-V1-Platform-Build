// ADR-061 step 5, against the real functions in the TEST database.
//
// The unit tests beside this file prove what the approval DECIDES: which refusals, whether
// to reset the cursor, whether to re-queue. This file proves what the database functions
// DO with those decisions, and that a refusal leaves every row exactly as it was.
//
// "Exactly as it was" is a comparison of two snapshots, so each refusal test takes one
// before and one after. The first test in the file shows a snapshot changing when an
// approval goes through, which is what makes an unchanged one mean something.
//
// Every organisation and the one user here are created by this file and deleted by this
// file, by id. Most settings are placeholder objects: the functions compare and copy jsonb
// and never read inside it. The last block uses real-shaped settings because it runs the
// whole approval, which does.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient } from '@/test-utils/test-database'
import { deleteTestOrganisations } from '@/test-utils/delete-test-organisations'

const registry = vi.hoisted(() => ({ resolve: vi.fn() }))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
// The test database registers no sourcing handler, and which handler is active is not what
// this file is about. The real one is taken from the dispatch map and handed back.
vi.mock('@/lib/sourcing/handler-registry', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sourcing/handler-registry')>()),
  resolveActiveSourcingHandler: (...args: unknown[]) => registry.resolve(...args),
}))

import {
  approvalFingerprint,
  approveIcpFilterSpecProposal,
  exclusionKey,
  rejectIcpFilterSpecProposal,
} from '@/lib/sourcing/approve-icp-filter-spec'
import { HANDLER_DISPATCH } from '@/lib/sourcing/handler-registry'
import { diffSettings } from '@/lib/sourcing/settings-diff'
import type { CanonicalIndustry, ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import { targetingInputs } from '@/lib/sourcing/targeting-inputs'
import { aGeography } from '@/test-utils/geography-fixture'
import { someBands } from '@/test-utils/seniority-fixture'

const CONTEXT = 'approve-icp-filter-spec.live.test.ts'

let service: SupabaseClient<Database>
let untyped: SupabaseClient
let operatorId: string
const created: string[] = []

const LIVE = { marker: 'live settings', list: ['a', 'b'], nested: { n: 1 } }
const PROPOSAL = { marker: 'the proposal', list: ['a', 'c'], nested: { n: 2 } }
const NOBODY = '00000000-0000-4000-8000-000000000000'

async function seedOrganisation(label: string): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data, error } = await service
    .from('organisations')
    .insert({ name: `${label} ${stamp}`, slug: `${label}-${stamp}` })
    .select('id')
    .single()
  expect(error).toBeNull()
  created.push(data!.id)
  return data!.id
}

async function seedDocument(
  organisationId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const { data, error } = await untyped
    .from('strategy_documents')
    .insert({
      organisation_id: organisationId,
      document_type: 'icp',
      status: 'active',
      version: '1',
      content: { words: 'placeholder' },
      icp_filter_spec: LIVE,
      icp_filter_spec_proposed: PROPOSAL,
      ...extra,
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  return data!.id as string
}

/** A client with settings, a proposal, a place in the search and five prospects. */
async function seedClient(label: string, docExtra: Record<string, unknown> = {}) {
  const organisationId = await seedOrganisation(label)
  const documentId = await seedDocument(organisationId, docExtra)
  const { error: cursorError } = await untyped.from('sourcing_cursors').insert({
    organisation_id: organisationId, icp_document_id: documentId, record_offset: 500,
  })
  expect(cursorError).toBeNull()
  const { error: prospectError } = await untyped.from('prospects').insert([
    { organisation_id: organisationId, sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)' },
    { organisation_id: organisationId, sourced_tier: 'tier_2', tiering_reason: 'tier_2 (score 60)' },
    { organisation_id: organisationId, sourced_tier: null, tiering_reason: 'industry_off_target' },
    { organisation_id: organisationId, sourced_tier: null, tiering_reason: 'not_decision_maker' },
    { organisation_id: organisationId, sourced_tier: null, tiering_reason: null },
  ])
  expect(prospectError).toBeNull()
  return { organisationId, documentId }
}

/** Everything an approval or a rejection could touch, for one organisation. */
async function snapshot(organisationId: string) {
  const { data: docs, error: docError } = await untyped
    .from('strategy_documents')
    .select('id, status, content, icp_filter_spec, icp_filter_spec_proposed, icp_filter_spec_approved_at, icp_filter_spec_approved_by')
    .eq('organisation_id', organisationId).order('id')
  expect(docError).toBeNull()
  const { data: cursors, error: cursorError } = await untyped
    .from('sourcing_cursors').select('icp_document_id, record_offset')
    .eq('organisation_id', organisationId)
  expect(cursorError).toBeNull()
  const { data: prospects, error: prospectError } = await untyped
    .from('prospects').select('sourced_tier, tiering_reason')
    .eq('organisation_id', organisationId)
  expect(prospectError).toBeNull()
  const reasons = prospects!
    .map(p => `${p.sourced_tier ?? 'none'}|${p.tiering_reason ?? 'none'}`).sort()
  return { docs: docs!, cursors: cursors!, reasons }
}

interface ApproveArgs {
  proposal?: unknown
  live?: unknown
  by?: string
  reset?: boolean
  requeue?: boolean
}

async function callApprove(documentId: string, args: ApproveArgs = {}) {
  const { data, error } = await untyped.rpc('approve_icp_filter_spec_proposal', {
    p_document_id: documentId,
    p_expected_proposal: 'proposal' in args ? args.proposal : PROPOSAL,
    p_expected_live: 'live' in args ? args.live : LIVE,
    p_approved_by: args.by ?? operatorId,
    p_reset_cursor: args.reset ?? false,
    p_requeue: args.requeue ?? false,
  })
  expect(error).toBeNull()
  return data as Record<string, unknown>
}

async function callReject(documentId: string, proposal: unknown = PROPOSAL) {
  const { data, error } = await untyped.rpc('reject_icp_filter_spec_proposal', {
    p_document_id: documentId, p_expected_proposal: proposal,
  })
  expect(error).toBeNull()
  return data as Record<string, unknown>
}

beforeAll(async () => {
  service = createTestServiceClient(CONTEXT)
  untyped = service as SupabaseClient

  // icp_filter_spec_approved_by references users(id), so the approver has to exist.
  const email = `approve-spec-operator-${Date.now()}@test.local`
  const { data: authUser, error: authError } = await service.auth.admin.createUser({
    email, password: `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`, email_confirm: true,
  })
  expect(authError).toBeNull()
  operatorId = authUser!.user!.id
  const { error: userError } = await untyped.from('users').insert({
    id: operatorId, email: authUser!.user!.email!, role: 'operator',
  })
  expect(userError).toBeNull()

  const handlers = Object.values(HANDLER_DISPATCH)
  if (handlers.length === 0) throw new Error(`${CONTEXT}: no sourcing handler is registered`)
  registry.resolve.mockResolvedValue(handlers[0])
})

afterAll(async () => {
  if (created.length > 0) await deleteTestOrganisations(service, created, CONTEXT)
  if (operatorId) {
    await untyped.from('users').delete().eq('id', operatorId)
    await service.auth.admin.deleteUser(operatorId)
  }
})

// ═════════════════════════════════════════════════════════════════════════════

describe('approve_icp_filter_spec_proposal: what an approval writes', () => {
  it('replaces the settings, clears the proposal and stamps who and when, and touches nothing else when both switches are off', async () => {
    const { organisationId, documentId } = await seedClient('approve-plain')
    const before = await snapshot(organisationId)
    const startedAt = Date.now()

    const answer = await callApprove(documentId)

    expect(answer).toEqual({
      applied: true, organisation_id: organisationId,
      cursor_reset: false, previous_offset: null, requeued_count: 0,
    })
    const after = await snapshot(organisationId)
    // CONTROL for every "nothing changed" below: a snapshot does change.
    expect(after).not.toEqual(before)

    const doc = after.docs[0]
    expect(doc.icp_filter_spec).toEqual(PROPOSAL)
    expect(doc.icp_filter_spec_proposed).toBeNull()
    expect(doc.icp_filter_spec_approved_by).toBe(operatorId)
    const stampedAt = new Date(doc.icp_filter_spec_approved_at as string).getTime()
    expect(Math.abs(stampedAt - startedAt)).toBeLessThan(120_000)
    expect(doc.status).toBe('active')
    expect(doc.content).toEqual({ words: 'placeholder' })

    expect(after.cursors).toEqual(before.cursors)
    expect(after.reasons).toEqual(before.reasons)
  })

  it('approves a client\'s FIRST settings, where there is nothing live', async () => {
    const organisationId = await seedOrganisation('approve-first')
    const documentId = await seedDocument(organisationId, { icp_filter_spec: null })

    const answer = await callApprove(documentId, { live: null, reset: true, requeue: true })

    // No cursor row, so nothing was reset, and nobody to re-queue.
    expect(answer).toMatchObject({ applied: true, cursor_reset: false, previous_offset: null, requeued_count: 0 })
    const { docs } = await snapshot(organisationId)
    expect(docs[0].icp_filter_spec).toEqual(PROPOSAL)
    expect(docs[0].icp_filter_spec_proposed).toBeNull()
  })

  it('accepts the same proposal with its keys in another order: the comparison is of values', async () => {
    const { documentId } = await seedClient('approve-key-order')
    const reordered = { nested: { n: 2 }, list: ['a', 'c'], marker: 'the proposal' }
    expect((await callApprove(documentId, { proposal: reordered })).applied).toBe(true)
  })
})

describe('approve_icp_filter_spec_proposal: the cursor', () => {
  it('resets the offset to zero when told to, and reports where it was', async () => {
    const { organisationId, documentId } = await seedClient('approve-reset')

    const answer = await callApprove(documentId, { reset: true })

    expect(answer).toMatchObject({ applied: true, cursor_reset: true, previous_offset: 500 })
    expect((await snapshot(organisationId)).cursors)
      .toEqual([{ icp_document_id: documentId, record_offset: 0 }])
  })

  it('leaves the offset alone when not told to', async () => {
    const { organisationId, documentId } = await seedClient('approve-keep')

    await callApprove(documentId, { reset: false, requeue: true })

    expect((await snapshot(organisationId)).cursors)
      .toEqual([{ icp_document_id: documentId, record_offset: 500 }])
  })

  it('never touches another organisation\'s cursor', async () => {
    const mine = await seedClient('approve-reset-mine')
    const other = await seedClient('approve-reset-other')
    const otherBefore = await snapshot(other.organisationId)

    await callApprove(mine.documentId, { reset: true, requeue: true })

    expect(await snapshot(other.organisationId)).toEqual(otherBefore)
  })
})

describe('approve_icp_filter_spec_proposal: the re-queue', () => {
  it('clears the reason on REMOVED prospects only, and reports how many', async () => {
    const { organisationId, documentId } = await seedClient('approve-requeue')

    const answer = await callApprove(documentId, { requeue: true })

    expect(answer).toMatchObject({ applied: true, requeued_count: 2 })
    // The two survivors keep their tier and their reason. The two removed rows are back to
    // "not yet tiered". The row that was never tiered is as it was.
    expect((await snapshot(organisationId)).reasons).toEqual([
      'none|none', 'none|none', 'none|none',
      'tier_1|tier_1 (score 90)', 'tier_2|tier_2 (score 60)',
    ])
  })

  it('re-queues nobody when not told to', async () => {
    const { organisationId, documentId } = await seedClient('approve-no-requeue')
    const before = await snapshot(organisationId)

    const answer = await callApprove(documentId, { reset: true, requeue: false })

    expect(answer).toMatchObject({ applied: true, requeued_count: 0 })
    expect((await snapshot(organisationId)).reasons).toEqual(before.reasons)
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('approve_icp_filter_spec_proposal: every refusal leaves every row as it was', () => {
  async function refused(
    seed: { organisationId: string; documentId: string },
    args: ApproveArgs,
    expected: string,
    documentId = seed.documentId,
  ) {
    const before = await snapshot(seed.organisationId)
    const answer = await callApprove(documentId, { reset: true, requeue: true, ...args })
    expect(answer).toEqual({ applied: false, refused: expected })
    expect(await snapshot(seed.organisationId)).toEqual(before)
  }

  it('not_found', async () => {
    const seed = await seedClient('refuse-not-found')
    await refused(seed, {}, 'not_found', NOBODY)
  })

  it('not_icp: another document type carrying a stray proposal', async () => {
    const seed = await seedClient('refuse-not-icp', { document_type: 'positioning' })
    await refused(seed, {}, 'not_icp')
  })

  it('not_active: an archived version that still carries the proposal', async () => {
    const seed = await seedClient('refuse-not-active', { status: 'archived' })
    await refused(seed, {}, 'not_active')
  })

  it('no_proposal', async () => {
    const seed = await seedClient('refuse-no-proposal', { icp_filter_spec_proposed: null })
    await refused(seed, {}, 'no_proposal')
  })

  it('changed_since_shown: the stored proposal is not the one named', async () => {
    const seed = await seedClient('refuse-proposal-changed')
    await refused(seed, { proposal: { ...PROPOSAL, list: ['a', 'd'] } }, 'changed_since_shown')
  })

  it('changed_since_shown: the proposal named has its list in another ORDER', async () => {
    // Key order is not a difference. List order is: the stored value is what was shown.
    const seed = await seedClient('refuse-proposal-order')
    await refused(seed, { proposal: { ...PROPOSAL, list: ['c', 'a'] } }, 'changed_since_shown')
  })

  it('changed_since_shown: the LIVE settings are not the ones the caller judged', async () => {
    const seed = await seedClient('refuse-live-changed')
    await refused(seed, { live: { ...LIVE, nested: { n: 9 } } }, 'changed_since_shown')
  })

  it('changed_since_shown: the caller judged "no live settings" and there are some', async () => {
    const seed = await seedClient('refuse-live-appeared')
    await refused(seed, { live: null }, 'changed_since_shown')
  })

  it('changed_since_shown: the caller judged live settings and there are none', async () => {
    const seed = await seedClient('refuse-live-vanished', { icp_filter_spec: null })
    await refused(seed, { live: LIVE }, 'changed_since_shown')
  })

  describe('sourcing_in_progress', () => {
    async function seedRun(organisationId: string, status: string, minutesAgo: number) {
      const { error } = await untyped.from('sourcing_runs').insert({
        organisation_id: organisationId,
        status,
        target_batch_size: 10,
        trigger_type: 'operator_manual',
        started_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      })
      expect(error).toBeNull()
    }

    it('refuses a cursor reset while a run for this organisation is running', async () => {
      const seed = await seedClient('refuse-run-live')
      await seedRun(seed.organisationId, 'running', 1)
      await refused(seed, { reset: true }, 'sourcing_in_progress')
    })

    it('does not refuse when the approval keeps the offset: the run\'s place is still valid', async () => {
      const seed = await seedClient('allow-run-no-reset')
      await seedRun(seed.organisationId, 'running', 1)
      expect((await callApprove(seed.documentId, { reset: false, requeue: true })).applied).toBe(true)
    })

    it('does not refuse for a run that finished', async () => {
      const seed = await seedClient('allow-run-done')
      await seedRun(seed.organisationId, 'completed', 1)
      expect((await callApprove(seed.documentId, { reset: true })).applied).toBe(true)
    })

    it('does not refuse for a run left "running" longer than a run can last', async () => {
      // A run that crashed without closing its record must not block approvals for ever.
      const seed = await seedClient('allow-run-stale')
      await seedRun(seed.organisationId, 'running', 20)
      expect((await callApprove(seed.documentId, { reset: true })).applied).toBe(true)
    })

    it('does not refuse for ANOTHER organisation\'s run', async () => {
      const seed = await seedClient('allow-run-other')
      const other = await seedOrganisation('allow-run-other-org')
      await seedRun(other, 'running', 1)
      expect((await callApprove(seed.documentId, { reset: true })).applied).toBe(true)
    })
  })

  it('raises, and writes nothing, when the approver or a decision is missing', async () => {
    const seed = await seedClient('refuse-missing-args')
    const before = await snapshot(seed.organisationId)
    const { error } = await untyped.rpc('approve_icp_filter_spec_proposal', {
      p_document_id: seed.documentId, p_expected_proposal: PROPOSAL, p_expected_live: LIVE,
      p_approved_by: null, p_reset_cursor: false, p_requeue: false,
    })
    expect(error).not.toBeNull()
    expect(await snapshot(seed.organisationId)).toEqual(before)
  })

  it('rolls the whole approval back when the stamp cannot be written', async () => {
    // An approver who is not a user breaks the foreign key AFTER the checks have passed.
    // The cursor reset and the re-queue sit after that write, so a rolled-back approval
    // must leave them unmade as well as the settings.
    const seed = await seedClient('refuse-rollback')
    const before = await snapshot(seed.organisationId)
    const { error } = await untyped.rpc('approve_icp_filter_spec_proposal', {
      p_document_id: seed.documentId, p_expected_proposal: PROPOSAL, p_expected_live: LIVE,
      p_approved_by: NOBODY, p_reset_cursor: true, p_requeue: true,
    })
    expect(error).not.toBeNull()
    expect(await snapshot(seed.organisationId)).toEqual(before)
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('reject_icp_filter_spec_proposal', () => {
  it('clears the proposal and changes nothing else at all', async () => {
    const { organisationId, documentId } = await seedClient('reject-plain', {
      icp_filter_spec_approved_at: '2026-01-02T03:04:05.000Z',
    })
    const before = await snapshot(organisationId)

    expect(await callReject(documentId)).toEqual({ rejected: true, organisation_id: organisationId })

    const after = await snapshot(organisationId)
    expect(after.docs[0].icp_filter_spec_proposed).toBeNull()
    // Put the proposal back in the "after" picture and it is the "before" picture.
    expect({ ...after, docs: [{ ...after.docs[0], icp_filter_spec_proposed: PROPOSAL }] }).toEqual(before)
  })

  it.each([
    ['not_icp', { document_type: 'positioning' }, PROPOSAL],
    ['not_active', { status: 'archived' }, PROPOSAL],
    ['no_proposal', { icp_filter_spec_proposed: null }, PROPOSAL],
    ['changed_since_shown', {}, { ...PROPOSAL, list: ['a', 'd'] }],
  ] as const)('refuses with %s and leaves every row as it was', async (expected, docExtra, named) => {
    const seed = await seedClient(`reject-${expected.replace(/_/g, '-')}`, docExtra)
    const before = await snapshot(seed.organisationId)

    expect(await callReject(seed.documentId, named)).toEqual({ rejected: false, refused: expected })
    expect(await snapshot(seed.organisationId)).toEqual(before)
  })

  it('refuses with not_found for a document that does not exist', async () => {
    expect(await callReject(NOBODY)).toEqual({ rejected: false, refused: 'not_found' })
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('the whole approval, through the real plan and the real function', () => {
  const handler = () => Object.values(HANDLER_DISPATCH)[0]

  function settings(): ICPFilterSpec {
    const industries = handler().targeted_industries as readonly CanonicalIndustry[]
    const countries = aGeography().countries
    return {
      job_titles: ['title one', 'title two'],
      job_titles_excluded: ['excluded title one', 'excluded title two'],
      seniority_levels: someBands(2),
      person_countries: [...countries],
      company_countries: [...countries],
      company_headcount_min: 10,
      company_headcount_max: 90,
      industries: [industries[0], industries[1]],
      industries_excluded: [],
      keywords: ['keyword one'],
      keywords_excluded: [],
      company_revenue_min: null,
      company_revenue_max: null,
      omitted_axes: [],
      omission_reasons: {},
      notes: 'placeholder notes',
      unmatched_industries: [],
      buyer_criterion: {
        status: 'derived',
        accept: [{ fragment: 'title one', rank: 'primary' }],
        reject: ['excluded title one', 'excluded title two'],
        statement: 'A placeholder statement of who decides.',
        evidence: ['a placeholder line of evidence'],
        unsettled_reason: null,
        sanity: null,
        derived_at: '2026-01-01T00:00:00.000Z',
        model: 'test-model',
      },
      targeting_inputs: targetingInputs({}),
    }
  }

  async function run(change: (spec: ICPFilterSpec) => void, ticks: 'all' | 'none' = 'all') {
    const live = settings()
    const proposed = settings()
    change(proposed)
    const seed = await seedClient('approve-whole', { icp_filter_spec: live, icp_filter_spec_proposed: proposed })
    const before = await snapshot(seed.organisationId)
    const outcome = await approveIcpFilterSpecProposal(untyped, {
      documentId: seed.documentId,
      // Computed from what the database gives back, as the panel will compute it.
      fingerprint: approvalFingerprint(
        before.docs[0].icp_filter_spec as ICPFilterSpec,
        before.docs[0].icp_filter_spec_proposed as ICPFilterSpec,
      ),
      confirmedRemovals: ticks === 'all' ? diffSettings(live, proposed).removed_exclusions.map(exclusionKey) : [],
      approvedBy: operatorId,
    })
    return { outcome, seed, before, after: await snapshot(seed.organisationId), proposed }
  }

  it('a headcount ceiling change: settings live, cursor reset, removed prospects re-queued', async () => {
    const { outcome, seed, after, proposed } = await run(spec => { spec.company_headcount_max = 60 })

    expect(outcome).toEqual({
      outcome: 'approved', organisation_id: seed.organisationId,
      cursor_reset: true, previous_offset: 500, requeued_count: 2,
    })
    expect(after.docs[0].icp_filter_spec).toEqual(proposed)
    expect(after.docs[0].icp_filter_spec_proposed).toBeNull()
    expect(after.docs[0].icp_filter_spec_approved_by).toBe(operatorId)
    expect(after.cursors).toEqual([{ icp_document_id: seed.documentId, record_offset: 0 }])
    expect(after.reasons.filter(r => r === 'none|none')).toHaveLength(3)
  })

  it('an excluded title loosened, with its tick: settings live, offset KEPT, nobody re-queued', async () => {
    const { outcome, after, before } = await run(spec => { spec.job_titles_excluded = ['excluded title one'] })

    expect(outcome).toMatchObject({ outcome: 'approved', cursor_reset: false, requeued_count: 0 })
    expect(after.docs[0].icp_filter_spec_proposed).toBeNull()
    expect(after.cursors).toEqual(before.cursors)
    expect(after.reasons).toEqual(before.reasons)
  })

  it('the same change WITHOUT its tick is refused, and every row is as it was', async () => {
    const { outcome, after, before } = await run(
      spec => { spec.job_titles_excluded = ['excluded title one'] }, 'none')

    expect(outcome).toMatchObject({ outcome: 'refused', refused: 'exclusions_not_confirmed' })
    expect(after).toEqual(before)
  })

  it('a criterion that does not gate is refused, and every row is as it was', async () => {
    const { outcome, after, before } = await run(spec => {
      spec.buyer_criterion = { ...spec.buyer_criterion!, status: 'out_of_band' }
    })

    expect(outcome).toEqual({ outcome: 'refused', refused: 'criterion_does_not_gate' })
    expect(after).toEqual(before)
  })

  it('a rejection through the real function leaves the search exactly as it was', async () => {
    const live = settings()
    const proposed = settings()
    proposed.company_headcount_max = 60
    const seed = await seedClient('reject-whole', { icp_filter_spec: live, icp_filter_spec_proposed: proposed })
    const before = await snapshot(seed.organisationId)

    const outcome = await rejectIcpFilterSpecProposal(untyped, {
      documentId: seed.documentId,
      fingerprint: approvalFingerprint(
        before.docs[0].icp_filter_spec as ICPFilterSpec,
        before.docs[0].icp_filter_spec_proposed as ICPFilterSpec,
      ),
      rejectedBy: operatorId,
    })

    expect(outcome).toEqual({ outcome: 'rejected', organisation_id: seed.organisationId })
    const after = await snapshot(seed.organisationId)
    expect(after.docs[0].icp_filter_spec).toEqual(live)
    expect(after.docs[0].icp_filter_spec_proposed).toBeNull()
    expect(after.cursors).toEqual(before.cursors)
    expect(after.reasons).toEqual(before.reasons)
  })
})
