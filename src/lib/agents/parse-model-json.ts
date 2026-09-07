// Parsing a document agent's JSON response, and saying what happened when it will not parse.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS AS A SHARED MODULE
//
// Three agents had this block, character for character:
//
//   try {
//     parsedDocument = JSON.parse(generatedContent)
//   } catch {
//     throw new Error(
//       'X agent: Claude returned content that is not valid JSON. ' +
//       'Raw response has been logged. Do not write to the database.'
//     )
//   }
//
// `catch {` binds nothing, so the parse error was discarded. NOTHING LOGGED THE RAW
// RESPONSE. `generatedContent` was never passed to a logger in any of the three, and
// stop_reason and usage were never read anywhere in any of them. The message asserted a
// log that no code wrote.
//
// On 2026-09-05 a tov regeneration for a live organisation failed here after 100 seconds.
// The complete production log for the run was four lines: starting, found website pages,
// calling Claude, failed. What the model returned is unrecoverable, so the failure could
// not be diagnosed at all, and the sentence promising a log sent the next reader hunting
// for something that had never been written.
//
// One module rather than three copies, because three copies of a diagnostic drift, and the
// version that drifts is the one nobody is looking at on the day it matters.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IS LOGGED, AND WHY EACH PIECE
//
//   stop_reason      'max_tokens' means the response was CUT OFF and any JSON in it is
//                    necessarily incomplete. This is the single fastest discriminator
//                    between "the model wrote prose" and "the model ran out of room",
//                    and it was thrown away at the API boundary.
//   output_tokens    the same question measured, and it says how much headroom was left.
//   hit_output_ceiling  stated rather than left to be derived from two numbers in
//                    different fields at three in the morning.
//   raw_length       distinguishes a short malformed response from a long truncated one
//                    without putting a whole strategy document in the log.
//   raw_head/tail    they fail differently and one without the other is ambiguous. A
//                    preamble or an apology shows at the HEAD. A truncation shows as a
//                    TAIL that stops mid-token with no closing brace. Seeing only the head
//                    of a truncated document tells you nothing at all.

import { logger } from '@/lib/logger'

/**
 * What a document agent's model call returned, plus the two facts that explain a
 * malformed response. This was a bare string in all three agents, which is precisely why
 * the 2026-09-05 failure could not be explained: the diagnostic was discarded at the API
 * boundary, before the code that needed it ever ran.
 */
export interface ModelResponse {
  /** Fences stripped, trimmed. The exact text handed to JSON.parse. */
  raw: string
  /** 'max_tokens' means truncated. 'end_turn' means the model finished and still produced this. */
  stopReason: string | null
  outputTokens: number | null
}

/** How much of the raw response goes in the log, from each end. */
const EXCERPT_CHARS = 600

/**
 * Parses the model's response, or throws an error that actually says what went wrong.
 *
 * @param agentLabel  How the agent names itself in errors, e.g. 'TOV agent'.
 * @param maxTokens   The agent's own MAX_TOKENS, so the log can show the ceiling that
 *                    was in force rather than one assumed here.
 */
export function parseModelJsonOrThrow(
  agentLabel: string,
  organisation_id: string,
  response: ModelResponse,
  maxTokens: number,
): Record<string, unknown> {
  try {
    return JSON.parse(response.raw)
  } catch (parseError) {
    logger.error(`${agentLabel}: model response is not valid JSON`, {
      organisation_id,
      parse_error: parseError instanceof Error ? parseError.message : String(parseError),
      stop_reason: response.stopReason,
      output_tokens: response.outputTokens,
      max_tokens: maxTokens,
      hit_output_ceiling: response.stopReason === 'max_tokens',
      raw_length: response.raw.length,
      raw_head: response.raw.slice(0, EXCERPT_CHARS),
      raw_tail: response.raw.slice(-EXCERPT_CHARS),
    })

    // The message carries the discriminating numbers itself, because it is what lands in
    // agent_runs.error_message and in the operator's alert email, and those are read in
    // places the log line is not.
    throw new Error(
      `${agentLabel}: Claude returned content that is not valid JSON. ` +
      `stop_reason=${response.stopReason}, ` +
      `output_tokens=${response.outputTokens}/${maxTokens}, ` +
      `raw_length=${response.raw.length}. ` +
      `The raw response head and tail are on the "${agentLabel}: model response is not ` +
      'valid JSON" log line. Nothing was written to the database.'
    )
  }
}
