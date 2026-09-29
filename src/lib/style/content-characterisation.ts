// A CANDIDATE THAT CHARACTERISES THE PROSPECT'S CONTENT AS A WHOLE IS NOT A HOOK.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS ADDS, AND WHAT IT DOES NOT. Measured 2026-09-29 against the three hooks the
// operator named, all of which already come out correctly WITHOUT this module:
//
//   a proportion plus an omission     already excluded by absenceAboutThem, on the omission
//   a proportion plus an omission     already excluded, same reason
//   a dated publication burst         already eligible, nothing fires
//
// So the gap this closes is NARROW and specific: a candidate that characterises their content
// by TOPIC OR MIX and names no omission at all. "All five of the last posts are about
// pricing" says what their whole body of content is, which is a reading of them rather than
// an event that happened, and nothing else catches it.
//
// WHY A PROPORTION AND NOT A COUNT. That distinction is the whole rule, and it is what keeps
// a real event eligible:
//
//   "Four of the last five posts are retreat promotion"        <- a bounded set, characterised
//   "published at least twelve articles in six days"           <- an event, counted
//
// The first says what their content IS. The second says what they DID. A plain count is the
// ordinary way to describe a burst of activity, so counting alone must never disqualify, and
// no date is needed to tell them apart: the quantifier does it.
//
// NOTHING HERE NAMES AN INDUSTRY, A SERVICE OR A BUYER. The nouns are kinds of published
// thing and the quantifiers are ordinary English.

/** Kinds of published thing a prospect can have a body of. */
const CONTENT_NOUN =
  '(posts?|articles?|pieces?|blogs?|blog entries|updates?|videos?|episodes?|newsletters?|' +
  'case studies|content|entries|publications?|essays?|columns?)'

/**
 * A quantifier covering a BOUNDED SET of their content: all of it, none of it, or a stated
 * fraction of it. Deliberately NOT a bare number: "twelve articles" counts an event, and
 * "four of the last five" characterises a set.
 */
// "most" ONLY AS A QUANTIFIER, never as the adjective. Measured on the stored corpus: a bare
// `most` matched a candidate reading "<name>'s most recent post is ...", which is a SINGLE
// DATED PIECE and the strongest kind of hook there is. "most recent", "most talked about" and "most read" are all
// adjective phrases, and none of them says anything about a body of content.
const PROPORTION =
  '(all|every|each|none|neither|most\\s+of\\s+(?:the|their|her|his|its)|the (?:entire|whole)|' +
  '\\d+\\s+of\\s+(?:the\\s+)?(?:last\\s+)?\\w+|' +
  '(?:the\\s+)?last\\s+\\w+)'

/** A verb saying what something IS ABOUT, rather than that it happened. */
const CHARACTERISING =
  '(are|is|were|was|all\\s+(?:about|on)|cover\\w*|focus\\w*|centre\\w*|center\\w*|' +
  'frame\\w*|deal\\s+with|revolve\\w*|concern\\w*|about)'

// FOUR WORDS OF SLACK, NOT THREE. "All five of the last posts" puts four words between the
// quantifier and the noun, and at three the leftmost alternative matched "All" and then ran
// out of room before reaching "posts". Widening is safe here and narrowing was not: every
// keep case below stays eligible at four, because what disqualifies them is the absence of a
// proportion, not the distance to it.
const CHARACTERISES = new RegExp(
  `\\b${PROPORTION}\\s+(?:\\w+\\s+){0,4}?${CONTENT_NOUN}\\b[^.!?]{0,50}?\\b${CHARACTERISING}\\b`,
  'i',
)

export interface ContentCharacterisationHit {
  /** The sentence it was found in. */
  sentence: string
  /** The matched span, for the log line and the report. */
  matched: string
}

/**
 * True when the observation reads their content as a body and says what it is about.
 *
 * ONE HIT IS ENOUGH; the caller only needs to know whether the candidate is eligible.
 * Returns the match so a rejection can be read rather than counted.
 */
export function characterisesTheirContent(observation: string | null | undefined): ContentCharacterisationHit | null {
  const text = (observation ?? '').trim()
  if (!text) return null
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const m = sentence.match(CHARACTERISES)
    if (m) return { sentence: sentence.trim(), matched: m[0] }
  }
  return null
}
