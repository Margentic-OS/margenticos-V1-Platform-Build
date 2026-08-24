// Running one prospect research job.
//
// Research is genuinely per-prospect, unlike enrichment, so this is a plain handler
// wrapped by perJobExecutor. One job, one prospect, one row.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SPEND STAMP HERE IS COARSER THAN ENRICHMENT'S. READ THIS BEFORE TRUSTING IT.
//
// runProspectResearchAgentV2 makes paid calls in THREE distinct phases:
//
//   1. sources     two Apify actors, Apollo, the website fetch, and two Brave searches,
//                  all in parallel. Skipped entirely when stored findings are reused.
//   2. synthesis   one Anthropic call.
//   3. write+judge two more Anthropic calls.
//
// ctx.paid() can only wrap the WHOLE agent call, because the phases are internal to the
// agent and it reports no per-phase spend. So spend_recorded_at lands after all three
// phases, not after the first.
//
// WHAT THAT MEANS CONCRETELY. A crash between phase 1 and phase 3 leaves no stamp, so a
// retry re-runs the sources and pays for them again. That is a wider window than
// enrichment's, where the stamp lands immediately after the single Apollo call.
//
// WHY IT IS ACCEPTED RATHER THAN FIXED HERE:
//   - The cost is bounded and small. Apify is about $0.006 per prospect and the three
//     Anthropic calls about $0.02, so a wasted attempt is roughly $0.026. Research is
//     capped at maxAttempts 2, so the worst case is one wasted attempt per prospect.
//     Compare Apollo, where a re-spend buys the same contact record again at full price.
//   - Narrowing it means changing the agent to report spend per phase, which is a
//     rewrite of prospect-research-agent-v2 rather than a migration of it. C5's job is
//     to move research onto the queue, not to restructure it.
//   - use_stored_findings defaults to TRUE, so once a run has stored findings for a
//     prospect, later runs skip phase 1 entirely and the expensive half is not repeated.
//
// If this ever needs narrowing, the boundary to aim for is the Promise.all over the four
// sources in prospect-research-agent-v2.ts: that is where the first money leaves.
//
// Tracked in BACKLOG as a known limitation, with the same reasoning.

import { logger } from '@/lib/logger'
import type { JobContext, JobHandler } from '../execute-job'
import { runProspectResearchAgentV2 } from '@/lib/agents/prospect-research-agent-v2'

/**
 * Build the handler for one research job.
 *
 * use_stored_findings is not read from the job row, because job_queue carries no payload.
 * It defaults to TRUE, which is both the safe value and exactly what the operator route
 * sends: re-fetching every source for a prospect that already has usable findings is the
 * expensive half of a run and must be a deliberate choice, never a default.
 *
 * allow_overwrite_trigger has no equivalent here at all. The route cannot set it and
 * neither can the queue. A prospect whose copy is finished is excluded at enqueue time,
 * which is where runResearchBatchForOrg refuses it too.
 */
export function researchHandler(): JobHandler {
  return async (ctx: JobContext): Promise<string> => {
    const { job } = ctx

    const result = await ctx.paid(
      'research.full_run',
      () =>
        runProspectResearchAgentV2({
          prospect_id: job.prospect_id,
          // Agent isolation: the agent filters every query by this, and it comes from the
          // job row rather than from any ambient state.
          client_id: job.organisation_id,
          use_stored_findings: true,
        }),
      research => ({
        research_result_id: research.research_result_id,
        // Which sources actually cost money on this run. An empty list here alongside a
        // stored-findings reuse is the signal that phase 1 was skipped and the run was
        // cheap.
        sources_attempted: research.sources_attempted,
        sources_successful: research.sources_successful,
        has_dateable_signal: research.has_dateable_signal,
        qualification_status: research.qualification_status,
      }),
    )

    logger.info('research-executor: prospect researched', {
      job_id: job.id,
      prospect_id: job.prospect_id,
      organisation_id: job.organisation_id,
      research_result_id: result.research_result_id,
      qualification_status: result.qualification_status,
      has_dateable_signal: result.has_dateable_signal,
      sources_successful: result.sources_successful,
    })

    // A disqualified prospect, or one the judge held, is a SUCCESSFUL job. The job's
    // purpose is to reach a research verdict, and it did. Marking it failed would inflate
    // MON-018, invite a retry of finished work, and eventually terminate a prospect that
    // was correctly held. Same rule as a held enrichment verdict.
    return (
      `research: ${result.qualification_status}` +
      `, signal ${result.has_dateable_signal ? 'yes' : 'no'}` +
      `, sources ${result.sources_successful.length}/${result.sources_attempted.length}` +
      (result.trigger_text ? ', trigger written' : ', no trigger')
    )
  }
}
