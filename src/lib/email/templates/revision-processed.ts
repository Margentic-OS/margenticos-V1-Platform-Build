import { getDocumentLabel } from '@/lib/document-labels'

// LABEL SWAP ONLY, 2026-08-27, and deliberately nothing else.
//
// This file held the SAME hardcoded document-label map TWICE, and both copies used the
// internal vocabulary: 'ICP' where the dashboard says "Prospect profile", 'Tone of Voice'
// where it says "Voice guide". A client reads this email and then opens a page with a
// different name on it.
//
// Both copies now call getDocumentLabel, the source the UI itself uses.
//
// TWO OTHER DEFECTS IN THIS TEMPLATE ARE LEFT ALONE ON PURPOSE, because they are copy
// decisions rather than mechanical fixes and the copy has not been reviewed:
//   1. it signs off "<client company> Team", which reads as the client's own team writing
//      to the client, the same fault that was just fixed in version-updated
//   2. it says "Log in to your dashboard" and gives NO LINK at all, so the reader has to
//      go and find the document themselves
// Both are in BACKLOG.

export function revisionProcessedSubject(orgName: string, docType: string): string {
  const typeLabel = getDocumentLabel(docType)

  return `${typeLabel} updated: your revision is live`
}

export function revisionProcessedTemplate(params: {
  orgName: string
  docType: string
}): string {
  const typeLabel = getDocumentLabel(params.docType)

  return `<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1a1a1a; line-height: 1.6; max-width: 600px; margin: 0 auto; padding: 20px;">
  <p>Your requested revision to the ${typeLabel} document has been approved and is now live.</p>
  <p>Log in to your dashboard to review the updated document and begin using it in your campaigns.</p>
  <p style="margin-top: 30px; color: #666; font-size: 14px;">
    ${params.orgName} Team
  </p>
</body>
</html>`
}
