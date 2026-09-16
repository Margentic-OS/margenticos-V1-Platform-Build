// Addressing a RECORD POSITION in a provider result set, in one place.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// Two callers need to address a record by its position rather than read from the top:
//
//   the tuner's spread sampler, which draws rows from positions scattered across the whole
//   reachable range (src/lib/tuner/spread-sample.ts)
//
//   sourcing, which needs to resume where the previous run for that client stopped
//   (src/lib/sourcing/handlers/adapter-apollo.ts)
//
// The sampler got there first and solved it the easy way: with `per_page` 1, the page
// number IS the record position and no arithmetic is needed. Sourcing cannot do that,
// because it reads a WINDOW of records rather than one, so it needs the general
// conversion. This module owns it, and owns the ceiling, so there is exactly one copy of
// both. RECORD_CEILING lived in spread-sample.ts and is re-exported from there.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT WAS MEASURED, AND WHEN
//
// Against the provider on 2026-09-08 and 2026-09-09, recorded in spread-sample.ts:
//
//   no documented sort, no offset parameter and no random ordering. `page` is the ONLY
//   way to move through a result set.
//
//   deep pages work and are free: pages 2, 25, 100, 400, 500, 501 and 600 all returned
//   rows, with ZERO overlap against page one.
//
//   the ceiling is exactly 50,000 records, enforced with HTTP 422. Page 5,000 at per_page
//   10 returns rows and page 5,001 does not, and the same boundary appears at page 500
//   with per_page 100.
//
//   page one is NOT STABLE between identical calls: re-fetching returned only 5 of 10 ids
//   in the same position.
//
// THAT LAST POINT IS WHY DEDUPE STAYS. The order churns locally, so a saved position is
// approximate: good enough to stop re-reading the same neighbourhood, not good enough to
// guarantee a record is seen once. A cursor is the mechanism and dedupe is the backstop,
// never the other way round.

/**
 * The provider's hard display ceiling. Measured: record 50,000 is reachable and 50,001 is
 * not, and asking past it returns HTTP 422 rather than an empty page.
 *
 * This is a limit on what is REACHABLE, not on what MATCHES. Measured for the live client
 * on 2026-09-15, its ICP matches 145,329 people, of whom 50,000 can ever be paged to. The
 * gap is not recoverable by paging harder; it needs a different or narrower query.
 */
export const RECORD_CEILING = 50_000

export interface PageAddress {
  /** The 1-based page number to ask the provider for. */
  page: number
  /**
   * How many rows to discard from the FRONT of that page.
   *
   * Non-zero whenever the offset does not land on a page boundary, which happens as soon
   * as two runs use different batch sizes. Measured on the three runs of 2026-09-15, whose
   * caps were 30, 36 and 44: with `per_page` varying like that, an offset of 30 against a
   * per_page of 44 is inside page 1, not at the start of page 2.
   *
   * WITHOUT THIS THE CURSOR SILENTLY OVER-READS. `floor(30/44) + 1` is page 1, so the run
   * would re-read records 1 to 30 and rely on dedupe to throw them away, which is the
   * behaviour the cursor exists to remove. Discarding the already-consumed prefix makes
   * the window exact and costs nothing: the page was fetched either way.
   */
  skipInPage: number
}

/**
 * Which page holds the record at `offset`, and how much of that page to skip.
 *
 * `offset` is a 0-based count of records already consumed for this client, so offset 0 is
 * "start at the first record" and offset 30 means "thirty have been read, start at the
 * thirty-first".
 */
export function addressForOffset(offset: number, perPage: number): PageAddress {
  if (!Number.isFinite(perPage) || perPage < 1) {
    throw new Error(`addressForOffset: perPage must be a positive integer, got ${perPage}`)
  }
  // A negative offset is a caller bug, not a state to tolerate quietly. Treating it as 0
  // would restart the client at the top of the result set and look like the cursor working.
  if (!Number.isFinite(offset) || offset < 0) {
    throw new Error(`addressForOffset: offset must be zero or positive, got ${offset}`)
  }
  const whole = Math.floor(offset / perPage)
  return { page: whole + 1, skipInPage: offset - whole * perPage }
}

/**
 * How many records remain below the ceiling from `offset`.
 *
 * Never negative. An offset at or past the ceiling returns 0, which is the condition
 * `isAtCeiling` reports and the caller must announce rather than treat as "no new people".
 */
export function remainingBelowCeiling(offset: number): number {
  return Math.max(0, RECORD_CEILING - offset)
}

/**
 * Whether this client has exhausted the reachable range.
 *
 * ── THE WHOLE REASON THIS IS A NAMED FUNCTION AND NOT AN INLINE COMPARISON ──
 *
 * At the ceiling the provider returns nothing, and "nothing" is indistinguishable from a
 * healthy run that happened to find no new people. Both produce zero written prospects and
 * a completed run. One is normal and the other means this client can never be sourced from
 * again without changing the query.
 *
 * The wall is roughly 1,250 runs away at current batch sizes, so nobody who reads this
 * later will remember the conversation that predicted it. It has to announce itself.
 */
export function isAtCeiling(offset: number): boolean {
  return offset >= RECORD_CEILING
}

/**
 * The window a run may read, clamped so it cannot ask past the ceiling.
 *
 * Returns the number of records this run is allowed to consume. Zero means the ceiling has
 * been reached and the caller must say so rather than proceed.
 */
export function windowBelowCeiling(offset: number, requested: number): number {
  return Math.min(Math.max(0, requested), remainingBelowCeiling(offset))
}
