import type { SupabaseClient } from '@supabase/supabase-js'
import {
  classifyTier,
  type EnrichedProspect,
  type TieringSpec,
} from '@/lib/sourcing/tier-classification'

// Re-run tiering over prospects a client ALREADY HOLDS, against any set of search settings,
// and write nothing.
//
// ─── WHY THIS EXISTS AS ONE MODULE ───────────────────────────────────────────
//
// Two things ask "how would these settings judge the people already here":
//
//   scripts/compare-tiering.ts          an operator, from the terminal
//   the before-and-after panel          an operator, about to approve a change (ADR-061)
//
// They must give the same answer, and the only way two answers stay the same is for there
// to be one of them. Both call replayTiering, which calls the real classifyTier. Neither
// has its own copy of a rule.
//
// ─── WHO IS REPLAYED ─────────────────────────────────────────────────────────
//
// ENRICHED prospects, and only those. They are exactly the people tiering can ever judge:
// tierEnrichedBatch selects enrichment_status = 'enriched'. A prospect that was never
// enriched has no verified email and no industry on file, so classifying it says
// "removed" under every possible settings and tells nobody anything.
//
// ─── IT READS IN PAGES, AND SAYS SO WHEN A READ FAILS ────────────────────────
//
// A single select returns at most 1,000 rows from this database and reports nothing about
// the rest. A replay over the first thousand of three thousand prospects would be a
// confident answer about a third of the client. So the read pages until a page comes back
// short, and a failed page throws rather than returning what it had.
//
// Spends nothing. Classification makes no model call and no provider call.

/** Where a prospect stands: in a tier, removed, or not yet reached by tiering. */
export type ReplayState = 'tier_1' | 'tier_2' | 'tier_3' | 'removed' | 'not_tiered'

/** The order states are listed in, best first. */
export const REPLAY_STATES = ['tier_1', 'tier_2', 'tier_3', 'removed', 'not_tiered'] as const satisfies readonly ReplayState[]

export interface ReplayProspect extends EnrichedProspect {
  sourced_tier: string | null
  tiering_reason: string | null
  fit_score: number | null
}

/** What tiering reads from a prospect, plus the verdict stored on the row. */
export const REPLAY_COLUMNS =
  'id, organisation_id, email_status, enrichment_status, job_title, company_headcount, ' +
  // competitor_check: the competitor screen's stored verdict. Without it the replay would
  // show an excluded company gaining a tier under any settings, which the real pass never does.
  'company_industry, company_name, sourced_tier, tiering_reason, fit_score, competitor_check'

export const REPLAY_PAGE_SIZE = 1000

/**
 * Every enriched prospect one organisation holds.
 *
 * THROWS on a failed read. A caller that needs to carry on without the replay catches it
 * and says the replay is unavailable; it must never be handed a partial list as a whole one.
 */
export async function fetchEnrichedProspects(
  supabase: SupabaseClient,
  organisationId: string,
): Promise<ReplayProspect[]> {
  const rows: ReplayProspect[] = []
  for (let from = 0; ; from += REPLAY_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('prospects')
      .select(REPLAY_COLUMNS)
      .eq('organisation_id', organisationId)
      .eq('enrichment_status', 'enriched')
      // A stable order, or two pages can overlap and a row between them is never read.
      .order('id', { ascending: true })
      .range(from, from + REPLAY_PAGE_SIZE - 1)
    if (error) {
      throw new Error(
        `Enriched prospects could not be read for organisation ${organisationId} ` +
        `(rows ${from} onward): ${error.message}`,
      )
    }
    const page = (data ?? []) as unknown as ReplayProspect[]
    rows.push(...page)
    if (page.length < REPLAY_PAGE_SIZE) return rows
  }
}

/** The verdict stored on a row. The three cases tier-verdict.ts describes. */
export function storedState(prospect: Pick<ReplayProspect, 'sourced_tier' | 'tiering_reason'>): ReplayState {
  if (prospect.sourced_tier === 'tier_1' || prospect.sourced_tier === 'tier_2' || prospect.sourced_tier === 'tier_3') {
    return prospect.sourced_tier
  }
  return prospect.tiering_reason === null ? 'not_tiered' : 'removed'
}

export interface ReplayVerdict {
  id: string
  stored: ReplayState
  stored_reason: string | null
  stored_score: number | null
  /** What classifyTier says today, against the settings given. Never `not_tiered`. */
  replayed: Exclude<ReplayState, 'not_tiered'>
  replayed_reason: string
  replayed_score: number | null
}

/**
 * Classify each prospect against `spec` with the real classifier. Writes nothing.
 *
 * `supabase` is passed through to classifyTier, which reads the operator's industry tag
 * mappings with it, as the real tiering pass does. The result is in the order given.
 */
export async function replayTiering(
  prospects: readonly ReplayProspect[],
  spec: TieringSpec,
  supabase?: SupabaseClient,
): Promise<ReplayVerdict[]> {
  const verdicts: ReplayVerdict[] = []
  for (const prospect of prospects) {
    const result = await classifyTier(prospect, spec, supabase)
    verdicts.push({
      id: prospect.id,
      stored: storedState(prospect),
      stored_reason: prospect.tiering_reason,
      stored_score: prospect.fit_score,
      replayed: result.sourced_tier ?? 'removed',
      replayed_reason: result.tiering_reason,
      replayed_score: result.fit_score,
    })
  }
  return verdicts
}

export interface Movement {
  from: ReplayState
  to: ReplayState
  count: number
}

/**
 * Count pairs by where they started and where they ended, leaving out the ones that did
 * not move. Listed best starting state first, then best ending state.
 */
export function countMovements(pairs: ReadonlyArray<{ from: ReplayState; to: ReplayState }>): Movement[] {
  const counts = new Map<string, number>()
  for (const { from, to } of pairs) {
    if (from === to) continue
    const key = `${from}>${to}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const movements: Movement[] = []
  for (const from of REPLAY_STATES) {
    for (const to of REPLAY_STATES) {
      const count = counts.get(`${from}>${to}`)
      if (count) movements.push({ from, to, count })
    }
  }
  return movements
}

/** How many prospects are in each state. Every state is present, at zero if empty. */
export function countByState(states: readonly ReplayState[]): Record<ReplayState, number> {
  const counts = Object.fromEntries(REPLAY_STATES.map(state => [state, 0])) as Record<ReplayState, number>
  for (const state of states) counts[state] += 1
  return counts
}
