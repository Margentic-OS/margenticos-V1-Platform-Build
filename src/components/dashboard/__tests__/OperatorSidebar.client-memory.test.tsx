// @vitest-environment jsdom
//
// The client picker remembers where the operator was, and falls back to NOTHING.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE DEFECT, 2026-09-09
//
// `selectedId = searchParams.get('client') ?? clients[0]?.id`. `clients[0]` is whichever
// organisation sorts first, so arriving anywhere without ?client= selected an alphabetical
// accident. Every per-client nav link then pointed at that organisation, and the picker
// displayed its name, so the sidebar asserted a selection the operator never made.
//
// THE FALLBACK IS NULL ON PURPOSE, and that is the part worth protecting. The obvious
// "improvement" is to pick the first client when there is no history, because a blank
// picker looks unfinished. It is not unfinished: a wrong guess is indistinguishable from a
// deliberate choice, and the operator acts on it. `'All clients'` is the honest label for
// "no client selected" and the component already rendered it.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const LAST_CLIENT_KEY = 'margenticos.operator.lastClientId'

const CLIENTS = [
  { id: 'aaa-org', name: 'Alpha Consulting', contract_start_date: null, pipeline_unlocked: true },
  { id: 'zzz-org', name: 'Zeta Industrial', contract_start_date: null, pipeline_unlocked: true },
]

let searchParamsValue = new URLSearchParams()

// This project's jsdom setup provides a partial localStorage that lacks clear(). Install a
// real in-memory one so the tests exercise the same API the component calls, rather than
// silently testing a stub with different behaviour.
function installMemoryStorage() {
  let store: Record<string, string> = {}
  const mem: Storage = {
    get length() { return Object.keys(store).length },
    clear: () => { store = {} },
    getItem: (k: string) => (k in store ? store[k] : null),
    key: (i: number) => Object.keys(store)[i] ?? null,
    removeItem: (k: string) => { delete store[k] },
    setItem: (k: string, v: string) => { store[k] = String(v) },
  }
  Object.defineProperty(window, 'localStorage', { value: mem, configurable: true, writable: true })
}

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/operator',
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => searchParamsValue,
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

import { OperatorSidebar } from '../OperatorSidebar'

beforeEach(() => {
  searchParamsValue = new URLSearchParams()
  installMemoryStorage()
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ drafts: [] }) })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('the client picker fallback', () => {
  it('selects NOTHING when there is no ?client= and no history', async () => {
    render(<OperatorSidebar clients={CLIENTS} />)

    // The neutral label, not the alphabetically-first client.
    // Assert on the PICKER, not on page text: a nav entry is also labelled 'All clients'.
    await waitFor(() =>
      expect(screen.getByTestId('client-picker')).toHaveTextContent('All clients'))
    expect(screen.getByTestId('client-picker')).not.toHaveTextContent('Alpha Consulting')
  })

  it('does NOT fall back to the first client, which is the defect this replaced', async () => {
    render(<OperatorSidebar clients={CLIENTS} />)
    // 'Alpha Consulting' sorts first. If it appears as the picker's current value, the
    // alphabetical fallback is back.
    await waitFor(() =>
      expect(screen.getByTestId('client-picker')).toHaveTextContent('All clients'))
  })

  it('remembers the last viewed client across a visit with no ?client=', async () => {
    window.localStorage.setItem(LAST_CLIENT_KEY, 'zzz-org')
    render(<OperatorSidebar clients={CLIENTS} />)

    await waitFor(() =>
      expect(screen.getByTestId('client-picker')).toHaveTextContent('Zeta Industrial'))
  })

  it('IGNORES a remembered client that no longer exists', async () => {
    // An organisation can be archived or deleted between visits. A stale id must not
    // select a client that is not in the list, or every per-client link carries a dead id.
    window.localStorage.setItem(LAST_CLIENT_KEY, 'deleted-org')
    render(<OperatorSidebar clients={CLIENTS} />)

    await waitFor(() =>
      expect(screen.getByTestId('client-picker')).toHaveTextContent('All clients'))
  })

  it('lets ?client= win over the remembered client', async () => {
    window.localStorage.setItem(LAST_CLIENT_KEY, 'zzz-org')
    searchParamsValue = new URLSearchParams('client=aaa-org')
    render(<OperatorSidebar clients={CLIENTS} />)

    await waitFor(() =>
      expect(screen.getByTestId('client-picker')).toHaveTextContent('Alpha Consulting'))
  })

  it('records a client that arrived via the URL, not only picker clicks', async () => {
    searchParamsValue = new URLSearchParams('client=zzz-org')
    render(<OperatorSidebar clients={CLIENTS} />)

    await waitFor(() =>
      expect(window.localStorage.getItem(LAST_CLIENT_KEY)).toBe('zzz-org'))
  })

  it('survives localStorage throwing, because private browsing must not break the sidebar', async () => {
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked')
    })
    render(<OperatorSidebar clients={CLIENTS} />)

    await waitFor(() =>
      expect(screen.getByTestId('client-picker')).toHaveTextContent('All clients'))
    spy.mockRestore()
  })
})

describe('FAQs is reachable from the operator nav', () => {
  it('renders a FAQs entry', async () => {
    render(<OperatorSidebar clients={CLIENTS} />)
    expect(await screen.findByText('FAQs')).toBeInTheDocument()
  })

  it('carries the selected client, because the page shows one organisation', async () => {
    searchParamsValue = new URLSearchParams('client=zzz-org')
    render(<OperatorSidebar clients={CLIENTS} />)

    const link = (await screen.findByText('FAQs')).closest('a')
    expect(link).toHaveAttribute('href', '/dashboard/operator/faqs?client=zzz-org')
  })

  it('links without a client param when nothing is selected', async () => {
    render(<OperatorSidebar clients={CLIENTS} />)
    const link = (await screen.findByText('FAQs')).closest('a')
    expect(link).toHaveAttribute('href', '/dashboard/operator/faqs')
  })
})
