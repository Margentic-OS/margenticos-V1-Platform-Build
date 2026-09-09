'use client'

import { useEffect } from 'react'
import { logger } from '@/lib/logger'

// The fallback shown when a strategy document's structured content does not match the shape
// its view knows how to render.
//
// ONE COMPONENT, NOT THREE. This existed as three byte-identical copies of `PlainTextView`
// in IcpDocumentView, TovDocumentView and PositioningDocumentView, each with its own copy of
// the placeholder sentence. Three copies of a string is three places to fix it and two
// places to forget, which is how the wrong sentence survived for months in all three.
//
// ─── What was wrong with the old sentence ───────────────────────────────────
//
// It read "Document content is being processed. Check back shortly."
//
// Nothing is being processed and nothing will change if the client comes back. A
// strategy_documents row exists only once it has been promoted, so by the time this renders
// the document is FINISHED and LIVE. The old copy described a pending state that this system
// does not have, and it invited the client to wait for an event that will never happen.
//
// It was also latent rather than live: measured 2026-09-08, zero of 49 ICP, positioning and
// TOV documents fail their view's structural check, so no client has actually seen it. That
// is why it survived. It is a trap waiting for the first document that fails to parse, not a
// defect anyone had reported.
//
// ─── Why it logs ─────────────────────────────────────────────────────────────
//
// The new copy tells the client we have been notified. That sentence has to be TRUE, so the
// notification is in this component rather than in a promise. A message claiming an alert
// that nothing raises is worse than the message it replaced: the old one was merely wrong,
// and that one would be wrong AND load-bearing.
//
// logger.error, not warn: reaching this means a live document cannot be displayed to the
// client it was written for. There is no lower-severity reading of that.

export function DocumentPlainTextFallback({
  text,
  docType,
  docId,
}: {
  text: string | null
  docType: string
  docId?: string
}) {
  const unrenderable = !text

  useEffect(() => {
    if (!unrenderable) return
    logger.error('Strategy document could not be displayed: content did not parse and plain_text is empty', {
      document_type: docType,
      document_id: docId ?? null,
    })
  }, [unrenderable, docType, docId])

  if (unrenderable) {
    return (
      <div className="bg-surface-card border border-border-card rounded-[10px] p-6 max-w-[640px]">
        <p className="text-[12px] text-text-secondary">
          This document could not be displayed. Your document is complete; this is a display
          problem on our side and we have been notified.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-surface-card border border-border-card rounded-[10px] p-6 max-w-[640px]">
      <p className="text-[13px] text-text-primary leading-[1.7] whitespace-pre-line">{text}</p>
    </div>
  )
}
