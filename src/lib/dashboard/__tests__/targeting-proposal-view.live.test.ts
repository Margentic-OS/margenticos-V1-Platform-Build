// ADR-061 step 6, against the TEST database: the panel says what the approval then does.
//
// The unit test beside this file proves the panel's numbers against a fake that honours
// its filters. This one runs the same builder against real rows, then approves with what
// the panel handed back, through the real approval and the real database function, and
// compares what happened with what was shown.
//
//   shown: 3 removed prospects go back into tiering     happened: 3 rows re-queued
//   shown: the search changes, the client starts again  happened: offset 500 -> 0
//
// Every organisation and the one user here are created by this file and deleted by this
// file, by id. No value names a real industry, role, band or country.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { createTestServiceClient } from '@/test-utils/test-database'
import { deleteTestOrganisations } from '@/test-utils/delete-test-organisations'

const registry = vi.hoisted(() => ({ resolve: vi.fn() }))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
// The test database registers no sourcing handler. The real one is taken from the
// dispatch map and handed back, for the panel and the approval alike.
vi.mock('@/lib/sourcing/handler-registry', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sourcing/handler-registry')>()),
  resolveActiveSourcingHandler: (...args: unknown[]) => registry.resolve(...args),
}))

import { buildProposalPanel } from '@/lib/dashboard/targeting-proposal-view'
import { approveIcpFilterSpecProposal } from '@/lib/sourcing/approve-icp-filter-spec'
import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import {
  before,
  EXCLUDED_BEFORE,
  handlerIndustries,
  registeredHandler,
  TITLES,
} from '@/lib/sourcing/__tests__/helpers/settings-change-fixture'

const CONTEXT = 'targeting-proposal-view.live.test.ts'

let service: SupabaseClient<Database>
let untyped: SupabaseClient
let operatorId: string
const created: string[] = []

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

/** Lower the ceiling AND stop excluding one title: a tiering change that needs a tick. */
function proposedSettings(): ICPFilterSpec {
  const spec = before()
  spec.company_headcount_max = 20
  spec.job_titles_excluded = [EXCLUDED_BEFORE[1]]
  spec.buyer_criterion = { ...spec.buyer_criterion!, reject: [EXCLUDED_BEFORE[1]] }
  return spec
}

const row = (organisationId: string, extra: Record<string, unknown>) => ({
  organisation_id: organisationId,
  email_status: 'verified',
  enrichment_status: 'enriched',
  job_title: TITLES[0],
  company_headcount: 12,
  company_industry: handlerIndustries()[0],
  company_name: 'Placeholder Company',
  sourced_tier: null,
  tiering_reason: null,
  ...extra,
})

async function seedClient(label: string) {
  const organisationId = await seedOrganisation(label)
  const { data: doc, error: docError } = await untyped
    .from('strategy_documents')
    .insert({
      organisation_id: organisationId, document_type: 'icp', status: 'active', version: '1',
      content: { words: 'placeholder' },
      icp_filter_spec: before(), icp_filter_spec_proposed: proposedSettings(),
    })
    .select('id').single()
  expect(docError).toBeNull()
  const documentId = doc!.id as string

  const { error: cursorError } = await untyped.from('sourcing_cursors').insert({
    organisation_id: organisationId, icp_document_id: documentId, record_offset: 500,
  })
  expect(cursorError).toBeNull()

  const tier1 = { sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)', fit_score: 90 }
  const { error: prospectError } = await untyped.from('prospects').insert([
    row(organisationId, { ...tier1, company_headcount: 12 }),                       // stays tier 1
    row(organisationId, { ...tier1, company_headcount: 25 }),                       // would be removed
    row(organisationId, { ...tier1, company_headcount: 28 }),                       // would be removed
    row(organisationId, { tiering_reason: 'company_too_large', company_headcount: 15 }),   // re-queued, would qualify
    row(organisationId, { tiering_reason: 'industry_off_target', company_industry: handlerIndustries()[4] }), // re-queued, removed again
    row(organisationId, { tiering_reason: 'not_decision_maker', enrichment_status: null }), // re-queued, never enriched
    row(organisationId, {}),                                                         // not yet tiered
  ])
  expect(prospectError).toBeNull()
  return { organisationId, documentId }
}

async function removedCount(organisationId: string): Promise<number> {
  const { count, error } = await untyped
    .from('prospects').select('id', { count: 'exact', head: true })
    .eq('organisation_id', organisationId).is('sourced_tier', null).not('tiering_reason', 'is', null)
  expect(error).toBeNull()
  return count!
}

beforeAll(async () => {
  service = createTestServiceClient(CONTEXT)
  untyped = service as SupabaseClient

  const email = `proposal-panel-operator-${Date.now()}@test.local`
  const { data: authUser, error: authError } = await service.auth.admin.createUser({
    email, password: `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`, email_confirm: true,
  })
  expect(authError).toBeNull()
  operatorId = authUser!.user!.id
  const { error: userError } = await untyped.from('users').insert({
    id: operatorId, email: authUser!.user!.email!, role: 'operator',
  })
  expect(userError).toBeNull()

  registry.resolve.mockResolvedValue(registeredHandler())
})

afterAll(async () => {
  if (created.length > 0) await deleteTestOrganisations(service, created, CONTEXT)
  if (operatorId) {
    await untyped.from('users').delete().eq('id', operatorId)
    await service.auth.admin.deleteUser(operatorId)
  }
})

describe('the panel, built from real rows', () => {
  it('shows the change, the tick, the cursor and who would be re-tiered', async () => {
    const { organisationId, documentId } = await seedClient('panel-shows')
    const other = await seedClient('panel-shows-other')

    const view = await buildProposalPanel(untyped, { organisationId, documentId })

    expect(view).not.toBeNull()
    expect(view!.changes.map(change => change.label)).toEqual([
      'Job titles excluded', 'Largest company size', 'Who we email',
    ])
    expect(view!.exclusions).toEqual([{
      keys: [`job_titles_excluded:${EXCLUDED_BEFORE[0]}`, `buyer_criterion.reject:${EXCLUDED_BEFORE[0]}`],
      label: `Stop excluding the job title “${EXCLUDED_BEFORE[0]}”`,
    }])
    expect(view!.blockers).toEqual([])
    expect(view!.cursor).toEqual({ reset: true, why: 'request_changed' })
    // The other client holds an identical set of prospects. None of them is counted here.
    expect(view!.retier).toEqual({
      kind: 'replayed',
      requeued: 3,
      requeued_not_enriched: 1,
      requeued_outcome: [
        { to: 'tier_1', count: 1 },
        { to: 'tier_2', count: 0 },
        { to: 'tier_3', count: 0 },
        { to: 'removed', count: 1 },
      ],
      survivors_moved: [{ from: 'tier_1', to: 'removed', count: 2 }],
      judged: 6,
    })
    expect(other.organisationId).not.toBe(organisationId)
  })

  it('is not shown under another organisation\'s id', async () => {
    const mine = await seedClient('panel-org-mine')
    const other = await seedOrganisation('panel-org-other')
    expect(await buildProposalPanel(untyped, { organisationId: other, documentId: mine.documentId })).toBeNull()
  })
})

describe('approving with what the panel handed back', () => {
  it('does what the panel said: the same re-queue count, the same cursor decision, and nothing left pending', async () => {
    const { organisationId, documentId } = await seedClient('panel-then-approve')
    const other = await seedClient('panel-then-approve-other')

    const view = (await buildProposalPanel(untyped, { organisationId, documentId }))!
    if (view.retier.kind !== 'replayed') throw new Error('expected a replay')
    expect(await removedCount(organisationId)).toBe(view.retier.requeued)

    const outcome = await approveIcpFilterSpecProposal(untyped, {
      documentId,
      fingerprint: view.fingerprint,
      confirmedRemovals: view.exclusions.flatMap(tick => tick.keys),
      approvedBy: operatorId,
    })

    expect(outcome).toEqual({
      outcome: 'approved', organisation_id: organisationId,
      cursor_reset: view.cursor.reset, previous_offset: 500,
      requeued_count: view.retier.requeued,
    })
    // The removed prospects are back in the queue, and the survivors the panel said would
    // be judged differently still hold their tier.
    expect(await removedCount(organisationId)).toBe(0)
    const { data: survivors, error } = await untyped
      .from('prospects').select('sourced_tier').eq('organisation_id', organisationId).eq('sourced_tier', 'tier_1')
    expect(error).toBeNull()
    expect(survivors).toHaveLength(3)
    // Nothing is pending any more, so there is no panel.
    expect(await buildProposalPanel(untyped, { organisationId, documentId })).toBeNull()
    // The other client was not touched: their panel is still there, with their three.
    const otherView = await buildProposalPanel(untyped, other)
    expect(otherView!.retier).toMatchObject({ kind: 'replayed', requeued: 3 })
  })

  it('without the tick the panel asked for, the approval refuses and the panel is unchanged', async () => {
    const { organisationId, documentId } = await seedClient('panel-then-refuse')
    const view = (await buildProposalPanel(untyped, { organisationId, documentId }))!

    const outcome = await approveIcpFilterSpecProposal(untyped, {
      documentId, fingerprint: view.fingerprint, confirmedRemovals: [], approvedBy: operatorId,
    })

    expect(outcome).toMatchObject({ outcome: 'refused', refused: 'exclusions_not_confirmed' })
    expect(await buildProposalPanel(untyped, { organisationId, documentId })).toEqual(view)
  })
})
