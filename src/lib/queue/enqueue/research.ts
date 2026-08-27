// Putting prospects into the research queue.
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS MUST REFUSE EXACTLY WHAT runResearchBatchForOrg REFUSES
//
// While both paths exist behind the flag, a prospect must be eligible under ONE
// definition. If the queue selected a prospect the inline path would have refused,
// flipping the flag would change WHICH prospects get researched rather than only how,
// and the difference would be invisible until copy came back rewritten.
//
// The guards carried over from src/lib/operator/research-batch-entry.ts:
//
//   organisation exists and is not archived
//   suppressed = false                       opted out or disqualified; researching them
//                                            spends money on copy that can never be sent
//   scope 'unresearched'  current_research_result_id IS NULL
//   scope 'researched'    current_research_result_id IS NOT NULL
//   NO prospect already holds a personalisation_trigger
//   send-eligibility            added 2026-08-25, see below
//
// THE SEND-ELIGIBILITY GATE, added 2026-08-25 and applied to BOTH paths in the same commit
// precisely so the rule above keeps holding. Measured on the first real queue batch: 12 of
// 13 prospects had already been verified as unmailable BEFORE research ran, and research
// ran anyway. $2.56 spent, one mailable prospect bought. The policy lives in
// src/lib/sourcing/send-eligibility-policy.ts and nowhere else.
//
// It SKIPS rather than refusing, unlike the trigger guard. Different in kind: the trigger
// guard protects against a destructive write, this one protects against wasted spend.
//
// THE TRIGGER GUARD IS THE ONE THAT MATTERS AND THE ONE EASIEST TO WEAKEN.
// updateProspect writes personalisation_trigger on EVERY run, unconditionally:
//
//     personalisation_trigger: opening.written_won ? opening.opening : null
//
// So re-researching a prospect whose copy is finished either replaces it with new
// wording or, when the judge holds, sets it to NULL and destroys it outright. Of the 15
// researched prospects in the client-zero organisation on 2026-08-20, 12 held a trigger.
// Much of that copy has already shipped.
//
// The inline path refuses the WHOLE batch when any selected prospect has a trigger. This
// does the same rather than silently skipping them, because a partial enqueue would make
// the queue quietly research a different set than the operator asked for, and the whole
// point of the refusal is that regenerating shipped copy has to be asked for explicitly.
//
// There is deliberately NO allow_overwrite_trigger here. The route cannot pass it and
// neither can the queue. Only the CLI can, and the CLI stays on the inline path.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import {
  enqueueJobsForProspects,
  enqueueResearchPhaseJob,
  prospectsWithLiveResearchJob,
} from '../job-queue'
import {
  checkResearchEligibility,
  summariseIneligible,
  type IneligibleReason,
} from '@/lib/sourcing/send-eligibility-policy'

export type ResearchScope = 'unresearched' | 'researched'

/**
 * Which research path the enqueued jobs run down.
 *
 * ── PARAMETERISED, NOT COPIED, AND THAT IS THE WHOLE POINT ──
 *
 * The header above says these guards must refuse exactly what runResearchBatchForOrg
 * refuses, because a prospect has to be eligible under ONE definition or flipping a flag
 * changes WHICH prospects get researched rather than only how.
 *
 * The batch path makes that a three-way problem. Writing a second enqueue function for it
 * would have meant three copies of the trigger guard, the eligibility gate and the
 * batch-wait filter, each free to drift. So the guards stay in one function and only the
 * final insert differs.
 *
 * 'research'         one job: sources, synthesis, writer, judge. The proven path.
 * 'research_sources' phase 1 of the batch path. Its counterpart, research_collect, is
 *                    never enqueued from here: the batch sweep enqueues it when the
 *                    synthesis result arrives.
 */
export type ResearchEnqueueJobType = 'research' | 'research_sources'

export interface EnqueueResearchSuccess {
  ok: true
  /** Rows matching org + suppressed + scope, BEFORE the eligibility filter. */
  selected: number
  created: number
  alreadyQueued: number
  /** Filtered out as not worth researching. selected - skippedIneligible = jobs considered. */
  skippedIneligible: number
  /** Plain-English counts by reason, or null when nothing was skipped. */
  skippedBreakdown: string | null
  scope: ResearchScope
}

export async function enqueueResearchForOrganisation(
  supabase: SupabaseClient,
  organisationId: string,
  scope: ResearchScope,
  enqueuedBy: string,
  maxProspects = 5000,
  jobType: ResearchEnqueueJobType = 'research',
): Promise<EnqueueResearchSuccess | { ok: false; error: string }> {
  // ── Organisation must exist and be active ──────────────────────────────────
  const { data: org, error: orgError } = await supabase
    .from('organisations')
    .select('id')
    .eq('id', organisationId)
    .is('archived_at', null)
    .maybeSingle()

  if (orgError) {
    return { ok: false, error: `Could not read organisation: ${orgError.message}` }
  }
  if (!org) {
    return { ok: false, error: `Organisation not found or archived: ${organisationId}` }
  }

  // ── Select ─────────────────────────────────────────────────────────────────
  let query = supabase
    .from('prospects')
    // The three verification columns are RAW on purpose. See send-eligibility-policy.ts:
    // email_send_eligible is materialised at verification time and defaults to false, so it
    // can neither be re-policied without a re-verification run nor distinguish "verified
    // ineligible" from "never verified".
    // second_pass_* added 2026-08-25. WITHOUT THEM THE GATE IS BLIND TO THE PAID PASS:
    // checkResearchEligibility treats an absent second_pass_status as "not run", so a
    // catch-all that Bouncer resolved to deliverable would still be filtered out and the
    // money spent resolving it would buy nothing.
    .select('id, personalisation_trigger, independent_verified_at, independent_email_status, email_send_ineligible_reason, verification_provider, second_pass_status, second_pass_provider')
    .eq('organisation_id', organisationId)
    .eq('suppressed', false)
    .limit(maxProspects)

  query = scope === 'unresearched'
    ? query.is('current_research_result_id', null)
    : query.not('current_research_result_id', 'is', null)

  const { data, error } = await query
  if (error) {
    return { ok: false, error: `Could not select prospects to enqueue: ${error.message}` }
  }

  const rows = data ?? []

  if (rows.length === 0) {
    const what = scope === 'unresearched'
      ? 'Every prospect in this organisation has already been researched.'
      : 'No prospect in this organisation has been researched yet, so there is nothing to re-run.'
    return { ok: false, error: `Nothing to research. ${what}` }
  }

  // ── GUARD: never silently rewrite an opening that already exists ───────────
  const withTrigger = rows.filter(r => r.personalisation_trigger != null)
  if (withTrigger.length > 0) {
    return {
      ok: false,
      error:
        `Refused: ${withTrigger.length} of ${rows.length} selected prospects already have a ` +
        'personalisation trigger, and researching them again overwrites it with new wording, or ' +
        'clears it entirely if the judge holds. Re-running finished copy has to be asked for ' +
        'explicitly. It is not available from the dashboard. Use the CLI with ' +
        '--allow-overwrite-trigger if that is genuinely what you want.',
    }
  }

  // ── GATE: do not pay for research on a prospect we already know we cannot email ──
  //
  // SKIPS rather than refusing the whole batch, unlike the trigger guard above. The two
  // are different in kind. The trigger guard refuses because overwriting shipped copy is
  // DESTRUCTIVE and has to be asked for explicitly. This is a spend FILTER: an operator
  // who asks to research an organisation wants its mailable prospects researched, and
  // refusing the batch because one address is a catch-all would be obstructive.
  //
  // It must not be silent, though, or it becomes the next invisible behaviour. Counts by
  // reason go into the result and the log, and a batch that filters down to nothing
  // returns an error naming why rather than a bare "nothing to do".
  const eligible: string[] = []
  const skippedReasons: IneligibleReason[] = []
  for (const row of rows) {
    const verdict = checkResearchEligibility({
      independent_verified_at:      (row.independent_verified_at as string | null) ?? null,
      independent_email_status:     (row.independent_email_status as string | null) ?? null,
      email_send_ineligible_reason: (row.email_send_ineligible_reason as string | null) ?? null,
      verification_provider:        (row.verification_provider as string | null) ?? null,
      second_pass_status:           (row.second_pass_status as string | null) ?? null,
      second_pass_provider:         (row.second_pass_provider as string | null) ?? null,
    })
    if (verdict.eligible) eligible.push(row.id as string)
    else skippedReasons.push(verdict.reason)
  }

  if (eligible.length === 0) {
    return {
      ok: false,
      error:
        `Nothing to research. All ${rows.length} prospects were filtered out as not worth ` +
        `researching: ${summariseIneligible(skippedReasons)}. Research costs roughly 60 times ` +
        'what composition costs per prospect, so it does not run on addresses we already know ' +
        'we cannot email. Verify the prospects, or revisit the catch-all policy in ' +
        'src/lib/sourcing/send-eligibility-policy.ts.',
    }
  }

  // ── GATE: a prospect mid-way through a BATCH run is not available to this path ──
  //
  // Added 2026-08-26 with the batch split, and it is a spend guard, not tidiness.
  //
  // The batch path runs research as two jobs with up to 24 hours between them, and the
  // research row is deliberately not written until the second one finishes. So during
  // that wait the prospect still reads as current_research_result_id IS NULL and the
  // 'unresearched' scope above selects it. Enqueuing an ordinary research job for it
  // would re-fetch Apify, Apollo, the website and Brave for sources that are already
  // bought and already stored on the synthesis_batch_entries row. That is the shape of
  // the 10 August 2026 incident: 141 credits for 29 prospects.
  //
  // job_queue_one_live_research_per_prospect makes it impossible at the database level,
  // and would raise 23505 out of enqueue_job and abort this loop part-way through. This
  // filter exists so the operator gets a sentence naming the reason instead. The index
  // stays the guarantee; a race that slips past this still hits it.
  //
  // SKIPS rather than refusing the whole batch, matching the eligibility gate above and
  // not the trigger guard: nothing destructive happens, the work is simply already in
  // progress somewhere else.
  const liveElsewhere = await prospectsWithLiveResearchJob(supabase, organisationId, eligible)
  const enqueueable = eligible.filter(id => !liveElsewhere.has(id))

  if (enqueueable.length === 0) {
    return {
      ok: false,
      error:
        `Nothing to research. All ${eligible.length} eligible prospects already have a ` +
        'research job in progress, which for the batch path can mean waiting on an ' +
        'Anthropic batch for up to 24 hours. Their sources are already paid for and ' +
        'stored, so re-running them now would buy the same data twice. Wait for the ' +
        'batch to collect.',
    }
  }

  // ── THE ONE PLACE THE TWO PATHS DIFFER ───────────────────────────────────
  //
  // The batch phases cannot use enqueue_job. Its ON CONFLICT names only
  // (job_type, prospect_id), and the protection they need spans job types, so a violation
  // of job_queue_one_live_research_per_prospect raises out of enqueue_job and would abort
  // this loop part-way. enqueue_research_phase catches unique_violation and returns zero
  // rows, which is the same contract. See 20260826130000_research_batch_job_types.sql.
  const { created, alreadyQueued } = jobType === 'research'
    ? await enqueueJobsForProspects(supabase, {
        jobType: 'research',
        organisationId,
        prospectIds: enqueueable,
        enqueuedBy,
      })
    : await enqueueBatchPhaseJobs(supabase, organisationId, enqueueable, enqueuedBy)

  logger.info('enqueue-research: complete', {
    organisation_id: organisationId,
    job_type: jobType,
    scope,
    selected: rows.length,
    eligible: eligible.length,
    skipped_ineligible: skippedReasons.length,
    skipped_breakdown: skippedReasons.length > 0 ? summariseIneligible(skippedReasons) : null,
    // Not the same as already_queued below. That one counts this job type's own
    // duplicates; this counts prospects held by ANOTHER research job type, which during
    // a batch rollout is the interesting number.
    skipped_live_elsewhere: liveElsewhere.size,
    created: created.length,
    already_queued: alreadyQueued.length,
  })

  return {
    ok: true,
    selected: rows.length,
    created: created.length,
    alreadyQueued: alreadyQueued.length,
    skippedIneligible: skippedReasons.length,
    skippedBreakdown: skippedReasons.length > 0 ? summariseIneligible(skippedReasons) : null,
    scope,
  }
}

/**
 * The batch path's insert, shaped to match enqueueJobsForProspects' return so the caller
 * above does not branch twice.
 */
async function enqueueBatchPhaseJobs(
  supabase: SupabaseClient,
  organisationId: string,
  prospectIds: string[],
  enqueuedBy: string,
): Promise<{ created: unknown[]; alreadyQueued: string[] }> {
  const created: unknown[] = []
  const alreadyQueued: string[] = []

  for (const prospectId of prospectIds) {
    const row = await enqueueResearchPhaseJob(supabase, {
      jobType: 'research_sources',
      organisationId,
      prospectId,
      enqueuedBy,
    })
    if (row) created.push(row)
    else alreadyQueued.push(prospectId)
  }

  logger.info('enqueue-research: batch phase 1 enqueued', {
    organisation_id: organisationId,
    requested: prospectIds.length,
    created: created.length,
    already_queued: alreadyQueued.length,
  })

  return { created, alreadyQueued }
}
