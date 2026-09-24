// A CLAIM ABOUT THE READER'S TIME, OR ABOUT WHO DOES THEIR SELLING.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS IS FOR. Copy generated from a client's documents tends to collapse onto that
// client's core pain, whatever the prospect's actual situation, because the pain is the one
// reason available when a trigger carries none of its own. When the pain is about capacity,
// every email ends up asserting that this particular reader is short of time and personally
// does the selling. Neither is known. Both are guesses about a stranger's business, and a
// wrong guess in the second line is worse than a generic one.
//
// IT IS NOT ABOUT ANY PARTICULAR CLIENT'S PAIN. The shapes below are the shapes of an
// assumption about a reader, and they are banned in any client's copy for the same reason.
// A client whose offer genuinely IS about time still may not tell a stranger how their week
// goes; it may only say what its own service does.
//
// TWO STRENGTHS, ONE DETECTOR:
//   BLOCKING  on a generated trigger reason, where the text is short, written once per
//             client, and a rewrite costs one call.
//   REPORT    on per-prospect copy, where precision is unproven and a false positive would
//             throw away a researched email. Count first, decide later. Same discipline as
//             activity-verdict, which ran report-only until 246 attempts had been scored.
//
// WHAT IS DELIBERATELY NOT BANNED, because these are claims about the SENDER or about an
// event, not about the reader:
//   "We keep outbound running so the next meetings are booked before the current work ends."
//   "Capacity is being added before the work that pays for it is booked."
//   "A panel puts the firm in front of a room it has not met."
// ═════════════════════════════════════════════════════════════════════════════

export type AssumedCapacityKind = 'their_time' | 'who_sells'

export interface AssumedCapacityHit {
  kind: AssumedCapacityKind
  /** The matched text, for the log line and the report. */
  matched: string
  /** The sentence it was found in. */
  sentence: string
}

/**
 * CLAIMS ABOUT THE READER'S TIME OR CAPACITY.
 *
 * Every pattern requires a SECOND-PERSON POSSESSIVE or subject, so the same noun used about
 * the sender or about the world does not match. "your week" is a claim about them; "the
 * weeks after a launch" is not.
 */
const THEIR_TIME: RegExp[] = [
  // "your time", "your week", "your diary", "your calendar", "your hours", "your day(s)"
  /\byour\s+(own\s+)?(time|week|weeks|day|days|diary|calendar|schedule|hours|bandwidth|capacity|attention|focus)\b/i,
  // "the hours you", "the time you", "the weeks you"
  /\bthe\s+(hours?|time|weeks?|days?)\s+(you|your)\b/i,
  // "you are busy", "you're stretched", "you have no time", "you don't have time"
  /\byou(?:'re| are|r)?\s+(too\s+)?(busy|stretched|stretched thin|swamped|flat out|at capacity)\b/i,
  /\byou\s+(do\s+not|don't|doesn't|have no|haven't)\s+have\s+(the\s+)?(time|hours|capacity|bandwidth)\b/i,
  // "while you are delivering", "when you're in delivery", "when delivery gets busy"
  /\bwhile\s+you(?:'re| are)?\s+\w*\s*(deliver|delivering|in delivery|billing|heads down)\b/i,
  /\bwhen\s+(delivery|client work|the work)\s+(gets|is)\s+busy\b/i,
  // "takes the hours", "eats into your", "absorbs your"
  /\b(takes?|eats? into|absorbs?|swallows?|consumes?)\s+(the\s+)?(hours|time|weeks)\b/i,
  // "first weeks run on your time"
  /\brun\s+on\s+your\s+\w+\b/i,
  // "that is a long time to carry", "carrying both"
  /\bto\s+carry\s+both\b/i,
  // PERSON-AGNOSTIC CAPACITY CLAIMS. A trigger's reason is written in the third person
  // ("they", "the company"), not the second, so every pattern above anchored to "you"
  // barely applies there. These say someone is short of capacity whoever the subject is,
  // and that is the claim being banned, not the pronoun it is made with.
  /\b(too busy|no time|not enough time|short of (?:time|hours)|stretched thin|spread thin|at capacity|already full)\b/i,
  // A POSSESSIVE ON A ROLE, plus a noun of attention or capacity. "your attention" was
  // already banned; "the founder's attention" is the same claim in the third person, which
  // is the person a trigger reason is written in.
  /\b(the\s+)?(founder|owner|principal|partner|director|team)(?:'s|s')\s+(time|attention|focus|capacity|bandwidth|hours|week|weeks|diary|calendar|schedule)\b/i,
]

/**
 * CLAIMS ABOUT WHO DOES THE SELLING.
 *
 * The verbs are the outbound ones. The subject has to be the reader or a named single person
 * at their company, which is what separates "you do the prospecting" from "the prospecting
 * gets done".
 */
const SELL_VERB = '(prospect(?:ing)?|outreach|outbound|selling|sales|business development|bd|pipeline|new business|chasing|follow[- ]?up)'

const WHO_SELLS: RegExp[] = [
  // "you do the prospecting", "you're doing the outreach", "you handle the outbound"
  new RegExp(`\\byou(?:'re| are)?\\s+(do(?:ing)?|handl(?:e|ing)|run(?:ning)?|own(?:ing)?|manag(?:e|ing))\\s+(the\\s+|all\\s+the\\s+|your\\s+own\\s+)?${SELL_VERB}\\b`, 'i'),
  // "you don't touch the prospecting", "no prospecting on your end"
  new RegExp(`\\bno\\s+${SELL_VERB}\\s+on\\s+your\\s+(end|side|part)\\b`, 'i'),
  new RegExp(`\\byou\\s+(do\\s+not|don't)\\s+touch\\s+(the\\s+)?${SELL_VERB}\\b`, 'i'),
  // "the only person responsible for pipeline", "sole person doing outreach"
  new RegExp(`\\b(only|sole)\\s+person\\s+\\w*\\s*(responsible for|doing|handling|running)?\\s*${SELL_VERB}\\b`, 'i'),
  // "you are the one doing", "he is the one who"
  /\b(you|he|she|they)(?:'re| is| are)?\s+the\s+one\s+(who\s+)?(doing|does|handles?|runs?)\b/i,
  // "without you chasing", "without you lifting"
  /\bwithout\s+you\s+\w+ing\b/i,
  // "the founder does/handles/runs the selling" — a claim about their staffing
  new RegExp(`\\bfounder\\s+(does|handles?|runs?|owns?|is doing)\\s+(the\\s+|all\\s+the\\s+)?${SELL_VERB}\\b`, 'i'),
  // "founder-led pipeline/selling", "founder-dependent pipeline" as an assertion about them
  new RegExp(`\\bfounder[- ](led|dependent|driven)\\s+${SELL_VERB}\\b`, 'i'),
  // PERSON-AGNOSTIC STAFFING CLAIMS, for the same reason as the capacity ones above.
  // "nobody owns pipeline", "no one is left doing the outreach". A claim that a company
  // has nobody on something is a claim about how it is staffed, which nobody has
  // established. Deliberately NOT triggered by "no buyers" or "no existing clients":
  // those are about the market, not about who works there.
  /\b(nobody|no one|no-one)\s+(is\s+)?(left\s+)?(doing|does|owns?|handles?|running|runs?|responsible\s+for|to\s+do)\b/i,
  // ── ADDED 2026-09-23 AFTER A MEASURED MISS ──────────────────────────────────
  // The first derivation run passed the gate with 0 faults and produced three reasons that
  // plainly broke the rule: "the founder re-enters delivery and pipeline stops", "shifts
  // them away from generating new pipeline", "the person who owned outbound is gone, so
  // pipeline generation has no operator". Every pattern above was about the READER doing
  // the selling; none was about a NAMED ROLE doing it, or about the selling stopping.
  //
  // WHO HELD THE JOB: "the person who owned outbound", "whoever ran the prospecting".
  new RegExp(`\\b(who|whoever)\\s+(owned|owns|ran|runs|handled|handles|did|does|drove|drives)\\s+(the\\s+)?${SELL_VERB}\\b`, 'i'),
  // WHAT A NAMED ROLE DOES WITH THEIR TIME: "the founder re-enters delivery".
  /\b(the\s+)?(founder|owner|principal|partner|director)\s+(re-?enters?|returns? to|goes? back (in)?to|is back in|drops? back into|moves? back into)\b/i,
  // THE SELLING STOPPING, as a claim about this company rather than about the event.
  new RegExp(`\\b${SELL_VERB}\\s+(stops|stalls|halts|pauses|freezes|dries up|resets|goes quiet|has no operator)\\b`, 'i'),
  // MOVED OFF THE SELLING: "shifts them away from generating new pipeline".
  new RegExp(`\\b(away from|off)\\s+(generating|doing|running|driving)\\s+(new\\s+)?${SELL_VERB}\\b`, 'i'),
  // NOBODY LEFT ON IT, stated as a shortage of people rather than with "nobody".
  new RegExp(`\\b${SELL_VERB}\\s+(generation\\s+)?has\\s+no\\s+(operator|owner|one)\\b`, 'i'),
  // ── SECOND MEASURED WIDENING, same day, same method ───────────────────────
  // WHO BRINGS THE WORK IN: "changing who generates new business".
  /\bwho\s+(generates?|creates?|brings?\s+in|wins?|finds?|found|lands?|books?|drives?|owns?|does|handles?|runs?|sources?)\s+(the\s+|new\s+|its\s+|their\s+)*(business|pipeline|leads?|meetings?|clients?|work|revenue|outreach|outbound|prospecting|sales)\b/i,
  // THE ONLY ONE ON IT: "removes the only dedicated pipeline function". Asserting a company
  // has exactly one of something is a claim about its staffing.
  new RegExp(`\\b(the\\s+)?only\\s+(dedicated\\s+|full[- ]time\\s+)?${SELL_VERB}\\s+(function|person|resource|hire|role|capability)\\b`, 'i'),
  // A ROLE'S OWN CHANNEL, as the thing the company sells through: "the founder's network".
  /\b(the\s+)?(founder|owner|principal|partner|director)(?:'s|s')\s+(network|contacts|relationships|connections|referrals?)\b/i,
  // ── THIRD MEASURED WIDENING, 2026-09-24, found the same way as the first two ────────
  // "A big project pulls the founder into the work" and "That job now falls to the founder".
  // The existing role patterns covered a role MOVING ITSELF ("re-enters", "goes back into")
  // and said nothing about a role BEING MOVED, or about work LANDING on one. Both are the
  // same claim: that this named person is the one who ends up doing it.
  /\b(pulls?|drags?|draws?|puts?|takes?|forces?)\s+(the\s+)?(founder|owner|principal|partner|director)\s+(in|into|back|out)\b/i,
  /\b(falls?|lands?|rests?|sits?|defaults?)\s+(back\s+)?(to|on|with)\s+(the\s+)?(founder|owner|principal|partner|director)\b/i,
]

/** Split on sentence ends, keeping it simple: this reports, it does not parse. */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean)
}

export function findAssumedCapacityClaims(text: string): AssumedCapacityHit[] {
  if (!text || !text.trim()) return []
  const hits: AssumedCapacityHit[] = []
  for (const sentence of sentencesOf(text)) {
    for (const [kind, patterns] of [['their_time', THEIR_TIME], ['who_sells', WHO_SELLS]] as const) {
      for (const re of patterns) {
        const m = sentence.match(re)
        if (m) {
          hits.push({ kind, matched: m[0], sentence })
          break   // ONE HIT PER KIND PER SENTENCE. A sentence matching three time patterns
                  // is one fault, and counting it three times would make the report look
                  // worse the more ways it is phrased.
        }
      }
    }
  }
  return hits
}

/** The rewrite instruction, used where this blocks. Names the offending text, not the rule. */
export function assumedCapacityFeedback(hits: readonly AssumedCapacityHit[]): string {
  const quoted = [...new Set(hits.map(h => `"${h.matched}"`))].slice(0, 4).join(', ')
  return `This assumes something about the reader that nobody has established: ${quoted}. ` +
    `You do not know how their week goes, how busy they are, or who in their company does ` +
    `the selling. State what the event itself means for any company it describes, and say ` +
    `nothing about the reader's time or their staffing.`
}
