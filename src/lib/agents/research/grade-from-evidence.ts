// Grade a prospect from the research evidence already on file.
//
// Nothing is fetched and nothing is written. It reads the prospect, reads the newest research
// record that holds evidence (evidence-record.ts), and asks the fit judge. It exists so a grade
// can be reached again without re-running research, which would buy every source again and,
// for a prospect already sent copy, replace or clear that copy.
//
// Recording the result is deliberately not done here. Whoever decides that a re-reached grade
// should replace a stored one does that explicitly; this function only reaches the grade.

import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildSynthesisRequest, synthesisFromMessage } from './synthesize'
import { loadEvidenceRecord } from './evidence-record'
import { readProspectContext } from './prospect-context'
import type { SynthesisOutput } from './types'

export interface EvidenceGrade {
  prospect_id:        string
  /** The research record the grade was reached from, or null when none holds evidence. */
  evidence_record_id: string | null
  evidence_from:      string | null
  synthesis:          SynthesisOutput | null
  /** Why no grade was attempted, when synthesis is null. */
  reason:             string | null
}

export async function gradeFromEvidence(args: {
  supabase:    SupabaseClient
  anthropic:   Pick<Anthropic, 'messages'>
  prospect_id: string
  client_id:   string
}): Promise<EvidenceGrade> {
  const { supabase, anthropic, prospect_id, client_id } = args

  // A plain read: readProspectContext never stamps a segment, so this path cannot write.
  const { ctx } = await readProspectContext(supabase, prospect_id, client_id)
  const evidence = await loadEvidenceRecord(supabase, prospect_id, client_id)
  if (!evidence) {
    return {
      prospect_id, evidence_record_id: null, evidence_from: null, synthesis: null,
      reason: 'No research record for this prospect holds any evidence.',
    }
  }

  const { params, clientCtx, detectedSignal } = await buildSynthesisRequest(ctx, evidence.raw, client_id)
  const response = await anthropic.messages.create(params)
  return {
    prospect_id,
    evidence_record_id: evidence.id,
    evidence_from:      evidence.created_at,
    synthesis:          synthesisFromMessage(response, ctx, clientCtx, detectedSignal),
    reason:             null,
  }
}
