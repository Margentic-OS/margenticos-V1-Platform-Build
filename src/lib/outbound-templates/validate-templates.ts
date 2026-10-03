// The hard gate on brief-generated templates. Deterministic, no model call.
//
// Plan: Notion "Firm-fact tier: plan (decided 30 September)", Rounds 3 to 7.
//
// WHAT IT VALIDATES IS WHAT SHIPS. Every check runs on bodies built by the renderers in
// template-shape.ts, the same functions composition uses. It renders each variant:
//
//   - slot-free, as every template-tier prospect receives it, and
//   - as the firm-fact Email 1, once per cell of an INVENTED fill matrix, for every opener
//     frame, at the shortest and longest peer group label in the client's brief.
//
// THE FILLS ARE INVENTED AND FROM UNRELATED INDUSTRIES, per Rule Zero. They are here to
// find wording that breaks under a long fill or a consumer-facing prospect, not to
// describe any client's market. Passing proves wording, never sense: a cell nobody would
// send still passes, and fit belongs to sourcing.
//
// THE CHECKS, by source:
//   reader rules (Round 3)   15-word sentences in EVERY email, grade 5 with slots masked,
//                            no paragraph opening with "I"
//   Round 5 / 6              pain line opens on {peer_group}, carries no number, duration
//                            or absolute; opener frames carry no hedge
//   Round 7                  every `from` id exists; Email 1's angle is most_buyers; proof
//                            never fills the pain; the offer cites scope.does; never_claims
//                            and must_not_exclude phrases; break-up blocklist; one sentence
//                            opener; at most 2 sentences and 30 words per paragraph
//   existing Email 1 gates   dashes, ampersands, AI tells, jargon, firmographic figures,
//                            back-references, bare pronouns in the offer, assumed capacity,
//                            one question, subject cap
//   word bands               EMAIL_WORD_LIMITS for slot-free emails, FACT_EMAIL1_WORD_LIMITS
//                            for the firm-fact Email 1, Email 3 no longer than Email 2
//   fifth reading            no word in two sentences in a row, no phrase more than twice
//                            across a sequence: read on the slot-free emails AND on the
//                            firm-fact Email 1, with each frame above it and each line in
//                            the wording it has when its slot is filled
//
// WHO CAN FIX A FAULT IS PART OF THE REPORT. A finding under a variant is the writer's. One
// whose place opens "opener_frames" is the frames'. One whose place opens "brief." is the
// BRIEF's: no rewrite of the copy can clear it, and the generator stops on it before it
// pays for anything. Every check of that last kind reads the brief alone, so it is seen
// with no variant written.
//
// NOT HERE, AND LISTED AS DEFERRED: the common-words list (it must be a NEW list; the
// ordinary-words module exists to spot names and is the wrong instrument), cross-variant
// sentence reuse, third-party contrast, and the reviewer's report-only categories. The
// scope judge is a model call and lives in the generator.

import {
  EMAIL_WORD_LIMITS,
  EMAIL_SUBJECT_LIMITS,
  FACT_EMAIL1_WORD_LIMITS,
  BANNED_JARGON,
} from '@/agents/messaging-generation-agent'
import { countWords } from '@/lib/composition/personalization'
import { findAITells } from '@/lib/style/customer-facing-style-rules'
import { findFirmographicFigures } from '@/lib/style/firmographic'
import { findBackReferences } from '@/lib/style/back-reference'
import {
  findAssumedCapacityClaims,
  isUnambiguousReaderClaim,
  EMAIL1_RAW_BLOCKING_KINDS,
} from '@/lib/style/assumed-capacity'
import { fleschKincaidGrade } from '@/lib/style/reading-grade'
import { splitSentences } from '@/lib/style/readability'
import { SentenceRegistry } from '@/lib/style/sentence-frames'
import { findAmbiguousReferents } from '@/lib/style/ambiguous-referent'
import { findStiffForms } from '@/lib/style/stiff-forms'
import { findConsecutiveRepeats, findRepeatedPhrases, wordsInCommon } from '@/lib/style/repetition'
import {
  briefItemIndex,
  conflictedAngleIds,
  forbiddenPhrases,
  isLeadDifferentiator,
  mostBuyersAngles,
  neutralOutcomeIds,
  proofIds,
  type OutboundBrief,
} from '@/lib/outbound-brief/brief'
import { unreachablePeerKinds } from '@/lib/sourcing/peer-kind'
import { CANONICAL_INDUSTRIES } from '@/lib/agents/icp-filter-spec'
import {
  SLOTS,
  FOLLOWUP_SLOTS,
  slotsIn,
  renderEmail1SlotFree,
  renderFactEmail1,
  renderFollowup,
  renderFollowupSlotFree,
  renderSlotFree,
  fillSlots,
  wordingsOf,
  type ParagraphKind,
  type SenderSignoff,
  type SlotFills,
  type TemplateLine,
  type TemplateWording,
  type VariantLines,
  type WordingChoice,
} from './template-shape'

// ─── Limits ───────────────────────────────────────────────────────────────────

/** Reader rules: every sentence, in every email, 15 words or fewer. One exception, below. */
export const TEMPLATE_MAX_SENTENCE_WORDS = 15
/**
 * THE OFFER IS ONE FLOWING SENTENCE: what the sender does, then what the reader gets
 * (operator note 5 on the fourth reading, 2026-10-02). Two short sentences read as two
 * claims; one sentence with "so" between them reads as cause and effect. That sentence
 * needs room the 15-word cap does not give it: his own example is 16 words before a slot
 * is filled, and a five-word customer group takes it to 22.
 */
export const OFFER_MAX_SENTENCE_WORDS = 22
/** Reader rules: Flesch-Kincaid grade 5 or below, with slot fills masked. */
export const TEMPLATE_MAX_READING_GRADE = 5
/**
 * The firm-fact Email 1 WITH THE PROSPECT'S REAL WORDS IN IT (operator note 9 of the second
 * reading: tier 2 a touch lower in reading level). The masked grade above measures the
 * client's lines and cannot see the clause taken from the prospect's site, which is where
 * the long words are. Measured 2026-10-01 on four real tier 2 emails: 4.3 to 5.6, against
 * 2.9 to 3.9 for the templates. An email over this falls to the broad line, then the template.
 */
export const FACT_EMAIL1_MAX_FILLED_GRADE = 5
/**
 * THE OPENER SENTENCE, GRADED ALONE, NAMES MASKED (operator note 6 on the fourth reading:
 * "a higher reading-grade cap for the opener clause only"). The prospect's own clause is
 * where the long words are, and they are the prospect's words about their own work: a
 * reader knows their own trade's vocabulary. Graded inside the whole email it sent four
 * faithful facts of 77 back to the template; graded alone it needs a different number,
 * because one sentence scores far higher than an email of short ones.
 *
 * MEASURED 2026-10-02 on every passing clause on file (34): 0.8 to 14.1, and the top of
 * that range reads plainly ("you build fundraising capacity for nonprofit
 * organizations"). 16 admits all of them and still refuses a clause that is a string of
 * long abstract nouns (one invented in the tests scores 27). It is a guard against word
 * salad, not a claim that the opener reads at grade 16 in the ordinary sense.
 */
export const OPENER_CLAUSE_MAX_GRADE = 16
/** Round 7: one idea per short paragraph. */
export const TEMPLATE_MAX_PARAGRAPH_SENTENCES = 2
/**
 * 30, from 25, on 2026-10-02: a pain line is the symptom and then its consequence opened by
 * a linking phrase (note 4 on the fourth reading), and the two together at their caps, with
 * a four-word peer label, run to 30.
 */
export const TEMPLATE_MAX_PARAGRAPH_WORDS = 30
/** Opener frames per client (Round 5, P3). */
export const MIN_OPENER_FRAMES = 2
export const MAX_OPENER_FRAMES = 3
/** offer_angle length (copy-writing a9044e5 asks for ten words or fewer). */
export const OFFER_ANGLE_MAX_WORDS = 10

// ─── The invented fill matrix ─────────────────────────────────────────────────
//
// Invented, from industries unrelated to any client. The long cell is the longest {does}
// the extraction check admits (12 words) and a five-word {for_whom}, which is where
// sentence caps and the 85-word ceiling break. The consumer cell is there because a
// consumer-facing prospect is where a {for_whom} line reads oddest (Round 4, finding 4).

export interface FillCell {
  name: string
  fills: SlotFills
  /**
   * Graded WITH THE FILL IN, as composition grades every real firm-fact Email 1. Set on the
   * plain cells only. Composition refuses an email over FACT_EMAIL1_MAX_FILLED_GRADE, and
   * until 2026-10-01 generation graded these cells masked: a document could pass generation
   * clean and have composition refuse most of its tier 2 sends, with nothing saying so
   * (measured on the invented client: 79 of 100 fell with its longest peer label). These
   * two are the floor: a short specific clause and the broad line, the easiest words a real
   * prospect can bring. If the client's own lines leave no room for THESE, they leave no
   * room for anybody. The long cell stays masked: it is there to stress length, and a
   * prospect that long is expected to fall to the broad line.
   */
  gradeFilled?: true
}

export const INVENTED_FILL_CELLS: readonly FillCell[] = [
  { name: 'short',    fills: { does: 'you run dental clinics', for_whom: 'bakeries' }, gradeFilled: true },
  { name: 'long',     fills: { does: 'you design and fit cold rooms for regional food wholesalers and bakeries', for_whom: 'regional food wholesalers and bakeries' } },
  { name: 'consumer', fills: { does: 'you teach swimming to young children', for_whom: 'families' } },
  { name: 'no_for_whom', fills: { does: 'you make recyclable trays and films for food brands' } },
  // The broad line of the fallback ladder: what kind of firm it is, and nothing more.
  { name: 'broad', fills: { does: 'you run a dental practice' }, gradeFilled: true },
]

/** Fills used ONLY for the reading grade: each slot becomes one short common word. */
// NOUNS, NOT PRONOUNS, for the two slots that can open a sentence. Until 2026-10-02 both
// were masked "they", and the stiff-wording check, which reads the masked body, refused
// "{peer_group} are often told ..." for the words "They are": words the writer never wrote,
// with an instruction ("write they're") it could not follow. One syllable each, so the
// reading grade is what it was.
export const GRADE_MASK: Required<SlotFills> = { does: 'you do this', for_whom: 'them', peer_group: 'folks', company: 'Kemp' }

/**
 * What stands for {for_whom} when PHRASES are counted on the sequence a firm-fact prospect
 * gets. ONE made-up word, for two reasons. It is not a small word, so the authored words
 * beside the slot count with it: "{for_whom} abroad" in the subject, the offer and a
 * follow-up is one phrase said three times, whoever the customers are. And it is one word,
 * so the group ITSELF is never a phrase: a reader's customers named in three lines is what
 * the slot is for, not a repeat. Made up, so it cannot collide with a word the writer used.
 */
const FOR_WHOM_PHRASE_MASK = 'forwhomgroup'

/**
 * Invented fills for the FOLLOW-UP slots, from no client's market. The long company is the
 * longest name companyShortName returns (four words); the long customer group is the
 * longest the extraction admits. A follow-up that holds a word band and a sentence cap
 * with these holds them for every real prospect.
 */
export const INVENTED_FOLLOWUP_CELLS: ReadonlyArray<{ name: string; fills: SlotFills }> = [
  { name: 'short fills', fills: { company: 'Acme', for_whom: 'bakeries' } },
  { name: 'long fills', fills: { company: 'Northtown Cold Room Engineering', for_whom: 'regional food wholesalers and bakeries' } },
]

// ─── Word lists ───────────────────────────────────────────────────────────────

const NUMBER_WORDS =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|billion|dozen|half)\b/i
const TIME_UNITS =
  /\b(days?|weeks?|months?|quarters?|years?|hours?|seasons?|annual(ly)?|monthly|weekly|daily)\b/i
const ABSOLUTES = /\b(always|never|every|all|nobody|no one|none|everyone|everything)\b/i
const OPENER_HEDGES = /\b(looks? like|seems?|appears?|apparently|presumably|i guess|i think|maybe|perhaps)\b/i
// "Saw that {does}." is "I saw" with the I dropped, and shipped from the first real run
// because this list held only "i saw". The rule is about the move, not the pronoun.
const NOTICED_OR_SAW = /\b(noticed|saw|i see|we see that|came across|stumbled)\b/i
const DROPPED_SUBJECT = /^\s*(saw|read|noticed|spotted|found|came|looked|checked|visited|seen|loved|enjoyed)\b/i
/**
 * A FRAME STATES WHAT WAS SEEN. IT NEVER JUDGES IT (operator note 1 on the fourth reading).
 * "Good to see you run an HR consultancy" approves of the reader's firm from a stranger,
 * and it shipped in six of twelve sequences he read. A word that says the writer is
 * pleased, impressed or interested is a judgement of the reader.
 *
 * A LIST, so it catches what it names. Plain English, no market's wording.
 */
const FRAME_APPROVAL =
  /\b(good|great|glad|nice|lovely|love|loved|like|liked|impressed|impressive|pleased|happy|delighted|excited|exciting|admire|admired|congrats|congratulations|kudos|brilliant|amazing|fantastic|wonderful|cool|awesome|interesting|interested|fascinating|enjoy|enjoyed|appreciate|appreciated|respect|proud|remarkable|strong|smart|clever|neat|well done|stood out|stands out|caught my eye)\b/i

/** A frame that says where the clause was read. The peer rung, built from the stored record, never uses one. */
export const FRAME_NAMES_THE_SITE = /\b(?:site|website|page|homepage)\b/i

/**
 * THE ONLY WORDS A FRAME MAY ADD (2026-10-02). A frame adds at most three words to the
 * prospect's clause, so the whole of what it can soundly say fits in a short closed list:
 * that the writer can see it, or that the reader's site says it.
 *
 * WHY A LIST OF WHAT IS ALLOWED. FRAME_APPROVAL above names praise words, and praise in any
 * word it does not name passed every check: "Fan of how", "Thrilled that", "Rare to see",
 * "Hats off:" (review, 2026-10-02). Frames are not read by the scope judge. And the first
 * live run under the no-praise rule wrote "Know {does}.", which is not praise and reads as
 * an order. A list of what to refuse is as long as what nobody thought of.
 *
 * Plain English about a website, the same in every market. The generator's prompt states
 * this list word for word (OPENER FRAMES); change both together.
 */
export const FRAME_WORDS: ReadonlySet<string> = new Set([
  'can', 'see', 'tell', 'your', 'site', 'website', 'page', 'homepage', 'says', 'shows', 'from', 'on', 'that', 'the',
])

/**
 * What a CONSEQUENCE opens on, so it reads on from the line before it (operator note 4 on
 * the fourth reading). "Too few of the right buyers hear from them. The firm can grow more
 * slowly." is two statements side by side; "As a result, ..." is one thought. A bare
 * "That" or "It" does not count: it points back without saying how the two are joined.
 *
 * Exported for the scope judge's floor (outbound-template-agent.ts, "unnatural"): a line
 * that is this linker plus a brief sentence is the brief's own sentence in the shape the
 * prompt requires, and one list says what a linker is.
 */
export const CONSEQUENCE_LINKERS =
  /^(?:as a result|so|and so|that means|this means|which means|that way|this way|when|if|once|then|over time|in turn|because of that|because|from there|before long|soon|after that|the result|without)\b/i

const MEETING_REQUEST = /\b(call|meeting|chat|demo|minutes|calendar|book a|hop on|jump on|time to talk)\b/i
const BREAKUP_BLOCK = /\b(i wrote|we wrote|the reason i|why i|should)\b/i
// "Never describe how busy anyone is, not even for peers" has been in the generator's prompt
// since Round 7 and nothing held it: the assumed-capacity check reads claims about THE
// READER, and "client work gets busy" is about nobody in particular. The first run under
// the eleven rules wrote it four times.
const BUSY_WORDING = /\b(busy|busier|busiest|swamped|overloaded|snowed under|flat out|stretched thin)\b/i
const DASHES = /[—–]|--/

// ─── Operator rules of 2026-10-01 ─────────────────────────────────────────────

/**
 * RULE 1. A consequence in a pain line is a POSSIBILITY, never asserted as the reader's
 * reality. "Orders arrive late" tells the reader what their business is like. "Orders can
 * arrive late" does not.
 *
 * A sentence in a pain line passes when it is one of:
 *   - a question;
 *   - a possibility: it carries can, could, may, might, often, sometimes, usually, tend to;
 *   - a REPORT ABOUT OTHER PEOPLE: it carries a reporting verb ("tell us", "say", "we
 *     hear"), or it opens on a quantifier that plainly means others ("Some firms...",
 *     "A few..."), AND what it reports holds no "you" or "your".
 * Anything else is a flat assertion. The possibility word must be in WHAT IS SAID, not on
 * the reporting verb: "they often tell us your pages are slow" is still about the reader.
 * "Many", "most" and the peer-group slot do not make a report on their own: they
 * generalise to the reader.
 *
 * WHY THE REPORT NEEDS BOTH HALVES. The first version passed any sentence opening on a
 * quantifier, so "Many of your sales stall" and "A few bad pages cost you the sale" went
 * through as reports about other people, which they are not. And it knew a report only by
 * how the sentence opened, so "Exporters tell us a new market takes longer" was rejected in
 * a follow-up, where there is no slot to open on, although the generator's prompt allows
 * exactly that sentence. Found by review on 2026-10-01; each case is now a test.
 *
 * Deterministic, and deliberately about FORM: whether a consequence is too narrow or a pain
 * is a self-diagnosis is a judgement, made by the scope judge in the generator.
 */
// "can", and not "can't": the apostrophe is a word boundary, so a bare \bcan\b read "your
// sales can't recover" as a possibility.
const POSSIBILITY = /\b(can(?!['’]t)|could|might|often|sometimes|usually|tend to|tends to|at times)\b/i
/** "may", and not the month: lower-case anywhere, capitalised only as the first word. */
const MAY = /\bmay\b|^May\b/
// {company} IS the reader: "Exporters tell us {company} loses buyers abroad" is a flat
// statement about them, with their name where "you" would be.
const READER = /\b(you|your|yours|yourself|yourselves)\b|\{company\}/i
// Only quantifiers that plainly mean OTHER people. "Many" and "most", and the peer-group
// slot itself, generalise to the reader, so a sentence opening on one of those needs a
// reporting verb or a possibility like any other.
const OTHERS_OPENER = /^(?:some|several|a few)\b/i
// The reporting clause, and what it reports. Verbs only: "report" also reads as a noun.
const REPORT = /^(.*?\b(?:(?:tell|tells|told) us|say|says|said|mention|mentions|describe|describes|we (?:often |sometimes )?hear))\b(?:\s+that\b)?(.*)$/i
export function findAssertedConsequences(painText: string): string[] {
  const possible = (text: string) => POSSIBILITY.test(text) || MAY.test(text)
  return splitSentences(painText.replace(/\n+/g, ' '))
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0)
    .filter(sentence => !sentence.endsWith('?'))
    .filter(sentence => {
      const report = sentence.match(REPORT)
      // WHAT IS REPORTED is what is judged, not the reporting clause. "Often" on "tell us"
      // says how often people speak; it does not turn "your pages are hard to read" into a
      // possibility. The first version let any possibility word anywhere exempt the whole
      // sentence, before the reader check ran.
      const content = report ? report[2] : sentence
      if (possible(content)) return false
      if (READER.test(content)) return true          // a flat statement about the reader
      if (report) return false                       // a report about other people
      if (OTHERS_OPENER.test(sentence)) return false // "Some firms ...": plainly not the reader
      return true
    })
}

/**
 * The form rules every PAIN carries, in Email 1 and in a follow-up alike: no number, no
 * duration, no absolute, and every consequence a possibility. One function, because the
 * generator's prompt states these for "Email 1 and every follow-up" and the first version
 * applied three of the four to Email 1 only.
 */
export function findPainFormFaults(text: string): Array<{ rule: string; detail: string }> {
  const faults: Array<{ rule: string; detail: string }> = []
  const words = text.replace(/\{[a-z_]+\}/g, '')
  if (/\d/.test(words) || NUMBER_WORDS.test(words)) faults.push({ rule: 'pain_number', detail: 'a pain carries no numbers' })
  if (TIME_UNITS.test(words)) faults.push({ rule: 'pain_duration', detail: `a pain carries no durations: "${words.match(TIME_UNITS)![0]}"` })
  if (ABSOLUTES.test(words)) faults.push({ rule: 'pain_absolute', detail: `absolute: "${words.match(ABSOLUTES)![0]}"` })
  for (const sentence of findAssertedConsequences(text)) {
    faults.push({ rule: 'consequence_asserted', detail: `stated as the reader's reality, say it as a possibility (can, often): "${sentence}"` })
  }
  return faults
}

/**
 * CONSEQUENCES READ ON FROM THE LINE BEFORE (operator note 4 on the fourth reading).
 *
 * Given the pain paragraphs of ONE email, in order: every sentence after the first opens
 * on a linking phrase. The first sentence states the symptom; what follows it is what the
 * symptom leads to, and the reader is told so by the word it opens on. Returns the
 * sentences that do not.
 *
 * FORM ONLY. Whether the consequence leans on what the client's buyers care about is the
 * brief's content, and whether it is too narrow is the scope judge's question.
 */
export function findUnlinkedConsequences(painParagraphs: readonly string[]): string[] {
  const sentences = painParagraphs
    .flatMap(text => splitSentences(text.replace(/\n+/g, ' ')))
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0 && !sentence.endsWith('?'))
  return sentences.slice(1).filter(sentence => !CONSEQUENCE_LINKERS.test(sentence))
}

/**
 * Words that carry no subject of their own. A consequence is not "about" one of these, so
 * sharing one with the brief proves nothing: "it can be hard to plan" shares "hard" with
 * every consequence that says something gets harder.
 */
const WEAK_CONSEQUENCE_WORDS = new Set([
  'that', 'this', 'than', 'then', 'when', 'with', 'from', 'into', 'over', 'more', 'most', 'less', 'much', 'very',
  'should', 'would', 'could', 'will', 'have', 'been', 'being', 'gets', 'make', 'makes', 'made', 'take', 'takes',
  'hard', 'harder', 'tough', 'firm', 'firms', 'time', 'times', 'down', 'come', 'comes', 'they', 'them', 'their',
  'your', 'what', 'which', 'while', 'because', 'become', 'becomes', 'often', 'sometimes', 'might', 'there', 'about',
  'some', 'many', 'also', 'even', 'ever', 'still', 'just', 'keep', 'keeps', 'does', 'turn', 'turns', 'goes',
])

function consequenceKeys(text: string): string[] {
  return text.toLowerCase().replace(/\{[a-z_]+\}/g, ' ').split(/[^a-z]+/).filter(word => word.length >= 4 && !WEAK_CONSEQUENCE_WORDS.has(word))
}

/** Two forms of one word, loosely: "grow" and "growth", "scale" and "scaling", "slowly" and "slower". */
function sameStem(a: string, b: string): boolean {
  if (a === b) return true
  let shared = 0
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++
  return shared >= 4 && shared >= Math.min(a.length, b.length) - 2
}

const touches = (sentence: string, keys: readonly string[]) => consequenceKeys(sentence).some(word => keys.some(key => sameStem(word, key)))

/** The sentences of a pain after its first: the consequences. */
function consequenceSentences(painParagraphs: readonly string[]): string[] {
  return painParagraphs
    .flatMap(text => splitSentences(text.replace(/\n+/g, ' ')))
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0 && !sentence.endsWith('?'))
    .slice(1)
}

/**
 * THE CONSEQUENCE IS THE BRIEF'S (operator note 4 on the fourth reading: "lean on growth and
 * scaling"). What a pain leads to is the client's own judgement about what its buyers care
 * about, and it is written in the brief: each pain angle carries a `consequence`.
 *
 * Until 2026-10-02 nothing tied the sentence in the email to it. The generator was told to
 * "keep the consequence at the level of the angle's outcome", and wrote "So it can be hard
 * to plan." under a brief whose consequence for that angle is about growth and scaling. A
 * sentence true of anything, and every check passed.
 *
 * TWO RULES, both read from the brief, so no market's words are here:
 *
 *   1. Every consequence sentence holds a word of its angle's outcome, symptom or
 *      consequence. A floor: it catches a consequence about nothing.
 *   2. An Email 1 pain's wordings, BETWEEN THEM, touch every part of the brief's
 *      consequence. "Growth can stall, and it gets harder to scale" has two parts; two
 *      wordings that both say only "growth can stall" leave the second unsaid, and that is
 *      how "scaling" was in the brief and in none of sixteen emails.
 *
 * KNOWN LIMIT. Words are matched by their first letters, so "growth" touches "grow" and
 * "scaling" touches "scale", and so would any word that merely starts the same.
 */
export function findConsequencesOffTheBrief(
  painParagraphs: readonly string[],
  angle: { outcome?: string | null; symptom?: string | null; consequence?: string | null },
): string[] {
  const keys = consequenceKeys([angle.outcome, angle.symptom, angle.consequence].filter(Boolean).join(' '))
  if (keys.length === 0) return []
  return consequenceSentences(painParagraphs).filter(sentence => !touches(sentence, keys))
}

/** The parts of the brief's consequence that none of a pain's wordings touches, as written in the brief. */
export function unsaidConsequenceParts(wordings: readonly string[], consequence: string | null | undefined): string[] {
  if (!consequence) return []
  const said = wordings.flatMap(text => consequenceSentences([text]))
  return consequence
    .split(/[,;]/)
    .map(part => part.trim().replace(/[.?!]+$/, ''))
    .filter(part => consequenceKeys(part).length > 0)
    .filter(part => !said.some(sentence => touches(sentence, consequenceKeys(part))))
}

/** What joins the sender's work to the reader's outcome inside one offer sentence, and what follows it. */
const OFFER_JOIN = /(?:,\s*(?:so|and)\b|\bso that\b|,?\s*which means\b)(?![^.?!]*(?:,\s*(?:so|and)\b|\bso that\b|\bwhich means\b))([^.?!]*)$/i

/**
 * THE OFFER'S SHAPE (operator note 5 on the fourth reading): ONE flowing sentence, what the
 * sender does and then what the reader gets. Three things code can hold: it is one
 * sentence; it opens on the sender ("We ..."); and after a joining word it turns to the
 * reader. Whether what the reader gets is the outcome the brief names, and whether it
 * answers the pain above it, are the scope judge's.
 *
 * This REPLACES the shape built for note 1 of the second reading (the outcome in its own
 * sentence, first). The principle of that note stands: an offer sells an outcome, and a
 * feature is only ever support. What changed is the order and the join.
 */
export function offerShapeFaults(text: string): string[] {
  const line = text.trim()
  const faults: string[] = []
  if (splitSentences(line).length !== 1) faults.push('the offer is ONE sentence: what we do, then what the reader gets')
  if (!/^We\b/.test(line)) faults.push('the offer opens on what the sender does: "We ..."')
  // After the LAST joining word comes a clause that is no longer about the sender. It need
  // not say "you": an outcome can be about the reader's buyers or the reader's growth. What
  // it may not be is a second thing the sender does ("We do A, and we do B").
  const after = line.replace(/[.?!]+$/, '').match(OFFER_JOIN)?.[1]?.trim() ?? null
  if (after === null || countWords(after) < 3 || /^(?:we|our)\b/i.test(after)) {
    faults.push('after what we do, the same sentence turns to what the reader gets, joined by "so" or "and": ", so you ..."')
  }
  return faults
}

/** Capitalised words after the first, read as one short common word: a name is not hard to read. */
function maskNamesForGrade(sentence: string): string {
  return sentence.split(/\s+/).map((word, i) => (i > 0 && /^[^a-z]*\p{Lu}/u.test(word) ? 'this' : word)).join(' ')
}

/** The opener sentence's reading grade, graded alone with names masked, or null if it cannot be graded. */
export function openerClauseGrade(opener: string): number | null {
  return fleschKincaidGrade(maskNamesForGrade(opener.replace(/\n+/g, ' ')))?.grade ?? null
}

// RULE 2 HAS NO WORD LIST HERE, ON PURPOSE. A differentiator is worded as an outcome or as
// expertise, never as a manual task. The first version held a universal pattern (write down,
// paperwork, fill in forms) and ran it on every paragraph of every client. That fails Rule
// Zero: for a customs broker the paperwork IS the offer, and for a transcription service so
// is typing things up. What counts as task wording depends on what the client sells, so the
// deterministic half lives in the client's brief, under avoid_wording, and the judgement
// ("is this claim a manual task, given this sender's scope?") is the scope judge's.

/** The most words the offer's lead-in may hold, {company} counted as one. */
export const OFFER_LEAD_IN_MAX_WORDS = 8

/**
 * THE LEAD-IN'S SHAPE: a conditional clause, opening "If", naming the reader's firm by
 * {company}, ending on a comma so the offer runs on from it; and a slot-free form for a
 * prospect with no usable name that opens "If you" (2026-10-03). It asks; it never says
 * what the firm has or does.
 */
export function leadInFaults(line: TemplateWording): string[] {
  const faults: string[] = []
  const text = (line.text ?? '').trim()
  if (!/^If\b/.test(text)) faults.push(`the lead-in opens "If": "${text}"`)
  if (!slotsIn(text).includes('company')) faults.push(`the lead-in names the reader's firm with {company}: "${text}"`)
  if (!text.endsWith(',')) faults.push(`the lead-in ends on a comma, so the offer runs on from it: "${text}"`)
  if (/[.?!]/.test(text)) faults.push(`the lead-in is a clause, not a sentence: "${text}"`)
  if (countWords(text) > OFFER_LEAD_IN_MAX_WORDS) faults.push(`the lead-in is ${countWords(text)} words, over ${OFFER_LEAD_IN_MAX_WORDS}: "${text}"`)
  const free = (line.slot_free ?? '').trim()
  if (!/^If you\b/.test(free)) faults.push(`the slot_free lead-in opens "If you": "${free}"`)
  if (!free.endsWith(',')) faults.push(`the slot_free lead-in ends on a comma: "${free}"`)
  if (/[{}]/.test(free)) faults.push(`the slot_free lead-in holds no slot: "${free}"`)
  return faults
}

/**
 * A FACELESS SOURCE (operator, 2026-10-03): a pattern attributed to nobody in particular,
 * "Many firms say", "Some firms spend", "Firms like yours". The copy names its source,
 * with {peer_group}, conversationally. Refused in every authored line, for every client.
 */
const FACELESS_SOURCE = /\b(?:many|some|most|a lot of|lots of|plenty of|several|a few|other|all)\s+(?:firms|companies|businesses|founders|owners|teams|leaders|organisations|organizations|agencies|practices)\b|\b(?:firms|companies|businesses|teams|people|founders) like (?:yours|you)\b/i
/** The clause that names who told us, when a sentence opens on one: "When we chat to {peer_group}," */
export const SOURCE_CLAUSE = /^(?:(?:when|whenever|each time|every time)\s+we\s+(?:chat|talk|speak|meet)\s+(?:to|with)|(?:talking|speaking|chatting)\s+(?:to|with))\s+[^,.?!]{1,60},\s*/i
export function findFacelessSource(text: string): string | null {
  const m = text.match(FACELESS_SOURCE)
  return m ? m[0].trim() : null
}

/** RULE 8. The lines of Email 1 that must hold two wordings. The subject may hold one. */
const TWO_WORDING_LINES = ['pain', 'offer', 'question'] as const

/**
 * AN ASK IS A FULL SENTENCE (operator note 10 of the second reading). "Worth a short
 * call?" and "Open to a quick call?" are fragments: no verb, no subject. A reader whose
 * first language is not English has to supply both. A question that is a sentence opens on
 * the verb or the question word that makes it one. Deterministic and deliberately about
 * FORM; fragments that are not questions are the scope judge's (`fragment`).
 */
// An auxiliary may carry its negative ("Isn't", "Doesn't", "Won't"): those are full
// sentences opening on their verb, and the first pattern refused them because the word
// boundary it asked for does not exist between "is" and "n't".
const QUESTION_OPENERS = /^(?:(?:is|are|was|were|am|do|does|did|would|could|can|should|shall|will|have|has|had|may|might)(?:n['’]t)?|won['’]t|shan['’]t|what|how|which|when|where|who|whose|why)\b/i
// A question word followed by no verb at all. "How about a short call?" opens on a question
// word and is exactly the fragment the rule exists to refuse. The generator is told the
// same three openers are out, verb or no verb, so the two agree.
const VERBLESS_OPENERS = /^(?:how about|what about|why not)\b/i
/** A lead-in is short: "At your firm," or "Right now, at your firm,". Longer, and it is a clause of its own. */
const LEAD_IN_MAX_WORDS = 6
// What a lead-in opens on: a word that places the question, never one that could itself be
// the fragment ("Worth a short call, do you think?" opens on "Worth").
const LEAD_IN_OPENERS = /^(?:at|in|on|for|with|if|when|as|right|today|so|and|but|now)\b/i
export function findAskFragments(text: string): string[] {
  return splitSentences(text.replace(/\n+/g, ' '))
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.endsWith('?'))
    .filter(sentence => {
      if (VERBLESS_OPENERS.test(sentence)) return true
      if (QUESTION_OPENERS.test(sentence)) return false
      // "At your firm, is that a problem?" is a full sentence with a short lead-in. The
      // lead-in must BE one (short, and opening on a placing word), and what follows the
      // LAST comma is held to the same test. The first version took anything before the
      // first comma, so a fragment with a tag on it passed.
      const cut = sentence.lastIndexOf(', ')
      if (cut < 0) return true
      const leadIn = sentence.slice(0, cut)
      const rest = sentence.slice(cut + 2)
      const isLeadIn = LEAD_IN_OPENERS.test(leadIn) && countWords(leadIn) <= LEAD_IN_MAX_WORDS
      return !(isLeadIn && !VERBLESS_OPENERS.test(rest) && QUESTION_OPENERS.test(rest))
    })
}

/**
 * "COULD" ASKS A PERSON (operator note 6 on the fifth reading). "Could a short call make
 * sense?" asks a call whether it is able to. Of a thing the question is "Would": "Would a
 * short call make sense?". "Could we talk?" and "Could you spare a minute?" are right and
 * pass. Held by the word after "Could": an article or a pointing word means a thing.
 *
 * KNOWN LIMIT. One word cannot tell a thing from a person, so "Could a colleague join us?"
 * is refused too, and the writer says it with "Would" or "Can". "Could one of your team
 * spare a minute?" passes: "one of" names a person among several.
 */
export function findCouldOfAThing(text: string): string[] {
  return splitSentences(text.replace(/\n+/g, ' '))
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.endsWith('?'))
    // WHEREVER THE QUESTION STARTS: at the start of the sentence, after a comma ("At your
    // firm, could a short call make sense?" is the same question with a place in front of
    // it), and after a joining word ("So could a short call help?"). Until 2026-10-02 only
    // what followed the LAST comma was read, so "Could a short call, say ten minutes, make
    // sense?" was judged on "make sense?" and passed, and so did any question opening "So".
    .filter(sentence => /(?:^|,\s+)(?:(?:so|and|but|then)\s+)?could\s+(?:a|an|the|this|that|these|those|it|another|more|some|any|one(?!\s+of\b))\b/i.test(sentence))
}

const PARAGRAPH_KINDS: readonly ParagraphKind[] = ['pain', 'offer', 'ask', 'close']

/**
 * What each follow-up is MADE OF. The kind decides which rules a paragraph is held to, so a
 * kind the model may choose freely is a switch the model holds: a pain paragraph relabelled
 * "close" was under none of the pain rules, and a repair call told "consequence_asserted"
 * could clear it by changing the label instead of the sentence. So the kinds are fixed per
 * email, as the generator's prompt has always stated them, and the validator now holds it.
 */
const FOLLOWUP_STRUCTURES: Record<2 | 3 | 4, readonly (readonly ParagraphKind[])[]> = {
  2: [['pain', 'pain'], ['pain', 'pain', 'ask']],
  3: [['pain', 'offer', 'ask']],
  4: [['close'], ['close', 'close']],
}

/**
 * Idioms and figures of speech, banned by the reader rules: a reader whose first language
 * is not English reads them literally. A LIST, so it catches only what it names, and it is
 * seeded from what real generator runs produced on 2026-09-30 plus the commonest others.
 * The semantic check ("does this line contain any idiom") is the reviewer's, deferred; this
 * list is the floor under it, not a replacement for it.
 */
/**
 * The idioms refused for ONE client: the list below, less the plain colloquialisms that
 * client's tone of voice uses (brief.colloquialisms, 2026-10-03). A client's own everyday
 * phrase is their voice; an obscure figure of speech is still refused for everyone.
 */
export function idiomsFor(brief: Pick<OutboundBrief, 'colloquialisms'> | null | undefined): readonly string[] {
  const allowed = new Set((brief?.colloquialisms ?? []).map(phrase => phrase.trim().toLowerCase()))
  return allowed.size === 0 ? IDIOMS : IDIOMS.filter(idiom => !allowed.has(idiom))
}

export const IDIOMS: readonly string[] = [
  'ring true', 'rings true', 'dries up', 'dried up', 'dry up', 'quiet patch', 'door is open', 'my door',
  'down the road', 'closing the loop', 'close the loop', 'in the loop', 'on your plate', 'in the room',
  'move the needle', 'low-hanging', 'low hanging', 'circle back', 'touch base', 'the ball rolling',
  'on the radar', 'on your radar', 'fall through the cracks', 'slipping through', 'leaky bucket',
  'roller coaster', 'rollercoaster', 'feast or famine', 'feast and famine', 'hit the ground', 'up to speed',
  'in the weeds', 'bandwidth', 'take the plunge', 'game changer', 'game-changer', 'the heavy lifting',
  'heavy lifting', 'at the end of the day', 'pinned down', 'pin down', 'under the hood', 'on the table',
  'fill the gap', 'plug the', 'keep the lights on', 'in waves', 'dry spell', 'drought', 'tap on the shoulder',
  // "New clients come and go" shipped in a generated pain line on 2026-10-01. It was meant
  // as "arrive unevenly" and reads as easily as "clients leave", which is a different
  // problem from the one the email is about.
  'come and go', 'comes and goes', 'came and went', 'coming and going',
]

/**
 * A three-part list in one sentence: "A, B and C". Banned in every customer-facing email
 * by the style rules, and the shape the Round 3 offer illustration fell into. A sentence
 * opening on a subordinator ("When X, we do Y and Z") is a clause, not a list, and is
 * skipped. Each list item must be short (6 words or fewer), which is what a list item is.
 */
const INTRODUCTORY = /^(when|if|so|because|while|once|after|before|as|since|although|though|unless|until|whether|then|but|and|from|on|at|in|with|for|by|to|over|across|like)\b/i
export function findThreePartList(sentence: string): string | null {
  const s = sentence.trim().replace(/[.?!]+$/, '')
  const parts = s.split(/,\s+/)
  if (parts.length < 2) return null
  // "When X, ..." and "From your site, ..." open on a clause or phrase, not a list item.
  if (INTRODUCTORY.test(parts[0])) return null
  let items: string[]
  // "..., so Y" is a RESULT, not a third item. An offer is "we do A and B, so <the reader
  // gets C>", and with a customer group that itself holds "and" ("wholesalers and
  // bakeries") the result clause split into two and read as items two and three. So is a
  // closing clause with its own subject: "..., and you keep winning the right clients".
  //
  // THE RESULT IS SET ASIDE AND WHAT IS LEFT IS STILL READ. Until 2026-10-02 a sentence
  // ending on a result returned null whole, so "We find buyers, write to them, and book
  // meetings, so you can grow" passed: three things the sender does, in the one sentence
  // most likely to hold them.
  const RESULT_CLAUSE = /^(?:(?:and|or)\s+)?(?:so|which|because|while|but)\b|^(?:and|or)\s+(?:you|your|they|their|\{company\}|\{for_whom\}|\{peer_group\})(?![a-z])/i
  let listParts = parts
  while (listParts.length > 1 && RESULT_CLAUSE.test(listParts[listParts.length - 1])) listParts = listParts.slice(0, -1)
  if (listParts.length < 2) return null
  const last = listParts[listParts.length - 1]
  if (/^(and|or)\s+/i.test(last)) {
    // Oxford comma: "A, B, and C".
    items = [...listParts.slice(0, -1), last.replace(/^(and|or)\s+/i, '')]
  } else {
    const andSplit = last.split(/\s+(?:and|or)\s+/i)
    if (andSplit.length < 2) return null
    items = [...listParts.slice(0, -1), ...andSplit]
  }
  if (items.length < 3) return null
  if (items.some(item => countWords(item) > 6 || countWords(item) === 0)) return null
  return sentence.trim()
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TemplateViolation {
  variant: string
  /** e.g. "email1.pain", "email3", "opener_frames[1]", "fact email1 [long / frame 0]". */
  where: string
  rule: string
  detail: string
}

export interface TemplateDocumentInput {
  brief: OutboundBrief
  opener_frames: readonly string[]
  variants: Readonly<Record<string, VariantLines>>
  signoff: SenderSignoff
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalise(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')
}

/** Body without the {{first_name}} greeting and the two sign-off lines. */
export function proseOf(body: string, signoff: SenderSignoff): string {
  return body
    .split('\n')
    .filter(line => {
      const t = line.trim()
      if (/^\{\{first_name\}\},?$/.test(t)) return false
      if (t.toLowerCase() === signoff.firstName.toLowerCase()) return false
      if (t.toLowerCase() === signoff.companyName.toLowerCase()) return false
      return true
    })
    .join('\n')
    .trim()
}

function proseParagraphs(body: string, signoff: SenderSignoff): string[] {
  return proseOf(body, signoff).split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
}

// The band message says HOW MANY WORDS TO ADD OR CUT, because it is read by the repair
// call as well as by a person, and a model told only "27 words, outside 30 to 70" adds
// one word and fails again. The count includes the greeting and both sign-off lines.
function bandDetail(words: number, min: number, max: number): string {
  const fix = words < min ? `add at least ${min - words} words` : `cut at least ${words - max} words`
  return `${words} words counting greeting and sign-off, outside ${min} to ${max}: ${fix}`
}

/**
 * Every rule that applies to a whole rendered email, whatever its position.
 * `label` names the rendering (slot-free, or a fact cell) for the report.
 */
function checkRenderedEmail(input: {
  variant: string
  where: string
  body: string
  maskedBody: string
  position: 1 | 2 | 3 | 4
  isFact: boolean
  /**
   * Grade the body AS IT WILL BE READ, with the slot fills in. At composition the fills are
   * a real prospect's words. At generation it is set only for the plain invented cells
   * (FillCell.gradeFilled), never for the cell invented to stress length.
   */
  gradeFilled?: boolean
  /**
   * The body the FILLED grade is taken on: the reader's customer group and peer label as
   * they will be read, with the opener clause masked. The opener has its own cap, below.
   * Omitted: the body itself.
   */
  gradeBody?: string
  /** The opener sentence as it will be read, for its own grade (OPENER_CLAUSE_MAX_GRADE). */
  opener?: string
  /** Which prose paragraph is the offer, if this email has one: its sentence has the longer cap. */
  offerParagraph?: number
  brief: OutboundBrief
  signoff: SenderSignoff
  out: TemplateViolation[]
}): void {
  const { variant, where, body, maskedBody, position, isFact, brief, signoff, out } = input
  const push = (rule: string, detail: string) => out.push({ variant, where, rule, detail })
  const prose = normalise(proseOf(body, signoff))
  const paragraphs = proseParagraphs(body, signoff)

  if (DASHES.test(prose)) push('dash', 'contains an em dash, en dash or double hyphen')
  {
    // ON THE AUTHORED WORDS (slots masked), like the two checks below. The list names
    // figures of speech an AUTHOR must not write. A prospect's own clause uses the same
    // words literally: "you provide bandwidth for rural schools" and "you breed wheat for
    // drought" each passed extraction, were paid for, and were sent back to the template
    // here for an idiom nobody wrote. Found by review on 2026-10-01.
    const lowerProse = normalise(proseOf(maskedBody, signoff)).toLowerCase()
    for (const idiom of idiomsFor(brief)) {
      if (new RegExp(`(?<![a-z])${idiom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`).test(lowerProse)) {
        push('idiom', `"${idiom}": say it literally`)
      }
    }
  }
  if (prose.includes('&')) push('ampersand', 'write "and"')
  {
    const busy = prose.match(BUSY_WORDING)
    if (busy) push('busy_wording', `"${busy[0]}": never describe how busy anyone is; say what comes first and what waits`)
  }
  // On the AUTHORED words (slots masked): a prospect's own clause may say anything.
  for (const phrase of findAmbiguousReferents(normalise(proseOf(maskedBody, signoff)))) {
    push('ambiguous_referent', `"${phrase}" can be read two ways; name who or what is meant`)
  }
  // On the authored words too: a prospect's own "you are an ..." is their page's wording.
  for (const stiff of findStiffForms(proseOf(maskedBody, signoff))) {
    push('stiff_wording', `"${stiff.found}" reads like a form letter: write "${stiff.write}", as a person does`)
  }
  for (const tell of findAITells(prose)) push('ai_tell', tell)
  for (const { label, pattern } of BANNED_JARGON) if (pattern.test(prose)) push('jargon', label)
  for (const label of findFirmographicFigures(prose)) push('firmographic', label)

  // WHOLE WORDS, not substrings: a phrase "ads" must not match "leads" or "heads".
  //
  // ON THE AUTHORED WORDS ONLY, so the slots are masked. A never_claims phrase is about
  // what the SENDER claims. A prospect whose own {does} says "software implementation" is
  // not the sender claiming to be software, and it sent a real firm-fact email back to the
  // template on 2026-09-30.
  const lower = normalise(proseOf(maskedBody, signoff)).toLowerCase()
  for (const { id, phrase } of forbiddenPhrases(brief)) {
    const escaped = normalise(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    if (new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(lower)) push('forbidden_phrase', `"${phrase}" (${id})`)
  }

  // THE LEAD-IN (2026-10-03) is joined in front of the offer sentence, so the offer
  // paragraph's caps are the offer's own plus the lead-in's words: "If Northtown Cold Room
  // Engineering is seeing this too," must not cost the offer the words it was written with.
  const leadInWords = (index: number) => {
    if (index !== input.offerParagraph) return 0
    const clause = paragraphs[index]?.match(/^If [^,.?!]{1,90},/)?.[0]
    return clause ? countWords(clause) : 0
  }
  for (const [paragraphIndex, sentence] of paragraphs.flatMap((para, i) => splitSentences(para.replace(/\n+/g, ' ')).map(sent => [i, sent] as const))) {
    const list = findThreePartList(sentence)
    if (list) push('three_part_list', `"${list}"`)
    // A NAMED SOURCE (2026-10-03) opens on who told us ("When we chat to HR consultants,"),
    // and that clause does not use up the sentence's words: the cap is for what is said.
    const words = countWords(sentence.replace(SOURCE_CLAUSE, ''))
    const cap = (paragraphIndex === input.offerParagraph ? OFFER_MAX_SENTENCE_WORDS : TEMPLATE_MAX_SENTENCE_WORDS) + leadInWords(paragraphIndex)
    if (words > cap) {
      push('sentence_length', `${words} words: "${sentence}"`)
    }
  }
  for (const [index, para] of paragraphs.entries()) {
    const sentences = splitSentences(para).length
    const words = countWords(para)
    if (sentences > TEMPLATE_MAX_PARAGRAPH_SENTENCES) {
      push('paragraph_sentences', `${sentences} sentences: "${para}"`)
    }
    if (words > TEMPLATE_MAX_PARAGRAPH_WORDS + leadInWords(index)) push('paragraph_words', `${words} words: "${para}"`)
    if (/^I\b/.test(para)) push('i_opener', `paragraph opens with "I": "${para}"`)
    // Rule 3: the question or call ask is ALWAYS its own paragraph.
    if (para.includes('?') && sentences > 1) {
      push('question_own_paragraph', `the question shares a paragraph: "${para}"`)
    }
  }

  const grade = fleschKincaidGrade(proseOf(maskedBody, signoff).replace(/\n+/g, ' '))
  if (grade === null) {
    push('reading_grade', 'no gradable prose')
  } else if (grade.grade > TEMPLATE_MAX_READING_GRADE) {
    push('reading_grade', `grade ${grade.grade.toFixed(2)} with slots masked, over ${TEMPLATE_MAX_READING_GRADE}: use shorter words`)
  }
  if (input.gradeFilled) {
    // THE OPENER CLAUSE IS NOT IN THIS NUMBER (note 6 on the fourth reading). It is the
    // prospect's own wording about their own trade, and it has a cap of its own just below.
    // NOR IS THE PEER LABEL (2026-10-03). Every pain line now names the reader's own group
    // ("When we chat to environmental consultants, ..."), and the reader knows the name of
    // their own trade however many syllables it has. Graded in, the label alone put most
    // wordings over the cap for the longer labels, and the writer can only answer that by
    // dropping words elsewhere. The label's LENGTH is still held by the length rules.
    // What is graded here is everything the client wrote, with the reader's customer group
    // as they will read it.
    const gradeProse = normalise(proseOf(input.gradeBody ?? body, signoff))
    const filled = fleschKincaidGrade(gradeProse.replace(/\n+/g, ' '))
    if (filled !== null && filled.grade > FACT_EMAIL1_MAX_FILLED_GRADE) {
      push('reading_grade_filled', `grade ${filled.grade.toFixed(2)} with the customer group filled in (the opener clause and the peer label apart), over ${FACT_EMAIL1_MAX_FILLED_GRADE}: use shorter words in the pain, the offer and the question`)
    }
  }
  if (input.opener !== undefined) {
    const openerGrade = openerClauseGrade(input.opener)
    if (openerGrade !== null && openerGrade > OPENER_CLAUSE_MAX_GRADE) {
      push('opener_clause_grade', `the opener sentence alone reads at grade ${openerGrade.toFixed(1)}, over ${OPENER_CLAUSE_MAX_GRADE}: "${input.opener}"`)
    }
  }

  const questions = (prose.match(/\?/g) ?? []).length
  if (position === 1 && questions !== 1) push('question_count', `Email 1 must hold exactly one question, found ${questions}`)
  if (position === 2 && questions > 1) push('question_count', `Email 2 may hold one question, found ${questions}`)
  if (position === 3 && questions !== 1) push('question_count', `Email 3 must end with one soft call ask, found ${questions} questions`)
  if (position === 4 && questions !== 0) push('question_count', `Email 4 is a break-up and holds no question, found ${questions}`)
  if (position === 4 && BREAKUP_BLOCK.test(prose)) {
    push('breakup_explains', `break-up explains or lectures: "${prose.match(BREAKUP_BLOCK)![0]}"`)
  }

  const words = countWords(body)
  if (position === 1 && isFact) {
    if (words < FACT_EMAIL1_WORD_LIMITS.minWords || words > FACT_EMAIL1_WORD_LIMITS.maxWords) {
      push('word_band', bandDetail(words, FACT_EMAIL1_WORD_LIMITS.minWords, FACT_EMAIL1_WORD_LIMITS.maxWords))
    }
  } else {
    const band = {
      1: [EMAIL_WORD_LIMITS.email1MinWords, EMAIL_WORD_LIMITS.email1MaxWords],
      2: [EMAIL_WORD_LIMITS.email2MinWords, EMAIL_WORD_LIMITS.email2MaxWords],
      3: [EMAIL_WORD_LIMITS.email3MinWords, EMAIL_WORD_LIMITS.email3MaxWords],
      4: [EMAIL_WORD_LIMITS.email4MinWords, EMAIL_WORD_LIMITS.email4MaxWords],
    }[position]
    if (words < band[0] || words > band[1]) push('word_band', bandDetail(words, band[0], band[1]))
  }

  if (position === 1) {
    if (NOTICED_OR_SAW.test(prose)) push('noticed_opener', 'Email 1 must never say "I noticed" or "I saw"')
    // EXEMPT WHAT STANDS ALONE BY CONSTRUCTION. Slot-free, that is the pain paragraph (P2,
    // the slot a researched trigger replaces). In the firm-fact email it is the opener AND
    // the pain: the pain line is the same authored text that already passed as P2 in the
    // slot-free render, and gating it again as P3 fires the bare-pronoun rule, which exists
    // for a P3 whose antecedent was replaced, on a paragraph nothing replaces. Measured
    // 2026-09-30: every variant of the first real run failed only on that. The offer and
    // question are scanned in the slot-free render, so nothing goes unchecked.
    // THE LEAD-IN IS NOT AN ANTECEDENT (2026-10-03). "If you're seeing this too," opens every
    // offer paragraph, and its words would stand as the antecedent of any pronoun after it,
    // so a bare "them" in the offer went unseen. The clause is set aside for this scan.
    const backRefs = findBackReferences(body.replace(/(^|\n\n)If [^,.?!\n]{1,90},\s*/g, '$1'), isFact ? 2 : 1)
    for (const hit of backRefs.demonstratives) push('back_reference', `"${hit.phrase}" in paragraph ${hit.paragraph}`)
    for (const hit of backRefs.unanchoredPronouns) push('bare_pronoun', `"${hit.pronoun}" in paragraph ${hit.paragraph}`)
    // THE QUESTION STANDS ALONE. On the researched path the offer-line selector may put a
    // DIFFERENT variant's offer above it, so "Would that be useful?" can point at a line it
    // was never written under. The question is the last prose paragraph.
    const questionParagraph = paragraphs.length + 1   // findBackReferences numbers from P2
    const all = [...backRefs.ambiguousPronouns, ...backRefs.unanchoredPronouns]
    for (const hit of all.filter(h => h.paragraph === questionParagraph)) {
      push('question_points_back', `"${hit.pronoun}" in the question points at an earlier line: "${hit.context}"`)
    }
  }

  for (const hit of findAssumedCapacityClaims(prose)) {
    const raw = position === 1 && EMAIL1_RAW_BLOCKING_KINDS.includes(hit.kind)
    if (raw || isUnambiguousReaderClaim(hit, [])) {
      push('assumed_capacity', `${hit.kind}: "${hit.sentence}"`)
    }
  }
}

/**
 * OUTCOMES, NOT FEATURES, AND THE RIGHT OUTCOME (operator notes 1 and 2 of the second
 * reading). An offer line cites an outcome from the brief, and that outcome is one the
 * brief says ANSWERS the pain stated just above it. This is the half code can hold: what a
 * line cites. Whether its first sentence really leads with that outcome, and whether it
 * really answers the pain as worded, are the scope judge's two questions on every offer.
 */
function offerOutcomeFaults(
  brief: OutboundBrief,
  index: ReturnType<typeof briefItemIndex>,
  from: readonly string[],
  painAngleId: string,
): Array<{ rule: string; detail: string }> {
  const cited = from.filter(id => index.get(id) === 'outcome')
  if (cited.length === 0) {
    return [{ rule: 'offer_outcome', detail: 'an offer leads with what the reader gets: cite the outcome it sells' }]
  }
  const answers = brief.pain_angles.find(a => a.id === painAngleId)?.resolved_by ?? []
  if (!cited.some(id => answers.includes(id))) {
    return [{
      rule: 'offer_resolves_pain',
      detail: `the pain above this offer is ${painAngleId}, answered by ${answers.join(', ') || 'no outcome in the brief'}; the offer cites ${cited.join(', ')}`,
    }]
  }
  return []
}

/**
 * The subject, as it ships. A subject never goes through checkRenderedEmail, which reads a
 * body, so until 2026-10-01 nothing checked a subject's words at all: a subject could hold a
 * never_claims phrase or the client's avoid_wording, and one whose only slot was
 * {peer_group} was never measured against the 40-character cap.
 *
 *   - LENGTH, on the slot-free rendering, which is the stored subject, every template-tier
 *     subject, and what a filled subject falls back to when the fill takes it over the cap
 *     (renderFactEmail1). So this one form fitting is what makes every send fit.
 *   - WORDS, on the authored text only: the slots are masked, because a prospect's own
 *     customers are not the sender claiming anything.
 */
function checkSubject(input: {
  variant: string
  where: string
  subject: TemplateWording
  brief: OutboundBrief
  out: TemplateViolation[]
}): void {
  const { variant, where, subject, brief, out } = input
  const push = (rule: string, detail: string) => out.push({ variant, where, rule, detail })
  let form: string
  try {
    form = renderSlotFree(subject, brief.peer_group_default.label, { capitalise: false })
  } catch {
    return   // an unrenderable line is already reported by its declaration
  }
  if (form.length > EMAIL_SUBJECT_LIMITS.email1MaxChars) {
    push('subject_length', `"${form}" is ${form.length} characters slot-free, over ${EMAIL_SUBJECT_LIMITS.email1MaxChars}`)
  }
  const authored = [fillSlots(subject.text, GRADE_MASK, { capitalise: false }) ?? '', subject.slot_free ?? '']
    .map(t => normalise(t)).filter(t => t.trim() !== '')
  // Lower case, as the generator is told: a subject that opens on a capital reads as a
  // headline. Read on the authored text, so a slot at the start is not a capital.
  if (/^[A-Z][a-z]/.test(subject.text.trim()) || /^[A-Z][a-z]/.test((subject.slot_free ?? '').trim())) {
    push('subject_case', 'the subject is lower case')
  }
  for (const text of authored) {
    for (const idiom of idiomsFor(brief)) {
      if (new RegExp(`(?<![a-z])${idiom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`).test(text.toLowerCase())) push('idiom', `subject: "${idiom}": say it literally`)
    }
    if (DASHES.test(text)) push('dash', 'the subject contains an em dash, en dash or double hyphen')
    if (text.includes('&')) push('ampersand', 'write "and" in the subject')
    for (const tell of findAITells(text)) push('ai_tell', `subject: ${tell}`)
    for (const { label, pattern } of BANNED_JARGON) if (pattern.test(text)) push('jargon', `subject: ${label}`)
    for (const label of findFirmographicFigures(text)) push('firmographic', `subject: ${label}`)
    // The reader's time and capacity are not ours to describe, in a subject as anywhere
    // else: "new meetings on your calendar" passed every check until a subject was read.
    for (const hit of findAssumedCapacityClaims(text)) {
      if (EMAIL1_RAW_BLOCKING_KINDS.includes(hit.kind) || isUnambiguousReaderClaim(hit, [])) {
        push('assumed_capacity', `subject: ${hit.kind}: "${text}"`)
      }
    }
    if (BUSY_WORDING.test(text)) push('busy_wording', `subject: "${text}"`)
    for (const phrase of findAmbiguousReferents(text)) push('ambiguous_referent', `subject: "${phrase}" can be read two ways`)
    const lower = text.toLowerCase()
    for (const { id, phrase } of forbiddenPhrases(brief)) {
      const escaped = normalise(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
      if (new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(lower)) push('forbidden_phrase', `"${phrase}" (${id}) in the subject`)
    }
  }
}

function checkLineDeclaration(
  variant: string,
  where: string,
  line: TemplateWording,
  index: ReturnType<typeof briefItemIndex>,
  out: TemplateViolation[],
  /**
   * `followup`: a follow-up paragraph, which may hold {company}, {for_whom} or {peer_group},
   * one kind at most. `leadIn`: Email 1's lead-in, which holds {company} and nothing else.
   */
  opts: { followup: boolean; leadIn?: boolean },
): void {
  const push = (rule: string, detail: string) => out.push({ variant, where, rule, detail })
  if (!line || typeof line.text !== 'string' || line.text.trim() === '') {
    push('line_missing', 'line has no text')
    return
  }
  // ONE LINE IS ONE PARAGRAPH. A blank line inside a line's text makes a second paragraph
  // with no kind and no rules of its own: it cleared "the question is its own paragraph"
  // by becoming one, and in Email 1 it moved the offer out of the place composition and the
  // research writer read it from.
  if (/\n/.test(line.text) || /\n/.test(line.slot_free ?? '')) {
    push('line_break', 'a line is one paragraph: no line breaks inside it')
  }
  const actual = slotsIn(line.text)
  const declared = Array.isArray(line.slots) ? line.slots : []
  for (const s of declared) if (!SLOTS.includes(s)) push('slot_unknown', `declares unknown slot ${s}`)
  const same = actual.length === declared.length && actual.every(s => declared.includes(s))
  if (!same) push('slot_undeclared', `text uses {${actual.join('}, {')}} but declares [${declared.join(', ')}]`)
  // NO BRACE BUT A KNOWN SLOT'S, in either form. The first version looked for a lower-case
  // name in braces in the text only, so "{Company}", "{ company }" and a slot_free holding
  // "{company_name}" each passed, and the last is what a prospect with no usable name would
  // be sent, braces and all.
  if (/[{}]/.test(line.text.replace(/\{(does|for_whom|peer_group|company)\}/g, ''))) {
    push('slot_unknown', 'text holds a placeholder that is not a known slot')
  }
  if (/[{}]/.test(line.slot_free ?? '')) push('slot_unknown', 'the slot_free form holds a brace: it is sent exactly as written')
  if (actual.includes('does')) push('does_outside_opener', '{does} belongs to the opener frames only')
  // WHICH SLOT GOES WHERE. {company} is for follow-ups: it is what Emails 2 and 3 carry of
  // the reader (operator note 2 on the fourth reading). A follow-up paragraph holds
  // {company} or {for_whom} and nothing else, and ONE kind at most: a paragraph falls back
  // to its slot-free form as a whole when any fill is missing, so two kinds in one would
  // cost a prospect its name for want of a customer group.
  const NEEDS_SLOT_FREE: readonly string[] = ['for_whom', 'does', 'company']
  if (opts.followup) {
    const notAllowed = actual.filter(slot => !FOLLOWUP_SLOTS.includes(slot))
    if (notAllowed.length > 0) push('followup_slot', `a follow-up paragraph may hold {company} or {for_whom} only, found {${notAllowed.join('}, {')}}`)
    if (actual.length > 1) push('followup_slot_mix', `one slot kind per follow-up paragraph, found {${actual.join('}, {')}}`)
  } else if (opts.leadIn) {
    const notAllowed = actual.filter(slot => slot !== 'company')
    if (notAllowed.length > 0) push('lead_in_slot', `the lead-in holds {company} and no other slot, found {${notAllowed.join('}, {')}}`)
  } else if (actual.includes('company')) {
    push('company_outside_followups', '{company} is used in the Email 1 lead-in and in follow-up paragraphs only')
  }
  // "{company}'s" reads badly for a name that ends in s, and a name is a whole phrase.
  if (/\{company\}['’]s\b/.test(line.text)) push('company_possessive', 'write {company} as a subject or an object, never as a possessive')
  if (actual.some(slot => NEEDS_SLOT_FREE.includes(slot)) && !line.slot_free?.trim()) {
    push('slot_free_missing', 'a line declaring {for_whom} or {company} needs a slot_free form')
  }
  if (line.slot_free && slotsIn(line.slot_free).length > 0) push('slot_free_has_slot', 'slot_free form contains a placeholder')
  // A SECOND FORM ONLY WHERE ONE IS NEEDED. A line with no {for_whom} renders slot-free
  // from its own text. Allowed a separate slot_free anyway, that form was what the stored
  // body shipped, and every rule that reads the line's text (the pain rules above all) was
  // checking words no template-tier prospect received.
  if (line.slot_free?.trim() && !actual.some(slot => NEEDS_SLOT_FREE.includes(slot))) {
    push('slot_free_unneeded', 'only a line using {for_whom} or {company} carries a slot_free form; this one renders from its own text')
  }
  if (!Array.isArray(line.from) || line.from.length === 0) {
    push('from_missing', 'every line cites the brief item ids it uses')
  } else {
    for (const id of line.from) if (!index.has(id)) push('from_unknown', `cites ${id}, which is not in the brief`)
  }
}

// ─── The validator ────────────────────────────────────────────────────────────

export function validateTemplateDocument(input: TemplateDocumentInput): TemplateViolation[] {
  const { brief, opener_frames, variants, signoff } = input
  const out: TemplateViolation[] = []
  const index = briefItemIndex(brief)
  const docPush = (where: string, rule: string, detail: string) => out.push({ variant: '*', where, rule, detail })

  // Opener frames: two or three, each one sentence, each carrying {does} once and nothing else.
  if (opener_frames.length < MIN_OPENER_FRAMES || opener_frames.length > MAX_OPENER_FRAMES) {
    docPush('opener_frames', 'frame_count', `need ${MIN_OPENER_FRAMES} to ${MAX_OPENER_FRAMES} frames, found ${opener_frames.length}`)
  }
  const longestDoes = INVENTED_FILL_CELLS.map(c => c.fills.does ?? '').sort((a, b) => b.length - a.length)[0]
  opener_frames.forEach((frame, i) => {
    const where = `opener_frames[${i}]`
    const slots = slotsIn(frame)
    if (slots.length !== 1 || slots[0] !== 'does' || frame.split('{does}').length !== 2) {
      docPush(where, 'frame_slot', 'a frame holds {does} exactly once and no other slot')
    }
    if (OPENER_HEDGES.test(frame)) docPush(where, 'frame_hedge', `hedged frame: "${frame}"`)
    // "Saw that {does}." and "Read that {does}." are "I saw" and "I read" with the I
    // dropped: both shipped from real runs. A frame does not open on a bare past-tense verb.
    if (DROPPED_SUBJECT.test(frame)) docPush(where, 'frame_dropped_subject', `opens on a verb with no subject: "${frame}"`)
    if (NOTICED_OR_SAW.test(frame)) docPush(where, 'noticed_opener', `"${frame}"`)
    if (/^\s*I\b/.test(frame)) docPush(where, 'i_opener', `"${frame}"`)
    {
      const approves = frame.replace('{does}', ' ').match(FRAME_APPROVAL)
      if (approves) docPush(where, 'frame_judges', `"${approves[0]}" judges or praises the reader: a frame says what was seen and nothing about it`)
      const outside = frame.replace('{does}', ' ').toLowerCase().split(/[^a-z']+/).filter(Boolean).filter(word => !FRAME_WORDS.has(word))
      if (outside.length > 0) {
        docPush(where, 'frame_words', `"${[...new Set(outside)].join('", "')}": a frame's own words come from this list only: ${[...FRAME_WORDS].join(', ')}`)
      }
    }
    // THE FRAME'S OWN WORDS, checked AS THE FRAME'S. These rules also run on every rendered
    // firm-fact email, but a fault found there is reported under the variant, the repair
    // call rewrites the variant, and the frame that caused it is never touched. Found here,
    // it is a frame violation and the frames are what get rewritten.
    {
      const own = normalise(frame.replace('{does}', ' ')).trim()
      const lowerOwn = own.toLowerCase()
      if (DASHES.test(own)) docPush(where, 'dash', 'the frame contains an em dash, en dash or double hyphen')
      if (own.includes('&')) docPush(where, 'ampersand', 'write "and" in the frame')
      if (BUSY_WORDING.test(own)) docPush(where, 'busy_wording', `"${frame}"`)
      for (const stiff of findStiffForms(own)) docPush(where, 'stiff_wording', `"${stiff.found}": write "${stiff.write}"`)
      for (const phrase of findAmbiguousReferents(own)) docPush(where, 'ambiguous_referent', `"${phrase}" can be read two ways`)
      for (const tell of findAITells(own)) docPush(where, 'ai_tell', tell)
      for (const { label, pattern } of BANNED_JARGON) if (pattern.test(own)) docPush(where, 'jargon', label)
      for (const idiom of idiomsFor(brief)) {
        if (new RegExp(`(?<![a-z])${idiom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`).test(lowerOwn)) docPush(where, 'idiom', `"${idiom}": say it literally`)
      }
      for (const { id, phrase } of forbiddenPhrases(brief)) {
        const escaped = normalise(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
        if (new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(lowerOwn)) docPush(where, 'forbidden_phrase', `"${phrase}" (${id}) in the frame`)
      }
    }
    const rendered = frame.replace('{does}', longestDoes)
    if (splitSentences(rendered).length !== 1) docPush(where, 'frame_sentences', 'the opener is ONE sentence')
    const words = countWords(rendered)
    if (words > TEMPLATE_MAX_SENTENCE_WORDS) {
      docPush(where, 'sentence_length', `${words} words with the longest {does}, over ${TEMPLATE_MAX_SENTENCE_WORDS}`)
    }
  })

  const mostBuyers = mostBuyersAngles(brief).map(a => a.id)
  // THE PEER RUNG NEEDS A FRAME THAT DOES NOT NAME THE SITE. Its clause is built from the
  // prospect's stored record, not read on their website, so "Your site shows you run ..."
  // would credit their site with a data provider's label. Composition uses only a frame
  // without those words, and with none in the document the rung would be silently absent.
  const peerKinds = brief.peer_groups.filter(pg => typeof pg.kind === 'string' && pg.kind.trim() !== '')
  const siteFreeFrames = opener_frames.map((frame, index) => ({ frame, index })).filter(({ frame }) => !FRAME_NAMES_THE_SITE.test(frame))
  if (peerKinds.length > 0 && siteFreeFrames.length === 0) {
    docPush('opener_frames', 'frame_site_free', 'at least one frame names no site, page or website: it carries a clause built from the reader\'s record, which was not read on their site')
  }
  for (const problem of unreachablePeerKinds(brief, CANONICAL_INDUSTRIES)) docPush('brief.peer_groups', 'peer_kind_industry', problem)
  // The opener built from a kind and the group's own label under it ("Can see you run an HR
  // consultancy. When we chat to HR consultants, ...") are NOT a fault since 2026-10-03:
  // the operator asked for the reader's own group by name. The after-opener stand-in and
  // the brief-level repeat check it needed are withdrawn.

  // Every label that can name the source in a pain line: each peer group's own.
  const peerLabels = brief.peer_groups.map(p => p.label)
  // A FRAME AND A PEER LABEL THAT SAY THE SAME WORD (second fix round, 2026-10-02). The pain
  // line opens on the label, so it stands straight under the frame: "Your site shows {does}."
  // then "Trade show exhibitors often tell us ...". Until this round that was found in the
  // firm-fact Email 1 and reported under every variant, whose writer is told the frames are
  // already written and cannot change a label: a stub run paid 22 repair calls ($1.82) and
  // passed nothing. The label is the brief's; the frame is the writer's, written once for
  // the whole document, so it is the FRAME that is reported. Every label is read, because
  // any of them can open that line: a peer group's own, the default, and the after_opener
  // label, which stands under any frame whose clause echoes the label it replaces.
  //
  // NEVER A FAULT OF THE BRIEF. A frame's words come from FRAME_WORDS, and a frame built only
  // from its small words ("Can see {does}.") says no word this rule counts, so no label can
  // make every frame impossible.
  const frameLabelWords = opener_frames.map(() => new Set<string>())
  const labelsUnderAFrame = [...new Set([brief.peer_group_default.label, ...peerLabels].filter((l): l is string => typeof l === 'string' && l.trim() !== ''))]
  opener_frames.forEach((frame, f) => {
    for (const label of labelsUnderAFrame) {
      for (const r of findConsecutiveRepeats([frame, label])) {
        if (frameLabelWords[f].has(r.word)) continue
        frameLabelWords[f].add(r.word)
        docPush(`opener_frames[${f}]`, 'consecutive_word', `"${r.word}" is said by this frame ("${frame}") and again by the peer label "${label}" that opens the line under it; the label is the brief's, so reword the frame without that word`)
      }
    }
  })
  const peerExtremes = [...new Set([
    [...peerLabels].sort((a, b) => a.length - b.length)[0],
    [...peerLabels].sort((a, b) => b.length - a.length)[0],
  ].filter((l): l is string => typeof l === 'string'))]
  const email1Angles: string[] = []

  for (const [variant, lines] of Object.entries(variants)) {
    const push = (where: string, rule: string, detail: string) => out.push({ variant, where, rule, detail })
    if (!lines?.email1 || !Array.isArray(lines.followups)) {
      push('lines', 'shape', 'variant has no email1 or followups')
      continue
    }
    if (lines.brief_version !== brief.brief_version) {
      push('lines', 'brief_version', `generated from brief v${lines.brief_version}, brief is v${brief.brief_version}`)
    }
    const e1 = lines.email1

    // THE LEAD-IN TO THE OFFER (operator, 2026-10-03): "If {company} is seeing this too,".
    // A condition that names the reader's firm and asks; never an assertion about it.
    if (!e1.lead_in) {
      push('email1.lead_in', 'lead_in_missing', 'Email 1 needs a lead-in to the offer: "If {company} is seeing this too," and a slot_free form "If you\'re seeing this too,"')
    } else {
      checkLineDeclaration(variant, 'email1.lead_in', e1.lead_in, index, out, { followup: false, leadIn: true })
      for (const fault of leadInFaults(e1.lead_in)) push('email1.lead_in', 'lead_in_shape', fault)
    }

    // FACELESS SOURCES, in every authored line and its slot-free form (2026-10-03).
    {
      const authored: Array<[string, TemplateWording]> = []
      for (const key of ['subject', 'pain', 'offer', 'question'] as const) {
        if (e1[key]) wordingsOf(e1[key]).forEach((wording, w) => authored.push([`email1.${key}${w === 0 ? '' : '.alt'}`, wording]))
      }
      if (e1.lead_in) authored.push(['email1.lead_in', e1.lead_in])
      for (const f of lines.followups) {
        (f?.paragraphs ?? []).forEach((p, i) => { if (p) authored.push([`email${f.position}.p${i + 1}`, p]) })
      }
      for (const [where, wording] of authored) {
        for (const form of [wording.text, wording.slot_free]) {
          const found = typeof form === 'string' ? findFacelessSource(form) : null
          if (found) push(where, 'faceless_source', `"${found}" says who told us without naming them; name the source with {peer_group}: "When we chat to {peer_group}, a lot of them tell us ..."`)
        }
      }
    }

    for (const key of ['subject', 'pain', 'offer', 'question'] as const) {
      const line = e1[key]
      if (!line) {
        push(`email1.${key}`, 'line_missing', 'line is absent')
        continue
      }
      wordingsOf(line).forEach((wording, w) =>
        checkLineDeclaration(variant, `email1.${key}${w === 0 ? '' : '.alt'}`, wording, index, out, { followup: false }))
      // {for_whom} BELONGS TO THE OFFER AND THE SUBJECT. A line using it has a second,
      // separately written slot_free form, and the rules that read a pain or a question
      // read its text: allowed there, the slot_free form was what template-tier prospects
      // received and nothing checked it.
      if (key === 'pain' || key === 'question') {
        wordingsOf(line).forEach((wording, w) => {
          if (slotsIn(wording.text ?? '').includes('for_whom')) {
            push(`email1.${key}${w === 0 ? '' : '.alt'}`, 'for_whom_outside_offer', `{for_whom} is used in the offer and the subject only, never in the ${key}`)
          }
        })
      }
      // {peer_group} OPENS THE PAIN LINE AND STANDS NOWHERE ELSE (2026-10-02), which is what
      // the generator has always been told. Composition fills it for the whole email, and
      // under an opener that has named the kind of firm the fill is the after-opener label,
      // written to open a sentence: a subject "new markets for {peer_group}" passed every
      // check here and shipped as "new markets for Firms like yours".
      if (key !== 'pain') {
        wordingsOf(line).forEach((wording, w) => {
          if (slotsIn(wording.text ?? '').includes('peer_group')) {
            push(`email1.${key}${w === 0 ? '' : '.alt'}`, 'peer_group_outside_pain', `{peer_group} opens the Email 1 pain line and is used nowhere else, never in the ${key}`)
          }
        })
      }
      // Rule 8: two wordings, and they are two wordings.
      const hasAlt = wordingsOf(line).length === 2
      if (!hasAlt && (TWO_WORDING_LINES as readonly string[]).includes(key)) {
        push(`email1.${key}`, 'alt_missing', `the ${key} line needs a second wording (alt)`)
      }
      if (hasAlt && normalise(line.alt!.text).trim().toLowerCase() === normalise(line.text).trim().toLowerCase()) {
        push(`email1.${key}.alt`, 'alt_identical', 'the second wording is the same as the first')
      }
    }
    if (out.some(v => v.variant === variant && (v.rule === 'line_missing' || v.rule === 'slot_free_missing'))) {
      continue   // cannot render a variant with a missing line; the reasons are already recorded
    }
    const proof = proofIds(brief)

    // Angles: Email 1 leads with a most_buyers angle; the pain line cites it and no proof.
    if (!mostBuyers.includes(e1.angle)) push('email1.angle', 'angle_reach', `${e1.angle} is not a most_buyers pain angle`)
    wordingsOf(e1.pain).forEach((pain, w) => {
      const where = `email1.pain${w === 0 ? '' : '.alt'}`
      if (!pain.from.includes(e1.angle)) push(where, 'angle_citation', `pain line does not cite its angle ${e1.angle}`)
      for (const id of pain.from) {
        if (proof.has(id)) push(where, 'proof_as_pain', `${id} is proof and never fills a pain line`)
      }
      // A NAMED SOURCE (operator, 2026-10-03): the first sentence says who told us, by
      // {peer_group}, in a conversational frame ("When we chat to {peer_group}, a lot of
      // them tell us ..."). It no longer has to OPEN on the slot.
      const first = splitSentences(pain.text.trim())[0] ?? ''
      if (!slotsIn(first).includes('peer_group')) {
        push(where, 'peer_group_source', 'the pain line\'s first sentence names who told us, with {peer_group}: "When we chat to {peer_group}, a lot of them tell us ..."')
      }
      for (const fault of findPainFormFaults(pain.text)) push(where, fault.rule, fault.detail)
      for (const sentence of findUnlinkedConsequences([pain.text])) {
        push(where, 'consequence_link', `the consequence opens on a linking phrase ("As a result,", "So", "When that happens,"), so it reads on from the line before: "${sentence}"`)
      }
      const angle = brief.pain_angles.find(a => a.id === e1.angle)
      if (angle) {
        for (const sentence of findConsequencesOffTheBrief([pain.text], angle)) {
          push(where, 'consequence_from_brief', `the consequence says what the brief's consequence for ${angle.id} says ("${angle.consequence}"), in its own key words: "${sentence}"`)
        }
      }
    })
    {
      const angle = brief.pain_angles.find(a => a.id === e1.angle)
      for (const part of unsaidConsequenceParts(wordingsOf(e1.pain).map(p => p.text), angle?.consequence)) {
        push('email1.pain', 'consequence_from_brief', `between them, the wordings of the pain say every part of the brief's consequence; none says "${part}"`)
      }
    }

    wordingsOf(e1.offer).forEach((offer, w) => {
      const where = `email1.offer${w === 0 ? '' : '.alt'}`
      const offerScope = offer.from.filter(id => {
        if (index.get(id) !== 'scope_does') return false
        return !brief.scope.does.find(d => d.id === id)?.proof_only
      })
      if (offerScope.length === 0) push(where, 'offer_scope', 'the offer cites no scope.does item it may use')
      for (const form of [offer.text, offer.slot_free]) {
        if (typeof form !== 'string' || !form.trim()) continue
        for (const fault of offerShapeFaults(form)) push(where, 'offer_shape', `${fault}: "${form}"`)
      }
      for (const fault of offerOutcomeFaults(brief, index, offer.from, e1.angle)) push(where, fault.rule, fault.detail)
      const offerHasForWhom = slotsIn(offer.text).includes('for_whom')
      if (brief.slot_policy?.for_whom_in_offer && !offerHasForWhom) {
        push(where, 'slot_policy', 'this client\'s brief puts {for_whom} in the offer, and the offer does not use it')
      }
      if (!brief.slot_policy?.for_whom_in_offer && offerHasForWhom) {
        push(where, 'slot_policy', 'this client\'s brief does not allow {for_whom} in the offer')
      }
      // Rule 4: only the lead differentiator may sit in an Email 1 offer.
      for (const id of offer.from) {
        if (proof.has(id) && !isLeadDifferentiator(brief, id)) {
          push(where, 'proof_in_email1_offer', `${id} is proof and is not the lead differentiator; it belongs in a follow-up`)
        }
      }
    })
    // offer_angle (copy-writing a9044e5): a short problem phrase, or null for the one
    // neutral line. A neutral offer names no pain, so it may cite no pain angle.
    if (e1.offer_angle === undefined) {
      push('email1.offer_angle', 'offer_angle_missing', 'every Email 1 declares offer_angle: a problem, or null for the neutral line')
    } else if (e1.offer_angle === null) {
      const painCited = wordingsOf(e1.offer).flatMap(o => o.from).filter(id => index.get(id) === 'pain_angle')
      if (painCited.length > 0) push('email1.offer', 'neutral_offer_names_pain', `the neutral offer cites ${[...new Set(painCited)].join(', ')}`)
      // NEUTRAL MEANS IT ANSWERS EVERY LEAD PAIN, not that it answers its own. The selector
      // places this line under whichever pain a prospect gets, so the only outcome it may
      // sell is one the brief lists under ALL of them. Held to its own variant's pain alone,
      // the stored neutral line led with the outcome for that one pain.
      const allowed = neutralOutcomeIds(brief)
      wordingsOf(e1.offer).forEach((offer, w) => {
        const tied = offer.from.filter(id => index.get(id) === 'outcome' && !allowed.includes(id))
        if (tied.length > 0) {
          push(`email1.offer${w === 0 ? '' : '.alt'}`, 'neutral_offer_outcome',
            `the neutral offer sits under any lead pain, so it sells only an outcome that answers all of them (${allowed.join(', ') || 'the brief has none'}); it cites ${tied.join(', ')}`)
        }
      })
    } else {
      const angleText = e1.offer_angle.trim()
      const n = countWords(angleText)
      if (n === 0 || n > OFFER_ANGLE_MAX_WORDS) push('email1.offer_angle', 'offer_angle_length', `${n} words, need 1 to ${OFFER_ANGLE_MAX_WORDS}`)
      if (DASHES.test(angleText) || /\{[a-z_]+\}/.test(angleText)) push('email1.offer_angle', 'offer_angle_form', 'no dashes or slots in an offer angle')
      const lowerAngle = normalise(angleText).toLowerCase()
      for (const { id, phrase } of forbiddenPhrases(brief)) {
        if (new RegExp(`(?<![a-z0-9])${normalise(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(lowerAngle)) {
          push('email1.offer_angle', 'forbidden_phrase', `"${phrase}" (${id}) in offer_angle`)
        }
      }
    }
    wordingsOf(e1.question).forEach((question, w) => {
      if (MEETING_REQUEST.test(question.text)) {
        push(`email1.question${w === 0 ? '' : '.alt'}`, 'meeting_request', `Email 1 asks about interest, never for a meeting: "${question.text}"`)
      }
      for (const sentence of findCouldOfAThing(question.text)) {
        push(`email1.question${w === 0 ? '' : '.alt'}`, 'ask_could', `"Could" asks a person. Of a thing, ask "Would": "${sentence}"`)
      }
      for (const fragment of findAskFragments(question.text)) {
        push(`email1.question${w === 0 ? '' : '.alt'}`, 'ask_fragment', `an ask is a full sentence that opens on its verb or question word, and never on \"How about\", \"What about\" or \"Why not\": "${fragment}"`)
      }
    })
    // Rule 4 holds for the WHOLE of Email 1, not only its offer: in Email 1 a proof point
    // sits in the offer and nowhere else. One cited by the subject or the question is the
    // same fault one line along, and was invisible while only the offer was read. (The pain
    // line is covered by proof_as_pain.)
    for (const key of ['subject', 'question'] as const) {
      wordingsOf(e1[key]).forEach((wording, w) => {
        for (const id of wording.from) {
          if (proof.has(id)) {
            push(`email1.${key}${w === 0 ? '' : '.alt'}`, 'proof_in_email1', `${id} is proof; in Email 1 a proof point sits in the offer only`)
          }
        }
      })
    }

    // Follow-ups: exactly positions 2, 3, 4; distinct angles; Email 4 names Email 1's angle.
    const byPos = new Map(lines.followups.map(f => [f.position, f]))
    const e2 = byPos.get(2), e3 = byPos.get(3), e4 = byPos.get(4)
    if (!e2 || !e3 || !e4 || lines.followups.length !== 3) {
      push('followups', 'shape', 'followups must be exactly positions 2, 3 and 4')
      continue
    }
    for (const f of [e2, e3, e4]) {
      if (!index.has(f.angle) || index.get(f.angle) !== 'pain_angle') {
        push(`email${f.position}.angle`, 'angle_unknown', `${f.angle} is not a pain angle in the brief`)
      }
      f.paragraphs.forEach((p, i) => {
        const where = `email${f.position}.p${i + 1}`
        checkLineDeclaration(variant, where, p, index, out, { followup: true })
        if (p.alt) push(where, 'followup_alt', 'follow-up paragraphs carry one wording')
        // The kind says what the paragraph is doing, which is what lets the pain rules reach
        // a follow-up at all. A paragraph asking a question is an ask, and only an ask asks.
        if (!p.kind || !PARAGRAPH_KINDS.includes(p.kind)) {
          push(where, 'paragraph_kind', `every follow-up paragraph declares a kind: ${PARAGRAPH_KINDS.join(', ')}`)
        } else {
          const asks = typeof p.text === 'string' && p.text.includes('?')
          if ((p.kind === 'ask') !== asks) push(where, 'ask_kind_mismatch', `kind is ${p.kind} and the paragraph ${asks ? 'asks a question' : 'asks nothing'}`)
          // An offer paragraph rests on something the sender does or can show. The prompt
          // has always said so; nothing held it, so an "offer" could be a second pain.
          //
          // AND NEVER ON PROOF ALONE (operator notes 1 and 10 of the second reading). "You
          // can see every person we contact" cited a proof point and passed: transparency
          // was the offer's whole point. An offer cites something the sender DOES that is
          // not proof-only, leads with an outcome, and that outcome answers the pain above
          // it. A proof point may sit beside those, in support.
          if (p.kind === 'offer') {
            const usable = (p.from ?? []).some(id => index.get(id) === 'scope_does' && !brief.scope.does.find(d => d.id === id)?.proof_only)
            if (!usable) push(where, 'followup_offer_scope', 'an offer paragraph cites a scope.does item that is not proof-only; proof may only support it')
            for (const fault of offerOutcomeFaults(brief, index, p.from ?? [], f.angle)) push(where, fault.rule, fault.detail)
            for (const form of [p.text, p.slot_free]) {
              if (typeof form !== 'string' || !form.trim()) continue
              for (const fault of offerShapeFaults(form)) push(where, 'offer_shape', `${fault}: "${form}"`)
            }
          }
          // {for_whom} is the reader's own customers. The brief says whether this client's
          // offer is about getting the reader more of them; where it is not, the slot has
          // no place in a follow-up either.
          if (slotsIn(p.text ?? '').includes('for_whom') && !brief.slot_policy?.for_whom_in_offer) {
            push(where, 'slot_policy', 'this client\'s brief does not allow {for_whom}')
          }
          // BOTH FORMS. The slot-free form is what a prospect with no usable name is sent,
          // and until 2026-10-02 only the offer's was read: a pain or an ask could say
          // anything in its slot_free and pass.
          const forms = [p.text, p.slot_free].filter((form): form is string => typeof form === 'string' && form.trim() !== '')
          if (p.kind === 'ask') {
            for (const sentence of new Set(forms.flatMap(form => findCouldOfAThing(form)))) {
              push(where, 'ask_could', `"Could" asks a person. Of a thing, ask "Would": "${sentence}"`)
            }
            for (const fragment of new Set(forms.flatMap(form => findAskFragments(form)))) {
              push(where, 'ask_fragment', `an ask is a full sentence that opens on its verb or question word, and never on \"How about\", \"What about\" or \"Why not\": "${fragment}"`)
            }
          }
          if (p.kind === 'pain') {
            for (const id of p.from ?? []) if (proof.has(id)) push(where, 'proof_as_pain', `${id} is proof and never fills a pain paragraph`)
            const seen = new Set<string>()
            for (const fault of forms.flatMap(form => findPainFormFaults(form))) {
              const key = `${fault.rule}|${fault.detail}`
              if (!seen.has(key)) { seen.add(key); push(where, fault.rule, fault.detail) }
            }
          }
        }
      })
      // The pain paragraphs of one email, read in order: the first states the symptom, and
      // every sentence after it opens on a linking phrase (note 4 on the fourth reading).
      {
        const painParagraphs = f.paragraphs.filter(p => p.kind === 'pain' && typeof p.text === 'string')
        const unlinked = new Set([
          ...findUnlinkedConsequences(painParagraphs.map(p => p.text)),
          ...findUnlinkedConsequences(painParagraphs.map(p => p.slot_free ?? p.text)),
        ])
        for (const sentence of unlinked) {
          push(`email${f.position}`, 'consequence_link', `the consequence opens on a linking phrase ("As a result,", "So", "When that happens,"), so it reads on from the line before: "${sentence}"`)
        }
        const angle = brief.pain_angles.find(a => a.id === f.angle)
        if (angle) {
          const off = new Set([
            ...findConsequencesOffTheBrief(painParagraphs.map(p => p.text), angle),
            ...findConsequencesOffTheBrief(painParagraphs.map(p => p.slot_free ?? p.text), angle),
          ])
          for (const sentence of off) {
            push(`email${f.position}`, 'consequence_from_brief', `the consequence says what the brief's consequence for ${angle.id} says ("${angle.consequence}"), in its own key words: "${sentence}"`)
          }
        }
      }
      // EMAILS 2 AND 3 CARRY THE READER'S FIRM BY NAME (note 2 on the fourth reading): "at
      // minimum the company's short name in the offer line". Email 3 has the offer. Email 2
      // has none, so it carries the name in one of its own paragraphs.
      if (f.position === 3 && !f.paragraphs.some(p => p.kind === 'offer' && slotsIn(p.text ?? '').includes('company'))) {
        push('email3', 'followup_company_missing', 'the Email 3 offer names the reader\'s firm: use {company} in it, with a slot_free form')
      }
      if (f.position === 2 && !f.paragraphs.some(p => slotsIn(p.text ?? '').includes('company'))) {
        push('email2', 'followup_company_missing', 'one paragraph of Email 2 names the reader\'s firm: use {company} in it, with a slot_free form')
      }
      const kinds = f.paragraphs.map(p => p.kind ?? 'undeclared')
      const allowed = FOLLOWUP_STRUCTURES[f.position]
      if (!allowed.some(shape => shape.length === kinds.length && shape.every((k, i) => k === kinds[i]))) {
        push(`email${f.position}`, 'paragraph_structure', `Email ${f.position} is ${allowed.map(a => a.join(', ')).join(' or ')}; found ${kinds.join(', ') || 'no paragraphs'}`)
      }
      if (f.position !== 4 && !f.paragraphs.some(p => (p.from ?? []).includes(f.angle))) {
        push(`email${f.position}`, 'angle_citation', `no paragraph cites this email's angle ${f.angle}`)
      }
    }

    // Rule 11: an angle that cannot be written without excluding an in-scope buyer is
    // never used. The brief declares the conflict; this refuses the angle WHEREVER it is:
    // as an email's angle, and as an id any line or paragraph cites. The first version read
    // only the three planned angles, which code sets from the plan and which therefore
    // could never conflict; a line citing the angle in `from` went straight through.
    {
      const conflicted = conflictedAngleIds(brief)
      const refuse = (where: string, angleId: string) => {
        if (!conflicted.has(angleId)) return
        const conflicts = brief.pain_angles.find(a => a.id === angleId)?.conflicts_with ?? []
        push(where, 'angle_conflict', `${angleId} conflicts with ${conflicts.join(', ')} and may not be used in a sequence`)
      }
      refuse('email1.angle', e1.angle)
      refuse('email2.angle', e2.angle)
      refuse('email3.angle', e3.angle)
      for (const key of ['subject', 'pain', 'offer', 'question'] as const) {
        wordingsOf(e1[key]).forEach((wording, w) => {
          for (const id of wording.from) refuse(`email1.${key}${w === 0 ? '' : '.alt'}`, id)
        })
      }
      for (const f of [e2, e3, e4]) f.paragraphs.forEach((p, i) => { for (const id of p.from ?? []) refuse(`email${f.position}.p${i + 1}`, id) })
    }

    // Rule 4: each proof point appears at most once in a sequence. Counted per LINE, so a
    // line and its alternate wording are one use.
    {
      const uses = new Map<string, string[]>()
      const note = (where: string, ids: readonly string[]) => {
        for (const id of new Set(ids)) if (proof.has(id)) uses.set(id, [...(uses.get(id) ?? []), where])
      }
      for (const key of ['subject', 'pain', 'offer', 'question'] as const) note(`email1.${key}`, wordingsOf(e1[key]).flatMap(x => x.from))
      for (const f of [e2, e3, e4]) f.paragraphs.forEach((p, i) => note(`email${f.position}.p${i + 1}`, p.from ?? []))
      for (const [id, wheres] of uses) {
        if (wheres.length > 1) push('sequence', 'proof_repeated', `${id} is used ${wheres.length} times (${wheres.join(', ')}); a proof point appears once in a sequence`)
      }
    }
    if (new Set([e1.angle, e2.angle, e3.angle]).size !== 3) {
      push('angles', 'angle_distinct', `Emails 1 to 3 use distinct angles, found ${e1.angle}, ${e2.angle}, ${e3.angle}`)
    }
    if (e4.angle !== e1.angle) push('email4.angle', 'breakup_angle', `the break-up names Email 1's angle ${e1.angle}, found ${e4.angle}`)
    email1Angles.push(e1.angle)

    // A variant that cannot be rendered is not rendered: a follow-up paragraph holding a
    // slot has no slot-free form, and rendering it THREW out of the validator, which took
    // the whole generation run down after its first answer was paid for. The reasons are
    // already recorded above.
    if (out.some(v => v.variant === variant && ['line_missing', 'slot_free_missing', 'followup_slot', 'company_outside_followups', 'does_outside_opener', 'slot_unknown'].includes(v.rule))) continue

    // Render and gate: the follow-ups, and Email 1 in EVERY combination of wordings. The
    // full product is needed: the word band, the question count, the masked grade and the
    // bare-pronoun rule all depend on which pain sits above which offer.
    const pgDefault = brief.peer_group_default.label
    const followupBodies = {
      2: renderFollowupSlotFree(e2, pgDefault, signoff),
      3: renderFollowupSlotFree(e3, pgDefault, signoff),
      4: renderFollowupSlotFree(e4, pgDefault, signoff),
    } as const
    // Email 3 is pain, offer, ask: its offer is the second prose paragraph.
    const offerParagraphOf = (pos: 2 | 3 | 4) => (pos === 3 ? 1 : undefined)
    for (const pos of [2, 3, 4] as const) {
      checkRenderedEmail({
        variant, where: `email${pos} [slot-free]`, body: followupBodies[pos], maskedBody: followupBodies[pos],
        position: pos, isFact: false, offerParagraph: offerParagraphOf(pos), brief, signoff, out,
      })
      // ...AND WITH A REAL NAME AND CUSTOMER GROUP IN IT. Composition fills these per
      // prospect and re-validates nothing, so every limit a fill can break is held here,
      // against the longest fills composition can bring.
      const followup = byPos.get(pos)!
      if (!followup.paragraphs.some(p => slotsIn(p.text ?? '').length > 0)) continue
      for (const cell of INVENTED_FOLLOWUP_CELLS) {
        const filled = renderFollowup(followup, cell.fills, pgDefault, signoff)
        const masked = renderFollowup(followup, GRADE_MASK, pgDefault, signoff)
        checkRenderedEmail({
          variant, where: `email${pos} [${cell.name}]`, body: filled.body, maskedBody: masked.body,
          position: pos, isFact: false, offerParagraph: offerParagraphOf(pos), brief, signoff, out,
        })
      }
    }
    if (countWords(followupBodies[3]) > countWords(followupBodies[2])) {
      push('email3', 'email3_longer', `Email 3 (${countWords(followupBodies[3])} words) is longer than Email 2 (${countWords(followupBodies[2])})`)
    }

    wordingsOf(e1.subject).forEach((subject, w) => checkSubject({
      variant, where: `email1.subject${w === 0 ? '' : '.alt'}`, subject, brief, out,
    }))

    const choices: WordingChoice[] = []
    for (let pain = 0; pain < wordingsOf(e1.pain).length; pain++) {
      for (let offer = 0; offer < wordingsOf(e1.offer).length; offer++) {
        for (let question = 0; question < wordingsOf(e1.question).length; question++) {
          choices.push({ pain, offer, question })
        }
      }
    }
    // ACROSS SENTENCES AND ACROSS EMAILS (operator note 3 on the fifth reading). Every other
    // rule reads one email. A reader gets four, and hears "good-fit buyers" the fifth time
    // and "harder to plan" straight after "hard to plan". See src/lib/style/repetition.ts.
    //
    // Read on the slot-free renders, which hold only authored words. A follow-up is read a
    // second time with its slots masked, so a fault in the named form is seen as well.
    //
    // AND ON THE FIRM-FACT EMAIL 1 (2026-10-02), which is the slot-free one with an opener
    // on top and each line in the wording it has when its slot is filled. Until then
    // neither rule read it, and the two things only it holds went unread: the frame's own
    // words against the line under it ("Your site says ..." then "... leave the site"), and
    // a slotted wording, which is a different sentence from its slot_free form. No
    // prospect's words are needed for either, so the slots are left as the writer wrote
    // them and the finding quotes the writer's own line.
    const sentencesOf = (body: string) => proseParagraphs(body, signoff).flatMap(paragraph => splitSentences(paragraph))
    const consecutive = new Map<string, { where: string; detail: string }>()
    const noteConsecutive = (where: string, body: string) => {
      for (const r of findConsecutiveRepeats(sentencesOf(body))) {
        // One finding per place and word: the named form of a follow-up repeats what its
        // slot-free form already said.
        const key = where === 'email1' ? `${where}|${r.word}|${r.first}|${r.second}` : `${where}|${r.word}|${r.index}`
        if (consecutive.has(key)) continue
        consecutive.set(key, {
          where,
          detail: `"${r.word}" is said in two sentences in a row; say it once and reword the other: "${r.first}" then "${r.second}"`,
        })
      }
    }
    for (const pos of [2, 3, 4] as const) {
      noteConsecutive(`email${pos}`, followupBodies[pos])
      noteConsecutive(`email${pos}`, renderFollowup(byPos.get(pos)!, GRADE_MASK, pgDefault, signoff).body)
    }
    const overused = new Map<string, number>()
    // THE PEER LABEL IS THE BRIEF'S, and the source is named in each pain as asked
    // (2026-10-03): a label of two or three words would otherwise be "said three times" by
    // design, a phrase no writer can change. Each label is masked before counting.
    const labelsToMask = [pgDefault, ...brief.peer_groups.map(g => g.label)].filter(Boolean).sort((a, b) => b.length - a.length)
    const maskLabels = (text: string) => labelsToMask.reduce((t, label) => t.replace(new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), 'them'), text)
    const notePhrases = (raw: readonly string[]) => {
      const texts = raw.map(maskLabels)
      for (const { phrase, count } of findRepeatedPhrases(texts)) {
        // Named with the slot, not with the made-up word that stood in for it.
        const named = phrase.split(FOR_WHOM_PHRASE_MASK).join('{for_whom}')
        overused.set(named, Math.max(overused.get(named) ?? 0, count))
      }
    }
    // The follow-ups as a prospect with a name AND a customer group gets them.
    const groupFollowups = ([2, 3, 4] as const).map(pos =>
      proseOf(renderFollowup(byPos.get(pos)!, { company: GRADE_MASK.company, for_whom: FOR_WHOM_PHRASE_MASK }, pgDefault, signoff).body, signoff))

    for (const wording of choices) {
      const tag = `w${wording.pain}${wording.offer}${wording.question}`
      const slotFree1 = renderEmail1SlotFree(e1, pgDefault, signoff, wording)
      noteConsecutive('email1', slotFree1.body)
      // What the slot-free render of THIS wording already holds, by sentence and word. The
      // fact email's sentences are the same ones, one place further down.
      const slotFreeRepeats = new Set(findConsecutiveRepeats(sentencesOf(slotFree1.body)).map(r => `${r.index}|${r.word}`))
      // What the fact render of each frame already holds, by sentence and word: the peer
      // cell below reports only what this does not.
      const factRepeats = opener_frames.map(() => new Set<string>())
      for (let f = 0; f < opener_frames.length; f++) {
        // The slots as the writer wrote them, and the default peer label, so every sentence
        // with no slot of its own reads exactly as it does slot-free.
        const asWritten = renderFactEmail1({
          email1: e1, openerFrames: opener_frames, frameIndex: f, peerGroupDefault: pgDefault, signoff, wording,
          fills: { does: '{does}', for_whom: '{for_whom}', peer_group: pgDefault },
        })
        if (!asWritten) continue   // reported as fact_render, below
        for (const r of findConsecutiveRepeats(sentencesOf(asWritten.body))) {
          factRepeats[f].add(`${r.index}|${r.word}`)
          // A repeat that is in both forms of a line is said once, at email1.
          if (r.index > 0 && slotFreeRepeats.has(`${r.index - 1}|${r.word}`)) continue
          // The frame's word in the LABEL that opens the line: reported once, at the frame, above.
          if (r.index === 0 && frameLabelWords[f].has(r.word)) continue
          const key = `fact email1|${r.word}|${r.first}|${r.second}`
          if (consecutive.has(key)) continue
          consecutive.set(key, {
            where: 'fact email1',
            detail: r.index === 0
              // The writer's own word under the frame. The line under it is what can move.
              ? `"${r.word}" is said by the opener frame and again by the line under it; reword the line, so the word is said once: "${r.first}" then "${r.second}"`
              : `"${r.word}" is said in two sentences in a row; say it once and reword the other: "${r.first}" then "${r.second}"`,
          })
        }
        // ...and the phrases of that prospect's whole sequence, in every subject wording.
        const counted = renderFactEmail1({
          email1: e1, openerFrames: opener_frames, frameIndex: f, peerGroupDefault: pgDefault, signoff, wording,
          fills: { does: GRADE_MASK.does, for_whom: FOR_WHOM_PHRASE_MASK, peer_group: pgDefault },
        })
        if (!counted) continue
        for (const subject of wordingsOf(e1.subject)) {
          // The subject with its slot filled whatever its length: a real group may be
          // shorter than the made-up word, and the cap is held elsewhere.
          const subjectText = fillSlots(subject.text, { for_whom: FOR_WHOM_PHRASE_MASK, peer_group: pgDefault }, { capitalise: false })
            ?? renderSlotFree(subject, pgDefault, { capitalise: false })
          notePhrases([subjectText, proseOf(counted.body, signoff), ...groupFollowups])
        }
      }
      // EVERY SUBJECT WORDING, AND THE FOLLOW-UPS IN BOTH FORMS. A reader gets one subject
      // and one form of each follow-up, so each combination is counted on its own and the
      // highest count is what is reported. The first version read the subject's first
      // wording and the slot-free follow-ups only: a third use in the subject's second
      // wording, or in the form that names the reader's firm, was not counted.
      const namedFollowups = ([2, 3, 4] as const).map(pos => proseOf(renderFollowup(byPos.get(pos)!, GRADE_MASK, pgDefault, signoff).body, signoff))
      const plainFollowups = ([2, 3, 4] as const).map(pos => proseOf(followupBodies[pos], signoff))
      for (let subject = 0; subject < wordingsOf(e1.subject).length; subject++) {
        const subjectText = renderEmail1SlotFree(e1, pgDefault, signoff, { ...wording, subject }).subject
        for (const followups of [plainFollowups, namedFollowups]) notePhrases([subjectText, proseOf(slotFree1.body, signoff), ...followups])
      }
      checkRenderedEmail({
        variant, where: `email1 [slot-free ${tag}]`, body: slotFree1.body, maskedBody: slotFree1.body,
        position: 1, isFact: false, offerParagraph: 1, brief, signoff, out,
      })
      // The firm-fact Email 1: every cell, every frame, both peer extremes.
      for (const cell of INVENTED_FILL_CELLS) {
        for (let f = 0; f < opener_frames.length; f++) {
          // The cells graded with the fill in are graded against EVERY peer label. The
          // length rules need only the two extremes by length, but reading grade does not
          // follow length: a short label of long words reads harder than a long label of
          // short ones, and one chosen by characters passed generation and was refused
          // for about a third of that label's prospects at composition.
          const peers = cell.gradeFilled && peerLabels.length > 0 ? peerLabels : (peerExtremes.length > 0 ? peerExtremes : [pgDefault])
          for (const peer of peers) {
            const fills = { ...cell.fills, peer_group: peer }
            const fact = renderFactEmail1({ email1: e1, openerFrames: opener_frames, frameIndex: f, fills, peerGroupDefault: pgDefault, signoff, wording })
            const masked = renderFactEmail1({ email1: e1, openerFrames: opener_frames, frameIndex: f, fills: GRADE_MASK, peerGroupDefault: pgDefault, signoff, wording })
            // What the filled grade reads: everything as the reader gets it, the opener clause
            // and the peer label apart (2026-10-03, see checkRenderedEmail).
            const graded = renderFactEmail1({ email1: e1, openerFrames: opener_frames, frameIndex: f, fills: { ...fills, does: GRADE_MASK.does, peer_group: GRADE_MASK.peer_group }, peerGroupDefault: pgDefault, signoff, wording })
            if (!fact || !masked || !graded) {
              push(`fact email1 [${cell.name} / frame ${f}]`, 'fact_render', 'the firm-fact Email 1 did not render')
              continue
            }
            checkRenderedEmail({
              variant, where: `fact email1 [${cell.name} / frame ${f} / ${peer} / ${tag}]`, body: fact.body, maskedBody: masked.body,
              position: 1, isFact: true, gradeFilled: cell.gradeFilled === true, gradeBody: graded.body, opener: fact.opener,
              offerParagraph: 2, brief, signoff, out,
            })
          }
        }
      }
      // THE PEER RUNG, AS IT WILL BE SENT. Every other cell is invented. This one is not: the
      // clause is "you run" plus a kind from the brief, the label under it is chosen by the
      // same function composition calls, and the frame is one composition may use. So the
      // exact Email 1 a prospect of each peer group receives is held to every rule here,
      // including the one no invented cell could see: the opener and the pain line sharing
      // a word ("you run a software company" then "... tell us their software ...").
      for (const group of peerKinds) {
        const does = `you run ${group.kind!.trim()}`
        for (const { index: f } of siteFreeFrames) {
          const fills = { does, peer_group: group.label }
          const where = `fact email1 [peer ${group.id} / frame ${f} / ${tag}]`
          const fact = renderFactEmail1({ email1: e1, openerFrames: opener_frames, frameIndex: f, fills, peerGroupDefault: pgDefault, signoff, wording })
          const masked = renderFactEmail1({ email1: e1, openerFrames: opener_frames, frameIndex: f, fills: GRADE_MASK, peerGroupDefault: pgDefault, signoff, wording })
          const graded = renderFactEmail1({ email1: e1, openerFrames: opener_frames, frameIndex: f, fills: { ...fills, does: GRADE_MASK.does, peer_group: GRADE_MASK.peer_group }, peerGroupDefault: pgDefault, signoff, wording })
          if (!fact || !masked || !graded) {
            push(where, 'fact_render', 'the peer Email 1 did not render')
            continue
          }
          checkRenderedEmail({
            variant, where, body: fact.body, maskedBody: masked.body,
            position: 1, isFact: true, gradeFilled: true, gradeBody: graded.body, opener: fact.opener,
            offerParagraph: 2, brief, signoff, out,
          })
          // THE WHOLE EMAIL, as this prospect is sent it (second fix round, 2026-10-02). Two
          // things are in it that no other render holds: the opener with a REAL kind in it,
          // and the label code puts under that opener, which is often the after_opener label
          // and not the default the fact render above reads. Until this round only the first
          // pair was read here, and "Growing firms like yours often tell us ..." then "So
          // growth plans can slip." was sent unread. A pair the fact render of this frame
          // already holds was reported there, and is not said twice.
          //
          // THE WRITER'S WORDS ONLY, in the opener's pair. A word the LABEL shares with the
          // kind is the brief's fault, reported once as peer_opener_repeat at
          // "brief.peer_groups", and one it shares with the frame is the frame's, reported at
          // "opener_frames[n]": told here, under a variant, either went to a writer that
          // cannot change a label. Further down, a label word is the writer's to avoid: the
          // sentence after the label is the writer's own, and is what is reworded.
          const placedLabel = group.label
          const labelWords = new Set(placedLabel.toLowerCase().split(/[^a-z0-9']+/))
          for (const r of findConsecutiveRepeats(sentencesOf(fact.body))) {
            if (factRepeats[f].has(`${r.index}|${r.word}`)) continue
            if (r.index === 0 && labelWords.has(r.word)) continue
            const fromLabel = r.index === 1 && findConsecutiveRepeats([placedLabel, r.second]).some(l => l.word === r.word)
            const key = `fact email1 [peer ${group.id}]|${r.word}|${r.first}|${r.second}`
            if (consecutive.has(key)) continue
            consecutive.set(key, {
              where: `fact email1 [peer ${group.id}]`,
              detail: r.index === 0
                ? `"${r.word}" is said by the opener, which code builds from the brief, and again by the line under it; reword the line, so the word is said once: "${r.first}" then "${r.second}"`
                : fromLabel
                  ? `"${r.word}" is said by the peer label "${placedLabel}" that code puts at the start of the pain line, and again in the sentence after it; the label is the brief's, so reword that sentence: "${r.first}" then "${r.second}"`
                  : `"${r.word}" is said in two sentences in a row; say it once and reword the other: "${r.first}" then "${r.second}"`,
            })
          }
        }
      }
    }
    for (const { where, detail } of consecutive.values()) push(where, 'consecutive_word', detail)
    for (const [phrase, count] of overused) {
      push('sequence', 'phrase_repeat', `"${phrase}" is said ${count} times across the four emails a reader gets (subject, Email 1 in its most repetitive wording and form, Emails 2 to 4); twice is the most. Say it another way in ${count - 2} of them`)
    }
  }

  // No full sentence of Email 1 twice: not in two variants, and not in the two wordings of
  // one line. CLAUDE.md "Sentence reuse": HARD FAIL, EMAIL 1 ONLY, first writer wins in
  // sorted order, proper nouns and numbers normalised by SentenceRegistry.
  //
  // KEYED BY LINE AND WORDING, not by variant. findReuse ignores a match under the same id,
  // so keyed by variant the two wordings of one line could share a sentence and nothing
  // would say so. Taken on the slot-free render, where the peer group reads the same in
  // every variant, which is where two lines would really collide.
  {
    const registry = new SentenceRegistry()
    const subjects = new Map<string, string>()
    for (const key of Object.keys(variants).sort()) {
      const e1 = variants[key]?.email1
      if (!e1?.pain?.text || !e1.offer?.text || !e1.question?.text || !e1.subject?.text) continue
      for (const lineKey of ['pain', 'offer', 'question'] as const) {
        wordingsOf(e1[lineKey]).forEach((wording, w) => {
          let text: string
          try {
            text = renderSlotFree(wording, brief.peer_group_default.label)
          } catch {
            return   // an unrenderable line is already reported above
          }
          const id = `${key}.${lineKey}.${w}`
          for (const hit of registry.findReuse(id, text)) {
            out.push({ variant: key, where: `email1.${lineKey}${w === 0 ? '' : '.alt'}`, rule: 'email1_sentence_reuse', detail: `"${hit.sentence}" is already in ${hit.firstSeenId}` })
          }
          registry.register(id, text)
        })
      }
      wordingsOf(e1.subject).forEach((wording, w) => {
        const id = `${key}.subject.${w}`
        for (const subject of new Set([wording.text, wording.slot_free ?? wording.text].map(x => x.trim().toLowerCase()))) {
          const first = subjects.get(subject)
          if (first !== undefined && first !== id) {
            out.push({ variant: key, where: `email1.subject${w === 0 ? '' : '.alt'}`, rule: 'subject_reuse', detail: `"${subject}" is already the subject at ${first}` })
          } else if (first === undefined) {
            subjects.set(subject, id)
          }
        }
      })
    }
  }

  // Across variants: AT MOST ONE neutral offer line. Two would split the fallback between
  // two lines for no reason and halve how often any tagged line could be chosen.
  {
    const neutral = Object.entries(variants).filter(([, v]) => v?.email1 && v.email1.offer_angle === null).map(([k]) => k)
    if (neutral.length > 1) docPush('variants', 'offer_angle_neutral_count', `${neutral.length} neutral offer lines (${neutral.join(', ')}), at most one`)
  }

  // Rule 6: one variant per distinct lead angle. No two variants lead with the same angle,
  // and there are never more variants than lead angles. (Fewer is the generator's business:
  // it refuses to store a document that does not cover every lead angle.)
  {
    const seenAngles = new Map<string, number>()
    for (const angle of email1Angles) seenAngles.set(angle, (seenAngles.get(angle) ?? 0) + 1)
    const duplicated = [...seenAngles].filter(([, n]) => n > 1).map(([angle]) => angle)
    if (duplicated.length > 0) {
      docPush('variants', 'email1_angles_distinct', `two variants lead with the same angle: ${duplicated.join(', ')}`)
    }
    if (Object.keys(variants).length > mostBuyers.length) {
      docPush('variants', 'variant_count', `${Object.keys(variants).length} variants for ${mostBuyers.length} lead angles; one variant per lead angle`)
    }
  }

  // De-duplicate: the matrix renders each line many times, and one wording fault should
  // read as one fault per rule and variant, not twenty-four.
  //
  // KEYED ON THE PLACE AS WELL AS THE FAULT, with the matrix cell stripped. Keyed on rule and
  // detail alone, two lines with the same fault (both offer wordings citing no scope item,
  // three paragraphs with no kind) read as ONE, the repair call was told about the first,
  // and the second surfaced a round later, each round an expensive model call.
  const seen = new Set<string>()
  return out.filter(v => {
    // A SPACE before the bracket: "email1 [slot-free w010]" is a matrix cell, and
    // "opener_frames[1]" is a place.
    const key = `${v.variant}|${v.where.replace(/\s+\[.*\]$/, '')}|${v.rule}|${v.detail}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Re-validation of ONE composed firm-fact Email 1, at composition (Design, step 6).
 *
 * The template already passed the full validator at generation, over invented fills. This
 * runs the same per-email rules on the REAL fill, because a real {does} or {for_whom} can
 * break a sentence cap or the 75-word ceiling that no invented fill did. Any violation means
 * the prospect gets the template; composition logs the reason. Deterministic, no model.
 */
export function validateFactEmail1(input: {
  body: string
  maskedBody: string
  /** The body with the opener clause masked and every other fill real: what the filled grade reads. */
  gradeBody: string
  /** The opener sentence as the prospect will read it: graded alone, names masked. */
  opener: string
  subject: string
  brief: OutboundBrief
  signoff: SenderSignoff
}): TemplateViolation[] {
  const out: TemplateViolation[] = []
  checkRenderedEmail({
    variant: 'composed',
    where: 'fact email1',
    body: input.body,
    maskedBody: input.maskedBody,
    position: 1,
    isFact: true,
    gradeFilled: true,
    gradeBody: input.gradeBody,
    opener: input.opener,
    // Greeting aside: opener, pain, offer, question.
    offerParagraph: 2,
    brief: input.brief,
    signoff: input.signoff,
    out,
  })
  if (input.subject.length > EMAIL_SUBJECT_LIMITS.email1MaxChars) {
    out.push({ variant: 'composed', where: 'subject', rule: 'subject_length', detail: `${input.subject.length} characters` })
  }
  // The filled subject carries the prospect's own words. Generation checked the authored
  // subject; these are the two faults a real fill can bring that any reader sees.
  if (DASHES.test(input.subject)) out.push({ variant: 'composed', where: 'subject', rule: 'dash', detail: 'the filled subject contains a dash' })
  if (input.subject.includes('&')) out.push({ variant: 'composed', where: 'subject', rule: 'ampersand', detail: 'the filled subject contains an ampersand' })
  return out
}
