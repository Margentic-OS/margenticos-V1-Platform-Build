// @vitest-environment jsdom
//
// Tests that NotYetGeneratedState renders a generate button for from-nothing recovery path
// This is the critical test that was missing: verify the UI control exists and calls the API.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { NotYetGeneratedState } from '../NotYetGeneratedState'

vi.mock('@/lib/document-labels', () => ({
  DOCUMENT_META: {
    positioning: { desc: 'Position your company in the market' },
    icp: { desc: 'Define your ideal customer' },
    tov: { desc: 'Create your theory of value' },
    messaging: { desc: 'Build your core messaging' },
  },
}))

describe('NotYetGeneratedState — Generate Button Render', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders a clickable Generate button for doc types', () => {
    const { container } = render(
      <NotYetGeneratedState
        docLabel="Positioning"
        docType="positioning"
        clientId="test-org-uuid"
      />
    )

    const button = screen.getByTestId('generate-button')
    expect(button).toBeInTheDocument()
    expect(button).toHaveTextContent('Generate Positioning')
    expect(button).not.toBeDisabled()
  })

  it('calls POST /api/suggestions/regenerate with from-nothing args (no suggestion_id)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })

    render(
      <NotYetGeneratedState
        docLabel="Positioning"
        docType="positioning"
        clientId="test-org-uuid"
      />
    )

    const button = screen.getByTestId('generate-button')
    button.click()

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/suggestions/regenerate',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: 'test-org-uuid',
          document_type: 'positioning',
        }),
      })
    )

    // Verify NO suggestion_id in the request body
    const callArgs = (global.fetch as any).mock.calls[0]
    const bodyString = callArgs[1].body
    const bodyObj = JSON.parse(bodyString)
    expect(bodyObj).not.toHaveProperty('suggestion_id')
  })

  it('disables button and shows loading state while generating', async () => {
    global.fetch = vi.fn(
      () =>
        new Promise<Response>(resolve => {
          setTimeout(() => {
            resolve({
              ok: true,
              json: async () => ({}),
            } as Response)
          }, 100)
        })
    )

    render(
      <NotYetGeneratedState
        docLabel="Positioning"
        docType="positioning"
        clientId="test-org-uuid"
      />
    )

    const button = screen.getByTestId('generate-button')
    button.click()
    await new Promise(resolve => setTimeout(resolve, 10))

    // Button should be disabled and show loading text immediately
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('Generating…')

    // Wait for completion
    await waitFor(
      () => {
        expect(screen.getByText(/Generating your Positioning/)).toBeInTheDocument()
      },
      { timeout: 500 }
    )
  })

  it('shows error message on API failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Generation failed: ICP must be approved first' }),
    })

    render(
      <NotYetGeneratedState
        docLabel="Positioning"
        docType="positioning"
        clientId="test-org-uuid"
      />
    )

    const button = screen.getByTestId('generate-button')
    button.click()
    await new Promise(resolve => setTimeout(resolve, 0))

    await waitFor(() => {
      expect(screen.getByText('Generation failed: ICP must be approved first')).toBeInTheDocument()
    })

    // Button should return to idle state after error
    expect(button).not.toBeDisabled()
    expect(button).toHaveTextContent('Generate Positioning')
  })

  it('shows in-progress state after successful generation', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })

    render(
      <NotYetGeneratedState
        docLabel="Positioning"
        docType="positioning"
        clientId="test-org-uuid"
      />
    )

    const button = screen.getByTestId('generate-button')
    button.click()
    await new Promise(resolve => setTimeout(resolve, 0))

    await waitFor(() => {
      expect(screen.getByText(/Generating your Positioning/)).toBeInTheDocument()
    })
  })

  it('works for all document types (icp, positioning, tov, messaging)', () => {
    const docTypes: Array<'icp' | 'positioning' | 'tov' | 'messaging'> = [
      'icp',
      'positioning',
      'tov',
      'messaging',
    ]

    docTypes.forEach(docType => {
      const { unmount } = render(
        <NotYetGeneratedState
          docLabel={docType.charAt(0).toUpperCase() + docType.slice(1)}
          docType={docType}
          clientId="test-org-uuid"
        />
      )

      const button = screen.getByTestId('generate-button')
      expect(button).toBeInTheDocument()
      expect(button).toHaveTextContent(`Generate ${docType.charAt(0).toUpperCase() + docType.slice(1)}`)

      unmount()
    })
  })

  it('button is disabled while generation is in progress', async () => {
    global.fetch = vi.fn(
      () =>
        new Promise<Response>(resolve => {
          setTimeout(() => {
            resolve({
              ok: true,
              json: async () => ({}),
            } as Response)
          }, 100)
        })
    )

    render(
      <NotYetGeneratedState
        docLabel="Positioning"
        docType="positioning"
        clientId="test-org-uuid"
      />
    )

    const button = screen.getByTestId('generate-button')
    expect(button).not.toBeDisabled()

    button.click()
    await new Promise(resolve => setTimeout(resolve, 10))

    // Button should be disabled during generation
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('Generating…')

    // Wait for completion
    await waitFor(() => {
      expect(screen.getByText(/Generating your Positioning/)).toBeInTheDocument()
    })
  })
})
