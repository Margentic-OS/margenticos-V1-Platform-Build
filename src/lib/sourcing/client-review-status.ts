// What "this prospect has not been reviewed yet" means as a query filter.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS EXISTS FOR
//
// approve-all filtered the review status with
//
//     .in('client_review_status', [null, 'pending_review'])
//
// SQL IN never matches NULL, and NULL is where an unreviewed prospect actually sits: the
// column has no default and nothing writes 'pending_review' on the way in. So the UPDATE
// matched nothing. An UPDATE matching zero rows is not an error, so the route returned
// ok:true every time. Approve-all was a no-op that reported success.
//
// Measured on the live organisation before the fix, as SELECTs with the same filter chain:
// 100 rows at NULL, 0 at 'pending_review', 0 selected.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS IS ITS OWN MODULE AND NOT A CONST IN THE ROUTE
//
// It started as an export from the route file. `tsc --noEmit` accepted it and all 2493
// tests passed; `npm run build` refused it, because a Next.js route module may only export
// the handler names and a fixed set of config fields. Same family as the circular import
// CLAUDE.md records: green typecheck, green suite, red build, which is why a local
// production build is a required receipt rather than a formality.

/**
 * client_review_status IS NULL OR client_review_status = 'pending_review'.
 *
 * PostgREST or-filter form. Exported as a string constant so a test can assert the exact
 * value: it is the whole rule in one line, and the form it replaced silently matched
 * nothing, so the string itself is worth pinning. Same reasoning as
 * TIER_NOT_REJECTED_FILTER.
 *
 * 'pending_review' is kept rather than dropped. It is a legitimate stored value the review
 * UI can write, and a row sitting at it is unreviewed by any reading.
 */
export const UNREVIEWED_FILTER =
  'client_review_status.is.null,client_review_status.eq.pending_review'
