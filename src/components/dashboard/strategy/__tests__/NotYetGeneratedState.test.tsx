// @vitest-environment jsdom
//
// Tests for NotYetGeneratedState component:
// - Button renders correctly
// - POST /api/suggestions/regenerate called on click
// - Error handling and reset on failure
// - Reconnection to real state on mount (polling)
// - Does NOT set generating state optimistically (only after successful response)

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

describe('NotYetGeneratedState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  afterEach(() => {
    cleanup()
  })

  describe('Button Render', () => {
    it('renders a clickable Generate button', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ isGenerating: false }),
      })

      render(
        <NotYetGeneratedState
          docLabel="Positioning"
          docType="positioning"
          clientId="test-org-uuid"
        />
      )

      await waitFor(() => {
        const button = screen.getByTestId('generate-button')
        expect(button).toBeInTheDocument()
        expect(button).toHaveTextContent('Generate Positioning')
        expect(button).not.toBeDisabled()
      })
    })
  })

  describe('API Call', () => {
    it('calls POST /api/suggestions/regenerate on button click (no suggestion_id)', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ isGenerating: false }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) })

      render(
        <NotYetGeneratedState
          docLabel="Positioning"
          docType="positioning"
          clientId="test-org-uuid"
        />
      )

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalled()
      })

      const button = screen.getByTestId('generate-button')
      button.click()

      await waitFor(() => {
        const postCall = (global.fetch as any).mock.calls.find(
          (call: any[]) => call[1]?.method === 'POST'
        )
        expect(postCall).toBeDefined()
        expect(postCall[0]).toBe('/api/suggestions/regenerate')
      })

      const postCall = (global.fetch as any).mock.calls.find(
        (call: any[]) => call[1]?.method === 'POST'
      )
      const bodyObj = JSON.parse(postCall[1].body)
      expect(bodyObj).not.toHaveProperty('suggestion_id')
      expect(bodyObj.client_id).toBe('test-org-uuid')
      expect(bodyObj.document_type).toBe('positioning')
    })
  })

  describe('Error Handling', () => {
    it('shows error message and resets button on API failure', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ isGenerating: false }) })
        .mockResolvedValueOnce({
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

      await waitFor(() => {
        expect(button).not.toBeDisabled()
      })

      button.click()

      await waitFor(() => {
        expect(screen.getByText('Generation failed: ICP must be approved first')).toBeInTheDocument()
      })

      // Button should remain enabled after error
      expect(button).not.toBeDisabled()
      expect(button).toHaveTextContent('Generate Positioning')
    })

    it('does NOT set generating state optimistically', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ isGenerating: false }) })
        .mockResolvedValueOnce({
          ok: false,
          json: async () => ({ error: 'Generation failed' }),
        })

      render(
        <NotYetGeneratedState
          docLabel="Positioning"
          docType="positioning"
          clientId="test-org-uuid"
        />
      )

      const button = screen.getByTestId('generate-button')

      await waitFor(() => {
        expect(button).not.toBeDisabled()
      })

      button.click()

      // Button text should still be Generate, not optimistically Generating
      expect(button).toHaveTextContent('Generate Positioning')

      await waitFor(() => {
        expect(screen.getByText('Generation failed')).toBeInTheDocument()
      })

      // Still shows idle button after error
      expect(button).toHaveTextContent('Generate Positioning')
    })
  })

  describe('Generating State', () => {
    it('shows generating state after successful POST response', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ isGenerating: false }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ isGenerating: true }) })

      render(
        <NotYetGeneratedState
          docLabel="Positioning"
          docType="positioning"
          clientId="test-org-uuid"
        />
      )

      const button = screen.getByTestId('generate-button')

      await waitFor(() => {
        expect(button).not.toBeDisabled()
      })

      button.click()

      await waitFor(() => {
        expect(screen.getByText(/Generating your Positioning/)).toBeInTheDocument()
      })
    })

    it('shows generating UI while generation is in progress', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ isGenerating: false }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ isGenerating: true }) })

      render(
        <NotYetGeneratedState
          docLabel="Positioning"
          docType="positioning"
          clientId="test-org-uuid"
        />
      )

      const button = screen.getByTestId('generate-button')

      await waitFor(() => {
        expect(button).not.toBeDisabled()
      })

      button.click()

      // After successful POST, should show generating spinner, not button
      await waitFor(() => {
        expect(screen.getByText(/Generating your Positioning/)).toBeInTheDocument()
        // Button should no longer be rendered; instead the spinner view is shown
        expect(screen.queryByTestId('generate-button')).not.toBeInTheDocument()
      })
    })
  })

  describe('Pending Suggestion State', () => {
    it('shows pending review message when hasPendingSuggestion is true', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ isGenerating: false }),
      })

      render(
        <NotYetGeneratedState
          docLabel="Positioning"
          docType="positioning"
          clientId="test-org-uuid"
          hasPendingSuggestion={true}
        />
      )

      await waitFor(() => {
        expect(screen.getByText(/Your Positioning is being reviewed/)).toBeInTheDocument()
      })

      // Button should not be rendered when there's a pending suggestion
      expect(screen.queryByTestId('generate-button')).not.toBeInTheDocument()
    })

    it('takes precedence over generating state', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ isGenerating: true }),
      })

      render(
        <NotYetGeneratedState
          docLabel="Positioning"
          docType="positioning"
          clientId="test-org-uuid"
          hasPendingSuggestion={true}
        />
      )

      await waitFor(() => {
        // Should show pending message, not generating message
        expect(screen.getByText(/Your Positioning is being reviewed/)).toBeInTheDocument()
        expect(screen.queryByText(/Generating your Positioning/)).not.toBeInTheDocument()
      })
    })

    it('transitions from pending state when suggestion is resolved', async () => {
      const { rerender } = render(
        <NotYetGeneratedState
          docLabel="Positioning"
          docType="positioning"
          clientId="test-org-uuid"
          hasPendingSuggestion={true}
        />
      )

      await waitFor(() => {
        expect(screen.getByText(/Your Positioning is being reviewed/)).toBeInTheDocument()
      })

      // Mock generation-status check
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ isGenerating: false }),
      })

      // Re-render with hasPendingSuggestion=false (suggestion was resolved)
      rerender(
        <NotYetGeneratedState
          docLabel="Positioning"
          docType="positioning"
          clientId="test-org-uuid"
          hasPendingSuggestion={false}
        />
      )

      await waitFor(() => {
        const button = screen.getByTestId('generate-button')
        expect(button).toBeInTheDocument()
      })
    })
  })

  describe('Reconnection on Mount', () => {
    it('reconnects to real state on mount if generation is already in progress', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ isGenerating: true }),
      })

      render(
        <NotYetGeneratedState
          docLabel="Positioning"
          docType="positioning"
          clientId="test-org-uuid"
        />
      )

      await waitFor(() => {
        const calls = (global.fetch as any).mock.calls
        const statusCall = calls.find((call: any[]) => call[0].includes('/api/generation-status?'))
        expect(statusCall).toBeDefined()
        expect(statusCall[0]).toContain('client_id=test-org-uuid')
        expect(statusCall[0]).toContain('document_type=positioning')
      })

      await waitFor(() => {
        expect(screen.getByText(/Generating your Positioning/)).toBeInTheDocument()
      })

      // When reconnected to generating state, button should not be visible
      expect(screen.queryByTestId('generate-button')).not.toBeInTheDocument()
    })

    it('remains in idle state if no generation is in progress on mount', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ isGenerating: false }),
      })

      render(
        <NotYetGeneratedState
          docLabel="Positioning"
          docType="positioning"
          clientId="test-org-uuid"
        />
      )

      const button = screen.getByTestId('generate-button')

      await waitFor(() => {
        expect(button).not.toBeDisabled()
        expect(button).toHaveTextContent('Generate Positioning')
      })
    })
  })

  describe('All Document Types', () => {
    it('works for all document types (icp, positioning, tov, messaging)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ isGenerating: false }),
      })

      const docTypes: Array<'icp' | 'positioning' | 'tov' | 'messaging'> = [
        'icp',
        'positioning',
        'tov',
        'messaging',
      ]

      for (const docType of docTypes) {
        const { unmount } = render(
          <NotYetGeneratedState
            docLabel={docType.charAt(0).toUpperCase() + docType.slice(1)}
            docType={docType}
            clientId="test-org-uuid"
          />
        )

        const button = screen.getByTestId('generate-button')

        await waitFor(() => {
          expect(button).toBeInTheDocument()
          expect(button).toHaveTextContent(`Generate ${docType.charAt(0).toUpperCase() + docType.slice(1)}`)
        })

        unmount()
      }
    })
  })
})
