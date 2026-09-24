// PROMISING TO REACH AN AUDIENCE THE PROSPECT ALREADY HAS.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS IS FOR. Outbound reaches people who have never heard of the prospect. Copy that
// promises to reach the prospect's OWN readers, listeners, followers, subscribers,
// attendees or site visitors describes work nobody is selling, and a prospect who says yes
// to it has been mis-sold. It is not a style fault. It is a promise the sender cannot keep.
//
// WHY IT LIVES HERE NOW. It was written on 2026-09-22 as two regexes inside an analysis
// script and never promoted, so for two full runs it was measured and could not act:
// it appeared in no gate, no test and no production path. A check that lives only in a
// report is a check that cannot fail a build. Moved into src on 2026-09-24 with no change
// to what it matches, so the figures it produced in those runs remain comparable.
//
// TWO THINGS MUST CO-OCCUR IN ONE SENTENCE, which is what keeps it off ordinary copy:
//   a word for an audience THE PROSPECT ALREADY HAS, and
//   a verb about the SENDER reaching or converting them.
// "Your listeners" alone is a fact about them. "We reach your listeners" is a promise.
//
// INDUSTRY-AGNOSTIC BY CONSTRUCTION. Every word below names a kind of audience or a kind of
// contact. None names an industry, a buyer type, a service or a client.
// ═════════════════════════════════════════════════════════════════════════════

import { splitIntoSentences } from './sentence-count'

/** An audience the PROSPECT already has, pointed at as theirs. */
const THEIR_AUDIENCE =
  /\b(your|those|these|that)\s+(listeners?|readers?|attendees?|followers?|subscribers?|viewers?|visitors?|audience|list|people who (?:listened|read|attended|watched|follow))\b/i

/** The SENDER reaching or converting them. */
const REACH_VERB =
  /\b(reach|reaching|contact|contacting|email|emailing|message|messaging|convert|converting|turn|turning|nurture|nurturing|re-?engage|re-?engaging|follow up with|following up with|get in front of|getting in front of|run outbound to|running outbound to|send to|sending to|target|targeting)\b/i

/**
 * ASSERTING WHO DID OR DID NOT CONSUME THE PROSPECT'S OWN CONTENT. Added 2026-09-24.
 *
 * "The buyers who never read that post do not know the firm exists" is a claim about the
 * reach of their own publishing, which nobody outside their analytics can know. It is the
 * same fault as promising to reach their audience, stated from the other side: the first
 * promises to contact people they already have, this one asserts who they have not reached.
 *
 * REQUIRES A POINTER AT THEIR CONTENT, so ordinary sentences about buyers do not match.
 */
const UNREACHED_AUDIENCE =
  /\b(who|that)\s+(never|have\s+not|haven[\u2019']t|did\s+not|didn[\u2019']t|has\s+not|hasn[\u2019']t)\s+(read|seen|heard|watched|attended|followed|come across|found)\b/i
const THEIR_CONTENT =
  /\b(that|this|your|the)\s+(post|article|piece|episode|webinar|talk|newsletter|video|content|page|site|feed)\b/i

export interface AudienceContactHit {
  /** The matched audience phrase, for the log line and the report. */
  matched: string
  /** The sentence it was found in. */
  sentence: string
}

/**
 * Every sentence promising to reach an audience the prospect already has.
 *
 * REPORTS BOTH HALVES SO A READER CAN JUDGE IT. The matched audience phrase is the part
 * that names whose audience it is, and the sentence is what has to be rewritten.
 */
export function findAudienceContactClaims(text: string): AudienceContactHit[] {
  if (!text || !text.trim()) return []
  const hits: AudienceContactHit[] = []
  for (const sentence of splitIntoSentences(text)) {
    const audience = sentence.match(THEIR_AUDIENCE)
    if (audience && REACH_VERB.test(sentence)) {
      hits.push({ matched: audience[0], sentence: sentence.trim() })
      continue
    }
    const unreached = sentence.match(UNREACHED_AUDIENCE)
    if (unreached && THEIR_CONTENT.test(sentence)) {
      hits.push({ matched: unreached[0], sentence: sentence.trim() })
    }
  }
  return hits
}

/** The rewrite instruction. Names the offending text, not the rule. */
export function audienceContactFeedback(hits: readonly AudienceContactHit[]): string {
  const first = hits[0]
  return (
    `promises to reach an audience they already have (${JSON.stringify(first.matched)}): ` +
    `${JSON.stringify(first.sentence)}. The work reaches people who have NOT heard of them. ` +
    'Say what it puts in front of new buyers, never what it does with their existing audience.'
  )
}
