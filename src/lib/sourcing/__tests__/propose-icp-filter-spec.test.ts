// ADR-061 step 4: a promotion compares targeting fields and files a proposal. It never
// changes the search.
//
// ─── WHAT IS BEING PROVED ────────────────────────────────────────────────────
//
// On 2026-09-30 an edit to two trigger reasons rebuilt one client's search, switched its
// buyer criterion off and removed 62 prospects. The first describe block replays that edit.
// It must end with the live settings, the cursor and every prospect exactly as they were,
// and with NO MODEL CALLED.
//
// "No model called" is a zero, and a zero has two causes: nothing was called, or the thing
// counting calls was not attached. So every count here is taken from mocks that a positive
// control, in the same block, shows recording a call.
//
// ─── THE FAKE ────────────────────────────────────────────────────────────────
//
// It honours eq() and is() by filtering, records every write with the filters it was made
// under, and THROWS on any method it does not implement. A fake that quietly returns its
// chain cannot test a filter, and the status = 'active' filter on the write is one of the
// things under test. See CLAUDE.md, "A fake that does not honour a filter".
//
// ─── NOTHING HERE NAMES A REAL INDUSTRY, ROLE, BAND OR COUNTRY ───────────────
//
// Industries come from the canonical list by position, bands and countries from the shared
// fixtures, and every title and phrase is a placeholder.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const models = vi.hoisted(() => ({
  criterion: vi.fn(),
  geography: vi.fn(),
  fit: vi.fn(),
  serviceClient: vi.fn(),
}))

vi.mock('@sentry/nextjs', () => ({
  withScope: (fn: (s: unknown) => void) => fn({ setExtra() {}, setContext() {}, setTag() {} }),
  captureMessage: () => {},
  captureException: () => {},
  flush: async () => true,
}))
vi.mock('@/agents/buyer-criterion-agent', () => ({
  deriveBuyerCriterionWithVocabulary: (...args: unknown[]) => models.criterion(...args),
}))
vi.mock('@/agents/fit-dimensions-agent', () => ({
  deriveFitDimensions: (...args: unknown[]) => models.fit(...args),
}))
vi.mock('@/lib/sourcing/resolve-icp-geography', () => ({
  resolveIcpGeography: (...args: unknown[]) => models.geography(...args),
}))
vi.mock('@/lib/supabase/service-role', () => ({
  createServiceRoleClient: () => models.serviceClient(),
}))

import {
  proposeIcpFilterSpec,
  proposeIcpFilterSpecForOrganisationSafely,
} from '@/lib/sourcing/propose-icp-filter-spec'
import {
  CANONICAL_INDUSTRIES,
  deriveFilterSpec,
  REVENUE_NOT_OPTED_IN_LEAD,
  type ICPFilterSpec,
} from '@/lib/agents/icp-filter-spec'
import type { BuyerCriterion } from '@/lib/sourcing/buyer-criterion'
import type { FitDimension, FitDimensionSet } from '@/lib/agents/research/fit-dimensions'
import { targetingInputs } from '@/lib/sourcing/targeting-inputs'
import { diffSettings } from '@/lib/sourcing/settings-diff'
import { aGeography, twoTargetableCodes } from '@/test-utils/geography-fixture'
import { seniorityFixture, someBands } from '@/test-utils/seniority-fixture'
import { logger } from '@/lib/logger'

const ORG = '11111111-2222-3333-4444-555555555555'
const OTHER_ORG = '99999999-8888-7777-6666-555555555555'
const DOC = 'doc-new'

type Row = Record<string, unknown>

// ── The document ─────────────────────────────────────────────────────────────

function tier(name: string, industryAt: number, headcount: string) {
  return {
    label: `placeholder label ${name}`,
    description: `placeholder description ${name}`,
    company_profile: {
      industries: [CANONICAL_INDUSTRIES[industryAt]],
      headcount,
      revenue_range: `placeholder revenue phrase ${name}`,
      geography: `placeholder geography phrase ${name}`,
      stage: `placeholder stage ${name}`,
      business_model: `placeholder business model ${name}`,
    },
    buyer_profile: {
      title: `placeholder buyer title ${name}`,
      seniority: `placeholder buyer level ${name}`,
      day_to_day: `placeholder day ${name}`,
    },
    disqualifiers: [`placeholder rule ${name}`],
    triggers: Array.from({ length: 7 }, (_, n) => ({
      event: `placeholder event ${name} ${n}`,
      reason: `placeholder reason ${name} ${n}`,
    })),
  }
}

function icpDocument() {
  return {
    summary: 'A placeholder summary.',
    jtbd_statement: 'A placeholder job statement.',
    tier_1: tier('one', 0, '10 to 40 people'),
    tier_2: tier('two', 1, '41 to 90 people'),
    tier_3: { company_profile: { industries: [], headcount: '1 person', revenue_range: 'none' } },
  }
}

// ── The settings a client is running on, built by the REAL derivation ─────────

function criterion(overrides: Partial<BuyerCriterion> = {}): BuyerCriterion {
  return {
    status: 'derived',
    accept: [
      { fragment: 'title one', rank: 'primary' },
      { fragment: 'title two', rank: 'secondary' },
    ],
    reject: ['excluded title one'],
    statement: 'A placeholder statement of who decides.',
    evidence: ['a placeholder line of evidence'],
    unsettled_reason: null,
    sanity: null,
    derived_at: '2026-01-01T00:00:00.000Z',
    model: 'test-model',
    ...overrides,
  }
}

const fitSet = (key: string): FitDimensionSet => ({
  dimensions: [{ key, statement: `placeholder condition ${key}` } as unknown as FitDimension],
  derived_at: '2026-01-01T00:00:00.000Z',
  model: 'test-model',
})

interface Outside { statedHeadcount?: { min: number; max: number } | null; revenueFilterEnabled?: boolean }

/** Live settings as the approved state would hold them: derived, then stamped with their inputs. */
function liveSettings(doc: unknown = icpDocument(), outside: Outside = {}): ICPFilterSpec {
  const inputs = targetingInputs(doc, outside)
  const spec = deriveFilterSpec(inputs.document, criterion(), aGeography(), seniorityFixture(), {
    statedHeadcount: inputs.stated_headcount,
    revenueFilterEnabled: inputs.revenue_filter_enabled,
  })
  spec.buyer_criterion = criterion()
  spec.fit_dimensions = fitSet('live')
  spec.targeting_inputs = inputs
  return spec
}

// ── The fake database ────────────────────────────────────────────────────────

interface Write { table: string; payload: Row; filters: [string, unknown][]; matched: number }

function makeSupabase(tables: Record<string, Row[]>, options: {
  /** Tables whose reads return an error, as a failed query does. */
  failRead?: Record<string, string>
  /** Runs when an update is issued, before it is applied. Lets a row change under the call. */
  beforeUpdate?: (table: string) => void
} = {}) {
  const writes: Write[] = []
  const reads: string[] = []
  const unimplemented = (method: string) => () => {
    throw new Error(`fake supabase does not implement ${method}()`)
  }
  const client = {
    from(table: string) {
      const filters: [string, unknown][] = []
      let pending: Row | null = null
      const match = () =>
        (tables[table] ?? []).filter(row => filters.every(([column, value]) => row[column] === value))
      const applyUpdate = () => {
        options.beforeUpdate?.(table)
        const matched = match()
        writes.push({ table, payload: pending!, filters: [...filters], matched: matched.length })
        for (const row of matched) Object.assign(row, pending)
        return { data: matched.map(row => ({ id: row.id })), error: null }
      }
      const read = <T,>(shape: (rows: Row[]) => T) => {
        reads.push(table)
        const failure = options.failRead?.[table]
        if (failure) return { data: null, error: { message: failure } }
        return shape(match())
      }
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (column: string, value: unknown) => { filters.push([column, value]); return chain },
        is: (column: string, value: unknown) => { filters.push([column, value]); return chain },
        update: (payload: Row) => { pending = payload; return chain },
        single: async () => read(rows => rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: { message: `expected one row in ${table}, found ${rows.length}` } }),
        maybeSingle: async () => read(rows => ({ data: rows[0] ?? null, error: null })),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(pending ? applyUpdate() : read(rows => ({ data: rows, error: null }))).then(resolve),
        not: unimplemented('not'),
        in: unimplemented('in'),
        or: unimplemented('or'),
        order: unimplemented('order'),
        limit: unimplemented('limit'),
        insert: unimplemented('insert'),
        upsert: unimplemented('upsert'),
        delete: unimplemented('delete'),
      }
      return chain
    },
    rpc: unimplemented('rpc'),
  } as unknown as SupabaseClient
  return { client, writes, reads }
}

/** A client mid-campaign: live settings, a cursor part-way through, prospects with verdicts. */
function world(options: {
  content?: unknown
  live?: ICPFilterSpec | null
  proposed?: ICPFilterSpec | null
  status?: string
  documentType?: string
  buyerProfile?: Row | null
  revenueEnabled?: boolean
} = {}) {
  const document: Row = {
    id: DOC,
    organisation_id: ORG,
    document_type: options.documentType ?? 'icp',
    status: options.status ?? 'active',
    content: options.content ?? icpDocument(),
    icp_filter_spec: options.live === undefined ? liveSettings() : options.live,
    icp_filter_spec_proposed: options.proposed ?? null,
  }
  const tables: Record<string, Row[]> = {
    strategy_documents: [document],
    organisations: [
      { id: ORG, sourcing_revenue_filter_enabled: options.revenueEnabled ?? false },
      { id: OTHER_ORG, sourcing_revenue_filter_enabled: true },
    ],
    intake_buyer_profile: [
      ...(options.buyerProfile ? [{ organisation_id: ORG, ...options.buyerProfile }] : []),
      { organisation_id: OTHER_ORG, buyer_headcount_min: 700, buyer_headcount_max: 900 },
    ],
    sourcing_cursors: [{ organisation_id: ORG, icp_document_id: DOC, record_offset: 500 }],
    prospects: [
      { id: 'p-tier', organisation_id: ORG, sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)' },
      { id: 'p-removed', organisation_id: ORG, sourced_tier: null, tiering_reason: 'industry_off_target' },
      { id: 'p-fresh', organisation_id: ORG, sourced_tier: null, tiering_reason: null },
    ],
  }
  return { tables, document }
}

const snapshot = (value: unknown) => JSON.parse(JSON.stringify(value))
const modelCalls = () => ({
  criterion: models.criterion.mock.calls.length,
  geography: models.geography.mock.calls.length,
  fit: models.fit.mock.calls.length,
})
const proposalIn = (document: Row) => document.icp_filter_spec_proposed as ICPFilterSpec | null

beforeEach(() => {
  vi.restoreAllMocks()
  models.criterion.mockReset().mockResolvedValue({
    criterion: criterion({
      accept: [{ fragment: 'title three', rank: 'primary' }],
      reject: ['excluded title one', 'excluded title two'],
    }),
    vocabulary: { sells: 's', usedFor: 'u', nameWords: [] },
    seniority: seniorityFixture(3),
  })
  models.geography.mockReset().mockResolvedValue(aGeography(twoTargetableCodes()))
  models.fit.mockReset().mockResolvedValue(fitSet('rebuilt'))
  models.serviceClient.mockReset()
  vi.spyOn(logger, 'info').mockImplementation(() => {})
  vi.spyOn(logger, 'warn').mockImplementation(() => {})
  vi.spyOn(logger, 'error').mockImplementation(() => {})
})

describe('REPLAY of 2026-09-30: an edit to two trigger reasons', () => {
  function editedReasons() {
    const after = icpDocument()
    after.tier_1.triggers[5].reason = 'a rewritten reason for the sixth trigger'
    after.tier_1.triggers[6].reason = 'a rewritten reason for the seventh trigger'
    return after
  }

  it('leaves the settings, the cursor and every verdict untouched, and calls no model', async () => {
    const { tables, document } = world({ content: editedReasons() })
    const before = snapshot(tables)
    const { client, writes } = makeSupabase(tables)

    const result = await proposeIcpFilterSpec(client, DOC)

    expect(result).toEqual({ outcome: 'unchanged' })
    expect(modelCalls()).toEqual({ criterion: 0, geography: 0, fit: 0 })
    expect(writes).toEqual([])
    // Byte for byte: the search settings, the cursor, and each prospect's tier and reason.
    expect(snapshot(tables)).toEqual(before)
    expect(document.icp_filter_spec_proposed).toBeNull()
  })

  it('POSITIVE CONTROL: the same mocks do record a call when a buyer field changes', async () => {
    // Without this, the zeros above could mean the mocks were never attached.
    const edited = editedReasons()
    edited.tier_1.buyer_profile.title = 'a different placeholder buyer title'
    const { client } = makeSupabase(world({ content: edited }).tables)

    const result = await proposeIcpFilterSpec(client, DOC)

    expect(result.outcome).toBe('proposed')
    expect(modelCalls()).toEqual({ criterion: 1, geography: 0, fit: 1 })
  })

  it('holds for every prose field, not only the two that were edited that day', async () => {
    const edited = icpDocument() as Record<string, unknown> & ReturnType<typeof icpDocument>
    edited.summary = 'A rewritten summary.'
    edited.jtbd_statement = 'A rewritten job statement.'
    edited.tier_1.label = 'a new label'
    edited.tier_2.description = 'a new description'
    edited.tier_1.company_profile.stage = 'a new stage'
    edited.tier_2.company_profile.business_model = 'a new business model'
    edited.tier_1.buyer_profile.day_to_day = 'a new day'
    edited.tier_2.triggers.push({ event: 'a new event', reason: 'a new reason' })
    const { tables } = world({ content: edited })
    const before = snapshot(tables)
    const { client, writes } = makeSupabase(tables)

    expect(await proposeIcpFilterSpec(client, DOC)).toEqual({ outcome: 'unchanged' })
    expect(modelCalls()).toEqual({ criterion: 0, geography: 0, fit: 0 })
    expect(writes).toEqual([])
    expect(snapshot(tables)).toEqual(before)
  })
})

describe('a targeting edit files a proposal BESIDE the live settings', () => {
  async function propose(mutate: (doc: ReturnType<typeof icpDocument>) => void, options = {}) {
    const edited = icpDocument()
    mutate(edited)
    const { tables, document } = world({ content: edited, ...options })
    const liveBefore = snapshot(document.icp_filter_spec)
    const untouched = snapshot({ prospects: tables.prospects, cursors: tables.sourcing_cursors })
    const { client, writes } = makeSupabase(tables)
    const result = await proposeIcpFilterSpec(client, DOC)
    return { result, document, tables, writes, liveBefore, untouched }
  }

  it('a headcount edit proposes a headcount change and nothing else in the search', async () => {
    const { result, document, liveBefore } = await propose(d => {
      d.tier_2.company_profile.headcount = '41 to 120 people'
    })

    expect(result).toMatchObject({
      outcome: 'proposed',
      rebuilt: { geography: false, buyer_criterion: false, fit_dimensions: true },
      criterion_held: false,
    })
    // The live settings did not move.
    expect(snapshot(document.icp_filter_spec)).toEqual(liveBefore)

    const proposal = proposalIn(document)!
    const diff = diffSettings(document.icp_filter_spec as ICPFilterSpec, proposal)
    expect(diff.field_changes).toEqual([
      { field: 'company_headcount_max', kind: 'value', before: 90, after: 120 },
    ])
    expect(diff.criterion.changed).toBe(false)
    expect(diff.removed_exclusions).toEqual([])
    // The buyer criterion and the geography were NOT asked again.
    expect(modelCalls()).toEqual({ criterion: 0, geography: 0, fit: 1 })
    // Carried verbatim, and not merely equivalent.
    expect(proposal.buyer_criterion).toEqual(liveBefore.buyer_criterion)
    expect(proposal.job_titles).toEqual(liveBefore.job_titles)
    expect(proposal.seniority_levels).toEqual(liveBefore.seniority_levels)
    expect(proposal.company_countries).toEqual(liveBefore.company_countries)
    expect(proposal.person_countries).toEqual(liveBefore.person_countries)
  })

  it('a geography edit asks the geography derivation and nothing else about the buyer', async () => {
    const { result, document, liveBefore } = await propose(d => {
      d.tier_1.company_profile.geography = 'a different placeholder geography phrase'
    })
    expect(result).toMatchObject({ outcome: 'proposed', rebuilt: { geography: true, buyer_criterion: false } })
    expect(modelCalls()).toEqual({ criterion: 0, geography: 1, fit: 1 })
    const proposal = proposalIn(document)!
    expect(proposal.company_countries).toEqual(twoTargetableCodes())
    expect(proposal.person_countries).toEqual(twoTargetableCodes())
    expect(proposal.job_titles).toEqual(liveBefore.job_titles)
  })

  it('a buyer profile edit re-derives the criterion and leaves the geography alone', async () => {
    const { result, document, liveBefore } = await propose(d => {
      d.tier_2.buyer_profile.seniority = 'a different placeholder buyer level'
    })
    expect(result).toMatchObject({ outcome: 'proposed', rebuilt: { geography: false, buyer_criterion: true } })
    expect(modelCalls()).toEqual({ criterion: 1, geography: 0, fit: 1 })
    const proposal = proposalIn(document)!
    expect(proposal.job_titles).toEqual(['title three'])
    expect(proposal.job_titles_excluded).toEqual(['excluded title one', 'excluded title two'])
    expect(proposal.seniority_levels).toEqual(someBands(3))
    expect(proposal.buyer_criterion?.accept).toEqual([{ fragment: 'title three', rank: 'primary' }])
    expect(proposal.company_countries).toEqual(liveBefore.company_countries)
  })

  it('a disqualifier is a targeting field: editing one re-derives the criterion', async () => {
    const { result } = await propose(d => { d.tier_1.disqualifiers.push('a new placeholder rule') })
    expect(result).toMatchObject({ outcome: 'proposed', rebuilt: { buyer_criterion: true, geography: false } })
    expect(modelCalls().criterion).toBe(1)
  })

  it('stores the fields it was built from, so the next call knows it is already proposed', async () => {
    const edited = icpDocument()
    edited.tier_1.company_profile.headcount = '10 to 45 people'
    const { tables, document } = world({ content: edited })
    const { client, writes } = makeSupabase(tables)

    expect((await proposeIcpFilterSpec(client, DOC)).outcome).toBe('proposed')
    expect(proposalIn(document)!.targeting_inputs).toEqual(targetingInputs(edited, {}))
    const callsAfterFirst = modelCalls()
    const writesAfterFirst = writes.length

    // A prose edit lands while the proposal waits. Nothing is asked again.
    ;(document.content as ReturnType<typeof icpDocument>).summary = 'A rewritten summary.'
    expect(await proposeIcpFilterSpec(client, DOC)).toEqual({ outcome: 'already_proposed' })
    expect(modelCalls()).toEqual(callsAfterFirst)
    expect(writes.length).toBe(writesAfterFirst)
  })

  it('never re-queues a prospect and never touches the cursor, whatever changed', async () => {
    const edits: ((d: ReturnType<typeof icpDocument>) => void)[] = [
      d => { d.tier_1.company_profile.headcount = '10 to 45 people' },
      d => { d.tier_1.company_profile.geography = 'another placeholder geography' },
      d => { d.tier_1.buyer_profile.title = 'another placeholder title' },
      d => { d.tier_1.company_profile.industries.push(CANONICAL_INDUSTRIES[7]) },
      d => { d.tier_2.disqualifiers = [] },
    ]
    for (const edit of edits) {
      const { result, tables, writes, untouched } = await propose(edit)
      expect(result.outcome).toBe('proposed')
      expect(snapshot({ prospects: tables.prospects, cursors: tables.sourcing_cursors })).toEqual(untouched)
      // ONE write, to ONE column, on the ACTIVE row of this document.
      expect(writes.map(w => ({ table: w.table, keys: Object.keys(w.payload), filters: w.filters, matched: w.matched })))
        .toEqual([{
          table: 'strategy_documents',
          keys: ['icp_filter_spec_proposed'],
          filters: [['id', DOC], ['status', 'active']],
          matched: 1,
        }])
    }
  })

  it('logs the filed proposal at warn, with the fields that changed', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    await propose(d => { d.tier_1.company_profile.headcount = '10 to 45 people' })
    const line = warn.mock.calls.find(call => String(call[0]).includes('proposal filed for approval'))
    expect(line).toBeDefined()
    expect((line![1] as Row).changed_paths).toEqual(['document.tier_1.company_profile.headcount'])
    expect((line![1] as Row).organisation_id).toBe(ORG)
  })
})

describe('the floor: the buyer criterion stays applied', () => {
  function buyerEdit() {
    const edited = icpDocument()
    edited.tier_1.buyer_profile.title = 'a different placeholder buyer title'
    return edited
  }

  it('keeps the live criterion when the re-derived one does not gate, and says so', async () => {
    for (const status of ['out_of_band', 'unsettled'] as const) {
      models.criterion.mockResolvedValue({
        criterion: criterion({
          status,
          accept: [{ fragment: 'title nine', rank: 'primary' }],
          unsettled_reason: status === 'unsettled' ? 'the documents disagree' : null,
          sanity: status === 'out_of_band'
            ? { checked: true, sample_size: 206, accept_rate: 0.956, note: 'accepts 197 of 206' }
            : null,
        }),
        vocabulary: { sells: 's', usedFor: 'u', nameWords: [] },
        seniority: seniorityFixture(4),
      })
      const { tables, document } = world({ content: buyerEdit() })
      const live = snapshot(document.icp_filter_spec)
      const { client } = makeSupabase(tables)

      const result = await proposeIcpFilterSpec(client, DOC)

      expect(result).toMatchObject({ outcome: 'proposed', criterion_held: true })
      const proposal = proposalIn(document)!
      // The criterion, its titles and its seniority are the LIVE ones. Half of one call's
      // answer beside half of another's would be settings nobody derived.
      expect(proposal.buyer_criterion).toEqual(live.buyer_criterion)
      expect(proposal.job_titles).toEqual(live.job_titles)
      expect(proposal.job_titles_excluded).toEqual(live.job_titles_excluded)
      expect(proposal.seniority_levels).toEqual(live.seniority_levels)
      expect(diffSettings(live, proposal).criterion.gates_after).toBe(true)
      expect(proposal.criterion_held?.rederived_status).toBe(status)
      expect(proposal.criterion_held?.reason).toBe(
        status === 'unsettled' ? 'the documents disagree' : 'accepts 197 of 206')
    }
  })

  it('a criterion with an empty accept list does not gate either, whatever its status says', async () => {
    models.criterion.mockResolvedValue({
      criterion: criterion({ accept: [] }),
      vocabulary: { sells: 's', usedFor: 'u', nameWords: [] },
      seniority: seniorityFixture(2),
    })
    const { tables, document } = world({ content: buyerEdit() })
    const { client } = makeSupabase(tables)
    expect(await proposeIcpFilterSpec(client, DOC)).toMatchObject({ criterion_held: true })
    expect(proposalIn(document)!.job_titles).toEqual(['title one', 'title two'])
  })

  it('with nothing live to keep, proposes the non-gating criterion and warns it cannot be approved', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    models.criterion.mockResolvedValue({
      criterion: criterion({ status: 'unsettled', unsettled_reason: 'the documents disagree' }),
      vocabulary: { sells: 's', usedFor: 'u', nameWords: [] },
      seniority: seniorityFixture(2),
    })
    const { tables, document } = world({ live: null })
    const { client } = makeSupabase(tables)

    const result = await proposeIcpFilterSpec(client, DOC)

    expect(result).toMatchObject({ outcome: 'proposed', criterion_held: false })
    expect(proposalIn(document)!.buyer_criterion?.status).toBe('unsettled')
    expect(document.icp_filter_spec).toBeNull()
    expect(warn.mock.calls.some(call => String(call[0]).includes('does not gate and none is live'))).toBe(true)
  })
})

describe('first settings, and settings with no record of what they were built from', () => {
  it('a client with no settings gets a proposal built from everything, and stays unsourced', async () => {
    const { tables, document } = world({ live: null })
    const { client } = makeSupabase(tables)

    const result = await proposeIcpFilterSpec(client, DOC)

    expect(result).toMatchObject({
      outcome: 'proposed',
      rebuilt: { geography: true, buyer_criterion: true, fit_dimensions: true },
    })
    expect(modelCalls()).toEqual({ criterion: 1, geography: 1, fit: 1 })
    expect(document.icp_filter_spec).toBeNull()
    const proposal = proposalIn(document)!
    expect(proposal.job_titles).toEqual(['title three'])
    expect(proposal.fit_dimensions).toEqual(fitSet('rebuilt'))
    expect(proposal.targeting_inputs).toEqual(targetingInputs(icpDocument(), {}))
  })

  it('settings with no stored inputs count as changed: "cannot tell" is never "unchanged"', async () => {
    const legacy = liveSettings()
    delete legacy.targeting_inputs
    const { tables, document } = world({ live: legacy })
    const { client } = makeSupabase(tables)

    const result = await proposeIcpFilterSpec(client, DOC)

    expect(result).toMatchObject({ outcome: 'proposed' })
    if (result.outcome !== 'proposed') throw new Error('unreachable')
    expect(result.change.unknown_before).toBe(true)
    expect(modelCalls()).toEqual({ criterion: 1, geography: 1, fit: 1 })
    // And still only a proposal: the legacy settings are what the client keeps running on.
    expect(document.icp_filter_spec).toEqual(legacy)
  })
})

describe('a pending proposal that is no longer wanted', () => {
  it('is cleared when the document is edited back to what the live settings were built from', async () => {
    const stale = liveSettings()
    stale.company_headcount_max = 999
    const { tables, document } = world({ proposed: stale })
    const live = snapshot(document.icp_filter_spec)
    const { client, writes } = makeSupabase(tables)

    expect(await proposeIcpFilterSpec(client, DOC)).toEqual({ outcome: 'proposal_cleared' })
    expect(document.icp_filter_spec_proposed).toBeNull()
    expect(document.icp_filter_spec).toEqual(live)
    expect(modelCalls()).toEqual({ criterion: 0, geography: 0, fit: 0 })
    expect(writes.map(w => [w.table, w.payload, w.filters])).toEqual([
      ['strategy_documents', { icp_filter_spec_proposed: null }, [['id', DOC], ['status', 'active']]],
    ])
  })
})

describe('the two inputs outside the document', () => {
  it('a headcount typed into intake replaces the parsed one, with no model call', async () => {
    const { tables, document } = world({
      buyerProfile: { buyer_headcount_min: 12, buyer_headcount_max: 60 },
    })
    const { client } = makeSupabase(tables)

    const result = await proposeIcpFilterSpec(client, DOC)

    expect(result).toMatchObject({
      outcome: 'proposed',
      rebuilt: { geography: false, buyer_criterion: false, fit_dimensions: false },
    })
    expect(modelCalls()).toEqual({ criterion: 0, geography: 0, fit: 0 })
    const proposal = proposalIn(document)!
    expect([proposal.company_headcount_min, proposal.company_headcount_max]).toEqual([12, 60])
    expect(proposal.fit_dimensions).toEqual(fitSet('live'))
  })

  it('reads THIS organisation\'s headcount and switch, never another\'s', async () => {
    // The other organisation has a headcount answer and the switch on. Neither may leak.
    const { tables } = world()
    const { client, writes } = makeSupabase(tables)
    expect(await proposeIcpFilterSpec(client, DOC)).toEqual({ outcome: 'unchanged' })
    expect(writes).toEqual([])
  })

  it('the revenue switch, turned on, proposes sending a band the document states', async () => {
    const withBand = icpDocument()
    withBand.tier_1.company_profile.revenue_range = 'between 500K and 5M'
    const { tables, document } = world({
      content: withBand,
      live: liveSettings(withBand, { revenueFilterEnabled: false }),
      revenueEnabled: true,
    })
    const live = document.icp_filter_spec as ICPFilterSpec
    expect(live.omitted_axes).toContain('company_revenue')
    expect(live.omission_reasons?.company_revenue?.startsWith(REVENUE_NOT_OPTED_IN_LEAD)).toBe(true)
    const { client } = makeSupabase(tables)

    const result = await proposeIcpFilterSpec(client, DOC)

    expect(result).toMatchObject({ outcome: 'proposed' })
    expect(modelCalls()).toEqual({ criterion: 0, geography: 0, fit: 0 })
    const diff = diffSettings(live, proposalIn(document)!)
    expect(diff.axes_switched_on).toEqual(['company_revenue'])
    expect(diff.field_changes).toEqual([])
    // Carried over, the switched-off axis was the RULE's doing, so the notes must not claim
    // the derivation proposed it.
    expect(proposalIn(document)!.notes).not.toMatch(/derivation proposed switching it off/)
  })

  it('a FAILED read of either ends the call: a guess would propose a change nobody made', async () => {
    for (const table of ['organisations', 'intake_buyer_profile']) {
      const { tables, document } = world({
        live: liveSettings(icpDocument(), { statedHeadcount: { min: 12, max: 60 } }),
        buyerProfile: { buyer_headcount_min: 12, buyer_headcount_max: 60 },
      })
      const before = snapshot(tables)
      const { client, writes } = makeSupabase(tables, { failRead: { [table]: 'connection lost' } })

      const result = await proposeIcpFilterSpec(client, DOC)

      expect(result, table).toMatchObject({ outcome: 'failed', error: 'connection lost' })
      expect(writes, table).toEqual([])
      expect(snapshot(tables), table).toEqual(before)
      expect(document.icp_filter_spec_proposed, table).toBeNull()
    }
  })
})

describe('a failure leaves the live settings in force and files nothing', () => {
  function changed() {
    const edited = icpDocument()
    edited.tier_1.company_profile.geography = 'a different placeholder geography phrase'
    edited.tier_1.buyer_profile.title = 'a different placeholder buyer title'
    return edited
  }
  const cases: [string, () => void, RegExp][] = [
    ['the geography cannot be resolved', () => models.geography.mockRejectedValue(new Error('no country named')), /no country named/],
    ['the buyer criterion call throws', () => models.criterion.mockRejectedValue(new Error('model unavailable')), /model unavailable/],
  ]
  for (const [name, arrange, message] of cases) {
    it(`when ${name}`, async () => {
      arrange()
      const { tables, document } = world({ content: changed() })
      const live = snapshot(document.icp_filter_spec)
      const { client, writes } = makeSupabase(tables)

      const result = await proposeIcpFilterSpec(client, DOC)

      expect(result.outcome).toBe('failed')
      if (result.outcome !== 'failed') throw new Error('unreachable')
      expect(result.error).toMatch(message)
      expect(writes).toEqual([])
      expect(document.icp_filter_spec).toEqual(live)
      expect(document.icp_filter_spec_proposed).toBeNull()
    })
  }

  it('when the document names an industry outside the canonical list, and says THAT', async () => {
    const edited = icpDocument()
    edited.tier_1.company_profile.industries =
      ['Not A Canonical Industry'] as unknown as typeof edited.tier_1.company_profile.industries
    const { tables, document } = world({ content: edited })
    const { client, writes } = makeSupabase(tables)

    const result = await proposeIcpFilterSpec(client, DOC)

    expect(result).toMatchObject({ outcome: 'failed', step: 'derive the settings from the targeting fields' })
    if (result.outcome !== 'failed') throw new Error('unreachable')
    expect(result.error).toMatch(/not a canonical industry name/)
    expect(writes).toEqual([])
    expect(document.icp_filter_spec_proposed).toBeNull()
  })

  it('a failed fit-dimension call does not stop the proposal: the live set is carried', async () => {
    models.fit.mockRejectedValue(new Error('fit model unavailable'))
    const edited = icpDocument()
    edited.tier_1.company_profile.headcount = '10 to 45 people'
    const { tables, document } = world({ content: edited })
    const { client } = makeSupabase(tables)

    expect((await proposeIcpFilterSpec(client, DOC)).outcome).toBe('proposed')
    expect(proposalIn(document)!.fit_dimensions).toEqual(fitSet('live'))
  })
})

describe('documents it must not act on', () => {
  it('does nothing for a document that is not an ICP', async () => {
    const { tables } = world({ documentType: 'positioning', live: null })
    const { client, writes, reads } = makeSupabase(tables)
    expect(await proposeIcpFilterSpec(client, DOC)).toEqual({ outcome: 'skipped', why: 'not_icp' })
    expect(writes).toEqual([])
    expect(reads).toEqual(['strategy_documents'])
    expect(modelCalls()).toEqual({ criterion: 0, geography: 0, fit: 0 })
  })

  it('does nothing for a version that is no longer active', async () => {
    const edited = icpDocument()
    edited.tier_1.company_profile.headcount = '10 to 45 people'
    const { tables } = world({ content: edited, status: 'archived' })
    const { client, writes } = makeSupabase(tables)
    expect(await proposeIcpFilterSpec(client, DOC)).toEqual({ outcome: 'skipped', why: 'not_active' })
    expect(writes).toEqual([])
    expect(modelCalls()).toEqual({ criterion: 0, geography: 0, fit: 0 })
  })

  it('stores nothing when the version is archived BETWEEN the read and the write', async () => {
    // The conflict has to happen at the write, not before the read: set up beforehand, the
    // call returns at the status check and never reaches the filter being tested.
    const edited = icpDocument()
    edited.tier_1.company_profile.headcount = '10 to 45 people'
    const { tables, document } = world({ content: edited })
    const { client, writes } = makeSupabase(tables, {
      beforeUpdate: () => { document.status = 'archived' },
    })

    expect(await proposeIcpFilterSpec(client, DOC)).toEqual({ outcome: 'skipped', why: 'not_active' })
    expect(writes.map(w => w.matched)).toEqual([0])
    expect(document.icp_filter_spec_proposed).toBeNull()
  })

  it('reports a document that does not exist, and does not throw', async () => {
    const { client } = makeSupabase(world().tables)
    expect(await proposeIcpFilterSpec(client, 'no-such-document'))
      .toEqual({ outcome: 'skipped', why: 'not_found' })
  })
})

describe('proposeIcpFilterSpecForOrganisationSafely: the intake headcount and the revenue switch', () => {
  it('finds the organisation\'s active ICP and runs the same comparison', async () => {
    const { tables, document } = world({
      buyerProfile: { buyer_headcount_min: 12, buyer_headcount_max: 60 },
    })
    const { client } = makeSupabase(tables)
    models.serviceClient.mockResolvedValue(client)

    const result = await proposeIcpFilterSpecForOrganisationSafely(ORG)

    expect(result).toMatchObject({ outcome: 'proposed' })
    expect(proposalIn(document)!.company_headcount_max).toBe(60)
  })

  it('does nothing for an organisation with no active ICP', async () => {
    const { client, writes } = makeSupabase(world({ status: 'archived' }).tables)
    models.serviceClient.mockResolvedValue(client)
    expect(await proposeIcpFilterSpecForOrganisationSafely(ORG)).toBeNull()
    expect(writes).toEqual([])
  })

  it('never throws: the answer the caller was saving is already saved', async () => {
    models.serviceClient.mockRejectedValue(new Error('SUPABASE_SERVICE_ROLE_KEY environment variable not set'))
    await expect(proposeIcpFilterSpecForOrganisationSafely(ORG)).resolves.toBeNull()
  })
})
