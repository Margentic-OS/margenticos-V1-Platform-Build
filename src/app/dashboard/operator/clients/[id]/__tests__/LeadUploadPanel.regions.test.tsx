// @vitest-environment jsdom
//
// The upload panel names, for each campaign, which prospects it takes and when it sends.
// With regional campaigns the operator needs both before pressing Upload: a UK/IE campaign
// whose window was never set, or whose read failed, must be visible on its own row.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('../actions', () => ({ handleUploadLeads: vi.fn(), handleSyncSequenceShell: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { LeadUploadPanel } from '../LeadUploadPanel'

afterEach(cleanup)

const base = { shellSyncedAt: '2026-10-05T19:30:00Z', shellStepCount: 4 }

describe('LeadUploadPanel: regional campaigns', () => {
  it('PLANTED: each campaign row shows its own region and schedule, including a failed read', () => {
    render(
      <LeadUploadPanel
        orgId="org-under-test"
        instantlyApiActive={true}
        pendingCount={4}
        unresearchedCount={0}
        suppressionBlockedCount={0}
        primarySegmentId={null}
        campaigns={[
          { ...base, internalId: 'c-us', externalId: 'ext-us-0000', name: 'US', region: 'US and everywhere else: every country no other campaign names, and prospects with no known country', schedule: 'Mon to Fri 08:00 to 18:00 America/Detroit · 75 a day · 6 mailboxes' },
          { ...base, internalId: 'c-uk', externalId: 'ext-uk-0000', name: 'UK/IE', region: 'UK/IE: GB, IE', schedule: 'Send window could not be read: campaign read returned HTTP 503' },
        ]}
      />,
    )
    expect(screen.getByText('UK/IE: GB, IE')).toBeInTheDocument()
    expect(screen.getByText(/^US and everywhere else: /)).toBeInTheDocument()
    expect(screen.getByText('Mon to Fri 08:00 to 18:00 America/Detroit · 75 a day · 6 mailboxes')).toBeInTheDocument()
    expect(screen.getByText(/^Send window could not be read: .*503/)).toBeInTheDocument()
  })
})
