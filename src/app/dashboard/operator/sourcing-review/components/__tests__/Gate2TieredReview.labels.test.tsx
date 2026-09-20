// @vitest-environment jsdom
//
// THE QUALITY SCREEN. Item 10 (the opening line an operator could not read), item 8 on this
// screen's own publish control, and item 16's warning panel.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run src/app/dashboard/operator/sourcing-review/components/__tests__/Gate2TieredReview.labels.test.tsx

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { Gate2TieredReview } from '../Gate2TieredReview'
import type { Database } from '@/types/database'

type Prospect = Database['public']['Tables']['prospects']['Row']

afterEach(cleanup)

function prospect(overrides: Partial<Prospect> = {}): Prospect {
  return {
    id: Math.random().toString(36).slice(2),
    first_name: 'Sam',
    last_name: 'Taylor',
    email: 'sam@northwind.example',
    company_name: 'Northwind Logistics',
    job_title: 'Operations Director',
    company_headcount: 24,
    company_industry: 'Freight Transportation',
    linkedin_url: null,
    website_url: null,
    sourced_tier: 'tier_1',
    tiering_reason: 'tier_1 (score 100): industry 45, seniority 35, headcount 20',
    suppressed: false,
    email_send_eligible: true,
    email_send_ineligible_reason: null,
    independent_verified_at: '2026-09-01T00:00:00Z',
    independent_email_status: 'Valid',
    verification_provider: 'x',
    second_pass_status: null,
    second_pass_provider: null,
    personalisation_trigger: null,
    ...overrides,
  } as unknown as Prospect
}

const NO_REPORT = { variantsChecked: 3, findings: [] }

function renderReview(
  prospects: Prospect[],
  over: Partial<{
    unpublishedCount: number
    openingReport: {
      variantsChecked: number
      findings: Array<{
        variantId: string
        opening: string
        faults: Array<{ kind: string; phrase: string; detail: string }>
      }>
    }
  }> = {},
) {
  return render(
    <Gate2TieredReview
      prospects={prospects}
      organisationId="org-1"
      organisationName="Test Client"
      tiering={{ tier_1: prospects, tier_2: [], tier_3: [] }}
      removedByReason={{}}
      removedCount={0}
      unpublishedCount={over.unpublishedCount ?? prospects.length}
      openingReport={over.openingReport ?? NO_REPORT}
    />,
  )
}

describe('item 10 — the operator can read the opening line before publishing', () => {
  it('adds a column for it', () => {
    renderReview([prospect()])
    expect(screen.getByRole('columnheader', { name: 'Opening line' })).toBeInTheDocument()
  })

  it('shows the stored personalisation text where there is one', () => {
    const line = 'Your last three hires were all in delivery, none in sales.'
    renderReview([prospect({ personalisation_trigger: line })])
    expect(screen.getByText(line)).toBeInTheDocument()
  })

  // "None" would read as a fault. It is a deliberate design: four authored openings rather
  // than one shared line.
  it('states plainly that an unresearched prospect gets the standard opener', () => {
    renderReview([prospect({ personalisation_trigger: null })])
    expect(screen.getByText(/gets the standard opener for its variant/)).toBeInTheDocument()
  })

  it('tells the two apart in one list', () => {
    renderReview([
      prospect({ id: 'a', personalisation_trigger: 'Written for this prospect.' }),
      prospect({ id: 'b', personalisation_trigger: null }),
    ])
    expect(screen.getByText('Written for this prospect.')).toBeInTheDocument()
    expect(screen.getByText(/gets the standard opener/)).toBeInTheDocument()
  })
})

describe('item 8 — this screen’s publish control also counts the unpublished', () => {
  it('names both numbers in the heading', () => {
    renderReview([prospect(), prospect(), prospect()], { unpublishedCount: 1 })
    expect(screen.getByText(/1 of 3 not yet sent to the client/)).toBeInTheDocument()
  })

  it('carries the actionable number on the button', () => {
    renderReview([prospect(), prospect(), prospect()], { unpublishedCount: 1 })
    expect(screen.getByRole('button', { name: 'Publish 1 for client review' })).toBeInTheDocument()
  })

  it('disables the button and says so when nothing is new', () => {
    renderReview([prospect(), prospect()], { unpublishedCount: 0 })
    const button = screen.getByRole('button', { name: /already published/i })
    expect(button).toBeDisabled()
  })
})

describe('item 16 — a fallback opening that needs the paragraph above it is surfaced', () => {
  const REPORT = {
    variantsChecked: 4,
    findings: [
      {
        variantId: 'variant-b',
        opening: 'Where this tends to show up is in the third month of a quarter.',
        faults: [
          {
            kind: 'points_backwards',
            phrase: 'this',
            detail: '"this" stands in for something that was never named, because this is the first line.',
          },
        ],
      },
    ],
  }

  it('warns, naming how many variants of how many', () => {
    renderReview([prospect()], { openingReport: REPORT })
    expect(screen.getByText(/1 of 4 message variants open on a line that needs the paragraph above it/))
      .toBeInTheDocument()
  })

  it('quotes the opening and explains the fault', () => {
    renderReview([prospect()], { openingReport: REPORT })
    expect(screen.getByText(/Where this tends to show up/)).toBeInTheDocument()
    expect(screen.getByText(/stands in for something that was never named/)).toBeInTheDocument()
  })

  it('says it blocks nothing', () => {
    renderReview([prospect()], { openingReport: REPORT })
    expect(screen.getByText(/Nothing is blocked/)).toBeInTheDocument()
    // And it really does not: the publish control is still live beside it.
    expect(screen.getByRole('button', { name: /Publish 1 for client review/ })).toBeEnabled()
  })

  // THE CONTROL. No panel when every variant stands on its own, or when none was read.
  it('shows no panel when nothing was found', () => {
    renderReview([prospect()], { openingReport: NO_REPORT })
    expect(screen.queryByText(/open on a line that needs/)).not.toBeInTheDocument()
  })

  it('shows no panel when no document could be read', () => {
    renderReview([prospect()], { openingReport: { variantsChecked: 0, findings: [] } })
    expect(screen.queryByText(/open on a line that needs/)).not.toBeInTheDocument()
  })
})
