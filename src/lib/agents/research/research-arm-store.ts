// WHERE A PROSPECT'S RESEARCH ARM IS STORED, ASSIGNED, READ AND RELEASED.
//
// ═══ THE RULES THIS FILE ENFORCES ════════════════════════════════════════════
//
//   STORED ONCE. prospects.research_arm is written only while it is NULL (a conditional update).
//   A retry, a resubmitted batch or a second enqueue reads the stored value and never redraws it.
//
//   ASSIGNED BEFORE RESEARCH, ON THE BATCH PATH ONLY. assignResearchArms runs when a prospect is
//   enqueued for the batch route. The inline path never assigns a short arm; it settles a prospect
//   to 'standard' if nothing is stored, and otherwise runs the stored arm.
//
//   A PROSPECT WITH PRIOR RESEARCH IS 'standard'. Its stored findings were produced before the split,
//   or are reused, and a reuse run makes no synthesis call. Recording an arm it did not run would be
//   a false record, so the arm is set to standard, which is what its findings are.
//
//   THE SWITCH OFF MEANS STANDARD FOR EVERYONE. organisations.research_arm_split_enabled defaults to
//   false. A switch that cannot be read is treated as off. The batch then runs on the standard arm
//   alone, which is decision 4: the split must never delay or block research.
//
//   RELEASE IS BY BATCH, AND COVERS FAILURES. releaseShortReasoningBatch releases every prospect
//   that was in the batch, whether its research succeeded or not. A prospect whose research failed
//   ships as a template, where the arm does not apply, so releasing it changes nothing it would send.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { armOf, balancedArmPlan, drawResearchArm, type ResearchArm } from './research-arm'

/** PostgREST `in` lists are kept small so one read cannot be truncated by the API's row ceiling. */
const CHUNK = 100

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * The arm stored for one prospect, read for this organisation only. A NULL is standard: research
 * before the split existed was standard. Throws on a failed read, because a guessed arm is a false
 * record.
 */
export async function readStoredArm(
  supabase: SupabaseClient,
  organisationId: string,
  prospectId: string,
): Promise<ResearchArm> {
  const { data, error } = await supabase
    .from('prospects')
    .select('research_arm')
    .eq('id', prospectId)
    .eq('organisation_id', organisationId)
    .maybeSingle()
  if (error) throw new Error(`research-arm: could not read the stored arm for prospect ${prospectId}: ${error.message}`)
  if (!data) throw new Error(`research-arm: prospect ${prospectId} is not in organisation ${organisationId}`)
  return armOf(data.research_arm as string | null)
}

/**
 * The inline path's arm. A prospect with nothing stored is settled to 'standard', conditionally,
 * so an inline run cannot overwrite an assignment made concurrently. Returns what is now stored.
 */
export async function settleInlineArm(
  supabase: SupabaseClient,
  organisationId: string,
  prospectId: string,
): Promise<ResearchArm> {
  const current = await readStoredArm(supabase, organisationId, prospectId)
  const { data: row, error: rowError } = await supabase
    .from('prospects')
    .select('research_arm')
    .eq('id', prospectId)
    .eq('organisation_id', organisationId)
    .maybeSingle()
  if (rowError) throw new Error(`research-arm: could not re-read the arm for prospect ${prospectId}: ${rowError.message}`)
  if (row?.research_arm != null) return current

  const { error } = await supabase
    .from('prospects')
    .update({ research_arm: 'standard' })
    .eq('id', prospectId)
    .eq('organisation_id', organisationId)
    .is('research_arm', null)
  if (error) throw new Error(`research-arm: could not settle the arm for prospect ${prospectId}: ${error.message}`)
  return readStoredArm(supabase, organisationId, prospectId)
}

/**
 * Which of these prospects already have a research row of any age. Such a prospect's findings
 * predate the split, or may be reused, so it is never given the short arm.
 *
 * Fails CLOSED: a failed read returns null, and the caller assigns standard to everyone. Recording
 * the wrong arm is worse than not testing a prospect.
 */
async function prospectsWithPriorResearch(
  supabase: SupabaseClient,
  organisationId: string,
  prospectIds: string[],
): Promise<Set<string> | null> {
  const found = new Set<string>()
  for (const part of chunks(prospectIds)) {
    const { data, error } = await supabase
      .from('prospect_research_results')
      .select('prospect_id')
      .eq('organisation_id', organisationId)
      .in('prospect_id', part)
    if (error) {
      logger.warn('research-arm: could not read prior research; assigning standard', { organisation_id: organisationId, error: error.message })
      return null
    }
    for (const row of data ?? []) found.add(row.prospect_id as string)
  }
  return found
}

/** Whether the organisation's split is switched on. A failed read is OFF, which is the safe reading. */
async function splitEnabled(supabase: SupabaseClient, organisationId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('organisations')
    .select('research_arm_split_enabled')
    .eq('id', organisationId)
    .maybeSingle()
  if (error) {
    logger.warn('research-arm: could not read the split switch; running standard for everyone', { organisation_id: organisationId, error: error.message })
    return false
  }
  return data?.research_arm_split_enabled === true
}

/**
 * Write arms for prospects that have none. Conditional on NULL, so an arm already stored is never
 * overwritten. Returns how many prospects were actually written. Throws on a failed write.
 */
export async function writeArmsIfUnset(
  supabase: SupabaseClient,
  organisationId: string,
  assignments: Map<string, ResearchArm>,
): Promise<number> {
  const byArm: Record<ResearchArm, string[]> = { standard: [], short_reasoning: [] }
  for (const [id, arm] of assignments) byArm[arm].push(id)
  let written = 0
  for (const arm of ['standard', 'short_reasoning'] as const) {
    for (const part of chunks(byArm[arm])) {
      const { data, error } = await supabase
        .from('prospects')
        .update({ research_arm: arm })
        .eq('organisation_id', organisationId)
        .in('id', part)
        .is('research_arm', null)
        .select('id')
      if (error) throw new Error(`research-arm: could not store ${arm} arms: ${error.message}`)
      written += (data ?? []).length
    }
  }
  return written
}

export interface ArmAssignmentCounts {
  /** Prospects that already had an arm. Left exactly as they were. */
  kept: number
  /** Prospects given an arm by this call. */
  assigned: { standard: number; short_reasoning: number }
}

/**
 * Assign an arm to every prospect in the set that has none, before it is researched on the batch
 * route. The decision order, per prospect:
 *   already stored             keep it
 *   switch off, or unreadable  standard
 *   prior research of any age  standard
 *   otherwise                  a fair coin
 */
export async function assignResearchArms(
  supabase: SupabaseClient,
  organisationId: string,
  prospectIds: string[],
  random: () => number = Math.random,
): Promise<ArmAssignmentCounts> {
  const counts: ArmAssignmentCounts = { kept: 0, assigned: { standard: 0, short_reasoning: 0 } }
  if (prospectIds.length === 0) return counts

  const unset: string[] = []
  for (const part of chunks(prospectIds)) {
    const { data, error } = await supabase
      .from('prospects')
      .select('id, research_arm')
      .eq('organisation_id', organisationId)
      .in('id', part)
    if (error) throw new Error(`research-arm: could not read arms before research: ${error.message}`)
    for (const row of data ?? []) {
      if (row.research_arm == null) unset.push(row.id as string)
      else counts.kept += 1
    }
  }
  if (unset.length === 0) return counts

  // Both guards are read independently. The switch decides whether a coin is drawn at all; prior
  // research decides whether a drawn prospect may keep the coin. Reading prior research even with the
  // switch off keeps the two from shadowing each other.
  const on = await splitEnabled(supabase, organisationId)
  const prior = await prospectsWithPriorResearch(supabase, organisationId, unset)

  const assignments = new Map<string, ResearchArm>()
  for (const id of unset) {
    const arm: ResearchArm = !on || prior === null || prior.has(id)
      ? 'standard'
      : drawResearchArm(random)
    assignments.set(id, arm)
  }

  await writeArmsIfUnset(supabase, organisationId, assignments)
  for (const arm of assignments.values()) counts.assigned[arm] += 1
  logger.info('research-arm: assigned', {
    organisation_id: organisationId,
    split_enabled: on,
    kept: counts.kept,
    standard: counts.assigned.standard,
    short_reasoning: counts.assigned.short_reasoning,
  })
  return counts
}

/**
 * Store an explicit, balanced plan for a fixed set of prospects. The dry run's only entry point:
 * the org switch is NOT consulted, because the dry run is an operator asking for both arms on six
 * named prospects. Conditional on NULL like everything else, so a prospect already assigned keeps
 * its arm and the dry run reports that rather than overwriting it.
 */
export async function storeBalancedPlan(
  supabase: SupabaseClient,
  organisationId: string,
  prospectIds: string[],
  random: () => number = Math.random,
): Promise<Map<string, ResearchArm>> {
  const plan = balancedArmPlan(prospectIds, random)
  await writeArmsIfUnset(supabase, organisationId, plan)
  return plan
}

/**
 * Release the held short_reasoning prospects of one Anthropic batch, by the operator's approval.
 * Sets research_arm_released_at once; a prospect already released is left alone.
 *
 * Refuses a batch that belongs to another organisation. Works from synthesis_batch_entries rather
 * than from research rows, so a prospect whose research FAILED in the batch is released too. It
 * ships as a template, which the arm does not change.
 */
export async function releaseShortReasoningBatch(
  supabase: SupabaseClient,
  organisationId: string,
  synthesisBatchId: string,
): Promise<{ prospectsInBatch: number; released: number }> {
  const { data: batch, error: batchError } = await supabase
    .from('synthesis_batches')
    .select('id')
    .eq('id', synthesisBatchId)
    .eq('organisation_id', organisationId)
    .maybeSingle()
  if (batchError) throw new Error(`research-arm: could not read batch ${synthesisBatchId}: ${batchError.message}`)
  if (!batch) throw new Error(`research-arm: batch ${synthesisBatchId} is not an organisation ${organisationId} batch`)

  const { data: entries, error: entriesError } = await supabase
    .from('synthesis_batch_entries')
    .select('prospect_id')
    .eq('organisation_id', organisationId)
    .eq('batch_id', synthesisBatchId)
  if (entriesError) throw new Error(`research-arm: could not read the batch's prospects: ${entriesError.message}`)
  const prospectIds = [...new Set((entries ?? []).map(e => e.prospect_id as string))]

  let released = 0
  for (const part of chunks(prospectIds)) {
    const { data, error } = await supabase
      .from('prospects')
      .update({ research_arm_released_at: new Date().toISOString() })
      .eq('organisation_id', organisationId)
      .eq('research_arm', 'short_reasoning')
      .is('research_arm_released_at', null)
      .in('id', part)
      .select('id')
    if (error) throw new Error(`research-arm: could not release prospects: ${error.message}`)
    released += (data ?? []).length
  }
  return { prospectsInBatch: prospectIds.length, released }
}
