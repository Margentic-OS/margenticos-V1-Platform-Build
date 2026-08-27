// Writing the opening for the email it will land in, then judging the finished artifact.
//
// EXTRACTED, NOT REWRITTEN. Moved out of runProspectResearchAgentV2 on 2026-08-26 so
// phase 2 of the batch path produces openings with the SAME code rather than a copy.
//
// This is the block that decides what a prospect actually receives, so a second copy
// drifting would not show up as an error. It would show up as different copy, and only
// for prospects that happened to go down the other path.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  composeEmail1WithOpening,
  getVariantEmail1Frame,
} from '@/lib/composition/compose-sequence'
import { assignVariantDeterministically } from '@/lib/composition/variant-assignment'
import { writeAndJudgeOpening, type OpeningResult } from './write-opening'
import type { BatchUniquenessRegistry } from '@/lib/agents/research/batch-uniqueness'
import type { ProspectContext, ObservationCandidate } from './types'

/**
 * The messaging document content the opening is written against.
 *
 * Typed as the composition layer's shape via the functions that consume it, and passed
 * IN rather than fetched here, because the two callers get it from different places and
 * that difference is the whole point of the batch split:
 *
 *   the inline agent  fetches the currently approved document, moments before writing
 *   phase 2           reads the SNAPSHOT taken by phase 1, up to 24 hours earlier
 *
 * Phase 2 must not re-fetch. If the document was revised during the batch wait, the
 * writer would be scoped to different copy than phase 1 planned for, and nothing would
 * fail: the email would simply be different. That is precisely why compose was never
 * migrated to the queue.
 */
export type MessagingContent = Parameters<typeof getVariantEmail1Frame>[0]

export interface ProduceOpeningInput {
  apiKey: string
  clientName: string
  ctx: ProspectContext
  candidates: ObservationCandidate[]
  messagingContent: MessagingContent
  variantId: string
  /** Batch-scoped. Absent on a single-prospect run, where there is nothing to collide with. */
  uniqueness?: BatchUniquenessRegistry
}

/**
 * Resolve which variant this prospect's opening is written for.
 *
 * Read from the prospect row when composition has already assigned one, otherwise
 * resolved with the same deterministic hash composition uses, so the writer targets the
 * variant that will actually ship. Nothing is written back: assignment stays
 * composition's job.
 */
export function resolveVariantId(
  prospectId: string,
  assignedVariantId: string | null,
  messagingContent: MessagingContent,
): string {
  const availableVariants = messagingContent.variants
    ? Object.keys(messagingContent.variants).sort()
    : ['A', 'B', 'C', 'D']
  return assignedVariantId ?? assignVariantDeterministically(prospectId, availableVariants)
}

/** Read the organisation's name, used as the client name the writer is briefed with. */
export async function loadClientName(
  supabase: SupabaseClient,
  client_id: string,
): Promise<string> {
  const { data: org } = await supabase
    .from('organisations').select('name').eq('id', client_id).single()
  return (org?.name as string | null) ?? 'the client'
}

export async function produceOpening({
  apiKey,
  clientName,
  ctx,
  candidates,
  messagingContent,
  variantId,
  uniqueness,
}: ProduceOpeningInput): Promise<OpeningResult> {
  const frame = getVariantEmail1Frame(messagingContent, variantId)

  return writeAndJudgeOpening({
    apiKey,
    clientName,
    prospectFirstName: ctx.first_name,
    candidates,
    p3: frame.p3,
    cta: frame.cta,
    // The version the written opening has to beat: the variant's own approved opener.
    templateOpening: frame.authoredOpening,
    // The judge must read the real artifact, so this calls the exact production path.
    // first_name resolved so the judge reads exactly what the prospect receives.
    // question omitted keeps the variant's approved CTA, which is how the template side
    // of the comparison stays a complete, genuinely sendable email.
    composeEmail1: (text: string, question?: string | null) =>
      composeEmail1WithOpening(messagingContent, variantId, text, question ?? null, ctx.first_name).body,
    prospectId: ctx.id,
    uniqueness,
  })
}
