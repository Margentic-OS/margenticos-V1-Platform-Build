// What "the version we are working from" means, as one list.
//
// The strategy page and /api/documents/revise disagreed about this. The page selected
// status in ('active', 'approved') and the route accepted 'active' alone, so a document
// the page was willing to render was a document the route was willing to call missing.
// Nothing had gone wrong yet only because no row currently carries 'approved': every
// row is 'active' or 'archived', and promote_strategy_doc_version writes 'active'.
//
// A latent mismatch is still a mismatch, and the two lists were written by hand in two
// files, which is the shape that drifts. One exported constant means the page and the
// route cannot disagree again without someone editing this line.
//
// 'approved' is kept rather than dropped because it is the prevailing convention
// elsewhere for a live document: the readiness gate in assertStrategyApproved, the
// client navigation, and the clients_read_own_strategy_docs RLS policy all admit it.
// Narrowing to 'active' alone would have made this page disagree with those instead,
// and it fails in the worse direction: a live document silently absent from the client's
// screen, rather than a legacy row still being revisable.
export const LIVE_DOCUMENT_STATUSES = ['active', 'approved'] as const

export type LiveDocumentStatus = (typeof LIVE_DOCUMENT_STATUSES)[number]
