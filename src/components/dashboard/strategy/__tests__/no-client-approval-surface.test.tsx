// @vitest-environment jsdom
//
// PROOF 4: no client-facing surface asks for approval anywhere.
//
// This RENDERS the components a client actually sees on a strategy document and asserts
// the approval vocabulary is absent from the output. It is not a grep over source: the
// question is what reaches the screen, and a component can render a word that appears
// nowhere in its own file.
//
// The live half of this proof is the deployed preview returning 404 for
// /api/documents/approve and /api/operator/documents/force-approve. Between them, the
// surface and the routes behind it are both gone.
//
// WHY ASSERT ON ABSENCE. The failure mode for removing a mechanism is copy that outlives
// it: a button that still says Approve and now posts to a route that is not there, or a
// sentence about a review window nobody is counting. Absence is the property that breaks
// when somebody puts it back.
//
// RULE ZERO: every string in this file is an abstract token or fixed product copy.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { DocumentRevisionControls } from '../DocumentRevisionControls'
import { DocumentVersionHistory } from '../DocumentVersionHistory'
import { describeVersionHistory } from '@/lib/dashboard/version-history'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

// Renders accumulate in one document otherwise, and 'found multiple elements' is a
// failure about the test rather than about the component.
afterEach(cleanup)

// Every word the removed mechanism used. Checked case-insensitively against the rendered
// text of each client-facing surface.
const APPROVAL_VOCABULARY = [
  'approve',
  'approved',
  'approval',
  'pending approval',
  'auto-approve',
  'three days',
  'review window',
  'proceed without',
]

function assertNoApprovalVocabulary(text: string, where: string) {
  const lower = text.toLowerCase()
  for (const word of APPROVAL_VOCABULARY) {
    expect(lower, `${where} renders the word "${word}"`).not.toContain(word)
  }
}

const VERSIONS = describeVersionHistory([
  {
    id: 'v3', version: '3', status: 'active', created_at: '2026-09-03T10:00:00.000Z',
    update_trigger: 'signal_suggestion', revision_note: 'A note about the third version.',
    change_summary: null,
  },
  {
    id: 'v2', version: '2', status: 'archived', created_at: '2026-09-02T10:00:00.000Z',
    update_trigger: 'signal_suggestion', revision_note: 'A note about the second version.',
    change_summary: null,
  },
  {
    id: 'v1', version: '1', status: 'archived', created_at: '2026-09-01T10:00:00.000Z',
    update_trigger: 'signal_suggestion', revision_note: null, change_summary: null,
  },
])

describe('the controls a client sees on a live document', () => {
  it('offers no approval of any kind', () => {
    const { container } = render(
      <DocumentRevisionControls
        docId="doc-1"
        changeSummary="A summary of what changed."
        revisionNote="A note somebody typed."
        hasPendingRevision={false}
      />,
    )
    assertNoApprovalVocabulary(container.textContent ?? '', 'DocumentRevisionControls')
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument()
  })

  it('offers no approval while a revision is staged either', () => {
    const { container } = render(
      <DocumentRevisionControls docId="doc-1" changeSummary={null} revisionNote={null} hasPendingRevision />,
    )
    assertNoApprovalVocabulary(container.textContent ?? '', 'DocumentRevisionControls (staged)')
  })

  it('still lets the client ask for a change, which was never approval', () => {
    // The negative assertions above would all pass on an empty component. This is what
    // stops this file proving that the page is blank.
    render(
      <DocumentRevisionControls docId="doc-1" changeSummary={null} revisionNote={null} hasPendingRevision={false} />,
    )
    expect(screen.getByRole('button', { name: /request an update/i })).toBeInTheDocument()
  })
})

describe('the version history a client sees', () => {
  it('offers no approval and no restore', () => {
    // canRestore false is the client. Restore is the operator's tool: it rewrites the
    // copy every future email is composed from.
    const { container } = render(
      <DocumentVersionHistory versions={VERSIONS} canRestore={false} isMessaging={false} />,
    )
    assertNoApprovalVocabulary(container.textContent ?? '', 'DocumentVersionHistory')
    expect(screen.queryByRole('button', { name: /restore/i })).not.toBeInTheDocument()
  })

  it('tells the client the document changed and when, which is what replaced approval', () => {
    render(<DocumentVersionHistory versions={VERSIONS} canRestore={false} isMessaging={false} />)
    expect(screen.getByText(/Version 3, updated/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /view previous/i })).toBeInTheDocument()
  })
})

describe('the client-facing email about a new version', () => {
  it('makes no promise about an approval window', async () => {
    const { versionUpdatedTemplate, versionUpdatedText } =
      await import('@/lib/email/templates/version-updated')
    const params = {
      docType: 'icp',
      recipientFirstName: 'A',
      senderFirstName: 'B',
      senderCompanyName: 'C',
    }
    assertNoApprovalVocabulary(versionUpdatedTemplate(params), 'version-updated html')
    assertNoApprovalVocabulary(versionUpdatedText(params), 'version-updated text')
  })
})
