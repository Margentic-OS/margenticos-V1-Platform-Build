// What the operator is shown before approving a change to the search settings. ADR-061.
//
// ─── WHAT IS BEING PROVED ────────────────────────────────────────────────────
//
//   1. A viewer who is not an operator never reaches the database. "Never reaches" is a
//      zero, so the stand-in for the service client records calls, and a control shows it
//      recording one.
//   2. "Could not load" is never shown as "nothing pending".
//   3. The panel's numbers are the replay's: who goes back to tiering and where they land,
//      and which survivors the new settings would judge differently.
//   4. THE PAIR: what the panel shows is what the approval does. The fingerprint and ticks
//      taken from a view are handed to the real approval, which accepts them and makes the
//      cursor and re-queue decisions the view announced.
//
// The handler is the registered one, never named. The database is a fake that honours
// every filter it is given and throws on the rest.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const stubs = vi.hoisted(() => ({ serviceClient: vi.fn(), resolve: vi.fn() }))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/service-role', () => ({
  createServiceRoleClient: () => stubs.serviceClient(),
}))
vi.mock('@/lib/sourcing/handler-registry', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sourcing/handler-registry')>()),
  resolveActiveSourcingHandler: (...args: unknown[]) => stubs.resolve(...args),
}))

import {
  buildProposalPanel,
  loadProposalPanelForViewer,
  type ProposalPanelView,
} from '@/lib/dashboard/targeting-proposal-view'
import {
  approvalFingerprint,
  approveIcpFilterSpecProposal,
  REFUSAL_MESSAGES,
} from '@/lib/sourcing/approve-icp-filter-spec'
import { describeSettingsDiff } from '@/lib/sourcing/describe-settings-diff'
import { diffSettings } from '@/lib/sourcing/settings-diff'
import {
  countMovements,
  fetchEnrichedProspects,
  replayTiering,
  type ReplayProspect,
} from '@/lib/sourcing/tiering-replay'
import { clearIndustryMappingCache } from '@/lib/sourcing/industry-mapping'
import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import { fakeReplayClient, type ReplayFakeOptions } from '@/lib/sourcing/__tests__/helpers/fake-replay-client'
import {
  after,
  afterWithCriterionHeld,
  before,
  EXCLUDED_BEFORE,
  handlerIndustries,
  registeredHandler,
  TITLES,
} from '@/lib/sourcing/__tests__/helpers/settings-change-fixture'

const ORG = '11111111-2222-4333-8444-555555555555'
const OTHER_ORG = '99999999-8888-4777-8666-555555555555'
const DOC = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OPERATOR = '77777777-6666-4555-8444-333333333333'

function document(live: ICPFilterSpec | null, proposed: ICPFilterSpec | null, overrides: Record<string, unknown> = {}) {
  return {
    id: DOC, organisation_id: ORG, document_type: 'icp', status: 'active',
    icp_filter_spec: live, icp_filter_spec_proposed: proposed, ...overrides,
  }
}

function prospect(id: string, overrides: Partial<ReplayProspect> = {}): ReplayProspect {
  return {
    id,
    organisation_id: ORG,
    email_status: 'verified',
    enrichment_status: 'enriched',
    job_title: TITLES[0],
    company_headcount: 12,
    company_industry: handlerIndustries()[0],
    company_name: 'Placeholder Company',
    sourced_tier: null,
    tiering_reason: null,
    fit_score: null,
    ...overrides,
  }
}

const TIER_1 = { sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)', fit_score: 90 }

/** The ceiling drops from 30 to 20: one field, and one tiering reads. */
const lowerCeiling = () => {
  const spec = before()
  spec.company_headcount_max = 20
  return spec
}

/** Eight enriched prospects and one never enriched, planted to land in known places. */
const PLANTED = () => [
  prospect('s1-stays', { ...TIER_1, company_headcount: 12 }),
  prospect('s2-now-too-large', { ...TIER_1, company_headcount: 25 }),
  prospect('s3-now-too-large', { ...TIER_1, company_headcount: 28 }),
  // Stored tier 2, though today's code puts it in tier 1 under BOTH sets of settings. A
  // panel that compared against the stored tier would report it as moved by this change.
  prospect('d1-drifted', { sourced_tier: 'tier_2', tiering_reason: 'tier_2 (score 60)', fit_score: 60 }),
  prospect('r1-would-qualify', { tiering_reason: 'company_too_large', company_headcount: 15 }),
  prospect('r2-removed-again', { tiering_reason: 'industry_off_target', company_industry: handlerIndustries()[4] }),
  prospect('r3-never-enriched', { tiering_reason: 'not_decision_maker', enrichment_status: null }),
  prospect('n1-not-yet-tiered'),
  // Not yet tiered, and the two sets of settings WOULD judge it differently. It is in no
  // tier, so it must not be listed among the people who keep theirs.
  prospect('n2-not-yet-tiered-and-would-differ', { company_headcount: 25 }),
  prospect('x1-another-client', { organisation_id: OTHER_ORG, tiering_reason: 'industry_off_target' }),
]

async function build(live: ICPFilterSpec | null, proposed: ICPFilterSpec | null, options: ReplayFakeOptions = {}) {
  const fake = fakeReplayClient({ documents: [document(live, proposed)], ...options })
  const view = await buildProposalPanel(fake.client, { organisationId: ORG, documentId: DOC })
  return { view, fake }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearIndustryMappingCache()
  stubs.resolve.mockResolvedValue(registeredHandler())
})

// ═════════════════════════════════════════════════════════════════════════════

describe('who is shown a proposal: decided before anything is read', () => {
  const viewer = { role: 'operator', docType: 'icp', docStatus: 'active', organisationId: ORG, documentId: DOC }

  it('control: an operator on the live ICP does reach the database', async () => {
    stubs.serviceClient.mockResolvedValue(fakeReplayClient({ documents: [document(before(), lowerCeiling())] }).client)
    const state = await loadProposalPanelForViewer(viewer)
    expect(stubs.serviceClient).toHaveBeenCalledTimes(1)
    expect(state.state).toBe('pending')
  })

  it.each([
    ['a client', { role: 'client' }],
    ['a viewer with no role', { role: null }],
    ['an operator on another document type', { docType: 'positioning' }],
    ['an operator on an archived version', { docStatus: 'archived' }],
  ])('%s gets nothing, and no client is built', async (_name, change) => {
    stubs.serviceClient.mockImplementation(() => { throw new Error('the database was reached') })
    expect(await loadProposalPanelForViewer({ ...viewer, ...change })).toEqual({ state: 'none' })
    expect(stubs.serviceClient).not.toHaveBeenCalled()
  })

  it('says "none" when nothing is waiting', async () => {
    stubs.serviceClient.mockResolvedValue(fakeReplayClient({ documents: [document(before(), null)] }).client)
    expect(await loadProposalPanelForViewer(viewer)).toEqual({ state: 'none' })
  })

  it('says "failed", never "none", when the proposal could not be read', async () => {
    stubs.serviceClient.mockResolvedValue(
      fakeReplayClient({ documents: [document(before(), lowerCeiling())], failDocument: true }).client)
    expect(await loadProposalPanelForViewer(viewer)).toEqual({ state: 'failed' })
  })

  it('says "failed" when no service client could be built', async () => {
    stubs.serviceClient.mockRejectedValue(new Error('missing key'))
    expect(await loadProposalPanelForViewer(viewer)).toEqual({ state: 'failed' })
  })

  it('never shows one organisation\'s proposal under another organisation\'s id', async () => {
    const fake = fakeReplayClient({ documents: [document(before(), lowerCeiling())] })
    expect(await buildProposalPanel(fake.client, { organisationId: OTHER_ORG, documentId: DOC })).toBeNull()
  })

  // The builder checks the row itself as well. The viewer check above is told the status
  // by the page; this one reads it, so a caller that got it wrong still gets nothing.
  it.each([
    ['an archived version that still carries a proposal', { status: 'archived' }],
    ['another document type carrying a stray proposal', { document_type: 'positioning' }],
  ])('the builder returns nothing for %s', async (_name, overrides) => {
    const fake = fakeReplayClient({ documents: [document(before(), lowerCeiling(), overrides)] })
    expect(await buildProposalPanel(fake.client, { organisationId: ORG, documentId: DOC })).toBeNull()
  })

  it('control: the same row, active and an ICP, does produce a panel', async () => {
    const fake = fakeReplayClient({ documents: [document(before(), lowerCeiling())], prospects: [] })
    expect(await buildProposalPanel(fake.client, { organisationId: ORG, documentId: DOC })).not.toBeNull()
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('the 2026-09-30 difference, with invented names', () => {
  it('shows every change, the two exclusions that need a tick, and why it cannot be approved', async () => {
    const { view } = await build(before(), after(), { prospects: [] })

    expect(view).not.toBeNull()
    expect(view!.changes).toEqual(describeSettingsDiff(diffSettings(before(), after())))
    expect(view!.changes.map(change => change.label)).toEqual([
      'Job titles searched', 'Job titles excluded', 'Seniority levels searched',
      'Who we email', 'Research fit conditions',
    ])
    expect(view!.exclusions.map(tick => tick.label)).toEqual(
      EXCLUDED_BEFORE.map(title => `Stop excluding the job title “${title}”`))
    // The re-derived criterion would not be applied to anyone, so this never becomes live.
    expect(view!.blockers).toEqual([REFUSAL_MESSAGES.criterion_does_not_gate])
    expect(view!.cursor).toEqual({ reset: true, why: 'request_changed' })
    expect(view!.first_settings).toBe(false)
    expect(view!.fingerprint).toBe(approvalFingerprint(before(), after()))
  })

  it('as step 4 files it: the live criterion is kept, the panel says so, and nobody is re-tiered', async () => {
    // Only the fit conditions differ, which neither the search nor tiering reads. The
    // fake forbids any read of prospects: the replay must not run at all.
    const { view, fake } = await build(before(), afterWithCriterionHeld(), { forbidProspects: true })

    expect(view!.criterion_held).toEqual({
      status: 'out_of_band',
      reason: 'A placeholder note: accepts almost every title sampled.',
    })
    expect(view!.blockers).toEqual([])
    expect(view!.exclusions).toEqual([])
    expect(view!.cursor).toEqual({ reset: false, why: 'request_unchanged' })
    expect(view!.retier).toEqual({ kind: 'none' })
    expect(fake.tables).not.toContain('prospects')
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('who would be re-tiered', () => {
  it('counts who goes back to tiering, where they land, and which survivors would be judged differently', async () => {
    const { view } = await build(before(), lowerCeiling(), { prospects: PLANTED() })

    expect(view!.retier).toEqual({
      kind: 'replayed',
      // r1, r2 and r3. Not the other client's, and not the one never tiered.
      requeued: 3,
      requeued_not_enriched: 1,
      requeued_outcome: [
        { to: 'tier_1', count: 1 },
        { to: 'tier_2', count: 0 },
        { to: 'tier_3', count: 0 },
        { to: 'removed', count: 1 },
      ],
      // s2 and s3. NOT d1, whose stored tier is stale but which the change does not move.
      survivors_moved: [{ from: 'tier_1', to: 'removed', count: 2 }],
      judged: 8,
    })
  })

  it('agrees with the terminal replay on the same prospects and settings', async () => {
    // scripts/compare-tiering.ts prints stored-against-replayed movement from these same
    // two functions. Its "removed to tier N" lines are the panel's "would now be tier N".
    const proposed = lowerCeiling()
    const { view, fake } = await build(before(), proposed, { prospects: PLANTED() })
    const verdicts = await replayTiering(await fetchEnrichedProspects(fake.client, ORG), proposed, fake.client)
    const terminal = countMovements(verdicts.map(v => ({ from: v.stored, to: v.replayed })))

    if (view!.retier.kind !== 'replayed') throw new Error('expected a replay')
    for (const outcome of view!.retier.requeued_outcome) {
      if (outcome.to === 'removed') continue
      const line = terminal.find(m => m.from === 'removed' && m.to === outcome.to)
      expect(line?.count ?? 0, `removed to ${outcome.to}`).toBe(outcome.count)
    }
    // CONTROL: the terminal replay saw the movement at all.
    expect(terminal.find(m => m.from === 'removed' && m.to === 'tier_1')?.count).toBe(1)
  })

  it('says the replay is unavailable when prospects cannot be counted, and still builds the panel', async () => {
    const { view } = await build(before(), lowerCeiling(), { prospects: PLANTED(), failCount: true })

    expect(view!.retier.kind).toBe('unavailable')
    expect(view!.changes).toEqual([{ label: 'Largest company size', detail: 'changes from 30 people to 20 people' }])
    expect(view!.fingerprint).toBe(approvalFingerprint(before(), lowerCeiling()))
  })

  it('says the replay is unavailable when a page of prospects cannot be read', async () => {
    const { view } = await build(before(), lowerCeiling(), { prospects: PLANTED(), failProspectsAfterPages: 0 })
    expect(view!.retier.kind).toBe('unavailable')
  })

  it('first settings: nothing live to compare, nobody held yet', async () => {
    const { view } = await build(null, before(), { prospects: [] })

    expect(view!.first_settings).toBe(true)
    expect(view!.cursor).toEqual({ reset: true, why: 'first_settings' })
    expect(view!.blockers).toEqual([])
    expect(view!.retier).toMatchObject({ kind: 'replayed', requeued: 0, judged: 0, survivors_moved: [] })
  })

  it('first settings whose criterion does not gate cannot be approved, and the panel says so', async () => {
    const { view } = await build(null, after(), { prospects: [] })
    expect(view!.blockers).toEqual([REFUSAL_MESSAGES.criterion_does_not_gate])
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('THE PAIR: what the panel shows is what the approval does', () => {
  /** Lower the ceiling AND stop excluding one title, so the approval needs a tick. */
  const proposed = () => {
    const spec = lowerCeiling()
    spec.job_titles_excluded = [EXCLUDED_BEFORE[1]]
    spec.buyer_criterion = { ...spec.buyer_criterion!, reject: [EXCLUDED_BEFORE[1]] }
    return spec
  }

  async function panelThenApprove(ticks: (view: ProposalPanelView) => string[]) {
    const options: ReplayFakeOptions = {
      documents: [document(before(), proposed())],
      prospects: PLANTED(),
      rpc: (_name, args) => ({
        data: {
          applied: true, organisation_id: ORG,
          cursor_reset: args.p_reset_cursor === true,
          previous_offset: args.p_reset_cursor === true ? 500 : null,
          requeued_count: 3,
        },
        error: null,
      }),
    }
    const fake = fakeReplayClient(options)
    const view = (await buildProposalPanel(fake.client, { organisationId: ORG, documentId: DOC }))!
    const outcome = await approveIcpFilterSpecProposal(fake.client, {
      documentId: DOC, fingerprint: view.fingerprint, confirmedRemovals: ticks(view), approvedBy: OPERATOR,
    })
    return { view, outcome, fake }
  }

  it('the approval accepts the panel\'s fingerprint and ticks, and decides what the panel announced', async () => {
    const { view, outcome, fake } = await panelThenApprove(v => v.exclusions.flatMap(tick => tick.keys))

    expect(view.exclusions).toHaveLength(1)
    expect(outcome.outcome).toBe('approved')
    expect(fake.rpcCalls).toHaveLength(1)
    expect(fake.rpcCalls[0].args.p_reset_cursor).toBe(view.cursor.reset)
    expect(fake.rpcCalls[0].args.p_requeue).toBe(view.retier.kind !== 'none')
  })

  it('with the panel\'s one tick left unticked, the approval refuses and names it', async () => {
    const { outcome, fake } = await panelThenApprove(() => [])

    expect(outcome).toMatchObject({ outcome: 'refused', refused: 'exclusions_not_confirmed' })
    expect(fake.rpcCalls).toEqual([])
  })

  it('with only HALF of the folded tick confirmed, the approval still refuses', async () => {
    // The panel folds a title's two exclusions into one tick. The approval still requires
    // both keys, so a request that sent one of them does not get through.
    const { outcome } = await panelThenApprove(v => [v.exclusions[0].keys[0]])
    expect(outcome).toMatchObject({ outcome: 'refused', refused: 'exclusions_not_confirmed' })
  })

  it('a panel showing a blocker is one the approval refuses', async () => {
    const fake = fakeReplayClient({ documents: [document(before(), after())], prospects: [] })
    const view = (await buildProposalPanel(fake.client, { organisationId: ORG, documentId: DOC }))!
    const outcome = await approveIcpFilterSpecProposal(fake.client, {
      documentId: DOC, fingerprint: view.fingerprint,
      confirmedRemovals: view.exclusions.flatMap(tick => tick.keys), approvedBy: OPERATOR,
    })

    expect(view.blockers).toHaveLength(1)
    expect(outcome).toEqual({ outcome: 'refused', refused: 'criterion_does_not_gate' })
  })
})
