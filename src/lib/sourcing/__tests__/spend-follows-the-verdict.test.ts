// WHO GETS SPENT ON. Not who gets a row written.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE IS PHRASED IN MONEY
//
// Ten mutation proofs already cover the tiering verdict and every one of them checks that a
// VERDICT IS COMPUTED AND STORED. None checked that a paid stage declines to run because of
// it, and for most of this pipeline's life none did: the verdict was written to the row and
// read by nothing that spends. So every assertion here is about whether a prospect is
// admitted to a paid stage, and every mutation that breaks one breaks the SPEND.
//
// The two facts under test pull in opposite directions, which is the point:
//
//   the buyer criterion REFUSES to spend      a title the client's own profile rejects
//   the concurrent-role count SPENDS ANYWAY   a second current position removes nobody
//
// RULE ZERO: no industry, sector, country, company or real job title below.

import { describe, it, expect } from 'vitest'
import { classifyTier, type EnrichedProspect } from '@/lib/sourcing/tier-classification'
import { TIER_NOT_REJECTED_FILTER, TIER_PRESENT_COLUMN } from '@/lib/sourcing/tier-verdict'
import { evaluateOrFilter } from '@/lib/sourcing/__tests__/helpers/fake-prospects-client'
import type { ICPFilterSpec } from '@/lib/agents/icp-filter-spec'
import { CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'
import { aTargetableCode } from '@/test-utils/geography-fixture'
import { someBands } from '@/test-utils/seniority-fixture'

const ACCEPTED_FRAGMENT = 'placeholder-accepted-word'
const REJECTED_TITLE = 'placeholder-unrelated-role'

function spec(): ICPFilterSpec {
  const code = aTargetableCode()
  return {
    job_titles: [ACCEPTED_FRAGMENT], job_titles_excluded: [], seniority_levels: someBands(2),
    person_countries: [code], company_countries: [code],
    company_headcount_min: 1, company_headcount_max: 5000,
    industries: [CANONICAL_INDUSTRIES[0]], industries_excluded: [],
    keywords: [], keywords_excluded: [],
    company_revenue_min: null, company_revenue_max: null, notes: '',
    buyer_criterion: {
      status: 'derived',
      accept: [{ fragment: ACCEPTED_FRAGMENT, rank: 'primary' }],
      reject: [],
      statement: 'placeholder', evidence: [], unsettled_reason: null, sanity: null,
      derived_at: new Date(0).toISOString(), model: 'test',
    },
  } as unknown as ICPFilterSpec
}

/** Someone holding three open-ended positions at other organisations. */
function blobWithOtherCurrentRoles(): unknown {
  return {
    organization_id: 'own-org',
    employment_history: [
      { current: true, end_date: null, organization_id: 'own-org' },
      { current: true, end_date: null, organization_id: 'other-a' },
      { current: true, end_date: null, organization_id: 'other-b' },
      { current: true, end_date: null, organization_id: 'other-c' },
    ],
  }
}

function prospect(over: Partial<EnrichedProspect> = {}): EnrichedProspect {
  return {
    id: 'p1',
    organisation_id: 'org',
    job_title: `a ${ACCEPTED_FRAGMENT} of something`,
    email_status: 'verified',
    enrichment_status: 'enriched',
    company_headcount: 10,
    company_industry: CANONICAL_INDUSTRIES[0],
    company_name: 'Placeholder Company',
    ...over,
  } as EnrichedProspect
}

/** The admission decision the paid selections actually make, evaluated honestly. */
const admittedToPaidWork = (row: Record<string, unknown>) =>
  evaluateOrFilter(TIER_NOT_REJECTED_FILTER, row)

/** The send gate's stricter rule: a positive tier is required. */
const admittedToSending = (row: Record<string, unknown>) => row[TIER_PRESENT_COLUMN] !== null

describe('a second current position does not refuse anyone money', () => {
  it('scores someone holding three other current positions, rather than removing them', async () => {
    const result = await classifyTier(
      prospect({ apollo_enrichment_data: blobWithOtherCurrentRoles() } as Partial<EnrichedProspect>),
      spec(),
    )

    // THE ECONOMIC CLAIM. A real tier is what carries a prospect through every paid stage and
    // through the send gate. A null tier is the refusal.
    expect(result.sourced_tier).not.toBeNull()
    expect(result.fit_score).not.toBeNull()
    expect(result.tiering_reason).not.toBe('holds_another_current_role')

    const row = { sourced_tier: result.sourced_tier, tiering_reason: result.tiering_reason }
    expect(admittedToPaidWork(row)).toBe(true)
    expect(admittedToSending(row)).toBe(true)
  })

  it('reaches the same answer however many other positions there are', async () => {
    // The withdrawn rule removed on a threshold of one, so one is the case that has to pass.
    const one = {
      organization_id: 'own-org',
      employment_history: [
        { current: true, end_date: null, organization_id: 'own-org' },
        { current: true, end_date: null, organization_id: 'other-a' },
      ],
    }
    const result = await classifyTier(
      prospect({ apollo_enrichment_data: one } as Partial<EnrichedProspect>),
      spec(),
    )
    expect(result.sourced_tier).not.toBeNull()
    expect(result.tiering_reason).not.toBe('holds_another_current_role')
  })
})

describe('the buyer criterion still refuses to spend', () => {
  it('rejects a title the client\'s own profile does not accept, and the refusal reaches the money', async () => {
    const result = await classifyTier(prospect({ job_title: REJECTED_TITLE }), spec())

    expect(result.sourced_tier).toBeNull()
    expect(result.tiering_reason).toBe('not_decision_maker')

    const row = { sourced_tier: null, tiering_reason: 'not_decision_maker' }
    // THE POINT OF THE WHOLE FILE: the verdict is not merely written, it is refused entry.
    expect(admittedToPaidWork(row)).toBe(false)
    expect(admittedToSending(row)).toBe(false)
  })
})

describe('no verdict is ungraded, never disqualified', () => {
  it('admits a prospect tiering has never reached to every paid stage', () => {
    // Both columns null. This is the majority of a fresh batch, and it is the row a `neq`
    // filter would silently drop: in SQL three-valued logic NULL <> 'x' is NULL, not true.
    expect(admittedToPaidWork({ sourced_tier: null, tiering_reason: null })).toBe(true)
  })

  it('still refuses to SEND to a prospect tiering has never reached', () => {
    // Deliberately asymmetric. Spending is recoverable, a sent email is not.
    expect(admittedToSending({ sourced_tier: null, tiering_reason: null })).toBe(false)
  })

  it('distinguishes never-tiered from rejected, which are the same value in sourced_tier', () => {
    const neverTiered = { sourced_tier: null, tiering_reason: null }
    const rejected = { sourced_tier: null, tiering_reason: 'not_decision_maker' }
    expect(neverTiered.sourced_tier).toBe(rejected.sourced_tier)
    expect(admittedToPaidWork(neverTiered)).toBe(true)
    expect(admittedToPaidWork(rejected)).toBe(false)
  })
})
