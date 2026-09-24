// @vitest-environment jsdom
//
// The permanent way back into intake.
//
// The only link to /intake lived inside IntakeIncompleteState, the overview card shown while
// critical answers are still missing, so it disappeared the moment the client crossed the
// completeness threshold. The route kept working and the answers stayed editable; there was
// nothing anywhere to click. These tests pin the two properties that fix is made of: the link
// does not read the dashboard state, and it does not send an operator to the wrong org.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { Sidebar } from '../Sidebar'
import type { DashboardState } from '../Sidebar'

const searchParams = { value: new URLSearchParams() }
const pathname = { value: '/dashboard' }

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.value,
  useSearchParams: () => searchParams.value,
}))

const ALL_STATES: DashboardState[] = ['intake_incomplete', 'strategy_in_review', 'documents_active']

function renderSidebar(state: DashboardState, allOrgs?: { id: string; name: string }[]) {
  return render(
    <Sidebar
      orgName="Test Org"
      pipelineUnlocked={false}
      dashboardState={state}
      pendingProspectsCount={0}
      outreachStarted={false}
      strategyNav={{ collapsedByDefault: false, reason: 'blocking_upload', needsAttention: [] }}
      allOrgs={allOrgs}
    />
  )
}

afterEach(() => {
  cleanup()
  searchParams.value = new URLSearchParams()
  pathname.value = '/dashboard'
})

describe('the intake link is permanent', () => {
  // The whole point. If this ever starts reading dashboardState, one of these goes red.
  it.each(ALL_STATES)('renders in the %s state', (state) => {
    renderSidebar(state)
    expect(screen.getByRole('link', { name: 'Your answers' })).toHaveAttribute('href', '/intake')
  })

  it('renders on the overview, which is where the old link used to vanish from', () => {
    pathname.value = '/dashboard'
    renderSidebar('documents_active')
    expect(screen.getByRole('link', { name: 'Your answers' })).toBeInTheDocument()
  })

  it('renders away from the overview too, which the old link never did', () => {
    pathname.value = '/dashboard/strategy/icp'
    renderSidebar('documents_active')
    expect(screen.getByRole('link', { name: 'Your answers' })).toBeInTheDocument()
  })

  // Guard the guard. Every assertion above is a getByRole on one accessible name, so a
  // renamed label would fail them all with "unable to find" and look like a missing link.
  // This proves the sidebar rendered at all, so a red result above means what it says.
  it('the sidebar under test really did render', () => {
    renderSidebar('documents_active')
    expect(screen.getByRole('link', { name: 'Overview' })).toBeInTheDocument()
  })
})

describe('the link never sends an operator to their own answers', () => {
  // /intake resolves the CALLER's organisation and ignores ?client= entirely. Carrying the
  // param would show an operator their OWN intake form, editable, under the client's name.
  it('points an operator viewing a client at that client read-only view', () => {
    searchParams.value = new URLSearchParams('client=org-b')
    renderSidebar('documents_active', [{ id: 'org-b', name: 'Other Org' }])

    expect(screen.getByRole('link', { name: 'Your answers' }))
      .toHaveAttribute('href', '/dashboard/operator/clients/org-b/intake')
  })

  it('never appends ?client= to /intake', () => {
    searchParams.value = new URLSearchParams('client=org-b')
    renderSidebar('documents_active', [{ id: 'org-b', name: 'Other Org' }])

    const href = screen.getByRole('link', { name: 'Your answers' }).getAttribute('href') ?? ''
    expect(href).not.toContain('/intake?client=')
  })

  it('a real client, who has no org list, goes to their own intake form', () => {
    // A client session is handed allOrgs=[] by the layout, so clientId resolves to null even
    // if a client typed ?client= into the address bar themselves.
    searchParams.value = new URLSearchParams('client=org-b')
    renderSidebar('documents_active', [])

    expect(screen.getByRole('link', { name: 'Your answers' })).toHaveAttribute('href', '/intake')
  })
})
