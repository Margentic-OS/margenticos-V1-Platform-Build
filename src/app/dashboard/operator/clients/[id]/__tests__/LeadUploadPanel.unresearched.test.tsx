// @vitest-environment jsdom
//
// What the upload panel says about prospects that have never been researched.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE INCIDENT THIS RENDERS AGAINST
//
// An operator uploaded a batch in which most prospects had never been researched. All of
// them shipped the authored opener, which was a legitimate thing to send, and the screen
// said nothing about it. The number on the button was correct and carried no consequence.
//
// The fix is a sentence, not a block. So the two things worth locking down are that the
// sentence appears when it is true, and that the button STAYS PRESSABLE when it does. A
// warning that disables the control it warns about is a gate wearing a warning's clothes,
// and an unresearched send is sometimes the correct send.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// The panel imports exactly two runtime values from './actions', both server actions that
// pull server-only dependencies into jsdom if imported for real. Nothing here invokes
// either: every assertion below is about what is rendered before anything is pressed.
vi.mock('../actions', () => ({
  handleUploadLeads: vi.fn(),
  handleSyncSequenceShell: vi.fn(),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

import { LeadUploadPanel } from '../LeadUploadPanel'

afterEach(cleanup)

function renderPanel(
  pendingCount: number,
  unresearchedCount: number,
  suppressionBlockedCount = 0,
) {
  return render(
    <LeadUploadPanel
      orgId="org-under-test"
      instantlyApiActive={true}
      pendingCount={pendingCount}
      unresearchedCount={unresearchedCount}
      suppressionBlockedCount={suppressionBlockedCount}
      primarySegmentId={null}
      campaigns={[]}
    />,
  )
}

describe('LeadUploadPanel — unresearched notice', () => {
  it('renders NOTHING at zero: no empty state, no zero badge, no mention of research', () => {
    renderPanel(21, 0)

    // The whole vocabulary of the feature is absent, not merely showing a 0.
    expect(screen.queryByText(/never been researched/i)).toBeNull()
    expect(screen.queryByText(/standard opening line/i)).toBeNull()
    expect(screen.queryByText(/standard opener/i)).toBeNull()
    expect(screen.queryByText(/researched/i)).toBeNull()

    // And the button says only what it always said.
    expect(screen.getByRole('button', { name: 'Upload 21 pending leads' })).toBeInTheDocument()
  })

  it('states the count, the population and the consequence when some are unresearched', () => {
    renderPanel(21, 18)
    expect(
      screen.getByText(/18 of these 21 have never been researched\./i),
    ).toBeInTheDocument()
    expect(screen.getByText(/will send your standard opening line/i)).toBeInTheDocument()
  })

  it('carries the same fact into the button label', () => {
    renderPanel(21, 18)
    expect(
      screen.getByRole('button', { name: 'Upload 21 pending leads (18 with your standard opener)' }),
    ).toBeInTheDocument()
  })

  it('leaves the upload button PRESSABLE when every prospect is unresearched', () => {
    renderPanel(18, 18)
    const button = screen.getByRole('button', { name: /^Upload 18 pending leads/ })
    expect(button).not.toBeDisabled()
  })

  it('tells the operator they may still upload, rather than telling them to stop', () => {
    renderPanel(21, 18)
    expect(screen.getByText(/You can still upload them/i)).toBeInTheDocument()
  })

  it('reads as English for a single prospect', () => {
    renderPanel(3, 1)
    expect(screen.getByText(/1 of these 3 has never been researched\./i)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Upload 3 pending leads (1 with your standard opener)' }),
    ).toBeInTheDocument()
  })
})
