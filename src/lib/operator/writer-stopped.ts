// The prospects shipping the approved opening because the writer was stopped, for the
// operator's client page. READ-ONLY.
//
// WHY THIS EXISTS. When synthesis finds no usable candidate the writer does not run and the
// approved template ships. Decided 2026-09-11: no usable candidate means no hook, not a wrong
// buyer, and the template is a legitimate email to send to a good-fit prospect. Without this
// list the decision is silent: a stopped prospect looks exactly like one whose written
// opening lost to the template.
//
// KEYED ON A CODE, NOT ON PROSE. produceOpening sets not_written_reason on its result and
// updateProspect stores the whole result in prospects.trigger_data.judge, so the filter reads
// trigger_data->judge->>not_written_reason. Rewording judge_reasoning cannot hide a prospect.
//
// ONLY THE LATEST RESEARCH RUN COUNTS, because every run overwrites trigger_data. A prospect
// stopped once and written on a later run is not listed, which is correct: the written
// opening is what ships.

import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import type { NotWrittenReason } from '@/lib/agents/research/write-opening'

export const WRITER_STOPPED_CODE: NotWrittenReason = 'no_usable_candidate'

export interface WriterStoppedProspect {
  id: string
  name: string
  company_name: string | null
  job_title: string | null
  research_ran_at: string | null
  /** Synthesis's own relevance note from that run. Its words, shown as its words. */
  synthesis_note: string | null
}

export async function listWriterStoppedProspects(
  serviceRole: ServiceRoleClient,
  organisationId: string,
  limit = 200,
): Promise<{ ok: true; prospects: WriterStoppedProspect[] } | { ok: false; error: string }> {
  const { data, error } = await serviceRole
    .from('prospects')
    .select('id, first_name, last_name, company_name, job_title, research_ran_at, synthesis_note:trigger_data->>relevance_reason')
    .eq('organisation_id', organisationId)
    .filter('trigger_data->judge->>not_written_reason', 'eq', WRITER_STOPPED_CODE)
    .order('research_ran_at', { ascending: false })
    .limit(limit)

  if (error) return { ok: false, error: error.message }

  return {
    ok: true,
    prospects: (data ?? []).map(p => ({
      id: p.id,
      name: [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Unnamed prospect',
      company_name: p.company_name ?? null,
      job_title: p.job_title ?? null,
      research_ran_at: p.research_ran_at ?? null,
      synthesis_note: typeof p.synthesis_note === 'string' ? p.synthesis_note : null,
    })),
  }
}
