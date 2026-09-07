// Write down that a client's dashboard failed, so a person is not the only thing that noticed.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE GAP THIS FILLS, STATED PLAINLY
//
// A client's home screen could fail and leave no trace anywhere. Measured 2026-09-07:
//
//   Vercel   a render that dies mid-stream is already an HTTP 200, so it is logged as a
//            success. Runtime log LINES are retained for one hour on the current plan, so
//            an incident reported an hour later has no evidence left to read.
//   Sentry   correctly wired, but it only fires if an error boundary actually rendered or
//            the server threw. A read that quietly returned null does neither.
//   Monitors all 31 of MON-001..MON-031 are SQL views over database state. Not one makes
//            an HTTP call. A failed render writes no row, so no monitor could see it.
//
// The fix is to make the failure write a row, because a row is the one thing every monitor
// can already see. This is the writer. mon_032 is the reader.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS FUNCTION MUST NEVER THROW, AND THAT IS NOT DEFENSIVE PADDING
//
// It is called from inside failure handling. If it threw, it would convert a degraded card
// into the whole-page failure it exists to report, and it would do so precisely when the
// database is already unwell. A recorder that can take down the thing it is recording is
// worse than no recorder. So every path returns, and the fallback is a log line.

import { logger } from '@/lib/logger'
import { createServiceRoleClient } from '@/lib/supabase/service-role'

export type DashboardFailureKind = 'read' | 'render'

export interface DashboardFailure {
  kind: DashboardFailureKind
  /** Which code noticed. Stable identifier, not a message. */
  source: string
  /** The path the user was on. */
  route: string
  organisationId?: string | null
  /** Whatever the error said. Truncated on write; the column is not a log. */
  detail?: string | null
  /** Next.js error digest, when a render failure carries one. */
  digest?: string | null
}

const DETAIL_MAX = 1000

export async function recordDashboardFailure(failure: DashboardFailure): Promise<void> {
  try {
    const supabase = await createServiceRoleClient()
    const { error } = await supabase.from('dashboard_failures').insert({
      kind: failure.kind,
      source: failure.source,
      route: failure.route,
      organisation_id: failure.organisationId ?? null,
      detail: failure.detail ? failure.detail.slice(0, DETAIL_MAX) : null,
      digest: failure.digest ?? null,
    })

    if (error) {
      // The recorder itself failed. Say so at error level: this is the case where the
      // monitor goes quiet for a reason that is not "nothing is wrong".
      logger.error('dashboard failure could not be recorded', {
        source: failure.source,
        route: failure.route,
        recorderError: error.message,
      })
    }
  } catch (err) {
    logger.error('dashboard failure recorder threw', {
      source: failure.source,
      route: failure.route,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
