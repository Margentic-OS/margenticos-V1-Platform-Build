// ADR-061 step 5: approving or rejecting a proposed change to a client's search settings.
//
// ─── WHAT IS BEING PROVED ────────────────────────────────────────────────────
//
//   1. Every refusal refuses, and writes nothing. "Writes nothing" is a zero, so the fake
//      records every database-function call and one test in each block shows it recording.
//   2. The floors: a buyer criterion that would not gate never becomes live, and an
//      exclusion is removed only when that removal is named in the request.
//   3. The cursor is reset only when the request the sourcing handler builds changes.
//   4. Removed prospects are re-queued only when something tiering reads changes.
//
// ─── THE HANDLER IS THE REAL ONE ─────────────────────────────────────────────
//
// "Did the query change" is answered by the registered handler's own request builder. A
// fake builder here would prove that this module compares two values, and nothing about
// whether an excluded title is part of the request. So the handler comes from the real
// dispatch map, and this file is the test of the PAIR. It is never named here: whichever
// handler is registered first is used, and the suite fails loudly if there is none.
//
// ─── THE FAKE DATABASE ───────────────────────────────────────────────────────
//
// It honours eq('id') by filtering and THROWS on any table, filter or method it does not
// implement. The transaction itself is the database function's, and is proved against the
// real function in approve-icp-filter-spec.live.test.ts.
//
// ─── NOTHING HERE NAMES A REAL INDUSTRY, ROLE, BAND OR COUNTRY ───────────────
//
// Industries are taken by position from the handler's own list, bands and countries from
// the shared fixtures, and every title and keyword is a placeholder.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const registry = vi.hoisted(() => ({ resolve: vi.fn() }))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/sourcing/handler-registry', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sourcing/handler-registry')>()),
  resolveActiveSourcingHandler: (...args: unknown[]) => registry.resolve(...args),
}))

import {
  APPROVAL_REFUSALS,
  approvalFingerprint,
  approveIcpFilterSpecProposal,
  exclusionKey,
  planApproval,
  REFUSAL_MESSAGES,
  REFUSAL_STATUS,
  rejectIcpFilterSpecProposal,
  type ApprovalOutcome,
} from '@/lib/sourcing/approve-icp-filter-spec'
import { HANDLER_DISPATCH } from '@/lib/sourcing/handler-registry'
import { diffSettings, EXCLUSION_FIELDS, type RemovedExclusion } from '@/lib/sourcing/settings-diff'
import { TIERING_SPEC_FIELDS, type TieringSpecField } from '@/lib/sourcing/tier-classification'
import type { CanonicalIndustry, ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import type { BuyerCriterion } from '@/lib/sourcing/buyer-criterion'
import type { FitDimension } from '@/lib/agents/research/fit-dimensions'
import type { SourcingHandler } from '@/lib/sourcing/types'
import { targetingInputs } from '@/lib/sourcing/targeting-inputs'
import { aGeography, twoTargetableCodes } from '@/test-utils/geography-fixture'
import { someBands } from '@/test-utils/seniority-fixture'
import { logger } from '@/lib/logger'

const ORG = '11111111-2222-3333-4444-555555555555'
const DOC = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OPERATOR = '99999999-8888-4777-8666-555555555555'

// ── The handler, taken from the real dispatch map and never named ────────────
const HANDLERS = Object.values(HANDLER_DISPATCH)
if (HANDLERS.length === 0) {
  throw new Error('approve-icp-filter-spec.test.ts: no sourcing handler is registered, so nothing here can be proved')
}
const HANDLER: SourcingHandler = HANDLERS[0]
const INDUSTRIES = HANDLER.targeted_industries as readonly CanonicalIndustry[]
if (INDUSTRIES.length < 5) {
  throw new Error('approve-icp-filter-spec.test.ts: the handler targets too few industries to build the fixtures')
}

function criterion(overrides: Partial<BuyerCriterion> = {}): BuyerCriterion {
  return {
    status: 'derived',
    accept: [
      { fragment: 'title one', rank: 'primary' },
      { fragment: 'title two', rank: 'secondary' },
    ],
    reject: ['excluded title one', 'excluded title two'],
    statement: 'A placeholder statement of who decides.',
    evidence: ['a placeholder line of evidence'],
    unsettled_reason: null,
    sanity: null,
    derived_at: '2026-01-01T00:00:00.000Z',
    model: 'test-model',
    ...overrides,
  }
}

const dimension = (key: string) =>
  ({ key, statement: `placeholder condition ${key}` }) as unknown as FitDimension

/** Settings the registered handler can build a request from. */
function baseSpec(): ICPFilterSpec {
  const countries = aGeography().countries
  return {
    job_titles: ['title one', 'title two'],
    job_titles_excluded: ['excluded title one', 'excluded title two'],
    seniority_levels: someBands(2),
    person_countries: [...countries],
    company_countries: [...countries],
    company_headcount_min: 10,
    company_headcount_max: 90,
    industries: [INDUSTRIES[0], INDUSTRIES[1]],
    industries_excluded: [INDUSTRIES[2]],
    keywords: ['keyword one'],
    keywords_excluded: ['excluded keyword one', 'excluded keyword two'],
    company_revenue_min: null,
    company_revenue_max: null,
    omitted_axes: [],
    omission_reasons: {},
    notes: 'placeholder notes',
    unmatched_industries: [],
    buyer_criterion: criterion(),
    fit_dimensions: {
      dimensions: [dimension('a')],
      derived_at: '2026-01-01T00:00:00.000Z',
      model: 'test-model',
    },
    targeting_inputs: targetingInputs({}),
  }
}

function proposal(change: (spec: ICPFilterSpec) => void): ICPFilterSpec {
  const spec = baseSpec()
  change(spec)
  return spec
}

// ── The fake database ────────────────────────────────────────────────────────
type Row = Record<string, unknown>
type RpcAnswer = { data: unknown; error: { message: string } | null }

interface Fake {
  client: SupabaseClient
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>
}

function fakeSupabase(opts: {
  row: Row | null
  readError?: string
  rpc?: (name: string, args: Record<string, unknown>) => RpcAnswer
}): Fake {
  const rpcCalls: Fake['rpcCalls'] = []
  const client = {
    from(table: string) {
      if (table !== 'strategy_documents') throw new Error(`fake does not implement table ${table}`)
      let wantedId: unknown
      const chain = {
        select(columns: string) {
          for (const needed of ['document_type', 'status', 'icp_filter_spec', 'icp_filter_spec_proposed', 'organisation_id']) {
            if (!columns.includes(needed)) throw new Error(`fake: the read does not select ${needed}`)
          }
          return chain
        },
        eq(column: string, value: unknown) {
          if (column !== 'id') throw new Error(`fake does not implement .eq on ${column}`)
          wantedId = value
          return chain
        },
        async maybeSingle() {
          if (opts.readError) return { data: null, error: { message: opts.readError } }
          if (wantedId === undefined) throw new Error('fake: the read was not filtered by id')
          const hit = opts.row && opts.row.id === wantedId ? opts.row : null
          return { data: hit, error: null }
        },
      }
      return chain
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args })
      if (opts.rpc) return opts.rpc(name, args)
      if (name === 'approve_icp_filter_spec_proposal') {
        return {
          data: {
            applied: true,
            organisation_id: ORG,
            cursor_reset: args.p_reset_cursor === true,
            previous_offset: args.p_reset_cursor === true ? 500 : null,
            requeued_count: args.p_requeue === true ? 3 : 0,
          },
          error: null,
        }
      }
      if (name === 'reject_icp_filter_spec_proposal') {
        return { data: { rejected: true, organisation_id: ORG }, error: null }
      }
      throw new Error(`fake does not implement rpc ${name}`)
    },
  }
  return { client: client as unknown as SupabaseClient, rpcCalls }
}

function row(live: ICPFilterSpec | null, proposed: ICPFilterSpec | null, overrides: Row = {}): Row {
  return {
    id: DOC,
    organisation_id: ORG,
    document_type: 'icp',
    status: 'active',
    icp_filter_spec: live,
    icp_filter_spec_proposed: proposed,
    ...overrides,
  }
}

const allTicks = (live: ICPFilterSpec | null, proposed: ICPFilterSpec) =>
  diffSettings(live, proposed).removed_exclusions.map(exclusionKey)

/** Approve `proposed` over `live`, as the panel would: the right fingerprint, every tick. */
async function approve(
  live: ICPFilterSpec | null,
  proposed: ICPFilterSpec,
  opts: { ticks?: string[]; fingerprint?: string; fake?: Fake } = {},
): Promise<{ outcome: ApprovalOutcome; fake: Fake }> {
  const fake = opts.fake ?? fakeSupabase({ row: row(live, proposed) })
  const outcome = await approveIcpFilterSpecProposal(fake.client, {
    documentId: DOC,
    fingerprint: opts.fingerprint ?? approvalFingerprint(live, proposed),
    confirmedRemovals: opts.ticks ?? allTicks(live, proposed),
    approvedBy: OPERATOR,
  })
  return { outcome, fake }
}

const approveArgs = (fake: Fake) => {
  const calls = fake.rpcCalls.filter(call => call.name === 'approve_icp_filter_spec_proposal')
  expect(calls).toHaveLength(1)
  return calls[0].args
}

beforeEach(() => {
  vi.clearAllMocks()
  registry.resolve.mockResolvedValue(HANDLER)
})

// ═════════════════════════════════════════════════════════════════════════════

describe('an approval that goes through', () => {
  it('hands the database function the proposal and the live settings it judged, and who approved', async () => {
    const live = baseSpec()
    const proposed = proposal(spec => { spec.job_titles = [...spec.job_titles, 'title three'] })
    const { outcome, fake } = await approve(live, proposed)

    expect(outcome).toEqual({
      outcome: 'approved', organisation_id: ORG,
      cursor_reset: true, previous_offset: 500, requeued_count: 0,
    })
    const args = approveArgs(fake)
    expect(args.p_document_id).toBe(DOC)
    expect(args.p_expected_proposal).toEqual(proposed)
    expect(args.p_expected_live).toEqual(live)
    expect(args.p_approved_by).toBe(OPERATOR)
  })

  it('logs both counts at warn', async () => {
    const live = baseSpec()
    const proposed = proposal(spec => { spec.industries = [...spec.industries, INDUSTRIES[3]] })
    await approve(live, proposed)

    const warned = vi.mocked(logger.warn).mock.calls.find(([message]) =>
      String(message).includes('proposal approved'))
    expect(warned).toBeDefined()
    expect(warned![1]).toMatchObject({
      organisation_id: ORG, approved_by: OPERATOR,
      cursor_reset: true, previous_offset: 500, requeued_count: 3,
    })
  })

  it('approves a client\'s FIRST settings: nothing live to compare, cursor reset, re-queue on', async () => {
    const proposed = baseSpec()
    const { outcome, fake } = await approve(null, proposed)

    expect(outcome.outcome).toBe('approved')
    const args = approveArgs(fake)
    expect(args.p_expected_live).toBeNull()
    expect(args.p_reset_cursor).toBe(true)
    expect(args.p_requeue).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('refusals: each one refuses and writes nothing', () => {
  // CONTROL for every "writes nothing" below: the fake does record a call when one is made.
  it('control: an approval that goes through IS recorded by the fake', async () => {
    const { fake } = await approve(baseSpec(), proposal(spec => { spec.company_headcount_min = 20 }))
    expect(fake.rpcCalls.map(call => call.name)).toEqual(['approve_icp_filter_spec_proposal'])
  })

  async function refusedWith(fake: Fake, fingerprint: string, ticks: string[] = []) {
    const outcome = await approveIcpFilterSpecProposal(fake.client, {
      documentId: DOC, fingerprint, confirmedRemovals: ticks, approvedBy: OPERATOR,
    })
    expect(fake.rpcCalls).toEqual([])
    return outcome
  }

  const live = baseSpec()
  const changed = proposal(spec => { spec.company_headcount_min = 20 })
  const print = approvalFingerprint(live, changed)

  it('not_found: no such document', async () => {
    expect(await refusedWith(fakeSupabase({ row: null }), print))
      .toEqual({ outcome: 'refused', refused: 'not_found' })
  })

  it('not_icp: another document type, even one carrying a stray proposal', async () => {
    const fake = fakeSupabase({ row: row(live, changed, { document_type: 'positioning' }) })
    expect(await refusedWith(fake, print)).toEqual({ outcome: 'refused', refused: 'not_icp' })
  })

  it('not_active: an archived version, even though it still carries the proposal', async () => {
    const fake = fakeSupabase({ row: row(live, changed, { status: 'archived' }) })
    expect(await refusedWith(fake, print)).toEqual({ outcome: 'refused', refused: 'not_active' })
  })

  it('no_proposal: nothing is waiting', async () => {
    const fake = fakeSupabase({ row: row(live, null) })
    expect(await refusedWith(fake, print)).toEqual({ outcome: 'refused', refused: 'no_proposal' })
  })

  it('changed_since_shown: the proposal was re-filed after the page was loaded', async () => {
    const refiled = proposal(spec => { spec.company_headcount_min = 30 })
    const fake = fakeSupabase({ row: row(live, refiled) })
    expect(await refusedWith(fake, print))
      .toEqual({ outcome: 'refused', refused: 'changed_since_shown' })
  })

  it('changed_since_shown: the LIVE settings moved, with the proposal untouched', async () => {
    // The before-and-after is a comparison. The proposal being identical is not enough.
    const liveNow = proposal(spec => { spec.keywords_excluded = ['excluded keyword one'] })
    const fake = fakeSupabase({ row: row(liveNow, changed) })
    expect(await refusedWith(fake, print))
      .toEqual({ outcome: 'refused', refused: 'changed_since_shown' })
  })

  it('a failed read is a failure, not a refusal, and writes nothing', async () => {
    const outcome = await refusedWith(fakeSupabase({ row: null, readError: 'connection reset' }), print)
    expect(outcome).toMatchObject({ outcome: 'failed', step: 'read the proposal' })
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('floor: a buyer criterion that does not gate never becomes live', () => {
  const NOT_GATING: Array<[string, (spec: ICPFilterSpec) => void]> = [
    ['out of band', spec => { spec.buyer_criterion = criterion({ status: 'out_of_band' }) }],
    ['unsettled', spec => { spec.buyer_criterion = criterion({ status: 'unsettled', unsettled_reason: 'placeholder' }) }],
    ['derived with nothing to accept', spec => { spec.buyer_criterion = criterion({ accept: [] }) }],
    ['absent', spec => { delete spec.buyer_criterion }],
  ]

  it.each(NOT_GATING)('refuses a proposal whose criterion is %s, over live settings that gate', async (_name, change) => {
    const live = baseSpec()
    const proposed = proposal(change)
    const { outcome, fake } = await approve(live, proposed)

    expect(outcome).toEqual({ outcome: 'refused', refused: 'criterion_does_not_gate' })
    expect(fake.rpcCalls).toEqual([])
  })

  it.each(NOT_GATING)('refuses FIRST settings whose criterion is %s: that client is not sourced', async (_name, change) => {
    const { outcome, fake } = await approve(null, proposal(change))

    expect(outcome).toEqual({ outcome: 'refused', refused: 'criterion_does_not_gate' })
    expect(fake.rpcCalls).toEqual([])
  })

  it('control: the same proposals go through once the criterion gates', async () => {
    const { outcome } = await approve(baseSpec(), proposal(spec => {
      spec.buyer_criterion = criterion({ accept: [{ fragment: 'title nine', rank: 'primary' }] })
    }))
    expect(outcome.outcome).toBe('approved')
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('floor: an exclusion is removed only when that removal is ticked', () => {
  async function refusedFor(proposed: ICPFilterSpec, ticks: string[]) {
    const { outcome, fake } = await approve(baseSpec(), proposed, { ticks })
    expect(fake.rpcCalls).toEqual([])
    expect(outcome.outcome).toBe('refused')
    if (outcome.outcome !== 'refused') throw new Error('unreachable')
    expect(outcome.refused).toBe('exclusions_not_confirmed')
    return outcome.unconfirmed ?? []
  }

  // PLANTED: the real list of exclusion fields is iterated, so a new one is tested with
  // nothing to remember.
  it.each([...EXCLUSION_FIELDS])('refuses an entry dropped from %s with no tick, and names it', async field => {
    const dropped = (baseSpec()[field] as string[])[0]
    const proposed = proposal(spec => {
      (spec as unknown as Record<string, string[]>)[field] = (spec[field] as string[]).slice(1)
    })
    const unconfirmed = await refusedFor(proposed, [])
    expect(unconfirmed).toContainEqual({ source: field, value: dropped, how: 'removed' })
  })

  it.each([...EXCLUSION_FIELDS])('lets the same removal from %s through once it is ticked', async field => {
    const proposed = proposal(spec => {
      (spec as unknown as Record<string, string[]>)[field] = (spec[field] as string[]).slice(1)
    })
    const { outcome } = await approve(baseSpec(), proposed)
    expect(outcome.outcome).toBe('approved')
  })

  it('refuses a SWAP that leaves the count unchanged: both removed entries are named', async () => {
    // The 2026-09-30 shape. Two excluded titles out, two different ones in.
    const proposed = proposal(spec => {
      spec.job_titles_excluded = ['excluded title three', 'excluded title four']
    })
    const unconfirmed = await refusedFor(proposed, [])
    expect(unconfirmed).toEqual([
      { source: 'job_titles_excluded', value: 'excluded title one', how: 'removed' },
      { source: 'job_titles_excluded', value: 'excluded title two', how: 'removed' },
    ])
  })

  it('refuses with ONE tick missing, and names only that one', async () => {
    const proposed = proposal(spec => { spec.job_titles_excluded = [] })
    const unconfirmed = await refusedFor(proposed, ['job_titles_excluded:excluded title one'])
    expect(unconfirmed).toEqual([
      { source: 'job_titles_excluded', value: 'excluded title two', how: 'removed' },
    ])
  })

  it('refuses an exclusion axis switched off: every entry on it needs its own tick', async () => {
    const proposed = proposal(spec => { spec.omitted_axes = ['keywords_excluded'] })
    const unconfirmed = await refusedFor(proposed, ['keywords_excluded:excluded keyword one'])
    expect(unconfirmed).toEqual([
      { source: 'keywords_excluded', value: 'excluded keyword two', how: 'axis_switched_off' },
    ])
  })

  it('refuses a fragment dropped from the buyer criterion\'s reject list', async () => {
    const proposed = proposal(spec => {
      spec.buyer_criterion = criterion({ reject: ['excluded title one'] })
    })
    const unconfirmed = await refusedFor(proposed, [])
    expect(unconfirmed).toEqual([
      { source: 'buyer_criterion.reject', value: 'excluded title two', how: 'removed' },
    ])
  })

  it('a tick for the wrong field does not confirm a removal of the same value elsewhere', async () => {
    const proposed = proposal(spec => { spec.job_titles_excluded = ['excluded title two'] })
    const unconfirmed = await refusedFor(proposed, ['keywords_excluded:excluded title one'])
    expect(unconfirmed).toHaveLength(1)
  })

  it('ADDING an exclusion needs no tick', async () => {
    const proposed = proposal(spec => {
      spec.job_titles_excluded = [...spec.job_titles_excluded, 'excluded title three']
    })
    const { outcome } = await approve(baseSpec(), proposed, { ticks: [] })
    expect(outcome.outcome).toBe('approved')
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('the cursor: reset only when the request the handler builds changes', () => {
  async function resetFor(change: (spec: ICPFilterSpec) => void): Promise<unknown> {
    const { outcome, fake } = await approve(baseSpec(), proposal(change))
    expect(outcome.outcome).toBe('approved')
    return approveArgs(fake).p_reset_cursor
  }

  const CHANGES_THE_REQUEST: Array<[string, (spec: ICPFilterSpec) => void]> = [
    ['a job title added', spec => { spec.job_titles = [...spec.job_titles, 'title three'] }],
    ['a seniority band added', spec => { spec.seniority_levels = someBands(3) }],
    ['the countries', spec => {
      const two = twoTargetableCodes()
      spec.person_countries = [...two]
      spec.company_countries = [...two]
    }],
    ['the headcount floor', spec => { spec.company_headcount_min = 20 }],
    ['the headcount ceiling', spec => { spec.company_headcount_max = 60 }],
    ['an industry added', spec => { spec.industries = [...spec.industries, INDUSTRIES[3]] }],
    // An excluded industry is deliberately not listed. Whether adding one changes the
    // request depends on the handler's translation table: two canonical industries can
    // translate to one provider code, and then the request is the same and the offset is
    // rightly kept. That is the handler's fact, and a fixture here would be a guess at it.
    ['a keyword added', spec => { spec.keywords = [...spec.keywords, 'keyword two'] }],
    ['a revenue floor', spec => { spec.company_revenue_min = 1_000_000 }],
    ['an axis switched off', spec => { spec.omitted_axes = ['seniority_levels'] }],
  ]

  it.each(CHANGES_THE_REQUEST)('resets when the change is %s', async (_name, change) => {
    expect(await resetFor(change)).toBe(true)
  })

  const KEEPS_THE_REQUEST: Array<[string, (spec: ICPFilterSpec) => void]> = [
    // Post-filters: applied to rows after they are fetched, and not part of the request.
    ['an excluded title removed', spec => { spec.job_titles_excluded = ['excluded title one'] }],
    ['an excluded title added', spec => { spec.job_titles_excluded = [...spec.job_titles_excluded, 'excluded title three'] }],
    ['an excluded keyword removed', spec => { spec.keywords_excluded = ['excluded keyword one'] }],
    // Metadata the handler never sees.
    ['the buyer criterion', spec => { spec.buyer_criterion = criterion({ accept: [{ fragment: 'title nine', rank: 'primary' }] }) }],
    ['the fit dimensions', spec => { spec.fit_dimensions = { ...spec.fit_dimensions!, dimensions: [dimension('b')] } }],
    ['the notes', spec => { spec.notes = 'different placeholder notes' }],
    // Order within a list is never a change.
    ['the same titles in another order', spec => { spec.job_titles = [...spec.job_titles].reverse() }],
    ['the same industries in another order', spec => { spec.industries = [...spec.industries].reverse() }],
  ]

  it.each(KEEPS_THE_REQUEST)('keeps the offset when the change is %s', async (_name, change) => {
    expect(await resetFor(change)).toBe(false)
  })

  it('resets when the proposed settings cannot be built into a request', async () => {
    // Not knowing whether the query changed is not "unchanged".
    const plan = planApproval(baseSpec(), proposal(spec => { spec.job_titles = [] }), HANDLER)
    expect(plan.cursor).toMatchObject({ reset: true, why: 'request_not_built' })
  })

  it('resets when the LIVE settings cannot be built into a request', async () => {
    const plan = planApproval(proposal(spec => { spec.industries = [] }), baseSpec(), HANDLER)
    expect(plan.cursor).toMatchObject({ reset: true, why: 'request_not_built' })
  })

  it('resets, and still approves, when no sourcing handler can be resolved', async () => {
    registry.resolve.mockRejectedValue(new Error('no active handler'))
    const { outcome, fake } = await approve(baseSpec(), proposal(spec => { spec.notes = 'x' }))
    expect(outcome.outcome).toBe('approved')
    expect(approveArgs(fake).p_reset_cursor).toBe(true)
  })

  it('says why, for the panel: unchanged, changed, first settings', () => {
    expect(planApproval(baseSpec(), baseSpec(), HANDLER).cursor)
      .toEqual({ reset: false, why: 'request_unchanged' })
    expect(planApproval(baseSpec(), proposal(spec => { spec.company_headcount_min = 20 }), HANDLER).cursor)
      .toEqual({ reset: true, why: 'request_changed' })
    expect(planApproval(null, baseSpec(), HANDLER).cursor)
      .toEqual({ reset: true, why: 'first_settings' })
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('the re-queue: only when something tiering reads changes', () => {
  // PLANTED. One change per field tiering reads, keyed by the real list's type: a field
  // added to TIERING_SPEC_FIELDS does not compile until it has a change here.
  const TIERING_CHANGES: Record<TieringSpecField, (spec: ICPFilterSpec) => void> = {
    buyer_criterion: spec => {
      spec.buyer_criterion = criterion({ accept: [{ fragment: 'title nine', rank: 'primary' }] })
    },
    company_headcount_max: spec => { spec.company_headcount_max = 60 },
    industries: spec => { spec.industries = [...spec.industries, INDUSTRIES[3]] },
    industries_excluded: spec => { spec.industries_excluded = [...spec.industries_excluded, INDUSTRIES[4]] },
    keywords: spec => { spec.keywords = [...spec.keywords, 'keyword two'] },
  }

  it.each([...TIERING_SPEC_FIELDS])('re-queues when %s changes, and names it', async field => {
    const proposed = proposal(TIERING_CHANGES[field])
    const { outcome, fake } = await approve(baseSpec(), proposed)

    expect(outcome).toMatchObject({ outcome: 'approved', requeued_count: 3 })
    expect(approveArgs(fake).p_requeue).toBe(true)
    expect(planApproval(baseSpec(), proposed, HANDLER).requeue_fields).toEqual([field])
  })

  const NOT_READ_BY_TIERING: Array<[string, (spec: ICPFilterSpec) => void]> = [
    ['a job title sent to the provider', spec => { spec.job_titles = [...spec.job_titles, 'title three'] }],
    ['an excluded title', spec => { spec.job_titles_excluded = [...spec.job_titles_excluded, 'excluded title three'] }],
    ['the seniority bands', spec => { spec.seniority_levels = someBands(3) }],
    ['the countries', spec => {
      const two = twoTargetableCodes()
      spec.person_countries = [...two]
      spec.company_countries = [...two]
    }],
    ['the headcount FLOOR', spec => { spec.company_headcount_min = 20 }],
    ['the revenue band', spec => { spec.company_revenue_min = 1_000_000 }],
    ['an excluded keyword', spec => { spec.keywords_excluded = [...spec.keywords_excluded, 'excluded keyword three'] }],
    ['an axis switched off', spec => { spec.omitted_axes = ['seniority_levels'] }],
    ['the fit dimensions', spec => { spec.fit_dimensions = { ...spec.fit_dimensions!, dimensions: [dimension('b')] } }],
    ['the criterion\'s wording, with what it accepts and rejects unchanged', spec => {
      spec.buyer_criterion = criterion({ statement: 'Reworded.', derived_at: '2026-02-02T00:00:00.000Z' })
    }],
  ]

  it.each(NOT_READ_BY_TIERING)('re-queues nobody when the change is %s', async (_name, change) => {
    const { outcome, fake } = await approve(baseSpec(), proposal(change))

    expect(outcome).toMatchObject({ outcome: 'approved', requeued_count: 0 })
    expect(approveArgs(fake).p_requeue).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('what the database function answers', () => {
  const live = baseSpec()
  const proposed = proposal(spec => { spec.company_headcount_min = 20 })

  it.each(['changed_since_shown', 'sourcing_in_progress', 'not_active', 'no_proposal'] as const)(
    'passes its refusal %s through as a refusal',
    async refused => {
      const fake = fakeSupabase({
        row: row(live, proposed),
        rpc: () => ({ data: { applied: false, refused }, error: null }),
      })
      const { outcome } = await approve(live, proposed, { fake })
      expect(outcome).toEqual({ outcome: 'refused', refused })
    },
  )

  it('treats an answer it does not recognise as a failure, never as approved', async () => {
    const fake = fakeSupabase({
      row: row(live, proposed),
      rpc: () => ({ data: { applied: false, refused: 'something_new' }, error: null }),
    })
    const { outcome } = await approve(live, proposed, { fake })
    expect(outcome).toMatchObject({ outcome: 'failed', step: 'write the approved settings' })
  })

  it('treats an empty answer as a failure', async () => {
    const fake = fakeSupabase({ row: row(live, proposed), rpc: () => ({ data: null, error: null }) })
    const { outcome } = await approve(live, proposed, { fake })
    expect(outcome.outcome).toBe('failed')
  })

  it('treats a database error as a failure', async () => {
    const fake = fakeSupabase({
      row: row(live, proposed),
      rpc: () => ({ data: null, error: { message: 'permission denied' } }),
    })
    const { outcome } = await approve(live, proposed, { fake })
    expect(outcome).toMatchObject({ outcome: 'failed', error: 'permission denied' })
  })

  it('never throws, even when the client does', async () => {
    const fake = fakeSupabase({ row: row(live, proposed), rpc: () => { throw new Error('socket closed') } })
    const { outcome } = await approve(live, proposed, { fake })
    expect(outcome).toMatchObject({ outcome: 'failed', error: 'socket closed' })
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('the fingerprint: what "the proposal you were shown" means', () => {
  it('is the same for the same values whatever order the keys arrive in', () => {
    const a = baseSpec()
    const reordered = Object.fromEntries(Object.entries(baseSpec()).reverse()) as unknown as ICPFilterSpec
    expect(Object.keys(reordered)).not.toEqual(Object.keys(a))
    expect(approvalFingerprint(a, reordered)).toBe(approvalFingerprint(reordered, a))
  })

  it('changes when anything in the proposal changes', () => {
    const live = baseSpec()
    const before = approvalFingerprint(live, baseSpec())
    expect(approvalFingerprint(live, proposal(spec => { spec.notes = 'x' }))).not.toBe(before)
    expect(approvalFingerprint(live, proposal(spec => { spec.job_titles = [...spec.job_titles].reverse() })))
      .not.toBe(before)
  })

  it('changes when anything in the LIVE settings changes', () => {
    const proposed = baseSpec()
    expect(approvalFingerprint(proposal(spec => { spec.company_headcount_max = 91 }), proposed))
      .not.toBe(approvalFingerprint(baseSpec(), proposed))
  })

  it('tells no live settings apart from live settings', () => {
    expect(approvalFingerprint(null, baseSpec())).not.toBe(approvalFingerprint(baseSpec(), baseSpec()))
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('reject', () => {
  const live = baseSpec()
  const proposed = proposal(spec => { spec.company_headcount_min = 20 })
  const print = approvalFingerprint(live, proposed)

  const reject = (fake: Fake, fingerprint = print) =>
    rejectIcpFilterSpecProposal(fake.client, { documentId: DOC, fingerprint, rejectedBy: OPERATOR })

  it('clears the proposal it was shown, through the reject function and no other', async () => {
    const fake = fakeSupabase({ row: row(live, proposed) })
    expect(await reject(fake)).toEqual({ outcome: 'rejected', organisation_id: ORG })
    expect(fake.rpcCalls).toEqual([{
      name: 'reject_icp_filter_spec_proposal',
      args: { p_document_id: DOC, p_expected_proposal: proposed },
    }])
  })

  it('needs no ticks and no gating criterion: rejecting is always allowed', async () => {
    const bad = proposal(spec => {
      spec.buyer_criterion = criterion({ status: 'out_of_band' })
      spec.job_titles_excluded = []
    })
    const fake = fakeSupabase({ row: row(live, bad) })
    expect((await rejectIcpFilterSpecProposal(fake.client, {
      documentId: DOC, fingerprint: approvalFingerprint(live, bad), rejectedBy: OPERATOR,
    })).outcome).toBe('rejected')
  })

  it.each([
    ['not_found', fakeSupabase({ row: null })],
    ['not_icp', fakeSupabase({ row: row(live, proposed, { document_type: 'positioning' }) })],
    ['not_active', fakeSupabase({ row: row(live, proposed, { status: 'archived' }) })],
    ['no_proposal', fakeSupabase({ row: row(live, null) })],
    ['changed_since_shown', fakeSupabase({ row: row(live, proposal(spec => { spec.company_headcount_min = 30 })) })],
  ] as const)('refuses with %s and writes nothing', async (refused, fake) => {
    expect(await reject(fake)).toEqual({ outcome: 'refused', refused })
    expect(fake.rpcCalls).toEqual([])
  })

  it('passes a refusal from the database function through', async () => {
    const fake = fakeSupabase({
      row: row(live, proposed),
      rpc: () => ({ data: { rejected: false, refused: 'changed_since_shown' }, error: null }),
    })
    expect(await reject(fake)).toEqual({ outcome: 'refused', refused: 'changed_since_shown' })
  })

  it('treats a database error as a failure', async () => {
    const fake = fakeSupabase({
      row: row(live, proposed),
      rpc: () => ({ data: null, error: { message: 'permission denied' } }),
    })
    expect(await reject(fake)).toMatchObject({ outcome: 'failed', error: 'permission denied' })
  })
})

// ═════════════════════════════════════════════════════════════════════════════

describe('every refusal has something to say and a status to say it with', () => {
  it.each([...APPROVAL_REFUSALS])('%s', refused => {
    expect(REFUSAL_MESSAGES[refused].length).toBeGreaterThan(20)
    expect(REFUSAL_STATUS[refused]).toBeGreaterThanOrEqual(400)
    expect(REFUSAL_STATUS[refused]).toBeLessThan(500)
  })

  it('names removed exclusions by where they were and what they were', () => {
    const exclusion: RemovedExclusion = { source: 'job_titles_excluded', value: 'excluded title one', how: 'removed' }
    expect(exclusionKey(exclusion)).toBe('job_titles_excluded:excluded title one')
  })
})
