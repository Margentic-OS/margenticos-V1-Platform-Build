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
// THE SHORT NAME (the sixth reading, 2026-10-03)
//
// The operator, in his words: "short names drop trailing descriptors and initialisms;
// places and trade words keep the full name". His three examples were a firm's name with
// an initialism and two descriptors after it, said as its first word; a name of two
// ordinary words and a descriptor, said as the two words; and one ordinary word and a
// descriptor, said as the word. All three are real firms' names and are not written here;
// the tests use invented names of the same shapes ("Quillon HCM Consulting Group" is
// "Quillon", "Amber Ridge Consulting" is "Amber Ridge", "Harbour Consulting" is "Harbour").
//
// WHAT CHANGED FROM THE FIFTH READING. Then, a remainder was said only when one of its
// words was on no list of common English words, so "Harbour Consulting" and "Quiet Harbour
// Group" kept their full names: code could not tell a brand of ordinary words from a trade
// said in ordinary words, and the full name was the safe side. The operator's examples are
// exactly those shapes, and he wants them shortened. So A COMMON ENGLISH WORD NO LONGER
// KEEPS THE FULL NAME. What still does is a place, and a trade the firm's OWN RECORD names.
//
// WHY A SHORT NAME AT ALL. Nobody says "Kessel Consulting" in the middle of a sentence about
// that firm. Its own people say "Kessel", and so does anyone who has dealt with it. The
// registered style, said in full every time, is how a database talks, and a follow-up that
// talks like a database has shown the reader the merge.
//
// WHY A PLACE KEEPS THE FULL NAME. "so Denver can win the right clients" is a sentence
// about a city. The generic word is the part that makes "Denver Consulting" a firm's name,
// so it stays. The full name is never the wrong thing to call a firm. It is only longer.
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
// STEP TWO, THE REMAINDER. Trailing words come off the full name, one after another, from
// the end:
//
//   ENTITY words    say that a business exists: Group, Partners, Associates, Holdings ...
//   SERVICE words   say that it sells services, in general: Consulting, Advisory,
//                   Solutions ... and, with them, every one of the calling client's OWN
//                   generic words: the words true of every firm that client writes to,
//                   from its brief. A client that writes to hauliers gets "Kessel" from
//                   "Kessel Haulage". Another client gets "Kessel Haulage".
//   THE FIRM'S OWN  trade words, from its stored industry and keywords (firmTradeWords),
//   TRADE WORDS     taken as service words. With logistics on its record "Kessel
//                   Logistics Solutions" is "Kessel". Never the only word left.
//   INITIALISMS     two to five capitals, letters only, standing after another word:
//                   "Quillon HCM" is "Quillon", "Kessel UK" is "Kessel". Never the only
//                   word left ("The QTX Company" is "QTX"), and never after an "and" or "&",
//                   where it is the other half of a partnership ("Marlow & KMR").
//
// An "and" or "&" left at the end goes with the word it joined on. Where that word was an
// ENTITY word ("Marlow & Associates") the other side of the join is the name, and it
// stays. Where it was a SERVICE word, the other side may be a trade joined to it: "Vantor
// Surveying & Consulting" is the name "Vantor" and a description, "Surveying &
// Consulting". The trade word goes too, but ONLY in the one shape code can read:
//
//   - exactly ONE word stands in front of the joined word, and
//   - the joined word is a common English word (common-words.data.ts). One of the client's
//     generic words or the firm's trade words goes as well, in any shape, because it is a
//     service word in its own right.
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
// AND WHEN NOTHING STANDS IN FRONT ("Tax & Advisory", "Tax, Audit & Advisory"), what is
// left is the trade by this same reading, and a trade keeps the full name (the sixth
// reading). "so Tax can win the right clients" is the sentence that prevents.
//
// STEP THREE, WHICH OF THE TWO IS SAID. The remainder, when at least ONE of its words
// names something: three characters or more, and not a place, a nationality, a weekday or
// a month (place-names.data.ts, beside this file), not one of the calling client's generic
// words and not one of the firm's own trade words. A common English word counts. And when
// it passes every refusal below.
//
//   - a word INSIDE A LISTED PLACE OF SEVERAL WORDS names nothing: any run of two words or
//     more that is a place taken whole. "Los Angeles Advisors" keeps its full name;
//     "Los Angeles Tax Advisors" is "Los Angeles Tax", through "Tax"
//   - a HYPHENATED word names something only when, with its hyphens read as spaces, it is
//     not a place taken whole, and at least one of its parts does. "Asia-Pacific" and
//     "North-Texas" do not; "Real-Estate" and "Marlow-Kessel" do
//   - a remainder that, taken whole, is a place ("New York", "North Texas", "Greater
//     Manchester") names nothing
//
// Otherwise the full name, held to the same refusals. And "your firm" (null) in three
// cases where there is nothing to say:
//
//   - NOTHING is left, because every word of the name was a generic business word
//     ("Consulting Group")
//   - nothing came off, and the name is ONE word that names nothing: "Denver Ltd", "QX
//     Ltd", "Logistics Ltd" for a firm whose record names logistics. Since the sixth
//     reading a common word is a name: "Orchard GmbH" is "Orchard", "Smith and Co" is
//     "Smith"
//   - nothing came off, and the name is a PLACE in any number of words: "New York Ltd",
//     "Greater Manchester LLC"
//
// THE FIRM'S OWN TRADE WORDS (the review of the fifth reading). The record says what this
// firm's trade is, in any market: compose-sequence passes the firm's stored industry and
// keywords, and firmTradeWords makes the trade words from them. A longer list of trade
// vocabulary would be one market's wording by another name, so nothing is hardcoded here.
// They are compared in one form (the second round of the review, 2026-10-02): a word of a
// name is split on its hyphens and read with its digits, so "E-Commerce" meets the tag
// "E-Commerce" and "3PL" meets "3PL", and a word of four characters or more that is the
// start of a trade word, or that a trade word of four or more is the start of, is one
// ("Telecom" against "telecommunications"). Four, because a three-letter trade word would
// take a name with it ("law" and "Lawson").
//
// AN ACRONYM IS A NAME WHEN IT IS THE WHOLE NAME. "CRM Consulting" with no trade words given
// goes out as "CRM", because code cannot tell "QTX" from "CRM". The trade words are what
// catch it: when the record's keywords hold CRM, "CRM Consulting" keeps its full name.
//
// It returns null, and the email keeps its slot-free wording, whenever what would be said
// reads badly in a sentence or is not a name at all. These apply to the remainder and to
// the full name alike, except where one says otherwise:
//
//   - nothing left, or one letter
//   - more than four words, or more than 32 characters: a name that long crowds the line
//     it sits in, and the templates are validated against a four-word name. A full name
//     over the cap is still said by its remainder when the remainder fits and passes; when
//     it does not, there is nothing to say
//   - ANY WORD THAT IS NOT PLAIN LETTERS AND DIGITS, with an apostrophe, a hyphen or a full
//     stop allowed INSIDE it ("O'Neill", "Northtown-West", "Northtown.io"). So no dash
//     standing between words, no comma, slash, colon, quote mark or symbol, and no word
//     ending in a full stop, "!" or "?". See THE REVIEW below for why this is a rule about
//     what a word may be, and no longer a list of marks to refuse.
//   - ENDING ON A WORD NO NAME ENDS ON: of, for, in, at, by, to, the, a, an, and, with,
//     on, from, or, and the joins and particles of other languages (en, und, og, och, et,
//     y, e, de, van, von; the second round of the review), and since the merge review any
//     lower-case word at the end of a name of several words. A remainder that ends that way
//     was cut in the middle of a phrase ("Institute of", "Kessel en"), so the full name is
//     said ("Institute of Consulting", "Kessel en Partners"). A full name that ends that
//     way is not said at all ("Harrowby The", "Northtown And"). THE COST: a firm whose name
//     really ends on one of them ("Studio A", "Check In", "Kessel Van") is "your firm"
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
//   - the reader's own name as a PERSON ("Jane Marlow Ltd" written to Jane Marlow): their
//     first name, or their surname with an initial, a title or a possessive ("J Marlow",
//     "Jane M. Marlow", "Marlow's"). The SURNAME ALONE IS SAID (reading file 7, 2026-10-03):
//     "Marlow Consulting" written to a Marlow is "Marlow", and an entity word straight after
//     the surname stays, so "Marlow Group Consulting" is "Marlow Group".
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
// THE LISTS ARE LISTS. A place nobody listed and a nationality nobody listed pass as names.
// They are allowed to be lists because of which way they fail: a hit costs nothing, because
// the full name is never wrong, and a miss costs one sentence that calls a firm by a town.
//
// ═════════════════════════════════════════════════════════════════════════════
// KNOWN LIMITS, as of the sixth reading
//
//   - A TRADE SAID IN ORDINARY WORDS, which the firm's record does not name, is said alone:
//     "Real Estate Advisors" is "Real Estate", "IT Support Solutions" is "IT Support",
//     "Denver Tax Advisors" is "Denver Tax". The fifth reading's review kept these at their
//     full names through the common-word list; the operator's rule gave that up to shorten
//     brands of ordinary words, and the record's own trade words are what remain. With
//     real estate on the record "Real Estate Advisors" keeps its full name
//   - a trade word on no list, with no trade words passed or none that match, is said
//     alone: "Analytics Consulting" as "Analytics", "SEO Consultants" as "SEO"
//   - the firm's own trade words now COME OFF a name, so a record whose keywords hold the
//     firm's own second word ("Kessel Marsh" with the keyword "Marsh") loses it: "Kessel"
//   - a trailing word of five capitals or fewer is taken for an initialism even where it
//     is an ordinary word typed in capitals ("Kessel ROOFS" is "Kessel")
//   - a region whose every word is on no list, and a demonym of a place that is on no list
//   - a trade word under four characters that is only the start of the firm's trade word
//
// RULE ZERO. The entity words and the legal forms are the same in every market. The
// service words are the ones that say "sells services" in any market, and they are here by
// the operator's instruction of the fifth reading, not as one market's trade. A market's
// OWN word is never written in this file: it comes from the calling client's brief, so
// "Vantor Marketing" stays as it is for every client whose list does not call marketing
// generic, and a firm's own trade comes from that firm's record. An initialism is a shape
// of English writing, not a trade. The words no name ends on and the grammar words are
// English grammar, not a trade. The values that are not a firm's name are the same in every
// market too.

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
 * is, in any market, and nothing is hardcoded here. Since the sixth reading (2026-10-03)
 * the same words also come off the end of a name: "places and trade words keep the full
 * name" means the trade is never what is SAID, and a trade at the end is a descriptor.
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
 * characters ("IT", "of", "QX"), a place or a demonym, one of the calling client's generic
 * words, or one of the firm's own trade words.
 *
 * A COMMON ENGLISH WORD IS ONE, since the sixth reading (2026-10-03). Until then it was
 * not, and "Harbour Consulting" kept its full name. The operator: "short names drop
 * trailing descriptors", with three examples of ordinary words said alone.
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
  if (PLACE_NAMES.has(listed) || DEMONYMS_AND_CALENDAR_WORDS.has(listed)) return false
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
 * A trailing INITIALISM: two to five capitals and nothing else ("HCM", "HR", "UK"). It
 * comes off the end of a name the way a descriptor does (the sixth reading, 2026-10-03:
 * "short names drop trailing descriptors and initialisms"). Letters only, so "B2B" and
 * "SaaS" are not one, and six capitals or more is a word typed in capitals, not an
 * initialism.
 */
const INITIALISM = /^\p{Lu}{2,5}$/u

/**
 * Is this word of a name one of the FIRM'S OWN trade words? Every part of it that is three
 * characters or more must be, so "E-Commerce" is (its "E" is set aside) and "Kessel-Freight"
 * is not.
 */
function isTheFirmsTrade(word: string, tradeWords: ReadonlySet<string>): boolean {
  if (tradeWords.size === 0) return false
  const parts = word.split('-').filter(part => lettersAndDigits(part) >= ONE_WORD_NAME_MIN_CHARS)
  return parts.length > 0 && parts.every(part => isATradeWord(part, tradeWords))
}

/** What step two leaves, and whether what it leaves is a trade joined to a service word. */
type Remainder = { words: string[]; isATrade: boolean }

/**
 * STEP TWO: the full name with its trailing generic words removed. May be empty, which
 * means every word of the name was one.
 *
 * Off the end, one after another: an ENTITY word, a SERVICE word, one of the calling
 * client's generic words, and since the sixth reading (2026-10-03) one of the FIRM'S OWN
 * trade words and an INITIALISM. The last two never take the only word left: a name made
 * only of the firm's trade ("Logistics Solutions") or only of an initialism ("QTX Group")
 * keeps it, and step three decides whether it is said. An initialism with a join in front
 * of it ("Marlow & KMR") is the other half of a partnership and stays.
 */
function withoutGenericWords(full: string[], sets: WordSets): Remainder {
  let words = full
  let isATrade = false
  for (;;) {
    const last = words[words.length - 1]
    if (last === undefined) return { words, isATrade }
    const notTheOnlyWord = words.length > 1
    const sellsServices = SERVICE_WORDS.has(bare(last)) || sets.clientWords.has(bare(last))
      || (notTheOnlyWord && isTheFirmsTrade(last, sets.tradeWords))
    const initialism = notTheOnlyWord && INITIALISM.test(last) && !JOIN.test(words[words.length - 2])
    if (!sellsServices && !initialism && !ENTITY_WORDS.has(bare(last))) return { words, isATrade }
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
      // because "Tax" is marked a trade (below).
      // A joined word that is one of the CLIENT's generic words, or one of the FIRM's own
      // trade words, needs no test here. It is taken as a service word, so the loop takes
      // it on its next turn, in any shape.
      //
      // A LIST OF TRADES (the second round of the review, 2026-10-02): "Kessel Tax, Audit &
      // Advisory". The words in front of the joined one that end in a comma are the list's
      // other items, and they go with it under the same two conditions: exactly one word
      // stands in front of the whole list, and every item is a common word. Before this the
      // comma stayed in the remainder and the firm was "your firm" by accident.
      //
      // NOTHING IN FRONT OF THE LIST (the sixth reading, 2026-10-03): "Tax & Advisory",
      // "Tax, Audit & Advisory". By this rule's own reading the joined words are a trade,
      // and nothing stands in front of them to be the name. Until the sixth reading "Tax"
      // kept the full name because it is a common word; a common word no longer does, so
      // the remainder is marked a trade here, and a trade keeps the full name. The list is
      // read back to the first word for this ("first > 0"), so "Tax," is never taken for
      // a name standing in front of "Audit".
      let first = words.length - 1
      while (first > 0 && /,$/.test(words[first - 1] ?? '')) first--
      const items = words.slice(first).map(word => listForm(word.replace(/,$/, '')))
      const aListOfTrades = sellsServices && items.every(item => COMMON_ENGLISH_WORDS.has(item))
      if (aListOfTrades && first === 1) words = words.slice(0, 1)
      if (aListOfTrades && first === 0) isATrade = true
    }
    words = withoutHangingComma(words)
  }
}

/**
 * STEP THREE: does the remainder still point at one firm? Not when, taken whole, it is a
 * place. And otherwise only when at least ONE of its words is distinctive: three
 * characters or more, not a place or a demonym, not a client generic word or one of the
 * firm's own trade words, and not inside a run of words that is a place.
 *
 * A COMMON WORD COUNTS, since the sixth reading (2026-10-03). The fifth reading's review
 * held that "Real Estate" and "Quiet Harbour" could not be told apart, and kept both at
 * their full names. The operator's rule now says both: "Quiet Harbour", and "Real Estate"
 * unless the firm's own record names real estate as its trade, which is the one place code
 * can learn that it is a trade.
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
 * True when the words are exactly the reader's surname: every word one of its words, each
 * written plainly (no initial, no possessive, no title), and the reader's first name absent.
 */
function isTheReadersSurname(words: string[], reader: Reader): boolean {
  const surname = typeof reader.lastName === 'string' ? reader.lastName.split(/\s+/).map(bare).filter(w => w.length > 1) : []
  if (surname.length === 0 || words.length === 0) return false
  const first = typeof reader.firstName === 'string' ? reader.firstName.split(/\s+/).map(bare).filter(Boolean) : []
  return words.every(word => {
    const b = bare(word)
    return b.length > 1 && /^\p{L}[\p{L}-]*$/u.test(word) && surname.includes(b) && !first.includes(b) && !PERSON_TITLES.has(b)
  })
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
 *                            keywords: build them with firmTradeWords. Optional. Since
 *                            the sixth reading they come off the END of a name as
 *                            service words do ("Kessel Logistics Solutions" is
 *                            "Kessel"), never as the only word left, and a remainder
 *                            made only of them is not said: with "logistics" among
 *                            them, "Logistics Solutions" keeps its full name. Left
 *                            out, no word is read as the firm's trade.
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
  const { words: remainder, isATrade } = withoutGenericWords(full, sets)
  // NOTHING DISTINCTIVE REMAINS. Every word was a generic business word ("Consulting
  // Group", "The Company"), so there is no name here to say, in full or in short.
  if (remainder.length === 0) return null
  // STEP THREE. A distinctive remainder that fails a refusal (the reader's own name, a
  // word typed in capitals, a name cut mid-phrase) falls back to the full name, which
  // may still pass. A remainder that is the trade joined to a service word ("Tax" from
  // "Tax & Advisory") is not a name at all, so it falls back the same way.
  const distinctive = !isATrade && remainderIsDistinctive(remainder, sets)
  // A FIRM NAMED AFTER THE READER'S SURNAME IS STILL SHORTENED (operator, reading file 7,
  // 2026-10-03): "Marlow Group Consulting" written to Jane Marlow is "Marlow Group", and
  // "Marlow Consulting" written to her is "Marlow". A surname alone is
  // how a founder-named firm is spoken of. Where the registered name puts an entity word
  // straight after the surname, it stays, so the firm is named rather than the person. The
  // refusal still holds for anything that reads as the PERSON: their first name, an
  // initial, a title or a possessive ("Jane Marlow", "J Marlow", "Marlow's").
  if (distinctive && isTheReadersSurname(remainder, reader)) {
    const next = full[remainder.length]
    const named = next !== undefined && ENTITY_WORDS.has(bare(next)) ? [...remainder, next] : remainder
    const short = nameForASentence(named, clientGenericWords, {})
    if (short !== null) return short
  }
  if (distinctive) {
    const short = nameForASentence(remainder, clientGenericWords, reader)
    if (short !== null) return short
  }
  // A FULL NAME WITH NOTHING DISTINCTIVE IN IT, AND NO GENERIC WORD THAT MAKES IT A FIRM'S.
  // There is no longer form to fall back to, and two shapes have nothing to say:
  //   - a PLACE, in any number of words: "Denver Ltd", "New York Ltd", "Greater Manchester
  //     LLC", "American Ltd"
  //   - ONE word that is not distinctive: a place or demonym, a trade word of the firm's
  //     own, or under three characters ("QX Ltd"). Since the sixth reading a common word
  //     is distinctive, so "Orchard GmbH" is "Orchard". A full name of one word IS its
  //     remainder (nothing can have come off and left something), so the verdict above is
  //     the verdict on it.
  // "so Denver can win the right clients" is the sentence the place rule exists to
  // prevent. The operator's rule for this case is "your firm".
  if (isAPlace(full) || (full.length === 1 && !distinctive)) return null
  return nameForASentence(full, clientGenericWords, reader)
}
