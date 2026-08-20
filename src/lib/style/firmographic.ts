// Figures drawn from the prospect's firmographic record. Shared, because two agents now
// need the same ban and a second copy would drift.
//
// The messaging agent has enforced this since 2026-08-19, after two variants shipped
// "Most B2B consulting firms at the £500K to £5M mark" and "For most consulting founders
// billing north of £500K". The research writer never inherited it and shipped "a $5M
// consulting firm" in Bob's opening.
//
// Three reasons, any one of which is enough. It reads as a database lookup, which is the
// exact impression the personalisation layer exists to avoid. It may simply be wrong,
// because the figure came from a data provider and not from the prospect. And being wrong
// about someone's revenue in the opening line is worse than being generic: a generic line
// is ignored, a wrong number is disproved and the reader stops.
//
// The population may still be qualified by ROLE, STAGE or SITUATION. The revenue band is a
// TARGETING instruction that decides who receives the email, never content for the email.
//
// Deliberately narrow so ordinary numbers survive: "your last 30 reviews", "4 of the most
// recent 10", "13 months", "August 2025" and "six or eight weeks" all pass untouched.

// Number words, so a headcount spelled out is caught the same as a numeral. "Three
// visibility plays ... from a two-person firm" shipped past the numeral-only version, and
// so did the softer "a firm that size". Both are the prospect's headcount restated.
const NUMBER_WORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|fifty|a|an)'

export const BANNED_FIRMOGRAPHIC: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /[£$€]\s?\d/,                                    label: 'a currency amount' },
  { pattern: /\b\d+(?:\.\d+)?\s*[km]\b/i,                     label: 'a figure like 500K or 5M' },
  { pattern: /\b\d+(?:\.\d+)?\s*(?:bn|billion|million)\b/i,   label: 'a figure in millions or billions' },
  { pattern: /\b\d+\s*(?:employees|staff|headcount)\b/i,      label: 'a headcount' },
  { pattern: /\bteam of \d+/i,                                label: 'a team size' },
  { pattern: /\b\d+[- ]person\b/i,                            label: 'a team size' },

  // Spelled-out forms of the same three things.
  { pattern: new RegExp(`\\b${NUMBER_WORD}[- ]person\\b`, 'i'),                       label: 'a spelled-out team size' },
  { pattern: new RegExp(`\\bteam of ${NUMBER_WORD}\\b`, 'i'),                         label: 'a spelled-out team size' },
  { pattern: new RegExp(`\\b${NUMBER_WORD}[- ](?:employees|staff|people)\\b`, 'i'),   label: 'a spelled-out headcount' },
  // Oblique references to size, which say the same thing without a number at all.
  { pattern: /\b(?:a|the)\s+(?:firm|company|business|team|shop|practice)\s+(?:that|this)\s+size\b/i, label: 'an oblique reference to their size' },
  { pattern: /\bof\s+(?:that|this)\s+size\b/i,                                      label: 'an oblique reference to their size' },
]

/** Labels of every banned figure type found in the text. Empty when clean. */
export function findFirmographicFigures(text: string): string[] {
  return [...new Set(
    BANNED_FIRMOGRAPHIC.filter(t => t.pattern.test(text)).map(t => t.label),
  )]
}

/**
 * The rule as prose, for prompts.
 *
 * The messaging agent keeps its own wording in docs/prompts/messaging-agent.md, because
 * that file IS its system prompt and is markdown rather than importable TypeScript. The
 * PATTERNS above are the shared source of truth for enforcement; this string is the shared
 * source of truth for any prompt built in code.
 */
export const FIRMOGRAPHIC_RULE_TEXT = `NEVER QUOTE A FIGURE FROM THEIR FIRMOGRAPHIC RECORD.
No revenue, no headcount, no funding raised, no currency amounts, no "5M", no "team of 12",
and none of those spelled out either: "a two-person firm", "a team of five", "a firm that
size" are all the same thing said differently.
Those numbers came from a data provider, not from them. Quoting one reads as a database
lookup, it may simply be wrong, and being wrong about someone's revenue in your first line
is worse than being generic: a generic line gets ignored, a wrong number gets disproved and
they stop reading. Qualify by role, stage or situation instead. Dates, counts of posts and
lengths of time are fine: "fourteen months", "your last three posts", "since 2016".`
