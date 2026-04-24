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

export function scrubAITells(text: string, context?: string): string {
  const scrubbed = text.replace(DASH_PATTERN, (match, offset, str) => {
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
