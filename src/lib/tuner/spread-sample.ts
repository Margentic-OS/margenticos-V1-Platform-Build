// Drawing a sample that is not page one.
//
// ─── WHY PAGE ONE IS NOT A SAMPLE ────────────────────────────────────────────
//
// MEASURED AGAINST THE PROVIDER 2026-09-08 and 2026-09-09:
//
//   the provider documents no sort, no offset and no random ordering; `page` is the only
//   way to move through a result set
//
//   deep pages work and are free: pages 2, 25, 100, 400, 500, 501 and 600 all returned rows
//   with ZERO overlap against page one
//
//   the ceiling is exactly 50,000 records, enforced with HTTP 422: page 5,000 at per_page 10
//   returns rows and page 5,001 does not, and the same boundary appears at page 500 with
//   per_page 100
//
//   page one is NOT STABLE between identical calls: re-fetching it returned only 5 of 10
//   ids in the same position
//
// So a sample must be drawn from record positions spread across the whole reachable range.
// Reading page one twice is not a second sample; it is the same biased slice, shuffled.
//
// ─── PER_PAGE 1, WHICH LOOKS WASTEFUL AND IS NOT ─────────────────────────────
//
// Asking for one row per call means one call per sampled row, which sounds expensive until
// you price it: people search consumes no credits, so the entire cost is a rate-limit slot
// and 320ms of throttle. Eighty rows is eighty free calls and about half a minute.
//
// The alternative, taking a whole page of 100 and treating it as the sample, is cheaper in
// calls and worthless as a sample: 100 consecutive records are one neighbourhood of the
// result set, and the thing being measured is what the WHOLE set contains.

import { countAndSample, type ProviderBudget, type SampleRow } from '@/lib/tuner/count-and-sample'
import { logger } from '@/lib/logger'

/** The provider's hard display ceiling, measured: record 50,000 works and 50,001 does not. */
export const RECORD_CEILING = 50_000

/**
 * Default rows per round.
 *
 * ─── WHY 80 AND NOT 20 ───────────────────────────────────────────────────────
 *
 * MEASURED. At n=20, seven draws from one unchanged search gave fit proportions of 13.3,
 * 26.7, 26.7, 25.0, 30.0, 10.0 and 25.0 percent: a range of 20 points on a search that did
 * not change. A round at that size can only recognise a change that roughly doubles quality.
 *
 * At n=80 the resolved-row count rises from about 14 to about 68, which is what actually buys
 * precision, because the proportion that matters is measured against resolved rows.
 *
 * It is a parameter, not a constant, because the trade is real: 80 rows costs roughly 120
 * billable searches a round.
 */
export const DEFAULT_SAMPLE_SIZE = 80

export interface SpreadSample {
  rows: SampleRow[]
  /** Record positions actually drawn, so a reader can check the spread rather than trust it. */
  positions: number[]
  /** The population the sample was drawn from. */
  total: number
  /** Positions that returned nothing. Reported, because a silent short sample flatters a rate. */
  missed: number
}

/**
 * Distinct record positions spread across the reachable range.
 *
 * Uniform across the whole range rather than stratified. Stratifying would impose a shape on
 * a result set whose ordering the provider does not document and which is measurably
 * unstable, so the strata would mean nothing.
 */
export function spreadPositions(total: number, n: number, random: () => number = Math.random): number[] {
  const ceiling = Math.min(total, RECORD_CEILING)
  if (ceiling <= 0) return []
  if (ceiling <= n) return Array.from({ length: ceiling }, (_, i) => i + 1)
  const out = new Set<number>()
  // Bounded, because with n close to ceiling the birthday problem makes this slow and with a
  // pathological random source it would not terminate at all.
  for (let guard = 0; out.size < n && guard < n * 20; guard++) {
    out.add(1 + Math.floor(random() * ceiling))
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * Draw `size` rows from spread positions.
 *
 * Sequential rather than concurrent: the provider's limit is 600 requests an hour and this
 * shares it with sourcing, so the throttle is the point rather than an inconvenience.
 */
export async function drawSpreadSample(
  request: Record<string, unknown>,
  budget: ProviderBudget,
  size: number = DEFAULT_SAMPLE_SIZE,
  random: () => number = Math.random,
): Promise<SpreadSample> {
  const first = await countAndSample(request, budget, 1)
  const total = first.total
  const positions = spreadPositions(total, size, random)

  const rows: SampleRow[] = []
  let missed = 0
  for (const position of positions) {
    // per_page 1 with page = position means "the record at this position".
    const one = await countAndSample(request, budget, 1, position)
    if (one.rows.length === 0) { missed++; continue }
    rows.push(one.rows[0])
  }

  logger.info('tuner: spread sample drawn', {
    total,
    requested: size,
    positions_drawn: positions.length,
    rows_returned: rows.length,
    missed,
    spread_over: Math.min(total, RECORD_CEILING),
  })

  return { rows, positions, total, missed }
}
