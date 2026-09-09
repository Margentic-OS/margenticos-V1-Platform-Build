// Renders the plain_text for a suggestion that is about to be promoted.
//
// WHY THIS IS A SHARED HELPER AND NOT INLINE AT EACH CALL SITE. Two routes approve
// suggestions: the operator's approve route and the auto-approve cron. They must produce
// byte-identical text for the same content, because a document promoted by the cron and the
// same document promoted by a click would otherwise carry different prose, and the
// difference would be invisible until someone diffed two versions and found the formatting
// had moved. One function, two callers.
//
// WHY THE RENDER HAPPENS HERE RATHER THAN IN plpgsql. `promote_strategy_doc_version` takes
// plain_text as a parameter precisely so the renderer stays in TypeScript and there is only
// one of it. A second renderer in SQL would be a list kept in step with the first by hand,
// which is the shape that produced the monitor sweep's silent gap and the incomplete literal
// behind an `as`.
//
// WHY IT NEVER THROWS. Approval is the operator's action and it must not fail because a
// document rendered oddly. A null return promotes the document with plain_text NULL, which
// is exactly the state every row was in before 2026-09-08: degraded, visible, and not a lost
// document. Refusing to approve would be a worse failure than the one being fixed.

import { renderDocumentPlainText } from '@/lib/documents/render-plain-text'
import { logger } from '@/lib/logger'

/**
 * Renders `suggested_value` (a JSON string) as plain text.
 *
 * Returns null when the value cannot be parsed. The caller passes that null straight to the
 * RPC, which stores it, so the failure shows up as a NULL column rather than as a failed
 * approval or a silently truncated document.
 */
export function plainTextForSuggestedValue(
  suggestedValue: string | null,
  context: { suggestion_id: string; document_type?: string },
): string | null {
  if (!suggestedValue) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(suggestedValue)
  } catch {
    // approve_document_suggestion casts the same string to jsonb and raises if it cannot.
    // So this branch means the RPC is about to fail too, and the approval will roll back.
    // Logged rather than thrown because the RPC produces the operator-facing error.
    logger.warn('plainTextForSuggestedValue: suggested_value is not valid JSON', context)
    return null
  }

  try {
    const rendered = renderDocumentPlainText(parsed)
    return rendered.trim() === '' ? null : rendered
  } catch (e) {
    logger.error('plainTextForSuggestedValue: render failed, promoting without plain_text', {
      ...context,
      error: (e as Error).message,
    })
    return null
  }
}
