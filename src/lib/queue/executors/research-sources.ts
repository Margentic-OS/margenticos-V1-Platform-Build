// Running one phase-1 research job: fetch the four sources and snapshot them.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SPEND STAMP HERE IS TIGHTER THAN THE SINGLE-JOB PATH'S, AND THAT IS THE POINT
//
// The 'research' executor wraps the WHOLE agent, so spend_recorded_at lands only after
// sources, synthesis, writer and judge have all finished. A crash between the sources and
// the judge leaves no stamp, and the retry re-buys the sources. Its own header calls that
// out as a known, accepted limitation and names the boundary to aim for: "the Promise.all
// over the four sources in prospect-research-agent-v2.ts, that is where the first money
// leaves."
//
// The split moved that boundary. This job ENDS just after the sources return and the
// snapshot is written, so ctx.paid() stamps within seconds of the money leaving rather
// than minutes. Everything expensive that used to sit inside the unprotected window
// (three-plus Anthropic calls) is now in a different job with its own stamp.
//
// A crash between the source calls returning and the snapshot INSERT is still unprotected,
// and the agent throws a named error saying exactly that rather than swallowing it. That
// window is a few milliseconds of database write against tens of seconds of HTTP.

import { logger } from '@/lib/logger'
import type { JobContext, JobHandler } from '../execute-job'
import { runProspectResearchSources } from '@/lib/agents/prospect-research-sources-agent'

export function researchSourcesHandler(): JobHandler {
  return async (ctx: JobContext): Promise<string> => {
    const { job } = ctx

    const result = await ctx.paid(
      'research.sources',
      () =>
        runProspectResearchSources({
          prospect_id: job.prospect_id,
          // Agent isolation: every query in the agent filters by this, and it comes from
          // the job row rather than from any ambient state.
          client_id: job.organisation_id,
          use_stored_findings: true,
        }),
      research =>
        research.outcome === 'completed_from_stored'
          ? {
              // A reuse run makes NO source calls and NO synthesis call, so it never
              // reaches a batch. Recorded distinctly because an empty source list next to
              // a normal run is the signal that phase 1 was skipped and the run was cheap.
              outcome: 'completed_from_stored',
              research_result_id: research.research_result_id,
              sources_attempted: [],
            }
          : {
              outcome: 'queued_for_batch',
              entry_id: research.entry_id,
              sources_successful: research.sources_successful,
            },
    )

    if (result.outcome === 'completed_from_stored') {
      logger.info('research-sources-executor: stored findings reused, no batch needed', {
        job_id: job.id,
        prospect_id: job.prospect_id,
        research_result_id: result.research_result_id,
      })
      return `research sources: stored findings reused, no batch, result ${result.research_result_id}`
    }

    logger.info('research-sources-executor: snapshotted for batch', {
      job_id: job.id,
      prospect_id: job.prospect_id,
      organisation_id: job.organisation_id,
      entry_id: result.entry_id,
      sources_successful: result.sources_successful,
    })

    return (
      `research sources: ${result.sources_successful.length} succeeded, ` +
      `entry ${result.entry_id} awaiting batch submission`
    )
  }
}
