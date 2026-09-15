// A count an operator reads as "how much work is left" must never be a failure in disguise.
//
// ── THE FAILURE THIS REMOVES ─────────────────────────────────────────────────
//
// `const { count } = await supabase...; const n = count ?? 0` turns a refused read, a
// timed-out read and a genuinely empty table into the same number. On an operator screen
// that number is read as "nothing left to do": "Awaiting approval 0" beside 100 pending
// rows is indistinguishable from an empty queue, and the operator closes the tab.
//
// src/lib/operator/sourcing-metrics.ts already made this decision and says so in the same
// words. This is that decision, extracted, so the next count site has something to import
// rather than a comment to re-derive.
//
// ── IT ALSO REFUSES A NULL COUNT, WHICH IS THE STRICTER HALF ─────────────────
//
// postgrest-js only sends the `Prefer: count=` header when the `count` option is passed,
// so a query that FORGOT `{ count: 'exact' }` returns count === null with NO error. That
// is not hypothetical here: it is written up at two call sites in this repo
// (src/app/api/reply-drafts/[id]/approve/route.ts and
// src/lib/reply-handling/send-approved-draft.ts) where a missing option made a `count === 0`
// idempotency guard permanently unreachable, and nothing failed.
//
// So a null count with no error is treated as a defect, not as zero. The only way to get a
// number out of this function is for the database to have actually returned one.

export interface CountResult {
  count: number | null
  error: { message: string } | null
}

/**
 * The count, or an exception. Never a consoling zero.
 *
 * `what` is used in the message and should name what was being counted and for whom, since
 * the operator seeing the error is the person who has to decide whether it matters.
 */
export function requireCount(result: CountResult, what: string): number {
  if (result.error) {
    throw new Error(`Could not count ${what}: ${result.error.message}`)
  }
  if (result.count === null) {
    throw new Error(
      `Could not count ${what}: the query returned no count. ` +
      "This almost always means { count: 'exact' } was omitted from .select().",
    )
  }
  return result.count
}
