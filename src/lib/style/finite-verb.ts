// Deterministic detection of sentences that have no finite verb.
//
// WHY THIS EXISTS
// Three of twenty-four shipped openings contained a sentence with no finite verb: a noun
// phrase punctuated as if it were a sentence. Every existing gate passed them, because
// each one asks a different question. The word cap counts words. The readability score
// measures sentence LENGTH and hedging, both of which a fragment passes easily, since a
// fragment is short and commits to nothing by omission rather than by hedge word. The
// back-reference and sentence-initial gates look at particular tokens. Nothing asked
// whether the sentence had a verb in it at all.
//
// Deterministic by design (ADR-018). This is pattern matching on predictable text, not
// judgement, so no model is involved and no dependency is added. There is no
// part-of-speech tagger in this repository and one is not being introduced for this.
// The technique is closed word lists, the same as NON_NOUN_FOLLOWERS in back-reference.ts,
// and it inherits the same trade-off, stated there and restated here because it governs
// every decision in this file.
//
// GOVERNING PRINCIPLE: AMBIGUITY RESOLVES TO PASS.
// A missed fragment costs one imperfect email. A false positive is far more expensive: it
// blocks good copy, burns a retry at real API cost, and can push the prospect onto the
// fallback template, which is a worse email than the sentence that was rejected. So every
// list below is built to avoid false POSITIVES, and every uncertain case is treated as
// having a verb. The cost is misses, and misses are the correct direction to fail.
//
// THE ASYMMETRY, WHICH IS THE LOAD-BEARING RULE:
//
//   A bare word ending in -ed COUNTS as a finite verb. It is more often a simple past
//   than a bare participle, and reading it as a participle would flag large numbers of
//   correct sentences.
//
//   A bare word ending in -ing DOES NOT count as a finite verb. Without an auxiliary it
//   is almost never finite, and a bare participle standing in for a verb is exactly the
//   fault being hunted.
//
// Backwards, this gate is unusable in both directions at once.
//
// The -ed half has no minimum word length, so short nouns that merely end in those two
// letters (shed, bed, seed) also read as finite and carry a fragment through. Imposing a
// length floor would start rejecting real four-letter verbs such as "used" and "aged",
// which is the expensive direction, so the miss is taken instead.
//
// HOMOGRAPHS ARE NOT DISAMBIGUATED, AND THAT IS DELIBERATE.
// Many nouns share a form with a third-singular verb: posts, wins, results, reports,
// moves. A noun-phrase fragment containing one of them passes undetected. That is a
// false negative and it is the direction this gate is supposed to fail in. It also means
// a LONGER verb list produces MORE misses rather than fewer, so the lists below are kept
// short on purpose and no attempt is made to tell a noun from a verb by context.

// MEASURED AGAINST THE LIVE DATA BEFORE THIS FILE WAS COMMITTED, AND THE NUMBERS ARE NOT
// GOOD ENOUGH TO BLOCK ON. Run over all 24 stored personalisation triggers:
//
//   TRUE POSITIVES   3 of 3. Every genuinely verbless sentence in the corpus is caught:
//                    one participle fragment, and two comma-separated noun lists. This is
//                    the fault the file was written for and it finds all of it.
//   FALSE POSITIVES  13 sentences across 10 further rows. 13 of 24 rows flag in total.
//
// EVERY false positive has the same single cause: an ordinary present-tense verb that is
// not in the lists below. Third-singular forms and bare plural forms are an OPEN class in
// English, and no closed list can cover them.
//
// AND THE OBVIOUS FIX DOES NOT WORK, which is the part worth carrying. Lengthening the
// lists until the false positives stop would destroy the detection, because the missing
// words and the fragment words are the same words. Two of the three real faults contain
// nouns that are also common verbs, so adding those verbs to the lists turns both into
// misses. The two error rates are not independent knobs, and there is no setting of this
// technique that gives a low false-positive rate and keeps the three hits.
//
// SO IT SHIPS REPORT-ONLY, and flipping FINITE_VERB_GATE_MODE to 'block' on the strength
// of the three hits alone would reject roughly two fifths of all openings written. See
// BACKLOG. Whoever flips it needs a different technique, not a longer list.

import { logger } from '@/lib/logger'
import { splitSentences } from './readability'

// REPORT-ONLY FIRST, as with the sentence-initial gate. Nothing this file finds may
// reject anything in production until someone has read a week of logs and seen what it
// actually caught.
//
// A CONSTANT, NOT A DATE. This file does not roll over on its own. An automatic flip
// would put the gate into blocking mode without anyone having read what it caught, which
// is the only thing the observation period is for.
//
// TO FLIP: change this to 'block', by hand, and record in BACKLOG what the logs showed.
export type FiniteVerbGateMode = 'report' | 'block'
export const FINITE_VERB_GATE_MODE: FiniteVerbGateMode = 'report'

/** Finite forms of BE. Deliberately excludes be, been and being, which are non-finite. */
export const BE_FORMS = ['am', 'is', 'are', 'was', 'were'] as const

/** HAVE used finitely. "having" is excluded: it is a participle, never a finite verb. */
export const HAVE_FORMS = ['have', 'has', 'had'] as const

export const DO_FORMS = ['do', 'does', 'did'] as const

export const MODALS = [
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'ought',
] as const

// Every form of BE and HAVE, finite or not. Used ONLY for the -ed lookbehind: an -ed word
// directly after one of these is a participle in a compound tense rather than a simple
// past. In practice this only changes the verdict after be, been, being and having, since
// the finite forms already mark the sentence as having a verb on their own.
export const PARTICIPLE_AUXILIARIES = [
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having',
] as const

// Contraction endings that expand to a finite auxiliary: "they're", "we've", "he'll",
// "she'd", "doesn't". Each of these has no second reading, so each is unconditional.
//
// 'S IS NOT IN THIS LIST, AND THAT IS THE WHOLE OF THE PROBLEM WITH IT. It is a copula or
// HAVE in "it's late" and "the firm's been quiet", and a possessive in "the firm's board".
// An unconditional 's rule was the first version of this file, and the measurement below
// is why it did not survive: it read the possessive as a verb and MISSED BOTH of the real
// faults in the live data, which were the only two the gate existed to catch.
export const CONTRACTION_SUFFIXES = ["'re", "'ve", "'ll", "'d", "n't"] as const

// Stems that take 's as a copula and can never take it as a possessive. "It's", "that's",
// "there's" are verbs every time.
export const COPULA_PRONOUN_STEMS = [
  'it', 'that', 'there', 'he', 'she', 'who', 'what', 'here', 'this', 'one',
  'everything', 'something', 'nothing', 'everyone', 'someone', 'nobody',
] as const

// Words that cannot follow a possessive and therefore prove the 's before them is a verb.
// A possessive introduces a noun phrase, so an article, a negator or a participle after it
// is impossible: "the firm's been quiet" is HAVE, "the firm's the exception" is BE.
//
// Anything else after 's is read as a possessive and contributes no verb. That is the
// conservative direction here for once, because the sentence still passes if it has a verb
// anywhere else, and a bare noun phrase built round a possessive is the exact fault.
export const POST_COPULA_MARKERS = [
  'been', 'being', 'got', 'not', 'a', 'an', 'the', 'no', 'still', 'already', 'always',
  'just', 'now', 'also',
] as const

// Common lexical verbs in present third-singular form.
//
// SHORT ON PURPOSE. See the homograph note in the header: every entry that is also a
// common noun buys a miss. Entries here are ones that are rarely nouns in this register.
export const LEXICAL_THIRD_SINGULAR = [
  'makes', 'takes', 'gives', 'gets', 'goes', 'comes', 'keeps', 'knows', 'says', 'tells',
  'seems', 'looks', 'feels', 'means', 'shows', 'sends', 'brings', 'happens', 'includes',
  'requires', 'becomes', 'remains', 'appears', 'runs', 'sits', 'lands',
] as const

// ADDED BEYOND THE ENUMERATED RULES, AND FLAGGED RATHER THAN SLIPPED IN.
//
// The rules above cover BE, HAVE, DO, modals, contractions, -ed pasts and third-singular
// lexical verbs. Two very common classes of finite verb are covered by NONE of them, and
// both are everywhere in this copy. Leaving them out does not produce misses, which would
// be acceptable. It produces FALSE POSITIVES on ordinary correct sentences, which the
// governing principle forbids outright.
//
// IRREGULAR SIMPLE PASTS DO NOT END IN -ED, so the asymmetry rule never sees them. This
// was not a theoretical worry: the first run of the test suite reported "The parasol blew
// over in the night" as verbless. An observation is usually written about something
// somebody DID, so past-tense verbs are the single most common thing in the text this
// gate reads, and most of the frequent ones are irregular.
//
// The list is longer than the third-singular one above, and that is deliberate rather
// than an oversight of the keep-it-short rule. Length costs misses only where an entry is
// also a common noun. Past forms are mostly not nouns at all, so the usual cost of a
// longer list barely applies here, while each omission is a live false positive.
export const IRREGULAR_PAST_FORMS = [
  'was', 'were', 'had', 'did',
  'began', 'blew', 'broke', 'brought', 'built', 'bought', 'caught', 'chose', 'came',
  'dealt', 'drew', 'drank', 'drove', 'ate', 'fell', 'fed', 'felt', 'fought', 'found',
  'flew', 'forgot', 'got', 'gave', 'went', 'grew', 'hung', 'heard', 'hid', 'held',
  'kept', 'knew', 'laid', 'led', 'left', 'lent', 'lost', 'made', 'meant', 'met',
  'paid', 'ran', 'rode', 'rang', 'rose', 'said', 'saw', 'sought', 'sold', 'sent',
  'shook', 'shone', 'shot', 'sang', 'sat', 'slept', 'spoke', 'spent', 'stood', 'stole',
  'stuck', 'struck', 'swam', 'took', 'taught', 'told', 'thought', 'threw', 'understood',
  'woke', 'wore', 'won', 'wrote',
] as const

// BARE PRESENT FORMS ARE NOT THIRD-SINGULAR, so they miss the list above as well. "Hold
// times keep coming up" and "The two teams run their own numbers" are complete sentences
// whose only verbs are "keep" and "run".
//
// SHORTER THAN THE PAST LIST, ON PURPOSE. Bare present forms collide with common nouns
// far more often than past forms do (run, hold, work, cost, need, show), so every entry
// here genuinely does buy misses. Only the highest-frequency verbs are listed.
export const BARE_PRESENT_FORMS = [
  'keep', 'run', 'make', 'take', 'give', 'come', 'go', 'know', 'say', 'tell', 'seem',
  'look', 'feel', 'mean', 'show', 'send', 'bring', 'happen', 'include', 'require',
  'become', 'remain', 'appear', 'sit', 'land', 'get', 'put', 'find', 'leave', 'hold',
  'think', 'want', 'need', 'use', 'work', 'help', 'start', 'stop', 'turn', 'move',
] as const

/**
 * Every exported word list, in one place, for the Rule Zero test to walk.
 *
 * A SECOND LIST THAT MUST STAY IN STEP WITH THE FILE, so the test guards it against the
 * file rather than against itself: it walks the module's own exports and fails if an
 * exported array is missing from here. Without that, adding a list and forgetting this
 * record would leave it silently unchecked, which is the parallel-array failure exactly.
 *
 * NOT the source of the lookup sets, and deliberately so. PARTICIPLE_AUXILIARIES contains
 * be, been, being and having, which are NOT finite, and CONTRACTION_SUFFIXES holds
 * fragments rather than words. Both play different roles and neither may be folded into
 * FINITE_TOKENS.
 */
export const FINITE_VERB_WORD_LISTS: Record<string, readonly string[]> = {
  BE_FORMS,
  HAVE_FORMS,
  DO_FORMS,
  MODALS,
  PARTICIPLE_AUXILIARIES,
  CONTRACTION_SUFFIXES,
  COPULA_PRONOUN_STEMS,
  POST_COPULA_MARKERS,
  LEXICAL_THIRD_SINGULAR,
  IRREGULAR_PAST_FORMS,
  BARE_PRESENT_FORMS,
}

/** Single-token words that mark a sentence as having a finite verb. */
const FINITE_TOKENS = new Set<string>([
  ...BE_FORMS,
  ...HAVE_FORMS,
  ...DO_FORMS,
  ...MODALS,
  ...LEXICAL_THIRD_SINGULAR,
  ...IRREGULAR_PAST_FORMS,
  ...BARE_PRESENT_FORMS,
])

const AUXILIARY_TOKENS = new Set<string>(PARTICIPLE_AUXILIARIES)
const COPULA_STEMS = new Set<string>(COPULA_PRONOUN_STEMS)
const POST_COPULA_SET = new Set<string>(POST_COPULA_MARKERS)

/** Below this a sentence is too short to judge, and is not the fault being hunted. */
const MIN_SENTENCE_WORDS = 4

// Lowercased, curly apostrophes normalised to straight so a contraction is recognised
// whichever way the model typed it, and edge punctuation stripped. Internal hyphens and
// apostrophes survive, so "well-established" still reads as ending in -ed.
function tokenise(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .split(/\s+/)
    .map(token => token.replace(/^[^\p{L}']+|[^\p{L}']+$/gu, ''))
    .filter(Boolean)
}

// Decides whether a token's 's is a verb or a possessive. See POST_COPULA_MARKERS for why
// the word AFTER it is the discriminator: no tagger is involved, only the fact that a
// possessive must introduce a noun phrase.
function isCopulaApostropheS(token: string, next: string | undefined): boolean {
  if (COPULA_STEMS.has(token.slice(0, -2))) return true
  return next !== undefined && POST_COPULA_SET.has(next)
}

function hasFiniteVerb(sentence: string): boolean {
  const tokens = tokenise(sentence)

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]

    if (FINITE_TOKENS.has(token)) return true
    if (CONTRACTION_SUFFIXES.some(suffix => token.endsWith(suffix))) return true
    if (token.endsWith("'s") && isCopulaApostropheS(token, tokens[i + 1])) return true

    // THE ASYMMETRY. -ed counts unless an auxiliary immediately before it makes it a
    // participle. -ing is never counted, and has no branch here at all.
    if (token.endsWith('ed') && !AUXILIARY_TOKENS.has(tokens[i - 1] ?? '')) return true
  }

  return false
}

/**
 * Returns, verbatim, the sentences that appear to have no finite verb.
 *
 * Skips sentences under MIN_SENTENCE_WORDS words and any sentence ending in a question
 * mark. Neither is the fault being hunted, and both are common in correct copy: the
 * closing question is a question by design, and a deliberate short fragment is a style
 * choice rather than the accident this looks for.
 */
export function findVerblessSentences(text: string): string[] {
  return splitSentences(text).filter(sentence => {
    if (sentence.endsWith('?')) return false
    if (sentence.trim().split(/\s+/).filter(Boolean).length < MIN_SENTENCE_WORDS) return false
    return !hasFiniteVerb(sentence)
  })
}

/**
 * Logs what it found, and returns failure strings ONLY in blocking mode.
 *
 * Returns the failure strings to append to the gate list, which is EMPTY in report mode.
 * That is the whole of the report-only behaviour: the hits are logged either way, and
 * only a blocking mode turns them into something the writer has to fix.
 */
export function checkFiniteVerbs(
  text: string,
  /** part names which half of the opening this was, so the log keeps per-part attribution. */
  context: { prospectId: string; part: string },
  /**
   * Defaulted to the module constant, which is what production uses. A PARAMETER ONLY SO
   * THE BLOCKING PATH CAN BE EXECUTED BY A TEST while the constant says 'report'.
   *
   * A flip that has never been run is a flip nobody has tested, and the moment of
   * flipping is the worst time to discover it was broken. Production never passes this.
   */
  mode: FiniteVerbGateMode = FINITE_VERB_GATE_MODE,
): string[] {
  const hits = findVerblessSentences(text)
  if (hits.length === 0) return []

  logger.warn('finite-verb-gate: sentence with no finite verb', {
    ...context,
    mode,
    count: hits.length,
    sentences: hits,
  })

  if (mode !== 'block') return []

  return [
    `contains a sentence with no verb in it: ` +
    hits.map(s => `"${s}"`).join(', ') +
    `. Rewrite it as a full sentence with something happening in it, or join it to the ` +
    `sentence beside it.`,
  ]
}
