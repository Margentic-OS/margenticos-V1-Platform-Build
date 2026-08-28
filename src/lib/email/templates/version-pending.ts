import { strategyDocumentUrl } from '@/lib/urls/strategy-document-url'
import { getDocumentLabel } from '@/lib/document-labels'

// THE LABEL COMES FROM THE UI'S OWN SOURCE, not from a second list kept here.
//
// This template used to carry { icp: 'ICP', tov: 'Tone of Voice', ... }, which is the
// INTERNAL vocabulary. The dashboard sidebar and the page the button opens both call
// getDocumentLabel, so a client received an email about their "ICP" and landed on a page
// titled "Prospect profile". Two names for one thing, in the same click.
//
// src/lib/document-labels.ts already existed and already said, in its own header, "Never
// show the raw database value ('icp', 'tov') to clients". The defect was not a missing
// source of truth. It was a second list next to one.
function label(docType: string): string {
  return getDocumentLabel(docType)
}

export function versionPendingSubject(orgName: string, docType: string): string {
  return `${label(docType)} has been updated`
}

export interface VersionPendingParams {
  /** The document that changed. */
  docType: string
  /** The recipient's own first name, from organisations.founder_first_name on their org. */
  recipientFirstName: string | null
  /** Who the email is from, from organisations.founder_first_name on the operator's org. */
  senderFirstName: string
  /** The operator's company name, for the second sign-off line. */
  senderCompanyName: string
  /**
   * Set ONLY when the recipient is an operator. resolveViewingOrg ignores ?client= for a
   * client user, so passing it to a client is noise at best.
   */
  clientId?: string | null
}

// ═══════════════════════════════════════════════════════════════════════════════
// WHAT THIS EMAIL IS, AND WHY IT WAS REWRITTEN
//
// It is what a paying client receives every time one of their four strategy documents
// changes. Until 2026-08-27 it was one sentence, one button pointing at a 404, and
// "[Company] Team" as a sign-off, which read as the client's own team writing to them.
//
// The button pointed at /dashboard/documents. That route has never existed. Three sends
// were confirmed 404ing on 27 August across ICP, positioning and tone of voice, which means
// nobody had ever clicked it, dogfooding included.
//
// The rewrite is plain on purpose. No hero image, no brand block, no three-column footer.
// A client who gets this every time a document changes wants to know what changed, what to
// do about it, and what happens if they ignore it. Everything else is decoration that makes
// the next one easier to skip.
//
// BOTH NAMES COME FROM organisations.founder_first_name, one from each side:
//   greeting  the RECIPIENT's organisation, so the client is addressed by name
//   sign-off  the OPERATOR's organisation, so a person signs it rather than a "Team"
// Never hardcoded. See resolvePlatformSender in src/lib/notifications/platform-sender.ts.
//
// The three-day line is not a nicety: strategy-doc-auto-approve promotes anything still
// pending after three days, so a client who does nothing has still decided something. An
// email that hides that is misleading by omission. It is phrased as a commitment we are
// making ("we will take that as approval and move ahead") rather than as a default that
// happens to them, because the first invites a reply and the second invites ignoring it.
// ═══════════════════════════════════════════════════════════════════════════════

export function versionPendingTemplate(params: VersionPendingParams): string {
  const docLabel = label(params.docType)
  const url = strategyDocumentUrl(params.docType, params.clientId ?? null)
  const greeting = params.recipientFirstName ? `Hi ${params.recipientFirstName},` : 'Hi,'

  return `<html>
<body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.6;font-size:15px;">
  <div style="max-width:520px;margin:0 auto;">
    <p style="margin:0 0 16px;">${greeting}</p>

    <p style="margin:0 0 20px;">Your ${docLabel} has been updated and is ready for you to review.</p>

    <p style="margin:0 0 24px;">
      <a href="${url}" style="display:inline-block;background:#1a1a1a;color:#ffffff;padding:11px 22px;text-decoration:none;border-radius:4px;font-size:14px;">Review your ${docLabel}</a>
    </p>

    <p style="margin:0 0 16px;">If it reads right, approve it. If something is off, use Request changes on the page and tell us what to change. The document is rewritten from what you write there, so the more specific you are, the closer the next version lands.</p>

    <p style="margin:0 0 24px;">If we do not hear from you within three days we will take that as approval and move ahead.</p>

    <p style="margin:0;">${params.senderFirstName}<br />${params.senderCompanyName}</p>
  </div>
</body>
</html>`
}

export function versionPendingText(params: VersionPendingParams): string {
  const docLabel = label(params.docType)
  const url = strategyDocumentUrl(params.docType, params.clientId ?? null)
  const greeting = params.recipientFirstName ? `Hi ${params.recipientFirstName},` : 'Hi,'

  return `${greeting}

Your ${docLabel} has been updated and is ready for you to review.

Review your ${docLabel}: ${url}

If it reads right, approve it. If something is off, use Request changes on the page and tell us what to change. The document is rewritten from what you write there, so the more specific you are, the closer the next version lands.

If we do not hear from you within three days we will take that as approval and move ahead.

${params.senderFirstName}
${params.senderCompanyName}`
}
