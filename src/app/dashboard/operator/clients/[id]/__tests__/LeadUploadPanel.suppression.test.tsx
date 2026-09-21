// @vitest-environment jsdom
//
// THE COUNT THE SQL PREDICATE CANNOT SEE.
//
// applySendGate requires suppressed = false, but a bounce never writes that column: it
// writes the global suppressed_emails table instead. So the ready-to-send count promised
// prospects the send then dropped, and nothing on the screen explained the difference.
//
// These cover the DISPLAY only, which is all that changed. The upload still claims the
// whole pending population; see the note on the prop in LeadUploadPanel.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

vi.mock('../actions', () => ({
  handleUploadLeads: vi.fn(),
  handleSyncSequenceShell: vi.fn(),
}))

import { LeadUploadPanel } from '../LeadUploadPanel'

afterEach(cleanup)

function renderPanel(pendingCount: number, suppressionBlockedCount: number) {
  return render(
    <LeadUploadPanel
      orgId="org-under-test"
      instantlyApiActive={true}
      pendingCount={pendingCount}
      unresearchedCount={0}
      suppressionBlockedCount={suppressionBlockedCount}
      primarySegmentId={null}
      campaigns={[]}
    />,
  )
}

describe('LeadUploadPanel, the suppression-blocked count', () => {
  // CONTROL. Every assertion below is about one line appearing or not appearing, and a
  // panel that rendered nothing at all would satisfy the absence cases for the wrong
  // reason. This proves the panel renders before the absences are believed.
  it('renders the pending count at all', () => {
    renderPanel(21, 0)
    expect(screen.getByText('Pending leads ready to upload:')).toBeDefined()
    expect(screen.getByText('21')).toBeDefined()
  })

  it('names how many the suppression list will block, and what will actually send', () => {
    renderPanel(35, 7)
    expect(screen.getByText(/blocked by the suppression list/i)).toBeDefined()
    expect(screen.getByText('7')).toBeDefined()
    // The number that matters: what the operator will actually get out of pressing send.
    expect(screen.getByText(/28 will actually send/i)).toBeDefined()
  })

  it('says nothing at zero', () => {
    renderPanel(21, 0)
    // Silent rather than reassuring. A badge that is always present cannot be told apart
    // from one that is broken, which is the MON-019 lesson in CLAUDE.md.
    expect(screen.queryByText(/blocked by the suppression list/i)).toBeNull()
    expect(screen.queryByText(/will actually send/i)).toBeNull()
  })

  it('does not disable the upload button because of blocked prospects', () => {
    // The gate drops these at SEND. Shrinking or disabling the claim here would make the
    // button attempt a different population than the one it names.
    renderPanel(35, 35)
    const button = screen.getByRole('button', { name: /Upload 35 pending leads/i })
    expect(button.hasAttribute('disabled')).toBe(false)
  })
})
