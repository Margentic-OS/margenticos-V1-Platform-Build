// @vitest-environment jsdom
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE SCREEN MUST NOT HANG
//
// On 2026-09-05 a tov regeneration failed after 100 seconds. Four minutes later the
// dashboard still said "New suggestion is being prepared, check back shortly", and it
// would have said it for ever. Two separate causes, one per control:
//
//   RegenerateButton (operator)   setState('done') fired on the 202. The route returns 202
//                                 on ACCEPTANCE and runs the agent in after(), so that
//                                 status said nothing about the outcome. 'done' was
//                                 terminal: no polling, no timer, no subscription.
//
//   NotYetGeneratedState (client) polled, but asked "is a run in flight" and treated every
//                                 false as success:
//                                   if (!isGenerating) { /* Generation completed */ }
//                                 A failed run also stops being in flight, so it cleared
//                                 the interval and STAYED in 'generating' for ever.
//
// The parent page is a server component with no revalidate that never reads agent_runs, so
// nothing was ever going to correct either one.
//
// These tests force a failure and assert the screen says so.
// ═══════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import { NotYetGeneratedState } from '../NotYetGeneratedState'
import { RegenerateButton } from '../RegenerateButton'

vi.mock('@/lib/document-labels', () => ({
  DOCUMENT_META: {
    tov: { desc: 'How you sound' },
    positioning: { desc: 'Position your company' },
  },
}))

const mockRefresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}))

const NOW = () => new Date().toISOString()

/**
 * A fetch stand-in that answers the two endpoints these components use.
 *
 * It HONOURS the shape of the real responses rather than returning a permissive blob,
 * because a fake that quietly accepts whatever it is asked cannot test the thing it was
 * written for. Anything it is not taught about throws rather than resolving.
 */
function mockFetch(opts: {
  regenerateOk?: boolean
  regenerateBody?: unknown
  status: Record<string, unknown>
}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/api/suggestions/regenerate')) {
      if (init?.method !== 'POST') throw new Error('regenerate must be POSTed')
      return {
        ok: opts.regenerateOk ?? true,
        json: async () => opts.regenerateBody ?? { success: true, started: true },
      }
    }
    if (typeof url === 'string' && url.includes('/api/generation-status')) {
      return { ok: true, json: async () => opts.status }
    }
    throw new Error(`fake fetch does not implement ${String(url)}`)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

describe('the client-facing control shows a failure instead of generating for ever', () => {
  it('shows the failure state when the run it started fails', async () => {
    global.fetch = mockFetch({
      status: { outcome: 'failed', latestRun: { started_at: NOW(), status: 'failed' } },
    }) as never

    render(<NotYetGeneratedState docLabel="Tone of voice" docType="tov" clientId="org-1" />)

    // Mount reads the status first and finds a prior failure, so the failure card is
    // reachable without pressing anything. That is the remount case: a client who reloads
    // after a failed run used to get a spinner.
    await waitFor(() => {
      expect(screen.getByTestId('generation-failed')).toBeInTheDocument()
    })
    expect(screen.getByText(/could not finish your Tone of voice/i)).toBeInTheDocument()
    expect(screen.queryByText(/Generating your/)).not.toBeInTheDocument()
  })

  it('moves from generating to failed while polling, rather than stopping in generating', async () => {
    // The exact 2026-09-05 sequence: in flight, then failed.
    let call = 0
    global.fetch = vi.fn(async (url: string) => {
      if (url.includes('/api/suggestions/regenerate')) {
        return { ok: true, json: async () => ({ success: true }) }
      }
      call++
      // First read: in flight. Every read after: failed.
      const outcome = call <= 1 ? 'generating' : 'failed'
      return {
        ok: true,
        json: async () => ({ outcome, latestRun: { started_at: NOW(), status: outcome } }),
      }
    }) as never

    render(<NotYetGeneratedState docLabel="Tone of voice" docType="tov" clientId="org-1" />)

    await waitFor(() => expect(screen.getByText(/Generating your Tone of voice/)).toBeInTheDocument())

    // Advance past one poll tick.
    await vi.advanceTimersByTimeAsync(6000)

    await waitFor(() => {
      expect(screen.getByTestId('generation-failed')).toBeInTheDocument()
    })
  })

  it('offers a retry rather than leaving the client with nothing to do', async () => {
    global.fetch = mockFetch({
      status: { outcome: 'failed', latestRun: { started_at: NOW(), status: 'failed' } },
    }) as never

    render(<NotYetGeneratedState docLabel="Tone of voice" docType="tov" clientId="org-1" />)

    await waitFor(() => expect(screen.getByTestId('retry-button')).toBeInTheDocument())
  })

  it('never shows the client the raw agent error', async () => {
    // The route withholds error_message from non-operators, and the component must not
    // invent a place to show one. "Claude returned content that is not valid JSON" tells a
    // client nothing they can act on and names our internals.
    global.fetch = mockFetch({
      status: {
        outcome: 'failed',
        latestRun: { started_at: NOW(), status: 'failed' },
      },
    }) as never

    render(<NotYetGeneratedState docLabel="Tone of voice" docType="tov" clientId="org-1" />)

    await waitFor(() => expect(screen.getByTestId('generation-failed')).toBeInTheDocument())
    expect(screen.queryByText(/JSON/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Claude/i)).not.toBeInTheDocument()
  })

  it('refreshes the page on success, because the parent will not re-render itself', async () => {
    global.fetch = mockFetch({
      status: { outcome: 'generating', latestRun: { started_at: NOW(), status: 'running' } },
    }) as never

    render(<NotYetGeneratedState docLabel="Tone of voice" docType="tov" clientId="org-1" />)
    await waitFor(() => expect(screen.getByText(/Generating your/)).toBeInTheDocument())

    global.fetch = mockFetch({
      status: { outcome: 'succeeded', latestRun: { started_at: NOW(), status: 'completed' } },
    }) as never

    await vi.advanceTimersByTimeAsync(6000)
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled())
  })
})

describe('the operator control reports the outcome, not the acceptance', () => {
  async function openAndSubmit() {
    fireEvent.click(screen.getByText('Regenerate'))
    await waitFor(() => expect(screen.getByLabelText('Note for this regeneration')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
  }

  it('does not claim a suggestion is being prepared once the run has failed', async () => {
    global.fetch = mockFetch({
      status: { outcome: 'failed', latestRun: { started_at: NOW(), status: 'failed', error_message: 'TOV agent: Claude returned content that is not valid JSON.' } },
    }) as never

    render(<RegenerateButton clientId="org-1" docType="tov" />)
    await openAndSubmit()

    await vi.advanceTimersByTimeAsync(4000)

    await waitFor(() => {
      expect(screen.getByText(/That regeneration failed/i)).toBeInTheDocument()
    })
    // The sentence that used to be the final state.
    expect(screen.queryByText(/being prepared/i)).not.toBeInTheDocument()
  })

  it('tells the operator the current version is untouched, which is what stops a panic', async () => {
    global.fetch = mockFetch({
      status: { outcome: 'failed', latestRun: { started_at: NOW(), status: 'failed' } },
    }) as never

    render(<RegenerateButton clientId="org-1" docType="tov" />)
    await openAndSubmit()
    await vi.advanceTimersByTimeAsync(4000)

    await waitFor(() => {
      expect(screen.getByText(/current version is unchanged/i)).toBeInTheDocument()
    })
  })

  it('shows the operator the actual agent error, which the client never sees', async () => {
    global.fetch = mockFetch({
      status: {
        outcome: 'failed',
        latestRun: {
          started_at: NOW(),
          status: 'failed',
          error_message: 'TOV agent: Claude returned content that is not valid JSON.',
        },
      },
    }) as never

    render(<RegenerateButton clientId="org-1" docType="tov" />)
    await openAndSubmit()
    await vi.advanceTimersByTimeAsync(4000)

    await waitFor(() => {
      expect(screen.getByText(/not valid JSON/)).toBeInTheDocument()
    })
  })

  it('ignores a previous run and keeps waiting, rather than reporting its outcome as this one', async () => {
    // THE ANCHOR. /api/generation-status answers with the MOST RECENT run, and on this page
    // that is usually a previous, completed one. Without the started_at comparison the
    // button would report the last regeneration's success instantly, and be wrong in the
    // most convincing way available.
    const oldRun = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    global.fetch = mockFetch({
      status: { outcome: 'succeeded', latestRun: { started_at: oldRun, status: 'completed' } },
    }) as never

    render(<RegenerateButton clientId="org-1" docType="tov" />)
    await openAndSubmit()
    await vi.advanceTimersByTimeAsync(10000)

    // Still waiting on OUR run, not celebrating somebody else's.
    expect(screen.getByText(/Generating the new version/i)).toBeInTheDocument()
    expect(screen.queryByText(/New version ready/i)).not.toBeInTheDocument()
  })

  it('reports success only for a run that started after the press', async () => {
    global.fetch = mockFetch({
      status: { outcome: 'succeeded', latestRun: { started_at: NOW(), status: 'completed' } },
    }) as never

    render(<RegenerateButton clientId="org-1" docType="tov" />)
    await openAndSubmit()
    await vi.advanceTimersByTimeAsync(4000)

    await waitFor(() => expect(screen.getByText(/New version ready/i)).toBeInTheDocument())
    expect(mockRefresh).toHaveBeenCalled()
  })

  it('gives up with a stalled message instead of spinning for ever', async () => {
    global.fetch = mockFetch({
      status: { outcome: 'generating', latestRun: { started_at: NOW(), status: 'running' } },
    }) as never

    render(<RegenerateButton clientId="org-1" docType="tov" />)
    await openAndSubmit()

    await waitFor(() => expect(screen.getByText(/Generating the new version/i)).toBeInTheDocument())

    // Past the six-minute ceiling.
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000 + 5000)

    await waitFor(() => {
      expect(screen.getByText(/No result after six minutes/i)).toBeInTheDocument()
    })
  })
})
