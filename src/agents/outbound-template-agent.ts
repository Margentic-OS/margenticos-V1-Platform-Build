// Outbound template agent: writes a client's four message template variants (Emails 1 to
// 4, subjects, opener frames) from the client's OUTBOUND BRIEF and nothing else.
//
// Plan: Notion "Firm-fact tier: plan (decided 30 September)", Round 7 (the build
// specification), with the principles of Rounds 3 to 6.
//
// WHY A SEPARATE AGENT FROM messaging-generation-agent. That agent reads intake, ICP,
// positioning, tone of voice, cross-client patterns and the live template, and Round 6
// showed the problem was exactly those inputs: the documents were right for strategy and
// wrong for outbound. This agent's only client input is the brief, which a person has
// confirmed. It is a different agent with a different input contract, so it is a
// different file (one file = one agent). The old agent stays for clients with no brief.
//
// THE BRIEF-ONLY SEAM. buildGenerationPrompt takes an OutboundBrief and nothing else, and
// a test asserts that no other field of the messaging document reaches the prompt. The
// live template text is deliberately NOT shown (ripple b): the agent upgrades by angle,
// never by copying the old wording.
//
// MODEL CALLS, and why each is a model call (ADR-018):
//   generation   claude-opus-4-6. Writing copy is synthesis. Document-generation tier per
//                ADR-013, and it runs once per regeneration, so cost is negligible.
//   repair       same model, only for variants the deterministic validator rejected.
//   scope judge  claude-sonnet-4-6. Whether a sentence claims something beyond what the
//                sender does is a paraphrase judgement that phrase lists cannot make.
//                Runs once per generation, never per prospect. Code rejects on any hit.
//
//   label judge  claude-sonnet-4-6, once per run, before anything is written: does the
//                default peer label wrongly describe a buyer the brief says is in scope?
//                A phrase list catches only the words somebody already listed (rule 7).
//
// THE VALIDATOR IS THE GATE, the prompt is advice (ADR-028). Every rule stated below is
// enforced by validateTemplateDocument; a variant that still fails after the repair budget
// is dropped, and a run that does not pass EVERY planned variant fails (rule 6).

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { usdForTokens } from '@/lib/agents/research/cost-constants'
import { countWords } from '@/lib/composition/personalization'
import { EMAIL_WORD_LIMITS, FACT_EMAIL1_WORD_LIMITS } from '@/agents/messaging-generation-agent'
import { FOR_WHOM_MAX_WORDS } from '@/lib/agents/research/firm-fact-checks'
import { scrubAITells, assertNoDashes } from '@/lib/style/customer-facing-style-rules'
import {
  isLeadDifferentiator,
  mostBuyersAngles,
  proofIds,
  usableAngles,
  validateOutboundBrief,
  type OutboundBrief,
  neutralOutcomeIds,
} from '@/lib/outbound-brief/brief'
import {
  renderEmail1SlotFree,
  renderFollowupSlotFree,
  SLOTS,
  slotsIn,
  wordingsOf,
  type FollowupLines,
  type ParagraphKind,
  type SenderSignoff,
  type TemplateLine,
  type TemplateWording,
  type VariantLines,
} from '@/lib/outbound-templates/template-shape'
import { splitSentences } from '@/lib/style/readability'
import {
  FRAME_WORDS,
  TEMPLATE_MAX_SENTENCE_WORDS,
  validateTemplateDocument,
  type TemplateViolation,
} from '@/lib/outbound-templates/validate-templates'
import { findConsecutiveRepeats } from '@/lib/style/repetition'

export const OUTBOUND_TEMPLATE_MODEL = 'claude-opus-4-6'
/**
 * The cheaper writer for DRAFT runs (operator spend rule, 2026-10-02: "Sonnet for drafts").
 * A draft is held to every check and to the same scope judge as any other run, so what it
 * stores has passed exactly what an Opus run would have had to pass. It is chosen per run by
 * the caller and recorded on the result; nothing defaults to it.
 */
export const OUTBOUND_TEMPLATE_DRAFT_MODEL = 'claude-sonnet-4-6'
export const OUTBOUND_SCOPE_JUDGE_MODEL = 'claude-sonnet-4-6'

// Explicit, per the lesson in the ICP geography agent: the SDK defaults are a 10-minute
// timeout and 2 retries, which a script cannot tell from a hang.
//
// 600 SECONDS, RAISED FROM 240 ON 2026-10-01: one generation call timed out at 240 on the
// answer alone. This runs from the command line only, so there is no route ceiling.
const GENERATION_TIMEOUT_MS = 600_000
/**
 * The room a WRITING answer gets: one variant, first draft or repair.
 *
 * 5,000. Until 2026-10-02 a writing answer was allowed 12,000. Measured on 2026-10-02 over ten
 * usable answers: 1,042 to 2,185 output tokens. The only answers that ever reached 12,000
 * were ones that never got to the JSON at all: the model checking its own work in the
 * answer, word by word and syllable by syllable. Each of those is billed for every token it
 * wrote, about thirty cents at this model's published price, and yields nothing. (The price
 * table read "about ninety cents" until 2026-10-02: it held three times the published
 * price.) Two in one run took a three-dollar run to its cap, as the table then counted it,
 * with no variant repaired. An answer that needs more than twice the largest sound one is
 * not going to be one, so it is stopped there.
 */
const WRITING_MAX_TOKENS = 5_000
/** A variant whose repair answer came back cut off this many times is not asked again in this run. */
const MAX_CUT_OFF_REPAIRS = 2
/**
 * ONE VARIANT PER CALL, NO THINKING, AND THE MODEL IS TOLD CODE DOES THE CHECKING.
 *
 * The prompt holds some forty rules. Asked for two or three variants at once, the model
 * checks every draft against every rule and runs out of room. Measured on 2026-10-01, in
 * the order tried, each a paid call that produced nothing:
 *
 *   several variants, no thinking    it did the checking IN THE ANSWER ("Wait, am I allowed
 *                                    to not ask a question? The rule says ..."), 35,000
 *                                    characters, cut off before any JSON. Three calls.
 *   adaptive thinking                no limit of its own: all 28,000 tokens went on
 *                                    thinking and nothing was written. Twice.
 *   a thinking budget of 8,000       not honoured by this model (the setting is marked
 *                                    deprecated for it): one variant used all 20,000
 *                                    tokens thinking and wrote nothing. Twice.
 *
 * What worked every time it was tried: ONE variant, no thinking. So that is the shape of
 * every generation and repair call, and the prompt now says that code checks the answer
 * and reports what to fix, so the model's job is one honest attempt, not a proof. Do not
 * switch thinking back on without measuring it on a real brief.
 */
// 12,000, RAISED FROM 6,000 on 2026-10-01: the judge now answers for every wording of every
// line, in both its forms, with seven fields a line. A cut-off answer is an unjudged run.
const JUDGE_MAX_TOKENS = 12_000
/**
 * Generation + repair calls per run (the expensive model). 30, RAISED FROM 13 on 2026-10-01
 * when every call became one variant: three variants now cost three calls to write and up
 * to three a round to repair, each about a third the size of the call it replaced.
 */
const MAX_GENERATION_CALLS = 30
/**
 * Scope judge calls per run, budgeted SEPARATELY so a run that spends its generation
 * budget on repairs can still judge the final wording. Measured 2026-09-30: with one
 * shared budget of 10, three variants ended deterministic-clean and unjudged, and were
 * dropped for it.
 */
const MAX_JUDGE_CALLS = 12
/**
 * Repair rounds after the first generation. RAISED FROM 7 on 2026-10-01: with the eleven
 * operator rules and the reader rules together a variant has some forty ways to fail, and
 * the first full run spent seven rounds on deterministic faults before the judge had read
 * two of its three variants. A round was then counted at about a quarter of a dollar, by a
 * price table that held three times Opus's published price (corrected 2026-10-02), so about
 * eight cents in fact, and a run happens once per regeneration.
 */
const MAX_REPAIR_ROUNDS = 11
const VARIANT_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * ONE VARIANT PER DISTINCT LEAD ANGLE (operator rule 6, 2026-10-01). The variant keys are
 * the first N letters, N being the number of most_buyers angles in the brief: three for a
 * client with three lead angles, never a fourth variant repeating one of them.
 */
export function variantKeysFor(brief: OutboundBrief): string[] {
  return mostBuyersAngles(brief).map((_, i) => VARIANT_LETTERS[i]).filter((k): k is string => typeof k === 'string')
}

// ─── The angle plan: deterministic, from the brief ───────────────────────────
//
// Computed in code rather than left to the model, so the rules cannot be missed and the
// validator can hold them:
//   - variant i leads with the i-th most_buyers angle, so no two variants share a lead;
//   - Emails 2 and 3 take two OTHER angles, and only from angles with no declared conflict
//     against a must_not_exclude buyer (rule 11);
//   - ONE variant's offer is the NEUTRAL line (offer_angle null), which the offer-line
//     selector needs: a researched opening that matches no tagged offer then gets a line
//     that names no problem, instead of a hash-picked line about the wrong one.
//
// WHICH VARIANT CARRIES THE NEUTRAL LINE (changed 2026-10-01). It used to be the last one,
// whatever its pain. The neutral line sells an outcome that answers EVERY lead pain, and it
// also sits under its own variant's pain for every template-tier prospect on that variant.
// Put under a pain whose natural answer is a different outcome, it is neutral and does not
// answer the pain above it, which is the pairing the operator's second note forbids, and
// the scope judge refused it on the live client (the same wording passed one read and
// failed the next: the question was genuinely undecidable).
//
// So the neutral line goes to the lead angle whose OWN first answer is an outcome that
// answers them all: there the line is the natural offer for its pain AND neutral for the
// rest. The first such angle in rank order; the last variant, as before, when none is.

export interface AnglePlan {
  email1: string
  email2: string
  email3: string
  /** True for the one variant whose offer is the neutral line (offer_angle null). */
  neutralOffer: boolean
}

/**
 * The position, among the lead angles in rank order, of the variant whose offer is the
 * neutral line. -1 for a client with one lead angle, which has no neutral line.
 */
export function neutralVariantIndex(brief: OutboundBrief): number {
  const lead = mostBuyersAngles(brief)
  if (lead.length < 2) return -1
  const neutral = neutralOutcomeIds(brief)
  const natural = lead.findIndex(a => neutral.includes((a.resolved_by ?? [])[0]))
  return natural >= 0 ? natural : lead.length - 1
}

export function planAngles(brief: OutboundBrief): Record<string, AnglePlan> {
  const keys = variantKeysFor(brief)
  const lead = mostBuyersAngles(brief).map(a => a.id)
  const usable = usableAngles(brief).map(a => a.id)
  const plan: Record<string, AnglePlan> = {}
  const usedOrders = new Set<string>()
  const neutralIndex = neutralVariantIndex(brief)
  keys.forEach((key, i) => {
    const email1 = lead[i]
    const others = usable.filter(id => id !== email1)
    if (others.length < 2) {
      throw new Error(`outbound-template-agent: variant ${key} needs two usable angles besides ${email1}; the brief has ${others.length}`)
    }
    // Every ordered pair of the other angles, rotated so variants start at different
    // points; the first order not already used wins.
    const pairs: Array<[string, string]> = []
    for (let a = 0; a < others.length; a++) {
      for (let b = 0; b < others.length; b++) {
        if (a !== b) pairs.push([others[(a + i) % others.length], others[(b + i) % others.length]])
      }
    }
    const pick = pairs.find(([e2, e3]) => !usedOrders.has(`${e2}>${e3}`)) ?? pairs[0]
    usedOrders.add(`${pick[0]}>${pick[1]}`)
    plan[key] = { email1, email2: pick[0], email3: pick[1], neutralOffer: i === neutralIndex }
  })
  return plan
}

// ─── The prompt ───────────────────────────────────────────────────────────────
//
// RULE ZERO. Nothing in this prompt names an industry, a market, a buyer type or a pain.
// Everything specific comes from the brief at run time. A test fails if market words
// appear in these strings.

/**
 * The words of the opener frame list that the no-word-twice rule counts, asked of the rule
 * itself rather than typed out (second fix round, 2026-10-02): a word counts when two
 * sentences made of it alone are refused. Today: site, website, page, homepage, shows. The
 * pain line opens straight under a frame for a firm-fact prospect, and the fixture itself
 * once said "leave the site" under "Your site says {does}.", which the check refuses.
 */
const COUNTED_FRAME_WORDS = [...FRAME_WORDS].filter(word => findConsecutiveRepeats([word, word]).length > 0)

export const OUTBOUND_TEMPLATE_SYSTEM_PROMPT = `You write cold email templates for one B2B sender.

Your ONLY source is the outbound brief you are given. It was confirmed by a person. Use nothing else, assume nothing else, and add no claim the brief does not support.

THE READER
English may not be their first language, and they may be dyslexic. So:
- Plain, literal words a person would say out loud. No idioms, no figures of speech, no coined phrases, no noun stacks.
- Every sentence 15 words or fewer, except the one offer sentence, which may run to 22. Reading grade 5 or below: prefer words of one or two syllables.
- Email 1 is graded TWICE: once as you wrote it, and once with the peer label and the customer group that code adds, which are often harder words than yours. So write Email 1's pain, offer and question in short common words, with room to spare.
- Every sentence is complete and grammatical. Two exceptions, because a person writes them: an opener frame may drop its "I", and the break-up email may open on a short friendly phrase.
- WRITE AS A PERSON WRITES AN EMAIL, not as a notice. Use a contraction wherever a person would: it's, that's, isn't, aren't, don't, can't, we're, you're. Never write the two words out ("it is", "is not", "we are", "do not"): code refuses them.
- One idea per paragraph: at most 2 sentences and 30 words.
- A question, and a call ask, is ALWAYS its own paragraph: one sentence, with nothing else in that paragraph.
- Never a list of three in one sentence ("A, B and C"). Split it into two sentences.
- No paragraph starts with "I".
- Use the brief's own nouns. Never swap a word the brief uses for a shorter one of your own to make a line easier.
- Never a word that points at somebody or something without saying who or what: never "someone else", "other people", "elsewhere", or "others" on its own. Name them: "other firms", "others in your field".
- A question is a full sentence that opens on its verb or its question word (Is, Are, Do, Does, Would, Could, What, How). Never a fragment with no verb, and never one that opens "How about", "What about" or "Why not". "Could" asks a PERSON: "Could we talk?" is right, and "Could a short call make sense?" is not. Of a thing, ask "Would": "Would a short call make sense?"
- EVERY LINE IS ENGLISH A CAREFUL NATIVE SPEAKER WOULD WRITE. The limits above are met by choosing a shorter sentence, never by bending a word: the adverb stays an adverb ("arrive steadily", never "come in steady"), the article stays in ("the wrong ones", never "wrong ones"), and a set phrase keeps its form ("No worries", never "No worry"). A second reader checks each line for this and the line fails if it reads wrong.

ACROSS THE FOUR EMAILS, which one reader gets in a row
- NO PHRASE MORE THAN TWICE. A phrase is two or three words in a row ("new clients", "the right buyers", "hard to plan"). It holds across the subject, Email 1 in either wording, and Emails 2, 3 and 4: code does the counting and reports any phrase used a third time, so vary your wording as you write and do not tally it. The third time, say it another way or leave it out. This bites hardest on the brief's own favourite nouns: use each of them, and do not lean on one.
- NO WORD IN TWO SENTENCES IN A ROW, inside one email. If a sentence says "hard to plan", the next says neither "plan" nor "harder". A paragraph break does not reset it: the last sentence of one paragraph and the first of the next are in a row. Two forms of a word are the same word ("grow" and "growth", "client" and "clients"). Small words (the, can, your, more) and "firm" do not count, and neither does a word of three letters. So the offer does not repeat the noun the consequence just used, and the question does not repeat the offer's. For some prospects the pain line sits directly under an opener frame, so its first sentence uses none of the frame's words (${COUNTED_FRAME_WORDS.join(', ')}), nor another form of one ("pages", "show").

WHAT CODE ADDS, SO YOU DO NOT WRITE IT
- The greeting line and the two sign-off lines. Never write a greeting, a name or a sign-off.
- In Email 1 for some prospects, an opener sentence built from one of your OPENER FRAMES and a clause about what the prospect does, taken from their own website.

SLOTS
Slots are placeholders code fills per prospect. Only these exist:
- {does}: a clause about what the prospect does, starting "you" plus a verb, up to 12 words. Opener frames only.
- {peer_group}: a plural label for the prospect's peer group, taken from the brief's peer_groups. Up to 4 words. It NAMES THE SOURCE of a pain, mid-sentence: "When we chat to {peer_group}, a lot of them tell us ...". It is used in the Email 1 pain line and in follow-up pain paragraphs, never in a subject, an offer or a question. It needs no slot_free form: code puts the brief's default label there when the prospect's group is unknown.
- {for_whom}: the prospect's OWN customers, as a plural category. Up to 5 words. The brief's slot_policy says whether the Email 1 offer uses it: when for_whom_in_offer is true the offer MUST use {for_whom}, and when false it must not.
  {for_whom} is who the PROSPECT sells to. For a prospect that ships goods for regional grocers, {for_whom} is "regional grocers". So "meetings with {for_whom}" and "new {for_whom}" are right: the grocers are the prospect's customers. "Clients for {for_whom}" is WRONG: it says the sender finds customers for the grocers. Read every slotted line with that example filled in before you keep it.
{for_whom} is used in the Email 1 offer and subject, never in the Email 1 pain or question. A follow-up paragraph may use it where it reads naturally, and only when for_whom_in_offer is true.
- {company}: the prospect's own firm, by the name it goes by. Up to 4 words. In Email 1 only in the lead-in, and in follow-up paragraphs. Write it as the subject or the object of a verb ("{company} can ...", "... for {company}"), never as a possessive.
Read every slotted line with a real group in the slot before you keep it. The group must read as plain English where it sits: after a word such as "with", "for" or "more of the right", or as the subject of a verb. Never straight after an adjective that does not describe it ("steady {for_whom}" reads "steady regional grocers") and never straight in front of a noun as a label ("{for_whom} meetings" reads "regional grocers meetings").
Every Email 1 line lists the slots it uses in "slots". A line or a follow-up paragraph using {for_whom} or {company} must also give "slot_free": the same sentence with no slot, for prospects where it is unknown (say it of "you" or "your firm"). One with neither sets "slot_free" to null. Each line and each follow-up paragraph is ONE paragraph: never put a line break inside it. A sentence holding {for_whom} or {company} leaves room for the fill, which can be 5 words. A follow-up paragraph holds at most ONE kind of slot.

OPENER FRAMES: write 2 or 3
Each is ONE sentence holding {does} exactly once and adding at most 3 other words. It says plainly that you can see what they do, or that their site says it, and NOTHING about it. The words a frame adds come from this list and no other: can, see, tell, your, site, website, page, homepage, says, shows, from, on, that, the. So a frame holds no word of approval, praise or interest, because a stranger does not get to judge the reader's firm, and it never opens on a bare verb, which reads as an order. It must read naturally when {does} is filled with a clause such as \"you design cold rooms for food wholesalers\" or \"you are a pension adviser\". It may drop its "I" by opening on "Can". Never start with "I". The frames differ from each other in their words, not only in their order. AT LEAST ONE FRAME NAMES NO SITE, PAGE OR WEBSITE ("Can see {does}."): for some prospects the clause is built from their company record and was never read on their site, and code gives those prospects only a frame that does not say where it was read.

HOW A PAIN IS WRITTEN, in Email 1 and in every follow-up
- State the SYMPTOM: what the reader feels. Each pain angle in the brief has a "symptom"; write that. Never state the diagnosis or the cause, and never say what peers failed to do or have not done: a reader rejects being told why they have the problem, even when it is true.
- NAME THE SOURCE, CONVERSATIONALLY. The first sentence of a pain says who told us, with {peer_group}, the way a person mentions conversations they have had. There are four forms: "When we chat to {peer_group}, a lot of them tell us ...", "Talking to {peer_group}, we often hear that ...", "In our chats with {peer_group}, many say ...", "From what {peer_group} tell us, ...". WITHIN ONE VARIANT, Email 1, Email 2 and Email 3 each open their source line in a DIFFERENT form: changing only the verb ("When we chat to" then "When we speak to") is the same form and is refused in code. Both Email 1 wordings must differ in form from Email 2 and from Email 3. NEVER A FACELESS SOURCE: never "Many firms", "Some firms", "Most firms", "A lot of firms" or "Firms like yours". Code refuses them. The source clause before the comma does not count toward the sentence's word cap.
- Never as a fact about the reader.
- A consequence is a POSSIBILITY. Use can, often, may or sometimes: write that a thing CAN happen or OFTEN happens, never that it happens. Every sentence of a pain either carries one of those words, or reports what other people say (they "tell us", they "say") and holds no "you" or "your".
- THE CONSEQUENCE IS THE BRIEF'S. Each pain angle has a "consequence" in the brief: what the symptom leads to, in the client's own judgement. The sentence after the symptom says THAT, using its key words, and never a vaguer effect ("it can be hard to plan"): code refuses a consequence that holds no word of its angle's outcome, symptom or consequence. Where the brief's consequence has two parts joined by a comma, the two wordings of an Email 1 pain say both between them: one wording may carry one part and the other the second, or one may carry both in a single sentence joined by ", and". Never a narrower effect than the angle's "outcome", and never anything in the brief's avoid_wording.
- THE CONSEQUENCE GENUINELY FOLLOWS FROM THE SYMPTOM: it is what that symptom leads to, never a second problem set beside it.
- THE CONSEQUENCE READS ON FROM THE SYMPTOM. In the pain of one email, every sentence after the first opens on a linking phrase that says how it follows: "As a result,", "So", "That means", "When that happens,", "Over time,". Never a new sentence that starts cold on "That", "It" or a noun: code refuses it. Two consequences may share that sentence, joined by ", and".
- No numbers, no durations, no absolutes (always, never, every, all, nobody, none).

HOW AN OFFER IS WRITTEN, in Email 1 and in Email 3
- ONE FLOWING SENTENCE: WHAT WE DO, THEN WHAT THE READER GETS. It opens "We" and says what the sender does in a few plain words, from a scope.does item that is not proof_only, worded as the sender's EXPERTISE: never as clerical or manual work the sender performs, and nothing in the brief's avoid_wording. Then a joining word (", so" or ", and"). Then the outcome for the reader: one of the brief's "outcomes", in the reader's terms. Up to 22 words. Never two sentences.
- THE OUTCOME IS THE POINT, AND THE SENTENCE ENDS ON IT. What we do is how the reader gets there. A feature of how the sender works (a report, a screen, a way of showing its work), and every proof point, is SUPPORTING PROOF: it never stands in for the outcome and is never the whole of an offer.
- THE OFFER ANSWERS THE PAIN JUST ABOVE IT. Each pain angle lists "resolved_by": the outcomes that answer it. The outcome in the offer placed under a pain is one of those, so a reader who agreed with the pain sees it dealt with in the next line. Never an offer that ignores the pain above it or pulls against it.
- Name at most TWO things we do, joined by "and", before the joining word. Never a list of three, never a mechanical step-by-step.
- PROOF POINTS: the brief names one lead_differentiator. It is the ONLY proof point that may appear anywhere in Email 1, and only in the offer, never in the subject, the pain or the question; if lead_differentiator is null, Email 1 holds no proof point. Every proof point, and every proof_only scope item, is used at most ONCE across a variant's four emails, the subject included.

EMAIL 1: subject, pain, offer, question, each written TWICE
- pain, offer and question each need a second wording in "alt": the same meaning, the same angle and the same slot rules, in different sentences. No sentence may appear in both wordings, in another line, or in another variant. Code rotates the two wordings between prospects.
- subject: under 40 characters when filled. Lower case. May use {for_whom} with a slot_free form. An "alt" is optional.
- pain: 1 or 2 sentences. The first names the source with {peer_group} ("When we chat to {peer_group}, a lot of them tell us ..."), then the symptom; the second is the consequence that follows from it.
- lead_in: ONE clause that leads into the offer and names the reader's firm, asking and never asserting: "If {company} is seeing this too,". It opens "If", holds {company}, ends on a comma, and is at most 8 words. Its slot_free form opens "If you" ("If you're seeing this too,"). Code joins it in front of the offer, whose "We" then reads "we". One wording; no alt. "from" lists the variant's Email 1 angle.
- question: ONE question asking whether THIS email's pain applies to the reader, in the reader's terms, answerable in a word, that makes sense on its own: no "that", "this" or "it" pointing at an earlier line. Never ask for a call, meeting, chat or time.
- offer_angle: the ONE problem the offer line answers, 10 words or fewer, taken from the brief's pain angle and written as a difficulty the reader could have. One variant, named in the angle plan, sets offer_angle to null instead: its offer is the NEUTRAL line. Code also places the neutral line under an opening written about one reader, on any subject. So the outcome it sells holds whatever the reader's situation is (the angle plan names which), it answers this variant's own pain, and it names no problem of its own.
- Length: the user message gives a LENGTH BUDGET for pain + lead_in + offer + question together. It holds in EVERY combination of wordings. Count each slot as one word. Count them.

FOLLOW-UPS (no subject, one wording). Each paragraph has a "kind": pain, offer, ask or close. The kinds of each email are FIXED, in this order, and code rejects any other:
- Email 2: the variant's Email 2 angle. Exactly two "pain" paragraphs, then optionally one "ask" paragraph. The first pain paragraph names its source with {peer_group}, as an Email 1 pain does. The second pain paragraph opens on a linking phrase. ONE paragraph names the reader's firm with {company}, and gives a slot_free form. 38 to 55 words of your own text.
- Email 3: the variant's Email 3 angle. Exactly one "pain" paragraph, then one "offer" paragraph in the offer shape above, whose outcome answers this email's pain and is said of the reader's firm by name (", so {company} can ..."), with a slot_free form that says it of "you" or "your firm". It cites a scope.does item that is not proof_only (a proof point may support it and never stands alone). Then ONE "ask" paragraph: a soft call ask, written as a full sentence. 30 to 45 words of your own text, and at least 5 words shorter than your Email 2.
- Email 4: the break-up. One or two "close" paragraphs and nothing else. It reads like a person easing off, not like a notice: warm, short, in contractions, and it may open on a short friendly phrase with no verb. It leaves the door open in plain words. Names Email 1's angle once. No question. Never explain why you wrote. Never say what anyone "should" do. 15 to 35 words of your own text.

THE BRIEF'S LIMITS ARE HARD
- Never state or imply anything in scope.never_claims.
- Never word a line so that a buyer in must_not_exclude would read it as "not for us".
- Proof points are proof. Never use one as the pain, and never lead an email with one.
- An outcome is said as something the reader CAN get, in the brief's sense and in your own plain sentence: "can", never "will". Two variants may sell the same outcome, and each says it in a different sentence. Never a number, a time, a guarantee or a promise, and nothing added to the outcome beyond what the brief says. If never_claims rules out results claims, this is still how an offer leads: the brief's outcome, as a possibility. What never_claims forbids is the promise, not the outcome.
- Never assert what the reader does, has, lacks, or how their time is spent. Never mention the reader's calendar, schedule or time, not even to say where a meeting lands.
- Never describe how busy anyone is or how their time or week goes, not even for peers. Say it as order or priority instead: what comes first, what waits.
- A follow-up pattern must not assume the reader has done something. Say what {peer_group} tell us, never imply "you".
- Never imply the reader already has the outcome an offer provides.
- A question asks about the email it ends: Email 2's ask is about Email 2's pain, Email 3's about Email 3's.
- WRITE IN THE CLIENT'S OWN VOICE: the brief's voice items come from their tone-of-voice document and apply, but the reader rules above win on any conflict. The brief's "colloquialisms" are plain everyday phrases this client says: use them where they fit. Never an obscure idiom or figure of speech.

CITATIONS
Every line and every follow-up paragraph lists in "from" the brief item ids it uses: its angle, the outcome an offer sells, the scope.does item an offer rests on, any proof point. Cite only ids that are in the brief you are given. The one exception: the NEUTRAL variant's offer names no problem, so its "from" lists no pain angle, and the only outcome it lists is one the angle plan names for it.

STYLE
No dashes of any kind. No ampersands. None of: leverage, robust, seamless, delve, furthermore, moreover, additionally. No internal jargon: ICP, funnel, value prop, go-to-market, buyer persona.
The variants must read differently from each other. Never reuse a sentence across variants.

OUTPUT
Write ONE honest attempt and stop. Code checks every rule above against what you return and tells you exactly what to fix, so do not check your own work in the answer, do not count out loud, and do not write a second version. The answer is ONLY a JSON object, starting with "{": no notes before it and nothing after it. In exactly this shape:
{
  "opener_frames": ["...{does}...", "...{does}..."],
  "variants": {
    "A": {
      "email1": {
        "subject":  { "text": "...", "slots": [], "slot_free": null, "from": ["..."], "alt": null },
        "pain":     { "text": "When we chat to {peer_group}, ...", "slots": ["peer_group"], "slot_free": null, "from": ["..."],
                      "alt": { "text": "... {peer_group} ...", "slots": ["peer_group"], "slot_free": null, "from": ["..."] } },
        "offer":    { "text": "...", "slots": [], "slot_free": null, "from": ["..."],
                      "alt": { "text": "...", "slots": [], "slot_free": null, "from": ["..."] } },
        "question": { "text": "...?", "slots": [], "slot_free": null, "from": ["..."],
                      "alt": { "text": "...?", "slots": [], "slot_free": null, "from": ["..."] } },
        "lead_in":  { "text": "If {company} ...,", "slots": ["company"], "slot_free": "If you ...,", "from": ["..."] },
        "offer_angle": "..." or null
      },
      "email2": [{ "kind": "pain", "text": "... {peer_group} ...", "slot_free": null, "from": ["..."] }, { "kind": "pain", "text": "... {company} ...", "slot_free": "...", "from": ["..."] }, { "kind": "ask", "text": "...?", "slot_free": null, "from": ["..."] }],
      "email3": [{ "kind": "pain", "text": "...", "slot_free": null, "from": ["..."] }, { "kind": "offer", "text": "We ..., so {company} can ...", "slot_free": "We ..., so your firm can ...", "from": ["..."] }, { "kind": "ask", "text": "...?", "slot_free": null, "from": ["..."] }],
      "email4": [{ "kind": "close", "text": "...", "slot_free": null, "from": ["..."] }]
    }
  }
}
Include only the variants you are asked for.`

/**
 * THE SEAM. The prompt's only client input is the brief. The signature is the control:
 * there is no parameter through which anything else could arrive.
 */
export function buildGenerationPrompt(
  brief: OutboundBrief,
  plan: Record<string, AnglePlan>,
  variantKeys: readonly string[],
  /** From email1WordBudget. Code arithmetic about lengths, never client content. */
  budget?: { min: number; max: number },
  /**
   * For a call that writes fewer than all the variants: the Email 1 lines the OTHER
   * variants already hold, which this one may not repeat, and whether the opener frames
   * are already written.
   */
  context?: { alreadyWritten?: Record<string, RawVariant>; framesWritten?: boolean },
): string {
  // The angles are shown as SYMPTOMS (rule 5). `statement` may hold a diagnosis for the
  // record, and a model shown a diagnosis writes it; so it is not shown.
  //
  // ONLY THE USABLE ANGLES ARE SHOWN (rule 11). An angle that conflicts with an in-scope
  // buyer is not merely left out of the plan: a model that can read it can write it into
  // another angle's paragraph. The first version sent every angle with conflicts_with
  // stripped, so the model was shown the angle and not told it was off limits.
  const briefForModel = {
    pain_angles: usableAngles(brief).map(a => ({
      id: a.id, rank: a.rank, outcome: a.outcome, symptom: a.symptom, consequence: a.consequence, reach: a.reach,
      resolved_by: a.resolved_by,
    })),
    // What an offer sells. competitor_categories is deliberately NOT here: it decides who is
    // researched, and has nothing to say about what an email may claim.
    outcomes: brief.outcomes.map(o => ({ id: o.id, statement: o.statement })),
    proof_points: brief.proof_points,
    lead_differentiator: brief.lead_differentiator,
    scope: brief.scope,
    must_not_exclude: brief.must_not_exclude,
    avoid_wording: brief.avoid_wording,
    peer_groups: brief.peer_groups.map(p => ({ id: p.id, label: p.label })),
    peer_group_default: brief.peer_group_default.label,
    third_parties: brief.third_parties,
    voice: brief.voice,
    colloquialisms: brief.colloquialisms ?? [],
    slot_policy: { for_whom_in_offer: brief.slot_policy?.for_whom_in_offer ?? false },
  }
  const planLines = variantKeys.map(k => {
    const p = plan[k]
    const offer = p.neutralOffer
      ? `Its offer is the NEUTRAL line: offer_angle null. It leads with an outcome that answers every lead pain (${mostBuyersAngles(brief).map(a => a.id).join(', ')}) and cites no other outcome: ${neutralOutcomeIds(brief).join(' or ')}.`
      : `Its offer_angle is the problem from ${p.email1} that its offer answers.`
    return `- Variant ${k}: Email 1 angle ${p.email1}, Email 2 angle ${p.email2}, Email 3 angle ${p.email3}, Email 4 names ${p.email1}. ${offer}`
  })
  return [
    '## THE OUTBOUND BRIEF',
    JSON.stringify(briefForModel, null, 2),
    '',
    '## ANGLE PLAN (fixed, follow it exactly)',
    ...planLines,
    '',
    ...(budget ? [
      '## LENGTH BUDGET',
      `Email 1: pain + lead_in + offer + question together are ${budget.min} to ${budget.max} words, counting each slot as one word, in every combination of wordings.`,
      '',
    ] : []),
    ...alreadyWrittenBlock(context?.alreadyWritten ?? {}),
    variantKeys.length === 0
      ? 'Write the opener frames only: return "variants": {}.'
      : context?.framesWritten
        ? `Write variant${variantKeys.length === 1 ? '' : 's'} ${variantKeys.join(', ')} only. The opener frames are already written: return "opener_frames": [].`
        : `Write opener frames and variants ${variantKeys.join(', ')}.`,
  ].join('\n')
}

/**
 * The sentences another variant already uses in Email 1, for a call that writes one variant
 * at a time. Code refuses a sentence or a subject that appears in two variants, so a
 * variant written without seeing the others fails on a collision it could not have known.
 */
function alreadyWrittenBlock(written: Record<string, RawVariant>): string[] {
  const rows = Object.entries(written).flatMap(([key, v]) => {
    const e1 = v.email1
    if (!e1) return []
    const texts = (['subject', 'pain', 'offer', 'question'] as const)
      .flatMap(name => [e1[name]?.text, e1[name]?.alt?.text])
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    return texts.length > 0 ? [`- Variant ${key}: ${texts.map(t => JSON.stringify(t)).join(' ')}`] : []
  })
  return rows.length > 0
    ? ['## ALREADY WRITTEN IN OTHER VARIANTS (use none of these sentences or subjects again)', ...rows, '']
    : []
}

/**
 * How many words of its own Email 1 may hold, for THIS client.
 *
 * The prompt used to say "40 to 55" for everyone. The real ceiling is the firm-fact Email 1
 * (75 words) less everything code adds: the greeting, the opener at its longest, the
 * sign-off, and the words a slot grows by when it is filled (a label of several words, a
 * five-word customer group). For a client whose offer uses {for_whom} the top of the stated
 * range could never pass, and each miss cost a repair call. The floor is the slot-free
 * Email 1's minimum, with two words of margin for a slot_free form shorter than its line.
 *
 * A test holds this arithmetic against the validator: a variant at the maximum passes the
 * word band and one word more does not.
 */
export function email1WordBudget(brief: OutboundBrief, signoff: SenderSignoff): { min: number; max: number } {
  const wordsOf = (text: string) => text.trim().split(/\s+/).filter(Boolean).length
  const signoffWords = wordsOf(signoff.firstName) + wordsOf(signoff.companyName)
  const defaultLabel = wordsOf(brief.peer_group_default.label)
  const longestLabel = Math.max(defaultLabel, ...brief.peer_groups.map(p => wordsOf(p.label)))
  const forWhomGrowth = brief.slot_policy?.for_whom_in_offer ? FOR_WHOM_MAX_WORDS - 1 : 0
  const opener = TEMPLATE_MAX_SENTENCE_WORDS   // {does} at its longest plus the frame's own words
  // The lead-in (2026-10-03) is joined in front of the offer and is counted in the budget
  // with the lines. Nothing more comes off for {company}: the template is checked with the
  // lead-in's slot-free form, and composition names it only when the named email still fits
  // its band (decideEmail1LeadIn, named_body_over_band), so a long name costs nothing here.
  const leadIn = 0
  const max = FACT_EMAIL1_WORD_LIMITS.maxWords - 1 - opener - signoffWords - (longestLabel - 1) - forWhomGrowth - leadIn
  const min = EMAIL_WORD_LIMITS.email1MinWords - 1 - signoffWords - (defaultLabel - 1) + 2
  if (min > max) {
    throw new Error(`outbound-template-agent: no Email 1 length fits this client (needs ${min} to ${max} words); shorten the peer labels or the sign-off`)
  }
  return { min, max }
}

function buildRepairPrompt(
  brief: OutboundBrief,
  plan: Record<string, AnglePlan>,
  failing: Record<string, { attempt: unknown; violations: string[] }>,
  frameViolations: string[],
  previousFrames: readonly string[],
  budget?: { min: number; max: number },
  /** The other variants' Email 1 lines, which the rewrite may not repeat. */
  alreadyWritten: Record<string, RawVariant> = {},
): string {
  const parts = [
    buildGenerationPrompt(brief, plan, Object.keys(failing), budget, { alreadyWritten, framesWritten: frameViolations.length === 0 }),
    '', '## YOUR PREVIOUS ATTEMPT FAILED THESE CHECKS',
  ]
  if (frameViolations.length > 0) {
    parts.push('Opener frames:', JSON.stringify(previousFrames), ...frameViolations.map(v => `- ${v}`))
  }
  for (const [key, { attempt, violations }] of Object.entries(failing)) {
    parts.push(`Variant ${key}, previous attempt:`, JSON.stringify(attempt), 'Failed:', ...violations.map(v => `- ${v}`))
  }
  parts.push('', 'Rewrite ONLY what failed. Return the same JSON shape with opener_frames and the listed variants. A line or an email you leave out of a variant is kept exactly as it was; every paragraph you do return is an object with "kind", "text", "slot_free" and "from". NO WORKING IN THE ANSWER: no word counts, no syllable counts, no checks, no second version. Code counts and checks, and tells you what is still wrong. Your answer starts with { and holds the JSON and nothing else.')
  return parts.join('\n')
}

// ─── Parsing the model's answer into VariantLines ─────────────────────────────

interface RawWording { text?: unknown; slots?: unknown; slot_free?: unknown; from?: unknown }
interface RawLine extends RawWording { alt?: RawWording | null }
interface RawParagraph { kind?: unknown; text?: unknown; slot_free?: unknown; from?: unknown }
export interface RawVariant {
  email1?: { subject?: RawLine; pain?: RawLine; offer?: RawLine; question?: RawLine; lead_in?: RawLine; offer_angle?: unknown }
  email2?: unknown
  email3?: unknown
  email4?: unknown
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** A line is one paragraph: a line break the model put inside one becomes a space. */
const oneParagraph = (text: string) => text.replace(/\s*\n+\s*/g, ' ').trim()

function toWording(raw: RawWording | null | undefined): TemplateWording {
  const text = typeof raw?.text === 'string' ? oneParagraph(scrubAITells(raw.text)) : ''
  // A slot_free form is kept only where one is needed. A model that fills it in on a line
  // with no {for_whom} has written a second version of that line, and the second version is
  // the one the stored body would ship while the rules read the first.
  const needsSlotFree = slotsIn(text).some(slot => slot === 'for_whom' || slot === 'does' || slot === 'company')
  return {
    text,
    slots: strings(raw?.slots).filter((s): s is (typeof SLOTS)[number] => (SLOTS as readonly string[]).includes(s)),
    slot_free: needsSlotFree && typeof raw?.slot_free === 'string' && raw.slot_free.trim() ? oneParagraph(scrubAITells(raw.slot_free)) : null,
    from: strings(raw?.from),
  }
}

function toLine(raw: RawLine | undefined): TemplateLine {
  const hasAlt = raw?.alt && typeof raw.alt === 'object' && typeof raw.alt.text === 'string' && raw.alt.text.trim()
  return { ...toWording(raw), ...(hasAlt ? { alt: toWording(raw!.alt) } : {}) }
}

const KINDS: readonly ParagraphKind[] = ['pain', 'offer', 'ask', 'close']

export function toVariantLines(raw: RawVariant, plan: AnglePlan, briefVersion: number): VariantLines {
  // A paragraph with no usable kind keeps kind undefined, and the validator says so: the
  // model's omission is reported, never guessed at.
  const paragraphs = (v: unknown): TemplateLine[] =>
    (Array.isArray(v) ? v : [])
      .filter((p): p is RawParagraph => !!p && typeof p === 'object' && typeof (p as RawParagraph).text === 'string' && ((p as RawParagraph).text as string).trim().length > 0)
      .map(p => {
        // A follow-up paragraph's slots are read from its text: the model is not asked to
        // list them, and a list it got wrong would be one more thing to repair.
        const wording = toWording({ text: p.text, slot_free: p.slot_free, from: p.from })
        return {
          ...wording,
          slots: slotsIn(wording.text),
          ...(KINDS.includes(p.kind as ParagraphKind) ? { kind: p.kind as ParagraphKind } : {}),
        }
      })
  const followups: FollowupLines[] = [
    { position: 2, angle: plan.email2, paragraphs: paragraphs(raw.email2) },
    { position: 3, angle: plan.email3, paragraphs: paragraphs(raw.email3) },
    { position: 4, angle: plan.email1, paragraphs: paragraphs(raw.email4) },
  ]
  return {
    brief_version: briefVersion,
    email1: {
      angle: plan.email1,
      subject: toLine(raw.email1?.subject),
      pain: toLine(raw.email1?.pain),
      offer: toLine(raw.email1?.offer),
      question: toLine(raw.email1?.question),
      ...(raw.email1?.lead_in ? { lead_in: (({ alt: _alt, ...rest }) => rest)(toLine(raw.email1.lead_in)) } : {}),
      // The plan decides which variant is neutral; the model only writes the tag text.
      offer_angle: plan.neutralOffer
        ? null
        : typeof raw.email1?.offer_angle === 'string' && raw.email1.offer_angle.trim()
          ? scrubAITells(raw.email1.offer_angle.trim())
          : '',
    },
    followups,
  }
}

/**
 * A repair answer laid over the previous attempt. The repair prompt says "rewrite ONLY what
 * failed", and a model that obeys returns one line. Taken as the whole variant, that answer
 * wiped every line that had passed, and the next round was shown the fragment as its
 * "previous attempt". So: a line or an email the answer leaves out, or returns in a shape
 * that holds no usable text, keeps its previous wording.
 */
export function mergeRepair(prev: RawVariant, next: RawVariant): RawVariant {
  const usable = (w: unknown): w is RawWording =>
    !!w && typeof w === 'object' && typeof (w as RawWording).text === 'string' && ((w as RawWording).text as string).trim() !== ''
  const usableParagraphs = (v: unknown): boolean =>
    Array.isArray(v) && v.some(p => !!p && typeof p === 'object' && typeof (p as RawParagraph).text === 'string' && ((p as RawParagraph).text as string).trim() !== '')
  // PER WORDING, not per line. A line holds two wordings, and a repair is usually for one
  // of them. Merged per line, an answer that returned only the alternate was thrown away
  // whole, and one that returned only the first wording dropped an alternate that had
  // passed. Each wording is taken from the answer when it is usable there, else kept.
  const line = (key: 'subject' | 'pain' | 'offer' | 'question'): RawLine | undefined => {
    const before = prev.email1?.[key]
    const after = next.email1?.[key]
    const main = usable(after) ? after : before
    if (!main) return undefined
    const alt = usable(after?.alt) ? after!.alt : before?.alt ?? null
    return { text: main.text, slots: main.slots, slot_free: main.slot_free, from: main.from, alt }
  }
  return {
    email1: {
      subject: line('subject'), pain: line('pain'), offer: line('offer'), question: line('question'),
      lead_in: usable(next.email1?.lead_in) ? next.email1!.lead_in : prev.email1?.lead_in,
      offer_angle: next.email1 && 'offer_angle' in next.email1 ? next.email1.offer_angle : prev.email1?.offer_angle,
    },
    email2: usableParagraphs(next.email2) ? next.email2 : prev.email2,
    email3: usableParagraphs(next.email3) ? next.email3 : prev.email3,
    email4: usableParagraphs(next.email4) ? next.email4 : prev.email4,
  }
}

/** A stored variant, back in the shape the model writes, for a repair prompt. */
export function linesToRaw(v: VariantLines): RawVariant {
  const f = (pos: number) => v.followups.find(x => x.position === pos)?.paragraphs.map(p => ({ kind: p.kind, text: p.text, slot_free: p.slot_free, from: p.from }))
  const line = (l: TemplateLine): RawLine => ({ text: l.text, slots: l.slots, slot_free: l.slot_free, from: l.from, alt: l.alt ?? null })
  return {
    email1: {
      subject: line(v.email1.subject), pain: line(v.email1.pain), offer: line(v.email1.offer), question: line(v.email1.question),
      ...(v.email1.lead_in ? { lead_in: line(v.email1.lead_in) } : {}),
      offer_angle: v.email1.offer_angle,
    },
    email2: f(2),
    email3: f(3),
    email4: f(4),
  }
}

export function parseModelJson(text: string): { opener_frames?: unknown; variants?: Record<string, RawVariant> } {
  // The copy itself contains braces ({does}, {peer_group}), so "the first {" is not the
  // start of the object. Prefer a fenced block; otherwise the first brace that opens a
  // quoted key.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  const start = body.search(/\{\s*"/)
  const end = body.lastIndexOf('}')
  // A SyntaxError, like every other unparseable answer: the callers that keep the previous
  // wording on a bad answer catch that type, and an answer with no JSON in it at all is the
  // plainest bad answer there is. As a plain Error it escaped them.
  if (start < 0 || end <= start) throw new SyntaxError('outbound-template-agent: model returned no JSON object')
  return JSON.parse(body.slice(start, end + 1))
}

// ─── The scope judge ─────────────────────────────────────────────────────────

export const SCOPE_JUDGE_SYSTEM_PROMPT = `You check cold email lines against what the sender is allowed to claim.

You get the sender's scope (what it does), its proof points, what it never claims, buyers the wording must not exclude, the pain angles, and the outcomes it sells. Then numbered lines. Each line is tagged with its kind, a pain or close line with its angle, and an offer line with the pain stated just above it and the outcome it sells: [pain PA1], [offer; the pain stated above it: "..."; the outcome it sells: O1 "..."], [ask], [close PA1], [subject]. After the tag, in round brackets, is the line's place in its sequence: (email1.offer) is the offer of Email 1, and (email2.p3) is the third paragraph of Email 2, read straight after (email2.p2). "[their customers]" inside a line stands for the reader's own customers, and "[the reader's firm]" for the name of the reader's own company; both are filled in per reader.

For EACH line, list every claim the line makes about the SENDER or the SENDER'S SERVICE, and for each claim say:
- covered_by: the id of the scope.does or proof_points item that supports it, or null if nothing supports it. When a claim is a proof point's claim, give the proof point's id, not the scope item's. On an [offer] line, the part that only says the outcome named in the line's tag, as something the reader or the reader's firm can get, is covered by that outcome: give the outcome's id.
- violates: the id of a never_claims item it states or implies, or null. An outcome from OUTCOMES said as a possibility ("you can ...", "your firm can ..."), with no number, no time and no promise added, does not by itself state or imply a never_claims item. The same outcome said as a certainty or with a figure does.
- manual_task: true if the claim describes clerical or manual work the sender performs, rather than an outcome for the reader or the sender's expertise. False when that work is itself what a scope.does item says the sender sells. Otherwise false.
Also for each line say:
- proof_used: the ids of every proof point, and of every scope.does item marked proof_only, that the line states, restates or alludes to, whether or not the line makes a claim. A question or a subject can use a proof point. An empty list when it uses none.
- excludes: the id of a must_not_exclude buyer the line would make feel "this is not for us", or null.
- idiom: the idiom, figure of speech or coined phrase in the line, quoted exactly, or null. The readers may not have English as a first language. Flag ONLY a phrase whose meaning a careful reader could not work out from the ordinary meaning of its words, such as a thing "taking a back seat", work that "dries up", or a week that "feels lumpy". Do NOT flag an everyday verb in its usual business sense (growth stalls, sales slow down, work picks up, a deal falls through), a common phrasal verb, or a polite set phrase. When unsure, null.

- ambiguous: a word or phrase that points at a PERSON, a GROUP or a THING without saying which one, where a careful reader could take it to mean two DIFFERENT people, groups or things, quoted exactly, or null. Example: "it can go to someone else" could mean a rival company or a colleague. These are NOT ambiguous, so null: a general statement with one plain meaning, however loose ("new work can slow down", "growth can slow"); a noun the line itself has just named; "you", "your firm" and "we", which are the reader and the sender; and a word such as "that" or "this" which plainly points at the line just before it IN THE SAME EMAIL (the lines are numbered in order, and "email2.p3" follows "email2.p2"), as in a question asking whether the problem just described applies. When unsure, null.
- unnatural: a word or short phrase in the line that a careful native speaker of English would not write, quoted exactly as it stands in the line, or null. Flag ONLY what is WRONG as English: a describing word where an adverb belongs ("the orders come in steady"); a missing "a" or "the" ("chasing wrong ones"); a set phrase bent out of its form ("No worry" for "No worries"); a describing word put on the wrong thing ("new customers can stay steady": it is the flow that is steady, not the customers). Do NOT flag plain, short, informal or contracted English; a break-up line that opens on a friendly phrase; a figure of speech (that is "idiom"); a loose or general statement; a placeholder in square brackets; or wording you would only have chosen differently. This is about correctness, never taste. When unsure, null.
- fragment: true if any sentence in the line is not a full sentence with its own subject and verb: a question with no verb, a clipped remark. A short but complete sentence is false. A [subject] line is always false. A [close] line is always false: a break-up may open on a short friendly phrase with no verb, as a person writes one.
- slot_reads: for a line holding "[their customers]" only. Put an ordinary plural group of customers in its place, such as "regional grocers", and read the line again. true if it reads as plain English and the group is still the reader's customers. false if the group lands straight after an adjective that does not describe it ("steady regional grocers"), or straight in front of a noun as a label ("regional grocers meetings"). A line with no "[their customers]" is true.

Statements about peers or patterns ("people in your field often tell us...") and questions are not sender claims; list no claims for them, but still give proof_used and excludes.

For each [offer] line also say (its tag gives the pain stated just above it, and the outcome it sells):
- sells_outcome: an offer is one sentence that says what the sender does and then what the reader gets. true if the line says what the reader (or the reader's firm) gets for their own business, and what it says is the outcome named in the line's tag. False if the line says only how the sender works, or what it ends on is a feature the sender has or something the reader can look at or check. False if it sells a different outcome from the one in its tag. When the tag names no outcome, true only if what the reader gets matches one of OUTCOMES.
- resolves_pain: true if what the line offers answers the pain given in its tag. False if the line ignores that pain or pulls against it.
For every other kind, sells_outcome and resolves_pain are true.

A line EXCLUDES a buyer only if it states or presumes something about THE READER that is false for that buyer, so that buyer would think "this is not for us". A pattern that some peers describe ("some firms tell us they tried X") does not exclude a reader for whom it is not true: it is about other people. A question asking whether something applies does not exclude either.

For each [pain] line and each [close] line also say:
- asserts_about_reader: true if the line states, as a fact, something about THE READER's own business, situation or problem. A statement about other people, a possibility (can, often, may, might), a condition (if, when) and a question are all false.
- self_diagnosis: true if the line tells people WHY they have the problem by naming something they did wrong, failed to do or have not understood: a verdict a reader would push back on. "They never agreed delivery dates with the carrier" is a diagnosis. A symptom is not: "their orders arrive late". A circumstance a reader would readily agree with is not one either, even though it explains the symptom: "orders arrive late when the port is full". When the angle's own "symptom" in PAIN ANGLES names a circumstance, a line that says the same thing is false. Otherwise false.
- narrow_consequence: true only if the consequence the line names is a DIFFERENT and smaller matter than the "outcome" given for that line's angle in PAIN ANGLES: a side effect in one corner of the business, such as staffing or admin, where the outcome is about growth or revenue. A consequence that restates the outcome, or follows directly from it, in other words is false. A line that names no consequence is false.
- consequence_follows: true if each consequence the line names is what its symptom leads to, in the line's own words. False if the consequence is a second, separate problem set beside the symptom. A line that names no consequence is true.
For every other kind, asserts_about_reader, self_diagnosis and narrow_consequence are false, and consequence_follows is true.

For each [offer] line also say asserts_about_reader, as above, and true as well if the line implies the reader ALREADY HAS what the offer provides. A condition ("If [the reader's firm] is seeing this too,") is not an assertion.

For each [ask] line whose tag gives the pain stated above it also say:
- question_matches: true if the question asks whether that pain, or what it leads to, applies to the reader. False if it asks about something else. For any other line, true.

Give EVERY field for EVERY line. Return ONLY JSON: {"lines":[{"n":1,"claims":[{"claim":"...","covered_by":"D1","violates":null,"manual_task":false}],"proof_used":[],"excludes":null,"idiom":null,"ambiguous":null,"unnatural":null,"fragment":false,"slot_reads":true,"sells_outcome":true,"resolves_pain":true,"asserts_about_reader":false,"self_diagnosis":false,"narrow_consequence":false,"consequence_follows":true,"question_matches":true}]}`

/**
 * Words that point at something without naming it. Plain English, a closed class, no
 * market's wording. An answer from the judge made only of these is never excused by the
 * brief holding the same word.
 */
const POINTING_WORDS = new Set([
  'it', 'its', 'they', 'them', 'their', 'theirs', 'this', 'that', 'these', 'those', 'one', 'ones',
  'we', 'us', 'our', 'he', 'she', 'him', 'her', 'his', 'hers', 'you', 'your',
  'here', 'there', 'some', 'any', 'other', 'others', 'such', 'same', 'thing', 'things', 'so',
])

/** Words that point at an unnamed person, group, thing or place. */
const INDEFINITE_WORDS = new Set([
  'someone', 'somebody', 'anyone', 'anybody', 'everyone', 'everybody', 'nobody', 'something', 'anything',
  'everything', 'nothing', 'somewhere', 'anywhere', 'elsewhere', 'else',
])

/** Does a phrase the judge quoted hold a word that points? "you", "your" and "we" do not count: the judge is told they are the reader and the sender. */
function holdsPointingWord(phrase: string): boolean {
  const NOT_POINTING = new Set(['you', 'your', 'we', 'us', 'our', 'so'])
  // Split on anything that is not a letter: a curly apostrophe then separates "it" from
  // "s" in "it’s", which is what is wanted here.
  return phrase.toLowerCase().split(/[^a-z]+/).filter(Boolean)
    .some(word => (POINTING_WORDS.has(word) && !NOT_POINTING.has(word)) || INDEFINITE_WORDS.has(word))
}

/** Small words that join or qualify and name nothing. With POINTING_WORDS: see briefSays. */
const JOINING_WORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'in', 'on', 'at', 'with', 'by', 'from', 'and', 'or', 'but', 'not', 'no',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'can', 'could', 'may', 'might', 'will', 'would', 'should',
  'has', 'have', 'had', "it's", "that's", "isn't", "can't", 'as', 'if', 'when', 'than', 'then', 'too', 'also', 'just',
])

/** What the scope judge is shown in place of {for_whom}. One constant: the prompt names it, lineRefsFor writes it, and scopeHitsFromJudge looks for it. */
const FOR_WHOM_PLACEHOLDER = '[their customers]'
/** What the scope judge is shown in place of {company}. The prompt names it and lineRefsFor writes it. */
const COMPANY_PLACEHOLDER = "[the reader's firm]"

interface ScopeJudgeClaim { claim?: unknown; covered_by?: unknown; violates?: unknown; manual_task?: unknown }
interface ScopeJudgeLine {
  n?: unknown
  claims?: unknown
  proof_used?: unknown
  excludes?: unknown
  idiom?: unknown
  ambiguous?: unknown
  unnatural?: unknown
  fragment?: unknown
  slot_reads?: unknown
  sells_outcome?: unknown
  resolves_pain?: unknown
  asserts_about_reader?: unknown
  self_diagnosis?: unknown
  narrow_consequence?: unknown
  consequence_follows?: unknown
  question_matches?: unknown
}

export interface ScopeHit {
  variant: string
  line: string
  reason: string
}

export interface ScopeLineRef {
  variant: string
  /** e.g. "email1.offer", "email1.offer.alt", "email1.offer.slotted", "email3.p2". */
  line: string
  text: string
  kind: ParagraphKind | 'subject'
  /** The pain angle a pain or close line is about. */
  angle?: string
  /** An offer or an ask: the pain stated above it in the same email, as the reader sees it. */
  painAbove?: string
  /**
   * An offer line only: the outcomes it CITES, id and statement. The validator holds that
   * the cited outcome answers the pain; the judge is asked whether the line SAYS the
   * outcome it cites. Without this the two halves never met: a line could cite the right
   * outcome and lead with a different one, and each check passed.
   */
  outcomes?: Array<{ id: string; statement: string }>
}

export interface ScopeVerdict {
  hits: ScopeHit[]
  /**
   * "unnatural" quotes the judge gave that are not in the line it named. They fail nothing,
   * because code cannot hold a line to words it does not contain, and they are kept so the
   * run can say so: a judge that rewrote what it saw ("No worry" for "No worries") may have
   * seen a real fault.
   */
  unplaced: Array<{ variant: string; line: string; quote: string }>
}

/**
 * The line a wording belongs to: "email1.offer", "email1.offer.alt" and
 * "email1.offer.slotted" are ONE line in three renderings, and count as one use of a proof
 * point.
 */
const baseLine = (line: string) => line.replace(/\.slotted$/, '').replace(/\.alt$/, '')

/**
 * Code's verdict on the judge's answer. Pure, so it is testable without a model.
 *
 * AN UNANSWERED QUESTION IS NOT A PASS. The first version was strict about an unanswered
 * LINE and lenient about an unanswered QUESTION about a line: a verdict with no
 * self_diagnosis key, or with manual_task as the string "true", or with no claims list at
 * all, produced no hit, so rules 2, 5 and 6 failed open on a partial answer. Every field
 * code acts on must now be present and of its type, or the line is rejected for that.
 */
export function scopeHitsFromJudge(
  judgedRaw: unknown,
  lineRefs: ScopeLineRef[],
  brief: OutboundBrief,
): ScopeVerdict {
  const hits: ScopeHit[] = []
  const judged = (Array.isArray(judgedRaw) ? judgedRaw : []).filter((j): j is ScopeJudgeLine => !!j && typeof j === 'object')
  const validIds = new Set([...brief.scope.does.map(d => d.id), ...brief.proof_points.map(p => p.id)])
  const proof = proofIds(brief)
  // Every id the judge is SHOWN. An outcome id is printed in every offer's tag since
  // 2026-10-01, so a judge that names it under proof_used has named a real item that is
  // not proof: ignored, as a pain angle id is, and not reported as "not in the brief".
  const knownIds = new Set([...validIds, ...brief.pain_angles.map(a => a.id), ...brief.outcomes.map(o => o.id)])
  // Every sentence of the brief the generator is shown: wording a person confirmed.
  //
  // MATCHED ON WHOLE WORDS, sentence by sentence. The first version joined the brief into one
  // string and asked whether it INCLUDES the judge's phrase. The judge's usual answer for a
  // word that points at nobody is one short word, and "it" is inside "site", "one" inside
  // "done", "us" inside "business": the verdict was read and thrown away. A phrase is the
  // brief's own only when the brief holds those words, in that order, as words.
  // Curly apostrophes read as straight ones, and an apostrophe at the edge of a word (a
  // quotation mark) is dropped: the brief's "can't" and the judge's "can’t" are one word.
  const wordsOnly = (text: string) => ` ${text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9']+/g, ' ').replace(/(^|\s)'+|'+(?=\s|$)/g, '$1').trim()} `
  const briefSentences = [
    ...brief.pain_angles.flatMap(a => [a.outcome, a.symptom, a.consequence]),
    ...brief.outcomes.map(o => o.statement),
    ...brief.proof_points.flatMap(p => [p.claim, p.reader_outcome]),
    ...brief.scope.does.map(d => d.statement),
  ].filter((t): t is string => typeof t === 'string').flatMap(text => splitSentences(text)).map(wordsOnly)
  const briefSays = (phrase: string, options: { pointingWordsCount: boolean }) => {
    const wanted = wordsOnly(phrase)
    const words = wanted.trim().split(' ').filter(Boolean)
    if (words.length === 0) return false
    // A PHRASE THAT ONLY POINTS is never the brief's own wording, however often the brief
    // uses it: "that" is in every brief, and so are "it can" and "to them". Their being
    // there says nothing about whether THIS sentence says what it points at. So the phrase
    // must carry at least one word that is neither a pointing word nor a small joining
    // word. A content word is different: "growth" in a line is the brief's "growth", and a
    // repair cannot fix a fault that is in the source.
    if (!options.pointingWordsCount && words.every(w => POINTING_WORDS.has(w) || JOINING_WORDS.has(w))) return false
    return briefSentences.some(sentence => sentence.includes(wanted))
  }
  /**
   * The quote as the line has it, with the word before it and the word after it in the same
   * sentence. "new market grows" in "Exporters often say new market grows as planned" is
   * "say new market grows as", which no brief sentence holds.
   */
  const widened = (line: string, quote: string): string => {
    const wanted = wordsOnly(quote).trim()
    for (const sentence of splitSentences(line).map(wordsOnly)) {
      const at = sentence.indexOf(` ${wanted} `)
      if (at < 0) continue
      const before = sentence.slice(0, at).trim().split(' ').filter(Boolean).pop()
      const after = sentence.slice(at + wanted.length + 2).trim().split(' ').filter(Boolean)[0]
      return [before, wanted, after].filter(Boolean).join(' ')
    }
    return wanted
  }
  /**
   * The quote IS one of the brief's sentences, whole, with its full stop gone and a leading
   * linking word ("So", "As a result,") set aside: the short list below, of linkers a
   * whole clause follows. "So growth plans can slip." quoted as "growth plans
   * can slip" widens to "so growth plans can slip", which no brief sentence holds, although
   * it is the brief's consequence in the very shape the prompt requires.
   */
  // NOT every linker the validator accepts: only those a complete clause follows (merge
  // review, 2026-10-02). "Without growth plans can slip." and "When growth plans can slip,
  // buyers leave." are a brief sentence behind a word that breaks it, and the judge's flag
  // is the only net for those.
  const leadingLinker = /^(?:and so|so|as a result|that means|this means|which means|over time|in turn|because of that|from there|before long|after that|then)\b[\s,]*/i
  const isWholeBriefSentence = (quote: string): boolean => {
    const asQuoted = wordsOnly(quote)
    const unlinked = wordsOnly(quote.trim().replace(leadingLinker, ''))
    return briefSentences.some(sentence => sentence === asQuoted || sentence === unlinked)
  }
  // proof id -> variant -> the distinct lines that use it
  const proofUse = new Map<string, Map<string, Set<string>>>()
  const answered = new Set<number>()
  const unplaced: ScopeVerdict['unplaced'] = []

  for (const j of judged) {
    // The judge is asked for a number and sometimes returns the string "3". Either is the line.
    const n = Number(j.n)
    const ref = Number.isInteger(n) ? lineRefs[n - 1] : undefined
    if (!ref) continue
    answered.add(n)
    const hit = (reason: string) => hits.push({ variant: ref.variant, line: ref.line, reason })
    const used = new Set<string>()

    if (!Array.isArray(j.claims)) hit('the scope judge gave no list of claims for this line')
    for (const raw of Array.isArray(j.claims) ? j.claims : []) {
      const c = (raw && typeof raw === 'object' ? raw : {}) as ScopeJudgeClaim
      const claim = typeof c.claim === 'string' ? c.claim : ''
      const coveredBy = typeof c.covered_by === 'string' ? c.covered_by : null
      if (c.violates) hit(`states ${String(c.violates)}: "${claim}"`)
      // AN OFFER'S OUTCOME SENTENCE IS COVERED BY THE OUTCOME IT CITES. An offer must lead
      // with an outcome, and until 2026-10-01 only scope and proof ids were legal cover: a
      // judge that listed the outcome sentence as a claim had nothing legal to cover it
      // with, so whether a correct offer passed depended on the judge not counting its
      // first sentence. Only the outcomes THIS line cites, which the validator has already
      // held to the pain above it.
      const coveredByOwnOutcome = ref.kind === 'offer' && !!coveredBy && (ref.outcomes ?? []).some(o => o.id === coveredBy)
      if (!coveredBy || (!validIds.has(coveredBy) && !coveredByOwnOutcome)) hit(`claim beyond scope: "${claim}"`)
      // Rule 2: a differentiator is an outcome or expertise, never a manual task.
      if (typeof c.manual_task !== 'boolean') hit(`the scope judge did not say whether this claim is a manual task: "${claim}"`)
      else if (c.manual_task) hit(`worded as a manual task, not an outcome or expertise: "${claim}"`)
      if (coveredBy && proof.has(coveredBy)) used.add(coveredBy)
    }

    // Rule 4, by what the line USES, claim or not. A question and a subject make no claim,
    // so a proof point inside one was invisible when only claims were counted.
    if (!Array.isArray(j.proof_used)) hit('the scope judge did not say which proof points this line uses')
    for (const id of Array.isArray(j.proof_used) ? j.proof_used : []) {
      if (typeof id === 'string' && proof.has(id)) used.add(id)
      // An entry that is not an id of this brief at all (wrong type, wrong case, invented)
      // is an answer code cannot read, and an unreadable answer is not "uses no proof".
      else if (typeof id !== 'string' || !knownIds.has(id)) hit(`the scope judge named a proof point that is not in the brief: ${JSON.stringify(id)}`)
    }
    for (const id of used) {
      const line = baseLine(ref.line)
      if (ref.kind === 'pain') {
        hit(`proof ${id} is used as the pain; a proof point never fills a pain`)
      } else if (line.startsWith('email1.') && (line !== 'email1.offer' || !isLeadDifferentiator(brief, id))) {
        // ...only the lead differentiator, and only in the offer, may sit in Email 1...
        hit(line === 'email1.offer'
          ? `proof ${id} in an Email 1 offer is not the lead differentiator`
          : `proof ${id} is used in ${line}; in Email 1 a proof point sits in the offer only`)
      }
      const byVariant = proofUse.get(id) ?? new Map<string, Set<string>>()
      byVariant.set(ref.variant, (byVariant.get(ref.variant) ?? new Set<string>()).add(line))
      proofUse.set(id, byVariant)
    }

    if (ref.kind === 'pain' || ref.kind === 'close') {
      // Rule 5 and rule 6: judgements about a pain that no pattern can make. A break-up
      // names Email 1's pain once, so it is held to the same two questions.
      if (typeof j.self_diagnosis !== 'boolean' || typeof j.narrow_consequence !== 'boolean' || typeof j.asserts_about_reader !== 'boolean') {
        hit('the scope judge did not answer asserts_about_reader, self_diagnosis and narrow_consequence for this line')
      }
      // Rule 1, as a judgement. The validator reads the FORM of a pain sentence, and only in
      // paragraphs of kind pain. A break-up names Email 1's pain again in a "close"
      // paragraph, where no form rule can run (a sentence like "this is my last note" has
      // no possibility word and is not an assertion about anyone).
      if (j.asserts_about_reader === true) hit('states something about the reader as a fact; say it as a possibility or as what others report')
      if (j.self_diagnosis === true) hit('states a diagnosis the reader would reject, not the symptom they feel')
      if (j.narrow_consequence === true) hit('names a consequence narrower than the angle\'s outcome')
    }
    // THE CONSEQUENCE FOLLOWS FROM THE PAIN (operator, 2026-10-03): what the stated symptom
    // leads to, not a second problem set beside it.
    if (ref.kind === 'pain') {
      if (typeof j.consequence_follows !== 'boolean') hit('the scope judge did not say whether the consequence follows from the pain')
      else if (!j.consequence_follows) hit('the consequence does not follow from the pain before it; say what that symptom leads to')
    }
    // THE QUESTION MATCHES ITS EMAIL (operator, 2026-10-03).
    if (ref.kind === 'ask' && ref.painAbove) {
      if (typeof j.question_matches !== 'boolean') hit('the scope judge did not say whether the question matches its email')
      else if (!j.question_matches) hit(`the question does not ask about this email's pain: "${ref.painAbove}"`)
    }
    // NEVER IMPLY THE READER ALREADY HAS WHAT WE SELL, in an offer either (2026-10-03).
    if (ref.kind === 'offer' && j.asserts_about_reader === true) hit('states something about the reader as a fact, or implies they already have what the offer provides')

    // EVERY EXCLUSION COUNTS (operator rule 11: "re-run the scope judge clean"). Until
    // 2026-10-01 an exclusion on a line that did not say "you" was set aside and reported,
    // because the judge kept flagging peer-pattern lines about an angle that could not be
    // written without implying the reader. Those angles now declare conflicts_with and are
    // never planned, shown or cited, so the reason to set anything aside is gone, and a run
    // that passes is one where the judge raised no exclusion at all.
    if (j.excludes === undefined) hit('the scope judge did not say whether this line excludes a buyer')
    else if (j.excludes) hit(`excludes in-scope buyer ${String(j.excludes)}`)

    // THE READER RULE THE WORD LIST COULD NOT HOLD. "No idioms, no figures of speech" has
    // been in the generator's prompt since the reader rules were written, and the validator
    // held it with a list, which catches only the phrases somebody already wrote down. The
    // first run under the eleven rules shipped "takes a back seat", "feels lumpy" and "come
    // in bursts" past it. Whether a phrase means what its words say is a judgement.
    //
    // NEVER AGAINST THE BRIEF'S OWN WORDS. Measured on the first run with this check: the
    // judge flagged "Growth can stall", which is a consequence in the brief word for word.
    // A person confirmed that wording; a line that uses it is doing what it was told, and
    // no repair can fix a fault that is in the source.
    //
    // A PHRASE OR NULL, NOTHING ELSE. The judge is asked for the phrase quoted exactly, or
    // null. An answer of any other type (a list of phrases, true, an object) is a fault it
    // named in a shape code cannot read, and until 2026-10-01 it was read as "none": the
    // line passed as judged clean. An unreadable answer is an unanswered question.
    if (j.idiom !== null && typeof j.idiom !== 'string') hit('the scope judge did not say whether this line uses a figure of speech')
    else if (typeof j.idiom === 'string' && j.idiom.trim() && !briefSays(j.idiom, { pointingWordsCount: true })) {
      hit(`uses a figure of speech, say it literally: "${j.idiom.trim()}"`)
    }

    // No phrase that can be read two ways (second reading, note 3). The validator holds a
    // short list of words that point at nobody in particular; this is the judgement behind
    // it. The brief is refused for the listed words when it is validated, so the brief's
    // own wording is not held against a line here either, EXCEPT a word that only points
    // ("it", "them", "that"): see briefSays.
    //
    // AND THE QUOTE MUST HOLD A WORD THAT POINTS. The rule is about a word that points at
    // somebody or something without saying which. Told so, the judge still quoted phrases
    // with nothing pointing in them ("the flow", "who fits", "the wrong buyers") on run
    // after run, each one a paid repair round that traded it for another. A judgement is
    // kept, and code checks it is a judgement about the thing the rule is about.
    // A phrase or null, as for the figure of speech above.
    if (j.ambiguous !== null && typeof j.ambiguous !== 'string') hit('the scope judge did not say whether this line can be read two ways')
    else if (typeof j.ambiguous === 'string' && j.ambiguous.trim() && holdsPointingWord(j.ambiguous) && !briefSays(j.ambiguous, { pointingWordsCount: false })) {
      hit(`can be read two ways, say who or what is meant: "${j.ambiguous.trim()}"`)
    }

    // ENGLISH A NATIVE SPEAKER WOULD WRITE (operator note 6 on the fifth reading: "Reviewer
    // flags unnatural phrasing"). The reading-grade cap and the sentence cap are met most
    // cheaply by dropping a syllable or an article, and three such slips were in a document
    // that passed every other check: "come in steady", "chasing wrong ones", "No worry".
    // Code cannot read for that; a second reader can.
    //
    // A phrase or null, as for the two questions above. TWO FLOORS IN CODE, because this
    // judge quotes outside its rule when given the chance:
    //
    //   1. The phrase must stand in the line it was raised on, word for word. A quote that
    //      does not is not held against the line, and it is RETURNED (unplaced), so the run
    //      logs it and counts it: until 2026-10-02 it was dropped with no trace, and the
    //      line read as judged clean although the judge had named something in it.
    //
    //   2. The brief's own confirmed wording is not held against a line, because a repair
    //      cannot fix what is in the source. But ONLY AS THE LINE HAS IT, with the word
    //      either side, and NEVER FOR ONE WORD. Until 2026-10-02 a quote made of brief words
    //      in brief order was excused anywhere, so the operator's own example of the fault,
    //      "come in steady", was excused as "steady" by a brief that says "stay steady", and
    //      "say new market grows" by a brief that says "a new market grows".
    //      OR AS A WHOLE BRIEF SENTENCE (second fix round, 2026-10-02). Widened, the brief's
    //      own consequence picks up the linking word the prompt requires before it, or the
    //      "and" that joins a second one after it, and the brief holds neither: "As a result,
    //      sales abroad can stall." quoted as "sales abroad can stall" was refused, and each
    //      such refusal is a repair round spent on a sentence the writer was told to use.
    if (j.unnatural !== null && typeof j.unnatural !== 'string') hit('the scope judge did not say whether this line reads as natural English')
    else if (typeof j.unnatural === 'string' && j.unnatural.trim()) {
      const quote = j.unnatural.trim()
      if (!wordsOnly(ref.text).includes(wordsOnly(quote))) {
        unplaced.push({ variant: ref.variant, line: ref.line, quote })
      } else if (wordsOnly(quote).trim().split(' ').length === 1 || !(briefSays(widened(ref.text, quote), { pointingWordsCount: true }) || isWholeBriefSentence(quote))) {
        hit(`not how a native speaker would write it; keep the meaning and write it correctly: "${quote}"`)
      }
    }

    // Every sentence is a full sentence (second reading, note 10). The validator holds the
    // form of a question; a clipped remark that is not a question is a judgement.
    //
    // NOT ASKED OF A BREAK-UP (fourth reading, note 3). "Break-up emails read like a
    // person", and a person easing off opens on a phrase with no verb. Note 10 was about
    // asks, and this check had been widened from asks to every line: a close refused for a
    // friendly opening is the form-letter voice the note is against.
    if (ref.kind !== 'subject' && ref.kind !== 'close') {
      if (typeof j.fragment !== 'boolean') hit('the scope judge did not say whether this line holds a sentence fragment')
      else if (j.fragment) hit('holds a fragment; every sentence needs its own subject and verb')
    }

    // THE CUSTOMER GROUP READS AS ENGLISH WHERE IT SITS. Added 2026-10-01, from reading a
    // generated variant. The slot is filled per reader with a group of up to five words, and
    // every check on the slotted line ran with a placeholder that reads as nothing: the
    // judge had passed "steady [their customers]" as a subject and "book [their customers]
    // meetings" as an offer, which ship as "steady regional grocers" and "book regional
    // grocers meetings". A position rule in code was tried first and refused good lines
    // where the group is the subject of a verb ("the pages {for_whom} need to read"), so
    // this is a reading, asked of the judge with a real group in place.
    if (ref.text.includes(FOR_WHOM_PLACEHOLDER)) {
      if (typeof j.slot_reads !== 'boolean') hit('the scope judge did not say whether this line reads as English with a customer group in place')
      else if (!j.slot_reads) hit('with a customer group in place of {for_whom} the line does not read as plain English; put the group after a word such as "with", "for" or "more of the right", or reword the line')
    }

    // An offer sells an outcome and answers the pain above it (second reading, notes 1 and
    // 2). The validator holds what an offer CITES; these are what it SAYS.
    if (ref.kind === 'offer') {
      if (typeof j.sells_outcome !== 'boolean' || typeof j.resolves_pain !== 'boolean') {
        hit('the scope judge did not answer sells_outcome and resolves_pain for this offer')
      }
      if (j.sells_outcome === false) hit('says only how the sender works, or ends on a feature; after what we do, end on the outcome the reader gets')
      if (j.resolves_pain === false) hit(`does not answer the pain stated above it${ref.painAbove ? `: "${ref.painAbove}"` : ''}`)
    }
  }

  // ...and each proof point appears at most once in a sequence, by what the lines USE,
  // whatever their `from` lists say.
  for (const [id, byVariant] of proofUse) {
    for (const [variant, lines] of byVariant) {
      if (lines.size > 1) {
        hits.push({ variant, line: [...lines].sort().join(' + '), reason: `proof ${id} is used in ${lines.size} lines; a proof point appears once in a sequence` })
      }
    }
  }

  // A judge that answered about fewer lines than it was given has not judged the rest.
  lineRefs.forEach((ref, i) => {
    if (!answered.has(i + 1)) hits.push({ variant: ref.variant, line: ref.line, reason: 'the scope judge returned no verdict for this line' })
  })
  return { hits, unplaced }
}

// Opener frames are not judged: {does} is a statement about the PROSPECT, taken from their
// own site and checked for faithfulness per prospect, so a frame makes no sender claim.
//
// EVERY WORDING IS JUDGED, IN EVERY FORM A PROSPECT CAN RECEIVE. A line using {for_whom}
// exists twice: the slot_free form, and the slotted sentence a firm-fact prospect gets. The
// first version sent only the slot_free form, so for a client whose offer uses {for_whom}
// the sentence that ships to tier 2 was never judged for scope, proof or manual-task
// wording. Both forms now go, the slotted one with the customers shown as a placeholder.
export function lineRefsFor(variants: Record<string, VariantLines>, peerDefault: string, brief?: OutboundBrief): ScopeLineRef[] {
  const refs: ScopeLineRef[] = []
  const shown = (text: string) => text
    .replace(/\{peer_group\}/g, peerDefault)
    .replace(/\{for_whom\}/g, FOR_WHOM_PLACEHOLDER)
    .replace(/\{company\}/g, COMPANY_PLACEHOLDER)
  // The outcomes an offer cites, as the judge is shown them. Needs the brief; a caller that
  // only wants the lines' text (the repair loop's "what was judged") passes none.
  const outcomesOf = (from: readonly string[]) => {
    const cited = (brief?.outcomes ?? []).filter(o => from.includes(o.id)).map(o => ({ id: o.id, statement: o.statement }))
    return cited.length > 0 ? { outcomes: cited } : {}
  }
  // THE NEUTRAL OFFER IS JUDGED LIKE ANY OTHER, against the pain of its own variant. For a
  // day it was also judged against every OTHER lead pain, on the reasoning that the
  // selector can place it under any of them. That was wrong about where it goes: the
  // selector gives the neutral line to a RESEARCHED opening that matched no tagged offer,
  // and a researched opening replaces the pain paragraph altogether. So the line never
  // sits under another variant's pain. What it must be is free of any one problem, and that
  // is held in code by what it may cite: only an outcome that answers every lead angle
  // (neutral_offer_outcome). Asked to answer three pains at once, the judge refused a
  // sound neutral line on every round.
  for (const [key, v] of Object.entries(variants)) {
    for (const k of ['subject', 'pain', 'offer', 'question'] as const) {
      wordingsOf(v.email1[k]).forEach((wording, w) => {
        const line = `email1.${k}${w === 0 ? '' : '.alt'}`
        const common = {
          variant: key,
          kind: (k === 'subject' ? 'subject' : k === 'pain' ? 'pain' : k === 'offer' ? 'offer' : 'ask') as ScopeLineRef['kind'],
          ...(k === 'pain' ? { angle: v.email1.angle } : {}),
          // An offer is judged against the pain it sits under: either wording of it.
          ...(k === 'offer' || k === 'question' ? { painAbove: wordingsOf(v.email1.pain).map(pain => shown(pain.text)).join(' / ') } : {}),
          ...(k === 'offer' ? outcomesOf(wording.from) : {}),
        }
        if (wording.slot_free?.trim()) {
          refs.push({ ...common, line, text: wording.slot_free.trim() })
          if (slotsIn(wording.text).length > 0) refs.push({ ...common, line: `${line}.slotted`, text: shown(wording.text) })
        } else {
          refs.push({ ...common, line, text: shown(wording.text) })
        }
      })
    }
    for (const f of v.followups) {
      // A paragraph holding {company} or {for_whom} exists twice, like an Email 1 line: the
      // slot_free form and the slotted sentence. Both are judged. The pain an offer sits
      // under is shown as a prospect with nothing held reads it.
      const asRead = (q: TemplateLine) => (q.slot_free?.trim() ? q.slot_free.trim() : shown(q.text))
      f.paragraphs.forEach((p, i) => {
        const line = `email${f.position}.p${i + 1}`
        const common = {
          variant: key,
          kind: p.kind ?? 'close',
          ...(p.kind === 'pain' || p.kind === 'close' || !p.kind ? { angle: f.angle } : {}),
          ...(p.kind === 'offer'
            ? { painAbove: f.paragraphs.slice(0, i).filter(q => q.kind === 'pain').map(asRead).join(' '), ...outcomesOf(p.from) }
            : p.kind === 'ask'
              ? { painAbove: f.paragraphs.slice(0, i).filter(q => q.kind === 'pain').map(asRead).join(' ') }
              : {}),
        } as const
        if (p.slot_free?.trim()) {
          refs.push({ ...common, line, text: p.slot_free.trim() })
          if (slotsIn(p.text).length > 0) refs.push({ ...common, line: `${line}.slotted`, text: shown(p.text) })
        } else {
          refs.push({ ...common, line, text: shown(p.text) })
        }
      })
    }
  }
  return refs
}

/**
 * What the judge is told about one line. Exported because it is the only place the judge
 * learns which pain an offer sits under and which outcome it sells: delete either part and
 * sells_outcome and resolves_pain are asked with nothing to compare against, while a
 * fake judge that answers true keeps every test green.
 */
export function scopeLineTag(r: ScopeLineRef): string {
  return [
    `${r.kind}${r.angle ? ` ${r.angle}` : ''}`,
    ...(r.painAbove ? [`the pain stated above it: "${r.painAbove}"`] : []),
    ...(r.outcomes && r.outcomes.length > 0 ? [`the outcome it sells: ${r.outcomes.map(o => `${o.id} "${o.statement}"`).join(' or ')}`] : []),
  ].join('; ')
}

/** The judge answered, and the answer is not a list of lines. Nothing was judged. */
class JudgeUnusable extends Error {}

/** One scope-judge call over the given variants. Code decides the verdict. */
export async function runScopeJudge(
  client: Anthropic,
  brief: OutboundBrief,
  variants: Record<string, VariantLines>,
  usage: OutboundTemplateResult['usage'],
): Promise<ScopeVerdict> {
  const refs = lineRefsFor(variants, brief.peer_group_default.label, brief)
  const judgeUser = [
    '## SCOPE', JSON.stringify({ does: brief.scope.does, proof_points: brief.proof_points.map(p => ({ id: p.id, claim: p.claim })) }),
    '## NEVER CLAIMS', JSON.stringify(brief.scope.never_claims.map(n => ({ id: n.id, statement: n.statement }))),
    '## MUST NOT EXCLUDE', JSON.stringify(brief.must_not_exclude.map(x => ({ id: x.id, statement: x.statement }))),
    // Usable angles only, as in the generation prompt (rule 11).
    '## PAIN ANGLES', JSON.stringify(usableAngles(brief).map(a => ({ id: a.id, outcome: a.outcome, symptom: a.symptom }))),
    '## OUTCOMES', JSON.stringify(brief.outcomes.map(o => ({ id: o.id, statement: o.statement }))),
    // The line's own name travels with it ("email2.p3"), so the judge can see which lines
    // belong to one email and in what order: a "that" pointing at the paragraph before it
    // has one reading, and without the names every line looked like it stood alone.
    '## LINES', ...refs.map((r, i) => `${i + 1}. [${scopeLineTag(r)}] (${r.line}) ${r.text}`),
  ].join('\n')
  const answer = parseModelJson(await callModel(
    // Temperature 0: a verdict should not change between two reads of the same line.
    client, OUTBOUND_SCOPE_JUDGE_MODEL, SCOPE_JUDGE_SYSTEM_PROMPT, judgeUser, JUDGE_MAX_TOKENS, usage, 0,
  )) as unknown as { lines?: unknown }
  if (!Array.isArray(answer.lines)) throw new JudgeUnusable('outbound-template-agent: the scope judge returned no list of lines')
  return scopeHitsFromJudge(answer.lines, refs, brief)
}

// ─── The peer label judge (rule 7) ───────────────────────────────────────────

// MEASURED 2026-10-01 on the live judge, with a must-fail and a must-pass label. The first
// wording of this prompt failed the label the operator had named as CORRECT: told only that
// "a label is wrong when it names a narrower group", the judge read a plain plural for the
// trade as "individual practitioners, not firms" and excluded every firm with a sales role.
// It was never told the reader is a PERSON at the buyer, or that the fault is a label that
// ADDS something false. Both are now stated, and it is told to judge the label's own words.
export const PEER_LABEL_JUDGE_SYSTEM_PROMPT = `You check one label against a list of buyers.

A sender writes to many readers. Each reader is one senior person at a company the sender sells to. The sender calls every reader, and people like them, by the LABEL, as in "LABEL often tell us...". You get descriptions of the buyers the sender's wording must not exclude. Every one of them is in scope: the sender sells to them.

Say whether a reader at one of those buyers would be wrongly described by the LABEL, so that they would think "that is not me".
- A label that only names the trade or profession the readers share is fine, whatever the size, structure or history of their company.
- A label is wrong only when its own words ADD something that is false for one of the listed buyers: a role, a kind of ownership, a company size or a history that buyer does not have.
Judge the words that are in the label. Do not guess at what else the label might suggest.

Return ONLY JSON: {"excludes": "<id of the first buyer the label wrongly describes>" or null, "why": "<one sentence>"}`

/**
 * Does the DEFAULT peer label wrongly describe an in-scope buyer? One model call per run.
 *
 * Why a model (ADR-018): the brief validator can only match the label against phrases
 * somebody already listed, so a label nobody thought to list goes straight through, and
 * the default label is the one word every template-tier reader is called by. Whether a noun
 * is true of a described buyer is a judgement no list makes.
 *
 * No verdict is not a pass: an answer without an `excludes` key throws.
 */
export async function judgePeerDefaultLabel(
  client: Anthropic,
  brief: OutboundBrief,
  usage: OutboundTemplateResult['usage'],
): Promise<{ excludes: string | null; why: string }> {
  if (brief.must_not_exclude.length === 0) return { excludes: null, why: 'the brief lists no buyer to exclude' }
  const user = [
    '## MUST NOT EXCLUDE', JSON.stringify(brief.must_not_exclude.map(x => ({ id: x.id, statement: x.statement }))),
    '## LABEL', brief.peer_group_default.label,
  ].join('\n')
  const answer = parseModelJson(await callModel(
    client, OUTBOUND_SCOPE_JUDGE_MODEL, PEER_LABEL_JUDGE_SYSTEM_PROMPT, user, 300, usage, 0,
  )) as unknown as { excludes?: unknown; why?: unknown }
  if (!('excludes' in answer) || (answer.excludes !== null && typeof answer.excludes !== 'string')) {
    throw new Error('outbound-template-agent: the peer label judge gave no verdict')
  }
  return { excludes: answer.excludes || null, why: typeof answer.why === 'string' ? answer.why : '' }
}

// ─── The run ─────────────────────────────────────────────────────────────────

export interface OutboundTemplateResult {
  opener_frames: string[]
  variants: Record<string, VariantLines>
  dropped: Record<string, string[]>
  calls: number
  usage: Array<{ model: string; input_tokens: number; output_tokens: number }>
  /** The model that WROTE the templates in this run. Kept variants were written earlier, by whatever wrote them. */
  model?: string
  /**
   * Each "unnatural" quote the scope judge gave that is not in the line it named, once per
   * line and quote. They failed nothing; the script prints them so the operator can read
   * those lines. See ScopeVerdict.unplaced.
   */
  unnatural_not_in_line: Array<{ variant: string; line: string; quote: string }>
}

/** What a run's model calls cost at full price, from the shared price table. */
export function templateRunCostUsd(usage: OutboundTemplateResult['usage']): number {
  return usage.reduce((sum, u) => sum + usdForTokens(u, u.model), 0)
}

/** A model answer cut off at max_tokens. Its partial JSON is never parsed. */
class TruncatedAnswer extends Error {}

/** The run's spend cap was reached before a call was made. Nothing failed; nothing more is asked. */
class SpendCapReached extends Error {}

async function callModel(
  client: Anthropic,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  usage: OutboundTemplateResult['usage'],
  /** A number pins the temperature (the judges). 'stream' is the generator: no temperature, streamed. */
  mode?: number | 'stream',
): Promise<string> {
  const params = {
    model,
    max_tokens: maxTokens,
    ...(typeof mode === 'number' ? { temperature: mode } : {}),
    system,
    messages: [{ role: 'user' as const, content: user }],
  }
  // THE GENERATOR'S CALLS ARE STREAMED. They run for minutes and, sent as one plain
  // request, send nothing back until they have finished: the connection was dropped as
  // idle before the model had answered ("Request timed out", on 2026-10-01, well inside
  // the client's own timeout). Streaming keeps bytes moving. The answer is assembled by
  // the SDK and read exactly as before. The judges are short and stay plain requests.
  const response = mode === 'stream'
    ? await client.messages.stream(params).finalMessage()
    : await client.messages.create(params)
  usage.push({ model, input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens })
  if (response.stop_reason === 'max_tokens') {
    const text = response.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    throw new TruncatedAnswer(
      `outbound-template-agent: ${model} answer was truncated at max_tokens (${text.length} chars; ends: ${JSON.stringify(text.slice(-200))})`,
    )
  }
  return response.content.map(b => (b.type === 'text' ? b.text : '')).join('')
}

function framesFrom(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string').map(f => scrubAITells(f)) : []
}

/**
 * THE SAME FAULT ONCE, NOT ONCE PER RENDER. The validator renders each email many times
 * (every wording, every frame, every peer label, each invented fill) and reports a fault in
 * every render it shows up in. That is right for a person reading the report, and wrong for
 * the writer: on 2026-10-02 two variants went back to it with 56 and 58 lines, 37 of them
 * the one fact that Email 1 reads above grade 5 with a peer label filled in. Faced with that
 * the writer checked its own work in the answer, counting words and syllables, and both
 * answers were cut off before any JSON. Billed in full, nothing repaired.
 *
 * Lines are grouped by the email (the render tag in square brackets is dropped), the rule,
 * and, for a band, whether it is over or under. Then:
 *   - a reading-grade group becomes ONE line, the worst render;
 *   - a repeated word or phrase becomes one line PER WORD, its first pair of sentences;
 *   - any other group shows its first two distinct findings, and counts the rest as faults.
 * A finding said identically by several renders is one finding, said once.
 *
 * UNTIL 2026-10-02 every group but the grade kept two findings and called the rest "more
 * renders of this email". For the repetition rules that was untrue and costly: they report
 * one finding per word, so the hidden ones were other words, not other renders, and each
 * surfaced only a paid round later (five words, shown two). And an over and an under of one
 * band shared a group, so "31 words, add 9" was hidden behind two "cut" lines.
 */
export function compactViolations(lines: readonly string[]): string[] {
  const groups = new Map<string, { where: string; rule: string; details: string[] }>()
  for (const line of lines) {
    const m = line.match(/^(.*?): ([a-z0-9_]+): ([\s\S]*)$/)
    if (!m) { groups.set(`raw|${line}`, { where: '', rule: '', details: [line] }); continue }
    const where = m[1].replace(/\s*\[[^\]]*\]/g, '').trim()
    const direction = /\badd at least\b/.test(m[3]) ? 'under' : /\bcut at least\b/.test(m[3]) ? 'over' : ''
    // One group per word for the repetition rules: the word is what the detail opens on.
    const word = m[2] === 'consecutive_word' || m[2] === 'phrase_repeat' ? (m[3].match(/^"([^"]+)"/)?.[1] ?? '') : ''
    const key = `${where}|${m[2]}|${direction}|${word}`
    const group = groups.get(key) ?? { where, rule: m[2], details: [] }
    if (!group.details.includes(m[3])) group.details.push(m[3])
    groups.set(key, group)
  }
  const out: string[] = []
  for (const group of groups.values()) {
    if (group.rule === '') { out.push(group.details[0]); continue }
    const head = `${group.where}: ${group.rule}: `
    if (group.rule === 'reading_grade' || group.rule === 'reading_grade_filled' || group.rule === 'opener_clause_grade') {
      const grade = (detail: string) => Number(detail.match(/grade (\d+(?:\.\d+)?)/)?.[1] ?? 0)
      const worst = [...group.details].sort((a, b) => grade(b) - grade(a))[0]
      out.push(`${head}${worst}${group.details.length > 1 ? ` (the worst of ${group.details.length} renders of this email that read too hard)` : ''}`)
      continue
    }
    if (group.rule === 'consecutive_word' || group.rule === 'phrase_repeat') {
      out.push(`${head}${group.details[0]}`)
      continue
    }
    const shown = group.details.slice(0, 2)
    const hidden = group.details.length - shown.length
    shown.forEach((detail, i) => {
      const more = i === shown.length - 1 && hidden > 0 ? ` (and ${hidden} more fault${hidden === 1 ? '' : 's'} of this rule in this email, not shown)` : ''
      out.push(`${head}${detail}${more}`)
    })
  }
  return out
}

function violationText(v: TemplateViolation): string {
  return `${v.where}: ${v.rule}: ${v.detail}`
}

/**
 * The validator's findings, sorted by WHO CAN FIX THEM. A variant's are its writer's; a
 * frame's go with the frames; one about the whole document goes to every variant.
 *
 * AND ONE AT THE BRIEF GOES TO NOBODY WHO WRITES (2026-10-02). The writer cannot change a
 * label, a kind or an industry. Until then such a finding was copied under every variant
 * like a document finding, the repair prompt asked the writer to "give the brief a
 * peer_group_default.after_opener label", and the run paid for repair calls until its cap
 * stopped it. Kept apart here, a brief fault can never reach a repair prompt.
 */
export function routeViolations(violations: readonly TemplateViolation[], variantKeys: readonly string[]): {
  byVariant: Record<string, string[]>
  frameViolations: string[]
  briefFaults: string[]
} {
  const byVariant: Record<string, string[]> = {}
  const frameViolations: string[] = []
  const briefFaults: string[] = []
  for (const v of violations) {
    if (v.variant !== '*') (byVariant[v.variant] ??= []).push(violationText(v))
    else if (v.where.startsWith('brief.')) briefFaults.push(violationText(v))
    else if (v.where.startsWith('opener_frames')) frameViolations.push(violationText(v))
    else for (const k of variantKeys) (byVariant[k] ??= []).push(violationText(v))
  }
  return { byVariant, frameViolations, briefFaults }
}

/** What the run says when the brief holds a fault no writing can clear. */
const briefFaultMessage = (faults: readonly string[]) =>
  `outbound-template-agent: the brief has a fault only the brief can fix, so nothing was written: ${faults.join('; ')}. Change the brief and run again.`

/**
 * A run that did not produce every planned variant, or that stopped on an error after the
 * first answer was paid for. Carries the last attempt, so the wording is never lost and the
 * variants that passed can be kept on the next run.
 */
export class OutboundTemplateFailure extends Error {
  constructor(message: string, readonly attempt: OutboundTemplateResult) {
    super(message)
    this.name = 'OutboundTemplateFailure'
  }
}

/**
 * Generate, validate, repair, judge. Pure of the database: the caller supplies the brief
 * and the sign-off, and decides where the result is written.
 */
export async function generateOutboundTemplates(input: {
  brief: OutboundBrief
  signoff: SenderSignoff
  apiKey: string
  /**
   * Variants to keep as they are, with the opener frames they were generated with, so a
   * run regenerates only the others. A kept variant is not trusted: it is re-checked
   * deterministically AND re-judged, because both the checks and the judge change between
   * runs, and a variant that passed last week's judge has not passed this one. If either
   * now fails, it is repaired like any other variant.
   */
  keep?: { opener_frames: string[]; variants: Record<string, VariantLines> }
  /** The model that writes. Defaults to OUTBOUND_TEMPLATE_MODEL; a draft run passes OUTBOUND_TEMPLATE_DRAFT_MODEL. */
  model?: string
  /**
   * Stop paying once the run's calls have cost this much, at full price. Checked BEFORE
   * each writing call and each judge round, so a run overshoots by at most the calls
   * already in flight: one writing call, or one judge round. (The one label check that
   * opens a run is not checked: nothing has been spent before it.) A run stopped by it fails like any other failed run,
   * carrying its attempt, so nothing written is lost. Omitted, there is no cap.
   */
  maxUsd?: number
  /** Tests only: a stand-in for the model client. Production passes apiKey and nothing here. */
  client?: Anthropic
}): Promise<OutboundTemplateResult> {
  const { brief, signoff } = input
  const writerModel = input.model ?? OUTBOUND_TEMPLATE_MODEL
  const briefProblems = validateOutboundBrief(brief)
  if (briefProblems.length > 0) {
    throw new Error(`outbound-template-agent: the brief is not valid: ${briefProblems.join('; ')}`)
  }
  // THE TEMPLATE VALIDATOR'S BRIEF FAULTS, BEFORE ANYTHING IS PAID FOR. The brief validator
  // above is the first net for these; this is the second, and it reads exactly what the run
  // would later be refused for. Every brief-level check reads the brief alone, so it is seen
  // here with nothing written: no label check, no writing call, no repair.
  {
    const { briefFaults } = routeViolations(validateTemplateDocument({ brief, opener_frames: [], variants: {}, signoff }), [])
    if (briefFaults.length > 0) throw new Error(briefFaultMessage(briefFaults))
  }
  const client = input.client ?? new Anthropic({ apiKey: input.apiKey, timeout: GENERATION_TIMEOUT_MS, maxRetries: 1 })
  const plan = planAngles(brief)
  const budget = email1WordBudget(brief, signoff)
  const usage: OutboundTemplateResult['usage'] = []
  let calls = 0
  let judgeCalls = 0
  let judgeModelCalls = 0
  const overCap = () => input.maxUsd !== undefined && templateRunCostUsd(usage) >= input.maxUsd
  // Four decimals under a cent, so a small figure is never printed as "$0.00 of $0.00".
  const dollars = (usd: number) => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`
  const capNote = () => (overCap() ? ` Stopped at the spend cap: ${dollars(templateRunCostUsd(usage))} of ${dollars(input.maxUsd!)}.` : '')

  const { keep } = input
  const variantKeys = variantKeysFor(brief)
  const toGenerate = variantKeys.filter(k => !keep?.variants[k])
  if (keep) {
    for (const [k, v] of Object.entries(keep.variants)) {
      const p = plan[k]
      if (!p || v.email1.angle !== p.email1) throw new Error(`outbound-template-agent: kept variant ${k} does not match the angle plan`)
      // THE NEUTRAL LINE IS PART OF THE PLAN. A kept variant is copied in as it stands, so
      // nothing downstream sets its offer_angle. A variant saved under an older plan (the
      // neutral line moved from the last variant to another on 2026-10-01) would either
      // leave the document with no neutral line at all, or with it on a variant the plan
      // no longer names, and the validator holds only "at most one". Refused here, by name.
      const keptIsNeutral = v.email1.offer_angle === null
      if (keptIsNeutral !== p.neutralOffer) {
        throw new Error(
          `outbound-template-agent: kept variant ${k} ${keptIsNeutral ? 'carries the neutral offer line' : 'carries a tagged offer line'}, ` +
          `and the plan now gives ${p.neutralOffer ? 'the neutral line' : 'a tagged line'} to ${k}. Regenerate ${k}; do not keep it.`,
        )
      }
    }
  }

  // RULE 7, BEFORE ANYTHING IS WRITTEN. The default peer label is the brief's, not the
  // model's, so no repair can fix it: a label that wrongly describes an in-scope buyer stops
  // the run here, for the price of one small call, with the brief named as the thing to fix.
  // Counted on its own: charged to the scope judge's budget it took one of eight calls,
  // and the last paid repair of a full run could then never be judged.
  let labelCalls = 0
  if (brief.must_not_exclude.length > 0) labelCalls++
  const label = await judgePeerDefaultLabel(client, brief, usage)
  if (label.excludes) {
    throw new Error(
      `outbound-template-agent: the default peer label "${brief.peer_group_default.label}" wrongly describes in-scope buyer ${label.excludes}` +
      `${label.why ? ` (${label.why})` : ''}. Change peer_group_default in the brief; no templates were generated.`,
    )
  }

  // ONE VARIANT PER GENERATION CALL. Asked for every variant at once, with every rule to
  // check each against, the answer outgrew its limit before it was written (see
  // GENERATION_THINKING). Each call is told what the others already hold in Email 1,
  // because code refuses a sentence used twice and a variant written blind cannot avoid
  // one. The first call also writes the opener frames, unless they are kept.
  //
  // A truncated answer is retried once: without a first answer there is nothing to repair.
  const raw: Record<string, RawVariant> = {}
  const lines: Record<string, VariantLines> = {}
  for (const key of variantKeys) {
    if (!keep?.variants[key]) continue
    lines[key] = keep.variants[key]
    raw[key] = linesToRaw(keep.variants[key])
  }
  let firstFrames: unknown = undefined
  for (const key of toGenerate) {
    const framesWritten = !!keep || firstFrames !== undefined
    let answer: ReturnType<typeof parseModelJson> | null = null
    for (let attempt = 0; attempt < 2 && answer === null; attempt++) {
      try {
        if (overCap()) throw new SpendCapReached(`the spend cap was reached before this variant was written.${capNote()}`)
        calls++
        answer = parseModelJson(await callModel(
          client, writerModel, OUTBOUND_TEMPLATE_SYSTEM_PROMPT,
          buildGenerationPrompt(brief, plan, [key], budget, { alreadyWritten: raw, framesWritten }),
          WRITING_MAX_TOKENS, usage, 'stream',
        ))
      } catch (err) {
        if (err instanceof TruncatedAnswer && attempt === 0) {
          logger.warn('outbound-template-agent: first answer truncated, retrying once', { variant: key })
          continue
        }
        // WHAT WAS ALREADY WRITTEN IS KEPT. Each variant is its own paid call now, so a
        // failure on the third must not take the first two with it: on 2026-10-01 a
        // variant that had generated cleanly was lost this way and paid for again. Thrown
        // as a failure that carries the attempt, the caller saves it and prints the
        // --keep command for what exists.
        const unwritten = toGenerate.filter(k => !lines[k])
        // A run stopped by its cap did not FAIL to write the variant: it was not asked to.
        const capped = err instanceof SpendCapReached
        throw new OutboundTemplateFailure(
          capped
            ? `outbound-template-agent: stopped before writing variant ${key}: ${err.message}`
            : `outbound-template-agent: generating variant ${key} failed after ${calls} generation calls: ${err instanceof Error ? err.message : String(err)}`,
          {
            opener_frames: keep ? [...keep.opener_frames] : framesFrom(firstFrames),
            variants: { ...lines },
            dropped: Object.fromEntries(unwritten.map(k => [k, [capped ? 'not written: the run stopped at its spend cap' : 'not written: the generation call for this variant failed']])),
            calls: calls + labelCalls,
            usage,
            model: writerModel,
            // No judge has run before every variant is written.
            unnatural_not_in_line: [],
          },
        )
      }
    }
    if (answer === null) throw new Error(`outbound-template-agent: no first answer for variant ${key}`)
    if (!framesWritten) firstFrames = answer.opener_frames
    raw[key] = answer.variants?.[key] ?? {}
    lines[key] = toVariantLines(raw[key], plan[key], brief.brief_version)
  }
  let frames = keep ? [...keep.opener_frames] : framesFrom(firstFrames)

  // THE JUDGE IS PER VARIANT AND PER WORDING. A variant passes only if its CURRENT wording
  // passed every deterministic check AND the scope judge. judgedClean holds the variants
  // whose current wording the judge cleared; repairing a variant removes it, so a repaired
  // variant is always judged again. A variant stuck on a deterministic failure never
  // blocks the others from being judged.
  const judgedClean = new Set<string>()
  const scopeFindings: Record<string, Array<{ line: string; reason: string }>> = {}
  // Quotes the judge gave as "unnatural" that are not in the line it named, once each.
  const unplacedQuotes = new Map<string, OutboundTemplateResult['unnatural_not_in_line'][number]>()
  const scopeText = (k: string) => (scopeFindings[k] ?? []).map(f => `${f.line}: scope: ${f.reason}`)
  // The text the judge was shown for each line of a variant, by line name.
  const judgedText = (v: VariantLines) => new Map(lineRefsFor({ x: v }, brief.peer_group_default.label).map(r => [r.line, r.text]))
  const deterministic = () => {
    const { byVariant, frameViolations, briefFaults } = routeViolations(
      validateTemplateDocument({ brief, opener_frames: frames, variants: lines, signoff }), Object.keys(lines))
    // Never handed to the writer. The check before the first call sees every one of these;
    // should a brief-level check ever need the copy to be seen, the run stops here, with
    // what it wrote, instead of paying a writer to fix the brief.
    if (briefFaults.length > 0) throw new OutboundTemplateFailure(briefFaultMessage(briefFaults), attempt({}))
    return { byVariant, frameViolations }
  }
  // One judge call. A judge answer that cannot be used (cut off, not JSON, not a list of
  // lines) judges nothing: the variants stay unjudged, which is not passed, and the run
  // goes on to a later round or to the final verdict with its wording intact. Until
  // 2026-10-01 such an answer threw out of the run after the writing calls were paid for.
  //
  // ONE VARIANT PER CALL, since 2026-10-01. All the variants used to go in one call, and the
  // answer is one object per line with a dozen fields, so its length grew with the number
  // of variants and with every field a new rule added. On the day slot_reads became the
  // thirteenth field, three kept variants judged together came back cut off at the token
  // limit twice running, and a run that had nothing to repair failed with every variant
  // "not cleared". An answer whose size depends on how much was asked is a limit waiting to
  // be met. Per variant, the answer is bounded by one variant's lines, and one unusable
  // answer leaves ONE variant unjudged instead of all of them.
  //
  // judgeCalls counts ROUNDS, which is what MAX_JUDGE_CALLS budgets. judgeModelCalls counts
  // the calls actually made, which is what the result reports.
  const judge = async (keys: string[]) => {
    judgeCalls++
    const verdicts = await Promise.all(keys.map(async k => {
      judgeModelCalls++
      try {
        return { k, verdict: await runScopeJudge(client, brief, { [k]: lines[k] }, usage) }
      } catch (err) {
        if (!(err instanceof TruncatedAnswer) && !(err instanceof SyntaxError) && !(err instanceof JudgeUnusable)) throw err
        logger.warn('outbound-template-agent: scope judge answer unusable, this variant stays unjudged', { judged: [k], error: String(err) })
        return { k, verdict: null }
      }
    }))
    const hits: ScopeHit[] = []
    for (const { k, verdict } of verdicts) {
      if (verdict === null) continue
      for (const u of verdict.unplaced) {
        const key = `${u.variant}|${u.line}|${u.quote}`
        if (unplacedQuotes.has(key)) continue
        unplacedQuotes.set(key, u)
        logger.warn('outbound-template-agent: the scope judge called words unnatural that are not in the line it named; the line was not failed for them', u)
      }
      for (const h of verdict.hits) (scopeFindings[h.variant] ??= []).push({ line: h.line, reason: h.reason })
      hits.push(...verdict.hits)
      if (!scopeFindings[k]) judgedClean.add(k)
    }
    logger.info('outbound-template-agent: scope judge', {
      judged: verdicts.filter(v => v.verdict !== null).map(v => v.k),
      unjudged: verdicts.filter(v => v.verdict === null).map(v => v.k),
      hits: hits.map(h => `${h.variant} ${h.line}: ${h.reason}`),
    })
  }
  const cutOffRepairs = new Map<string, number>()
  const attempt = (dropped: Record<string, string[]>): OutboundTemplateResult =>
    ({ opener_frames: frames, variants: { ...lines }, dropped, calls: calls + judgeModelCalls + labelCalls, usage, model: writerModel, unnatural_not_in_line: [...unplacedQuotes.values()] })

  try {
    for (let round = 0; round <= MAX_REPAIR_ROUNDS; round++) {
      const { byVariant, frameViolations } = deterministic()
      const toJudge = Object.keys(lines).filter(k => !byVariant[k] && !judgedClean.has(k) && !scopeFindings[k])
      if (toJudge.length > 0 && judgeCalls < MAX_JUDGE_CALLS && !overCap()) await judge(toJudge)

      const failingKeys = Object.keys(lines).filter(k => byVariant[k] || scopeFindings[k])
      if (failingKeys.length === 0 && frameViolations.length === 0) break
      // Which CODE rule cost this round. The judge's hits were already logged; without this
      // line a variant that never reaches the judge leaves no trace of why, and a rule the
      // writer cannot satisfy looks the same as a run that was merely unlucky.
      logger.info('outbound-template-agent: round', {
        round,
        frames: frameViolations,
        violations: Object.fromEntries(failingKeys.map(k => [k, byVariant[k] ?? []])),
      })
      if (round === MAX_REPAIR_ROUNDS || calls >= MAX_GENERATION_CALLS || overCap()) break

      // ONE VARIANT PER REPAIR CALL, like the first generation (see MAX_GENERATION_CALLS and
      // the comment on WRITING_MAX_TOKENS). The frames, when they failed, are rewritten
      // in the first call of the round, or in a call of their own when no variant failed.
      // A variant whose repair answer has been cut off twice is not asked a third time in
      // this run: the same request gets the same runaway answer, billed in full each time.
      // Its wording stays as it was, it fails the run's final verdict, and the saved attempt
      // lets the next run pick it up.
      const askable = failingKeys.filter(k => (cutOffRepairs.get(k) ?? 0) < MAX_CUT_OFF_REPAIRS)
      if (failingKeys.length > 0 && askable.length === 0 && frameViolations.length === 0) break
      const targets: Array<string | null> = askable.length > 0 ? askable : [null]
      for (const [n, k] of targets.entries()) {
        if (calls >= MAX_GENERATION_CALLS || overCap()) break
        calls++
        // The writer is shown each fault once. See compactViolations.
        const failing = k ? { [k]: { attempt: raw[k], violations: [...compactViolations(byVariant[k] ?? []), ...scopeText(k)] } } : {}
        const framesToFix = n === 0 ? frameViolations : []
        const others = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== k))
        // A truncated or unparseable repair keeps the previous wording and costs the call.
        let repaired: ReturnType<typeof parseModelJson>
        try {
          repaired = parseModelJson(await callModel(
            client, writerModel, OUTBOUND_TEMPLATE_SYSTEM_PROMPT,
            buildRepairPrompt(brief, plan, failing, framesToFix, frames, budget, others), WRITING_MAX_TOKENS, usage, 'stream',
          ))
        } catch (err) {
          if (!(err instanceof TruncatedAnswer) && !(err instanceof SyntaxError)) throw err
          if (k && err instanceof TruncatedAnswer) cutOffRepairs.set(k, (cutOffRepairs.get(k) ?? 0) + 1)
          logger.warn('outbound-template-agent: repair answer unusable, keeping previous wording', { variant: k, error: String(err) })
          continue
        }
        if (framesToFix.length > 0) {
          const newFrames = framesFrom(repaired.opener_frames)
          if (newFrames.length > 0) frames = newFrames
        }
        if (k && repaired.variants?.[k]) {
          // Laid over the previous attempt, never in place of it: see mergeRepair.
          const before = judgedText(lines[k])
          raw[k] = mergeRepair(raw[k], repaired.variants[k])
          lines[k] = toVariantLines(raw[k], plan[k], brief.brief_version)
          judgedClean.delete(k)
          // A FINDING STANDS UNTIL ITS LINE CHANGES. Cleared whenever the repair answer
          // merely contained the variant, a line the judge had rejected could come back
          // word for word, be read a second time in different company, and pass. The judge
          // said no to that wording; only different wording earns another read.
          const after = judgedText(lines[k])
          const standing = (scopeFindings[k] ?? []).filter(f =>
            f.line.split(' + ').every(name => before.has(name) && before.get(name) === after.get(name)))
          if (standing.length > 0) {
            scopeFindings[k] = standing.map(f => ({
              line: f.line,
              reason: f.reason.endsWith('(not changed by the last repair)') ? f.reason : `${f.reason} (not changed by the last repair)`,
            }))
          } else {
            delete scopeFindings[k]
          }
        }
      }
    }

    // The loop can end on a repair, leaving that wording unjudged. Judge it once more.
    {
      const { byVariant } = deterministic()
      const unjudged = Object.keys(lines).filter(k => !byVariant[k] && !judgedClean.has(k) && !scopeFindings[k])
      if (unjudged.length > 0 && judgeCalls < MAX_JUDGE_CALLS && !overCap()) await judge(unjudged)
    }
  } catch (err) {
    // Anything that stops the run after the first answer (a failed repair call, the API
    // going away) must not take the wording with it: the calls so far are paid for.
    if (err instanceof OutboundTemplateFailure) throw err
    throw new OutboundTemplateFailure(
      `outbound-template-agent: the run stopped on an error after ${calls + judgeModelCalls} model calls: ${err instanceof Error ? err.message : String(err)}`,
      attempt({}),
    )
  }

  // Final verdict: a variant passes only with clean deterministic checks AND a judge pass
  // on its final wording. Unjudged is not passed.
  const final = deterministic()
  const dropped: Record<string, string[]> = {}
  for (const k of Object.keys(lines)) {
    const reasons = [...(final.byVariant[k] ?? []), ...scopeText(k)]
    if (reasons.length === 0 && !judgedClean.has(k)) reasons.push('the scope judge did not clear the final wording')
    if (reasons.length > 0) dropped[k] = reasons
  }
  if (final.frameViolations.length > 0) {
    throw new OutboundTemplateFailure(`outbound-template-agent: opener frames still fail: ${final.frameViolations.join('; ')}`, attempt(dropped))
  }
  const passing = Object.fromEntries(Object.entries(lines).filter(([k]) => !dropped[k]))
  // ONE VARIANT PER LEAD ANGLE, so every planned variant must pass (rule 6). A document
  // short a variant would leave a lead angle with no email, and the prospects hashed to it
  // would be reassigned at upload. The failure carries every variant, passing and not, so
  // the next run can keep the ones that passed (--keep with --keep-from in the script).
  if (Object.keys(passing).length < variantKeys.length) {
    throw new OutboundTemplateFailure(
      `outbound-template-agent: ${Object.keys(passing).length} of ${variantKeys.length} variants passed; every lead angle needs its variant.${capNote()} ` +
      Object.entries(dropped).map(([k, r]) => `${k}: ${r.slice(0, 4).join(' | ')}`).join(' || '),
      attempt(dropped),
    )
  }
  return { opener_frames: frames, variants: passing, dropped, calls: calls + judgeModelCalls + labelCalls, usage, model: writerModel, unnatural_not_in_line: [...unplacedQuotes.values()] }
}

// ─── Storage ─────────────────────────────────────────────────────────────────

export interface StoredEmail {
  sequence_position: number
  subject_line: string | null
  subject_char_count: number
  body: string
  word_count: number
  /** Email 1 only: the offer-line selector's tag (copy-writing a9044e5). */
  offer_angle?: string | null
}

/**
 * The messaging document content for a generated result. Bodies are the SLOT-FREE
 * rendering, so every existing reader (composition, the research writer) works on them
 * unchanged; `lines` beside them carry the structure the firm-fact tier needs.
 */
export function buildMessagingContent(input: {
  base: Record<string, unknown>
  brief: OutboundBrief
  result: Pick<OutboundTemplateResult, 'opener_frames' | 'variants'>
  signoff: SenderSignoff
  firmFactTierEnabled: boolean
}): Record<string, unknown> {
  const { base, brief, result, signoff } = input
  const pg = brief.peer_group_default.label
  const variants = Object.fromEntries(Object.entries(result.variants).map(([key, v]) => {
    const e1 = renderEmail1SlotFree(v.email1, pg, signoff)
    const byPos = new Map(v.followups.map(f => [f.position, f]))
    const email = (pos: 2 | 3 | 4): StoredEmail => {
      const body = renderFollowupSlotFree(byPos.get(pos)!, pg, signoff)
      return { sequence_position: pos, subject_line: null, subject_char_count: 0, body, word_count: countWords(body) }
    }
    const emails: StoredEmail[] = [
      {
        sequence_position: 1, subject_line: e1.subject, subject_char_count: e1.subject.length,
        body: e1.body, word_count: countWords(e1.body), offer_angle: v.email1.offer_angle,
      },
      email(2), email(3), email(4),
    ]
    return [key, { angle: v.email1.angle, emails, lines: v }]
  }))
  const content: Record<string, unknown> = {
    ...Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'variants')),
    outbound_brief: brief,
    opener_frames: result.opener_frames,
    firm_fact_tier: { enabled: input.firmFactTierEnabled },
    variants,
  }
  assertNoDashes(content, 'outbound-template-agent')
  return content
}

/** The org's sender sign-off, read from the organisation record (never hardcoded). */
export async function fetchSenderSignoff(supabase: SupabaseClient, organisationId: string): Promise<SenderSignoff> {
  const { data, error } = await supabase
    .from('organisations')
    .select('name, founder_first_name')
    .eq('id', organisationId)
    .single()
  if (error || !data) throw new Error(`outbound-template-agent: organisation ${organisationId} not found`)
  const firstName = (data.founder_first_name ?? '').trim()
  const companyName = (data.name ?? '').trim()
  if (!firstName || !companyName) {
    throw new Error('outbound-template-agent: organisation needs founder_first_name and name for the sign-off')
  }
  return { firstName, companyName }
}
