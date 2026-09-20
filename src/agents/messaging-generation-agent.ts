// Messaging Playbook Generation Agent
// Entry point for generating the Messaging Playbook.
// Model: claude-sonnet-4-6 (see ADR-013 — revert to claude-opus-4-6 on stable connection)
// Prompt: /docs/prompts/messaging-agent.md
//
// ISOLATION RULES (enforced at three levels):
//   1. Database: RLS policies block cross-client reads
//   2. Application: explicit organisation_id filter on every query below
//   3. Prompt: no prompt references any data source outside current client context
//
// DEPENDENCIES — all three must exist and be active before this agent can run:
//   - ICP document     (strategy_documents WHERE document_type = 'icp' AND status = 'active')
//   - Positioning doc  (strategy_documents WHERE document_type = 'positioning' AND status = 'active')
//   - TOV guide        (strategy_documents WHERE document_type = 'tov' AND status = 'active')
//
// OUTPUT: Generates four distinct sequence variants (A, B, C, D) per ADR-014.
//   Writes a single row to document_suggestions with suggested_value:
//   { variants: { A: { emails: [...] }, B: { emails: [...] }, ... } }
//   Each variant that passes the post-processor gate is stored.
//   Variants that fail are retried (up to 3 times on original angle, then 3 fallback angles).
//   Minimum 3 variants must pass or the run fails without writing to document_suggestions.

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { mergeIntakeWithQuestions } from '@/lib/intake/questions'
import { logger } from '@/lib/logger'
import { startAgentRun } from '@/lib/agents/log-agent-run'
import { scrubAITells, scrubAITellsDeep, assertNoDashes } from '@/lib/style/customer-facing-style-rules'
import { nominalisationDensity, NOMINALISATION_THRESHOLD } from '@/lib/style/nominalisation'
import { findBackReferences } from '@/lib/style/back-reference'
import { EMAIL1_FRAME_TAIL_PARAGRAPHS, EMAIL1_FRAME_SLOT_PARAGRAPHS } from '@/lib/composition/compose-sequence'
import { BANNED_FIRMOGRAPHIC } from '@/lib/style/firmographic'
import { SentenceRegistry, comparableSentences } from '@/lib/style/sentence-frames'
import { readabilityScore, MAX_SENTENCE_WORDS, splitSentences } from '@/lib/style/readability'
// countWords is imported from the composition layer on purpose: the agent and composition
// must measure word counts identically or the stored count and the sent count disagree.
import { countWords } from '@/lib/composition/personalization'
import { buildRegenerationNotesBlock, buildRegenerationNotesReason, noteForVersionHistory, type RegenerationNotes } from '@/lib/agents/regeneration-notes'
import { projectIcpForDownstream } from '@/lib/agents/document-projection'

const MESSAGING_MODEL = 'claude-sonnet-4-6' // TEST ONLY — revert to claude-opus-4-6 for production (ADR-013)

// 4 variants × 4 emails each — increase tokens to accommodate the larger output.
const MAX_TOKENS = 16384

// Maximum retry attempts on the same angle before moving to fallback angles.
const MAX_RETRY_ATTEMPTS = 3

/**
 * Hard ceiling on Anthropic calls per run. THE 8TH CALL IS REFUSED.
 *
 * WHY A CALL BUDGET AS WELL AS THE WALL CLOCK. Nothing bounded total calls against the
 * clock. The structural worst case is 1 first-pass call plus MAX_RETRY_ATTEMPTS retries and
 * 3 fallback angles for each of 4 slots: 1 + 4 x 6 = 25 sequential calls. One run on
 * 2026-08-19 took 1,255,370ms, 21 minutes, and produced zero variants.
 *
 * THE ARITHMETIC, from durations measured across every run with a recorded call count. The
 * first call generates all four variants and costs about 75s; each single-variant retry
 * costs about 26s:
 *
 *     total ≈ preflight + 75 + 26 x (calls - 1)
 *
 *     6 calls ≈ 214s   <- inside the 240s guard, so the budget fires first
 *     7 calls ≈ 240s   <- ON the guard, which is not inside it
 *     9 calls ≈ 292s   <- what the two failed runs on 2026-08-28 actually reached
 *                          before Vercel killed the function at its 300s ceiling
 *
 * PREFLIGHT WAS MISSING FROM THIS MODEL UNTIL 2026-09-20, AND IT IS WHY THE NUMBER WAS
 * WRONG. Six Supabase reads and one insert run before the first call, and the projection
 * did not count them. 75 + 26 x 6 = 231 < 240 passed its test while the real total was
 * 231 + preflight, which is on or over the line. Measured on 2026-09-20: a run spent its
 * 5th call when the guard fired, having been granted 7. The guard cut mid-stream, which is
 * precisely the arbitrary failure the budget exists to prevent.
 *
 * THE NUMBER BELOW IS DERIVED, NOT CHOSEN. call-budget.test.ts computes the largest call
 * count whose projection fits inside AGENT_TIMEOUT_MS and asserts this constant equals it.
 * Change any of the three cost terms or the guard and the test says what the budget should
 * now be, rather than agreeing with whatever is written here.
 *
 * THE TWO CONTROLS FAIL DIFFERENTLY AND BOTH ARE KEPT. The wall clock can only ever cut
 * mid-stream, at an arbitrary point, with a partially generated variant discarded. The
 * budget stops at a SLOT BOUNDARY: every variant that has already passed is intact, the
 * remaining slots are recorded as dropped with a truthful reason, and the run reports a
 * complete picture of what it did. The wall clock stays as the backstop for the case the
 * budget cannot model, which is a single call running pathologically long.
 */
export const MAX_API_CALLS_PER_RUN = 6

/**
 * Measured cost model, exported so the budget and the wall-clock guard cannot drift apart
 * silently. Derived from every messaging run that recorded a call count:
 * 1 call -> 53-84s, 3 -> 128s, 5 -> 197s, 11 -> 317s, 12 -> 354s, 19 -> 543s.
 *
 * Re-measured 2026-09-20 across four runs: the first call ran 69 to 72s (mean 71.0, n=4)
 * and single-variant repairs ran 20 to 28s (median 24, mean 24.4, n=21). Both constants
 * below are left ABOVE their measured means deliberately. They are a ceiling the budget is
 * derived from, and rounding them down to the mean would buy a call by assuming every call
 * is average, which is the assumption a timeout guard exists to distrust.
 */
export const MEASURED_FIRST_CALL_SECONDS = 75
export const MEASURED_REPAIR_CALL_SECONDS = 26

/**
 * Everything before the first model call: startAgentRun, then intake, preflight checks,
 * the three required documents, the existing messaging document and the patterns table.
 * Six reads and one insert, all sequential.
 *
 * 9s is the OBSERVED MAXIMUM across the four runs of 2026-09-20 (8.8, 5.9, 4.5, and one
 * outlier), and instrumenting the real agent with the model call suppressed measured
 * 2.6 to 3.5s across three runs.
 *
 * THE OUTLIER IS DELIBERATELY EXCLUDED. One run spent 64.6s here, roughly sixty seconds of
 * which was a single unattributed stall in one of six trivial queries. Budgeting for it
 * would cost two repairs on every run to insure against something that has happened once
 * and is not understood. The wall-clock guard is the control for a pathological call; this
 * term models the normal case, which is what a cost model is for. See the Backlog row.
 */
export const MEASURED_PREFLIGHT_SECONDS = 9

/** 240s. Under Vercel's 300s ceiling on this plan, which the route declares. */
export const AGENT_TIMEOUT_MS = 240 * 1000

/** The structural worst case the budget exists to bound: 1 + 4 slots x (3 retries + 3 fallbacks). */
export const UNBOUNDED_WORST_CASE_CALLS = 1 + 4 * (MAX_RETRY_ATTEMPTS + 3)

// ─── Angle definitions ────────────────────────────────────────────────────────

// Maps each variant key to its original angle instruction for retry calls.
const VARIANT_ANGLE_INSTRUCTIONS: Record<string, string> = {
  A: 'Pain-led — email 1 opens with the implied cost or consequence of the current situation',
  B: "Outcome-led — email 1 opens with what their world looks like after the problem is resolved. Reflect the prospect's current situation first — do not open with the post-purchase state or project an imagined outcome. The outcome is implied by solving the problem, never stated directly.",
  C: "Peer pattern — email 1 opens with what similar buyers at this stage are experiencing. Draw the buyer archetype directly from the Tier 1 profile in the ICP document. Do not assume the prospect is a founder or runs a consulting firm unless the ICP document explicitly says so.",
  D: 'Pattern interrupt — email 1 opens with a direct observation that challenges one assumption the prospect holds about their current approach to the problem the client solves',
}

// Fallback angles tried in order when a slot exhausts retries on its original angle.
const FALLBACK_ANGLES = [
  {
    name: 'curiosity_gap' as const,
    instruction: "Email 1 opens with an observation that creates a question in the prospect's mind without answering it. The observation is drawn from the ICP document. The email deliberately withholds the resolution — the question is implied, not stated. No promise-forward language. No outcome description.",
  },
  {
    name: 'contrarian_reframe' as const,
    instruction: "Email 1 opens by directly challenging one assumption the prospect likely holds about their current approach to the problem the client solves. The assumption is drawn from the ICP Four Forces anxiety or habit force. One sentence challenge, one sentence implication, one CTA question.",
  },
  {
    // "Under 40 words total" was unreachable: the Email 1 floor is 50 words, so this
    // fallback failed the word gate on every attempt by construction and could never
    // rescue a slot. It now asks for the shortest email the band actually allows.
    name: 'direct_ask' as const,
    instruction: "Email 1 is the shortest email the word band allows: aim for the low 50s, and never below 50 words including the {{first_name}} line and both sign-off lines. State the prospect's core problem as a pattern most buyers at their stage recognise, in one or two short sentences. Then one direct question asking whether it is relevant. Nothing else.",
  },
] as const

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MessagingAgentInput {
  organisation_id: string
  /** Supabase client authenticated as the operator. Passed in from the API route. */
  supabase: SupabaseClient
  /** Segment this generation run is scoped to. NULL = org-level (should not occur for Messaging). */
  segment_id?: string | null
  /** Optional: notes on the rejected suggestion this run replaces. See ADR-038. */
  regeneration_notes?: RegenerationNotes
}

export interface MessagingAgentResult {
  suggestion_id: string
  organisation_id: string
  document_type: 'messaging'
  status: 'pending'
  variants_generated: number
  variants_failed: string[]
}

// One email object as returned by Claude in the four-element array.
// Exported for direct unit testing.
export interface EmailRecord {
  sequence_position: number
  subject_line: string | null
  subject_char_count: number
  body: string
  word_count: number
  suggestion_reason?: string
}

interface VariantFailure {
  variant: string
  violations: ValidationViolation[]
}

interface IntakeRow {
  field_key: string
  field_label: string
  response_value: string | null
  section: string
  is_critical: boolean
  /** The form asks this question and this organisation has no row for it at all. */
  never_presented?: boolean
}

// Represents any of the three required strategy documents.
interface StrategyDocument {
  id: string
  document_type: string
  version: string
  plain_text: string | null
  content: Record<string, unknown>
  status: string
}

// Extracted assumption from an upstream document.
interface UpstreamAssumption {
  documentType: string
  assumption: string
}

// Validated pre-flight context — org name, sender first name, prospect company name.
// These are required for email generation. Missing any of them aborts the run.
interface PreflightContext {
  org_name: string
  sender_first_name: string
  company_name: string
}

interface ExistingMessagingDocument {
  id: string
  version: string
  plain_text: string | null
  content: Record<string, unknown>
}

interface PatternRow {
  pattern_type: string
  pattern_data: Record<string, unknown>
  sample_size: number
  confidence_score: number | null
}

// All three required predecessor documents, fetched together.
interface RequiredDocuments {
  icp: StrategyDocument
  positioning: StrategyDocument
  tov: StrategyDocument
}

// Context passed to single-variant generation calls (retry and fallback).
// Same fields as buildUserMessage params, without organisation_id (not used in message construction).
interface VariantGenerationContext {
  intake: IntakeRow[]
  requiredDocs: RequiredDocuments
  existingDocument: ExistingMessagingDocument | null
  patterns: PatternRow[]
  completeness: number
  preflight: PreflightContext
  upstreamAssumptions: UpstreamAssumption[]
  /** Notes on the rejected suggestion this run replaces. Carried into retries and
   *  fallbacks as well as the first pass, so a retry cannot quietly drop the note. */
  regeneration_notes: RegenerationNotes | undefined
}

// Records the outcome for one variant slot after first pass + any retries/fallbacks.
interface SlotOutcome {
  variant: string
  result: 'first_pass' | 'retry' | 'fallback' | 'dropped'
  retryAttempts: number
  fallbackName?: string
  fallbackAttempt?: number
  apiCallsUsed: number
  dropReason?: string
  /**
   * The angle whose copy actually shipped in this slot. Equals the variant key when the
   * slot kept its assigned angle, the fallback angle name when a fallback was used, and
   * null when the slot was dropped and nothing shipped.
   *
   * REQUIRED, not optional. It used to be optional and set only inside retryVariantSlot,
   * so a first-pass variant recorded nothing and the storage step fell back to the slot
   * key. The stored value was therefore ambiguous: "A" could mean "shipped on angle A" or
   * "never recorded". Making it required forces every construction site to state which.
   */
  shippedAngle: string | null
}

// Accumulated stats for the full run — written to agent_runs and suggestion_reason.
interface RunStats {
  slotOutcomes: SlotOutcome[]
  totalApiCalls: number
  durationMs: number
}

/**
 * One-line summary of what a run had done at the moment it is called.
 *
 * Used by the timeout path so a killed run still records its call count and slot
 * outcomes. The success path has always had this detail; the failure path had none, which
 * left the only evidence in provider logs that expire.
 */
/**
 * Thrown when the 240s guard aborts a run. Distinct from a validation failure so the
 * retry loops can tell "this attempt was bad" from "stop working entirely".
 */
class MessagingAbortedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MessagingAbortedError'
  }
}

/**
 * Stops the retry machinery the moment the guard fires.
 *
 * WITHOUT THIS THE ABORT WOULD BE SWALLOWED. Every attempt inside retryVariantSlot is
 * wrapped in a try/catch that logs and continues to the next attempt, which is correct for
 * a transport error and completely wrong for an abort: an aborted signal makes every
 * remaining attempt fail instantly, so the loop would spin through all remaining retries
 * and fallbacks for every remaining slot, doing no work and reporting each as dropped.
 * The guard has to be checked explicitly and its error has to be rethrown.
 */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const reason = signal.reason
    throw new MessagingAbortedError(
      reason instanceof Error ? reason.message : 'Messaging agent: run aborted by the timeout guard'
    )
  }
}

function summariseRunStats(stats: RunStats, startedAt: number): string {
  const settled = stats.slotOutcomes
  const shipped = settled.filter(o => o.result !== 'dropped').length
  return (
    `API calls: ${stats.totalApiCalls}. ` +
    `Slots settled: ${settled.length}/4 (${shipped} shipped). ` +
    (settled.length > 0
      ? `Outcomes: ${settled.map(o => `${o.variant}=${o.result}`).join(', ')}. `
      : '') +
    `Elapsed: ${Math.round((Date.now() - startedAt) / 1000)}s.`
  )
}

// ─── Main agent function ──────────────────────────────────────────────────────

export async function runMessagingGenerationAgent(
  input: MessagingAgentInput
): Promise<MessagingAgentResult> {
  const { organisation_id, supabase, segment_id = null } = input
  const regeneration_notes = input.regeneration_notes

  logger.info('Messaging agent: starting', { organisation_id, segment_id })

  // Start agent run logging — every run is recorded to agent_runs table.
  const agentRun = await startAgentRun({
    organisation_id,
    agent_name: 'messaging-generation',
  })

  // AGENT_TIMEOUT_MS is 240s and stays 240s. Vercel's ceiling on this plan is 300 and the
  // route declares exactly that, so there is no headroom above it to move into.
  let timeoutHandle: NodeJS.Timeout | null = null

  // THE GUARD ABORTS. It used to only announce.
  //
  // The old version called agentRun.fail() and returned. Nothing cancelled the work, so
  // the agent kept calling Anthropic until Vercel killed the function at 300s. Measured
  // 2026-08-28: the guard fired at 240s, two more single-variant calls completed, and a
  // third was in flight when the runtime killed it. On 2026-08-19 a run whose guard had
  // fired at 240s ran on to 543s and then reported success. A control that does not stop
  // the thing it is guarding is a monitor wearing a control's name.
  //
  // The signal is threaded into every Anthropic call, so an in-flight stream is cut
  // rather than left to finish and be discarded.
  const abortController = new AbortController()

  // Live, not reconstructed at the end. The timeout path needs to persist what the run
  // actually did, and the old code built RunStats only on the success path, so a timed-out
  // run recorded nothing about how many calls it had made. That is why the two failures on
  // 2026-08-28 were diagnosable only from Vercel logs, which expire.
  const startedAt = Date.now()
  const runStats: RunStats = {
    slotOutcomes: [],
    totalApiCalls: 0,
    durationMs: 0,
  }

  try {
    timeoutHandle = setTimeout(() => {
      const msg =
        'Messaging agent: execution exceeded 240s timeout guard — aborting in-flight work. ' +
        summariseRunStats(runStats, startedAt)
      logger.error(msg, {
        organisation_id,
        api_calls: runStats.totalApiCalls,
        slots_settled: runStats.slotOutcomes.length,
      })
      // Abort first, then record. Recording is async; aborting must not wait on it.
      abortController.abort(new Error(msg))
      runStats.durationMs = Date.now() - startedAt
      void agentRun.fail(msg)
    }, AGENT_TIMEOUT_MS)

    // Step 1: Fetch intake responses for this client only.
    const intake = await fetchIntakeResponses(supabase, organisation_id)

    if (intake.length === 0) {
      throw new Error(
        `Messaging agent: no intake responses found for organisation ${organisation_id}. ` +
        'Intake data is required to generate a Messaging Playbook.'
      )
    }

    // Step 2: Pre-flight checks — verify required name fields before any generation work.
    const preflight = await runPreflightChecks(supabase, organisation_id, intake)

    // Step 3: Fetch all three required strategy documents.
    const requiredDocs = await fetchRequiredDocuments(supabase, organisation_id)

    // Step 4: Check overall intake completeness.
    const criticalFields = intake.filter(r => r.is_critical)
    const answeredCritical = criticalFields.filter(
      r => r.response_value && r.response_value.trim().length > 0
    )
    const completeness = criticalFields.length > 0
      ? Math.round((answeredCritical.length / criticalFields.length) * 100)
      : 0

    if (completeness < 80) {
      logger.warn(
        `Messaging agent: intake completeness is ${completeness}% — below 80% threshold.`,
        { organisation_id, completeness }
      )
    }

    // Step 5: Fetch the active messaging document, if this organisation has one.
    //
    // FETCHED ON DOCUMENT EXISTENCE, NEVER ON A CALLER'S FLAG. This was gated on
    // is_refresh, which meant "a pending suggestion is being replaced" and not "a prior
    // document exists". The operator's Regenerate control sends no suggestion_id, exactly
    // because nothing is pending, which is the case where an ACTIVE document DOES exist.
    // So the one path where the current version matters most was the one that never read
    // it: the run rebuilt from intake while its own reasoning header said no prior
    // document existed. Measured against a live v2 on 2026-09-08.
    const existingDocument: ExistingMessagingDocument | null = await fetchExistingMessagingDocument(supabase, organisation_id)

    // Step 6: Read patterns table (cross-client, read-only, may be empty in phase one).
    const patterns = await fetchPatterns(supabase)

    // Step 7: Extract upstream assumptions from strategy documents.
    const upstreamAssumptions: UpstreamAssumption[] = [
      ...extractAssumptionsFromDocument(requiredDocs.icp).map(a => ({
        documentType: 'icp',
        assumption: a,
      })),
      ...extractAssumptionsFromDocument(requiredDocs.positioning).map(a => ({
        documentType: 'positioning',
        assumption: a,
      })),
      ...extractAssumptionsFromDocument(requiredDocs.tov).map(a => ({
        documentType: 'tov',
        assumption: a,
      })),
    ]

    // Step 8: Build the user message requesting four variants.
    const userMessage = buildUserMessage({
      organisation_id,
      intake,
      requiredDocs,
      existingDocument,
      patterns,
      completeness,
      preflight,
      upstreamAssumptions,
      regeneration_notes,
    })

    // Step 9: Call Claude — one API call for all four variants.
    logger.info('Messaging agent: calling Claude for four variants', {
      organisation_id,
      model: MESSAGING_MODEL,
    })
    // Counted BEFORE the await so a call aborted mid-flight is still counted. A counter
    // incremented after the response would report zero for exactly the run that failed.
    throwIfAborted(abortController.signal)
    runStats.totalApiCalls++
    const generatedContent = await callClaude(userMessage, abortController.signal)

    // Step 10: Parse the four-variant structure.
    // Expected: { variants: { A: { emails: [...] }, B: { emails: [...] }, C: {...}, D: {...} } }
    const rawVariants = parseVariantsFromClaude(generatedContent)

    // Step 11: Post-process each variant independently.
    // Em-dash auto-fix + sign-off fix + 10-rule validation gate runs per variant.
    // One registry per document. Holds every sentence the accepted variants have used, so
    // a later variant repeating one is caught and regenerated.
    const sentenceRegistry = new SentenceRegistry()

    const { passedVariants, variantFailures } = await processAllVariants(
      rawVariants,
      preflight.sender_first_name,
      preflight.org_name,   // sender's company name, from organisations.name
      organisation_id,
      sentenceRegistry,
    )

    // Step 12: RunStats is created above, before the guard, and counted live.

    for (const key of Object.keys(rawVariants)) {
      if (passedVariants[key]) {
        runStats.slotOutcomes.push({
          variant: key,
          result: 'first_pass',
          retryAttempts: 0,
          apiCallsUsed: 0,
          // First pass means the slot kept its assigned angle. Recorded explicitly rather
          // than left to a downstream default, so the stored value always means what it says.
          shippedAngle: key,
        })
      }
    }

    // Step 13: Retry any failing variants (up to 3 attempts on original angle,
    // then fallback angles). Only fires if variants actually failed.
    if (variantFailures.length > 0) {
      const retryContext: VariantGenerationContext = {
        intake,
        requiredDocs,
        existingDocument,
        patterns,
        completeness,
        preflight,
        upstreamAssumptions,
        regeneration_notes,
      }

      // BREADTH-FIRST. Every failing slot gets its first repair before any gets its
      // second. See scheduleRepairsBreadthFirst for the measurement that prompted it.
      //
      // Sorted so the order a run spends its budget in is reproducible, the same reason
      // processAllVariants sorts.
      const repairStates = new Map<string, SlotRepairState>(
        [...variantFailures]
          .sort((a, b) => a.variant.localeCompare(b.variant))
          .map(f => [f.variant, {
            variant: f.variant,
            // The first-pass violations for THIS slot. The feedback step 0 sees.
            lastViolations: f.violations,
            apiCallsUsed: 0,
          }]),
      )

      await scheduleRepairsBreadthFirst({
        slots: [...repairStates.keys()],
        stepsPerSlot: repairStepCount(),
        hasBudget: () => runStats.totalApiCalls < MAX_API_CALLS_PER_RUN,
        attempt: async (slot, step) => {
          // Stop before starting a slot once the guard has fired. Without this the loop
          // would enter the slot and throw on its call anyway, but only after logging an
          // attempt that never happened.
          throwIfAborted(abortController.signal)

          const state = repairStates.get(slot)!
          // Recollected before every attempt so each one sees the variants that have
          // survived up to this point, including ones repaired earlier this round.
          const taken = collectTakenCopy(passedVariants, [preflight.sender_first_name, preflight.org_name])

          const result = await attemptSlotRepair(
            state, step, retryContext, organisation_id, taken,
            sentenceRegistry, abortController.signal, runStats,
          )
          if (!result) return false

          passedVariants[slot] = result.emails
          // NOT `+= apiCallsUsed`. attemptSlotRepair increments the shared counter at the
          // moment of each call, so adding the per-slot total here would double-count.
          runStats.slotOutcomes.push(result.outcome)
          return true
        },
        onBudgetExhausted: slot => {
          const state = repairStates.get(slot)!
          logger.warn(
            `Messaging agent: Variant ${slot} not attempted — run call budget of ${MAX_API_CALLS_PER_RUN} exhausted`,
            { organisation_id, variantKey: slot, api_calls: runStats.totalApiCalls, budget: MAX_API_CALLS_PER_RUN },
          )
          runStats.slotOutcomes.push(budgetExhaustedOutcome(slot, state.apiCallsUsed))
        },
        onStepsExhausted: slot => {
          const state = repairStates.get(slot)!
          logger.warn(
            `Messaging agent: Variant ${slot} dropped after all retries and fallbacks`,
            { organisation_id, variantKey: slot },
          )
          runStats.slotOutcomes.push(stepsExhaustedOutcome(slot, state.apiCallsUsed))
        },
      })
    }

    runStats.durationMs = Date.now() - startedAt

    // Step 14: Minimum threshold check — 3 or 4 variants must pass.
    const passedCount = Object.keys(passedVariants).length
    if (passedCount < 3) {
      const droppedOutcomes = runStats.slotOutcomes.filter(o => o.result === 'dropped')
      const droppedSummary = droppedOutcomes
        .map(o => `${o.variant}: ${o.dropReason ?? 'unknown reason'}`)
        .join('; ')
      const failureMessage =
        `Messaging generation failed: only ${passedCount} of 4 variants passed after retries and fallback substitution. ` +
        `Variants that failed: ${droppedSummary || 'none recorded'}. ` +
        `Regenerate manually from the dashboard.`

      await agentRun.fail(failureMessage)
      throw new Error(failureMessage)
    }

    // Step 15: Write validated variants to document_suggestions.
    const suggestionId = await writeDocumentSuggestion(supabase, {
      organisation_id,
      segment_id,
      requiredDocs,
      existingDocument,
      variants: passedVariants,
      variantFailures,
      intake,
      completeness,
      runStats,
      regeneration_notes,
    })

    // Step 16: Complete the agent run with full stats.
    const firstPassCount = runStats.slotOutcomes.filter(o => o.result === 'first_pass').length
    const retryCount = runStats.slotOutcomes.filter(o => o.result === 'retry').length
    const fallbackCount = runStats.slotOutcomes.filter(o => o.result === 'fallback').length
    const droppedCount = runStats.slotOutcomes.filter(o => o.result === 'dropped').length

    await agentRun.complete(
      `Generated ${passedCount}/4 variants. ` +
      `First pass: ${firstPassCount}.` +
      (retryCount > 0 ? ` Retry: ${retryCount}.` : '') +
      (fallbackCount > 0 ? ` Fallback: ${fallbackCount}.` : '') +
      (droppedCount > 0 ? ` Dropped: ${droppedCount}.` : '') +
      ` Total API calls: ${runStats.totalApiCalls}.` +
      ` Duration: ${Math.round(runStats.durationMs / 1000)}s.`
    )

    const finalDropped = runStats.slotOutcomes
      .filter(o => o.result === 'dropped')
      .map(o => o.variant)

    logger.info('Messaging agent: suggestion written successfully', {
      organisation_id,
      suggestion_id: suggestionId,
      variants_generated: passedCount,
      variants_failed: finalDropped,
    })

    if (timeoutHandle) clearTimeout(timeoutHandle)

    return {
      suggestion_id: suggestionId,
      organisation_id,
      document_type: 'messaging',
      status: 'pending',
      variants_generated: passedCount,
      variants_failed: finalDropped,
    }
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (!(err instanceof MessagingValidationError)) {
      await agentRun.fail(err instanceof Error ? err.message : String(err))
    }
    throw err
  }
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchIntakeResponses(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<IntakeRow[]> {
  const { data, error } = await supabase
    .from('intake_responses')
    .select('field_key, field_label, response_value, section, is_critical')
    .eq('organisation_id', organisation_id) // explicit isolation filter
    .order('section')

  if (error) {
    throw new Error(`Messaging agent: failed to fetch intake responses — ${error.message}`)
  }

  const rows = (data ?? []) as IntakeRow[]

  // An organisation with NO stored intake at all must still trip the caller's empty check,
  // so return early rather than handing it back a full set of unanswered questions.
  if (rows.length === 0) return []

  // Otherwise fill in every question the form asks that this organisation has no row for.
  // Without this the agent only ever sees questions the client was shown, so a question
  // added after they finished their intake is invisible here and the CRITICAL marker below
  // cannot fire on it. See src/lib/intake/questions.ts.
  return mergeIntakeWithQuestions(rows) as IntakeRow[]
}

// ─── Pre-flight checks ────────────────────────────────────────────────────────

async function runPreflightChecks(
  supabase: SupabaseClient,
  organisation_id: string,
  intake: IntakeRow[]
): Promise<PreflightContext> {
  const missing: string[] = []

  const { data: orgRow } = await supabase
    .from('organisations')
    .select('name, founder_first_name')
    .eq('id', organisation_id)
    .single()

  // organisations.name is the sender's company name and is MANDATORY: it is rendered on
  // the second line of the sign-off block of every email, so a prospect has something
  // searchable without a link in the body. There is deliberately no fallback. A missing
  // company name is a provisioning gap to fix, not something to paper over silently.
  const orgName = orgRow?.name?.trim() ?? ''
  if (!orgName) {
    missing.push(
      'Organisation name is missing. It is required because it appears on the sign-off ' +
      'line of every email, below the sender first name. Add it under Settings → Organisation.'
    )
  }

  const senderFirstName = orgRow?.founder_first_name?.trim() ?? ''
  if (!senderFirstName) {
    missing.push(
      'Founder first name is missing. Add it under Settings → Organisation (founder_first_name field).'
    )
  }

  const companyNameRow = intake.find(r => r.field_key === 'company_name')
  const companyName = companyNameRow?.response_value?.trim() ?? ''
  if (!companyName) {
    missing.push(
      'Company name is missing from the intake questionnaire. Complete the "Company name" field in the intake form.'
    )
  }

  if (missing.length > 0) {
    throw new Error(
      'Messaging agent: cannot generate emails — the following required fields are missing:\n' +
      missing.map((m, i) => `  ${i + 1}. ${m}`).join('\n')
    )
  }

  return {
    org_name: orgName,
    sender_first_name: senderFirstName,
    company_name: companyName,
  }
}

async function fetchRequiredDocuments(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<RequiredDocuments> {
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('id, document_type, version, plain_text, content, status')
    .eq('organisation_id', organisation_id) // explicit isolation filter
    .in('document_type', ['icp', 'positioning', 'tov'])
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(`Messaging agent: failed to fetch strategy documents — ${error.message}`)
  }

  const docs = (data ?? []) as StrategyDocument[]

  const byType: Partial<Record<string, StrategyDocument>> = {}
  for (const doc of docs) {
    if (!byType[doc.document_type]) {
      byType[doc.document_type] = doc
    }
  }

  const docLabels: Record<string, string> = {
    icp: 'ICP document',
    positioning: 'Positioning document',
    tov: 'Tone of Voice guide',
  }
  const errors: string[] = []

  for (const [type, label] of Object.entries(docLabels)) {
    const doc = byType[type]
    if (!doc) {
      errors.push(
        `${label} has not been generated yet. Run the ${label.split(' ')[0]} agent first.`
      )
    } else if (doc.status !== 'active') {
      errors.push(
        `${label} exists but has status "${doc.status}". ` +
        `Approve it in the dashboard before running the messaging agent.`
      )
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Messaging agent: cannot run — the following documents need attention:\n` +
      errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')
    )
  }

  return {
    icp:         byType['icp']!,
    positioning: byType['positioning']!,
    tov:         byType['tov']!,
  }
}

async function fetchExistingMessagingDocument(
  supabase: SupabaseClient,
  organisation_id: string
): Promise<ExistingMessagingDocument | null> {
  const { data, error } = await supabase
    .from('strategy_documents')
    .select('id, version, plain_text, content')
    .eq('organisation_id', organisation_id) // explicit isolation filter
    .eq('document_type', 'messaging')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error) return null

  return data as ExistingMessagingDocument
}

async function fetchPatterns(supabase: SupabaseClient): Promise<PatternRow[]> {
  const { data, error } = await supabase
    .from('patterns')
    .select('pattern_type, pattern_data, sample_size, confidence_score')
    .order('confidence_score', { ascending: false })
    .limit(20)

  if (error) {
    logger.warn('Messaging agent: could not fetch patterns — continuing without them', {
      error: error.message,
    })
    return []
  }

  return (data ?? []) as PatternRow[]
}

// ─── Prompt construction ──────────────────────────────────────────────────────

// Extracts "Assumptions we have made" section from a document's plain_text.
// Returns an array of assumption strings, or empty array if no section found.
function extractAssumptionsFromDocument(
  doc: StrategyDocument
): string[] {
  if (!doc.plain_text) return []

  const assumptionsMatch = doc.plain_text.match(
    /##\s+Assumptions\s+we\s+have\s+made\s*\n([\s\S]*?)(?=\n##|\Z)/i
  )

  if (!assumptionsMatch || !assumptionsMatch[1]) return []

  const lines = assumptionsMatch[1]
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('-') || line.startsWith('*'))
    .map(line => line.replace(/^[-*]\s+/, '').trim())
    .filter(line => line.length > 0)

  return lines
}

// Builds the shared context block used by both buildUserMessage and buildSingleVariantUserMessage.
// Returns the completeness note and all context sections (intake, documents, sender, refresh, patterns).
function buildBaseContext(params: VariantGenerationContext): {
  completenessNote: string
  contextBlocks: string
} {
  const { intake, requiredDocs, existingDocument, patterns, completeness, preflight, upstreamAssumptions } = params

  const bySec = intake.reduce<Record<string, IntakeRow[]>>((acc, row) => {
    if (!acc[row.section]) acc[row.section] = []
    acc[row.section].push(row)
    return acc
  }, {})

  const intakeSections = Object.entries(bySec)
    .map(([section, rows]) => {
      const lines = rows
        .map(r => {
          const answered = r.response_value && r.response_value.trim().length > 0
          const value = answered ? r.response_value : '[not answered]'
          const flag = r.is_critical && !answered
            ? (r.never_presented
                ? ' ⚠️ CRITICAL — NOT ANSWERED (added after this client completed intake, so they were never asked)'
                : ' ⚠️ CRITICAL — NOT ANSWERED')
            : ''
          return `  Q: ${r.field_label}${flag}\n  A: ${value}`
        })
        .join('\n\n')
      return `### ${section}\n\n${lines}`
    })
    .join('\n\n---\n\n')

  // `project` narrows the document before it reaches the prompt. Passed for the ICP, whose
  // content carries operator-facing keys (unresolved_fields, and Rule 9 Tier Two flagged
  // claims) that must not reach copy. Positioning and TOV have no such keys today; when
  // either gains one, it needs a projection here too.
  //
  // Note which branch runs: plain_text is NULL on every row in production, so the fallback
  // is the real path and projecting only the fallback would be projecting nothing. Both
  // branches go through `project`.
  // `project` is REQUIRED, and deliberately not optional. An optional parameter is one a
  // caller can forget, and forgetting it here silently puts operator-facing keys back into
  // a prompt that writes copy. Required means every call site states its decision and
  // omitting it is a compile error, which is the guard a test cannot give you.
  // Pass `null` only for a document with no operator-facing keys.
  const formatDoc = (
    doc: StrategyDocument,
    label: string,
    guidance: string,
    project: ((content: unknown) => Record<string, unknown>) | null,
  ): string => {
    const body = project
      ? JSON.stringify(project(doc.content), null, 2)
      : (doc.plain_text ?? JSON.stringify(doc.content, null, 2))
    return `\n\n---\n\n## ${label} (version ${doc.version})\n\n${guidance}\n\n${body}`
  }

  const icpBlock = formatDoc(
    requiredDocs.icp,
    'ICP DOCUMENT',
    'Use this to understand who the playbook is written for. ICP Tier 1 defines the hero. ' +
    'Their four_forces (push, pull, anxiety, habit) are the emotional raw material for opening lines and subject lines. ' +
    'Their triggers are the situations that make Email 1 land. Their switching_costs inform objection handling.',
    projectIcpForDownstream,
  )

  const positioningBlock = formatDoc(
    requiredDocs.positioning,
    'POSITIONING DOCUMENT',
    'Use this for the core_message, value_themes, and key_messages. ' +
    'The moore_statement is the spine. The competitive_alternatives inform the cost-of-inaction framing. ' +
    'The white_space from competitive_landscape is what differentiates this firm in copy.',
    // No operator-facing keys in the positioning schema today. The day it gains one,
    // this null becomes a projection.
    null,
  )

  const tovBlock = formatDoc(
    requiredDocs.tov,
    'TONE OF VOICE GUIDE',
    'Every word of copy must pass through this filter. ' +
    'Use the vocabulary.words_they_use list directly. ' +
    'Apply the vocabulary.structural_patterns to every email and LinkedIn message. ' +
    'The writing_rules section contains the five mandatory corrections — all apply here. ' +
    'The before_after_examples show the register. The do_dont_list is a copy checklist.',
    // No operator-facing keys in the TOV schema today. Same note as positioning above.
    null,
  )

  const refreshContext = existingDocument
    ? `\n\n---\n\n## VERSION ${existingDocument.version}, THE MESSAGING PLAYBOOK NOW LIVE\n\n` +
      'This organisation already has a live playbook, reproduced in full below. What you ' +
      'produce REPLACES it. Preserve what works. Update what has been superseded by new ' +
      'strategy documents, or by a note further down.\n\n' +
      (existingDocument.plain_text ?? JSON.stringify(existingDocument.content, null, 2))
    : ''

  const patternContext = patterns.length > 0
    ? `\n\n---\n\n## CROSS-CLIENT PATTERNS (anonymised, ${patterns.length} patterns)\n\n` +
      'Supplementary context only — not specific to this organisation.\n\n' +
      patterns
        .map(p => `- ${p.pattern_type} (${p.sample_size} data points): ${JSON.stringify(p.pattern_data)}`)
        .join('\n')
    : ''

  const completenessNote = completeness < 80
    ? `\n\n⚠️ INTAKE COMPLETENESS NOTE: Only ${completeness}% of critical fields answered. ` +
      'Derive what you can from the three strategy documents, which are the primary context. ' +
      'Do not hallucinate specifics.'
    : ''

  const senderContext =
    `\n\n---\n\n## SENDER CONTEXT\n\n` +
    `Organisation name (this is the sender's company. Write it VERBATIM as the second line ` +
    `of the sign-off block on every email, directly beneath the first name): ${preflight.org_name}\n` +
    `Sender first name (use this on the sign-off line of every email — never leave it blank): ${preflight.sender_first_name}\n` +
    `Client company name (use for context in copy — write as plain text, never as a merge tag): ${preflight.company_name}`

  const upstreamAssumptionsContext = upstreamAssumptions.length > 0
    ? `\n\n---\n\n## UPSTREAM ASSUMPTIONS FROM STRATEGY DOCUMENTS\n\n` +
      'The following assumptions appear in the ICP, Positioning, or TOV documents. ' +
      'If the messaging output relies on any of these, carry them into the messaging document\'s own ' +
      '"Assumptions we have made" section, attributed to their source. Do not copy assumptions the ' +
      'messaging does not use.\n\n' +
      upstreamAssumptions.map(a => {
        const sourceLabel = a.documentType === 'icp' ? 'ICP' : a.documentType === 'positioning' ? 'Positioning' : 'Tone of Voice'
        return `- ${sourceLabel}: ${a.assumption}`
      }).join('\n')
    : ''

  const contextBlocks =
    `## INTAKE QUESTIONNAIRE RESPONSES\n\n${intakeSections}` +
    icpBlock + positioningBlock + tovBlock + senderContext + upstreamAssumptionsContext + refreshContext + patternContext +
    buildRegenerationNotesBlock(params.regeneration_notes, params.existingDocument)

  return { completenessNote, contextBlocks }
}

function buildUserMessage(params: {
  organisation_id: string
  intake: IntakeRow[]
  requiredDocs: RequiredDocuments
  existingDocument: ExistingMessagingDocument | null
  patterns: PatternRow[]
  completeness: number
  preflight: PreflightContext
  upstreamAssumptions: UpstreamAssumption[]
  regeneration_notes: RegenerationNotes | undefined
}): string {
  const { completenessNote, contextBlocks } = buildBaseContext(params)

  return `You are generating four distinct messaging sequence variants for the client described in the ICP document provided.
${completenessNote}

The three strategy documents below are your primary context. They contain everything you need
to write copy that is specific, grounded, and consistent. Do not invent details not present in them.

${contextBlocks}

---

## FOUR-VARIANT SEQUENCE INSTRUCTION

Generate four distinct email sequence variants: A, B, C, and D.
Each variant is a complete 4-email sequence targeting the same ICP, offer, and positioning.
The primary angle changes across variants. The TOV voice, rules, and offer framing do not change.

## EMAIL 1 IS A FRAME WITH A SLOT

Email 1 is not finished prose. It is a frame of five paragraphs, each with one job.
Paragraph 2 is a SLOT: the platform replaces it at send time whenever real research on
that specific prospect exists. Write the default that ships when it does not.

  P1  {{first_name}} on its own line. Nothing else.
  P2  THE OBSERVATION SLOT. Observe the prospect's situation and name the problem it
      implies. This is the ONLY paragraph that may describe the problem. It must stand
      alone, because it gets replaced. Do not pitch here. Do not name the service here.
  P3  WHAT CHANGES. The offer line. Signal that the sender does something about that
      problem and name a RESULT in the prospect's own terms. Do NOT name the service, do
      NOT explain the mechanism, do NOT list features. One or two short sentences. This
      paragraph MAY begin with We: the I/We ban applies only to the observation slot.
      Register to match: "We get more conversations into your diary."
                         "We bring qualified prospects to you."

      TWO THINGS P3 MUST NEVER DO.
      It must not describe work the prospect still has to do. P3 is where friction comes
      off. Adding a task puts it back on.
      It must not explain the prospect's own job back to them. They have run sales calls
      for years and do not need one narrated by a stranger.
      FAILING, and shipped in three variants at once:
        "You take the calls and close them."
      Six words, both faults: it hands them a task, and it tells a consultant what happens
      on a sales call. Deleting it makes the offer line stronger.
      Shapes that work, as illustrations rather than lines to copy:
        "We keep the diary filled without you writing anything."
        "The prospecting runs whether you're in delivery or not."
      Each names the sender's action and the prospect's changed state, then stops.

      P3 must FLEX to the pain P2 opened on, and must differ across all four variants.
      A fixed line reused across variants is a spam fingerprint, and is code-enforced.
  P4  The CTA question. One question. Low commitment.
  P5  THE SIGN-OFF BLOCK. Two lines, in this order, nothing after them:
        ${params.preflight.sender_first_name}
        ${params.preflight.org_name}
      Both lines are mandatory on every email. No closer before the name.

NON-REDUNDANCY. No paragraph may restate the idea of another. P3 advances the email, it
does not rephrase P2. If P3 could be deleted and the email still says the same thing, P3
has failed and must be rewritten.

PARAGRAPH INDEPENDENCE STILL APPLIES. P2 is unknown at authoring time, so no paragraph
may refer back to the one above it. Each paragraph names its own subject.

NOTHING MAY DEPEND ON THE PARAGRAPH ABOVE IT. P2 is replaced per prospect at send time,
so every later paragraph must read correctly with a sentence it has never seen sitting
above it. No paragraph may lean on P2 by demonstrative, by pronoun, or by definite
article.

The pronoun case is the one that hides, and it shipped:
  "We run it differently: hyper-specific targeting, conversations that land with the
   right people."
"it" is outbound, which P2 named. A researched prospect got: "You ran Vantor and the ORRIN
Director role side by side for 13 months. That wrapped in August 2025. We run it
differently..." Run WHAT differently.
Restore the noun and the sentence survives any P2:
  "We run outbound differently: hyper-specific targeting, conversations that land with
   the right people."
Bare "it", "they" and "them" in P3 are rejected in code whenever that paragraph never
says what they stand for. The check is mechanical, so apply it yourself: read P3 with P2
deleted, and replace any word left pointing at nothing.

NO DEMONSTRATIVES POINTING BACKWARDS. From P3 onward, do not write "that X", "this X",
"those X", "these X" or "such X" where X is a noun. A demonstrative binding a noun has to
point at something, and the only thing it can point at is a paragraph that may not
survive composition. This is checked in code and rejects the whole variant.

  Rejected: "We break that ceiling by running outbound that puts conversations in your diary."
            P2 mentioned a ceiling. Once a researched observation replaces P2, no ceiling
            was ever named and the sentence points at nothing.
  Accepted: "We run the outbound so the diary fills without you writing anything."
            Names its own subject. Reads correctly after any P2.

Watch the softer version too. A definite article can lean on P2 just as hard: "so the gap
between projects stops being a panic" introduces "the gap" as though it were already
established. If a noun phrase would puzzle someone who read only that paragraph, name it
properly or cut it. Ordinary definite articles are fine: "without you touching the
outreach" needs no antecedent and is good copy.

## PATTERNS, NOT VERDICTS

The prospect knows their own business and you do not. P2 names a problem you have not
verified, so it must be offered as a pattern they can recognise themselves in, never as a
finding about them. The difference is whether a wrong guess costs you the reply.

GOOD, from a variant that framed it correctly. Note that this is a pattern statement about
a group, which the reader either joins or does not:

  "Most B2B consulting founders at your stage are in the same spot: delivery is solid,
   close rate is fine, but conversations are rare and almost all of them come from
   referrals they can't control. One warm intro every few weeks keeps the lights on and
   removes the urgency to build anything else."

FAILING, from a variant that asserted it. Every clause is a claim about this specific
reader's business, stated flat:

  "A project ends and the diary empties. No referrals lined up, no outreach running,
   nothing queued. The business that looked healthy last month is suddenly exposed."

Write like the first. Do not copy either one: they are here to show the difference between
describing a group and pronouncing on a person, and both will be recognisable if reused.
Reach for your own framing. "Most founders we speak to find...", "The pattern with firms
at this size tends to be...", "Where this usually shows up is..." are all openings into
pattern framing, and there are many more.

NEVER ASSERT EXCLUSIVITY. "Most of the pipeline comes from referrals" survives being
wrong. "No outreach running" does not. The prospect may well have three channels with two
of them broken, and an email that denies those channels exist reads as not having looked
before writing. Words like no, none, nothing, never, only and zero, applied to what the
prospect does or has, are the ones to watch. Say most, usually, or the bulk of, and the
sentence still lands if you guessed wrong about the details.

WORD PRESSURE, READ THIS. Pattern framing costs more words than assertion, and Email 1 is
${EMAIL_WORD_LIMITS.email1MinWords} to ${EMAIL_WORD_LIMITS.email1TargetMaxWords} words
with a hard cap of ${EMAIL_WORD_LIMITS.email1MaxWords}. Do not solve that by compressing
P2 back into a verdict. Take the words from elsewhere: P3 can be one sentence rather than
two, the CTA can be shorter, and any clause that merely restates something is already
failing the non-redundancy rule and should go. If the email will not fit, cut content, not
the framing.

Angle assignments determine how the P2 observation slot opens:
- Variant A: Pain-led. The implied cost or consequence of the current situation.
- Variant B: Outcome-led. Reflect the current situation. Never project the post-purchase state.
- Variant C: Peer pattern. What similar buyers at this stage are experiencing, as defined by the Tier 1 profile in the ICP document.
- Variant D: Pattern interrupt. A direct observation that challenges a common assumption.

All four variants must:
- Follow every rule in the system prompt without exception
- Use a different Email 1 subject line. Email 1 is the only email with a subject, so this
  is the only subject each variant has
- Use a meaningfully different P2 observation in email 1
- Use a meaningfully different P3 in email 1
- Differ meaningfully in emails 2, 3 AND 4, not only email 1. Four near-identical
  follow-ups across a send list is a larger fingerprint than a shared opener
- Keep the sequence structure: Email 1 observation and what changes, Email 2 pattern proof, Email 3 insight and meeting ask, Email 4 breakup

Critical reminders:
${renderWordCountReminder()}
- Do not count the words yourself. The platform recomputes word_count and subject_char_count from the text you return and validates the computed values. Write to the band, not to a number you report.
- Every sentence must mean something concrete on one reading. See the understandability tests in the system prompt.
- No I/We opener on the observation slot. One question per message. No em dashes.
- ALL FOUR EMAILS THREAD. Only Email 1 has a subject line. Emails 2, 3 and 4 must set
  subject_line to null and subject_char_count to 0, so the whole sequence lands in one
  thread and a reader opening the last email can scroll up to see who is writing.
- No ampersands in prose. Write "and". An ampersand is fine inside a company's own name.
- No internal jargon the buyer did not introduce. Never write ICP, top of funnel, buyer
  persona, value prop, or go-to-market to a prospect. Those are our words for their
  business. Say what they would say: "who you sell to", "the people you're targeting".
- Never assert exclusivity about the prospect's situation. See PATTERNS, NOT VERDICTS.
- NEVER QUOTE A FIGURE FROM THE PROSPECT'S FIRMOGRAPHIC RECORD. Code-enforced. The
  population you describe may be qualified by ROLE, STAGE or SITUATION, never by revenue,
  headcount or funding. These both shipped and both must not recur:
    "Most B2B consulting firms at the £500K to £5M mark"
    "For most consulting founders billing north of £500K"
  It reads as a database lookup, it may be wrong, and a wrong number in the opening line
  gets disproved where a generic one is merely ignored. The client's revenue band is a
  targeting instruction that decides who receives this, not content that goes inside it.
  Qualify by something defensible: who they are, what stage they are at, or what is
  happening to them.
- NO FULL SENTENCE MAY APPEAR IN TWO VARIANTS' EMAIL 1. Code-enforced, Email 1 only:
  emails 2, 3 and 4 may overlap between variants and are not checked. Within Email 1 it
  covers every sentence, not just subjects and openers. The offer line and the CTA collide
  most often, so write four genuinely different offer lines and four genuinely different
  CTAs. Swapping one noun does not clear it: proper nouns and numbers are normalised
  before comparing. The two-line sign-off is exempt.
- The offer line names what the sender does and what changes for the prospect. It must not
  describe work the prospect still has to do, and must not explain their own job to them.
- The sign-off block is mandatory on EVERY email and is TWO lines: the sender's first name
  ("${params.preflight.sender_first_name}") then the company name ("${params.preflight.org_name}") directly beneath it.
  For emails 1, 2, and 3 the CTA question is NOT the last line. The block goes after it.
  Structure: [CTA question], blank line, ${params.preflight.sender_first_name}, newline, ${params.preflight.org_name}
  Both lines count toward the word count, exactly as the {{first_name}} line already does.
  An email that ends with only "${params.preflight.sender_first_name}" will be rejected.

Return ONLY the four-variant JSON below. No subject line libraries. No CTA libraries. No objection responses. No explanation. No markdown fencing.

Return raw JSON with this exact structure:
{
  "variants": {
    "A": { "emails": [/* 4 email objects */] },
    "B": { "emails": [/* 4 email objects */] },
    "C": { "emails": [/* 4 email objects */] },
    "D": { "emails": [/* 4 email objects */] }
  }
}

Each email object must contain exactly these fields:
  sequence_position: integer 1-4
  subject_line: string for email 1 ONLY. null for emails 2, 3 and 4
  subject_char_count: integer for email 1, 0 for emails 2, 3 and 4
  body: full email body from {{first_name}} through the sign-off name
  word_count: integer (count the whole body, including the {{first_name}} line and the sign-off name)
  suggestion_reason: per-email notes (deliberate imperfection, unpopulated tokens, pronoun ratio shortfall)`
}

// Subject lines and Email 1 openers already used by variants that have passed the gate.
// Threaded into retry calls so a regenerated variant does not collide with them.
interface TakenCopy {
  subjects: string[]
  openers: string[]
  /**
   * Every comparable sentence from the EMAIL 1 of each accepted variant.
   * Subjects and openers alone were not enough: variants A, B and C all shipped
   * "You take the calls and close them." as Email 1 P3, which is neither a subject
   * nor an opener, so nothing saw it. Scoped to Email 1 to match the gate, which no
   * longer polices emails 2 to 4.
   */
  sentences: string[]
}

// Collects the subjects, Email 1 openers and full sentence inventory from every variant
// that has passed so far.
function collectTakenCopy(
  passed: Record<string, EmailRecord[]>,
  signOffLines: string[] = [],
): TakenCopy {
  const subjects: string[] = []
  const openers: string[] = []
  const sentences: string[] = []
  const seenSentences = new Set<string>()

  for (const emails of Object.values(passed)) {
    for (const email of emails) {
      if (email.subject_line) subjects.push(email.subject_line)
      // Email 1 only: the retry context should list exactly what the gate will reject.
      if (email.sequence_position !== CROSS_VARIANT_UNIQUE_POSITION) continue
      for (const sentence of comparableSentences(email.body, signOffLines)) {
        if (seenSentences.has(sentence)) continue
        seenSentences.add(sentence)
        sentences.push(sentence)
      }
    }
    const first = emails.find(e => e.sequence_position === 1)
    if (first) {
      const opener = firstBodyLineAfterGreeting(first.body)
      if (opener) openers.push(opener)
    }
  }

  return { subjects, openers, sentences }
}

// The observation slot line: the first non-empty line after the {{first_name}} greeting.
function firstBodyLineAfterGreeting(body: string): string | null {
  const lines = body.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  const greetingIdx = lines.findIndex(l => /^\{\{first_name\}\},?$/.test(l))
  return lines.slice(greetingIdx + 1).find(l => l.length > 0) ?? null
}

function buildAvoidBlock(taken: TakenCopy): string {
  if (taken.subjects.length === 0 && taken.openers.length === 0 && taken.sentences.length === 0) return ''

  const parts: string[] = [
    '\n## ALREADY USED BY OTHER VARIANTS IN THIS SEQUENCE SET\n',
    'These variants have already been accepted. Your variant ships alongside them to the',
    'same audience, so anything you repeat becomes a uniform fingerprint across sends.',
    'Do not reuse any of the following, and do not produce a near-paraphrase of one.\n',
  ]

  if (taken.subjects.length > 0) {
    parts.push('Subject lines already taken:')
    parts.push(...taken.subjects.map(s => `  - ${s}`))
  }
  if (taken.openers.length > 0) {
    parts.push('\nEmail 1 observation lines already taken:')
    parts.push(...taken.openers.map(o => `  - ${o}`))
  }
  if (taken.sentences.length > 0) {
    parts.push('')
    parts.push('EMAIL 1 SENTENCES ALREADY USED by the accepted variants.')
    parts.push('Reusing any of these in YOUR Email 1 fails the gate and the variant is regenerated.')
    parts.push('Swapping one noun is not enough either: write a different sentence.')
    parts.push('This includes the offer line and the CTA, which are the two that collide most.')
    parts.push('Emails 2, 3 and 4 are not checked for reuse, so spend your effort on Email 1.')
    parts.push(...taken.sentences.map(s => `  - ${s}`))
  }

  return parts.join('\n') + '\n'
}

// Renders the word bands from EMAIL_WORD_LIMITS so the prompt and the gate cannot drift.
function renderWordCountReminder(): string {
  const L = EMAIL_WORD_LIMITS
  return [
    `- Email 1: ${L.email1MinWords} to ${L.email1TargetMaxWords} words, hard cap ${L.email1MaxWords}. Under ${L.email1MinWords} is rejected.`,
    `- Email 2: ${L.email2MinWords} to ${L.email2MaxWords} words. It is NOT chained to Email 1's length.`,
    `- Email 3: ${L.email3MinWords} to ${L.email3MaxWords} words, and no longer than Email 2.`,
    `- Email 4: up to ${L.email4MaxWords} words. No minimum: a short breakup is fine.`,
    '- Counts include the {{first_name}} line and the sign-off name. They exclude the opt-out footer, which the platform adds later.',
    `- No SENTENCE may run over ${MAX_EMAIL_SENTENCE_WORDS} words. This is separate from the totals above: an email inside its band still fails if one sentence is too long. Split it into two rather than trimming words.`,
    '- Email 1 paragraph 2, the observation slot, must be exactly ONE sentence. It observes and does nothing else. The consequence, the bridge and any second observation do not belong in it.',
  ].join('\n')
}

/**
 * Renders the checks the previous attempt actually failed, so a retry is a correction
 * rather than a fresh sample.
 *
 * BEFORE THIS EXISTED, A RETRY WAS TOLD NOTHING. buildSingleVariantUserMessage received
 * the angle and the taken-copy list and no failure detail at all, so every attempt was an
 * independent draw from the same distribution. Measured 2026-08-28: variant B failed the
 * Email 2 word gate at 79, then 68, then 71, then 69 words across four consecutive
 * attempts, each one a full API call. Nothing in any of those prompts mentioned words.
 *
 * The violation strings already carry both numbers, because the gate formats them that
 * way: "word count 74 is outside the 30 to 85 word range". They are passed through
 * verbatim rather than summarised, so the model sees the measured value and the target
 * and does not have to infer either. A direction ("too long") would be a guess.
 */
export function buildPriorAttemptBlock(violations: readonly ValidationViolation[]): string {
  if (violations.length === 0) return ''
  const lines = violations.map(v => `- Email ${v.email}: ${v.issue}`).join('\n')
  return `

## WHAT THE PREVIOUS ATTEMPT GOT WRONG

The previous attempt at this variant was rejected by these checks, measured on the text it
returned. Each line gives the value measured and the target it missed.

${lines}

Fix exactly these. Keep everything the previous attempt got right: this is a correction,
not a fresh start. Do not shorten or rewrite anything the list above does not name.`
}

// Builds the user message for a single-variant retry or fallback call.
// Full context is always passed — no abbreviated context on retries.
function buildSingleVariantUserMessage(
  context: VariantGenerationContext,
  angleInstruction: string,
  taken: TakenCopy,
  // REQUIRED, deliberately not optional. An optional parameter is one a caller can forget,
  // and forgetting it here silently restores the blind-resample behaviour this fixes.
  // Pass [] only where there genuinely is no prior attempt.
  priorViolations: readonly ValidationViolation[],
): string {
  const { completenessNote, contextBlocks } = buildBaseContext(context)

  // Cross-variant uniqueness is unenforceable on the retry path unless the retry can see
  // what the surviving variants already used. Without this block a retried variant
  // collides with them by construction, because it is generated in isolation.
  const avoidBlock = buildAvoidBlock(taken)
  const priorAttemptBlock = buildPriorAttemptBlock(priorViolations)

  return `You are generating a single email sequence variant for the client described in the ICP document provided.
${completenessNote}

The three strategy documents below are your primary context. They contain everything you need
to write copy that is specific, grounded, and consistent. Do not invent details not present in them.

${contextBlocks}

---

## SINGLE-VARIANT SEQUENCE INSTRUCTION

Generate ONE email sequence variant. The angle assignment for Email 1 is:

${angleInstruction}

Apply all rules from the system prompt without exception: the Email 1 paragraph frame, word counts, TOV rules, banned structures, sign-off rules, and the four-email sequence structure (Email 1 observation and what changes, Email 2 pattern proof, Email 3 insight and meeting ask, Email 4 breakup).
${priorAttemptBlock}
${avoidBlock}
Critical reminders:
${renderWordCountReminder()}
- Do not count the words yourself. The platform recomputes word_count and subject_char_count from the text you return and validates the computed values. Write to the band, not to a number you report.
- Email 1 follows the paragraph frame: {{first_name}}, then the observation slot, then what changes, then the CTA question, then the sign-off. Each paragraph does its own job and none restates another.
- Nothing in Email 1 may depend on the paragraph above it. The observation slot is replaced
  per prospect, so read your P3 with P2 deleted and name anything left pointing at nothing.
  "We run it differently" fails. "We run outbound differently" passes.
- Nothing in Email 1 may depend on the paragraph above it, by demonstrative, pronoun or
  definite article. P2 is replaced per prospect. "We run it differently" fails: read with
  P2 gone, "it" points at nothing. Write "We run outbound differently". Bare it/they/them
  in P3 are rejected in code when the paragraph never names what they stand for.
- The offer line (Email 1 P3) names what the sender does and what changes for the prospect.
  It must not describe work the prospect still has to do, and must not explain their own
  job back to them. "You take the calls and close them" fails on both counts.
- No revenue, headcount or funding figures anywhere. Qualify the population by role, stage
  or situation. "at the £500K to £5M mark" and "billing north of £500K" both fail.
- Every sentence in YOUR EMAIL 1 must be new. Any sentence listed under ALREADY USED
  below is taken, and reusing one in Email 1 fails the gate and sends this variant back
  for regeneration. Emails 2, 3 and 4 are not checked for reuse.
- No I/We openers on the observation slot. One question per message. No em dashes.
- The sign-off block is mandatory on EVERY email and is TWO lines: "${context.preflight.sender_first_name}" then
  "${context.preflight.org_name}" directly beneath it. Both count toward the word count.
  Structure: [CTA question], blank line, ${context.preflight.sender_first_name}, newline, ${context.preflight.org_name}

Return ONLY the following JSON. No preamble. No markdown fencing. No explanation.
{
  "variant": {
    "emails": [/* 4 email objects */]
  }
}

Each email object must contain exactly these fields:
  sequence_position: integer 1-4
  subject_line: string for email 1 ONLY. null for emails 2, 3 and 4
  subject_char_count: integer for email 1, 0 for emails 2, 3 and 4
  body: full email body from {{first_name}} through the sign-off name
  word_count: integer (count the whole body, including the {{first_name}} line and the sign-off name)
  suggestion_reason: per-email notes (deliberate imperfection, unpopulated tokens, pronoun ratio shortfall)`
}

// ─── Claude API call ──────────────────────────────────────────────────────────

async function callClaude(userMessage: string, signal: AbortSignal): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      'Messaging agent: ANTHROPIC_API_KEY environment variable is not set. ' +
      'Add it to .env.local before running agents.'
    )
  }

  const client = new Anthropic({ apiKey })

  const systemPrompt = await loadSystemPrompt()

  // Use streaming to keep the TCP connection alive during long generations.
  // Without streaming, routers and macOS drop connections that look idle after ~180s,
  // even though the server is still working. Tokens arrive continuously in stream mode.
  // The signal is REQUIRED, not optional. It is what makes the 240s guard a control
  // rather than an announcement: without it an aborted run keeps streaming tokens until
  // the platform kills the function.
  const stream = client.messages.stream(
    {
      model: MESSAGING_MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    },
    { signal },
  )

  const message = await stream.finalMessage()

  const content = message.content.find(block => block.type === 'text')
  if (!content || content.type !== 'text') {
    throw new Error('Messaging agent: Claude returned no text content in response.')
  }

  return stripMarkdownFences(content.text.trim())
}

function stripMarkdownFences(text: string): string {
  const withoutOpen = text.replace(/^```(?:json)?\s*\n?/i, '')
  const withoutClose = withoutOpen.replace(/\n?```\s*$/i, '')
  return withoutClose.trim()
}

async function loadSystemPrompt(): Promise<string> {
  const { readFile } = await import('fs/promises')
  const { join } = await import('path')

  try {
    const promptPath = join(process.cwd(), 'docs', 'prompts', 'messaging-agent.md')
    const raw = await readFile(promptPath, 'utf-8')

    const systemPromptMarker = '## System Prompt'
    const idx = raw.indexOf(systemPromptMarker)
    if (idx === -1) {
      throw new Error(
        'Messaging agent: could not find "## System Prompt" section in messaging-agent.md'
      )
    }

    return raw.slice(idx + systemPromptMarker.length).trim()
  } catch (err) {
    throw new Error(`Messaging agent: failed to load system prompt — ${String(err)}`)
  }
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

// Parses the four-variant JSON structure returned by Claude on the initial call.
// Expected: { variants: { A: { emails: [...] }, B: { emails: [...] }, C: {...}, D: {...} } }
function parseVariantsFromClaude(raw: string): Record<string, EmailRecord[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      'Messaging agent: Claude returned invalid JSON for four-variant response. ' + String(err)
    )
  }

  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'variants' in parsed
  ) {
    const variants = (parsed as Record<string, unknown>).variants
    if (typeof variants === 'object' && variants !== null) {
      const result: Record<string, EmailRecord[]> = {}
      for (const [key, value] of Object.entries(variants as Record<string, unknown>)) {
        if (
          typeof value === 'object' &&
          value !== null &&
          'emails' in value &&
          Array.isArray((value as Record<string, unknown>).emails)
        ) {
          result[key] = (value as Record<string, unknown>).emails as EmailRecord[]
        }
      }
      if (Object.keys(result).length > 0) return result
    }
  }

  throw new Error(
    `Messaging agent: expected { variants: { A: { emails: [...] }, ... } }, got: ${typeof parsed}. ` +
    'Check that the system prompt correctly instructs four-variant JSON output.'
  )
}

// Parses the single-variant JSON returned by retry and fallback calls.
// Expected: { variant: { emails: [...] } }
function parseSingleVariantFromClaude(raw: string): EmailRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      'Messaging agent: single-variant retry — Claude returned invalid JSON. ' + String(err)
    )
  }

  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'variant' in parsed
  ) {
    const variant = (parsed as Record<string, unknown>).variant
    if (
      typeof variant === 'object' &&
      variant !== null &&
      'emails' in variant &&
      Array.isArray((variant as Record<string, unknown>).emails)
    ) {
      return (variant as Record<string, unknown>).emails as EmailRecord[]
    }
  }

  throw new Error(
    `Messaging agent: single-variant retry — expected { variant: { emails: [...] } }, got: ${typeof parsed}. ` +
    'Check that the single-variant instruction correctly specifies JSON output.'
  )
}

// ─── Post-processing ──────────────────────────────────────────────────────────

// Exported for direct unit testing.
export interface ValidationViolation {
  email: number
  issue: string
}

class MessagingValidationError extends Error {
  constructor(
    public readonly violations: ValidationViolation[],
    public readonly emails: EmailRecord[]
  ) {
    const lines = violations.map(v => `  Email ${v.email}: ${v.issue}`)
    super(`Messaging agent: post-processing validation failed.\n${lines.join('\n')}`)
    this.name = 'MessagingValidationError'
  }
}

// Runs the full post-processor on one variant's emails.
// Applies em-dash auto-fix, sign-off fix, then the 10-rule validation gate.
// Returns { passed } if clean, { failure } if violations remain.
// Named parameters, deliberately. Five of the six arguments were positional strings, so
// omitting one type-checked cleanly while shifting every later argument left. That is
// exactly what happened on the retry path: senderCompanyName received the organisation
// UUID and organisation_id received "retry-1". Named fields make it unrepresentable.
interface ProcessVariantParams {
  variantKey: string
  emails: EmailRecord[]
  senderFirstName: string
  senderCompanyName: string
  organisation_id: string
  attemptLabel?: string
}

async function processOneVariant({
  variantKey,
  emails,
  senderFirstName,
  senderCompanyName,
  organisation_id,
  attemptLabel,
}: ProcessVariantParams): Promise<{ passed: EmailRecord[] } | { failure: VariantFailure }> {
  const label = attemptLabel ? ` (${attemptLabel})` : ''

  if (emails.length !== 4) {
    const failure: VariantFailure = {
      variant: variantKey,
      violations: [{
        email: 0,
        issue: `Expected 4 emails, got ${emails.length}`,
      }],
    }
    return { failure }
  }

  const perEmail: Record<number, number> = {}
  let totalReplacements = 0
  const fixedEmails = emails.map(email => {
    const count = (email.body.match(/[—–]|--/g) ?? []).length
    const scrubbed = scrubAITells(email.body, `messaging/variant-${variantKey}/email-${email.sequence_position}`)
    if (count > 0) {
      perEmail[email.sequence_position] = count
      totalReplacements += count
    }
    return { ...email, body: scrubbed }
  })
  if (totalReplacements > 0) {
    const detail = Object.entries(perEmail)
      .map(([pos, n]) => `email ${pos} (${n})`)
      .join(', ')
    logger.info(
      `Messaging agent: Variant ${variantKey}${label} — replaced ${totalReplacements} em dash(es) across ${detail}`
    )
  }

  const { emails: signedEmails, fixed: signOffFixes } = applySignOffFix(fixedEmails, senderFirstName, senderCompanyName)
  if (signOffFixes > 0) {
    logger.info(
      `Messaging agent: Variant ${variantKey}${label} — auto-injected sign-off on ${signOffFixes} email(s)`
    )
  }

  // Overwrite the model's self-reported counts with computed ones. Must run after the
  // dash scrub and the sign-off fix, both of which change the body, and before
  // validateEmails, which gates on word_count.
  const countedEmails = recomputeCounts(signedEmails)

  // Report-only readability signal. Never gates: an over-threshold score is surfaced for
  // a human to judge, not used to reject a variant. See ADR note in nominalisation.ts.
  for (const email of countedEmails) {
    const score = nominalisationDensity(email.body)
    if (score.exceedsThreshold) {
      logger.warn('Messaging agent: abstract nominalisation density above threshold', {
        organisation_id,
        variant: variantKey,
        email: email.sequence_position,
        density: score.density,
        threshold: NOMINALISATION_THRESHOLD,
        matches: score.matches,
      })
    }
  }

  const violations = validateEmails(countedEmails, senderFirstName, senderCompanyName)
  if (violations.length > 0) {
    const failure: VariantFailure = { variant: variantKey, violations }
    logger.warn(`Messaging agent: Variant ${variantKey}${label} failed validation`, {
      variantKey,
      violations: violations.map(v => `Email ${v.email}: ${v.issue}`),
    })
    await saveFailedGeneration(
      countedEmails,
      violations,
      organisation_id,
      `${variantKey}${attemptLabel ? `-${attemptLabel}` : ''}`
    )
    return { failure }
  }

  // Return the array that was validated. Returning any earlier array would ship content
  // that differs from what the gate approved, which is how the opt-out footer went
  // missing from every stored document for months.
  return { passed: countedEmails }
}

// Processes all four variants from the initial Claude call.
// Cross-variant sentence reuse. This CANNOT live in validateEmails, which sees one
// variant at a time and by construction cannot know what the other three said.
//
// First writer wins: variants are checked in sorted key order, so the earliest variant
// keeps a sentence and every later variant that repeats it fails and is regenerated.
// Deterministic, so the same four raw variants always produce the same outcome.
// EMAIL 1 ONLY. Email 1 is where the four angles actually differ and where most replies
// originate, so that is where uniqueness earns its cost. Convergence in emails 2 to 4 is
// accepted deliberately.
//
// Applying it across all sixteen emails compounded: variant D had to avoid every sentence
// A, B and C had written anywhere, which made the last slot progressively harder to fill
// and drove retries and fallbacks. Narrowing it keeps the signal that matters and drops
// the failure rate.
const CROSS_VARIANT_UNIQUE_POSITION = 1

function findCrossVariantReuse(
  emails: EmailRecord[],
  registry: SentenceRegistry,
  variantKey: string,
  signOffLines: string[],
): ValidationViolation[] {
  const violations: ValidationViolation[] = []

  for (const email of emails) {
    if (email.sequence_position !== CROSS_VARIANT_UNIQUE_POSITION) continue
    for (const reuse of registry.findReuse(variantKey, email.body, signOffLines)) {
      violations.push({
        email: email.sequence_position,
        issue: `Email 1 sentence already used by variant ${reuse.firstSeenId}: "${reuse.sentence}". Email 1 is where the four angles differ, so a shared sentence there is a uniform fingerprint. Write a different one.`,
      })
    }
  }

  return violations
}

async function processAllVariants(
  rawVariants: Record<string, EmailRecord[]>,
  senderFirstName: string,
  senderCompanyName: string,
  organisation_id: string,
  registry: SentenceRegistry,
): Promise<{ passedVariants: Record<string, EmailRecord[]>; variantFailures: VariantFailure[] }> {
  const passedVariants: Record<string, EmailRecord[]> = {}
  const variantFailures: VariantFailure[] = []
  const signOffLines = [senderFirstName, senderCompanyName]

  // Sorted so "first writer wins" is stable rather than dependent on object key order.
  for (const variantKey of Object.keys(rawVariants).sort()) {
    const emails = rawVariants[variantKey]
    const result = await processOneVariant({ variantKey, emails, senderFirstName, senderCompanyName, organisation_id })
    if (!('passed' in result)) {
      variantFailures.push(result.failure)
      continue
    }

    const reuse = findCrossVariantReuse(result.passed, registry, variantKey, signOffLines)
    if (reuse.length > 0) {
      logger.warn(`Messaging agent: Variant ${variantKey} reuses sentences from an earlier variant`, {
        organisation_id,
        variantKey,
        violations: reuse.map(v => `Email ${v.email}: ${v.issue}`),
      })
      variantFailures.push({ variant: variantKey, violations: reuse })
      continue
    }

    passedVariants[variantKey] = result.passed
    for (const email of result.passed) {
      if (email.sequence_position !== CROSS_VARIANT_UNIQUE_POSITION) continue
      registry.register(variantKey, email.body, signOffLines)
    }
  }

  return { passedVariants, variantFailures }
}

// Category A (sign-off): the sign-off is a TWO-LINE block, sender first name then the
// sender's company name, on consecutive lines:
//
//     Doug
//     MargenticOS
//
// The company line gives the prospect something searchable without putting a link in the
// body. Both values come from the organisation record via preflight. Neither is ever
// hardcoded and neither is optional.
//
// The model consistently omits the sign-off on emails that end with a CTA question, so
// this repairs it deterministically rather than failing the variant for a fixable defect.
// Both values are known, so both can be appended.
export function applySignOffFix(
  emails: EmailRecord[],
  senderFirstName: string,
  senderCompanyName: string,
): { emails: EmailRecord[]; fixed: number } {
  let fixed = 0
  const result = emails.map(email => {
    if (hasSignOffBlock(email.body, senderFirstName, senderCompanyName)) return email

    fixed++

    // If the name is already the last line, the company line alone is missing. Append it
    // directly under the name rather than starting a second sign-off block.
    const nonEmptyLines = email.body.split('\n').map(l => l.trim()).filter(l => l.length > 0)
    const lastLine = nonEmptyLines[nonEmptyLines.length - 1] ?? ''
    if (lastLine.toLowerCase() === senderFirstName.toLowerCase()) {
      return { ...email, body: `${email.body.trimEnd()}\n${senderCompanyName}` }
    }

    return { ...email, body: `${email.body.trimEnd()}\n\n${senderFirstName}\n${senderCompanyName}` }
  })
  return { emails: result, fixed }
}

// True when the last two non-empty lines are the sender first name then the company name.
function hasSignOffBlock(
  body: string,
  senderFirstName: string,
  senderCompanyName: string,
): boolean {
  const lines = body.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  if (lines.length < 2) return false
  const last = lines[lines.length - 1] ?? ''
  const penultimate = lines[lines.length - 2] ?? ''
  return (
    penultimate.toLowerCase() === senderFirstName.toLowerCase() &&
    last.toLowerCase() === senderCompanyName.toLowerCase()
  )
}

// The opt-out footer is NOT applied here. It is appended at composition time by
// appendOptOutFooter in src/lib/composition/compose-sequence.ts, so every send carries it
// regardless of which messaging document version the copy came from. Documents therefore
// store footer-free bodies and no document needs a new version to become compliant.
// Do not reinstate a generation-time footer: it would double up with the composition one.

// Paragraph-position structural patterns: pronoun-dependent openers (reference back to the
// preceding paragraph, which gets replaced by a trigger sentence at composition time) and
// prescriptive-voice openers (tell the reader what their world should look like).
// Checked case-sensitively at paragraph-start for paragraphs 2+ only. Paragraph 1 is exempt.
// Prescriptive patterns listed first so more specific matches take precedence in Array.find().
const BANNED_PARAGRAPH_OPENERS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  // Prescriptive voice
  { pattern: /^That's what \w+ looks like/,  label: "That's what [word] looks like" },
  { pattern: /^A properly[- ]built/,          label: 'A properly-built / A properly built' },
  { pattern: /^What \w+ needs? is\b/,         label: 'What [word] need/needs is' },
  { pattern: /^The right way to/,             label: 'The right way to' },
  // Pronoun-dependent
  { pattern: /^That's what[\s\W]/,            label: "That's what" },
  { pattern: /^That's exactly[\s\W]/,         label: "That's exactly" },
  { pattern: /^That's the[\s\W]/,             label: "That's the" },
  { pattern: /^This is what[\s\W]/,           label: 'This is what' },
  { pattern: /^Such\s/,                       label: 'Such [word]' },
  { pattern: /^Like you said/,                label: 'Like you said' },
  { pattern: /^As I mentioned/,               label: 'As I mentioned' },
  { pattern: /^What I described/,             label: 'What I described' },
  { pattern: /^The reason is\b/,              label: 'The reason is' },
  { pattern: /^The answer is\b/,              label: 'The answer is' },
  { pattern: /^The result was\b/,             label: 'The result was' },
]

// Hard gate limits enforced by validateEmails. THE single source of truth.
// Exported so the agent prompt, the revision agent prompt and CLAUDE.md all render the
// same numbers. Do not restate these figures anywhere without importing them.
//
// Counting basis: the WHOLE body, including the {{first_name}} line and the sign-off
// name, measured with countWords from the composition layer. Agent and composition
// therefore agree exactly. Roughly 2 words of that total are structural rather than
// copy. The opt-out footer is appended after composition and is never counted.
export const EMAIL_WORD_LIMITS = {
  // 40, LOWERED FROM 50 ON 2026-09-19, for the reason Email 4's floor was deleted on
  // 2026-08-28: a floor that rejects complete, legal, well-formed emails for being short,
  // and costs a full regeneration call every time it fires.
  //
  // WHAT MADE 50 UNREACHABLE. Email 1 paragraph 2 became a ONE-SENTENCE observation slot,
  // and the bridge that used to share that paragraph was removed rather than relocated:
  // P3 is injected verbatim into the research writer's prompt as THE OFFER LINE, so
  // widening it would change what every client's research writer aims at. That removes 15
  // to 20 words from Email 1 and nothing absorbs them.
  //
  // MEASURED 2026-09-18, the run that failed: with a one-sentence slot the model produced
  // Email 1s of 46 and 41 words. Both were complete three-paragraph emails, inside every
  // other gate, rejected only for being short. Its only ways back over 50 were to restore
  // the bridge as a second sentence, which the slot rule rejects, or to fuse it into one
  // sentence, which came out at 30 and 36 words against a 25-word cap. Three gates with no
  // legal move between them: the run burned all 7 calls on variant A and wrote nothing.
  //
  // 40 is below the 41 that was measured and rejected, with a little room under it. It is
  // not a target: email1TargetMaxWords is untouched and the prompt still asks for 40 to 80.
  // A fallback Email 1 carrying an observation, an offer line and a question, with no
  // bridge, is SUPPOSED to be shorter than one that carried a bridge too.
  //
  // THIS IS THE FALLBACK'S FLOOR, and the fallback ships roughly one send in ten. The
  // researched path replaces the slot with an observation AND a bridge as two paragraphs,
  // so it lands well above this number and never approaches the floor.
  email1MinWords: 40,
  email1TargetMaxWords: 80,   // advisory target rendered into the prompt
  email1MaxWords: 90,         // hard cap
  email2MinWords: 30,
  // 85, and DECOUPLED from Email 1. Email 2 used to be capped at 70 AND required to be no
  // longer than Email 1, so its real cap was whatever Email 1 happened to land at. The
  // model cannot see that number while writing, which made the target unhittable by
  // construction rather than by difficulty. Measured 2026-08-28 across 15 first-pass and
  // retry attempts in two runs: Email 2 came in at 62 to 79 words (mean 72.3, sd 4.2) while
  // Email 1 landed 56 to 71, so 10 of 15 breached the 70 band outright and the other 5
  // breached only the coupling. Every one of those 15 fits inside 85, which is mean + 3sd.
  //
  // The intent that survives: a follow-up carrying relevance is stacking, and stacking
  // raises reply odds. Emails 3 and 4 keep their own tighter bands, so the sequence still
  // tapers without Email 2 being chained to a number it cannot read.
  email2MaxWords: 85,
  email3MinWords: 30,
  email3MaxWords: 70,
  // NO FLOOR ON EMAIL 4. A breakup email is allowed to be very short: brevity is the
  // register. The old floor of 30 rejected variants at 26 and 29 words, which were not
  // defects, and each rejection cost a full regeneration call. Zero rather than deleting
  // the field so WORD_BANDS keeps one shape for all four positions.
  email4MinWords: 0,
  email4MaxWords: 50,
} as const

// ALL FOUR EMAILS THREAD. Only Email 1 carries a subject. Emails 2, 3 and 4 send with a
// null subject so the whole sequence sits in one thread, which means a reader who ignored
// the first three can scroll up from the breakup and see who is writing and why.
//
// email4MaxChars is GONE, and so is the rule requiring four distinct Email 4 subjects.
// Both existed only to make a separate Email 4 subject workable: the cap was 9 characters,
// which left "last note" as the only string that fitted and shipped an identical subject
// across all four variants. Raising it to 24 fixed the collision but kept the underlying
// mistake, which was giving Email 4 a subject at all and breaking the thread.
export const EMAIL_SUBJECT_LIMITS = {
  email1MaxChars: 40,
} as const

// One question per email. The CTA is the question. Rhetorical questions count.
export const MAX_QUESTIONS_PER_EMAIL = 1

// Firmographic figures are banned in both the messaging agent and the research writer,
// so the patterns live in one shared module. See src/lib/style/firmographic.ts for the
// full reasoning and the false-positive boundaries.

// Internal vocabulary that must never reach a prospect. These are the words we use to
// describe the work to each other, not words the buyer introduced. "ICP" shipped in a
// variant B email 3 ("they fix their outreach before they fix their ICP"), which tells
// the reader they are being processed by a system rather than written to.
// Word-boundary matched so "positioning" inside ordinary prose is untouched.
const BANNED_JARGON: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bICPs?\b/,                    label: 'ICP' },
  { pattern: /\btop[- ]of[- ]funnel\b/i,     label: 'top of funnel' },
  { pattern: /\bTOFU\b/,                     label: 'TOFU' },
  { pattern: /\bbuyer persona\b/i,           label: 'buyer persona' },
  { pattern: /\bvalue prop(osition)?\b/i,    label: 'value prop' },
  { pattern: /\bgo[- ]to[- ]market\b/i,      label: 'go-to-market' },
  { pattern: /\bfunnel metrics\b/i,          label: 'funnel metrics' },
]

// Per-position word bands, derived from EMAIL_WORD_LIMITS so there is one place to edit.
const WORD_BANDS: Record<number, { min: number; max: number }> = {
  1: { min: EMAIL_WORD_LIMITS.email1MinWords, max: EMAIL_WORD_LIMITS.email1MaxWords },
  2: { min: EMAIL_WORD_LIMITS.email2MinWords, max: EMAIL_WORD_LIMITS.email2MaxWords },
  3: { min: EMAIL_WORD_LIMITS.email3MinWords, max: EMAIL_WORD_LIMITS.email3MaxWords },
  4: { min: EMAIL_WORD_LIMITS.email4MinWords, max: EMAIL_WORD_LIMITS.email4MaxWords },
}

// ─── Readability: sentence length ─────────────────────────────────────────────
//
// THE SAME MODULE THE RESEARCH WRITER IS JUDGED BY. readability.ts has hard-gated
// research synthesis since it was written: an observation with a sentence over
// MAX_SENTENCE_WORDS is demoted, and a trigger that fails is dropped to mention_only.
// The messaging agent imported nominalisation, back-reference, firmographic and
// sentence-frames from the same folder and never imported this one, so the TEMPLATE
// copy shipped sentences the researched copy written beside it would have been rejected
// for. Both halves land in the same email, which is where the inconsistency is visible.
//
// IMPORTED, NEVER REIMPLEMENTED. splitSentences in readability.ts is the only definition
// of a sentence in this codebase, and a second one here would drift the day either moved.
//
// GATED ON SENTENCE LENGTH ONLY, deliberately. readabilityScore.hardFail is true for an
// over-long sentence OR a hedge phrase, and this check must NOT read hardFail: hedging
// would reject 104 of the 320 emails across every messaging document ever written
// (32.5%, measured 2026-09-17), almost all of it the single words "usually" (64) and
// "often" (40). That is a separate decision about copy, not a readability bug, and it is
// reported below rather than enforced. Nominalisation stays a log line for the reason its
// own module gives: suffix matching cannot tell "attention" from "question".
//
// MEASURED BEFORE SHIPPING, across all 20 messaging documents in production, 320 emails:
// 60 (18.8%) carry a sentence over the cap, and 59 of those 60 are Email 1 or Email 2.
// Emails 3 and 4 fail once in 160, because their word bands (30-70 and 0-50) already
// force short sentences where Email 1 at 90 and Email 2 at 85 do not. Every document from
// April onward fails at least one email, so this is a standing defect and not a
// regression in the current copy.
const MAX_EMAIL_SENTENCE_WORDS = MAX_SENTENCE_WORDS

// The prose surface a sentence cap applies to. Three lines are removed first, and none of
// them is prose:
//
//   {{first_name}}   a merge tag with no sentence terminator, so splitSentences joins it
//                    to the first real sentence and adds a word to it. Measured across the
//                    same 320 emails: scanning the raw body fails 72 emails against 60 for
//                    the prose, so 12 of those 72 are the greeting rather than the copy.
//   the sign-off     two name lines, likewise unterminated, which attach to the CTA.
//
// This chooses WHICH SURFACE to scan, in the same way the firmographic check scans a
// (body, subject) pair. It does not redefine a sentence: the text that survives goes to
// readabilityScore unmodified.
export function emailProse(body: string, senderFirstName: string, senderCompanyName: string): string {
  return body
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      if (/^\{\{first_name\}\},?$/.test(trimmed)) return false
      if (trimmed.toLowerCase() === senderFirstName.toLowerCase()) return false
      if (trimmed.toLowerCase() === senderCompanyName.toLowerCase()) return false
      return true
    })
    .join('\n')
}

// Replaces the model's self-reported word_count and subject_char_count with computed
// values, before validation and before storage.
//
// Both fields used to be whatever the model claimed. Nothing checked them, so a model
// that undercounted passed the word gate with an over-long email, and subject_char_count
// was displayed to the client without ever being verified. countWords is imported from
// the composition layer so the agent and composition measure identically.
export function recomputeCounts(emails: EmailRecord[]): EmailRecord[] {
  return emails.map(email => ({
    ...email,
    word_count: countWords(email.body),
    subject_char_count: email.subject_line ? email.subject_line.length : 0,
  }))
}

// Category B: collect all violations across all four emails. Returns empty array if clean.
// Exported for direct unit testing.
export function validateEmails(
  emails: EmailRecord[],
  senderFirstName: string,
  senderCompanyName: string,
): ValidationViolation[] {
  const violations: ValidationViolation[] = []

  for (const email of emails) {
    const pos = email.sequence_position
    const body = email.body
    const nonEmptyLines = body.split('\n').map(l => l.trim()).filter(l => l.length > 0)

    if (body.includes('[FIRST_NAME]')) {
      violations.push({ email: pos, issue: 'contains old [FIRST_NAME] merge tag — must be {{first_name}}' })
    }

    // Find the actual opening sentence — always the first non-empty line after {{first_name}}.
    // Never check {{first_name}} itself or any line before it.
    const firstNameLineIdx = nonEmptyLines.findIndex(l => l === '{{first_name}}')
    const openerLine = firstNameLineIdx >= 0
      ? (nonEmptyLines.slice(firstNameLineIdx + 1).find(l => l.length > 0) ?? '')
      : (nonEmptyLines.find(l => l !== '{{first_name}}' && l.length > 0) ?? '')
    if (/^(i|we)\s/i.test(openerLine)) {
      violations.push({
        email: pos,
        issue: `opener starts with "${openerLine.split(' ')[0]}" — I/We openers are banned`,
      })
    }

    // Paragraph independence: paragraphs 2+ must not open with pronoun-dependent or
    // prescriptive-voice patterns. Split by blank lines, filter the {{first_name}} greeting
    // chunk, skip index 0 (the opener — exempt, gets replaced at composition time).
    const rawChunks = body.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 0)
    const contentParas = rawChunks.filter(p => !/^\{\{first_name\}\},?\s*$/.test(p))
    for (let pIdx = 1; pIdx < contentParas.length; pIdx++) {
      const para = contentParas[pIdx]
      const paraNorm = para.replace(/[''ʼ‘’ʼ]/g, "'")
      const hit = BANNED_PARAGRAPH_OPENERS.find(({ pattern }) => pattern.test(paraNorm))
      if (hit) {
        const preview = para.split(/\s+/).slice(0, 6).join(' ')
        violations.push({
          email: pos,
          issue: `paragraph ${pIdx + 1} opens with "${hit.label}" pattern — pronoun-dependent or prescriptive voice at non-opener paragraph start is banned. Opening: "${preview}..."`,
        })
      }
    }

    // Mid-sentence back-references. BANNED_PARAGRAPH_OPENERS above only matches patterns
    // at a paragraph's START, which is why "We break that ceiling by..." shipped: the
    // demonstrative sits four words in.
    //
    // EMAIL 1 ONLY. The whole justification is that P2 is replaced at composition, and
    // applyTriggerToEmail1 touches nothing but Email 1. In emails 2, 3 and 4 every
    // paragraph ships exactly as written, so a demonstrative pointing at the paragraph
    // above is ordinary English and rejecting it is wrong. Gating all four positions
    // cost a whole variant: several regeneration attempts failed only on an Email 2
    // back-reference, and variant C was dropped after exhausting its retries.
    //
    // Still reported for emails 2 to 4, because a pile of them is a readability smell
    // worth seeing in the logs, just never a reason to reject copy.
    // THE EXEMPTION IS THE SLOT. Every paragraph in the slot is replaced together at
    // composition, so a demonstrative in the consequence pointing at the observation above
    // it is pointing at text that always ships with it. Passing 1 here against a
    // two-paragraph slot would hard-fail the consequence for saying "those relationships",
    // which is what naming a consequence requires.
    const slotParagraphs = pos === 1 && contentParas.length > EMAIL1_FRAME_TAIL_PARAGRAPHS
      ? Math.max(1, contentParas.length - EMAIL1_FRAME_TAIL_PARAGRAPHS)
      : 1
    const backRefs = findBackReferences(body, slotParagraphs)
    if (pos === 1) {
      for (const hit of backRefs.demonstratives) {
        violations.push({
          email: pos,
          issue: `paragraph ${hit.paragraph} contains back-reference "${hit.phrase}". A demonstrative binding a noun points at the paragraph above, which is replaced at composition. Name the subject instead.`,
        })
      }
      // Bare pronouns in P3 whose antecedent can only be in the replaced slot.
      // "We run it differently" reads as "run WHAT differently" once a researched
      // observation takes P2's place. Gated at P3 only, where P2 is the sole possible
      // referent; measured at 1 hit across 27 real Email 1s, and that hit was the bug.
      for (const hit of backRefs.unanchoredPronouns) {
        violations.push({
          email: pos,
          issue: `paragraph ${hit.paragraph} uses the bare pronoun "${hit.pronoun}" with nothing in that paragraph for it to refer to, so it can only point at the observation slot, which is replaced per prospect. Name the thing instead. Offending sentence: "${hit.context}"`,
        })
      }
      if (backRefs.ambiguousPronouns.length > 0) {
        logger.debug('Messaging agent: pronouns that may lean on an earlier paragraph (not gated)', {
          email: pos,
          pronouns: backRefs.ambiguousPronouns.map(h => `P${h.paragraph} ${h.pronoun}`),
        })
      }
    } else if (backRefs.demonstratives.length > 0) {
      logger.debug('Messaging agent: back-references in a follow-up email (not gated)', {
        email: pos,
        phrases: backRefs.demonstratives.map(h => h.phrase),
      })
    }

    // Ampersands belong in company names, not in prose. Variant D email 2 shipped
    // "targeting & messaging", which reads as note-taking rather than writing.
    if (/\s&\s/.test(body)) {
      violations.push({
        email: pos,
        issue: 'body uses an ampersand in prose. Write "and"',
      })
    }

    // Revenue, headcount, funding figures and internal jargon, over BOTH the body and the
    // subject line.
    //
    // THE SUBJECT USED TO BE EXEMPT, and not on purpose. Both bans were written as
    // `test(body)` and the subject was checked for length and null-ness only, so
    // "£500k revenue question" passed a validator that already owned every pattern needed
    // to catch it. The detector was never pointed at the line every recipient reads,
    // including the ones who open nothing. checkSubjectGates in write-opening.ts closed
    // the same hole for the GENERATED subject and said so in its own comment; this closes
    // it for the AUTHORED one.
    //
    // ONE LOOP OVER A PAIR, not two copies keyed on a field name. The defect was two
    // near-identical blocks that both said `body`, which is the shape where adding a third
    // scanned surface means remembering to edit two places. There is now no way to scan a
    // surface for firmographics without also scanning it for jargon, and no index
    // arithmetic to get wrong.
    //
    // A HIT REJECTS THE VARIANT, exactly as a body hit does. A subject is one line and the
    // regeneration costs one call against MAX_ANTHROPIC_CALLS, which is a real cost. It is
    // still the right call: there is no fallback subject to drop back to the way the
    // research writer can discard a generated subject and keep the authored one, so
    // report-only here means the figure ships. Measured before the change: 0 of 32 subject
    // lines across all 5 active messaging documents would fail, so the expected retry rate
    // is not what the budget was written to defend against.
    const scanned: ReadonlyArray<{ surface: 'body' | 'subject line'; text: string }> = [
      { surface: 'body', text: body },
      { surface: 'subject line', text: email.subject_line ?? '' },
    ]

    for (const { surface, text } of scanned) {
      if (!text) continue

      for (const term of BANNED_FIRMOGRAPHIC) {
        if (term.pattern.test(text)) {
          violations.push({
            email: pos,
            issue: `${surface} quotes ${term.label} from the prospect's firmographic record. Qualify the population by role, stage or situation instead. The revenue band belongs in targeting, not in the email.`,
          })
        }
      }

      // Internal jargon the buyer never introduced. "ICP" is our word for their customers.
      for (const term of BANNED_JARGON) {
        if (term.pattern.test(text)) {
          violations.push({
            email: pos,
            issue: `${surface} uses internal jargon "${term.label}". The buyer did not introduce this word. Say it in their language.`,
          })
        }
      }
    }

    // word_count is recomputed from the body by recomputeCounts before validation, so
    // this gate measures the actual text rather than the model's own claim about it.
    const wc = email.word_count
    const band = WORD_BANDS[pos]
    if (band && (wc < band.min || wc > band.max)) {
      violations.push({
        email: pos,
        issue: `word count ${wc} is outside the ${band.min} to ${band.max} word range`,
      })
    }

    // Sentence length, measured by the research module. See MAX_EMAIL_SENTENCE_WORDS.
    const readability = readabilityScore(
      emailProse(body, senderFirstName, senderCompanyName),
      MAX_EMAIL_SENTENCE_WORDS,
    )
    for (const sentence of readability.longSentences) {
      violations.push({
        email: pos,
        issue: `sentence runs ${countWords(sentence)} words, cap is ${MAX_EMAIL_SENTENCE_WORDS}. A sentence a thirteen-year-old follows on first read. Two short sentences beat one long one, so split it rather than trimming words. Offending sentence: "${sentence}"`,
      })
    }

    // ─── Email 1's observation slot is ONE sentence ───────────────────────────
    //
    // EMAIL 1 ONLY, and its FIRST content paragraph only. That paragraph is the slot
    // applyTriggerToEmail1 replaces per prospect; every other paragraph ships as authored.
    //
    // WHY ONE SENTENCE. The slot has exactly one job: observe. The research writer is held
    // to the same rule and is told so in the strongest terms its prompt contains: "The
    // observation and the bridge are SEPARATE PARAGRAPHS with a blank line between them.
    // They are not one paragraph and they are never run together. Each one gets its own
    // line of white space, which is what stops you cramming two jobs into one sentence."
    // The authored template was under no such rule, so it fused the two, and the fallback
    // that ships when research fails was the only opening in the system doing that.
    //
    // MEASURED 2026-09-17 across every messaging document in production plus the pending
    // suggestion, 84 Email 1 slots: 62 (73.8%) hold more than one sentence. 22 hold one.
    // Distribution 1:22, 2:31, 3:22, 4:9.
    //
    // COUNTING ONLY, exactly like the word cap above. splitSentences is imported from
    // readability.ts rather than restated, so there is still one definition of a sentence
    // in this codebase. Nothing here reads meaning: a two-sentence slot fails whether the
    // second sentence is a bridge, a second observation or a joke.
    //
    // PARAGRAPH 0 IS DERIVED THE SAME WAY getVariantEmail1Frame DERIVES IT — split on blank
    // lines, drop the greeting. If the two ever disagree about which paragraph is the slot,
    // this gate protects a different paragraph than composition replaces, which is worse
    // than no gate. contentParas above is that derivation and is reused rather than repeated.
    if (pos === 1 && contentParas.length > EMAIL1_FRAME_TAIL_PARAGRAPHS) {
      const slotLength = contentParas.length - EMAIL1_FRAME_TAIL_PARAGRAPHS
      const SLOT_JOBS = ['observation', 'consequence']

      if (!EMAIL1_FRAME_SLOT_PARAGRAPHS.includes(slotLength as 1 | 2)) {
        violations.push({
          email: pos,
          issue: `Email 1's observation slot is ${slotLength} paragraphs. It must be ${EMAIL1_FRAME_SLOT_PARAGRAPHS.join(' or ')}: the observation on its own, optionally followed by the consequence as a separate paragraph. The last three paragraphs are always the offer line, the CTA question and the sign-off.`,
        })
      } else {
        for (let i = 0; i < slotLength; i++) {
          const sentences = splitSentences(contentParas[i])
          if (sentences.length > 1) {
            violations.push({
              email: pos,
              issue: `Email 1's ${SLOT_JOBS[i]} paragraph must be ONE sentence. It has ${sentences.length}. The slot is replaced per prospect and each paragraph in it carries exactly one job. Keep the first sentence and move anything else into its own paragraph or delete it: "${sentences[0]}"`,
            })
          }
        }
      }
    }

    // REPORT ONLY, both of them. Neither gates. See MAX_EMAIL_SENTENCE_WORDS for why
    // hedging is not enforced in the same change as the cap.
    if (readability.hedges.length > 0) {
      logger.debug('Messaging agent: hedging phrases (reported, not gated)', {
        email: pos,
        hedges: readability.hedges,
      })
    }
    if (readability.nominalisation.exceedsThreshold) {
      logger.debug('Messaging agent: nominalisation density above threshold (reported, not gated)', {
        email: pos,
        density: readability.nominalisation.density,
        matches: readability.nominalisation.matches,
      })
    }

    // Email 3 must be no longer than Email 2. Email 2 is NO LONGER CHAINED TO EMAIL 1.
    //
    // Why Email 2 was released: the model writes all four emails in one response and
    // cannot measure Email 1 while writing Email 2, so this gate asked it to hit a target
    // it could not see. It cost eight failed API calls in a single run on 2026-08-28,
    // each one a full single-variant regeneration, which is what exhausted the 240s guard.
    // A follow-up at 74 words against an opener at 62 is not something a reader notices.
    //
    // Email 3 keeps the constraint deliberately, not by omission. It is the same shape and
    // carries the same risk, but it binds far less often now that Email 2 may run to 85:
    // the constraint only bites when Email 2 lands near its floor. Logged in BACKLOG.
    //
    // NOT LONGER THAN, not strictly shorter. Equal-length pairs pass.
    if (pos === 3) {
      const prev = emails.find(e => e.sequence_position === pos - 1)
      if (prev && wc > prev.word_count) {
        violations.push({
          email: pos,
          issue: `word count ${wc} is longer than email ${pos - 1} at ${prev.word_count} words`,
        })
      }
    }

    if (pos === 1 && email.subject_line !== null && email.subject_line.length > EMAIL_SUBJECT_LIMITS.email1MaxChars) {
      violations.push({
        email: pos,
        issue: `subject line "${email.subject_line}" is ${email.subject_line.length} chars, limit is ${EMAIL_SUBJECT_LIMITS.email1MaxChars}`,
      })
    }

    // Emails 2, 3 AND 4 thread under Email 1. Only Email 1 carries a subject.
    if ((pos === 2 || pos === 3 || pos === 4) && email.subject_line !== null) {
      violations.push({
        email: pos,
        issue: `subject line must be null for threading, got "${email.subject_line}"`,
      })
    }

    // One question maximum per email. The rule has always been in the prompt and was
    // never enforced, so a variant shipped with two questions in Email 1.
    //
    // Counted on the DOCUMENT body, which has no opt-out footer: the footer is appended
    // later at composition and itself contains a question mark. If the footer is ever
    // moved back to generation time, this check has to start excluding it.
    const questionMarks = (body.match(/\?/g) ?? []).length
    if (questionMarks > MAX_QUESTIONS_PER_EMAIL) {
      violations.push({
        email: pos,
        issue: `contains ${questionMarks} questions, limit is ${MAX_QUESTIONS_PER_EMAIL}. The CTA is the only question. Rhetorical questions count.`,
      })
    }

    // The sign-off is a two-line block: sender first name, then the sender's company name.
    // The company line is mandatory. An email ending with only the first name fails.
    const lastLine = nonEmptyLines[nonEmptyLines.length - 1] ?? ''
    const penultimateLine = nonEmptyLines[nonEmptyLines.length - 2] ?? ''
    if (penultimateLine.toLowerCase() !== senderFirstName.toLowerCase()) {
      violations.push({
        email: pos,
        issue: `missing or incorrect sign-off name. Second-to-last line is "${penultimateLine}", expected "${senderFirstName}"`,
      })
    }
    if (lastLine.toLowerCase() !== senderCompanyName.toLowerCase()) {
      violations.push({
        email: pos,
        issue: `missing or incorrect sign-off company line. Last line is "${lastLine}", expected "${senderCompanyName}". The company name is mandatory on every email.`,
      })
    }

    const bannedMatch = body.match(/\bAI\b|\bautomated\b|\bbot\b|artificial intelligence/i)
    if (bannedMatch) {
      violations.push({
        email: pos,
        issue: `contains banned word "${bannedMatch[0]}" — must not reference AI, automation, or bots`,
      })
    }

    // Scan body and subject line for unsupported merge tags.
    // Only {{first_name}} is permitted in MargenticOS sequences.
    // Other tags (including snake_case like {{company_name}}) are not supported by Instantly.
    const allText = [body, email.subject_line ?? ''].join('\n')
    const tagMatches = [...allText.matchAll(/\{\{([^}]+)\}\}/g)]
    for (const match of tagMatches) {
      const tag = match[0]
      if (tag !== '{{first_name}}') {
        violations.push({
          email: pos,
          issue: `unsupported merge tag "${tag}" — only {{first_name}} is permitted; Instantly does not support this tag`,
        })
      }
    }
  }

  return violations
}

async function saveFailedGeneration(
  emails: EmailRecord[],
  violations: ValidationViolation[],
  organisation_id: string,
  variantKey?: string
): Promise<void> {
  logger.warn('Messaging agent: variant failed validation — full detail', {
    organisation_id,
    variantKey,
    violations: violations.map(v => `Email ${v.email}: ${v.issue}`),
  })
}

// ─── Retry logic ──────────────────────────────────────────────────────────────

/**
 * The ordered repair steps available to one slot: every attempt on its original angle
 * first, then every attempt on each fallback angle in turn.
 *
 * Flattening the two nested loops into a list is what makes breadth-first possible. The
 * ORDER WITHIN A SLOT IS UNCHANGED by that flattening: a slot still exhausts its own angle
 * before it will accept a fallback, which is the whole point of the hierarchy.
 */
export function repairStepCount(fallbackAngles = FALLBACK_ANGLES.length): number {
  return MAX_RETRY_ATTEMPTS * (1 + fallbackAngles)
}

/**
 * BREADTH-FIRST REPAIR. Every failing slot gets its first repair before any slot gets its
 * second, then a second round if the budget survives, and so on.
 *
 * WHY. Depth-first ran one slot through its entire hierarchy before touching the next, so
 * a slot that kept failing spent the whole run. Measured 2026-09-20: variant A was repaired
 * in one attempt, variant B then consumed five, and C and D were never attempted at all.
 * Four slots each needing one correction cost four calls; one slot needing six costs six
 * and leaves nothing. The budget is unchanged at MAX_API_CALLS_PER_RUN. This only changes
 * the order it is spent in, so a run that can fix everything cheaply now does.
 *
 * PURE SCHEDULING, NO API. `attempt` makes the call and says whether the slot is settled;
 * `hasBudget` is read immediately before each attempt because the counter it reads is
 * shared and moves underneath this loop. Both are injected so the ordering can be tested
 * without a network, an API key, or a model.
 *
 * Slots are attempted in the order given, which the caller sorts, so a run is reproducible.
 */
export async function scheduleRepairsBreadthFirst(params: {
  slots: readonly string[]
  stepsPerSlot: number
  hasBudget: () => boolean
  /** Returns true when the slot is settled and needs no further rounds. */
  attempt: (slot: string, step: number) => Promise<boolean>
  /** Called for each slot still unsettled when the budget runs out. */
  onBudgetExhausted?: (slot: string) => void
  /** Called for each slot that used every step in its plan without settling. */
  onStepsExhausted?: (slot: string) => void
}): Promise<void> {
  const { slots, stepsPerSlot, hasBudget, attempt, onBudgetExhausted, onStepsExhausted } = params
  const settled = new Set<string>()

  for (let step = 0; step < stepsPerSlot; step++) {
    for (const slot of slots) {
      if (settled.has(slot)) continue

      if (!hasBudget()) {
        // Every slot that never got its turn is reported, not just the one in hand.
        for (const remaining of slots) {
          if (!settled.has(remaining)) {
            settled.add(remaining)
            onBudgetExhausted?.(remaining)
          }
        }
        return
      }

      if (await attempt(slot, step)) settled.add(slot)
    }
  }

  for (const slot of slots) {
    if (!settled.has(slot)) onStepsExhausted?.(slot)
  }
}

// Retries a single failing variant slot through the full hierarchy:
//   1. Up to MAX_RETRY_ATTEMPTS on the original angle
//   2. Up to MAX_RETRY_ATTEMPTS on each fallback angle, in order
// Returns the first passing result, or null if all attempts are exhausted.
/** Per-slot state carried ACROSS rounds, because a round only makes one attempt. */
interface SlotRepairState {
  variant: string
  /** Violations from the attempt that sent this slot here, then from each attempt after. */
  lastViolations: readonly ValidationViolation[]
  apiCallsUsed: number
}

/**
 * Which angle a slot uses on a given repair step, and what to call the attempt.
 *
 * Steps 0..MAX_RETRY_ATTEMPTS-1 are the slot's own angle. Everything after that walks the
 * fallback angles, MAX_RETRY_ATTEMPTS each. Derived from one index so the breadth-first
 * scheduler can hold a single number per slot rather than a loop position.
 */
function repairStepFor(variantKey: string, step: number):
  | { angle: string; fallbackName: string | null; attemptInAngle: number; label: string }
  | null {
  const original = VARIANT_ANGLE_INSTRUCTIONS[variantKey]
  if (!original) return null

  if (step < MAX_RETRY_ATTEMPTS) {
    const attemptInAngle = step + 1
    return { angle: original, fallbackName: null, attemptInAngle, label: `retry-${attemptInAngle}` }
  }

  const afterOriginal = step - MAX_RETRY_ATTEMPTS
  const fallback = FALLBACK_ANGLES[Math.floor(afterOriginal / MAX_RETRY_ATTEMPTS)]
  if (!fallback) return null
  const attemptInAngle = (afterOriginal % MAX_RETRY_ATTEMPTS) + 1
  return {
    angle: fallback.instruction,
    fallbackName: fallback.name,
    attemptInAngle,
    label: `fallback-${fallback.name}-attempt-${attemptInAngle}`,
  }
}

/**
 * ONE repair attempt for one slot. Was two nested loops inside a per-slot function; it is
 * now a single step so the scheduler decides the order and this decides the content.
 *
 * Returns the emails when the attempt passes, null when it does not. The slot's outcome is
 * recorded by the caller, which is the only place that knows whether more steps remain.
 */
async function attemptSlotRepair(
  state: SlotRepairState,
  step: number,
  context: VariantGenerationContext,
  organisation_id: string,
  taken: TakenCopy,
  registry: SentenceRegistry,
  signal: AbortSignal,
  runStats: RunStats,
): Promise<{ emails: EmailRecord[]; outcome: SlotOutcome } | null> {
  const variantKey = state.variant
  const plan = repairStepFor(variantKey, step)
  if (!plan) return null

  const senderFirstName = context.preflight.sender_first_name
  const senderCompanyName = context.preflight.org_name
  const signOffLines = [senderFirstName, senderCompanyName]

  logger.info(
    plan.fallbackName
      ? `Messaging agent: Variant ${variantKey} — fallback "${plan.fallbackName}" attempt ${plan.attemptInAngle}/${MAX_RETRY_ATTEMPTS}`
      : `Messaging agent: Variant ${variantKey} — retry ${plan.attemptInAngle}/${MAX_RETRY_ATTEMPTS} on original angle`,
    { organisation_id, variantKey, attempt: plan.attemptInAngle, fallbackName: plan.fallbackName ?? undefined },
  )

  // Checked BEFORE the counter so an aborted run does not report a call it never made.
  throwIfAborted(signal)
  state.apiCallsUsed++
  runStats.totalApiCalls++

  try {
    const userMessage = buildSingleVariantUserMessage(context, plan.angle, taken, state.lastViolations)
    const raw = await callClaude(userMessage, signal)
    const emails = parseSingleVariantFromClaude(raw)
    const result = await processOneVariant({
      variantKey, emails, senderFirstName, senderCompanyName, organisation_id,
      attemptLabel: plan.label,
    })

    // Carry THIS attempt's measured violations into the next one. Without this every
    // attempt would keep re-sending the first-pass failure, which goes stale the moment
    // attempt 1 fails a different check.
    if (!('passed' in result)) {
      state.lastViolations = result.failure.violations
      return null
    }

    // A repair that passes its own validation can still collide with an already-accepted
    // variant, so the cross-variant check runs here too. The collision IS the next
    // attempt's feedback; without that the next attempt is told nothing and can collide
    // the same way again.
    const reuse = findCrossVariantReuse(result.passed, registry, variantKey, signOffLines)
    if (reuse.length > 0) {
      logger.warn(
        `Messaging agent: Variant ${variantKey} ${plan.label} passed validation but reuses an accepted variant's sentence`,
        { organisation_id, variantKey, violations: reuse.map(v => `Email ${v.email}: ${v.issue}`) },
      )
      state.lastViolations = reuse
      return null
    }

    if (plan.fallbackName) {
      logger.info(
        `Messaging agent: Variant ${variantKey} shipped on fallback angle "${plan.fallbackName}", attempt ${plan.attemptInAngle}. Slot label ${variantKey} no longer describes its angle.`,
        { organisation_id, variantKey, fallbackName: plan.fallbackName, attempt: plan.attemptInAngle },
      )
    } else {
      logger.info(
        `Messaging agent: Variant ${variantKey} passed on retry attempt ${plan.attemptInAngle}`,
        { organisation_id, variantKey, attempt: plan.attemptInAngle },
      )
    }

    return {
      emails: result.passed,
      outcome: plan.fallbackName
        ? {
            variant: variantKey,
            result: 'fallback',
            retryAttempts: MAX_RETRY_ATTEMPTS,
            fallbackName: plan.fallbackName,
            fallbackAttempt: plan.attemptInAngle,
            apiCallsUsed: state.apiCallsUsed,
            // The slot keeps its key for assignment, but the angle that actually shipped
            // is the fallback. Recorded so the label is never a lie.
            shippedAngle: plan.fallbackName,
          }
        : {
            variant: variantKey,
            result: 'retry',
            retryAttempts: plan.attemptInAngle,
            apiCallsUsed: state.apiCallsUsed,
            shippedAngle: variantKey,
          },
    }
  } catch (err) {
    // An abort is not a bad attempt. Rethrow so the run stops here.
    if (err instanceof MessagingAbortedError) throw err
    throwIfAborted(signal)
    logger.warn(
      `Messaging agent: Variant ${variantKey} ${plan.label} error — ${String(err)}`,
      { organisation_id, variantKey },
    )
    return null
  }
}

/** The outcome recorded for a slot the budget never reached. */
function budgetExhaustedOutcome(variant: string, apiCallsUsed: number): SlotOutcome {
  return {
    variant,
    result: 'dropped',
    retryAttempts: 0,
    apiCallsUsed,
    shippedAngle: null,
    dropReason:
      `Run call budget of ${MAX_API_CALLS_PER_RUN} exhausted before this slot could be repaired. ` +
      `A run needs about 75s for the first call and 26s per repair, so an eighth call would ` +
      `not finish inside the 240s guard.`,
  }
}

/** The outcome recorded for a slot that used every angle and still failed. */
function stepsExhaustedOutcome(variant: string, apiCallsUsed: number): SlotOutcome {
  return {
    variant,
    result: 'dropped',
    retryAttempts: MAX_RETRY_ATTEMPTS,
    apiCallsUsed,
    shippedAngle: null,
    dropReason:
      `Exhausted ${MAX_RETRY_ATTEMPTS} retries on original angle and all ${FALLBACK_ANGLES.length} ` +
      `fallback angles (${MAX_RETRY_ATTEMPTS} attempts each)`,
  }
}

// Builds the retry summary appended to suggestion_reason.
// Returns empty string when all variants passed on first pass (no note needed).
function buildRetryNote(stats: RunStats): string {
  const firstPass = stats.slotOutcomes.filter(o => o.result === 'first_pass').map(o => o.variant)
  const retried = stats.slotOutcomes.filter(o => o.result === 'retry')
  const fallback = stats.slotOutcomes.filter(o => o.result === 'fallback')
  const dropped = stats.slotOutcomes.filter(o => o.result === 'dropped')

  if (retried.length === 0 && fallback.length === 0 && dropped.length === 0) return ''

  const parts: string[] = []
  if (firstPass.length > 0) parts.push(`Passed first pass: ${firstPass.join(', ')}.`)
  if (retried.length > 0) {
    parts.push(`Passed on retry: ${retried.map(o => `${o.variant} (attempt ${o.retryAttempts})`).join(', ')}.`)
  }
  if (fallback.length > 0) {
    parts.push(`Used fallback angle: ${fallback.map(o => `${o.variant} (${o.fallbackName ?? 'unknown'}, attempt ${o.fallbackAttempt ?? '?'})`).join(', ')}.`)
  }
  if (dropped.length > 0) {
    parts.push(`Dropped after all retries: ${dropped.map(o => o.variant).join(', ')}.`)
  }
  parts.push(`Total API calls: ${stats.totalApiCalls}. Duration: ${Math.round(stats.durationMs / 1000)}s.`)

  return ' ' + parts.join(' ')
}

// Reads the recorded shipped angle for a stored variant. Falling back to the slot key is
// retained only as a last resort and is logged as an error, because a silent fallback is
// exactly what made the stored value ambiguous before: "A" could mean "shipped on angle A"
// or "nobody recorded anything". A fallback now means a construction site was missed.
function resolveShippedAngle(key: string, recorded: Map<string, string>): string {
  const angle = recorded.get(key)
  if (angle) return angle
  logger.error('Messaging agent: no shipped angle recorded for a stored variant', {
    variantKey: key,
    recorded: [...recorded.keys()],
  })
  return key
}

// ─── Write to document_suggestions ───────────────────────────────────────────

// Writes a single row to document_suggestions.
// suggested_value stores: { variants: { A: { emails: [...] }, B: {...}, ... } }
// Matches the full_document pattern used by all document generation agents.
async function writeDocumentSuggestion(
  supabase: SupabaseClient,
  params: {
    organisation_id: string
    segment_id: string | null
    requiredDocs: RequiredDocuments
    existingDocument: ExistingMessagingDocument | null
    variants: Record<string, EmailRecord[]>
    variantFailures: VariantFailure[]
    intake: IntakeRow[]
    completeness: number
    runStats?: RunStats
    regeneration_notes: RegenerationNotes | undefined
  }
): Promise<string> {
  const {
    organisation_id,
    segment_id,
    requiredDocs,
    existingDocument,
    variants,
    completeness,
    runStats,
  } = params

  const answeredCount = params.intake.filter(
    r => r.response_value && r.response_value.trim().length > 0 && r.is_critical
  ).length
  const totalCount = params.intake.filter(r => r.is_critical).length

  // Derived from what was actually READ, never from a caller's flag. The old line branched
  // on is_refresh, so it said "Initial generation" about runs that never looked.
  const refreshNote = existingDocument
    ? ` Refresh. Version ${existingDocument.version} supplied to the agent as context.`
    : ' Initial generation. No prior messaging document exists.'

  const completenessNote = completeness < 80
    ? ` ⚠️ Intake completeness: ${completeness}% (${answeredCount}/${totalCount} required fields).`
    : ` Intake completeness: ${completeness}% (${answeredCount}/${totalCount} required fields).`

  // Use runStats for the variant summary when available (reflects post-retry final state).
  let variantNote: string
  if (runStats) {
    const passedKeys = Object.keys(variants).sort()
    const droppedKeys = runStats.slotOutcomes
      .filter(o => o.result === 'dropped')
      .map(o => o.variant)
    variantNote = ` Variants passed: ${passedKeys.join(', ')}.` +
      (droppedKeys.length > 0 ? ` Variants dropped after retries: ${droppedKeys.join(', ')}.` : '')
  } else {
    const variantKeys = Object.keys(variants).sort()
    const failedKeys = params.variantFailures.map(f => f.variant)
    variantNote = ` Variants generated: ${variantKeys.join(', ')}.` +
      (failedKeys.length > 0 ? ` Variants failed post-processing: ${failedKeys.join(', ')}.` : '')
  }

  const retryNote = runStats ? buildRetryNote(runStats) : ''

  const sourceVersions =
    ` Source documents: ICP v${requiredDocs.icp.version}, ` +
    `Positioning v${requiredDocs.positioning.version}, ` +
    `TOV v${requiredDocs.tov.version}.`

  const suggestionReason =
    `Four-variant Messaging Playbook generated by messaging-generation-agent using ${MESSAGING_MODEL}.` +
    refreshNote +
    buildRegenerationNotesReason(params.regeneration_notes, params.existingDocument) +
    completenessNote +
    variantNote +
    retryNote +
    sourceVersions

  // Strip per-email suggestion_reason before storing — it's agent metadata, not document content.
  //
  // `angle` is additive and records which angle actually shipped in each slot. When a
  // fallback angle is used the slot key alone misdescribes the copy, so the key is kept
  // for assignment stability and the true angle is stored alongside it. Every consumer
  // reads variants[key].emails and is unaffected by the extra key.
  // Every passing slot now records its shipped angle explicitly, so this map has an entry
  // for each stored variant. A miss means a slot outcome was constructed without one,
  // which is a bug rather than a first-pass default.
  const shippedAngleByVariant = new Map(
    (runStats?.slotOutcomes ?? [])
      .filter((o): o is SlotOutcome & { shippedAngle: string } => typeof o.shippedAngle === 'string')
      .map(o => [o.variant, o.shippedAngle])
  )

  const variantKeys = Object.keys(variants).sort()
  const variantsForStorage = Object.fromEntries(
    variantKeys.map(key => [
      key,
      {
        emails: variants[key].map(({ suggestion_reason: _unused, ...email }) => email),
        angle: resolveShippedAngle(key, shippedAngleByVariant),
      },
    ])
  )

  // Full payload gate: scrub and assert on the entire variants JSON before writing.
  // The per-email body scrub in processOneVariant already ran; this catches subject lines
  // and any other prose fields that the body-only scrub did not cover.
  const gatedVariants = scrubAITellsDeep(variantsForStorage, 'messaging-agent')
  assertNoDashes(gatedVariants, 'messaging-agent')

  const { data, error } = await supabase
    .from('document_suggestions')
    .insert({
      organisation_id,
      segment_id,               // segment this Messaging Playbook was generated for
      document_id: existingDocument?.id ?? null,
      document_type: 'messaging',
      field_path: 'full_document',
      current_value: existingDocument?.plain_text ?? null,
      // The model that wrote suggested_value, recorded on the SUGGESTION so that
      // approval carries it forward. Nothing recorded this before 2026-09-08, so
      // which model produced any existing document is unrecoverable rather than
      // merely unrecorded. Read from the constant this run actually called.
      generated_by_model: MESSAGING_MODEL,
      suggested_value: JSON.stringify({ variants: gatedVariants }),
      suggestion_reason: suggestionReason,
      confidence_level: completeness >= 80 ? 'high' : 'low',
      signal_count: 0,
      status: 'pending',
      // What the version history shows for the version this becomes. See
      // noteForVersionHistory: without it five regenerations are indistinguishable.
      revision_note: noteForVersionHistory(params.regeneration_notes),
    })
    .select('id')
    .single()

  if (error) {
    // 23505 = unique_violation on document_suggestions_org_type_pending_unique.
    // A pending suggestion already exists for this org+type — idempotent no-op.
    if ((error as { code?: string }).code === '23505') {
      logger.info('Messaging agent: duplicate pending suppressed by idempotency index', { organisation_id })
      const { data: existing } = await supabase
        .from('document_suggestions')
        .select('id')
        .eq('organisation_id', organisation_id)
        .eq('document_type', 'messaging')
        .eq('status', 'pending')
        .single()
      return (existing?.id ?? null) as string
    }
    throw new Error(`Messaging agent: failed to write document suggestion — ${error.message}`)
  }

  return data.id as string
}
