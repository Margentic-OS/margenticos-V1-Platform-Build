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
    specificity: number
    reason_strength: number
    trigger_position: number | null
  }
}

/** Days between the event and `now`. Null when there is no usable date. */
export function ageInDays(date: string | null | undefined, now: Date): number | null {
  if (!date) return null
  const m = String(date).match(/(\d{4})-(\d{2})-(\d{2})/) ?? String(date).match(/(\d{4})-(\d{2})(?!\d)/)
  if (!m) {
    const y = String(date).match(/\b(20\d{2})\b/)
    if (!y) return null
    const d = new Date(`${y[1]}-07-01T12:00:00Z`)
    return Math.round((now.getTime() - d.getTime()) / 864e5)
  }
  const iso = m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}-15`
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  return Math.round((now.getTime() - d.getTime()) / 864e5)
}

/** SPECIFICITY, from the two tests that already ask it: named, dated, checkable. */
function specificity(c: RankableCandidate): number {
  return (c.scores?.specific ? 1 : 0) + (c.scores?.verifiable ? 1 : 0)
}

/** HOW DIRECTLY IT GIVES A REASON, from the two tests that already ask that. */
function reasonStrength(c: RankableCandidate): number {
  return (c.scores?.relevant ? 1 : 0) + (c.scores?.useful ? 1 : 0)
}

export function rankBasis(c: RankableCandidate, now: Date): RankedCandidate['rank_basis'] {
  return {
    matched: c.matched_trigger != null,
    own_post: !c.is_reshare,
    days_old: ageInDays(c.date, now),
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
 *   2. RECENCY. Newer first. Undated sorts below every dated candidate: "we could not tell
 *      when" is not the same as "it was recent", and only one of those is worth writing.
 *   3. SPECIFICITY, from `specific` and `verifiable`.
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
      if (A.days_old !== B.days_old) {
        if (A.days_old == null) return 1
        if (B.days_old == null) return -1
        return A.days_old - B.days_old
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
