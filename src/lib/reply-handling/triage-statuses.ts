// The one place that decides which reply_drafts statuses the operator triage
// queue serves, and what the operator may do with each.
//
// WHY THIS MODULE EXISTS. These lists used to be three separate literals: one in
// the list route, one in the approve route, and one in the reject route. They
// drifted. The queue served four statuses, reject accepted two, and a
// manual_required draft sat in production from 2026-09-03 with a Reject button
// that could only ever return 409. That is the parallel-lists shape in
// CLAUDE.md: two lists that must agree, kept in step by hand, with no error
// when they stop agreeing.
//
// The fix is structural. TRIAGE_STATUSES is the only list. Everything else is
// derived from it, so a new status becomes rejectable and approvable by default
// and can only be excluded by naming it below. There is no second list to
// forget to update.

// Every status the triage queue serves. Adding one here is what puts rows in
// front of an operator, so it is also what grants the actions below.
export const TRIAGE_STATUSES = [
  'pending',          // AI-drafted, awaiting operator approval
  'manual_required',  // no draft generated (missing org context); operator writes
  'draft_failed',     // drafter failed after retries; operator writes
  'send_failed',      // post-approval send to Instantly failed; operator dismisses
] as const

export type TriageStatus = (typeof TRIAGE_STATUSES)[number]

// Approve sends an email. send_failed rows have already been approved once and
// the send failed, so approving again would re-send. The UI hides the Approve
// button on them; this is the server-side half of the same rule.
const NOT_APPROVABLE: readonly TriageStatus[] = ['send_failed']

// Derived, never hand-listed. A status added to TRIAGE_STATUSES is approvable
// unless it is named in NOT_APPROVABLE above.
export const APPROVABLE_STATUSES: readonly TriageStatus[] =
  TRIAGE_STATUSES.filter(status => !NOT_APPROVABLE.includes(status))

// Reject means "remove this row from the queue and handle it outside the
// platform". Every row the queue serves can be removed, whatever put it there.
// There is deliberately no exclusion list: a queued row an operator cannot
// clear is a row that stays in the queue forever, which is the defect this
// module was written to close.
export const REJECTABLE_STATUSES: readonly TriageStatus[] = TRIAGE_STATUSES

// Status comes off the database row as a plain string. These narrow it without
// a cast, so an unrecognised status is simply not actionable rather than being
// asserted into a type it does not belong to.
export function isApprovable(status: string): boolean {
  return (APPROVABLE_STATUSES as readonly string[]).includes(status)
}

export function isRejectable(status: string): boolean {
  return (REJECTABLE_STATUSES as readonly string[]).includes(status)
}
