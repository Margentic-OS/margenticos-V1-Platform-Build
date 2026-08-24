// @vitest-environment jsdom
//
// Tests for the sidebar's setup checklist.
//
// The checklist showed "Campaigns live" as pending while the client's sequence was
// actually sending, because it was derived from dashboardState alone and
// 'documents_active' covers both the day the strategy documents are approved and six
// weeks later with mail in the field. Two very different situations, one label.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { Sidebar } from '../Sidebar'
import type { DashboardState } from '../Sidebar'

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}))

function renderSidebar(state: DashboardState, outreachStarted: boolean) {
  return render(
    <Sidebar
      orgName="MargenticOS"
      pipelineUnlocked={false}
      dashboardState={state}
      pendingProspectsCount={0}
      outreachStarted={outreachStarted}
      strategyNav={{ collapsedByDefault: false, reason: 'blocking_upload', needsAttention: [] }}
    />
  )
}

// A step is done when its label is struck through, which is how the component renders it.
function stepIsDone(label: string): boolean {
  const el = screen.getByText(label)
  return el.className.includes('line-through')
}

afterEach(cleanup)

describe('setup checklist', () => {
  it('marks every step done once outreach has started', () => {
    renderSidebar('documents_active', true)

    for (const label of ['Complete intake', 'Documents ready', 'Integrations connected', 'Campaigns live']) {
      expect(stepIsDone(label)).toBe(true)
    }
  })

  it('does NOT mark campaigns live before anything has been sent', () => {
    renderSidebar('documents_active', false)

    expect(stepIsDone('Complete intake')).toBe(true)
    expect(stepIsDone('Documents ready')).toBe(true)
    expect(stepIsDone('Integrations connected')).toBe(false)
    expect(stepIsDone('Campaigns live')).toBe(false)
  })

  it('outreach cannot skip the earlier steps forward from an earlier state', () => {
    // A client mid-intake has sent nothing by definition, but the guard is worth pinning:
    // outreachStarted must not be able to tick "Documents ready" for someone whose
    // documents are not ready.
    renderSidebar('intake_incomplete', true)

    expect(stepIsDone('Documents ready')).toBe(false)
    expect(stepIsDone('Campaigns live')).toBe(false)
  })

  it('keeps the checklist while strategy is still in review', () => {
    renderSidebar('strategy_in_review', false)

    expect(stepIsDone('Complete intake')).toBe(true)
    expect(stepIsDone('Documents ready')).toBe(false)
  })

  it('still renders the Results section it always did', () => {
    renderSidebar('documents_active', true)
    const nav = screen.getByRole('navigation')
    expect(within(nav).getByText('Benchmarks')).toBeInTheDocument()
  })
})
