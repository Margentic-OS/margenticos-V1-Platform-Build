// @vitest-environment jsdom
//
// The triage queue is reachable from the navigation.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS LOCKS OUT, measured 2026-09-04
//
// /dashboard/operator/triage had ZERO inbound links anywhere in the codebase. It is the
// only screen in the product with an approve button: TriageQueue.tsx is the sole caller of
// POST /api/reply-drafts/{id}/approve and /reject.
//
// The sidebar's "Replies" entry points somewhere else — a per-client, read-only page whose
// only button toggles a context panel. So an operator following the navigation saw replies
// and could not act on any of them. Reaching the queue meant typing the URL.
//
// A draft sat at manual_required for two days while that was true. It was created
// correctly, listed correctly by GET /api/reply-drafts, and rendered by a page nothing
// linked to. MON-028 now reports the wait; this makes the queue reachable so the report
// can be acted on. The monitor's own remedy text says "open the triage queue".
//
// THE TWO ENTRIES ARE SEPARATE ON PURPOSE and this file asserts both still exist, because
// the obvious "tidy-up" is to merge them and that would silently remove one of two
// different screens.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { OperatorSidebar } from '../OperatorSidebar'

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/operator',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

const CLIENTS = [
  { id: 'org-1', name: 'Test Organisation', slug: 'test-org', pipeline_unlocked: true },
  { id: 'org-2', name: 'Second Test Organisation', slug: 'second-test-org', pipeline_unlocked: false },
]

function stubFetch(replyDraftCount: number) {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const target = String(url)
    if (target.includes('/api/reply-drafts')) {
      return new Response(
        JSON.stringify({ drafts: Array.from({ length: replyDraftCount }, (_, i) => ({ id: `d${i}` })) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (target.includes('monitor-badge-count')) {
      return new Response(JSON.stringify({ count: 0 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch ${target}`)
  }))
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function renderSidebar() {
  return render(<OperatorSidebar clients={CLIENTS as any} />)
}
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  vi.clearAllMocks()
  stubFetch(0)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the operator can reach the only screen that can action a reply', () => {
  it('renders a link whose href is the triage queue', () => {
    renderSidebar()

    // By HREF, not by label. A label assertion passes if someone renames the entry while
    // pointing it at the wrong route, which is the failure that matters here.
    const links = Array.from(document.querySelectorAll('a'))
    const hrefs = links.map(a => a.getAttribute('href'))

    expect(hrefs).toContain('/dashboard/operator/triage')
  })

  it('keeps the per-client Replies entry as a SEPARATE link', () => {
    renderSidebar()

    const hrefs = Array.from(document.querySelectorAll('a')).map(a => a.getAttribute('href'))

    // Two different screens. Replies is per-client and read-only; the triage queue is
    // cross-client and holds the approve button. Collapsing them loses one.
    expect(hrefs).toContain('/dashboard/operator/clients/org-1/replies')
    expect(hrefs).toContain('/dashboard/operator/triage')
    expect(hrefs.filter(h => h === '/dashboard/operator/triage')).toHaveLength(1)
  })

  it('does not require a selected client, because the queue is cross-organisation', () => {
    // GET /api/reply-drafts applies no organisation_id filter (ADR-021). If this entry were
    // built into the per-client list it would vanish when no client was selected, which is
    // the same unreachability with extra steps.
    renderSidebar()

    const triage = Array.from(document.querySelectorAll('a'))
      .find(a => a.getAttribute('href') === '/dashboard/operator/triage')

    expect(triage).toBeDefined()
    expect(triage!.getAttribute('href')).not.toContain('org-1')
  })
})

describe('the reply queue badge', () => {
  it('shows the number of waiting drafts', async () => {
    stubFetch(3)
    renderSidebar()

    await waitFor(() => {
      const triage = Array.from(document.querySelectorAll('a'))
        .find(a => a.getAttribute('href') === '/dashboard/operator/triage')
      expect(triage!.textContent).toContain('3')
    })
  })

  it('shows no badge when nothing is waiting, rather than a zero', async () => {
    stubFetch(0)
    renderSidebar()

    const triage = Array.from(document.querySelectorAll('a'))
      .find(a => a.getAttribute('href') === '/dashboard/operator/triage')

    // A permanent "0" is noise, and noise is what an operator learns to stop reading.
    expect(triage!.textContent).not.toContain('0')
  })

  it('still renders the entry when the count cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    renderSidebar()

    // The badge is an aid. If its failure could hide the link, a network blip would
    // recreate the exact unreachability this entry exists to fix.
    const hrefs = Array.from(document.querySelectorAll('a')).map(a => a.getAttribute('href'))
    expect(hrefs).toContain('/dashboard/operator/triage')
  })
})
