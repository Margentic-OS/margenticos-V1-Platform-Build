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
import { enqueueJobsForProspects } from '../job-queue'

export type ResearchScope = 'unresearched' | 'researched'

export interface EnqueueResearchSuccess {
  ok: true
  selected: number
  created: number
  alreadyQueued: number
  scope: ResearchScope
}

export async function enqueueResearchForOrganisation(
  supabase: SupabaseClient,
  organisationId: string,
  scope: ResearchScope,
  enqueuedBy: string,
  maxProspects = 5000,
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
    .select('id, personalisation_trigger')
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

  const { created, alreadyQueued } = await enqueueJobsForProspects(supabase, {
    jobType: 'research',
    organisationId,
    prospectIds: rows.map(r => r.id as string),
    enqueuedBy,
  })

  logger.info('enqueue-research: complete', {
    organisation_id: organisationId,
    scope,
    selected: rows.length,
    created: created.length,
    already_queued: alreadyQueued.length,
  })

  return {
    ok: true,
    selected: rows.length,
    created: created.length,
    alreadyQueued: alreadyQueued.length,
    scope,
  }
}
