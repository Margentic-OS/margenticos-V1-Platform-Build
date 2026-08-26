// Running one phase-2 research job: turn a batched synthesis into a finished research row.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A QUEUE JOB WHILE POLLING IS A CRON SWEEP
//
// Polling a batch is a free, idempotent lookup, so the queue would protect nothing. This
// is the opposite: three or more Anthropic calls per prospect (writer, floor, judge, plus
// retries), non-idempotent in the sense that each attempt bills again. That is exactly
// what ctx.paid() and the spend gate exist for.
//
// ── WHAT THE SPEND STAMP DOES AND DOES NOT COVER HERE ──
//
// It covers the writer and judge calls. It does NOT cover the batched synthesis, which
// was paid for hours earlier and is already stored on the entry row. That asymmetry is
// the whole benefit of the split: a phase-2 retry re-pays only for the cheap half, and
// the expensive half survives on the entry because raw_sources and response_message are
// still there.

import { logger } from '@/lib/logger'
import type { JobContext, JobHandler } from '../execute-job'
import { runProspectResearchCollect } from '@/lib/agents/prospect-research-collect-agent'

export function researchCollectHandler(): JobHandler {
  return async (ctx: JobContext): Promise<string> => {
    const { job } = ctx

    const result = await ctx.paid(
      'research.collect',
      () =>
        runProspectResearchCollect({
          prospect_id: job.prospect_id,
          client_id: job.organisation_id,
        }),
      collected =>
        collected.outcome === 'stored'
          ? {
              outcome: 'stored',
              research_result_id: collected.research_result_id,
              entry_id: collected.entry_id,
              qualification_status: collected.qualification_status,
              trigger_written: collected.trigger_written,
              // How often the messaging document moved under a batch. Reported here so
              // the rate is visible in spend_detail as well as in MON-021.
              doc_superseded: collected.doc_superseded,
            }
          : {
              outcome: 'stored_without_opening',
              research_result_id: collected.research_result_id,
              entry_id: collected.entry_id,
              // No writer or judge calls were made: the prospect became unmailable during
              // the wait. The saving is real and worth being able to count.
              skipped_reason: collected.reason,
            },
    )

    logger.info('research-collect-executor: collected', {
      job_id: job.id,
      prospect_id: job.prospect_id,
      organisation_id: job.organisation_id,
      outcome: result.outcome,
      research_result_id: result.research_result_id,
    })

    // A prospect held by the judge, disqualified, or skipped for being unmailable is a
    // SUCCESSFUL job. Its purpose is to reach a research verdict, and it did. Marking it
    // failed would inflate MON-018 and invite a retry of finished work.
    return result.outcome === 'stored'
      ? `research collect: ${result.qualification_status}` +
        `, ${result.trigger_written ? 'trigger written' : 'no trigger'}` +
        `${result.doc_superseded ? ', messaging doc superseded during the wait' : ''}`
      : `research collect: stored without an opening (${result.reason})`
  }
}
