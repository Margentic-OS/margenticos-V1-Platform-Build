// A SHORT RELATIVE TIME PHRASE IS BANNED OUTRIGHT, IN EVERY EMAIL.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY A BAN AND NOT A CHECK. relative-time.ts asks whether a phrase is TRUE, against the
// findings and a clock. That is the right question and it cannot be answered once, because
// there is no single moment the copy is read:
//
//   email 1 goes out on the day of upload
//   email 2 three days later
//   email 3 ten days later
//   email 4 seventeen days later
//
// So a phrase can be true when written, true at upload, and false by the time it is read.
// Checking it against any one clock leaves the other three unguarded, and the writing-time
// gate measures in whole calendar months, which cannot see a fortnight move at all.
//
// A MONTH OR A DATE IS TRUE WHENEVER IT LANDS. "In September" and "on 14 September" do not
// go stale between composition and the fourth email. That is the whole argument: the fix is
// not a better clock, it is copy that does not need one.
//
// WHAT IS NOT BANNED, and the distinction is the point: "last month", "this month",
// "earlier this year" and a named month or date all survive, because a month is the unit the
// sequence cannot cross in seventeen days. relative-time.ts still checks those against the
// findings, and still should.
//
// ═══ "JUST" IS NARROWED TO ITS TEMPORAL SENSE, AND THAT MATTERS ═══
//
// A bare "just" would be a disaster. The opt-out footer every email carries reads "Not for
// you? Just reply stop.", and "just a short call" is ordinary, good copy. Only "just" plus a
// verb of announcement carries the time claim, so only that is matched.

/** One banned phrase, and what to write instead. */
export interface ShortRelativeHit {
  /** The phrase as written. */
  matched: string
  /** The sentence it was found in. */
  sentence: string
}

const SHORT_RELATIVE: RegExp[] = [
  /\bthis week\b/i,
  /\blast week\b/i,
  /\byesterday\b/i,
  /\btoday\b/i,
  /\brecently\b/i,
  /\bthis morning\b/i,
  /\blast night\b/i,
  // "just announced", "just launched". NEVER a bare "just": see the header.
  /\bjust\s+(?:announced|launched|published|posted|added|opened|won|landed|shared|released|started)\b/i,
  // Forward-looking phrases go stale the same way, and faster: "next week" written on a
  // Monday is wrong by email 2. Included because the argument is identical, not because a
  // measured fault has been seen.
  /\bnext week\b/i,
  /\bthis coming week\b/i,
]

/**
 * Every short relative time phrase in the copy.
 *
 * NO FINDINGS AND NO CLOCK. That is the difference from findRelativeTimeFaults: this does not
 * ask whether the phrase is true, because the answer changes four times per sequence. It asks
 * whether the phrase is the kind that can stop being true, and those are banned.
 */
export function findShortRelativePhrases(
  text: string,
  sentencesOf: (t: string) => string[],
): ShortRelativeHit[] {
  if (!text?.trim()) return []
  const hits: ShortRelativeHit[] = []
  for (const sentence of sentencesOf(text)) {
    // ═══ A QUESTION RE-ANCHORS ON THE READER'S OWN WEEK, SO IT IS EXEMPT ═══
    //
    // The rule exists so the copy is true WHENEVER IT LANDS, and that is exactly what a
    // forward-looking question already is. "Is a call this week worth twenty minutes?" means
    // the week the reader is in, whenever they read it. "You published the guide this week"
    // means a week the writer was in, and stops being true.
    //
    // MEASURED before this exemption existed, over the 127 stored personalised emails: 13
    // carried a banned phrase and NINE of those were closing questions of exactly that
    // shape. Banning them would have asked for a rewrite of the copy the rule is trying to
    // produce, which is the failure this codebase keeps writing down.
    //
    // THE HOLE, STATED: "Did you post that this week?" is a question about the past and is
    // exempted. It is a shape nothing in the corpus uses, and the fact-check already covers
    // a claim about what they did. Narrowing on tense was tried and needed a past-tense
    // detector inside a question, which is the \w+ed trap one level down.
    if (sentence.trim().endsWith('?')) continue

    for (const re of SHORT_RELATIVE) {
      const m = sentence.match(re)
      if (m) {
        hits.push({ matched: m[0], sentence: sentence.trim() })
        // ONE HIT PER SENTENCE. A sentence saying "just announced this week" is one fault to
        // rewrite, and counting it twice would make the report worse the more ways it is
        // phrased. Same rule assumed-capacity applies per kind.
        break
      }
    }
  }
  return hits
}

/** The rewrite instruction. Names the phrase and what to put there, not the rule. */
export function shortRelativeFeedback(hit: ShortRelativeHit): string {
  return (
    `uses ${JSON.stringify(hit.matched)}, which stops being true between writing and sending: ` +
    `${JSON.stringify(hit.sentence)}. Name the month or the date instead.`
  )
}
