// ADR-061, end to end, against the real TEST database: the 2026-09-30 edit, replayed.
//
// The unit test beside this file proves the comparison on a fake that honours filters. This
// one joins the two halves that were built separately: the SQL promote function, which
// carries the settings and the cursor onto the new version, and the TypeScript comparison
// that runs after it. A test on each half proves both halves and says nothing about the
// handoff, and the handoff is where "the new version is live with nothing on it" used to be.
//
// The three model calls are mocked so they can be COUNTED, and nothing here can spend
// money. Everything else is real: the tables, the promote function, the reads of the
// revenue switch and the intake headcount, and the write of the proposal.
//
// Every organisation here is created by this file and deleted by this file, by id.
// Nothing names a real industry, role, band or country.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

const models = vi.hoisted(() => ({ criterion: vi.fn(), geography: vi.fn(), fit: vi.fn() }))
vi.mock('@/agents/buyer-criterion-agent', () => ({
  deriveBuyerCriterionWithVocabulary: (...args: unknown[]) => models.criterion(...args),
}))
vi.mock('@/agents/fit-dimensions-agent', () => ({
  deriveFitDimensions: (...args: unknown[]) => models.fit(...args),
}))
vi.mock('@/lib/sourcing/resolve-icp-geography', () => ({
  resolveIcpGeography: (...args: unknown[]) => models.geography(...args),
}))

import { createTestServiceClient } from '@/test-utils/test-database'
import { deleteTestOrganisations } from '@/test-utils/delete-test-organisations'
import { proposeIcpFilterSpec } from '@/lib/sourcing/propose-icp-filter-spec'
import { CANONICAL_INDUSTRIES, deriveFilterSpec, type ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import type { BuyerCriterion } from '@/lib/sourcing/buyer-criterion'
import { targetingInputs } from '@/lib/sourcing/targeting-inputs'
import { aGeography } from '@/test-utils/geography-fixture'
import { seniorityFixture } from '@/test-utils/seniority-fixture'

const CONTEXT = 'propose-icp-filter-spec.live.test.ts'

let service: SupabaseClient<Database>
let untyped: SupabaseClient
const created: string[] = []

function tier(name: string, industryAt: number, headcount: string) {
  return {
    company_profile: {
      industries: [CANONICAL_INDUSTRIES[industryAt]],
      headcount,
      revenue_range: `placeholder revenue phrase ${name}`,
      geography: `placeholder geography phrase ${name}`,
      stage: `placeholder stage ${name}`,
    },
    buyer_profile: { title: `placeholder buyer title ${name}`, seniority: `placeholder buyer level ${name}` },
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

const criterion: BuyerCriterion = {
  status: 'derived',
  accept: [{ fragment: 'title one', rank: 'primary' }],
  reject: ['excluded title one'],
  statement: 'A placeholder statement of who decides.',
  evidence: [],
  unsettled_reason: null,
  sanity: null,
  derived_at: '2026-01-01T00:00:00.000Z',
  model: 'test-model',
}

/** Approved settings, as the stamping step leaves them: derived, with their inputs stored. */
function approvedSettings(): ICPFilterSpec {
  const inputs = targetingInputs(icpDocument(), {})
  const spec = deriveFilterSpec(inputs.document, criterion, aGeography(), seniorityFixture())
  spec.buyer_criterion = criterion
  spec.targeting_inputs = inputs
  return spec
}

async function seedClientMidCampaign() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const { data: org, error: orgError } = await service
    .from('organisations')
    .insert({ name: `replay ${stamp}`, slug: `replay-${stamp}` })
    .select('id').single()
  expect(orgError).toBeNull()
  const organisationId = org!.id
  created.push(organisationId)

  const { data: doc, error: docError } = await untyped
    .from('strategy_documents')
    .insert({
      organisation_id: organisationId, document_type: 'icp', status: 'active', version: '1',
      content: icpDocument(),
      icp_filter_spec: approvedSettings(),
      icp_filter_spec_approved_at: '2026-01-02T03:04:05.000Z',
    })
    .select('id').single()
  expect(docError).toBeNull()

  const { error: cursorError } = await untyped.from('sourcing_cursors').insert({
    organisation_id: organisationId, icp_document_id: doc!.id, record_offset: 500,
  })
  expect(cursorError).toBeNull()

  const { error: prospectError } = await untyped.from('prospects').insert([
    { organisation_id: organisationId, sourced_tier: 'tier_1', tiering_reason: 'tier_1 (score 90)' },
    { organisation_id: organisationId, sourced_tier: null, tiering_reason: 'industry_off_target' },
    { organisation_id: organisationId, sourced_tier: null, tiering_reason: 'not_decision_maker' },
    { organisation_id: organisationId, sourced_tier: null, tiering_reason: null },
  ])
  expect(prospectError).toBeNull()

  return { organisationId, firstId: doc!.id as string }
}

async function promote(organisationId: string, content: unknown) {
  const { data, error } = await untyped.rpc('promote_strategy_doc_version', {
    p_org_id: organisationId, p_doc_type: 'icp', p_segment_id: null,
    p_content: content, p_update_trigger: 'signal_suggestion',
  })
  expect(error).toBeNull()
  return (data as { id: string }).id
}

/** Everything the 2026-09-30 incident moved, read back in one shape. */
async function state(organisationId: string) {
  const { data: doc } = await untyped
    .from('strategy_documents')
    .select('id, version, icp_filter_spec, icp_filter_spec_proposed, icp_filter_spec_approved_at')
    .eq('organisation_id', organisationId).eq('document_type', 'icp').eq('status', 'active').single()
  const { data: cursor } = await untyped
    .from('sourcing_cursors').select('icp_document_id, record_offset')
    .eq('organisation_id', organisationId).single()
  const { data: prospects } = await untyped
    .from('prospects').select('id, sourced_tier, tiering_reason')
    .eq('organisation_id', organisationId).order('id')
  return { doc: doc!, cursor: cursor!, prospects: prospects! }
}

const modelCalls = () => ({
  criterion: models.criterion.mock.calls.length,
  geography: models.geography.mock.calls.length,
  fit: models.fit.mock.calls.length,
})

beforeAll(() => {
  service = createTestServiceClient(CONTEXT)
  untyped = service as SupabaseClient
})

afterAll(async () => {
  if (created.length > 0) await deleteTestOrganisations(service, created, CONTEXT)
})

beforeEach(() => {
  models.criterion.mockReset().mockResolvedValue({
    criterion: { ...criterion, accept: [{ fragment: 'title two', rank: 'primary' }] },
    vocabulary: { sells: 's', usedFor: 'u', nameWords: [] },
    seniority: seniorityFixture(3),
  })
  models.geography.mockReset().mockResolvedValue(aGeography())
  models.fit.mockReset().mockResolvedValue({ dimensions: [], derived_at: '2026-01-01T00:00:00.000Z', model: 'test-model' })
})

describe('REPLAY, end to end: approving an edit to two trigger reasons', () => {
  it('leaves the search settings, the cursor and every tiering verdict unchanged, and calls no model', async () => {
    const { organisationId, firstId } = await seedClientMidCampaign()
    const before = await state(organisationId)

    const edited = icpDocument()
    edited.tier_1.triggers[5].reason = 'a rewritten reason for the sixth trigger'
    edited.tier_1.triggers[6].reason = 'a rewritten reason for the seventh trigger'
    const newId = await promote(organisationId, edited)
    const outcome = await proposeIcpFilterSpec(untyped, newId)

    expect(outcome).toEqual({ outcome: 'unchanged' })
    expect(modelCalls()).toEqual({ criterion: 0, geography: 0, fit: 0 })

    const after = await state(organisationId)
    // A new version, carrying the same settings and the same approval, with nothing pending.
    expect(after.doc.id).toBe(newId)
    expect(after.doc.id).not.toBe(firstId)
    expect(after.doc.version).toBe('2')
    expect(after.doc.icp_filter_spec).toEqual(before.doc.icp_filter_spec)
    expect(after.doc.icp_filter_spec_approved_at).toEqual(before.doc.icp_filter_spec_approved_at)
    expect(after.doc.icp_filter_spec_proposed).toBeNull()
    // The client's place in the search: same offset, now keyed to the new version.
    expect(before.cursor).toEqual({ icp_document_id: firstId, record_offset: 500 })
    expect(after.cursor).toEqual({ icp_document_id: newId, record_offset: 500 })
    // Every prospect's tier and reason, removed ones included. Nothing was re-queued.
    expect(after.prospects).toEqual(before.prospects)
    expect(after.prospects.filter(p => p.tiering_reason !== null).length).toBe(3)
  })

  it('POSITIVE CONTROL: a buyer edit on the same client does call a model, and still changes nothing live', async () => {
    const { organisationId } = await seedClientMidCampaign()
    const before = await state(organisationId)

    const edited = icpDocument()
    edited.tier_1.buyer_profile.title = 'a different placeholder buyer title'
    const newId = await promote(organisationId, edited)
    const outcome = await proposeIcpFilterSpec(untyped, newId)

    // The mocks CAN record a call, so the zeros in the test above are real zeros.
    expect(outcome).toMatchObject({ outcome: 'proposed', rebuilt: { buyer_criterion: true, geography: false } })
    expect(modelCalls()).toEqual({ criterion: 1, geography: 0, fit: 1 })

    const after = await state(organisationId)
    // A proposal now waits BESIDE the live settings, which did not move.
    expect(after.doc.icp_filter_spec).toEqual(before.doc.icp_filter_spec)
    expect((after.doc.icp_filter_spec_proposed as ICPFilterSpec).job_titles).toEqual(['title two'])
    expect((after.doc.icp_filter_spec as ICPFilterSpec).job_titles).toEqual(['title one'])
    expect(after.cursor).toEqual({ icp_document_id: newId, record_offset: 500 })
    expect(after.prospects).toEqual(before.prospects)
  })
})
