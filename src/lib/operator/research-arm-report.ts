// THE COMPARISON BEHIND THE APPROVAL, PER ARM.
//
// Doug approves the short_reasoning arm for a batch after comparing both arms on that batch:
// personalised share, tier split, fit-grade distribution and cost. This module makes that
// comparison. It reads, and writes nothing.
//
// Definitions, fixed here so the report and the decision cannot describe different things:
//   researches      research rows stored with this arm (a prospect re-researched counts twice)
//   personalised    signal_relevance = 'use_as_hook': the Email 1 opened on the research
//   tier split      prospects.sourced_tier at report time, as a count per tier
//   fit grades      research_rows.icp_fit, as a count per grade
//   cost            research_usage rows priced at the rates the ledger was billed at (batch
//                   synthesis at half). A row that cannot be priced is counted, not guessed.
//   cost per 100    usd / costed researches x 100
//   cost per personalised email   usd / personalised researches
//
// The arms are shown labelled here, because this is the operator's report. Doug's sample read is a
// separate, unlabelled thing and is not built by this module.

import type { SupabaseClient } from '@supabase/supabase-js'
import { RESEARCH_ARMS, armOf, type ResearchArm } from '@/lib/agents/research/research-arm'
import { researchUsageRowUsd, type ResearchUsageRow } from './run-spend'

export interface ArmReportRow {
  research_arm: ResearchArm
  signal_relevance: string | null
  icp_fit: string | null
  sourced_tier: string | null
  /** The priced cost of this research row, or null when the ledger row cannot be priced. */
  usd: number | null
}

export interface ArmReportLine {
  arm: ResearchArm
  researches: number
  personalised: number
  /** personalised / researches, or null when there are no researches. */
  personalisedShare: number | null
  tiers: Record<string, number>
  fitGrades: Record<string, number>
  costed: number
  unpriced: number
  usd: number
  /** usd / costed researches. Null when nothing was costed. */
  usdPerResearch: number | null
  /** usd / costed researches x 100. Null when nothing was costed. */
  usdPer100: number | null
  /** usd / personalised researches. Null when nothing was personalised. */
  usdPerPersonalised: number | null
}

export type ArmReport = Record<ResearchArm, ArmReportLine>

function emptyLine(arm: ResearchArm): ArmReportLine {
  return {
    arm,
    researches: 0,
    personalised: 0,
    personalisedShare: null,
    tiers: {},
    fitGrades: {},
    costed: 0,
    unpriced: 0,
    usd: 0,
    usdPerResearch: null,
    usdPer100: null,
    usdPerPersonalised: null,
  }
}

/** Pure: the comparison for both arms, from already-read rows. */
export function buildArmReport(rows: ArmReportRow[]): ArmReport {
  const report = {
    standard: emptyLine('standard'),
    short_reasoning: emptyLine('short_reasoning'),
  } as ArmReport

  for (const row of rows) {
    const line = report[armOf(row.research_arm)]
    line.researches += 1
    if (row.signal_relevance === 'use_as_hook') line.personalised += 1
    const tier = row.sourced_tier ?? 'untiered'
    line.tiers[tier] = (line.tiers[tier] ?? 0) + 1
    const fit = row.icp_fit ?? 'none'
    line.fitGrades[fit] = (line.fitGrades[fit] ?? 0) + 1
    if (row.usd === null) line.unpriced += 1
    else {
      line.costed += 1
      line.usd += row.usd
    }
  }

  for (const arm of RESEARCH_ARMS) {
    const line = report[arm]
    line.personalisedShare = line.researches > 0 ? line.personalised / line.researches : null
    line.usdPerResearch = line.costed > 0 ? line.usd / line.costed : null
    line.usdPer100 = line.usdPerResearch === null ? null : line.usdPerResearch * 100
    line.usdPerPersonalised = line.personalised > 0 ? line.usd / line.personalised : null
  }
  return report
}

const PAGE = 1000
const CHUNK = 100

/**
 * Read the report's rows for one organisation, optionally for one Anthropic batch. Pages through
 * every row; a short page is the end, never a guess.
 */
export async function loadArmReport(
  supabase: SupabaseClient,
  organisationId: string,
  synthesisBatchId?: string,
): Promise<{ report: ArmReport; heldShortReasoning: number }> {
  const results: Array<{ id: string; prospect_id: string; research_arm: string; signal_relevance: string | null; icp_fit: string | null }> = []
  for (let from = 0; ; from += PAGE) {
    let query = supabase
      .from('prospect_research_results')
      .select('id, prospect_id, research_arm, signal_relevance, icp_fit')
      .eq('organisation_id', organisationId)
      .not('research_arm', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (synthesisBatchId) query = query.eq('synthesis_batch_id', synthesisBatchId)
    const { data, error } = await query
    if (error) throw new Error(`research-arm report: could not read research rows: ${error.message}`)
    results.push(...((data ?? []) as typeof results))
    if ((data ?? []).length < PAGE) break
  }

  const prospectIds = [...new Set(results.map(r => r.prospect_id))]
  const tierById = new Map<string, string | null>()
  for (let i = 0; i < prospectIds.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('prospects')
      .select('id, sourced_tier')
      .eq('organisation_id', organisationId)
      .in('id', prospectIds.slice(i, i + CHUNK))
    if (error) throw new Error(`research-arm report: could not read tiers: ${error.message}`)
    for (const row of data ?? []) tierById.set(row.id as string, (row.sourced_tier as string | null) ?? null)
  }

  const resultIds = results.map(r => r.id)
  const usdByResult = new Map<string, number | null>()
  for (let i = 0; i < resultIds.length; i += CHUNK) {
    const { data, error } = await supabase
      .from('research_usage')
      .select('research_result_id, synthesis, opening, followups, web_search, synthesis_batched, firm_fact')
      .in('research_result_id', resultIds.slice(i, i + CHUNK))
    if (error) throw new Error(`research-arm report: could not read spend: ${error.message}`)
    for (const row of data ?? []) {
      usdByResult.set(row.research_result_id as string, researchUsageRowUsd(row as ResearchUsageRow))
    }
  }

  const rows: ArmReportRow[] = results.map(r => ({
    research_arm: armOf(r.research_arm),
    signal_relevance: r.signal_relevance,
    icp_fit: r.icp_fit,
    sourced_tier: tierById.get(r.prospect_id) ?? null,
    // No usage row at all is "unpriced", the same as a row that cannot be read: never a zero.
    usd: usdByResult.has(r.id) ? usdByResult.get(r.id) ?? null : null,
  }))

  // Prospects held at upload for the short arm, not yet released. Paged like the rows above.
  let heldShortReasoning = 0
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('prospects')
      .select('id')
      .eq('organisation_id', organisationId)
      .eq('research_arm', 'short_reasoning')
      .is('research_arm_released_at', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`research-arm report: could not count held prospects: ${error.message}`)
    heldShortReasoning += (data ?? []).length
    if ((data ?? []).length < PAGE) break
  }

  return { report: buildArmReport(rows), heldShortReasoning }
}
