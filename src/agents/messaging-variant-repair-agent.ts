// Messaging Variant Repair Agent
// Entry point for generating ONE missing variant into an existing pending suggestion.
// Model: inherited from the messaging generation agent (ADR-013).
//
// WHY THIS EXISTS. A messaging run is bounded by MAX_API_CALLS_PER_RUN, and a slot that
// runs out of budget is dropped. Measured on a real run: four variants failed the first
// pass, three passed on their first retry, and the fourth was dropped with "run call
// budget exhausted before this slot could be repaired". That slot never failed on its
// merits. The only recovery was a full regeneration, which spends a whole budget rewriting
// three variants that were already good and is not guaranteed to fill the fourth either.
//
// This repairs the one slot with the whole budget to itself.
//
// ISOLATION RULES (enforced at three levels):
//   1. Database: RLS policies block cross-client reads
//   2. Application: organisation_id is read from the suggestion row and filters every query
//   3. Prompt: the context is built by buildVariantGenerationContext, which is scoped to
//      that one organisation and is the SAME assembly the full run uses
//
// WHAT IT WRITES: suggested_value.variants.<key> on one pending document_suggestions row,
// plus a sentence appended to suggestion_reason recording the repair. Nothing else on that
// row, no other row, and no other table. It does not write strategy_documents and it never
// approves. If any step fails, it writes nothing.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { startAgentRun } from '@/lib/agents/log-agent-run'
import { SentenceRegistry } from '@/lib/style/sentence-frames'
import {
  AGENT_TIMEOUT_MS,
  MEASURED_PREFLIGHT_SECONDS,
  MEASURED_REPAIR_CALL_SECONDS,
  attemptSlotRepair,
  buildVariantGenerationContext,
  collectTakenCopy,
  repairStepCount,
  repairStepFor,
  type EmailRecord,
  type RunStats,
  type SlotRepairState,
} from '@/agents/messaging-generation-agent'
import {
  assertOnlyVariantAdded,
  parseVariantPayload,
  spliceVariant,
  variantFingerprints,
  VariantPayloadWriteError,
} from '@/lib/messaging/variant-payload'

/**
 * How many model calls one repair may spend.
 *
 * DERIVED, never a chosen number. The wall-clock guard is the binding constraint: after
 * the preflight reads, what remains divided by the measured cost of one repair call. The
 * structural ceiling is every step the slot has available, so the budget is whichever
 * of the two runs out first.
 *
 * A full run splits its budget across four slots. A repair has one slot, so the same
 * wall clock buys that slot roughly eight attempts instead of the one or two it got.
 */
export const MAX_REPAIR_API_CALLS = Math.min(
  repairStepCount(),
  Math.floor((AGENT_TIMEOUT_MS / 1000 - MEASURED_PREFLIGHT_SECONDS) / MEASURED_REPAIR_CALL_SECONDS),
)

/** The stored shape of one variant: its emails and the angle that actually shipped. */
interface StoredVariant {
  emails: EmailRecord[]
  angle?: string
}

export interface MessagingVariantRepairResult {
  suggestion_id: string
  organisation_id: string
  variant_key: string
  /** Every variant key in the row after the repair, sorted. */
  variants_after: string[]
  /** Fingerprints of the variants that were already there, read back after the write. */
  preserved_fingerprints: Record<string, string>
  api_calls_used: number
  shipped_angle: string
  duration_ms: number
}

export class VariantRepairError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VariantRepairError'
  }
}

/**
 * Reads the surviving variants out of a stored payload.
 *
 * Refuses a variant whose emails are not a four-element array rather than passing it on:
 * a malformed survivor would seed the reuse registry with nothing and make the
 * cross-variant check quietly weaker, which is the failure this whole path is guarding.
 */
export function readSurvivingVariants(
  suggestedValue: string | null,
  targetKey: string,
): Record<string, EmailRecord[]> {
  const { variants } = parseVariantPayload(suggestedValue)

  if (Object.prototype.hasOwnProperty.call(variants, targetKey)) {
    throw new VariantRepairError(
      `Variant ${targetKey} is already present in this suggestion. A repair fills a missing ` +
      'slot and never overwrites copy that exists.'
    )
  }

  const survivors: Record<string, EmailRecord[]> = {}
  for (const [key, value] of Object.entries(variants)) {
    const emails = (value as StoredVariant)?.emails
    if (!Array.isArray(emails) || emails.length !== 4) {
      throw new VariantRepairError(
        `Stored variant ${key} does not hold four emails, so it cannot be used as context ` +
        'for a repair. Refusing rather than generating against a partial set.'
      )
    }
    survivors[key] = emails
  }

  if (Object.keys(survivors).length === 0) {
    throw new VariantRepairError(
      'This suggestion has no surviving variants. There is nothing to repair alongside, ' +
      'and a full regeneration is the correct path.'
    )
  }

  return survivors
}

/**
 * Loads the surviving variants into BOTH the reuse registry and the prompt's avoid-block.
 *
 * THIS IS THE FUNCTION THAT MAKES THE CROSS-VARIANT CHECK REAL, and the reason it does
 * both jobs in one place rather than leaving them to the caller.
 *
 * In a normal run, SentenceRegistry is populated only by register(), and register() is
 * called only for variants that PASS. A repair that treats the stored variants as
 * already-passed and skips the registration gets an EMPTY registry: findReuse then
 * compares the new variant against nothing, returns no violations, and the run reports a
 * clean cross-variant result having checked nothing at all. The check does not fail, it
 * evaporates, and the payload that results looks exactly like a correct one.
 *
 * Seeding it here, next to the avoid-block that has to list the same sentences, means a
 * caller cannot take one and forget the other. The test that proves it is the one that
 * removes this seeding and watches a reuse case go from rejected to accepted.
 */
export function seedFromSurvivingVariants(
  survivors: Record<string, EmailRecord[]>,
  signOffLines: string[],
): { registry: SentenceRegistry; taken: ReturnType<typeof collectTakenCopy> } {
  const registry = new SentenceRegistry()

  // Sorted so "first writer wins" attributes a shared sentence to the same variant on
  // every run, exactly as processAllVariants does for a full generation.
  for (const key of Object.keys(survivors).sort()) {
    for (const email of survivors[key]) {
      // Email 1 only, matching CROSS_VARIANT_UNIQUE_POSITION in the generation agent.
      // Registering emails 2 to 4 here would gate copy the full run deliberately allows
      // to converge, and would make a repaired variant held to a stricter rule than the
      // three it ships beside.
      if (email.sequence_position !== 1) continue
      registry.register(key, email.body, signOffLines)
    }
  }

  const taken = collectTakenCopy(survivors, signOffLines)

  if (registry.size === 0) {
    throw new VariantRepairError(
      'Seeded the sentence registry from the surviving variants and it is empty. The ' +
      'cross-variant reuse check would pass vacuously, so the repair is refused. Check ' +
      'that the stored Email 1 bodies are intact.'
    )
  }

  return { registry, taken }
}

/**
 * Generates one missing variant into an existing pending messaging suggestion.
 */
export async function runMessagingVariantRepair(input: {
  suggestion_id: string
  variant_key: string
  supabase: SupabaseClient
}): Promise<MessagingVariantRepairResult> {
  const { suggestion_id, variant_key, supabase } = input
  const startedAt = Date.now()

  logger.info('Variant repair: starting', { suggestion_id, variant_key })

  // ── 1. Load the row and refuse anything this path is not for ───────────────
  const { data: row, error: readError } = await supabase
    .from('document_suggestions')
    .select('id, organisation_id, document_type, field_path, status, suggested_value, suggestion_reason')
    .eq('id', suggestion_id)
    .single()

  if (readError || !row) {
    throw new VariantRepairError(
      `Suggestion ${suggestion_id} could not be read: ${readError?.message ?? 'no row'}.`
    )
  }
  if (row.document_type !== 'messaging') {
    throw new VariantRepairError(
      `Suggestion ${suggestion_id} is a ${row.document_type} document. Only messaging ` +
      'documents carry variants.'
    )
  }
  if (row.field_path !== 'full_document') {
    throw new VariantRepairError(
      `Suggestion ${suggestion_id} has field_path ${row.field_path}, not full_document.`
    )
  }
  // A repair edits copy an operator is currently deciding on. Editing a row that has
  // already been approved or rejected would change the record of what was decided.
  if (row.status !== 'pending') {
    throw new VariantRepairError(
      `Suggestion ${suggestion_id} is ${row.status}, not pending. A repair only ever edits ` +
      'a suggestion that is still awaiting a decision.'
    )
  }
  if (!repairStepFor(variant_key, 0)) {
    throw new VariantRepairError(
      `${variant_key} is not a variant slot with a defined angle, so there is no ` +
      'instruction to generate it from.'
    )
  }

  const organisation_id = row.organisation_id as string
  const before = row.suggested_value as string | null

  // ── 2. The positive control's BEFORE reading, taken from the database bytes ─
  const survivors = readSurvivingVariants(before, variant_key)
  const fingerprintsBefore = variantFingerprints(before)
  logger.info('Variant repair: surviving variants fingerprinted before any work', {
    suggestion_id,
    organisation_id,
    survivors: [...fingerprintsBefore.keys()].sort(),
  })

  const agentRun = await startAgentRun({
    organisation_id,
    agent_name: 'messaging-variant-repair',
  })

  const abortController = new AbortController()
  let timeoutHandle: NodeJS.Timeout | null = null

  const runStats: RunStats = { slotOutcomes: [], totalApiCalls: 0, durationMs: 0 }

  try {
    timeoutHandle = setTimeout(() => {
      const msg =
        `Variant repair: exceeded ${AGENT_TIMEOUT_MS / 1000}s guard after ` +
        `${runStats.totalApiCalls} call(s) — aborting. Nothing was written.`
      logger.error(msg, { suggestion_id, organisation_id, variant_key })
      abortController.abort(new Error(msg))
      void agentRun.fail(msg)
    }, AGENT_TIMEOUT_MS)

    // ── 3. The same context assembly the full run uses ───────────────────────
    //
    // regeneration_notes is undefined deliberately. Those notes are an instruction about
    // a REJECTED suggestion this run replaces (ADR-038). This run replaces nothing: it
    // adds a slot to a suggestion that is still pending, so there is no rejection note
    // that applies and passing one would tell the model to act on an instruction that was
    // never given about this document.
    const context = await buildVariantGenerationContext(supabase, organisation_id, undefined)

    const senderFirstName = context.preflight.sender_first_name
    const senderCompanyName = context.preflight.org_name
    const signOffLines = [senderFirstName, senderCompanyName]

    // ── 4. Seed the reuse gate from the survivors, or refuse ─────────────────
    const { registry, taken } = seedFromSurvivingVariants(survivors, signOffLines)
    logger.info('Variant repair: reuse registry seeded from surviving variants', {
      suggestion_id,
      variant_key,
      registeredSentenceKeys: registry.size,
      takenSubjects: taken.subjects.length,
      takenSentences: taken.sentences.length,
    })

    // ── 5. Spend the budget on the one slot ──────────────────────────────────
    const state: SlotRepairState = { variant: variant_key, lastViolations: [], apiCallsUsed: 0 }
    let produced: { emails: EmailRecord[]; shippedAngle: string } | null = null

    for (let step = 0; step < MAX_REPAIR_API_CALLS; step++) {
      if (!repairStepFor(variant_key, step)) break

      const result = await attemptSlotRepair(
        state, step, context, organisation_id, taken, registry, abortController.signal, runStats,
      )
      if (result) {
        produced = {
          emails: result.emails,
          shippedAngle: result.outcome.shippedAngle ?? variant_key,
        }
        runStats.slotOutcomes.push(result.outcome)
        break
      }
    }

    if (!produced) {
      const msg =
        `Variant repair: variant ${variant_key} did not pass in ${runStats.totalApiCalls} ` +
        `call(s) of a ${MAX_REPAIR_API_CALLS} call budget. Nothing was written and the ` +
        'suggestion is unchanged.'
      logger.error(msg, { suggestion_id, organisation_id, variant_key })
      await agentRun.fail(msg)
      throw new VariantRepairError(msg)
    }

    // ── 6. Build the new payload, guarded before it is sent ──────────────────
    //
    // Stored in the same shape as every other variant: emails with the agent-only
    // suggestion_reason stripped, plus the angle that actually shipped.
    const storedVariant = {
      emails: produced.emails.map(({ suggestion_reason: _unused, ...email }) => email),
      angle: produced.shippedAngle,
    }
    const after = spliceVariant(before, variant_key, storedVariant, 'Variant repair (pre-write)')

    // The reason line has to move with the payload. A row that silently gains a variant
    // while its reason still reads "Variants dropped after retries: B" is a document
    // asserting something about itself that is no longer true, which is the exact class
    // of error the rest of this codebase keeps paying for.
    const repairNote =
      ` Variant ${variant_key} was repaired separately on ${new Date().toISOString().slice(0, 10)} ` +
      `by messaging-variant-repair (shipped angle: ${produced.shippedAngle}, ` +
      `${runStats.totalApiCalls} call(s)); the other variants were left byte-identical.`

    // ── 7. Write, scoped to this exact row AND still-pending ─────────────────
    //
    // The status filter is a concurrency guard, not decoration: an operator approving or
    // rejecting between the read above and this write would otherwise have their decision
    // edited underneath them. Matching zero rows here means that happened.
    const { data: written, error: writeError } = await supabase
      .from('document_suggestions')
      .update({
        suggested_value: after,
        suggestion_reason: (row.suggestion_reason ?? '') + repairNote,
      })
      .eq('id', suggestion_id)
      .eq('status', 'pending')
      .select('id')

    if (writeError) {
      throw new VariantRepairError(`Variant repair: write failed — ${writeError.message}`)
    }
    if (!written || written.length !== 1) {
      throw new VariantRepairError(
        'Variant repair: the update matched no pending row. The suggestion was approved or ' +
        'rejected while this repair was running, so nothing was changed.'
      )
    }

    // ── 8. The positive control's AFTER reading, from the database ───────────
    //
    // Re-read rather than trusted. Step 6 proves what was SENT; only this proves what
    // LANDED, and they are different claims.
    const { data: readBack, error: readBackError } = await supabase
      .from('document_suggestions')
      .select('suggested_value')
      .eq('id', suggestion_id)
      .single()

    if (readBackError || !readBack) {
      throw new VariantRepairError(
        `Variant repair: wrote the variant but could not read the row back to verify it — ` +
        `${readBackError?.message ?? 'no row'}. Verify by hand before approving.`
      )
    }

    assertOnlyVariantAdded(before, readBack.suggested_value as string, variant_key, 'Variant repair (read-back)')

    const fingerprintsAfter = variantFingerprints(readBack.suggested_value as string)
    const preserved: Record<string, string> = {}
    for (const key of [...fingerprintsBefore.keys()].sort()) {
      preserved[key] = fingerprintsAfter.get(key) as string
    }

    const durationMs = Date.now() - startedAt
    runStats.durationMs = durationMs

    const summary =
      `Repaired variant ${variant_key} into suggestion ${suggestion_id}. ` +
      `Shipped angle: ${produced.shippedAngle}. API calls: ${runStats.totalApiCalls}. ` +
      `Variants after: ${[...fingerprintsAfter.keys()].sort().join(', ')}. ` +
      `Duration: ${Math.round(durationMs / 1000)}s.`
    logger.info('Variant repair: complete', {
      suggestion_id, organisation_id, variant_key, preserved,
    })
    await agentRun.complete(summary)

    return {
      suggestion_id,
      organisation_id,
      variant_key,
      variants_after: [...fingerprintsAfter.keys()].sort(),
      preserved_fingerprints: preserved,
      api_calls_used: runStats.totalApiCalls,
      shipped_angle: produced.shippedAngle,
      duration_ms: durationMs,
    }
  } catch (err) {
    if (err instanceof VariantPayloadWriteError) {
      logger.error('Variant repair: refused by the payload guard', {
        suggestion_id, organisation_id, variant_key, error: err.message,
      })
      await agentRun.fail(err.message)
    }
    throw err
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}
