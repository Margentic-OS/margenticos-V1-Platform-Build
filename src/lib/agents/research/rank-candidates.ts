// Choosing between candidates that already matched one of the client's triggers.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE TRIGGERS DECIDE WHAT COUNTS. THIS DECIDES WHICH ONE.
//
// Those are different jobs and conflating them was the defect. List position says which
// KIND of event the client cares about most; it says nothing about whether THIS instance is
// recent, specific, or a good reason to reply. A nine-month-old instance of trigger 1 is
// worse copy than last week's instance of trigger 6, and ranking by position alone cannot
// see that.
//
// DETERMINISTIC, PER ADR-018. Every input here is already computed: the six test results
// come from synthesis, the date comes from the source, the reshare flag comes from the
// provider payload. Nothing is scored again and no model is asked to rank. A second
// scoring pass would be a second opinion about numbers that already exist.
// ═════════════════════════════════════════════════════════════════════════════

export interface RankableCandidate {
  id: string
  /** Free-text date from the source. Parsed here; unparseable counts as undated. */
  date?: string | null
  /** The six test results synthesis already produced. */
  scores?: Partial<Record<'specific' | 'verifiable' | 'inferential' | 'relevant' | 'useful' | 'non_judgemental', boolean>> | null
  /** 1-based position in the client's trigger list. Null when it matched none. */
  matched_trigger?: number | null
  /** True when the underlying post was a reshare of somebody else's. */
  is_reshare?: boolean | null
  source?: string | null
}

export interface RankedCandidate extends RankableCandidate {
  /** Why this one sorted where it did, for the record and for a human to check. */
  rank_basis: {
    matched: boolean
    own_post: boolean
    days_old: number | null
    /** days_old bucketed by RECENCY_BAND_DAYS. This, not days_old, is what the sort reads. */
    recency_band: number | null
    specificity: number
    reason_strength: number
    trigger_position: number | null
  }
}

/**
 * How precisely the source dated this. A day is worth more than a month, and a month more
 * than a year, because "dated" in the specificity test means a reader can go and check it.
 */
export type DatePrecision = 'day' | 'month' | 'year' | 'none'

export function datePrecision(date: string | null | undefined): DatePrecision {
  if (!date) return 'none'
  const t = String(date)
  if (/(\d{4})-(\d{2})-(\d{2})/.test(t)) return 'day'
  if (/(\d{4})-(\d{2})(?!\d)/.test(t)) return 'month'
  if (/\b(20\d{2})\b/.test(t)) return 'year'
  return 'none'
}

/**
 * Days between the event and `now`. Null when there is no usable date.
 *
 * A COARSE DATE IS READ AT ITS OLDEST POSSIBLE DAY, not its midpoint. "2026-07" means some
 * day in July, and putting it on the 15th invents a precision the source did not give,
 * which is how a month-only date came to outrank an event dated to the day beside it.
 * The oldest reading is the fail-closed one, and it matches how an undated candidate is
 * already treated: uncertainty costs you, it does not pay.
 */
export function ageInDays(date: string | null | undefined, now: Date): number | null {
  const precision = datePrecision(date)
  if (precision === 'none') return null
  const t = String(date)
  let iso: string
  if (precision === 'day') {
    const m = t.match(/(\d{4})-(\d{2})-(\d{2})/)!
    iso = `${m[1]}-${m[2]}-${m[3]}`
  } else if (precision === 'month') {
    const m = t.match(/(\d{4})-(\d{2})(?!\d)/)!
    iso = `${m[1]}-${m[2]}-01`
  } else {
    const y = t.match(/\b(20\d{2})\b/)!
    iso = `${y[1]}-01-01`
  }
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  return Math.round((now.getTime() - d.getTime()) / 864e5)
}

/**
 * RECENCY IS COMPARED IN BANDS, NOT IN DAYS, and this is the part of the ordering most worth
 * arguing with. Change RECENCY_BAND_DAYS and nothing else moves.
 *
 * MEASURED, 2026-09-23, on the 20 prospects researched that day. Comparing exact ages made
 * the ordering pick a different candidate for two of them, and both picks were worse copy:
 * a month-only composite beat an event dated to the day because it was ONE day newer, and an
 * absence-shaped observation beat a specific conference post because it was SIX days newer.
 * In both, the loser was the plainer sentence and the more precisely dated one.
 *
 * Six days is not a difference a reader can perceive. Six months is. So candidates inside
 * the same fortnight count as equally recent and the criteria below recency decide between
 * them, which is what those criteria are for.
 */
export const RECENCY_BAND_DAYS = 14

function recencyBand(days: number | null): number | null {
  return days == null ? null : Math.floor(days / RECENCY_BAND_DAYS)
}

/**
 * SPECIFICITY, from the two tests that already ask it, plus HOW PRECISELY IT IS DATED.
 *
 * The date is not a third opinion invented here. "Named, dated, verifiable in the source" is
 * the criterion, and the two boolean tests cannot separate an event dated to the day from one
 * dated to the month: both score specific and verifiable. The precision is already on the
 * candidate and is the only thing that distinguishes them.
 */
function specificity(c: RankableCandidate): number {
  const byDate = { day: 2, month: 1, year: 0, none: 0 }[datePrecision(c.date)]
  return (c.scores?.specific ? 1 : 0) + (c.scores?.verifiable ? 1 : 0) + byDate
}

/** HOW DIRECTLY IT GIVES A REASON, from the two tests that already ask that. */
function reasonStrength(c: RankableCandidate): number {
  return (c.scores?.relevant ? 1 : 0) + (c.scores?.useful ? 1 : 0)
}

export function rankBasis(c: RankableCandidate, now: Date): RankedCandidate['rank_basis'] {
  const days = ageInDays(c.date, now)
  return {
    matched: c.matched_trigger != null,
    own_post: !c.is_reshare,
    days_old: days,
    recency_band: recencyBand(days),
    specificity: specificity(c),
    reason_strength: reasonStrength(c),
    trigger_position: c.matched_trigger ?? null,
  }
}

/**
 * Best first.
 *
 * ORDER, and each step only breaks ties the step above left:
 *
 *   0. MATCHED A TRIGGER. The client's list decides what counts at all, so anything that
 *      matched outranks anything that did not. Below that the same order applies, because a
 *      client with no triggers still needs its candidates sorted.
 *   1. THEIR OWN POST BEFORE A RESHARE. A reshare is not their event. It is still evidence
 *      of what they chose to amplify, so it stays in the list rather than being dropped, and
 *      it can still win when nothing of their own qualifies.
 *   2. RECENCY, IN BANDS of RECENCY_BAND_DAYS. Newer first. Undated sorts below every dated
 *      candidate: "we could not tell when" is not the same as "it was recent", and only one
 *      of those is worth writing. Within a band the criteria below decide, because a
 *      six-day difference is not one a reader can perceive and the measurement showed it
 *      overturning better copy.
 *   3. SPECIFICITY, from `specific`, `verifiable` and how precisely the event is dated.
 *   4. REASON STRENGTH, from `relevant` and `useful`.
 *   5. TRIGGER POSITION, tie-break only. By the time two candidates are equal on everything
 *      above, the client's own ordering is the best remaining signal.
 *   6. id, so the sort is total and a run is reproducible.
 */
export function rankCandidates<T extends RankableCandidate>(
  candidates: readonly T[],
  now: Date = new Date(),
  /**
   * LAST tie-break, lower first, applied after everything above and before id. It exists so
   * a caller can keep a preference of its own without that preference outranking the order
   * here: synthesis passes readability penalty, which used to be the whole sort and is now
   * only allowed to separate candidates the criteria above could not.
   */
  finalTieBreak?: (c: T) => number,
): Array<T & RankedCandidate> {
  return [...candidates]
    .map(c => ({ ...c, rank_basis: rankBasis(c, now) }) as T & RankedCandidate)
    .sort((a, b) => {
      const A = a.rank_basis, B = b.rank_basis
      if (A.matched !== B.matched) return A.matched ? -1 : 1
      if (A.own_post !== B.own_post) return A.own_post ? -1 : 1
      if (A.recency_band !== B.recency_band) {
        if (A.recency_band == null) return 1
        if (B.recency_band == null) return -1
        return A.recency_band - B.recency_band
      }
      if (A.specificity !== B.specificity) return B.specificity - A.specificity
      if (A.reason_strength !== B.reason_strength) return B.reason_strength - A.reason_strength
      const ap = A.trigger_position ?? Number.MAX_SAFE_INTEGER
      const bp = B.trigger_position ?? Number.MAX_SAFE_INTEGER
      if (ap !== bp) return ap - bp
      if (finalTieBreak) {
        const at = finalTieBreak(a), bt = finalTieBreak(b)
        if (at !== bt) return at - bt
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
}

/** What pure list position would have chosen, for comparison. Never used to select. */
export function byTriggerPositionOnly<T extends RankableCandidate>(candidates: readonly T[]): T[] {
  return [...candidates]
    .filter(c => c.matched_trigger != null)
    .sort((a, b) => (a.matched_trigger! - b.matched_trigger!) || (a.id < b.id ? -1 : 1))
}
