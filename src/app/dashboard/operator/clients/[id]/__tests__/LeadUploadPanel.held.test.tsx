// @vitest-environment jsdom
//
// What the upload panel says when EVERY claimed prospect was held.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE JOIN THIS TESTS
//
// The upload action returns a count of prospects it held and the reason for each hold. A
// test on the action proves the count is returned. A test on the success display proves
// the sentence renders when it is given a count. Neither proves the panel hands one to the
// other, and it did not: with nothing uploaded and nothing blocked, the panel replaced the
// whole result with a generic error naming approval gates, shell sync and campaign
// assignments. On the day a hold ships that is every personalised prospect researched
// before it, so the operator's first sight of the rule was an error about three things
// that were fine. Found by review on 2026-10-01.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const handleUploadLeads = vi.fn()
vi.mock('../actions', () => ({
  handleUploadLeads: (...args: unknown[]) => handleUploadLeads(...args),
  handleSyncSequenceShell: vi.fn(),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

import { LeadUploadPanel } from '../LeadUploadPanel'

afterEach(() => {
  cleanup()
  handleUploadLeads.mockReset()
})

/** What the action returns when nothing was uploaded: no outcomes, nothing blocked. */
function nothingSent(extra: Record<string, unknown>) {
  return {
    ok: true,
    outcomes: [],
    hasPartialFailure: false,
    blockedSegments: [],
    shellBlockedCampaigns: [],
    compositionFailureCount: 0,
    heldWithoutFollowupCount: 0,
    heldWithoutApprovedReasonCount: 0,
    ...extra,
  }
}

async function uploadAndSettle(result: unknown) {
  handleUploadLeads.mockResolvedValue(result)
  render(
    <LeadUploadPanel
      orgId="org-under-test"
      instantlyApiActive={true}
      pendingCount={4}
      unresearchedCount={0}
      suppressionBlockedCount={0}
      primarySegmentId={null}
      campaigns={[]}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: /upload/i }))
  await waitFor(() => expect(handleUploadLeads).toHaveBeenCalledTimes(1))
}

const GENERIC = /none were sent\. Check approval gates/i

describe('LeadUploadPanel: a result that explains itself is shown', () => {
  it('every prospect held for an approved reason: the remedy is shown, not the generic error', async () => {
    await uploadAndSettle(nothingSent({ heldWithoutApprovedReasonCount: 4 }))

    expect(await screen.findByText(/4 leads held, not sent/i)).toBeInTheDocument()
    expect(screen.getByText(/Run their research again/i)).toBeInTheDocument()
    expect(screen.getByText('Nothing was sent')).toBeInTheDocument()
    expect(screen.queryByText(GENERIC)).toBeNull()
  })

  it('every prospect held for a missing follow-up: the backfill is named, not the generic error', async () => {
    await uploadAndSettle(nothingSent({ heldWithoutFollowupCount: 1 }))

    expect(await screen.findByText(/1 lead held, not sent/i)).toBeInTheDocument()
    expect(screen.getByText(/Run the follow-up backfill/i)).toBeInTheDocument()
    expect(screen.queryByText(GENERIC)).toBeNull()
  })

  it('every prospect failed composition: the count is shown, not the generic error', async () => {
    await uploadAndSettle(nothingSent({ compositionFailureCount: 2 }))

    expect(await screen.findByText(/2 leads excluded/i)).toBeInTheDocument()
    expect(screen.queryByText(GENERIC)).toBeNull()
  })

  // THE CONTROL. The generic error is still what an unexplained empty result gets: the
  // fix must not have switched it off.
  it('nothing sent and nothing explaining it: the generic error still shows', async () => {
    await uploadAndSettle(nothingSent({}))

    expect(await screen.findByText(GENERIC)).toBeInTheDocument()
    expect(screen.queryByText('Nothing was sent')).toBeNull()
  })
})
