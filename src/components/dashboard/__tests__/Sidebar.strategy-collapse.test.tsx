// @vitest-environment jsdom
//
// Tests for the collapsible Strategy section in the sidebar.
//
// The rule that matters is the negative one: this section must never START collapsed
// while a document is unapproved, because that is the state blocking the lead upload.
// deriveStrategyNavState decides that; these tests check the sidebar honours it, and adds
// the one rule the pure function cannot know about, which is where the client is standing.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { Sidebar } from '../Sidebar'
import type { StrategyNavState } from '@/lib/dashboard/strategy-nav-state'

const pathnameMock = vi.hoisted(() => ({ value: '/dashboard' }))

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock.value,
  useSearchParams: () => new URLSearchParams(),
}))

const ALL_APPROVED: StrategyNavState = {
  collapsedByDefault: true,
  reason: 'all_approved',
  needsAttention: [],
}

const BLOCKING: StrategyNavState = {
  collapsedByDefault: false,
  reason: 'blocking_upload',
  needsAttention: ['Messaging'],
}

const PENDING_VERSION: StrategyNavState = {
  collapsedByDefault: false,
  reason: 'pending_version',
  needsAttention: ['Prospect profile'],
}

function renderSidebar(strategyNav: StrategyNavState, pathname = '/dashboard') {
  pathnameMock.value = pathname
  return render(
    <Sidebar
      orgName="MargenticOS"
      pipelineUnlocked={false}
      dashboardState="documents_active"
      pendingProspectsCount={0}
      outreachStarted
      strategyNav={strategyNav}
    />
  )
}

const DOC_LABELS = ['Prospect profile', 'Positioning', 'Voice guide', 'Messaging']

afterEach(() => {
  cleanup()
  pathnameMock.value = '/dashboard'
})

describe('collapsed once everything is approved', () => {
  it('hides the four document links by default', () => {
    renderSidebar(ALL_APPROVED)

    for (const label of DOC_LABELS) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
    // The heading stays, so the section is discoverable rather than gone.
    expect(screen.getByText('Strategy')).toBeInTheDocument()
  })

  it('opens on click and closes again', () => {
    renderSidebar(ALL_APPROVED)
    const toggle = screen.getByRole('button', { name: /Strategy/ })

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Messaging')).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(screen.queryByText('Messaging')).not.toBeInTheDocument()
  })

  it('shows no attention badge', () => {
    renderSidebar(ALL_APPROVED)
    expect(screen.queryByText('Approval needed')).not.toBeInTheDocument()
    expect(screen.queryByText('New version')).not.toBeInTheDocument()
  })
})

describe('never collapsed while something blocks the lead upload', () => {
  it('starts expanded with every document link visible', () => {
    renderSidebar(BLOCKING)

    for (const label of DOC_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: /Strategy/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('says approval is needed, in words, on the section heading', () => {
    renderSidebar(BLOCKING)
    expect(screen.getByText('Approval needed')).toBeInTheDocument()
  })

  it('marks the specific document that is holding things up', () => {
    const { container } = renderSidebar(BLOCKING)

    const messagingLink = Array.from(container.querySelectorAll('a'))
      .find(a => a.textContent?.includes('Messaging'))
    const positioningLink = Array.from(container.querySelectorAll('a'))
      .find(a => a.textContent?.includes('Positioning'))

    expect(messagingLink?.querySelector('span.bg-brand-amber')).not.toBeNull()
    expect(positioningLink?.querySelector('span.bg-brand-amber')).toBeNull()
  })
})

describe('expanded when a new version is waiting', () => {
  it('starts open and says a new version is there', () => {
    renderSidebar(PENDING_VERSION)

    expect(screen.getByText('New version')).toBeInTheDocument()
    expect(screen.getByText('Prospect profile')).toBeInTheDocument()
  })
})

describe('it cannot hide the page the client is on', () => {
  it('stays expanded on a strategy route even when the default is collapsed', () => {
    renderSidebar(ALL_APPROVED, '/dashboard/strategy/messaging')

    for (const label of DOC_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('disables the toggle there, so it cannot be collapsed out from under them', () => {
    renderSidebar(ALL_APPROVED, '/dashboard/strategy/icp')
    const toggle = screen.getByRole('button', { name: /Strategy/ })

    expect(toggle).toBeDisabled()
    fireEvent.click(toggle)
    expect(screen.getByText('Voice guide')).toBeInTheDocument()
  })

  it('collapses normally on a non-strategy route', () => {
    renderSidebar(ALL_APPROVED, '/dashboard/replies')
    expect(screen.queryByText('Voice guide')).not.toBeInTheDocument()
  })
})
