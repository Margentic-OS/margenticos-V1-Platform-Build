// @vitest-environment jsdom
//
// The copy tells the client "we have been notified". These tests are what make that true
// rather than a claim: if the logger call is ever removed, the message becomes a lie and
// this file goes red. A promise in user-facing copy needs a test on the promise, not on the
// copy, because the copy will keep rendering perfectly either way.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { DocumentPlainTextFallback } from '../DocumentPlainTextFallback'
import { logger } from '@/lib/logger'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

beforeEach(() => vi.clearAllMocks())
afterEach(() => cleanup())

describe('DocumentPlainTextFallback', () => {
  it('renders the text when there is text, and does not log', () => {
    render(<DocumentPlainTextFallback text="The rendered document body." docType="icp" />)

    expect(screen.getByText('The rendered document body.')).toBeInTheDocument()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('shows the honest message when there is nothing to render', () => {
    render(<DocumentPlainTextFallback text={null} docType="tov" />)

    expect(screen.getByText(/could not be displayed/i)).toBeInTheDocument()
    expect(screen.getByText(/your document is complete/i)).toBeInTheDocument()
  })

  it('no longer claims the document is being processed', () => {
    // The replaced copy said "Document content is being processed. Check back shortly."
    // Nothing is being processed: a strategy_documents row exists only after promotion, so
    // the document is finished and live by the time this renders. The old sentence invited
    // the client to wait for an event that cannot happen.
    render(<DocumentPlainTextFallback text={null} docType="tov" />)

    expect(screen.queryByText(/being processed/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/check back/i)).not.toBeInTheDocument()
  })

  it('ACTUALLY notifies, because the copy says we have been notified', () => {
    render(<DocumentPlainTextFallback text={null} docType="positioning" docId="doc-123" />)

    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not be displayed'),
      expect.objectContaining({ document_type: 'positioning', document_id: 'doc-123' }),
    )
  })

  it('treats empty string as unrenderable, not as an empty document', () => {
    // renderDocumentPlainText returns '' for content carrying no words, and the backfill
    // stores null rather than '' for exactly that case. Handling both here means a row
    // written by some other path cannot render a blank card with no log line.
    render(<DocumentPlainTextFallback text="" docType="icp" />)

    expect(screen.getByText(/could not be displayed/i)).toBeInTheDocument()
    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})
