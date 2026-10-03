// The name a firm goes by, for use inside a sentence of a follow-up email.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE RULE (operator note 2 on the fourth reading, 2026-10-02)
//
// Emails 2 and 3 carry light personalisation whenever we hold it: at minimum the company's
// short name, "without 'The', 'Inc.', 'LLC', 'Company' or similar". A data provider stores
// the registered name. Nobody writes "The Northtown Company, Inc. can win more clients".
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SHORTER NAME (operator note 2 on the fifth reading, 2026-10-02)
//
// Until the fifth reading this file held "a market's own word stays": "Northtown
// Consulting" was said in full, on the reasoning that "Consulting" is one market's word
// and no market's words are stripped. The operator replaced that, in these words:
//
//   "Company short names, deterministic: drop trailing generic business words (Consulting,
//   Group, Advisors, Partners, Solutions, legal forms) when the remainder is distinctive;
//   keep the full name if the remainder is a place or a common word; 'your firm' when
//   nothing distinctive remains."
//
// WHY THE OLD RULE WENT. Nobody says "Kessel Consulting" in the middle of a sentence about
// that firm. Its own people say "Kessel", and so does anyone who has dealt with it. The
// registered style, said in full every time, is how a database talks, and a follow-up that
// talks like a database has shown the reader the merge.
//
// WHY A PLACE OR A COMMON WORD KEEPS THE FULL NAME. Dropping "Consulting" is safe only
// while what is left still points at one firm. "Kessel" does. "Summit" does not: it is a
// word before it is a name, and "so Summit can win the right clients" reads as a sentence
// with something missing. "Denver" is worse, because it is a city, and the sentence is
// then about the city. In both, the generic word is the part that makes the name a firm's
// name, so it stays. The full name is never the wrong thing to call a firm. It is only
// longer.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IT DOES, AND WHAT IT REFUSES TO DO
//
// It only ever REMOVES words, and only from the two ends: a leading article, a bracketed
// tag, and words at the end. It never reorders, and it never picks "the distinctive word"
// out of the middle of a name, because that is a guess about what a firm calls itself
// ("Higher Ground Design" is not "Higher"), and a wrong name in a sentence is worse than
// no name.
//
// STEP ONE, THE FULL NAME. A leading "The", bracketed tags and trailing legal or corporate
// forms come off, with the "and" or "&" that joined a form on ("Smith and Co") and any
// comma left hanging. What is left is the firm's name as the record holds it: "Kessel
// Consulting", "Northtown Design".
//
// STEP TWO, THE REMAINDER. Trailing GENERIC BUSINESS WORDS come off the full name, one
// after another, from the end. There are two classes, and the difference matters once:
//
//   ENTITY words   say that a business exists: Group, Partners, Associates, Holdings ...
//   SERVICE words  say that it sells services, in general: Consulting, Advisory,
//                  Solutions ... and, with them, every one of the calling client's OWN
//                  generic words: the words true of every firm that client writes to,
//                  from its brief. A client that writes to hauliers gets "Kessel" from
//                  "Kessel Haulage". Another client gets "Kessel Haulage".
//
// An "and" or "&" left at the end goes with the word it joined on. Where that word was an
// ENTITY word ("Marlow & Associates") the other side of the join is the name, and it
// stays. Where it was a SERVICE word, the other side may be a trade joined to it: "Vantor
// Surveying & Consulting" is the name "Vantor" and a description, "Surveying &
// Consulting". The trade word goes too, but ONLY in the one shape code can read:
//
//   - exactly ONE word stands in front of the joined word, and
//   - the joined word is a common English word. (One of the client's generic words goes
//     as well, in any shape, because it is a service word in its own right.)
//
// So "Kessel Tax & Advisory" is "Kessel". "Kessel Real Estate & Advisory" is "Kessel Real
// Estate": two words stand in front, and taking one of them cut a two-word trade in half
// ("Kessel Real"). "Kessel Trennick & Advisors" is "Kessel Trennick": a joined word on no
// list may be a partner's surname. THE KNOWN COST: a trade word on no list is kept too
// ("Kessel Haulage" from "Kessel Haulage & Consulting", for a client whose list does not
// hold "haulage"), and a partner whose surname is a common word is dropped ("Kessel" from
// "Kessel Marsh & Advisors"). Code cannot tell a name from a trade except by the lists.
//
// A LIST OF TRADES goes the same way (the second round of the review, 2026-10-02): "Kessel
// Tax, Audit & Advisory" is "Kessel". The words in front of the joined word that end in a
// comma are the list's other items, and they all go under the same two conditions: ONE
// word stands in front of the whole list, and every item is a common word. Otherwise the
// comma stays in the remainder, the remainder cannot be said, and neither can the full
// name, so it is "your firm" ("Kessel Trennick, Tax & Advisory").
//
// STEP THREE, WHICH OF THE TWO IS SAID. The remainder, when it is DISTINCTIVE. It is, when
// both of these hold:
//
//   - taken whole it is not a place ("New York", "North Texas", "Greater Manchester"), nor
//     a nationality, a weekday or a month ("American", "Friday"), which are treated as
//     places (place-names.data.ts, beside this file)
//   - at least ONE of its words is distinctive: three characters or more, and not a place,
//     not a common English word (common-words.data.ts), not one of the calling client's
//     generic words and not one of the firm's OWN TRADE WORDS (see below)
//
// Two readings of "a word" were added by the second round of the review (2026-10-02):
//
//   - a word INSIDE A LISTED PLACE OF SEVERAL WORDS is not distinctive: any run of two
//     words or more that is a place taken whole. "Los Angeles Tax Advisors" keeps its full
//     name, where "los" and "angeles" alone are on no list and it went out as "Los Angeles
//     Tax". "Kessel Hong Kong Consulting" is still "Kessel Hong Kong", through "Kessel"
//   - a HYPHENATED word is distinctive only when, with its hyphens read as spaces, it is
//     not a place taken whole, and at least one of its parts is distinctive. "Asia-Pacific",
//     "Real-Estate" and "North-Texas" are not; "Marlow-Kessel" is
//
// and when it passes every refusal below. So a remainder of one word and a remainder of
// several are held to the same test. "Kessel Marsh" is distinctive by "Kessel". "Real
// Estate", "Human Resources" and "IT Support" are not, and neither is "Quiet Harbour":
// every word is ordinary, and code cannot tell a brand made of two ordinary words from a
// trade said in two words. All of them keep the full name, which is never wrong.
//
// Otherwise the full name, held to the same refusals. And "your firm" (null) in three
// cases where there is nothing to say:
//
//   - NOTHING is left, because every word of the name was a generic business word
//     ("Consulting Group")
//   - nothing generic came off, and the name is ONE word that is not distinctive: "Denver
//     Ltd", "The Summit Company", "Orchard GmbH", "Smith and Co". There is no longer form
//     to fall back to. THIS CHANGED ON THE FIFTH READING: until then a one-word name was
//     said as it stood, common word or not. The price is a surname that is also an
//     ordinary word or a place ("Brown Ltd", "Jackson Ltd"), which becomes "your firm"
//   - nothing generic came off, and the name is a PLACE in any number of words: "New York
//     Ltd", "Greater Manchester LLC"
//
// A name of several words that nothing came off is otherwise said as it stands, ordinary
// words or not ("Higher Ground Design", "Real Estate Ltd" as "Real Estate"). It is the
// whole of what the firm is called, and this file does not question a whole name.
//
// THE FIRM'S OWN TRADE WORDS (the review of the fifth reading). The common-word list holds
// everyday English, so much trade vocabulary is on neither list: "logistics", "analytics",
// "telecom", and every acronym. "Logistics Solutions" went out as "Logistics". A longer
// list of trades would be one market's wording, so the answer is BUILT FROM STORED DATA:
// compose-sequence passes the firm's stored industry and keywords, firmTradeWords makes
// the trade words from them, and a word that is one of them is not distinctive. With
// "logistics" among them "Logistics Solutions" keeps its full name. They never come off a
// name; they only stop a word being said alone.
//
// THEY ARE COMPARED IN ONE FORM (the second round of the review, 2026-10-02). A word of a
// name is split on its hyphens and read with its digits, as the record's text is, so
// "E-Commerce" meets the tag "E-Commerce" and "3PL" meets "3PL". And a word of four
// characters or more that is the start of a trade word, or that a trade word of four or
// more is the start of, is one: "Telecom" against "telecommunications", "Logistic"
// against "logistics". Four, because a three-letter trade word would take a name with it
// ("law" and "Lawson").
//
// AN ACRONYM IS A NAME, AND CODE CANNOT TELL "QTX" FROM "CRM". A remainder of one word in
// capitals, three to five letters, is said unless it spells a listed word (ACE, USA): the
// operator's own example of a name that must shorten has that shape. "CRM Consulting" has it too, and with no trade words given
// it goes out as "CRM". The trade words are what catch it: when the record's keywords
// hold CRM, "CRM Consulting" keeps its full name. When they do not, nothing here can know.
// The other cost of the trade words: a record whose keywords hold the firm's own name
// keeps that firm at its full name. That is the safe side.
//
// It returns null, and the email keeps its slot-free wording, whenever what would be said
// reads badly in a sentence or is not a name at all. These apply to the remainder and to
// the full name alike, except where one says otherwise:
//
//   - nothing left, or one letter
//   - more than four words, or more than 32 characters: a name that long crowds the line
//     it sits in, and the templates are validated against a four-word name. A full name
//     over the cap is still said by its remainder when the remainder fits AND is
//     distinctive; when it is not, there is nothing to say
//   - ANY WORD THAT IS NOT PLAIN LETTERS AND DIGITS, with an apostrophe, a hyphen or a full
//     stop allowed INSIDE it ("O'Neill", "Northtown-West", "Northtown.io"). So no dash
//     standing between words, no comma, slash, colon, quote mark or symbol, and no word
//     ending in a full stop, "!" or "?". See THE REVIEW below for why this is a rule about
//     what a word may be, and no longer a list of marks to refuse.
//   - ENDING ON A WORD NO NAME ENDS ON: of, for, in, at, by, to, the, a, an, and, with,
//     on, from, or, and the joins and particles of other languages (en, und, og, och, et,
//     y, e, de, van, von; the second round of the review). A remainder that ends that way
//     was cut in the middle of a phrase ("Institute of", "Kessel School of", "Kessel en"),
//     so the full name is said ("Institute of Consulting", "Kessel en Partners"). A full
//     name that ends that way is not said at all ("Harrowby The", "Northtown And"). THE
//     COST: a firm whose name really ends on one of them ("Studio A", "Check In", "Kessel
//     Van") is "your firm". Title case writes the article and the letter the same way
//   - written all in capitals (longer than a five-letter acronym) or with no capital at
//     all: the record's casing is not how the firm writes itself, and code will not guess
//     the case. THE CAPITALS ARE READ ON THE FULL NAME FIRST, before anything comes off:
//     "DOYLE CONSULTING" is a record typed in capitals, and with "CONSULTING" gone the
//     five letters left read as an acronym. So a full name in capitals is "your firm"
//     whatever its remainder. A mixed-case record keeps its acronym: "KMR Consulting" is
//     "KMR", and a full name that is itself short ("DOYLE Ltd", "IBX") is still one
//   - made only of words that name no firm in particular ("Services Partners"): judged by
//     the caller's own generic words, the same list the firm-fact kind check uses
//   - a value a record holds where there is no firm ("Self-employed", "Confidential")
//   - the reader's own name ("Jane Marlow Ltd" written to Jane Marlow). This is why "Marlow
//     Consulting" written to a Marlow stays "Marlow Consulting": the remainder is the
//     reader, so the full name is said. Titles, one-letter initials and a possessive are
//     set aside first, so "J Marlow", "Jane M. Marlow" and "Marlow's" are the reader too.
//     NOT MODELLED: a firm named by initials alone ("K & M Consulting"). For a client
//     whose generic words hold "consulting" it is "your firm", as it was before
//
// Two things ARE allowed that an earlier version refused, because they are how firms are
// named and the sentence reads correctly with them: one "&" standing between two words
// ("Marlow & Kessel"), and a bracketed tag, which is dropped ("Northtown (UK) Ltd").
//
// ═════════════════════════════════════════════════════════════════════════════
// THE REVIEW OF 2026-10-02, and why the rule is an allow-list
//
// The first version refused a list of marks: & , / ( ) [ ] : | + ". Every one of these then
// went out in a sentence, measured on the pure function:
//
//   "Northtown – A Hartwell Company"  ->  "what Northtown – A Hartwell sells"   a dash, and a cut name
//   "Kessel Bros."                    ->  "what Kessel Bros. Sees?"            the full stop ends
//   "Northtown Sp. z o.o."            ->  "Northtown Sp. Z o.o. Has seen"      a sentence, and the
//                                                                              next word is capitalised
//   "Self-employed"                   ->  "what Self-employed sells"
//
// A list of what to refuse is as long as the things nobody thought of. A rule about what a
// word of a name MAY be has no such tail: anything else is refused, and the email keeps its
// slot-free wording, which is the safe side.
//
// THE LISTS ARE LISTS, and the paragraph above applies to them. A place nobody listed, a
// nationality nobody listed and a word above the common-word cut all pass as names. They
// are allowed to be lists because of which way they fail: a hit costs nothing, because the
// full name is never wrong, and a miss costs one sentence that calls a firm by a town or
// by an ordinary word. That cost is NEW with the fifth reading. Before it nothing was
// shortened and every such firm was called by its full name, so it is worth keeping small.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE REVIEW OF THE FIFTH READING, 2026-10-02: what a table of 237 invented names found
//
// The shorter name was run over 237 names by shape, each put through both follow-up
// sentences. Every row below went out before this review. Each is now a planted test.
//
//   "Human Resources Consulting"  ->  "so Human Resources can win the right clients"
//   "North Texas Advisors"        ->  "Does that match what North Texas sees?"
//   "Institute of Consulting"     ->  "so Institute of can win the right clients"
//   "American Consulting Group"   ->  "so American can win the right clients"
//   "Logistics Solutions"         ->  "so Logistics can win the right clients"
//   "Kessel Real Estate & Advisory"  ->  "Kessel Real"
//   "DOYLE CONSULTING"            ->  "DOYLE"
//   "J Marlow Consulting", written to Jane Marlow  ->  "J Marlow"
//
// One mistake sits under the first three: a remainder of two words or more was never read
// word by word, so anything of two words was a name. The rule now asks of every remainder
// whether ONE word in it could only be this firm's. The fourth and fifth are words that
// were on no list: the nationalities, weekdays and months are now closed sets beside the
// places, and a firm's trade comes from its own record.
//
// KNOWN LIMITS, measured after the fix and left as they are:
//
//   - a trade word on neither list, with no trade words passed or none that match, is
//     still said alone: "Analytics Consulting" as "Analytics", "SEO Consultants" as "SEO"
//   - a common word above the list's cut is a name: "Catalyst Solutions" is "Catalyst"
//   - a region whose every word is on no list ("Hudson" and "Thames" were added; the next
//     river was not), and a demonym of a place that is on no list
//   - a trade word under four characters that is only the start of the firm's trade word
//   - a name of several ordinary words that nothing came off is said whole
//
// RULE ZERO. The entity words and the legal forms are the same in every market. The
// service words are the ones that say "sells services" in any market, and they are here by
// the operator's instruction of the fifth reading, not as one market's trade. A market's
// OWN word is never written in this file: it comes from the calling client's brief, so
// "Vantor Marketing" stays as it is for every client whose list does not call marketing
// generic, and a firm's own trade comes from that firm's record. The words no name ends
// on and the grammar words are English grammar, not a trade. The values that are not a
// firm's name are the same in every market too.

import { kindIsGeneric } from '@/lib/agents/research/firm-fact-checks'
import { COMMON_ENGLISH_WORDS } from '@/lib/composition/common-words.data'
import { DEMONYMS_AND_CALENDAR_WORDS, PLACE_NAMES, PLACE_QUALIFIERS } from '@/lib/composition/place-names.data'

/** A leading article is not part of how a name is said inside a sentence. */
const LEADING_ARTICLE = /^the\s+/i

/**
 * Trailing words for a legal or corporate form, with or without full stops. Applied
 * repeatedly from the end: "Northtown Holdings Co., Ltd." loses "Ltd." and then "Co.".
 */
const TRAILING_FORMS = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'llp', 'lp', 'plc', 'pllc', 'pc', 'corp', 'corporation',
  'co', 'company', 'gmbh', 'ag', 'sa', 'sas', 'srl', 'bv', 'nv', 'pty', 'pte', 'pvt', 'oy', 'ab', 'as',
])

/**
 * ENTITY words: they say a business exists and nothing about it. The same in every market.
 * "company" and "co" are legal forms too, and are here for the name that carries one in
 * front of another generic word ("Kessel Co. Consulting"), which the forms pass above
 * never reaches.
 */
const ENTITY_WORDS = new Set([
  'group', 'partners', 'partner', 'associates', 'holdings', 'enterprises', 'ventures', 'international', 'worldwide',
  'global', 'industries', 'collective', 'company', 'co',
])

/**
 * SERVICE words: they say a firm sells services, in general, and not which. The calling
 * client's own generic words are treated as service words beside these.
 */
const SERVICE_WORDS = new Set([
  'consulting', 'consultants', 'consultancy', 'consultancies', 'advisors', 'advisers', 'advisory', 'solutions',
  'services',
])

/** The word that joins a trailing word on: "Marlow & Associates", "Smith and Co". */
const JOIN = /^(?:and|&)$/i

/**
 * A word no name ends on: a preposition, an article or a join. A name that stops on one
 * was cut in the middle of a phrase ("Institute of", "Ask The"), and the sentence it sits
 * in is broken: "so Institute of can win the right clients". Grammar words, the same in
 * every market. "&" is here for completeness; the word rule refuses it at an end.
 *
 * The second line was added by the second round of the review (2026-10-02): the joins and
 * particles of the other languages firms are named in, and three more English ones.
 * "Kessel en Partners" (Dutch) and "Kessel og Partners" (Nordic) are ordinary names, and
 * each went out as "Kessel en". THE COST: a name that really ends on one of them is said
 * in full where it has a generic word to fall back to, and is "your firm" where it has
 * not ("Kessel Van Ltd", where "Van" is the vehicle).
 */
const NEVER_THE_LAST_WORD = new Set([
  'of', 'for', 'in', 'at', 'by', 'to', 'the', 'a', 'an', 'and', '&',
  'en', 'und', 'og', 'och', 'et', 'y', 'e', 'de', 'van', 'von', 'with', 'on', 'from', 'or',
])

/**
 * Grammar words, set aside when a firm's stored industry and keywords are read for its
 * trade words: "Logistics and Supply Chain" is three trade words, not four. English
 * grammar words of three letters or more; shorter words are dropped by length.
 */
const GRAMMAR_WORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'into', 'our', 'your', 'you', 'their', 'that', 'this', 'are', 'not', 'all', 'any',
  'but', 'nor', 'per', 'via', 'its', 'other', 'etc',
])

/** A name with no lower-case letter is an acronym up to this many letters, and a record typed in capitals above it. */
const ACRONYM_MAX_LETTERS = 5

/** The shortest single word that can stand as a firm's name. "QX" is initials, not a name. */
const ONE_WORD_NAME_MIN_CHARS = 3

/** The longest name used in a sentence, in words and in characters. */
export const COMPANY_SHORT_NAME_MAX_WORDS = 4
export const COMPANY_SHORT_NAME_MAX_CHARS = 32

const bare = (word: string) => word.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * A name in the form the two lists are written in: lower case, accents folded, no full
 * stops. So "Zürich" is looked up as "zurich" and "St. Louis" as "st louis".
 */
const listForm = (text: string) =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim()

/** A bracketed tag in a record: "(UK)", "(Pty)", "[Holdings]". Dropped, like a legal form. */
const BRACKETED_TAG = /\s*[([][^()[\]]*[)\]]\s*/g

/**
 * One word of a name: letters and digits, with an apostrophe, a hyphen or a full stop
 * allowed between them. Nothing at either end, so "Bros." and "Northtown!" are not words
 * of a name, and a dash standing alone is not a word at all.
 */
const NAME_WORD = /^[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*$/u

/** An abbreviation that keeps its full stop: allowed only where a capital follows ("St. James"). */
const ABBREVIATION = /^[\p{L}]{1,4}\.$/u

/**
 * What a record holds where there is no firm. The same in every market. Compared with the
 * whole of what is left, in lower case, with hyphens read as spaces.
 */
const NOT_A_FIRM = new Set([
  'self employed', 'selfemployed', 'freelance', 'freelancer', 'freelancing', 'confidential', 'stealth',
  'stealth startup', 'stealth mode', 'unknown', 'none', 'na', 'not applicable', 'independent', 'independent consultant',
  'consultant', 'contractor', 'retired', 'unemployed', 'private', 'various', 'student', 'tbd', 'tbc', 'home', 'myself',
  'self', 'open to work', 'looking for work', 'seeking opportunities',
])

/** Titles and letters after a name. Set aside when asking whether a firm's name is the reader's own. */
const PERSON_TITLES = new Set(['dr', 'prof', 'professor', 'mr', 'mrs', 'ms', 'miss', 'mx', 'sir', 'phd', 'md', 'mba', 'cpa', 'esq', 'jr', 'sr'])

type Reader = { firstName?: string | null; lastName?: string | null }

const NO_TRADE_WORDS: ReadonlySet<string> = new Set()

/**
 * THE FIRM'S OWN TRADE WORDS, from what its record already holds: the stored industry and
 * the stored keyword tags. Lower case, accents folded, split wherever a character is not
 * a letter or a digit, words of three characters or more, grammar words left out. So
 * "Logistics and Supply Chain" with the tags "Freight Forwarding", "CRM", "E-Commerce" and
 * "3PL" gives logistics, supply, chain, freight, forwarding, crm, commerce, 3pl. (Digits
 * are kept since the second round of the review, 2026-10-02: "3PL" lost its digit before
 * and matched nothing.)
 *
 * This is the fourth input of companyShortName, and it is BUILT FROM STORED DATA on
 * purpose (the review of the fifth reading, 2026-10-02). The other way to stop "Logistics
 * Solutions" going out as "Logistics" is a longer list of trade vocabulary, and a list of
 * trades is one market's wording by another name. The record says what this firm's trade
 * is, in any market, and nothing is hardcoded here.
 *
 * Deterministic: no model call.
 */
export function firmTradeWords(industry: string | null | undefined, keywords: readonly string[] | null | undefined): Set<string> {
  const texts = [industry, ...(keywords ?? [])].filter((text): text is string => typeof text === 'string')
  return new Set(
    texts.flatMap(text => tradeForm(text).split(' ')).filter(word => word.length >= 3 && !GRAMMAR_WORDS.has(word)),
  )
}

/**
 * The one form a trade word is compared in, on both sides: the form of the lists, with
 * anything that is not a letter or a digit read as a space. firmTradeWords splits a
 * record's text on those spaces, and a word of a name is split on its hyphens before it
 * is compared, so "E-Commerce" in a name meets "E-Commerce" in a tag as "commerce".
 */
const tradeForm = (text: string) => listForm(text).replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * A shorter word is read as the start of a longer one from this many characters: "Telecom"
 * is the trade word "telecommunications", and "Logistic" is "logistics". Below it a
 * three-letter trade word would swallow a name ("law" and "Lawson").
 */
const TRADE_PREFIX_MIN_CHARS = 4

/** Is this word of a name (one hyphen part of it) one of the firm's own trade words? */
function isATradeWord(word: string, tradeWords: ReadonlySet<string>): boolean {
  const form = tradeForm(word).replace(/ /g, '')
  if (form.length === 0) return false
  if (tradeWords.has(form)) return true
  for (const trade of tradeWords) {
    const [shorter, longer] = form.length <= trade.length ? [form, trade] : [trade, form]
    if (shorter.length >= TRADE_PREFIX_MIN_CHARS && longer.startsWith(shorter)) return true
  }
  return false
}

/** The letters and digits of a word: what the three-character floor counts. */
const lettersAndDigits = (word: string) => (word.match(/[\p{L}\p{N}]/gu) ?? []).length

/** A name with no lower-case letter in it, longer than an acronym: a record typed in capitals. */
function typedInCapitals(name: string): boolean {
  const letters = name.replace(/[^\p{L}]/gu, '')
  return letters.length > ACRONYM_MAX_LETTERS && !/\p{Ll}/u.test(letters)
}

/**
 * Is this, taken whole, a place? A listed place, a nationality, weekday or month (treated
 * as a place: see place-names.data.ts), or a qualifier in front of one: "North Texas",
 * "Greater Manchester", "North West England". The qualifier rule is why those regions are
 * not on the list.
 */
function isAPlace(words: string[]): boolean {
  if (words.length === 0) return false
  const whole = listForm(words.join(' '))
  if (PLACE_NAMES.has(whole) || DEMONYMS_AND_CALENDAR_WORDS.has(whole)) return true
  return PLACE_QUALIFIERS.has(listForm(words[0])) && isAPlace(words.slice(1))
}

/** The front halves of compound place and people adjectives: "Indo-", "Sino-", "Trans-". Grammar of English, not any market's words. */
const COMBINING_FORMS = new Set([
  'pan', 'trans', 'inter', 'intra', 'mid', 'indo', 'sino', 'euro', 'afro', 'franco', 'anglo',
  'austro', 'greco', 'ibero', 'russo', 'italo', 'hispano', 'luso', 'judeo', 'nordo', 'balto',
])

/** What a remainder is judged against: the caller's two word sets, each in the form it is looked up in. */
type WordSets = { clientWords: ReadonlySet<string>; tradeWords: ReadonlySet<string> }

/**
 * Can this ONE word be what makes a remainder a firm's name? Not when it is under three
 * characters ("IT", "of", "QX"), a place, a common English word, one of the calling
 * client's generic words, or one of the firm's own trade words.
 *
 * A HYPHENATED WORD (the second round of the review, 2026-10-02) is on no list as it
 * stands, so "Asia-Pacific", "Real-Estate" and "North-Texas" were each a name. It is now
 * distinctive only when, with its hyphens read as spaces, it is not a place taken whole,
 * AND at least one of its parts is distinctive by this same test. "Marlow-Kessel" is,
 * through "Kessel". A place listed with its hyphen ("Winston-Salem") is caught first.
 */
function wordIsDistinctive(word: string, sets: WordSets): boolean {
  if (lettersAndDigits(word) < ONE_WORD_NAME_MIN_CHARS) return false
  const listed = listForm(word)
  if (PLACE_NAMES.has(listed) || DEMONYMS_AND_CALENDAR_WORDS.has(listed) || COMMON_ENGLISH_WORDS.has(listed)) return false
  const parts = word.split('-').filter(Boolean)
  // "Indo-Pacific", "Trans-Atlantic", "Afro-Caribbean": every part a place, a demonym or a
  // combining form that only ever joins one (merge review, 2026-10-02).
  if (parts.length > 1 && parts.every(part => isAPlace([part]) || COMBINING_FORMS.has(listForm(part)))) return false
  if (parts.length > 1) return !isAPlace(parts) && parts.some(part => wordIsDistinctive(part, sets))
  return !sets.clientWords.has(bare(word)) && !isATradeWord(word, sets.tradeWords)
}

/** A comma left hanging on the last word, where the word after it was removed. */
function withoutHangingComma(words: string[]): string[] {
  return words.join(' ').replace(/[,;]+$/, '').trim().split(/\s+/).filter(Boolean)
}

/**
 * STEP TWO: the full name with its trailing generic business words removed. May be empty,
 * which means every word of the name was one.
 */
function withoutGenericWords(full: string[], clientWords: ReadonlySet<string>): string[] {
  let words = full
  for (;;) {
    const last = words[words.length - 1]
    if (last === undefined) return words
    const sellsServices = SERVICE_WORDS.has(bare(last)) || clientWords.has(bare(last))
    if (!sellsServices && !ENTITY_WORDS.has(bare(last))) return words
    words = words.slice(0, -1)
    if (JOIN.test(words[words.length - 1] ?? '')) {
      words = words.slice(0, -1)
      // "Vantor Surveying & Consulting": the word joined to a service word is a trade, and
      // part of the description, so it goes too. But ONLY in the one shape code can read:
      // exactly one word in front of it (the name), and the joined word a common word
      // (so, not a surname). The review of the fifth reading found the looser rule
      // sending "Kessel Real" for "Kessel Real Estate & Advisory", one word of a two-word
      // trade, and "Kessel" for "Kessel Trennick & Advisors", where the joined word is a
      // partner. Anywhere else the join and the service word go and the rest stays.
      // Never the only word left: "Tax & Advisory" keeps "Tax", and is then said in full,
      // because "Tax" alone is a common word.
      // A joined word that is one of the CLIENT's generic words needs no test here. It is
      // a service word, so the loop takes it on its next turn, in any shape.
      //
      // A LIST OF TRADES (the second round of the review, 2026-10-02): "Kessel Tax, Audit &
      // Advisory". The words in front of the joined one that end in a comma are the list's
      // other items, and they go with it under the same two conditions: exactly one word
      // stands in front of the whole list, and every item is a common word. Before this the
      // comma stayed in the remainder and the firm was "your firm" by accident.
      let first = words.length - 1
      while (first > 1 && /,$/.test(words[first - 1] ?? '')) first--
      const items = words.slice(first).map(word => listForm(word.replace(/,$/, '')))
      if (sellsServices && first === 1 && items.every(item => COMMON_ENGLISH_WORDS.has(item))) words = words.slice(0, 1)
    }
    words = withoutHangingComma(words)
  }
}

/**
 * STEP THREE: does the remainder still point at one firm? Not when, taken whole, it is a
 * place. And otherwise only when at least ONE of its words is distinctive: three
 * characters or more, not a place, a common word, a client generic word or one of the
 * firm's own trade words, and not inside a run of words that is a place.
 *
 * Until the review of the fifth reading any remainder of two words or more was a name,
 * on the reasoning that common words together are nobody else's. "Real Estate", "Human
 * Resources" and "North Texas" are common words together, and each went out as the firm.
 * Code cannot tell those from "Quiet Harbour", so all of them keep the full name.
 *
 * A remainder cut mid-phrase ("Kessel School of") is NOT refused here. nameForASentence
 * refuses any name that ends that way, and a remainder it refuses falls back to the full
 * name. A second test here would never be the one that decides.
 */
function remainderIsDistinctive(remainder: string[], sets: WordSets): boolean {
  if (isAPlace(remainder)) return false
  return remainder.some((word, i) => !insideAPlaceOfSeveralWords(remainder, i) && wordIsDistinctive(word, sets))
}

/**
 * Does the word at this position sit inside a run of two or more words that, taken whole,
 * is a place? Added by the second round of the review (2026-10-02): "Los Angeles" was
 * looked up only when it was the WHOLE remainder, so in "Los Angeles Tax" each word was
 * read alone, "los" and "angeles" are on no list, and the firm went out as "Los Angeles
 * Tax". A word of a listed place is no more distinctive than the place. "Kessel Hong Kong"
 * is still a name, through "Kessel".
 */
function insideAPlaceOfSeveralWords(words: string[], i: number): boolean {
  for (let start = 0; start <= i; start++) {
    for (let end = Math.max(i + 1, start + 2); end <= words.length; end++) {
      if (isAPlace(words.slice(start, end))) return true
    }
  }
  return false
}

/**
 * The words as one name, or null when they would read badly in a sentence or are not a
 * firm's name at all. Every refusal in the file header that is about what is SAID lives
 * here, and it is applied to a remainder and to a full name alike.
 */
function nameForASentence(words: string[], clientGenericWords: ReadonlySet<string>, reader: Reader): string | null {
  const name = words.join(' ')
  if (name.length < 2) return null
  if (words.length > COMPANY_SHORT_NAME_MAX_WORDS || name.length > COMPANY_SHORT_NAME_MAX_CHARS) return null
  // EVERY WORD IS A WORD OF A NAME. One "&" between two words, and an abbreviation with a
  // capital after it, are the two exceptions; see the file header.
  const wordIsSound = (word: string, i: number) =>
    NAME_WORD.test(word)
    || (word === '&' && i > 0 && i < words.length - 1 && words.filter(w => w === '&').length === 1)
    || (ABBREVIATION.test(word) && /^\p{Lu}/u.test(words[i + 1] ?? ''))
  if (!words.every(wordIsSound)) return null
  // CUT MID-PHRASE. A name that stops on "of", "the" or "and" is not a name. For a
  // remainder this sends the caller back to the full name ("Institute of Consulting").
  // For a full name there is nothing to go back to ("Harrowby The").
  if (NEVER_THE_LAST_WORD.has(words[words.length - 1].toLowerCase())) return null
  // A small word of any language at the end is lower case ("Kessel i Partners", "Kessel ja
  // Partners", cut to "Kessel i"): a list of them is never complete, so a name of more than
  // one word may not END on a lower-case word at all (merge review, 2026-10-02).
  if (words.length > 1 && /^\p{Ll}/u.test(words[words.length - 1])) return null
  const letters = name.replace(/[^\p{L}]/gu, '')
  if (letters.length === 0) return null
  const hasUpper = /\p{Lu}/u.test(letters)
  // A name may open a sentence, and code capitalises a sentence's first letter: a name
  // styled with a lower-case first letter would be respelled, so it is not used.
  if (!/^[\p{Lu}\d]/u.test(name)) return null
  if (!hasUpper) return null
  if (typedInCapitals(name)) return null
  if (NOT_A_FIRM.has(name.toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ')) || NOT_A_FIRM.has(bare(name))) return null
  // THE READER'S OWN NAME. "Does that match what Jane Marlow sees?" under the greeting
  // "Jane" is a mail merge showing. A sole practitioner's firm is often their name plus a
  // legal form, and the form has just been removed. Titles, initials ("J Marlow", "Jane M.
  // Marlow") and a possessive ("Marlow's") are set aside before comparing: none of them
  // makes the reader's name somebody else's.
  const own = [reader.firstName, reader.lastName].flatMap(n => (typeof n === 'string' ? n.split(/\s+/) : [])).map(bare).filter(Boolean)
  const nameWords = words.map(w => bare(w.replace(/['’]s$/i, ''))).filter(w => w.length > 1 && !PERSON_TITLES.has(w))
  if (own.length > 0 && nameWords.length > 0 && nameWords.every(w => own.includes(w))) return null
  // "Services Partners", "Haulage Logistics" for a client that writes to hauliers: every
  // word names no firm in particular.
  if (kindIsGeneric(`a ${name.toLowerCase()}`, clientGenericWords)) return null
  return name
}

/**
 * The firm's name as a follow-up says it, or null for "your firm". See the file header.
 *
 * @param clientGenericWords  the CALLING CLIENT's generic words, from its brief: true of
 *                            every firm that client writes to. They come off the end of
 *                            a name like service words.
 * @param reader              who the email is written to, so a firm named after them is
 *                            not written back to them in the third person.
 * @param tradeWords          THIS FIRM's own trade words, from its stored industry and
 *                            keywords: build them with firmTradeWords. Optional. They
 *                            never come off a name. They only stop a word being said
 *                            alone: with "logistics" among them, "Logistics Solutions"
 *                            keeps its full name. Left out, the function behaves as it
 *                            did before the parameter existed.
 */
export function companyShortName(
  companyName: string | null | undefined,
  clientGenericWords: ReadonlySet<string>,
  reader: Reader = {},
  tradeWords: ReadonlySet<string> = NO_TRADE_WORDS,
): string | null {
  if (typeof companyName !== 'string') return null
  // STEP ONE: the full name.
  let words = companyName.replace(BRACKETED_TAG, ' ').trim().replace(LEADING_ARTICLE, '').split(/\s+/).filter(Boolean)
  // Strip trailing forms, and the "and" or "&" that joined one on ("Smith and Co").
  for (;;) {
    const last = words[words.length - 1]
    if (last === undefined) return null
    if (TRAILING_FORMS.has(bare(last)) && words.length > 1) {
      words = words.slice(0, -1)
      const join = words[words.length - 1]
      if (join !== undefined && JOIN.test(join)) words = words.slice(0, -1)
      continue
    }
    break
  }
  // A comma left hanging where a form was removed ("Northtown Design," from "..., Inc.").
  const full = withoutHangingComma(words)
  // A RECORD TYPED IN CAPITALS, decided on the FULL name. Taking "CONSULTING" off "DOYLE
  // CONSULTING" leaves five letters, which read as an acronym, and the evidence that it
  // was the record and not the firm in capitals went with the word. So it is read here,
  // before anything comes off. A name that is short in full ("DOYLE Ltd", "IBX") is still
  // an acronym, and a mixed-case record keeps its own ("KMR Consulting" is "KMR").
  if (typedInCapitals(full.join(' '))) return null
  const sets: WordSets = {
    clientWords: new Set([...clientGenericWords].map(bare).filter(Boolean)),
    tradeWords: new Set([...tradeWords].map(word => tradeForm(word).replace(/ /g, '')).filter(Boolean)),
  }
  // STEP TWO: the remainder.
  const remainder = withoutGenericWords(full, sets.clientWords)
  // NOTHING DISTINCTIVE REMAINS. Every word was a generic business word ("Consulting
  // Group", "The Company"), so there is no name here to say, in full or in short.
  if (remainder.length === 0) return null
  // STEP THREE. A distinctive remainder that fails a refusal (the reader's own name, a
  // word typed in capitals, a name cut mid-phrase) falls back to the full name, which
  // may still pass.
  const distinctive = remainderIsDistinctive(remainder, sets)
  if (distinctive) {
    const short = nameForASentence(remainder, clientGenericWords, reader)
    if (short !== null) return short
  }
  // A FULL NAME WITH NOTHING DISTINCTIVE IN IT, AND NO GENERIC WORD THAT MAKES IT A FIRM'S.
  // There is no longer form to fall back to, and two shapes have nothing to say:
  //   - a PLACE, in any number of words: "Denver Ltd", "New York Ltd", "Greater Manchester
  //     LLC", "American Ltd"
  //   - ONE word that is not distinctive: a common word, a trade word of the firm's own,
  //     or under three characters. "The Summit Company" is one word once the form is off.
  //     A full name of one word IS its remainder (nothing can have come off and left
  //     something), so the verdict above is the verdict on it.
  // "so Denver can win the right clients" is the sentence the place rule exists to
  // prevent. The operator's rule for this case is "your firm".
  if (isAPlace(full) || (full.length === 1 && !distinctive)) return null
  return nameForASentence(full, clientGenericWords, reader)
}
