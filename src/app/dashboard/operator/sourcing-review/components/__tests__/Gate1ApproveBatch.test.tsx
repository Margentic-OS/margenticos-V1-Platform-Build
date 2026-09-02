// @vitest-environment jsdom
//
// THE FIFTY-ROW LIST, PROVEN BY COUNTING.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS PROVES, AND WHY IT COUNTS ROWS INSTEAD OF READING THE HANDLER
//
// The screen rendered `prospects.slice(0, 50)` and told the operator "Showing 50 of 100
// prospects. Scroll to see more" with nowhere to scroll. The question that mattered was
// not what the footer said: it was whether "Approve all" acted on the 100 or on the 50
// that had loaded, and that cannot be settled by reading the click handler, because the
// handler reads an array whose length is set somewhere else entirely.
//
// So every assertion below is a COUNT taken from the rendered document or from the
// intercepted request body:
//
//   rows on screen        document.querySelectorAll('tbody tr').length
//   rows acted on         the length of prospect_ids in the POST body
//
// THE OLD BEHAVIOUR, MEASURED rather than recalled. The previous component was checked out
// from origin/main, rendered with 100 prospects, and counted:
//
//     rows on screen                     50
//     footer                             "Showing 50 of 100 prospects. Scroll to see more."
//     rows ticked by the header checkbox 50   (of 100 selected; the other 50 had no row)
//     ids sent by "Approve all"          100
//
// So the answer to "does it act on 100 or on the 50 that loaded" is 100. Nothing was
// missed, and that is the less comfortable half: the button approved 50 prospects that
// were never rendered, and the footer told the operator the other 50 were reachable by
// scrolling to rows that did not exist in the document.
//
// The fix is not a bigger slice. It is that the server sends one page, the checkbox is
// scoped to that page and says so, and the wide action carries no ids at all: it sends a
// predicate the server evaluates, so its scope cannot be decided by what a tab fetched.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import type { Database } from '@/types/database'
import { Gate1ApproveBatch } from '../Gate1ApproveBatch'

type Prospect = Database['public']['Tables']['prospects']['Row']

const PAGE_SIZE = 50
const TOTAL_PENDING = 100

/** A prospect with only the fields this screen reads. Everything else is irrelevant here. */
function prospect(index: number): Prospect {
  return {
    id: `prospect-${index}`,
    first_name: `First${index}`,
    last_name: `Last${index}`,
    email: `person${index}@example.invalid`,
    company_name: `Company ${index}`,
    job_title: 'Role',
    linkedin_url: null,
    email_status: index % 2 === 0 ? 'verified' : null,
  } as unknown as Prospect
}

/** One page of the batch, as the server now sends it. */
const PAGE_ONE = Array.from({ length: PAGE_SIZE }, (_, i) => prospect(i))

interface Captured { url: string; body: Record<string, unknown> }

function stubApprovalEndpoint(): { calls: Captured[] } {
  const calls: Captured[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      body: JSON.parse(String(init?.body ?? '{}')),
    })
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { approved_count: 0, timestamp: 'now' } }),
    } as unknown as Response
  })
  return { calls }
}

function renderPage(overrides: Partial<Parameters<typeof Gate1ApproveBatch>[0]> = {}) {
  return render(
    <Gate1ApproveBatch
      prospects={PAGE_ONE}
      totalPending={TOTAL_PENDING}
      page={1}
      pageSize={PAGE_SIZE}
      organisationId="org-1"
      organisationName="A Client"
      icpSummary={{}}
      {...overrides}
    />,
  )
}

/** The number of prospect rows actually in the document. */
function renderedRowCount(): number {
  return document.querySelectorAll('tbody tr').length
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the approval list shows a page and says so', () => {
  it('renders exactly the rows it was given, and no slice discards any of them', () => {
    renderPage()
    expect(renderedRowCount()).toBe(PAGE_SIZE)
  })

  it('states the real position in the batch instead of promising a scroll', () => {
    renderPage()
    expect(screen.getByText(/Showing 1 to 50 of 100, page 1 of 2/)).toBeInTheDocument()
    // The sentence that was there before, and the reason this test exists.
    expect(screen.queryByText(/Scroll to see more/)).not.toBeInTheDocument()
  })

  it('offers a way to reach the rows it is not showing', () => {
    renderPage()
    const next = screen.getByRole('link', { name: 'Next' })
    expect(next).toHaveAttribute('href', expect.stringContaining('page=2'))
    expect(screen.queryByRole('link', { name: 'Previous' })).not.toBeInTheDocument()
  })

  it('reports the batch total, not the page length, as the number pending', () => {
    renderPage()
    expect(screen.getByText('100 prospects pending approval')).toBeInTheDocument()
  })

  it('shows the empty state only when the BATCH is empty, not when a page is', () => {
    // A page past the end has no rows and is not an empty batch. Keying the empty state on
    // the page length would tell an operator with 100 pending prospects that there are none.
    renderPage({ prospects: [], totalPending: TOTAL_PENDING, page: 3 })
    expect(screen.queryByText(/No prospects awaiting approval/)).not.toBeInTheDocument()

    cleanup()
    renderPage({ prospects: [], totalPending: 0 })
    expect(screen.getByText(/No prospects awaiting approval/)).toBeInTheDocument()
  })
})

describe('what each action actually acts on, counted', () => {
  it('THE HEADER CHECKBOX SELECTS THIS PAGE, and the count proves it', async () => {
    const { calls } = stubApprovalEndpoint()
    renderPage()

    fireEvent.click(screen.getByLabelText(`Select all ${PAGE_SIZE} on this page`))

    // The label the button now carries IS the count, so a wrong scope is visible before
    // the click rather than only in the request.
    const approveSelected = screen.getByRole('button', { name: `Approve ${PAGE_SIZE} selected` })
    fireEvent.click(approveSelected)

    await waitFor(() => expect(calls).toHaveLength(1))
    const ids = calls[0].body.prospect_ids as string[]

    // ROWS ON SCREEN === ROWS ACTED ON. This is the assertion that used to fail: 50 and 100.
    expect(renderedRowCount()).toBe(PAGE_SIZE)
    expect(ids).toHaveLength(PAGE_SIZE)
    expect(new Set(ids)).toEqual(new Set(PAGE_ONE.map(p => p.id)))
  })

  it('a partial selection sends exactly the rows ticked', async () => {
    const { calls } = stubApprovalEndpoint()
    renderPage()

    const boxes = document.querySelectorAll('tbody input[type="checkbox"]')
    fireEvent.click(boxes[0])
    fireEvent.click(boxes[3])

    fireEvent.click(screen.getByRole('button', { name: 'Approve 2 selected' }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].body.prospect_ids).toEqual(
      expect.arrayContaining(['prospect-0', 'prospect-3']),
    )
    expect(calls[0].body.prospect_ids as string[]).toHaveLength(2)
  })

  it('refuses to approve nothing, instead of silently meaning "everything"', async () => {
    // The old handler read "the selection, or everything if the selection is empty". So a
    // button labelled "Approve all" did two different things depending on state the
    // operator was not necessarily looking at.
    const { calls } = stubApprovalEndpoint()
    renderPage()

    const approveSelected = screen.getByRole('button', { name: 'Approve 0 selected' })
    expect(approveSelected).toBeDisabled()
    fireEvent.click(approveSelected)

    await new Promise(r => setTimeout(r, 50))
    expect(calls).toHaveLength(0)
  })

  it('APPROVE ALL ASKS FIRST, and names the rows the operator cannot see', () => {
    stubApprovalEndpoint()
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: `Approve all ${TOTAL_PENDING} pending` }))

    expect(screen.getByText(/Approve all 100 pending prospects\?/)).toBeInTheDocument()
    expect(screen.getByText(/includes 50 not shown on this page/)).toBeInTheDocument()
  })

  it('APPROVE ALL SENDS NO IDS, so its scope is not set by what this tab loaded', async () => {
    const { calls } = stubApprovalEndpoint()
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: `Approve all ${TOTAL_PENDING} pending` }))
    fireEvent.click(screen.getByRole('button', { name: `Yes, approve ${TOTAL_PENDING}` }))

    await waitFor(() => expect(calls).toHaveLength(1))

    // The whole point. An id list here would mean 50, because 50 is what the browser holds.
    expect(calls[0].body).toEqual({ approve_all_pending: true })
    expect(calls[0].body.prospect_ids).toBeUndefined()
  })

  it('the confirmation can be backed out of without approving anything', async () => {
    const { calls } = stubApprovalEndpoint()
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: `Approve all ${TOTAL_PENDING} pending` }))
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))

    await new Promise(r => setTimeout(r, 50))
    expect(calls).toHaveLength(0)
    expect(screen.getByRole('button', { name: `Approve all ${TOTAL_PENDING} pending` })).toBeInTheDocument()
  })
})
