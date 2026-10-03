// Replaying tiering over prospects a client already holds, against any search settings.
//
// What is proved here:
//
//   1. The read is COMPLETE. It pages past the database's 1,000-row ceiling, and a failed
//      page is an error, never a short list passed off as a whole one.
//   2. The verdicts are the real classifier's. Nothing in tiering-replay.ts decides who
//      qualifies, so the planted prospects below land where classifyTier puts them.
//   3. Movement is counted only for prospects that moved.
//
// Nothing names a real industry, role or country. Industries are taken by position from
// the registered handler's list; a provider tag that IS a canonical name maps to itself,
// which is what lets a fixture be on target without naming anything.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  countByState,
  countMovements,
  fetchEnrichedProspects,
  REPLAY_COLUMNS,
  REPLAY_PAGE_SIZE,
  REPLAY_STATES,
  replayTiering,
  storedState,
  type ReplayProspect,
} from '@/lib/sourcing/tiering-replay'
import { clearIndustryMappingCache } from '@/lib/sourcing/industry-mapping'
import { TIERING_SPEC_FIELDS } from '@/lib/sourcing/tier-classification'
import { fakeReplayClient } from './helpers/fake-replay-client'
import { before, handlerIndustries, TITLES } from './helpers/settings-change-fixture'

const ORG = '11111111-2222-4333-8444-555555555555'
const OTHER_ORG = '99999999-8888-4777-8666-555555555555'

function prospect(id: string, overrides: Partial<ReplayProspect> = {}): ReplayProspect {
  return {
    id,
    organisation_id: ORG,
    email_status: 'verified',
    enrichment_status: 'enriched',
    job_title: TITLES[0],              // a primary title in the fixture criterion
    company_headcount: 12,
    company_industry: handlerIndustries()[0],
    company_name: 'Placeholder Company',
    sourced_tier: null,
    tiering_reason: null,
    fit_score: null,
    ...overrides,
  }
}

const pad = (n: number) => String(n).padStart(6, '0')

beforeEach(() => clearIndustryMappingCache())

describe('fetchEnrichedProspects: the read is complete', () => {
  it('reads past the 1,000-row ceiling, in id order, and asks for a stable order first', async () => {
    const total = REPLAY_PAGE_SIZE * 2 + 300
    const rows = Array.from({ length: total }, (_, i) => prospect(`p-${pad(total - i)}`))
    const fake = fakeReplayClient({ prospects: rows })

    const read = await fetchEnrichedProspects(fake.client, ORG)

    expect(read).toHaveLength(total)
    expect(read[0].id).toBe(`p-${pad(1)}`)
    expect(read[total - 1].id).toBe(`p-${pad(total)}`)
    expect(new Set(read.map(row => row.id)).size).toBe(total)
    expect(fake.ranges).toEqual([
      [0, REPLAY_PAGE_SIZE - 1],
      [REPLAY_PAGE_SIZE, REPLAY_PAGE_SIZE * 2 - 1],
      [REPLAY_PAGE_SIZE * 2, REPLAY_PAGE_SIZE * 3 - 1],
    ])
  })

  it('asks again when a page comes back exactly full, and stops on the empty one', async () => {
    // The boundary a "short page means done" rule gets wrong: a full last page looks like
    // there is more.
    const rows = Array.from({ length: REPLAY_PAGE_SIZE }, (_, i) => prospect(`p-${pad(i)}`))
    const fake = fakeReplayClient({ prospects: rows })

    expect(await fetchEnrichedProspects(fake.client, ORG)).toHaveLength(REPLAY_PAGE_SIZE)
    expect(fake.ranges).toHaveLength(2)
  })

  it('returns only this organisation\'s ENRICHED prospects', async () => {
    const fake = fakeReplayClient({
      prospects: [
        prospect('mine-enriched'),
        prospect('mine-not-enriched', { enrichment_status: null }),
        prospect('mine-failed', { enrichment_status: 'failed' }),
        prospect('theirs', { organisation_id: OTHER_ORG }),
      ],
    })
    expect((await fetchEnrichedProspects(fake.client, ORG)).map(row => row.id)).toEqual(['mine-enriched'])
  })

  it('THROWS when a later page fails, and does not return the pages it already had', async () => {
    const rows = Array.from({ length: REPLAY_PAGE_SIZE + 5 }, (_, i) => prospect(`p-${pad(i)}`))
    const fake = fakeReplayClient({ prospects: rows, failProspectsAfterPages: 1 })

    await expect(fetchEnrichedProspects(fake.client, ORG)).rejects.toThrow(/could not be read/)
  })

  it('selects every field tiering reads from a prospect, and the stored verdict', () => {
    // competitor_check is what classifyTier reads first: without it a replay would show an
    // excluded competitor gaining a tier under any settings.
    for (const column of ['email_status', 'job_title', 'company_headcount', 'company_industry', 'company_name', 'sourced_tier', 'tiering_reason', 'competitor_check']) {
      expect(REPLAY_COLUMNS).toContain(column)
    }
  })
})

describe('storedState: the three things a stored verdict can mean', () => {
  it.each([
    [{ sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)' }, 'tier_1'],
    [{ sourced_tier: 'tier_3', tiering_reason: 'tier_3 (score 40)' }, 'tier_3'],
    [{ sourced_tier: null, tiering_reason: 'industry_off_target' }, 'removed'],
    [{ sourced_tier: null, tiering_reason: null }, 'not_tiered'],
  ] as const)('%o is %s', (row, expected) => {
    expect(storedState(row)).toBe(expected)
  })
})

describe('replayTiering: the verdicts are the real classifier\'s', () => {
  const offTarget = () => handlerIndustries()[4]

  it('puts planted prospects where the classifier puts them, and changes nothing stored', async () => {
    const spec = before()
    const planted = [
      prospect('on-target', { sourced_tier: null, tiering_reason: 'industry_off_target' }),
      prospect('too-large', { company_headcount: spec.company_headcount_max + 1, sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)', fit_score: 90 }),
      prospect('wrong-industry', { company_industry: offTarget() }),
      prospect('rejected-title', { job_title: spec.job_titles_excluded[0] }),
      prospect('no-title', { job_title: null }),
      prospect('unverified', { email_status: 'unknown' }),
    ]
    const fake = fakeReplayClient()
    const verdicts = await replayTiering(planted, spec, fake.client)

    expect(verdicts.map(v => [v.id, v.stored, v.replayed, v.replayed_reason.split(' ')[0]])).toEqual([
      ['on-target', 'removed', 'tier_1', 'tier_1'],
      ['too-large', 'tier_1', 'removed', 'company_too_large'],
      ['wrong-industry', 'not_tiered', 'removed', 'industry_off_target'],
      ['rejected-title', 'not_tiered', 'removed', 'not_decision_maker'],
      ['no-title', 'not_tiered', 'removed', 'no_title'],
      ['unverified', 'not_tiered', 'removed', 'email_unverified'],
    ])
    // The stored verdict is reported, not rewritten.
    expect(verdicts[1]).toMatchObject({ stored_reason: 'tier_1 (score 90)', stored_score: 90 })
    expect(planted[1].sourced_tier).toBe('tier_1')
  })

  it('answers differently when the settings differ, on the same prospects', async () => {
    const planted = [prospect('edge', { company_headcount: 25 })]
    const live = before()
    const tighter = before()
    tighter.company_headcount_max = 20

    expect((await replayTiering(planted, live))[0].replayed).toBe('tier_1')
    expect((await replayTiering(planted, tighter))[0]).toMatchObject({
      replayed: 'removed', replayed_reason: 'company_too_large',
    })
  })

  it('needs only the fields tiering reads: the rest of the settings can be absent', async () => {
    // The replay accepts the same projection classifyTier does, so it can never judge by a
    // field the approval's re-queue decision does not look at.
    const full = before()
    const projection = Object.fromEntries(
      TIERING_SPEC_FIELDS.map(field => [field, full[field]]),
    ) as Parameters<typeof replayTiering>[1]
    const planted = [prospect('a'), prospect('b', { company_headcount: 500 })]

    expect((await replayTiering(planted, projection)).map(v => v.replayed))
      .toEqual((await replayTiering(planted, full)).map(v => v.replayed))
  })
})

describe('counting', () => {
  it('counts only prospects that moved, best starting state first', () => {
    expect(countMovements([
      { from: 'tier_1', to: 'tier_1' },
      { from: 'removed', to: 'tier_2' },
      { from: 'tier_1', to: 'removed' },
      { from: 'tier_1', to: 'removed' },
      { from: 'tier_2', to: 'tier_1' },
      { from: 'removed', to: 'removed' },
    ])).toEqual([
      { from: 'tier_1', to: 'removed', count: 2 },
      { from: 'tier_2', to: 'tier_1', count: 1 },
      { from: 'removed', to: 'tier_2', count: 1 },
    ])
  })

  it('returns nothing when nobody moved', () => {
    expect(countMovements([{ from: 'tier_2', to: 'tier_2' }])).toEqual([])
    expect(countMovements([])).toEqual([])
  })

  it('lists every state, at zero when empty', () => {
    const counts = countByState(['tier_1', 'tier_1', 'removed'])
    expect(Object.keys(counts)).toEqual([...REPLAY_STATES])
    expect(counts).toEqual({ tier_1: 2, tier_2: 0, tier_3: 0, removed: 1, not_tiered: 0 })
  })
})
