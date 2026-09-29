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

import { splitIntoSentences } from './sentence-count'

export type AssumedCapacityKind = 'their_time' | 'who_sells' | 'they_lack' | 'their_money'

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
/**
 * The nouns that name a share of somebody's finite time or attention, and the verbs that
 * divide one. ONE DEFINITION EACH, used in both orders of the division pattern below.
 *
 * Nouns only, verbs of division only. Nothing here names a service, an industry, a buyer
 * type or an act of selling, so the shapes built from them stay general.
 */
/**
 * Nouns naming a share of somebody's MONEY: what comes in, what is held, what is owed to
 * them. ONE DEFINITION, used by every money shape below, for the reason the division patterns
 * learned the hard way: a second copy of a noun list loses an entry and nothing says so.
 *
 * DELIBERATELY WITHOUT "price", "pricing", "cost" or "invoice". Those name a NUMBER ON AN
 * OFFER, which anyone may mention neutrally, and a rule that fired on them would reject a
 * sentence saying what something costs. What is banned is asserting how much of it THEY have.
 */
const MONEY_NOUN = '(income|revenue|revenues|turnover|cash|cashflow|cash flow|billings|fees|' +
  'margins?|profits?|earnings|takings|receipts|funding|runway)'

const CAPACITY_NOUN = '(time|hours?|attention|focus|capacity|bandwidth|energy|days?|weeks?)'
const DIVISION_VERB = '(split|divided|shared|spread|stretched)'

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
  // A DETERMINER IS REQUIRED. "takes the hours" names specific hours and is a claim about
  // them; "takes time" is the idiom for "is slow" and says nothing about anybody's diary.
  // Measured 2026-09-25: "that kind of hire takes time to ramp" was rejected as a capacity
  // claim, and it is about the hire ramping.
  /\b(takes?|eats? into|absorbs?|swallows?|consumes?)\s+(the|your|their)\s+(hours|time|weeks?|day|days)\b/i,
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

  // ═══ ADDED 2026-09-24, from six lines that shipped and none of which was detected ═══
  //
  // Every pattern above anchors the capacity noun to "your" or to a CLOSED LIST of role
  // words. So the same claim made with a possessive on a NAME, with a definite article, with
  // a verb form the list omits, or as a zero-sum trade, was invisible. Four shapes, each
  // named by its grammar rather than its vocabulary, so none carries an industry, a service
  // or a buyer type. The sender exemption below applies to all of them.

  // A POSSESSIVE ON ANY NAME, plus a capacity noun. The role list was the arbitrary part:
  // a possessive on a company or a person is the same claim as a possessive on a role.
  // "Halden's attention is fully committed" says whose attention it is.
  /\b[A-Z][A-Za-z0-9&.\u2019'-]*(?:[\u2019']s|s[\u2019'])\s+(time|attention|focus|capacity|bandwidth|hours?|week|weeks|day|days|diary|calendar|schedule|energy)\b/,

  // A CAPACITY NOUN AS THE SUBJECT OF AN ALLOCATION. "The bandwidth that used to go to
  // business development is now going elsewhere" asserts where the reader's capacity goes
  // without once saying "your". The noun is the subject and the verb moves it.
  /\b(time|hours?|bandwidth|capacity|attention|focus|energy|effort)\b[^.!?]{0,60}\b(used to go|now goes|now going|is going|is now going|goes to|went to|goes into|went into)\b/i,

  // AN ACTIVITY CONSUMING A UNIT OF TIME. The verb list above holds "consumes" and not
  // "consuming", and the noun list holds "weeks" and not "week", so "delivery is consuming
  // the week" passed on two separate omissions.
  /\b(consum\w+|eat\w*\s+into|absorb\w*|swallow\w*|soak\w*\s+up|tak\w+\s+up)\s+(the\s+|a\s+)?(hours?|time|weeks?|days?|month|months|diary|calendar|bandwidth|capacity)\b/i,

  // A ZERO-SUM TIME TRADE. "every hour spent chasing X is an hour not spent on Y" states
  // how the reader's hours divide, which is the same assumption in arithmetic clothing.
  /\b(an?|every|each)\s+(hour|day|week|minute|afternoon|morning)\b[^.!?]{0,80}\bnot\s+(spent|going|available|free)\b/i,

  // ═══ ADDED 2026-09-29: HOW THE READER'S HOURS OR ATTENTION ARE DIVIDED ═══
  //
  // Measured on the stored cohort: the three patterns immediately above this block scored
  // ZERO on every sentence of the one example the operator had named by hand, while the
  // suite's own positive controls fired. The detector was working; it had no shape for the
  // claim. Precision was 6 of 6 and recall was the unmeasured half, which is the half that
  // decides what a gate is worth.
  //
  // WHAT THESE THREE HAVE IN COMMON, and why they are three rather than a word list: each
  // asserts a DIVISION of the reader's finite time between two claims on it. That is a fact
  // about how their week actually goes, which is the thing nobody outside the business can
  // see. Each is named by its grammar. None carries an industry, a service, a buyer type or
  // a verb of selling, and the existing role list is untouched: a division claim does not
  // become acceptable because it is made about a job title the list happens to omit.

  // CONTENTION FOR ONE POOL OF TIME. A verb of competing or sharing, then "the same" plus a
  // unit of time or attention. The verb is required: "at the same time" is the ordinary
  // idiom for simultaneity and says nothing about anyone's week, and a stored observation
  // reporting two businesses run "at the same time since 2022" is a visible fact.
  /\b(compet\w+|contend\w+|vie\w*|shar\w+|split\w*|divid\w+|draw\w*|pull\w*)\b[^.!?]{0,30}\bthe\s+same\s+(hours?|time|days?|weeks?|attention|focus|capacity|bandwidth|energy)\b/i,

  // THE ZERO-SUM TRADE WITHOUT THE WORD "NOT". The pattern above requires "not spent" or
  // "not going", so the same arithmetic written as a loss to the other side was invisible:
  // "every hour you spend on one is an hour the other never gets back". The construction
  // itself, a unit of time equated to a unit of time, is the claim.
  /\b(an?|every|each)\s+(hour|day|week|minute|afternoon|morning)\b[^.!?]{0,80}\bis\s+an?\s+(hour|day|week|minute|afternoon|morning)\b/i,

  // TIME OR ATTENTION EXPLICITLY DIVIDED. A capacity noun and a verb of division, in either
  // order, with the division landing across two or more claims on it.
  //
  // BOTH ORDERS ARE BUILT FROM ONE NOUN LIST, and that is not tidiness. Written out twice,
  // the second copy lost `days?` and `weeks?` within a minute of being typed, and the only
  // reason it was caught is that a control sentence used "the week". Two lists that must
  // agree are the drift this codebase keeps paying for; there is one list here and the
  // second order cannot disagree with the first.
  new RegExp(`\\b${CAPACITY_NOUN}\\b[^.!?]{0,40}\\b${DIVISION_VERB}\\s+(between|across|over|among)\\b`, 'i'),
  new RegExp(`\\b${DIVISION_VERB}\\s+(between|across|over|among)\\b[^.!?]{0,40}\\b${CAPACITY_NOUN}\\b`, 'i'),
]

/**
 * ═══ WHAT THE READER'S MONEY IS DOING. Added 2026-09-29. ═══
 *
 * The same class as the time shapes and the same argument: you can see an event from outside,
 * you cannot see a balance sheet. A sentence asserting what a company earns, holds or has
 * stopped earning is a guess about a stranger's finances, and a wrong one in the second line
 * is worse than a generic line.
 *
 * WHY IT IS A SEPARATE KIND. It is the gap two other checks leave open, measured on the stored
 * cohort: the fact-check can pass a money claim when a finding happens to mention the event
 * behind it, and the firmographic rule bans FIGURES, so a claim carrying no number goes
 * straight through. Prospects 1b2a2796 and 6835f6e6 both shipped one.
 *
 * NO AMOUNT IS NAMED IN ANY PATTERN. Numbers are the firmographic rule's job and it already
 * does it. These are about the ASSERTION, which is why they work without a figure.
 *
 * ANCHORING IS THE CALLER'S JOB, not these patterns'. A money noun in a population statement
 * is a legitimate bridge, and Email 1's bridge is required to be one. isUnambiguousReaderClaim
 * is what separates "firms lose the income behind them when a contract ends" from the same
 * sentence with this reader's name in it, and both gates now apply it.
 */
const THEIR_MONEY: RegExp[] = [
  // A POSSESSIVE, SECOND PERSON OR ON A NAME, PLUS A MONEY NOUN. "your revenue", "your second
  // income", "Acme's billings". The same two shapes the time patterns use, because a
  // possessive is how a claim about whose money it is gets made.
  new RegExp(`\\byour\\s+(own\\s+)?(\\w+\\s+){0,2}${MONEY_NOUN}\\b`, 'i'),
  new RegExp(`\\b[A-Z][A-Za-z0-9&.\u2019'-]*(?:[\u2019']s|s[\u2019'])\\s+${MONEY_NOUN}\\b`, ''),

  // AN ABSENCE OF MONEY. "without a second income behind it", "without the revenue it was
  // running beside". Both stored examples are this shape, and neither carries a figure.
  new RegExp(`\\bwithout\\s+(a|an|any|the|that|its|their|your)\\s+(\\w+\\s+){0,2}${MONEY_NOUN}\\b`, 'i'),

  // ── TWO SHAPES TRIED AND DROPPED, 2026-09-29, recorded so they are not re-derived ──
  //
  // MONEY AS THE SUBJECT OF A LOSS, `<money noun> ... stopped|dried up|is gone`. It fires on
  // "Steady income just stopped", which is in this module's own leave-alone list: as a trigger
  // reason that is the CONSEQUENCE OF THE EVENT, which is what a reason is required to be,
  // not a guess about anyone. A detector that rejects the copy the rules ask for is worse
  // than no detector.
  //
  // THEY NEED OR LACK MONEY, `needs|lacks|replace ... <money noun>`. It fired on nothing in
  // the corpus, so it is unmeasured recall, and "needs" is the ordinary verb of a trigger
  // reason. The highest-risk phrasing in the register this detector also gates.
  //
  // Both were dropped because the two stored examples this shape exists for are the ABSENCE
  // form, which the pattern above catches, so neither bought anything measurable.
]

/**
 * CLAIMS ABOUT WHO DOES THE SELLING.
 *
 * The verbs are the outbound ones. The subject has to be the reader or a named single person
 * at their company, which is what separates "you do the prospecting" from "the prospecting
 * gets done".
 */
const SELL_VERB = '(prospect(?:ing)?|outreach|outbound|selling|sales|business development|bd|pipeline|new business|chasing|follow[- ]?up)'

/**
 * ASSERTING THAT THE READER LACKS SOMETHING. Added 2026-09-24.
 *
 * "You need a follow-up system" says they have not got one. It is the same family as the
 * exclusivity rule the house style already states: a problem framed as a pattern survives
 * being wrong, a verdict about what this reader does not have does not.
 *
 * NARROW ON PURPOSE. "You need to see this" is an ordinary sentence and must not match, so
 * the pattern requires a DETERMINER: the claim has to be about a THING they do not have.
 */
const THEY_LACK: RegExp[] = [
  /\byou\s+(need|lack|are missing|have no|haven[\u2019']t got|don[\u2019']t have)\s+(a|an|any|the)\s+\w+/i,
  /\bwithout\s+(a|an|any)\s+\w+[^.!?]{0,40}\byou\b/i,
]

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
  // PAST TENSE AS WELL AS PRESENT, every verb. The list was patched twice for single
  // missing past forms ("found", then "ran") before it was written out properly. A verb
  // list that holds only present tense cannot see a claim about who USED TO do the job,
  // and that is the more common shape, because the trigger is usually that they left.
  /\bwho\s+(generate[sd]?|create[sd]?|brings?\s+in|brought\s+in|wins?|won|finds?|found|lands?|landed|books?|booked|drives?|drove|driven|owns?|owned|does|did|done|handle[sd]?|runs?|ran|sources?|sourced|leads?|led|manage[sd]?|drove)\s+(the\s+|new\s+|its\s+|their\s+)*(business|pipeline|leads?|meetings?|clients?|deals?|work|revenue|outreach|outbound|prospecting|sales)\b/i,
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
  // NOBODY ON IT, said of the WORK rather than of a named function: "that work now has no
  // owner". The pattern above requires a selling noun before "has no owner"; this one takes
  // the generic nouns a reason reaches for when it is avoiding the selling ones.
  /\b(work|job|task|role|it)\s+(now\s+)?has\s+no\s+(owner|operator|one|lead)\b/i,
]

/** Split on sentence ends, keeping it simple: this reports, it does not parse. */
function sentencesOf(text: string): string[] {
  return splitIntoSentences(text)
}

/**
 * A first-person subject, which makes a sentence a statement about the SENDER.
 *
 * The module header already lists sender-side statements as deliberately not banned. Until
 * 2026-09-24 nothing enforced that: the detector matched a capacity noun wherever it sat, so
 * "We map the right targets, run the outreach, and book the meetings directly into your
 * calendar" matched on "your calendar" and read as a claim about the reader's week. It is
 * the opposite: it is the sender saying what it does.
 */
const FIRST_PERSON = /\b(we|our|ours|us|i|my|mine)\b/i

/**
 * An EXPLICIT reference to the reader or their firm: second person, or a possessive on a
 * capitalised name.
 *
 * THIS IS WHAT MAKES A HIT UNAMBIGUOUS. "Your week is full" and "Acme's attention is
 * committed" both say whose capacity is being described. "Delivery is consuming the week"
 * says the same thing impersonally and might be a population statement, which this codebase
 * permits and the bridge is required to be.
 */
const SECOND_PERSON_READER = /\byou(?:[\u2019']re|r|rs|rself)?\b/i

/**
 * True when the capacity claim in this sentence is the SENDER describing its own work.
 *
 * Judged on the text BEFORE the match, because that is where the subject of the clause sits.
 * A first-person subject earlier in the sentence governs what follows.
 */
/**
 * THE READER NOT DOING THE WORK IS A PROMISE ABOUT THE SERVICE.
 *
 * "No prospecting on your end", "You don't touch the prospecting", "without you touching
 * the outreach" all describe what the sender takes over. They are offers, and they are in
 * the client's own approved template, where they were written deliberately.
 *
 * THE POSITIVE FORM IS THE OPPOSITE CLAIM AND STAYS BANNED. "You do all the prospecting
 * yourself" asserts how this reader's business runs, which nobody outside it knows. The
 * grammar tells them apart: a NEGATED activity attributed to the reader is the sender
 * removing it; the same activity asserted is a guess about them.
 *
 * Measured 2026-09-24 against the client's approved copy: without this, two of eighty-six
 * approved sentences were rejected, and both were offer statements.
 */
const READER_NOT_DOING_IT = new RegExp([
  // "without you touching the outreach", "without you lifting a finger"
  '\\bwithout\\s+you\\b',
  // "You don't touch the prospecting", "you never write a list"
  '\\byou\\s+(?:do\\s+not|don[\u2019\']t|never|no\\s+longer)\\s+\\w+',
  // "You stop chasing the calendar"
  '\\byou\\s+stop(?:s|ped)?\\s+\\w+',
  // "No prospecting on your end", "nothing on your side"
  '\\b(?:no|nothing)\\b[^.!?]{0,25}\\bon\\s+your\\s+(?:end|side|part|behalf)\\b',
].join('|'), 'i')

/**
 * ═══ NARROWED 2026-09-29, AND IT WAS EXEMPTING ALMOST EVERYTHING ═══
 *
 * This was a bare alternation of `no|never|without|don't|do not|stop|stops|stopped` matched
 * ANYWHERE in the sentence. Every one of its documented examples ties the negation to the
 * READER not doing the work, but nothing in the pattern required that, so any sentence
 * containing a negation at all was read as a sender promise and exempted from the capacity
 * gate outright.
 *
 * Found by trying to use it. Two stored bridges asserting the reader's finances, prospects
 * 1b2a2796 and 6835f6e6, were both exempted on the word "without" in "without a second income
 * behind it" and "without the revenue it was running beside". The negation there is part of
 * the CLAIM, not a promise that the reader need do nothing.
 *
 * Now each alternative names the reader explicitly. Every example the comment below lists
 * still matches; a bare negation no longer does.
 */

/**
 * SOMETHING ARRIVING IN THE READER'S DIARY IS A DELIVERY PROMISE.
 *
 * "A meeting lands in your diary", "booked calls land on your calendar", "it arrives in your
 * inbox". The capacity noun is the DESTINATION of something the sender provides, not a claim
 * about how the reader's hours are spent. Measured 2026-09-25: three of the capacity gate's
 * four false positives on the 44 audited pairs were exactly this shape.
 *
 * "Your calendar is already full" is the opposite and still blocks: there the noun is the
 * SUBJECT and the sentence asserts its state.
 */
const DELIVERED_INTO =
  /\b(land|lands|landed|arriv\w+|appear\w*|show\w*\s+up|go|goes|went|drop\w*|book\w*)\b[^.!?]{0,30}\b(in|on|into|onto|straight\s+into)\s+your\s+(calendar|diary|inbox|schedule|week)\b/i

/**
 * True when the capacity claim in this sentence is the SENDER describing its own work.
 *
 * ─── JUDGED ON THE WHOLE SENTENCE. Changed 2026-09-25. ──────────────────────
 *
 * This read only the text BEFORE the match, on the reasoning that a clause's subject sits
 * ahead of it. That is true of the subject and false of everything else, and it cost four of
 * the seven capacity rejections in the audited run. The clearest case:
 *
 *   "Booked calls land on your calendar without you touching the prospecting side."
 *
 * The match is `your calendar`. The `without you touching` that exempts it sits AFTER, so the
 * exemption never saw it and a sender promise was rejected as a claim about the reader's
 * hours. A negation anywhere in the sentence is about that sentence.
 *
 * THE RISK THIS ACCEPTS, stated rather than discovered later: a mixed sentence that both
 * asserts the reader's capacity and mentions the sender ("Your week is full, so we run the
 * outreach") is now exempt. That is the looser direction, and it is the right way to be
 * wrong here: a false positive throws away a researched email, and the three real
 * reader-capacity claims in the audit carry no first person at all, so none of them moves.
 */
export function isSenderSide(sentence: string, matched: string): boolean {
  if (FIRST_PERSON.test(sentence)) return true
  if (READER_NOT_DOING_IT.test(sentence)) return true
  if (DELIVERED_INTO.test(sentence)) return true
  return false
}

/**
 * True when the hit names the reader or their firm outright, so there is no reading of it
 * as a statement about a population.
 *
 * THE BLOCKING SUBSET. Everything else is counted and reported. Measured 2026-09-24: wiring
 * the whole detector to block on follow-ups hit four live sentences, at least two of which
 * were sender-side offer statements, and one rejection discards BOTH follow-ups.
 */
export function isUnambiguousReaderClaim(
  hit: AssumedCapacityHit,
  /**
   * Names that mean THIS READER: their company as stored, and any short form of it. Passed
   * in rather than guessed, because a capitalised name in a sentence is as likely to be the
   * SENDER's company, and blocking on that would reject the offer statements this module's
   * header has always permitted.
   */
  readerNames: readonly string[] = [],
): boolean {
  // A BARE `.filter(isUnambiguousReaderClaim)` WOULD PASS THE INDEX HERE, and an index of 0
  // reads as "no reader names", which silently UNDER-blocks. Caught while measuring this on
  // 2026-09-24. Refusing loudly is better than a gate that quietly stops naming the reader.
  if (!Array.isArray(readerNames)) {
    throw new TypeError('isUnambiguousReaderClaim: readerNames must be an array of names')
  }
  if (isSenderSide(hit.sentence, hit.matched)) return false
  if (SECOND_PERSON_READER.test(hit.sentence)) return true
  return readerNames.some(n => n.trim().length > 1 && hit.sentence.includes(n))
}

export function findAssumedCapacityClaims(text: string): AssumedCapacityHit[] {
  if (!text || !text.trim()) return []
  const hits: AssumedCapacityHit[] = []
  for (const sentence of sentencesOf(text)) {
    for (const [kind, patterns] of [['their_time', THEIR_TIME], ['who_sells', WHO_SELLS], ['they_lack', THEY_LACK], ['their_money', THEIR_MONEY]] as const) {
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
  // THE SENTENCE, NOT ONLY THE MATCH. A two-word match tells the rewrite which words tripped
  // the rule and not which sentence to change, and it left a live rejection unreadable after
  // the fact: the discarded prose is not persisted, so "your calendar" was the whole record
  // of what had been written. Measured 2026-09-24.
  const quoted = [...new Set(hits.map(h => `"${h.matched}"`))].slice(0, 4).join(', ')
  const sentence = hits[0]?.sentence?.trim()
  return `This assumes something about the reader that nobody has established: ${quoted}` +
    (sentence ? `, in ${JSON.stringify(sentence)}` : '') + '. ' +
    `You do not know how their week goes, how busy they are, or who in their company does ` +
    `the selling. State what the event itself means for any company it describes, and say ` +
    `nothing about the reader's time or their staffing.`
}
