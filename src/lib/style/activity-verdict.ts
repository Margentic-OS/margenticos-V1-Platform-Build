// A bridge or observation that tells the reader their own visible activity is failing, or
// that names what they lack.
//
// WHY THIS EXISTS. The writer's brief forbids both, in five separate places, and nothing
// has ever checked either. Per ADR-028 a prompt instruction is advisory and only code
// gates. The measured consequence is that the same fault reaches real prospects run after
// run while every gate reports green.
//
// REPORT ONLY ON THIS COMMIT. checkActivityVerdict returns an empty array while
// ACTIVITY_VERDICT_MODE says 'report', and logs every hit with the prospect and the part.
// Nothing can be rejected by it. The reason is precision: a detector of this kind was
// previously right about half the time, which is unusable as a gate, and the only way to
// find out what this one's rate is here is to accumulate hits against real copy first.
//
// THE HARD PART IS NOT FINDING NEGATION. It is telling the BANNED shape from the PERMITTED
// one, because they are built from the same words. The brief explicitly permits conceding
// what works and then naming what that activity does not reach:
//
//   PERMITTED: "... keeps existing contacts close but rarely puts your name in front of
//              people who have never heard of you."
//              The gap lands on people who do NOT know them. This is the brief's own
//              WORKING example and it is the most common bridge shape in the corpus.
//
//   BANNED:    "The people who heard you speak don't yet know you take on new clients."
//              The gap lands on people who DO know them. The brief's own FAILING example.
//
// Both sentences contain a negated verb of reaching. The discriminator is WHO the negation
// is predicated of, not whether a negation is present, so a detector built on negation
// alone would fire on the permitted shape far more often than on the banned one.
//
// SO EACH RULE BELOW REQUIRES TWO THINGS TO COINCIDE, never one. A negation on its own is
// ordinary English and is not evidence of anything.

import { logger } from '@/lib/logger'

export type ActivityVerdictMode = 'report' | 'block'

// TO FLIP: change this to 'block', by hand, and record in the Notion Backlog what the
// accumulated hits showed. Do not flip it on the strength of the examples in the test
// file: those prove the detector can fire and can stay silent, which is a different
// question from how often it is right about copy nobody wrote for it.
export const ACTIVITY_VERDICT_MODE: ActivityVerdictMode = 'report'

export type ActivityVerdictKind =
  /** Names what the reader lacks: "with no visible footprint", "no mention of X". */
  | 'names_an_absence'
  /** Lands the gap on an audience that has already met them. */
  | 'already_acquainted_gap'
  /** States outright that something they are visibly doing does not work. */
  | 'activity_declared_failing'

export interface ActivityVerdictHit {
  part: 'observation' | 'bridge'
  kind: ActivityVerdictKind
  /** The sentence the hit was found in, for a human to judge. */
  sentence: string
  /** The exact span that matched, so a false positive is diagnosable without re-running. */
  matched: string
}

/**
 * Things the reader can be said to own and be visibly doing. Used as the anchor half of
 * rule 3: a negation is only interesting when it is predicated of one of these.
 *
 * DELIBERATELY NOT INDUSTRY-SPECIFIC. Every entry is a channel or artefact any B2B
 * business of any kind may have, which is what keeps this usable for a client in any
 * sector. No buyer archetype, no sector noun, no growth model.
 */
const OWNED_ACTIVITY =
  '(?:blog|posts?|feed|content|website|site|page|profile|newsletter|talks?|keynotes?|' +
  'speaking|events?|network|brand|marketing|outreach|referrals?|introductions?|' +
  'reputation|articles?|podcast|videos?|webinars?)'

/** Verbs of being known, reached or acted upon. The half a banned sentence negates. */
const REACH_VERB =
  '(?:know|knows|knew|hear|hears|heard|reach|reaches|reached|find|finds|found|see|sees|saw|' +
  'call|calls|called|contact|contacts|reply|replies|respond|responds|follow|follows|' +
  'convert|converts|book|books|buy|buys|ask|asks|enquire|enquires|inquire|inquires)'

/** Ways English says "not", including the contracted and adverbial forms. */
const NEGATOR =
  "(?:do(?:es)? ?n[o']t|do not|does not|did ?n[o']t|did not|ca ?n[o']t|cannot|can not|" +
  "wo ?n[o']t|will not|have ?n[o']t|have not|has ?n[o']t|has not|is ?n[o']t|is not|" +
  "are ?n[o']t|are not|never|rarely|seldom|no longer|still ?n[o']t)"

/**
 * Rule 1. NAMES AN ABSENCE.
 *
 * "NEVER NAME WHAT THEY LACK. No 'there is no', no 'nothing about', no 'with no case
 * studies', no lists of what is missing from their site or their feed."
 *
 * Bound to a following noun in every case. A bare "no" is a determiner that does ordinary
 * work all over English ("no two clients are alike"), so the pattern never fires on one.
 */
const ABSENCE_PATTERNS: ReadonlyArray<RegExp> = [
  // "with no visible footprint", "and no dated content", "with no mention of new mandates"
  /\b(?:with|and|but)\s+no\s+(?:visible|dated|recent|public|obvious|apparent|other|real)?\s*[a-z]+/i,
  // "no mention of", "no sign of", "no trace of"
  /\bno\s+(?:mention|sign|trace|reference|evidence|record|sight|indication)\s+of\b/i,
  // "there is no", "there are no", "there was nothing"
  /\bthere\s+(?:is|are|was|were)\s+(?:no|nothing|none)\b/i,
  // "nothing about", "nothing running", "nothing visible"
  /\bnothing\s+(?:about|on|in|visible|running|there|behind|underneath|else)\b/i,
  // "not a single post", "not one case study"
  /\bnot\s+(?:a\s+single|one)\s+[a-z]+/i,
  // The artefact nouns the brief names directly, negated.
  new RegExp(`\\bno\\s+(?:visible|dated|recent|public)?\\s*${OWNED_ACTIVITY}\\b`, 'i'),
]

/**
 * Rule 2. THE GAP LANDS ON AN AUDIENCE THEY ALREADY HAVE.
 *
 * "Never name a gap about converting, following up with, or re-engaging an audience they
 * already have." The brief's failing example is a room that has already met them.
 *
 * The subject must be an audience established as ALREADY ACQUAINTED, and the predicate
 * must be negative. Both, within one sentence. The permitted inverse, where the gap lands
 * on people who have never heard of them, cannot match: its acquaintance clause is itself
 * negated, and the exclusion below removes it explicitly.
 */
const ACQUAINTED_SUBJECT =
  '(?:who|that)\\s+(?:already\\s+)?(?:heard|saw|met|know|knows|follow|follows|read|reads|' +
  'attended|watched|hired|worked with|have met|have heard|have seen)'

const ALREADY_ACQUAINTED_PATTERNS: ReadonlyArray<RegExp> = [
  // "...who heard you speak don't yet know...", "...that already follow you never reply..."
  new RegExp(`${ACQUAINTED_SUBJECT}\\b[^.!?;]{0,70}?\\b${NEGATOR}\\b`, 'i'),
  // "don't yet know", "haven't yet heard" — the shape on its own is always this fault.
  new RegExp(`\\b${NEGATOR}\\s+yet\\s+${REACH_VERB}\\b`, 'i'),
  // "are already reading your feed", "already know the name" as the whole point of the gap
  /\balready\s+(?:reading|following|watching|subscribed)\b/i,
]

/**
 * The brief's WORKING shape, which rule 2 must never claim. An audience defined by NOT
 * knowing them is the permitted destination for a gap, and it is the most common bridge in
 * the corpus, so this exclusion is what keeps the rule usable at all.
 */
const NEVER_HEARD = new RegExp(
  // MIRRORS THE ACQUAINTANCE VERBS ABOVE, negated. It listed a subset once and rule 3 then
  // fired on "prospects who have never READ your posts do not know the firm exists", which
  // is the permitted shape and had shipped. An exclusion narrower than the thing it
  // excludes is the same defect as a gate narrower than the class it exists to find.
  '\\b(?:never|not)\\s+(?:yet\\s+)?(?:heard|met|seen|read|visited|encountered|' +
  'come across|been to|spoken to|worked with|dealt with)\\b' +
  '|\\bhave\\s+no\\s+idea\\s+(?:who|what)\\b',
  'i',
)

/**
 * Rule 3. THE ACTIVITY IS DECLARED TO BE FAILING.
 *
 * "And never tell them something they are doing is not working." Requires the owned
 * activity and the negation to be the same clause, which is what separates it from a
 * sentence that merely mentions a channel.
 */
const FAILING_PATTERNS: ReadonlyArray<RegExp> = [
  // "What a strong network cannot do is ..." — the brief's own worked failure.
  /\bwhat\s+[^.!?]{0,80}?\b(?:cannot|can ?n[o']t|can not)\s+do\b/i,
  // "your blog is not reaching", "their events do not bring"
  // POSSESSIVE ONLY, never a bare "the". "The weeks between speaking engagements rarely
  // fill themselves" is a claim about the weeks, not about their speaking, and the bare
  // article let the activity noun sit anywhere in the subject rather than being its head.
  new RegExp(
    `\\b(?:your|their)\\s+(?:[a-z]+\\s+){0,2}${OWNED_ACTIVITY}\\b[^.!?;]{0,40}?\\b${NEGATOR}\\b`,
    'i',
  ),
  // "is not working", "are not landing" — said of anything at all.
  new RegExp(`\\b(?:is|are|was|were)\\s+(?:${NEGATOR}|not)\\s+(?:really\\s+)?` +
    '(?:working|landing|reaching|bringing|generating|producing|converting|paying off)\\b', 'i'),
]

/** Split on sentence ends. Crude on purpose: a hit reports its sentence for a human. */
function sentencesOf(text: string): string[] {
  return (text || '')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean)
}

function scan(
  part: 'observation' | 'bridge',
  text: string,
  patterns: ReadonlyArray<RegExp>,
  kind: ActivityVerdictKind,
  excludeIf?: RegExp,
): ActivityVerdictHit[] {
  const hits: ActivityVerdictHit[] = []
  for (const sentence of sentencesOf(text)) {
    if (excludeIf?.test(sentence)) continue
    for (const pattern of patterns) {
      const m = sentence.match(pattern)
      if (m) {
        hits.push({ part, kind, sentence, matched: m[0] })
        break
      }
    }
  }
  return hits
}

/**
 * Pure. Returns every hit in the observation and the bridge.
 *
 * BOTH PARTS, because the absence ban says so outright: "THE ABSENCE BAN. IT COVERS THE
 * OBSERVATION AND THE BRIDGE, BOTH." A bridge names what they lack just as easily as an
 * observation does, and the reverse is equally true: the absence that prompted this check
 * was in an observation.
 */
export function findActivityVerdicts(observation: string, bridge: string): ActivityVerdictHit[] {
  const parts: ReadonlyArray<['observation' | 'bridge', string]> = [
    ['observation', observation],
    ['bridge', bridge],
  ]
  const hits: ActivityVerdictHit[] = []
  for (const [part, text] of parts) {
    // NEVER_HEARD guards ALL THREE rules, not just the second. A sentence whose gap lands
    // on people who have never encountered them is the brief's WORKING shape wherever it
    // appears, and which rule happens to match it says nothing about whether it is a fault.
    hits.push(...scan(part, text, ABSENCE_PATTERNS, 'names_an_absence', NEVER_HEARD))
    hits.push(...scan(part, text, ALREADY_ACQUAINTED_PATTERNS, 'already_acquainted_gap', NEVER_HEARD))
    hits.push(...scan(part, text, FAILING_PATTERNS, 'activity_declared_failing', NEVER_HEARD))
  }
  return hits
}

/**
 * Logs what it found and returns the failure strings a caller would act on, which is EMPTY
 * in report mode. That is the whole of the report-only behaviour: the hit is logged either
 * way, and only a blocking mode turns it into something that ends an attempt.
 */
export function checkActivityVerdict(
  observation: string,
  bridge: string,
  context: { prospectId: string },
  /**
   * Defaulted to the module constant, which is what production uses. A PARAMETER ONLY SO
   * THE BLOCKING PATH CAN BE EXECUTED BY A TEST while the constant says 'report'. A flip
   * that has never been run is a flip nobody has tested. Production never passes this.
   */
  mode: ActivityVerdictMode = ACTIVITY_VERDICT_MODE,
): string[] {
  const hits = findActivityVerdicts(observation, bridge)
  if (hits.length === 0) return []

  for (const hit of hits) {
    logger.info('activity-verdict: scored, not gated', {
      ...context,
      mode,
      part: hit.part,
      kind: hit.kind,
      matched: hit.matched,
      sentence: hit.sentence,
    })
  }

  if (mode !== 'block') return []

  return hits.map(hit => {
    const why =
      hit.kind === 'names_an_absence'
        ? 'names what they lack. Notice something that IS there instead'
        : hit.kind === 'already_acquainted_gap'
          ? 'lands the gap on people who have already met them. Point it at people who have not'
          : 'tells them something they are visibly doing does not work. Say what tends to happen instead'
    return `the ${hit.part} ${why}: "${hit.matched}"`
  })
}
