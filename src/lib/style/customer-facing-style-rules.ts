// Shared style rules for all agents that produce customer-facing text.
// Import CUSTOMER_FACING_STYLE_RULES into agent system prompts.
// Call scrubAITells() on generated text before storage or sending.
// Every agent touching client- or prospect-facing copy must use both exports.

import { logger } from '@/lib/logger'

// ─── Rules string ─────────────────────────────────────────────────────────────
// Embed this block in any agent system prompt that outputs customer-facing text.

export const CUSTOMER_FACING_STYLE_RULES = `
─────────────────────────────────────────────────────────────────────
STYLE RULES — ALL CUSTOMER-FACING TEXT
─────────────────────────────────────────────────────────────────────

Em dashes (—), en dashes (–), and double hyphens (--) are absolutely
forbidden. They are the most recognizable AI writing tells. Replace with:
  • A period and a new sentence (most common fix)
  • A comma (when the clause is tightly connected)
  • A colon (when what follows IS the thing described)
  • Sentence restructuring

Also forbidden in any customer-facing output:
  • "Delve into"
  • "Navigate the complexities of" / "Navigate the landscape"
  • "Leverage" as a verb — use "use", "apply", or "build with"
  • "Seamless" / "Seamlessly"
  • "Robust"
  • "At the end of the day"
  • "That said" / "Having said that"
  • Sentences starting with "Look,"
  • "Furthermore" / "Moreover" / "Additionally" — AI structural transitions
  • "It's worth noting that" — hedge filler
  • Three-part parallel lists in a single sentence ("not just X, but Y and Z")
  • "As someone who..." when the framing is speculative or inflated
    (legitimate experience-based openers such as "From working with..." are fine)

Before returning any output, scan for every item above.
`.trim()

// ─── Runtime scrubber ─────────────────────────────────────────────────────────
// Replaces dash variants in a string. Logs warnings (does not throw) on detected AI tells.
// Replacement logic: lowercase char after dash → comma, uppercase → period.
// Matches the messaging agent's original applyEmDashFixes() behaviour, extended to cover
// en dashes and double hyphens.

const DASH_PATTERN = /\s*[—–]\s*|--/g

// Numeric/currency range en-dashes (€1K–€3K, 3K–15K, 10%–20%) → plain hyphen.
// Applied before DASH_PATTERN in scrubAITells so valid ranges are not turned into sentences.
// Matches only when the en-dash has numeric/currency chars on both sides with no whitespace.
const NUMERIC_RANGE_PATTERN = /([0-9KMB%])–([€$£¥%0-9])/g

const AI_TELL_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'delve into',                          pattern: /delve into/i },
  { label: 'navigate the complexities/landscape', pattern: /navigate the (complexities|landscape)/i },
  { label: 'leverage (verb)',                     pattern: /\bleverage\b/i },
  { label: 'seamless/seamlessly',                 pattern: /\bseamless(ly)?\b/i },
  { label: 'robust',                              pattern: /\brobust\b/i },
  { label: 'at the end of the day',               pattern: /at the end of the day/i },
  { label: 'that said / having said that',        pattern: /\bthat said\b|\bhaving said that\b/i },
  { label: 'look opener',                         pattern: /^look,/im },
  { label: 'furthermore/moreover/additionally',   pattern: /\bfurthermore\b|\bmoreover\b|\badditionally\b/i },
  { label: "it's worth noting that",              pattern: /it'?s worth noting that/i },
]

/**
 * Walk every string value in an arbitrary JSON-compatible object and apply
 * scrubAITells() to it. Recurses into arrays and objects. Never mutates the
 * input. Returns a deep-cloned, scrubbed version.
 *
 * Used by ICP, positioning, and TOV agents to gate their JSON output before
 * writing to document_suggestions. Operates on string VALUES only — never
 * changes field names or structure.
 */
export function scrubAITellsDeep<T>(value: T, contextPrefix: string): T {
  if (typeof value === 'string') {
    return scrubAITells(value, contextPrefix) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => scrubAITellsDeep(item, `${contextPrefix}[${i}]`)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = scrubAITellsDeep(v, `${contextPrefix}.${k}`)
    }
    return result as unknown as T
  }
  return value
}

/**
 * Assert that no em-dash or en-dash characters remain in any string value
 * of the object after scrubbing. Throws if any are found.
 *
 * Call AFTER scrubAITellsDeep(). This is a hard gate — if dashes remain
 * after scrubbing (e.g. a dash inside a quoted verbatim sample that the
 * scrubber should not touch), the agent must not write to the database.
 */
export function assertNoDashes(value: unknown, context: string): void {
  if (typeof value === 'string') {
    if (/[—–]/.test(value)) {
      throw new Error(
        `assertNoDashes: em-dash or en-dash found in ${context} after scrubbing. ` +
        `Raw value preview: ${value.slice(0, 120)}`
      )
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoDashes(item, `${context}[${i}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertNoDashes(v, `${context}.${k}`)
    }
  }
}

/**
 * Field-aware variant of scrubAITellsDeep. When the recursive walk reaches an object
 * key that is in excludeFields, it passes the entire value through without scrubbing.
 * Use this for agents whose output mixes generated prose with verbatim quoted text.
 */
export function scrubAITellsDeepExcluding<T>(
  value: T,
  contextPrefix: string,
  excludeFields: ReadonlySet<string>
): T {
  if (typeof value === 'string') {
    return scrubAITells(value, contextPrefix) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((item, i) =>
      scrubAITellsDeepExcluding(item, `${contextPrefix}[${i}]`, excludeFields)
    ) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (excludeFields.has(k)) {
        result[k] = v
      } else {
        result[k] = scrubAITellsDeepExcluding(v, `${contextPrefix}.${k}`, excludeFields)
      }
    }
    return result as unknown as T
  }
  return value
}

/**
 * Field-aware variant of assertNoDashes. Skips any object key in excludeFields.
 * Pair with scrubAITellsDeepExcluding using the same exclusion set.
 */
export function assertNoDashesExcluding(
  value: unknown,
  context: string,
  excludeFields: ReadonlySet<string>
): void {
  if (typeof value === 'string') {
    if (/[—–]/.test(value)) {
      throw new Error(
        `assertNoDashes: em-dash or en-dash found in ${context} after scrubbing. ` +
        `Raw value preview: ${value.slice(0, 120)}`
      )
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoDashesExcluding(item, `${context}[${i}]`, excludeFields))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!excludeFields.has(k)) {
        assertNoDashesExcluding(v, `${context}.${k}`, excludeFields)
      }
    }
  }
}

export function scrubAITells(text: string, context?: string): string {
  // First pass: numeric/currency ranges — en-dash between adjacent numbers/currency symbols
  // becomes a plain hyphen so a price range like €1K–€3K is not turned into €1K. €3K.
  const rangeFixed = text.replace(NUMERIC_RANGE_PATTERN, '$1-$2')
  const scrubbed = rangeFixed.replace(DASH_PATTERN, (match, offset, str) => {
    const firstCharAfter = str.slice(offset + match.length).trimStart()[0] ?? ''
    const isLower =
      firstCharAfter.length > 0 &&
      firstCharAfter === firstCharAfter.toLowerCase() &&
      firstCharAfter !== firstCharAfter.toUpperCase()
    return isLower ? ', ' : '. '
  })

  for (const { label, pattern } of AI_TELL_PATTERNS) {
    if (pattern.test(scrubbed)) {
      logger.warn('customer-facing-style: AI tell detected', {
        tell: label,
        context: context ?? 'unknown',
        preview: scrubbed.slice(0, 120),
      })
    }
  }

  return scrubbed.trim()
}
