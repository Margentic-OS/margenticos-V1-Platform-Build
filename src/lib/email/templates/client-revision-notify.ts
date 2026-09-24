// client-revision-notify: sent to the operator when a CLIENT CHANGES AN ANSWER they had
// already given, on the intake form or in the buyer-targeting section.
//
// Operator-facing only. Not seen by clients. Sent with audience: 'operator'.
//
// ─── WHAT THIS TEMPLATE USED TO SAY, AND WHY IT CHANGED ──────────────────────
//
// It was written for a different event: "a client submitted a revision request for a
// strategy document, the revision agent has run, and the updated document is ready to
// view." It never had a caller, so it never sent that sentence to anybody, which is the
// only reason it could be repointed rather than deprecated.
//
// Two of its claims are now things this system must NOT say. Client approval on strategy
// documents was removed on 2026-09-03 (ADR-047), so there is no revision request to submit.
// And an intake edit REGENERATES NOTHING: it marks live documents as possibly out of date
// and stops, deliberately, because replacing copy a client has already seen with copy they
// have not is the failure the whole mechanism is built to avoid. An email announcing "the
// updated document is ready" would have described work nobody did.
//
// So the email now answers three questions and no others: what moved, from what to what,
// and which live documents are now flagged. It says in as many words that nothing was
// regenerated, because an operator who assumes otherwise stops looking.
//
// ─── THE CONSTRAINT THAT SHAPES EVERY VALUE IN HERE ──────────────────────────
//
// validateEmailContent refuses any email containing the literal words "null", "undefined"
// or "NaN", and the operator audience is exempt from the STYLE rules only, never from those
// RENDERING checks. Every value reaching this template is therefore pre-rendered by
// src/lib/intake/answer-change.ts, which spells nulls out in words. This template formats
// and escapes; it does not decide what an absent answer is called.

/** Operator vocabulary, not the client-facing labels. The operator does say "ICP". */
const DOC_TYPE_LABELS: Record<string, string> = {
  icp:         'ICP',
  tov:         'Tone of voice',
  positioning: 'Positioning',
  messaging:   'Messaging',
}

/** One answer that moved, already rendered for display. */
export interface ClientAnswerChange {
  fieldLabel: string
  previous: string
  next: string
}

export interface ClientRevisionNotifyParams {
  orgName: string
  orgId: string
  /** At least one. A notification with nothing in it must not be sent at all. */
  changes: ClientAnswerChange[]
  /** Document types this edit moved from live to stale. Often empty, which is not a fault. */
  flaggedDocumentTypes: readonly string[]
}

/**
 * Escape text that came from a client into HTML.
 *
 * Every value below is something a client typed. The version of this template that never
 * shipped interpolated its one client-supplied field raw. An operator email is not a web
 * page and no mail client will run a script from it, but an unclosed tag in an answer would
 * swallow the rest of the message, which is enough to lose the thing the email was sent to
 * say. Escaping costs nothing and removes the question.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function docLabel(docType: string): string {
  return DOC_TYPE_LABELS[docType] ?? docType
}

/**
 * The one sentence about staleness, in both renderings.
 *
 * An EMPTY list is the common case and is stated plainly rather than omitted. Saying nothing
 * would leave the operator to guess whether the flagging ran at all, and the answer matters:
 * a document can be unflagged because it was already stale, because this answer feeds no
 * document, or because no document exists yet. None of those is a fault, and all three read
 * the same from outside.
 */
function staleSentence(flaggedDocumentTypes: readonly string[]): string {
  if (flaggedDocumentTypes.length === 0) {
    return 'No live document was newly flagged by this change.'
  }
  const labels = flaggedDocumentTypes.map(docLabel).join(', ')
  return `Now flagged as possibly out of date: ${labels}.`
}

function changeCountPhrase(changes: ClientAnswerChange[]): string {
  return changes.length === 1 ? 'an answer' : `${changes.length} answers`
}

export function clientRevisionNotifySubject(
  orgName: string,
  changes: ClientAnswerChange[],
): string {
  if (changes.length === 1) {
    return `Client changed an answer: ${changes[0].fieldLabel}, ${orgName}`
  }
  return `Client changed ${changes.length} answers, ${orgName}`
}

export function clientRevisionNotifyTemplate({
  orgName,
  orgId,
  changes,
  flaggedDocumentTypes,
}: ClientRevisionNotifyParams): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.margenticos.com'
  // Straight to the answers themselves, which is what the operator opens this to check.
  const intakeUrl = `${appUrl}/dashboard/operator/clients/${orgId}/intake`

  const rows = changes.map(change => `
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;">
                <tr>
                  <td style="background:#f9f7f3;border:1px solid #e0d9cc;border-radius:6px;padding:16px;">
                    <p style="margin:0 0 10px;font-size:13px;font-weight:600;color:#1a1a1a;">${escapeHtml(change.fieldLabel)}</p>
                    <p style="margin:0 0 4px;font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#8a8175;">Was</p>
                    <p style="margin:0 0 10px;font-size:13px;color:#6b6358;line-height:1.6;white-space:pre-wrap;">${escapeHtml(change.previous)}</p>
                    <p style="margin:0 0 4px;font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#8a8175;">Now</p>
                    <p style="margin:0;font-size:13px;color:#1a1a1a;line-height:1.6;white-space:pre-wrap;">${escapeHtml(change.next)}</p>
                  </td>
                </tr>
              </table>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Client changed ${escapeHtml(changeCountPhrase(changes))}</title>
</head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background:#2d5a27;padding:24px 32px;">
              <p style="margin:0;color:#f5f0e8;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">MargenticOS Operator</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px;font-size:18px;font-weight:600;color:#1a1a1a;">
                Client changed ${escapeHtml(changeCountPhrase(changes))}
              </p>
              <p style="margin:0 0 20px;font-size:14px;color:#444;line-height:1.6;">
                <strong>${escapeHtml(orgName)}</strong> changed ${escapeHtml(changeCountPhrase(changes))} they had already given.
                <strong>Nothing has been regenerated.</strong> ${escapeHtml(staleSentence(flaggedDocumentTypes))}
              </p>
              ${rows}
              <table cellpadding="0" cellspacing="0" style="margin-top:12px;">
                <tr>
                  <td style="background:#2d5a27;border-radius:6px;">
                    <a href="${intakeUrl}"
                       style="display:inline-block;padding:12px 24px;color:#f5f0e8;font-size:14px;font-weight:600;text-decoration:none;">
                      View their answers
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

export function clientRevisionNotifyTemplateText({
  orgName,
  orgId,
  changes,
  flaggedDocumentTypes,
}: ClientRevisionNotifyParams): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.margenticos.com'
  const intakeUrl = `${appUrl}/dashboard/operator/clients/${orgId}/intake`

  const blocks = changes.map(change =>
    `${change.fieldLabel}\n  Was: ${change.previous}\n  Now: ${change.next}`,
  ).join('\n\n')

  return `Client changed ${changeCountPhrase(changes)}

${orgName} changed ${changeCountPhrase(changes)} they had already given. Nothing has been regenerated. ${staleSentence(flaggedDocumentTypes)}

${blocks}

View their answers: ${intakeUrl}`
}
