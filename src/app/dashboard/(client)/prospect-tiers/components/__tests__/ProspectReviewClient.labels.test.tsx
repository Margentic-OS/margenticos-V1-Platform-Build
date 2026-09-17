// @vitest-environment jsdom
//
// WHAT THE CLIENT REVIEW SCREEN SAYS. Items 11 to 15 of the 2026-09-17 walkthrough.
//
// Rendering assertions over fixture data. Whether the underlying counts are right is proved
// elsewhere; what is only provable here is that a number on this screen is accompanied by
// something saying what it counts, and that a control's absence is explained rather than
// silent.
//
// Run:
//   npx dotenv -e .env.test.local -- npx vitest run "src/app/dashboard/(client)/prospect-tiers/components/__tests__/ProspectReviewClient.labels.test.tsx"

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { ProspectReviewClient } from '../ProspectReviewClient'
import { buildRosterGroups, countPending, countRoster } from '@/lib/dashboard/prospect-roster'
import type { RosterProspect } from '@/lib/dashboard/prospect-roster'
import type { AutoApprovalNotice } from '@/lib/dashboard/auto-approval-notice'

// Same mock as the sibling roster suite: this component calls useRouter for the refresh
// after approval, and the App Router is not mounted under jsdom.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

afterEach(cleanup)

function prospect(overrides: Partial<RosterProspect> = {}): RosterProspect {
  return {
    id: Math.random().toString(36).slice(2),
    first_name: 'Sam',
    last_name: 'Taylor',
    company_name: 'Northwind Logistics',
    job_title: 'Operations Director',
    linkedin_url: null,
    website_url: null,
    client_review_status: 'approved',
    outbound_upload_attempted_at: '2026-09-16T09:00:00Z',
    email_send_eligible: true,
    ...overrides,
  }
}

function renderRoster(
  prospects: RosterProspect[],
  autoApproval: AutoApprovalNotice = { kind: 'nothing_pending' },
) {
  const groups = buildRosterGroups(prospects)
  return render(
    <ProspectReviewClient
      groups={groups}
      pendingCount={countPending(groups)}
      rosterCount={countRoster(groups)}
      autoApproval={autoApproval}
      organisationId="org-1"
      viewerIsOperator={false}
    />,
  )
}

describe('item 11 — a prospect who cannot be emailed is explained, not silent', () => {
  // NOT HIDDEN. The roster is a permanent record (Decisions Log 2026-09-07) and filtering
  // on current sendability would erase the evidence that we mailed someone before a rule
  // changed. So the fix is an explanation, not an exclusion.
  it('still lists an approved prospect that cannot currently be emailed', () => {
    renderRoster([
      prospect({ id: 'ok', first_name: 'Ada' }),
      prospect({ id: 'held', first_name: 'Ben', email_send_eligible: false }),
    ])
    expect(screen.getByText('Ada Taylor')).toBeInTheDocument()
    expect(screen.getByText('Ben Taylor')).toBeInTheDocument()
  })

  it('says why there is no Remove control on that row', () => {
    renderRoster([prospect({ email_send_eligible: false })])
    expect(screen.getByText('Not being contacted')).toBeInTheDocument()
  })

  it('leaves a sendable, already-decided prospect without that note', () => {
    // The control. If the note rendered on every row it would say nothing.
    renderRoster([prospect({ email_send_eligible: true })])
    expect(screen.queryByText('Not being contacted')).not.toBeInTheDocument()
  })

  // RULE ZERO. The client is told what it means for them and nothing about our machinery.
  it('names no verification verdict, country, operator action or vendor', () => {
    const { container } = renderRoster([prospect({ email_send_eligible: false })])
    const text = container.textContent ?? ''
    expect(text).toContain('Not being contacted')   // control: the note did render
    for (const leak of ['verif', 'operator', 'hold', 'catch', 'bounce', 'suppress', 'country']) {
      expect(text.toLowerCase()).not.toContain(leak)
    }
  })
})

describe('item 12 — the banner never shows a date that has passed', () => {
  it('renders a future date when one applies', () => {
    renderRoster(
      [prospect({ client_review_status: 'pending_review' })],
      { kind: 'scheduled', onISO: '2099-03-04T00:00:00Z' },
    )
    expect(screen.getByText(/4 Mar 2099/)).toBeInTheDocument()
  })

  it('states the position with no date when nothing will happen automatically', () => {
    renderRoster(
      [prospect({ client_review_status: 'pending_review' })],
      { kind: 'no_automatic_approval' },
    )
    const banner = screen.getByText(/We will not add anyone automatically/)
    // SCOPED TO THE BANNER. The tabs legitimately carry dates (they are batch days), so a
    // page-wide search would be testing the wrong element and would fail for a good reason.
    expect(banner.textContent).not.toMatch(
      /\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}/,
    )
  })
})

describe('item 13 — the job title column is aligned', () => {
  // The cause was the actions column being flex-shrink-0 with a width that varied per row,
  // so the two flexible columns absorbed the difference and the title started in a
  // different place on every line. A fixed grid template is what makes them line up; this
  // asserts the template rather than a rendered pixel, which jsdom cannot measure.
  it('lays each row out on the same fixed column template', () => {
    const { container } = renderRoster([
      prospect({ id: 'a', linkedin_url: 'https://example.com/a', website_url: 'https://a.example' }),
      prospect({ id: 'b' }),
    ])
    const rows = container.querySelectorAll('div[class*="grid-cols-"]')
    expect(rows.length).toBe(2)
    const templates = [...rows].map(r => [...r.classList].find(c => c.startsWith('grid-cols-')))
    // Both rows use the SAME template, which is the whole of the alignment claim.
    expect(new Set(templates).size).toBe(1)
    expect(templates[0]).toContain('11rem')
  })

  it('leaves the titles themselves untouched', () => {
    const raw = '  head of  REVENUE ops '
    const { container } = renderRoster([prospect({ job_title: raw })])
    // READ FROM THE DOM, not through getByText: the default normaliser collapses runs of
    // whitespace, so it could not tell a preserved title from a tidied one. The claim here
    // is that the stored string reaches the page byte for byte.
    const titles = [...container.querySelectorAll('p')].map(p => p.textContent)
    expect(titles).toContain(raw)
  })
})

describe('item 14 — the approve control appears at the top as well as the bottom', () => {
  const pending = [
    prospect({ id: 'p1', client_review_status: 'pending_review' }),
    prospect({ id: 'p2', client_review_status: 'pending_review' }),
  ]

  it('renders two approve controls', () => {
    renderRoster(pending, { kind: 'no_automatic_approval' })
    const buttons = screen.getAllByRole('button', { name: /Approve remaining/ })
    expect(buttons).toHaveLength(2)
  })

  it('gives both the same count, because they are one function', () => {
    renderRoster(pending, { kind: 'no_automatic_approval' })
    const buttons = screen.getAllByRole('button', { name: /Approve remaining/ })
    expect(buttons[0].textContent).toBe(buttons[1].textContent)
    expect(buttons[0].textContent).toContain('2')
  })

  it('renders none at all once nothing is pending', () => {
    renderRoster([prospect({ client_review_status: 'approved' })])
    expect(screen.queryByRole('button', { name: /Approve remaining/ })).not.toBeInTheDocument()
  })
})

describe('item 15 — the counts say what they count', () => {
  const across = [
    prospect({ id: 'a', outbound_upload_attempted_at: '2026-09-16T09:00:00Z' }),
    prospect({ id: 'b', outbound_upload_attempted_at: '2026-09-17T09:00:00Z' }),
    prospect({ id: 'c', outbound_upload_attempted_at: null }),
  ]

  it('explains what the tabs are grouped by', () => {
    renderRoster(across)
    expect(screen.getByText(/Grouped by the day we added them to your campaign/)).toBeInTheDocument()
  })

  it('says a tab count is people, not tasks', () => {
    renderRoster(across)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.length).toBeGreaterThan(1)
    expect(tabs.some(t => /\d+ (person|people)/.test(t.textContent ?? ''))).toBe(true)
  })

  it('marks only the tabs that still need the client', () => {
    renderRoster(
      [
        prospect({ id: 'done', outbound_upload_attempted_at: '2026-09-16T09:00:00Z' }),
        prospect({
          id: 'todo',
          outbound_upload_attempted_at: '2026-09-17T09:00:00Z',
          client_review_status: 'pending_review',
        }),
      ],
      { kind: 'no_automatic_approval' },
    )
    const tabs = screen.getAllByRole('tab')
    const withWork = tabs.filter(t => /to review/.test(t.textContent ?? ''))
    expect(withWork).toHaveLength(1)
    expect(withWork[0].textContent).toContain('17 Sep 2026')
  })

  it('relates the headline number to the groups below it', () => {
    renderRoster(across)
    expect(screen.getByText(/This total covers every group below/)).toBeInTheDocument()
  })

  it('says what separates "Not yet in the campaign" from the dated tabs', () => {
    renderRoster(across)
    const notYet = screen.getByRole('tab', { name: /Not yet in the campaign/ })
    within(notYet).getByText(/1 person/)

    // The subtitle belongs to the SELECTED group, so the tab has to be opened. Asserting it
    // without clicking would have been testing whichever group happened to open first.
    fireEvent.click(notYet)
    expect(
      screen.getByText(/Not added to your campaign yet, so they have no date/),
    ).toBeInTheDocument()
  })
})
