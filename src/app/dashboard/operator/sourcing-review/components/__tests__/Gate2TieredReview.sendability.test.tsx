// @vitest-environment jsdom
//
// THE SCREEN AN OPERATOR ACTUALLY READS BEFORE PUBLISHING A BATCH.
//
// On 2026-09-08 this screen showed "Can be emailed: Yes" for a prospect who had been stopped
// that morning, with a "Stopped" badge in the very next column. Two more rows said Yes for
// people who had replied `stop` in August. All three were inside the "N can be emailed"
// figure in the tier header and in the summary cards at the top.
//
// This file covers that screen SPECIFICALLY, and not through the helper it shares with the
// pipeline overview. The two screens are asserted separately on purpose: a single test over
// the shared helper would go green for both while either screen quietly kept its own copy of
// the logic, which is exactly how the funnel stage stayed wrong.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { Gate2TieredReview } from '../Gate2TieredReview'
import type { Database } from '@/types/database'

type Prospect = Database['public']['Tables']['prospects']['Row']

// A fixture carrying every field this screen reads. Cast once, HERE, rather than at each use:
// the prospects row has ~90 columns and the component touches a dozen. The cast is on a test
// fixture, never on production data, and the fields below are the ones the screen renders.
function prospect(overrides: Partial<Prospect> & { id: string }): Prospect {
  return {
    first_name: 'Sam',
    last_name: 'Reed',
    email: 'sam@northwind.example',
    company_name: 'Northwind',
    job_title: 'Operations Lead',
    company_headcount: 20,
    company_industry: 'Management Consulting',
    linkedin_url: null,
    website_url: null,
    tiering_reason: 'tier_1 (score 100): industry 45, seniority 35, headcount 20',
    suppressed: false,
    email_send_eligible: true,
    email_send_ineligible_reason: null,
    independent_verified_at: '2026-09-01T00:00:00Z',
    independent_email_status: 'Valid',
    verification_provider: 'myemailverifier',
    second_pass_status: null,
    second_pass_provider: null,
    ...overrides,
  } as unknown as Prospect
}

function renderTier1(prospects: Prospect[]) {
  return render(
    <Gate2TieredReview
      prospects={prospects}
      organisationId="org-1"
      organisationName="Test Org"
      tiering={{ tier_1: prospects, tier_2: [], tier_3: [] }}
      removedByReason={{}}
      removedCount={0}
    />,
  )
}

afterEach(cleanup)

describe('the quality-check screen does not offer a stopped prospect as contactable', () => {
  it('shows Yes for a prospect the send gate would send to', () => {
    // The control. A screen that said "no" to everyone would satisfy every assertion below
    // while being far more broken than the defect being fixed.
    renderTier1([prospect({ id: 'p1' })])
    expect(screen.getByText('Yes')).toBeInTheDocument()
    // getAllByText, not getByText: the figure appears twice on purpose, once in the summary
    // card at the top and once in the tier header. Both must agree, which is asserted below.
    expect(screen.getAllByText('1 can be emailed')).toHaveLength(2)
  })

  it('does not say Yes for a suppressed prospect whose eligibility column still says true', () => {
    // THE ROW AS IT SHIPPED. Suppressed, and email_send_eligible never rewritten, because
    // stopProspect deliberately does not touch that column: durability comes from the hold,
    // applied at the next verification, which may never happen.
    renderTier1([prospect({ id: 'p1', suppressed: true })])
    expect(screen.queryByText('Yes')).not.toBeInTheDocument()
    expect(screen.getByText('Stopped, not to be contacted')).toBeInTheDocument()
  })

  it('does not contradict itself between the sendability column and the Stop column', () => {
    // The visible symptom, pinned as its own case: the same row rendered "Yes" next to a
    // "Stopped" badge. Whatever else changes here, those two cells must never disagree.
    renderTier1([prospect({ id: 'p1', suppressed: true })])
    const row = screen.getByText('Sam Reed').closest('tr')
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getByText('Stopped')).toBeInTheDocument()
    expect(within(row as HTMLElement).queryByText('Yes')).not.toBeInTheDocument()
  })

  it('excludes suppressed prospects from the tier header count', () => {
    // The number an operator plans campaign volume from. Three sendable, two stopped.
    renderTier1([
      prospect({ id: 'p1' }),
      prospect({ id: 'p2' }),
      prospect({ id: 'p3' }),
      prospect({ id: 'p4', suppressed: true }),
      prospect({ id: 'p5', suppressed: true }),
    ])
    expect(screen.getAllByText('5 prospects').length).toBeGreaterThan(0)
    expect(screen.getAllByText('3 can be emailed').length).toBeGreaterThan(0)
    expect(screen.queryByText('5 can be emailed')).not.toBeInTheDocument()
  })

  it('still counts the stopped prospect in the tier total, so the filter stays readable', () => {
    // Suppression must not delete anyone from the tier arithmetic. The tier total is how the
    // operator judges whether the filter is behaving; a row that vanishes from both numbers
    // makes the screen quieter and less true.
    renderTier1([prospect({ id: 'p1', suppressed: true })])
    expect(screen.getAllByText('1 prospects').length).toBeGreaterThan(0)
    expect(screen.getAllByText('0 can be emailed').length).toBeGreaterThan(0)
  })
})
