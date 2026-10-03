// The deterministic half of firm-fact extraction. No model calls, no I/O.
//
// Plan: Notion "Firm-fact tier: plan (decided 30 September)": Design (order of work per
// prospect), Round 4 ({does} check), Round 6 (faithfulness pre-checks, revised cost caps).
//
// WHAT A FIRM FACT IS. One clause about what the prospect's firm does, in second person
// ("you design cold rooms for food wholesalers"), taken from the firm's OWN website text,
// plus optionally who its customers are ({for_whom}) and which of the client's peer group
// labels it belongs to. It fills the opener of a firm-fact Email 1.
//
// EVERY CHECK FAILS CLOSED. Any failure means the prospect gets the template, which is what
// they would have received anyway. Nothing here can make an email worse than the template;
// the worst a wrong pass can do is put an inaccurate clause in an opener, which is why the
// checks lean strict and a separate model judge confirms faithfulness after them.

import { USD_PER_MTOK } from './cost-constants'
import { findFirmographicFigures } from '@/lib/style/firmographic'

// ─── Caps, and the $0.02 ceiling they enforce by construction ────────────────

export const FIRM_FACT_EXTRACTION_MODEL = 'claude-sonnet-4-6'
export const FIRM_FACT_JUDGE_MODEL = 'claude-haiku-4-5-20251001'

/**
 * THE VERSION OF THE CHECKS A STORED FACT WAS JUDGED UNDER.
 *
 * prospects.firm_fact is a FROZEN VERDICT: evaluated once and stored, so tightening a check
 * here changes nothing already stored (CLAUDE.md, "a rule change that does not change any
 * row"). Measured 2026-09-30: a fact stored that morning carried the customer group
 * "corporations and organizations", which the check written that afternoon rejects as vague.
 *
 * So the record carries this number. Composition uses a fact only when its version is the
 * current one, and a fact from an older version may be extracted again. BUMP THIS whenever
 * a check in this file changes what passes: that is what makes the change reach stored rows.
 *
 *   1  2026-09-30  first cut
 *   2  2026-09-30  marketing words; multi-word vague {for_whom}; identity by initials,
 *                  folded accents and compact name; B2B; hyphenated proper nouns
 *   3  2026-09-30  "transformation" is a service name, only the verb is marketing; AI is a
 *                  category acronym; a customer group may be plural at its head
 *   4  2026-09-30  a range ("small businesses to multinational corporations") is not a
 *                  specific customer group
 *   5  2026-10-01  every content word of the clause must be in the source quote (operator
 *                  rule 10); the judge fails any added concept
 *   6  2026-10-01  two forms of a word match only by INFLECTION (the first matcher called
 *                  "leadership" and "leaders" one word); the carrier verbs are help and
 *                  provide only, and the JUDGE decides whether the carrier is fair; the
 *                  customer group is held to the quote too and "our clients" is vague; the
 *                  judge's audit must cover every word of the clause and say the clause
 *                  means what the quote means
 *   7  2026-10-01  no "your" in the clause (the page's "your" is the firm's customer, and
 *                  after "we" becomes "you" it reads as the firm's own), no comma and no
 *                  spaced hyphen. All three shipped in one real clause under version 6
 *   8  2026-10-01  the fallback ladder: a fact passes at the SPECIFIC rung (the clause) or
 *                  the BROAD rung (the kind of firm, "you run a dental practice"); one judge
 *                  call audits both; caps re-cut so both rungs fit the ceiling
 *   9  2026-10-01  what names nothing comes from the client's brief, not a shared word
 *                  list; a word about a firm's size, ownership, legal form, age or place
 *                  never makes a line specific, and the extraction prompt says so for the
 *                  kind of firm. Bumped because the prompt changed and because the generic
 *                  check LOOSENED as well as tightened: a record stored as failed for being
 *                  generic keeps no words, so composition's re-check cannot reach it and
 *                  only a new extraction can. No fact was stored under version 8.
 *  11  2026-10-01  the broad line reads "you are <kind>" where the kind names a person or
 *                  a maker ("an organisational consultant"), and the judge is told so. A
 *                  stored fact was judged on the clause that ships, so the clause changing
 *                  changes the version.
 *  10  2026-10-01  a kind of firm is put in the case of running prose before it is checked
 *                  (sentenceCaseKind). Pages write their kind in Title Case ("a Design
 *                  Consultancy"), the check reads a capitalised word in a kind as a name,
 *                  and four real kinds in the first 77 extractions under version 9 were
 *                  refused for naming nothing. A stored kind changes, so the version does.
 *  12  2026-10-01  the broad line's VERB comes from the extraction and is stored with the
 *                  kind; version 11 guessed it from the last word's ending and shipped
 *                  "you run" in front of every person whose word has no such ending. A
 *                  kind must read as a complete noun phrase: it may not end on a joining
 *                  word, stop where its quote carries the phrase on, or hold a word the
 *                  page only ever capitalises. The judge is asked whether each clause
 *                  reads as a sentence, because one real stored kind had its noun left
 *                  off with nothing after it in the quote for code to see. A kind made
 *                  only of words for "a firm" names nothing. The stored record gains a
 *                  field and the judged clause changes, so the version does.
 *  13  2026-10-01  version 12, corrected by its own live trial on 77 real prospects. The
 *                  judge's "reads as a sentence" question failed sound lines and halved
 *                  the broad rung, and the extraction prompt's "complete noun phrase"
 *                  procedure made the model answer twice ("Wait, let me fix"), which cut
 *                  answers off. Both withdrawn. In their place a rule code can hold: the
 *                  quote must SAY the kind, with "a", "an", "the" or "is" in front of it
 *                  and nothing carrying the phrase on (kindInQuote). Prompt and judged
 *                  flags changed, so the version does.
 *  14  2026-10-01  version 13's own run, read. The extraction is told to write its answer
 *                  once (it was still writing it twice on some pages and being cut off);
 *                  a cut-off answer with a whole answer in it is read, not discarded; the
 *                  judge is not required to audit "are" after "you" (it leaves it out as
 *                  a grammar word, and two sound lines failed for that alone); the judge's
 *                  output cap is 480. The prompt changed, so the version does.
 *  15  2026-10-01  an attack on version 14's quote rule. A joining word, a comma, a slash,
 *                  a bracket or an all-caps word after the kind no longer counts as its
 *                  end ("a web design" against "a web design and digital marketing
 *                  agency" passed); a run of -ing words closing on one singular word is
 *                  the phrase carrying on ("a commercial" + "lending broker"). The
 *                  introducer is found across any number of describing words code can
 *                  see ("a small, friendly, family-run bakery" was refused). The prompt no
 *                  longer allows a name in a kind, which the check has always refused.
 *  16  2026-10-02  tier 2 coverage (operator note 6 on the fourth reading: most
 *                  non-personalised prospects should land in tier 2). Read from the 39
 *                  prospects of 77 that had a page and failed: a clause is REPAIRED BY
 *                  REMOVAL before it is refused (the first item of a list, the clause cut
 *                  at its trailing phrase), "&" is written "and", and the judge is told
 *                  that a clause saying LESS than its quote is not saying something
 *                  different. Prompt and judged question changed, so the version does.
 *  17  2026-10-02  from reading version 16's twenty newly passing clauses against their
 *                  quotes. None added a word; two named nothing ("you help businesses
 *                  win"; a clause whose cut removed its only specific part). So: every
 *                  candidate is tried AS WRITTEN before any repair is tried; a verb that
 *                  only says things get better (win, grow, succeed) names nothing; and a
 *                  clause is put in the case of running prose as a kind already was. The
 *                  stored clause changes, so the version does.
 *  18  2026-10-02  from reading all fifty passing lines of version 17's run. A broad line
 *                  read "you are a working relationship with a coach": a kind may hold no
 *                  preposition, and the judge is told a clause twists its quote when it
 *                  says of the company what the quote says of something else. A repair
 *                  that leaves fewer than two specific words is not a repair ("you help
 *                  organisations prepare"). A clause holds no symbols ("DATA + X"). A
 *                  clause lifted from a heading is lower-cased throughout.
 *  19  2026-10-02  two faults of version 18's own repairs, read from its run. A list of
 *                  two-word describing phrases was cut to "you help organisations build
 *                  fair": a list is cut only when its first item ends on a word with the
 *                  form of a noun. A product named in a heading was lower-cased: a word
 *                  the page uses as a name in running text keeps its capital.
 *  20  2026-10-02  from an adversarial review of versions 16 to 19, each fault reproduced
 *                  on the pure functions. The word-cap cut ended mid-phrase ("...small
 *                  accountancy practices so", "you help landlords deal"): the kept part
 *                  must end on a noun's form, and a clause that fences its claim in
 *                  ("stop", "against", "only") is never cut. "M&A" became "M and A": an
 *                  ampersand is rewritten only between two words. A list of describing
 *                  words whose first ends -ing or -ure was cut ("you help schools run
 *                  engaging"). A run of Title Case came out half lowered. More words
 *                  that only say things get better, matched by inflection. No prompt
 *                  changed and no judged question: code only.
 *  21  2026-10-02  from reading all 45 passing lines of version 20's run: none cut off or
 *                  broken. Two were half lowered across an "and" ("category management
 *                  and Strategic Sourcing"): a joining word between two capitalised words
 *                  does not end the run. The stored clause changes, so the version does.
 *  22  2026-10-02  the operator's fifth reading. No unexplained acronym in a clause or a
 *                  kind ("HCM and payroll providers"): it is refused. A clause taken from
 *                  a tagline is used only after the page's own kind of firm. The prompt
 *                  says both, so the version changes.
 *      2026-10-02  STILL 22: changed the same day by the pre-merge review, and the number
 *                  was held on purpose. Four changes.
 *                  (1) THE ACRONYM REPAIR IS GONE. Version 22 first left the acronym out
 *                  and kept the rest of the clause. Measured on 77 real extractions it was
 *                  tried three times and stored one clause. On invented clauses it wrote
 *                  "you install maintain fire alarms", "you offer both content writing"
 *                  and "you keep compliant with tax law", and each passed every check. So
 *                  the acronym is never deleted alone; the list and length cuts still run
 *                  by their own rules (see version 23), and otherwise the next candidate
 *                  or the next rung is used.
 *                  (2) A roman numeral is not an acronym ("phase II clinical trials").
 *                  Too wide: any string of I, V and X passed. Narrowed in 23.
 *                  (3) "building" is a trade's noun, not the slogan verb "build". Too
 *                  wide: it re-admitted "building success". Narrowed in 23.
 *                  (4) The prompt's kind paragraph states the allowed acronyms, and a
 *                  tagline is tried only after every other candidate and its repairs.
 *                  CORRECTED by version 23: this entry said that with no new version
 *                  none of these changes reached a stored row. The "building" change did:
 *                  composition re-runs the shared generic list on every stored clause, so
 *                  a version 22 fact holding "building", refused at composition before,
 *                  composed again. The acronym and ordering changes reached only new
 *                  extractions, and the one clause the removed repair stored ("repaired
 *                  by removal (acronym_removed)" in its check_reasons) kept passing.
 *  23  2026-10-02  the second fix round of the pre-merge review. Every stored fact is
 *                  extracted again under it, and that run is the live trial of its prompt
 *                  change. Seven changes:
 *                  (1) THE ACRONYM REPAIR IS GONE, and with this number its one stored
 *                  clause stops being trusted. No clause is shortened to hide an acronym
 *                  by deleting the acronym alone. The list and length cuts still run by
 *                  their own rules, and a cut that leaves the acronym out is kept,
 *                  because what it leaves is a sound, true clause.
 *                  (2) A ROMAN NUMERAL is not an acronym, ONLY in an order a numeral can
 *                  take: "II", "XIV" pass; "VX", "IIII", "VVV" are reported again.
 *                  (3) A SHORT FORM IS READ WITH ITS QUOTE'S CAPITALS. "a pr agency" from
 *                  a page saying "a PR agency" passed every check and composed "you run
 *                  a pr agency"; it is now refused exactly as "a PR agency" is. A known
 *                  short form written in lower case ("an hr consultancy") is refused, so
 *                  it never prints so. A quote in capitals throughout is refused, since
 *                  it cannot show which words are short forms.
 *                  (4) A MIXED-CASE SHORT FORM ("SaaS", "IoT", "FinTech", "eCommerce",
 *                  and any of that shape) is an unexplained acronym. These were let
 *                  through as "field acronyms" because the prompt told the model to write
 *                  an acronym; none is on the known list.
 *                  (5) A SLOGAN IS TRIED LAST, after every other candidate and its cuts
 *                  (from version 22's review, reaching stored rows only now).
 *                  (6) "BUILDING" names a trade only before one of its nouns ("building
 *                  services", "a building company") or a word off the shared list; before
 *                  an outcome word ("building success", "capability building") or nothing
 *                  it is generic.
 *                  (7) THE KIND PARAGRAPH of the extraction prompt: lower case, but any
 *                  short form kept exactly as the page writes it; the only short forms
 *                  allowed are the known list; otherwise the page's plain words or null.
 */
export const FIRM_FACT_CHECKS_VERSION = 23

/** Hard ceiling per prospect, both calls together, at FULL price (Decision 3). */
export const FIRM_FACT_CEILING_USD = 0.02

/** Round 6 caps. The test derives the worst case from these and USD_PER_MTOK. */
// RE-CUT 2026-10-01 for the fallback ladder. Extraction now also returns the kind of firm
// (more output), and the one judge call audits two clauses (more output), so input was
// taken down to pay for both: 3,600 and 360 for extraction, 1,300 and 420 for the judge.
// Worst case at full price $0.0196. The build-time test holds it under the ceiling.
// RE-CUT AGAIN 2026-10-01 (checks version 14): the judge's answer was cut off on 1 of 77
// real prospects in each of two runs, on a prospect that had passed before. Its output cap
// goes from 420 to 480, paid for by taking extraction input from 3,600 to 3,500. Worst
// case unchanged at $0.0196.
export const EXTRACTION_MAX_INPUT_TOKENS = 3_500
export const EXTRACTION_MAX_OUTPUT_TOKENS = 360
export const JUDGE_MAX_INPUT_TOKENS = 1_300
// 420. The plan's figure was 200, raised to 300 on 2026-09-30 when the judge's JSON was cut
// off on 2 of about 35 real prospects (a truncated verdict is a paid failure), and to 420
// on 2026-10-01 when the one call began auditing two clauses. The worst case of both calls
// at full price is $0.0196, under the ceiling; the build-time test holds that.
export const JUDGE_MAX_OUTPUT_TOKENS = 480

/**
 * Website text sent to extraction: 8,000 characters against the 3,600 token input cap.
 * The plan's figure was 12,000 characters at a 5,000 token cap; Round 6 took it to 9,000
 * at 4,000, and the fallback ladder's re-cut of 2026-10-01 to these. Stored page text is
 * full of navigation and HTML entities that tokenise worse than prose, so the character
 * figure sits well under the token cap with the prompt included. The what-and-for-whom
 * line sits at the top of a homepage, so the cut loses the footer, not the fact.
 */
export const WEBSITE_TEXT_MAX_CHARS = 8_000

/** Stored website text older than this is not used (Design, step 1). */
export const SOURCE_MAX_AGE_DAYS = 90

/** The longest {does} admitted, in words. Matches the invented long fill in the validator. */
export const DOES_MAX_WORDS = 12
export const FOR_WHOM_MAX_WORDS = 5
/** The verbatim quote's length cap, so the judge's input stays inside its token cap. */
export const QUOTE_MAX_CHARS = 400

/**
 * Worst-case cost of one prospect at FULL price: both calls at their caps. If this ever
 * exceeds the ceiling, a price change has broken the construction and the build must fail
 * (the build-time test asserts it), not the ceiling.
 */
export function worstCaseFirmFactCostUsd(): number {
  const sonnet = USD_PER_MTOK[FIRM_FACT_EXTRACTION_MODEL]
  const judge = USD_PER_MTOK[FIRM_FACT_JUDGE_MODEL]
  if (!sonnet || !judge) return Number.POSITIVE_INFINITY   // unknown price: fail the test, never assume
  return (
    EXTRACTION_MAX_INPUT_TOKENS * sonnet.input + EXTRACTION_MAX_OUTPUT_TOKENS * sonnet.output +
    JUDGE_MAX_INPUT_TOKENS * judge.input + JUDGE_MAX_OUTPUT_TOKENS * judge.output
  ) / 1_000_000
}

/** Actual cost at FULL price from returned usage, for post-call reconciliation. */
export function actualFirmFactCostUsd(
  extraction: { input_tokens: number; output_tokens: number } | null,
  judge: { input_tokens: number; output_tokens: number } | null,
): number {
  const sonnet = USD_PER_MTOK[FIRM_FACT_EXTRACTION_MODEL]
  const haiku = USD_PER_MTOK[FIRM_FACT_JUDGE_MODEL]
  const e = extraction ? (extraction.input_tokens * sonnet.input + extraction.output_tokens * sonnet.output) : 0
  const j = judge ? (judge.input_tokens * haiku.input + judge.output_tokens * haiku.output) : 0
  return (e + j) / 1_000_000
}

// ─── Source text ─────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-',
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...', trade: '', reg: '', copy: '',
}

/** Decode the HTML entities stored page text still carries, and collapse whitespace. */
export function decodePageText(raw: string): string {
  return raw
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n)
      if (code === 8211 || code === 8212) return '-'
      if (code === 8216 || code === 8217) return "'"
      if (code === 8220 || code === 8221) return '"'
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' '
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

const BOT_CHECK = /\b(just a moment|checking your browser|verify you are human|are you a robot|captcha|access denied|enable javascript|attention required|ddos protection|request blocked)\b/i

/** Why a page cannot be used, or null when it can. */
export function unusablePageReason(text: string): string | null {
  if (text.length < 200) return 'page_too_short'
  if (BOT_CHECK.test(text.slice(0, 600))) return 'bot_check_page'
  // Raw page code rather than text: a high density of braces and semicolons.
  const codey = (text.slice(0, 2000).match(/[{};<>]/g) ?? []).length
  if (codey > 60) return 'page_code_not_text'
  return null
}

// ─── Identity ────────────────────────────────────────────────────────────────
//
// Design step 2: the page must be the prospect's own. Two of the 49 measured template
// prospects had a site showing a different company (a reused domain, a different brand).
// The check: a distinctive token of the company name appears in the top of the page or
// in the domain. Generic words in a company name are not distinctive.

// RULE ZERO DEBT, RECORDED. This list holds words that are common in the NAMES of firms in
// one market (consulting, advisory, strategy, management and their forms) beside the legal
// forms and filler that are common to all. It predates the brief's generic_kind_words and
// was not moved with them, deliberately: it is a different question (is this word of the
// name enough to recognise the company by?) and needs its own per-client list. What it
// costs: for a client in another market that market's common name word is NOT here, so it
// counts as distinctive and a page from another company in the same trade can match on it.
// On the Notion Backlog ("Rule Zero: the firm-fact identity check ..."), before the first
// paying client.
const GENERIC_NAME_WORDS = new Set([
  'the', 'and', 'of', 'for', 'a', 'an', 'group', 'company', 'co', 'inc', 'llc', 'ltd', 'limited',
  'plc', 'llp', 'lp', 'corp', 'corporation', 'consulting', 'consultants', 'consultancy', 'advisory',
  'advisors', 'advisers', 'partners', 'associates', 'solutions', 'services', 'international',
  'global', 'management', 'strategies', 'strategy', 'agency', 'firm', 'holdings', 'enterprises',
  'uk', 'usa', 'us', 'ie',
])
const LEGAL_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'limited', 'plc', 'llp', 'lp', 'corp', 'corporation', 'co', 'the', 'and', 'of'])

/** Lower-case, accents folded ("Rêve" -> "reve"), so a name and its page compare. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/**
 * Distinctive tokens of a company name. Three characters or more, or two when the token
 * carries a digit ("S4"), so a short coined name is still checkable.
 */
export function distinctiveNameTokens(companyName: string): string[] {
  return fold(companyName)
    .replace(/&/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(t => (t.length >= 3 || (t.length === 2 && /\d/.test(t))) && !GENERIC_NAME_WORDS.has(t))
}

/** The name's initials, legal suffixes dropped: "Northtown Group Consulting Inc." -> "ngc". */
function nameInitials(companyName: string): string {
  return fold(companyName)
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 0 && !LEGAL_SUFFIXES.has(t))
    .map(t => t[0])
    .join('')
}

/**
 * True when the page or domain belongs to the named company: every distinctive token
 * appears in the top of the page or the domain, or the domain holds them joined, or the
 * name's initials (three letters or more) appear as a whole word in either.
 *
 * Measured 2026-09-30 on 30 real prospects: the first version failed four real companies
 * on their own sites (an accented name, a site branded with the initials, a two-character
 * name, and a distinctive word wrongly listed as generic). Each is now a test.
 */
export function identityMatches(companyName: string, pageText: string, url: string | null): boolean {
  const tokens = distinctiveNameTokens(companyName)
  const head = fold(pageText.slice(0, 400))
  const domain = fold(url ?? '').replace(/^https?:\/\//, '').split('/')[0].replace(/[^a-z0-9]/g, '')
  const word = (t: string) => new RegExp(`(?<![a-z0-9])${t}(?![a-z0-9])`)
  if (tokens.length > 0) {
    if (domain.includes(tokens.join(''))) return true
    // Every distinctive token must appear: one shared word is not the same company.
    if (tokens.every(t => word(t).test(head) || domain.includes(t))) return true
  }
  // The whole name, compacted, in the domain: "QX & Associates, Inc." on qxandassociates.example
  // has no distinctive token and only two initials, and is plainly its own site.
  for (const amp of ['and', '']) {
    const compact = fold(companyName).replace(/&/g, ` ${amp} `).split(/[^a-z0-9]+/)
      .filter(t => t.length > 0 && !LEGAL_SUFFIXES.has(t) || (t === 'and' && amp === 'and')).join('')
    if (compact.length >= 6 && domain.includes(compact)) return true
  }
  const initials = nameInitials(companyName)
  if (initials.length >= 3 && (word(initials).test(head) || word(initials).test(fold(url ?? '').replace(/^https?:\/\//, '').split('/')[0].replace(/[^a-z0-9]+/g, ' ')))) {
    return true
  }
  return false   // nothing distinctive matched: fail closed
}

// ─── The {does} clause ───────────────────────────────────────────────────────

const NUMBER_WORDS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|hundreds|thousand|thousands|million|millions|billion|dozen|dozens|half|single|double|triple)\b/i
const PRAISE = /\b(leading|award[- ]winning|top|best|proven|trusted|premier|world[- ]class|expert|experts|innovative|exceptional|renowned|unique|unrivalled|unparalleled|outstanding|excellent|cutting[- ]edge|state[- ]of[- ]the[- ]art|elite|preferred|premium|exclusive|passionate|dedicated|bespoke|tailored|best[- ]in[- ]class|industry[- ]leading|market[- ]leading|first[- ]class|high[- ]quality|quality|great|successful)\b/i
const ABSENCE = /\b(no|not|without|only|never|nothing|none|lack|lacks)\b/i
const TIME = /\b(since|years?|founded|established|recent|recently|now|today|currently|newly|latest|this year|decades?|months?|weeks?)\b/i
const HEDGE = /\b(appears?|seems?|suggests?|likely|probably|apparently|presumably|may|might|perhaps)\b/i
const AUDIENCE = /\b(most|many|firms like|companies like|people like|everyone|all)\b/i
// Site marketing language: true of every firm, so it says nothing about this one, and
// "navigate" is a banned AI tell besides. Both shipped in real clauses on 2026-09-30
// ("help leaders navigate complex business problems", "workforce solutions").
const MARKETING = /\b(navigat\w*|solutions?|empower\w*|unlock\w*|elevat\w*|transform(?:s|ing|ed)?|journey|leverag\w*|seamless\w*|holistic|synerg\w*|end[- ]to[- ]end|next[- ]level|game[- ]chang\w*|thrive|thriving)\b/i
const BE_VERBS = new Set(['are', 'were', 'have', 'had', 'will', 'can', 'could', 'would', 'should', 'may', 'might', 'do', 'did', 'must'])
// Present-tense verbs that END in -ing or -ed. The tense check below reads the ending, and
// without this list a page that says "we shred documents" could never yield "you shred",
// while rule 10 forbids any other verb in its place.
const BASE_VERBS_ENDING_ING_OR_ED = new Set([
  'bring', 'sing', 'ring', 'swing', 'spring', 'string', 'cling', 'fling', 'sting', 'wring',
  'feed', 'need', 'seed', 'speed', 'breed', 'bleed', 'weed', 'embed', 'shred', 'shed', 'wed',
  'exceed', 'proceed', 'succeed',
])

/** Bare category nouns that say nothing about who the customers are (Round 3, ripple c). */
const VAGUE_FOR_WHOM = new Set([
  'companies', 'businesses', 'clients', 'customers', 'organisations', 'organizations', 'firms',
  'people', 'individuals', 'brands', 'enterprises', 'teams', 'leaders', 'owners', 'groups',
  'corporations', 'entities', 'institutions', 'partners', 'stakeholders', 'buyers', 'users',
])

/**
 * Words that say a firm exists and sells something, and nothing about WHAT. A clause made
 * only of these ("you provide professional services for businesses") is true of every firm
 * in every client's list, so as an opener it shows the reader nothing was read.
 *
 * NO MARKET'S WORDS IN HERE (Rule Zero). Until 2026-10-01 this list held one market's words
 * for itself ("consulting", "advisory" and their forms), applied to every client: for a
 * client selling to a different market those are the most specific words a prospect's page
 * has, and the words that ARE generic for that client's list were missing. What is generic
 * for one client's prospects comes from that client's brief (generic_kind_words) and is
 * passed in.
 */
const GENERIC_DOES_WORDS = new Set([
  'services', 'service', 'support',
  'solutions', 'professional', 'expert', 'help', 'provide', 'offer', 'deliver', 'work', 'range', 'wide', 'full',
  'run', 'are',
  // Verbs and nouns that only say things get BETTER. "You help businesses win" and "you
  // help firms grow" are true of every firm that sells anything to a business: read from a
  // real passing clause on 2026-10-02. With a specific word beside them they are harmless
  // ("you help hotels grow direct bookings" names hotels and bookings).
  'win', 'wins', 'grow', 'grows', 'succeed', 'succeeds', 'success', 'thrive', 'improve', 'improves',
  'achieve', 'achieves', 'better', 'more', 'results', 'goals', 'potential', 'reach',
  // More of the same, each read from a clause that passed with it (review, 2026-10-02).
  // Matched by inflection too (sharedGeneric), so "growing" and "scales" are covered;
  // "growth" and "successful" are derivations and are listed. A LIST: an unlisted word for
  // "things get better" still passes.
  'growth', 'successful', 'scale', 'perform', 'performance', 'value', 'profit', 'objective', 'forward',
  'flourish', 'excel', 'lead', 'change', 'do', 'get', 'meet', 'realise', 'realize', 'drive', 'increase', 'keep', 'make',
  // Slogan words, read from version 22's run: "you help build vital capabilities to deliver
  // meaningful outcomes" passed, every word of it on the firm's own page and none of it
  // saying what the firm sells. Added without a new checks version: composition re-runs
  // this check on the stored clause, so a longer list reaches every stored fact.
  // "build" is NOT here: see GENERIC_EXACT_VERB_FORMS below.
  'create', 'vital', 'meaningful', 'outcome', 'capability', 'impact', 'transform', 'unlock',
  'empower', 'enable', 'elevate', 'accelerate', 'maximise', 'maximize', 'optimise', 'optimize', 'journey',
  'business', 'company', 'firm', 'client', 'customer', 'organisation', 'organization',
  // Other plain words for "people who do a thing", in any market.
  'partnership', 'provider', 'specialists', 'experts',
])

/**
 * A SLOGAN VERB WHOSE -ING FORM IS A TRADE'S OWN NOUN, held as exact verb forms and never
 * matched by inflection. "build" went on the list above with the other slogan words, that
 * list reads "building" as "build", and so "you provide building services" and "a building
 * company" were refused as naming nothing: the plain word one trade has for itself (the
 * pre-merge review, 2026-10-02). Here the verb is still generic in each form a clause can
 * hold it ("you help build vital capabilities", "builds", "built").
 *
 * "BUILDING" ITSELF IS DECIDED BY THE WORD AFTER IT (checks version 23): see
 * buildingNamesATrade. Version 22 made it specific wherever it stood, and that re-admitted
 * every slogan built on it: "you help companies with building success", "you provide
 * capability building for businesses" and eight more passed and composed, each with
 * "building" as its only specific word (the verifier, 2026-10-02). The judge does not stop
 * them: it reads faithfulness to the quote, and a slogan copied from the page is faithful.
 *
 * The other slogan verbs added with it (create, transform, unlock, empower, enable,
 * elevate, accelerate, maximise, optimise) were checked for the same trap: none has an
 * -ing form a trade names itself by, so they stay on the inflected list. A verb that does
 * goes HERE, never there.
 */
const GENERIC_EXACT_VERB_FORMS = new Set(['build', 'builds', 'built'])

/**
 * The nouns a building trade names itself by after "building": "building services", "a
 * building company", "building materials". Several are on the shared list ("services",
 * "company") and would otherwise make "building" read as a slogan word. Plain English for
 * that one trade's own phrase, no other market's wording.
 */
const BUILDING_TRADE_NOUNS = new Set([
  'services', 'service', 'work', 'works', 'company', 'firm', 'business', 'group', 'contractor', 'contractors',
  'materials', 'maintenance', 'surveyor', 'surveying', 'design', 'supplies', 'products', 'projects',
])

/**
 * Does "building" name a trade here, read by the words after it? YES before one of the
 * trade's nouns above, or before any word off the shared list ("building surveys",
 * "building regulations"). NO when nothing follows it, when a grammar word follows it (it
 * heads its own phrase: "capability building for businesses"), or when a word on the shared
 * list follows it: those are the outcome words a slogan builds ("building success",
 * "building capabilities", "building meaningful impact", "building better businesses").
 * One "and" or "or" is looked past: "building and maintenance services" names the trade,
 * "building and growth" does not.
 */
function buildingNamesATrade(after: readonly string[]): boolean {
  const next = after[0] === 'and' || after[0] === 'or' ? after[1] : after[0]
  if (next === undefined) return false
  if (BUILDING_TRADE_NOUNS.has(next)) return true
  if (STOP_WORDS_FOR_GENERIC.has(next) || /^(a|an|that|which|who|so|as|by|at)$/.test(next)) return false
  return !sharedGeneric(next)
}

/**
 * A part of a token that says nothing for itself: "building" in front of an outcome word,
 * or of nothing, or with a shared-list word in front of it ("capability building
 * services", "value building", merge review 2026-10-02): there the trade noun after it
 * belongs to the slogan, not to a builder.
 */
function isSloganBuilding(token: GenericToken, partIndex: number): boolean {
  if (token.parts[partIndex] !== 'building') return false
  // The word in front, unless it is the clause's own verb ("you provide building
  // services": "provide" is on the list and says nothing about the building).
  const isTheVerb = partIndex === 0 && ['you', 'we'].includes(token.before[token.before.length - 2] ?? '')
  const previous = partIndex > 0 ? token.parts[partIndex - 1] : token.before[token.before.length - 1]
  if (previous !== undefined && !isTheVerb && sharedGeneric(previous.replace(/[^a-z0-9]/g, ''))) return true
  return !buildingNamesATrade([...token.parts.slice(partIndex + 1), ...token.after])
}

/** On the shared list, in any INFLECTION: "growing" is "grow", "scales" is "scale". */
function sharedGeneric(part: string): boolean {
  if (GENERIC_EXACT_VERB_FORMS.has(part)) return true
  if (GENERIC_DOES_WORDS.has(part)) return true
  for (const form of baseForms(part)) if (GENERIC_DOES_WORDS.has(form)) return true
  return false
}

/** For the test that holds Rule Zero on these lists: no market's words may come back. */
export const SHARED_GENERIC_WORDS: ReadonlySet<string> = new Set([...GENERIC_DOES_WORDS, ...GENERIC_EXACT_VERB_FORMS])

/**
 * The plain nouns for A FIRM, singular and plural: words that say an organisation exists
 * and nothing about what it does, in any market. Used twice. A descriptor word (below) is
 * set aside only when it describes one of these, or one of the client's own generic words.
 * And in a KIND of firm these are generic themselves: "you run a group" and "you run a
 * provider" name nothing, exactly as "you run a business" does.
 *
 * NOT "agency", "practice" or "studio". Those are weak and still a kind of firm: they are
 * not words for "a firm" in every market, and a reader told "you run an agency" has been
 * told something. Decided when the kind check was first written and kept.
 *
 * Until version 12 the list stopped at "corporation", so "an independent provider", "a
 * small team" and "a limited liability partnership" each kept its descriptor as content
 * and passed as a specific kind.
 */
const FIRM_NOUNS = new Set([
  'business', 'businesses', 'company', 'companies', 'firm', 'firms',
  'organisation', 'organisations', 'organization', 'organizations',
  'enterprise', 'enterprises', 'corporation', 'corporations',
  'partnership', 'partnerships', 'provider', 'providers', 'supplier', 'suppliers',
  'vendor', 'vendors', 'group', 'groups', 'team', 'teams', 'venture', 'ventures',
  'entity', 'entities', 'outfit', 'outfits', 'operation', 'operations',
])

/**
 * Words about a firm's SIZE, OWNERSHIP, LEGAL FORM, AGE or REACH. They describe the firm
 * and say nothing about what it does: "you run a small business" and "you run a family
 * firm" name nothing, exactly as "you run a business" does. Plain English, no market's
 * wording.
 *
 * SET ASIDE ONLY WHERE THEY DESCRIBE THE FIRM. The first version dropped these words
 * wherever they stood, and read "you provide private client services" and "you support
 * young people" as naming nothing: there "private" and "young" describe the work and the
 * customers. So a descriptor is dropped only when what follows it is a firm noun or one of
 * the client's generic words, or nothing follows it at all ("a start-up", "an SME").
 */
const FIRM_DESCRIPTOR_WORDS = new Set([
  'small', 'smaller', 'large', 'larger', 'big', 'medium', 'mid', 'midsize', 'midsized', 'sized', 'size', 'micro',
  'family', 'owned', 'led', 'run', 'managed', 'operated', 'held', 'listed', 'founder', 'employee', 'woman', 'women',
  'independent', 'private', 'privately', 'public', 'publicly',
  'limited', 'liability', 'ltd', 'llc', 'inc', 'plc', 'incorporated', 'nonprofit', 'profit', 'charitable',
  'new', 'young', 'established', 'growing', 'modern', 'start', 'startup', 'up',
  'global', 'international', 'multinational', 'national', 'nationwide', 'worldwide', 'regional', 'local', 'based',
  'boutique', 'specialist', 'specialised', 'specialized', 'niche', 'market', 'fast',
  'sme', 'smes', 'b2b', 'b2c',
  'uk', 'us', 'usa', 'eu', 'gb', 'uae',
])

/**
 * ALL-CAPS tokens that describe a firm or a place, not a field of work. Every other
 * all-caps token counts as content ("an HR practice", "PLC support" where PLC is a
 * controller): the descriptor list is lower case, and matching an acronym against it after
 * lower-casing read "PLC" as a legal form and "LED" as an ownership word.
 */
const DESCRIPTOR_ACRONYMS = new Set(['UK', 'US', 'USA', 'EU', 'GB', 'UAE', 'SME', 'SMES', 'B2B', 'B2C', 'LTD', 'LLC', 'INC'])

/**
 * All-caps legal forms that are ALSO fields of work somewhere ("PLC" is a controller, "LP"
 * a record). They stay content wherever something follows them ("a PLC programming firm").
 * As the LAST word of a kind there is nothing for them to describe but the firm itself:
 * "you run an LLP" and "you run a PLC" name a legal form and nothing else.
 */
const LEGAL_FORM_ACRONYMS = new Set(['LLP', 'PLC', 'LP', 'CIC'])

/**
 * A MIXED-CASE SHORT FORM: "SaaS", "IoT", "FinTech", "eCommerce". It is not a name, so a
 * kind holding one is not refused for naming a place or a brand. It IS a short form, so it
 * is refused as one (findUnexplainedAcronyms): none of them is on the known list.
 *
 * CHANGED IN CHECKS VERSION 23 (2026-10-02). Until then these five were a list of "field
 * acronyms" let through everywhere, because the extraction prompt told the model to write
 * an acronym in capitals and "a SaaS company" was then refused as a name. The operator's
 * rule is "no unexplained acronyms in the opener", and the known list does not hold them,
 * so they are refused like any other. The list stays, as the forms code is sure of, and the
 * SHAPE finds the rest:
 *   - a lower-case start and then a capital ("eLearning", "mHealth");
 *   - a capital after the first letter in a word of six letters or fewer ("IaaS",
 *     "DevOps"), a plural "s" aside;
 *   - a clipped compound ending "Tech" ("PropTech").
 * NOT a family name's own capital ("McLeod", "MacLeod"), and NOT a longer word with a
 * capital inside it ("NorthBridge"), which is read as a name as before. The price: a short
 * name with a capital inside it ("DeWalt") is refused as a short form, which fails to the
 * template, the safe side; and a longer clipped form not ending "Tech" passes as a name.
 */
const MIXED_CASE_SHORT_FORMS = new Set(['SaaS', 'IoT', 'FinTech', 'PaaS', 'eCommerce'])

export function isMixedCaseShortForm(part: string): boolean {
  if (MIXED_CASE_SHORT_FORMS.has(part)) return true
  if (!/^[A-Za-z]+$/.test(part)) return false
  // "HRs" and "KPIs" are a capitals short form with a plural, read by the capitals rule.
  const stem = part.replace(/s$/, '')
  if (!/[a-z]/.test(stem) || !/[A-Z]/.test(stem.slice(1))) return false
  if (/^Ma?c[A-Z]/.test(stem)) return false
  return /^[a-z]+[A-Z]/.test(stem) || stem.length <= 6 || /[a-z]Tech$/.test(stem)
}

const NO_CLIENT_WORDS: ReadonlySet<string> = new Set()

/** `after` is every word that follows the token in the clause, grammar words included, lower case. */
interface GenericToken { raw: string; lower: string; parts: string[]; after: string[]; before: string[] }

/** One token per space-separated word: a hyphenated compound stays ONE unit. */
function genericTokens(text: string): GenericToken[] {
  const all = text
    .split(/\s+/)
    .map(word => word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''))
    .filter(word => word.length > 0)
  const lowered = all.map(word => word.toLowerCase())
  return all
    .map((raw, i) => ({ raw, lower: lowered[i], parts: lowered[i].split(/[^a-z0-9]+/).filter(Boolean), after: lowered.slice(i + 1), before: lowered.slice(0, i) }))
    .filter(token => token.raw.length > 1)
}

/**
 * Is this word one of the client's generic words, in any INFLECTION of it? A person writes
 * "exporters" as the peer label and means "an exporter" too. Inflection only (plural,
 * tense, -ing), the same matcher the faithfulness check uses: "consulting" does not cover
 * "consultancy", and the brief has to list both.
 */
export function isClientGeneric(word: string, clientGeneric: ReadonlySet<string>): boolean {
  if (clientGeneric.has(word)) return true
  for (const generic of clientGeneric) if (sameWord(word, generic)) return true
  return false
}

/**
 * True when a clause names nothing specific. Pure, and used TWICE: at extraction, and again
 * at composition on the stored clause, so a tightening of this list reaches facts already
 * paid for without extracting them again.
 *
 * `clientGeneric` is the calling client's own generic words (clientGenericWords in the
 * brief). `kind` is set for a KIND of firm ("a dental practice"), and changes two things:
 *
 *   - a Capitalised word is read as a name. The extraction prompt forbids place names in a
 *     kind, and "a Northtown practice" says where a firm is, not what it does. Not applied
 *     to the specific clause, where a named product or method is often the most specific
 *     thing on the page.
 *   - a descriptor with nothing after it is the head of the phrase and names nothing: "a
 *     start-up", "an SME". In a specific clause the last word is the object ("you support
 *     women"), and it stays.
 */
export function clauseIsGeneric(
  does: string,
  clientGeneric: ReadonlySet<string> = NO_CLIENT_WORDS,
  options: { kind?: boolean } = {},
): boolean {
  const tokens = genericTokens(does).filter(t => !STOP_WORDS_FOR_GENERIC.has(t.lower))
  const isAllCaps = (t: GenericToken) => /^[A-Z0-9]{2,}s?$/.test(t.raw) && /[A-Z]/.test(t.raw)
  const isName = (t: GenericToken) =>
    !!options.kind && /^[A-Z][a-z]/.test(t.raw) && !isMixedCaseShortForm(t.raw)
  // A compound is a descriptor when any part of it is: mid-size, woman-owned, fast-growing.
  const isDescriptor = (t: GenericToken) => isAllCaps(t)
    ? DESCRIPTOR_ACRONYMS.has(t.raw.toUpperCase())
    : t.parts.some(part => FIRM_DESCRIPTOR_WORDS.has(part))
  const isFirmWord = (t: GenericToken) =>
    !isAllCaps(t) && t.parts.every(part => FIRM_NOUNS.has(part) || isClientGeneric(part, clientGeneric))
  const generic = (part: string) =>
    sharedGeneric(part) || isClientGeneric(part, clientGeneric)
    || VAGUE_FOR_WHOM.has(part) || VAGUE_FOR_WHOM.has(`${part}s`) || VAGUE_FOR_WHOM.has(`${part}es`)
    // In a kind, a plain noun for a firm is the whole of what a generic kind says.
    || (!!options.kind && FIRM_NOUNS.has(part))

  const kept = tokens.filter(t => !isName(t))
  // A legal form closing a kind describes the firm and nothing else. See the list.
  const describesTheFirm = (t: GenericToken, i: number) => isDescriptor(t)
    || (!!options.kind && i === kept.length - 1 && isAllCaps(t) && LEGAL_FORM_ACRONYMS.has(t.raw.toUpperCase()))
  const content = kept.filter((t, i) => {
    if (!describesTheFirm(t, i)) return true
    // What does it describe? The next word that is not itself a descriptor.
    const next = kept.slice(i + 1).find((other, j) => !describesTheFirm(other, i + 1 + j))
    return !(next === undefined ? !!options.kind : isFirmWord(next))
  })
  return content.every(t => !isAllCaps(t) && t.parts.every((part, j) => generic(part) || isSloganBuilding(t, j)))
}

/**
 * A kind of firm in the case of running prose: "a Design Consultancy" becomes "a design
 * consultancy".
 *
 * A page writes its own kind in Title Case as often as not, and the extraction is told to
 * use the page's words. Two things follow. The opener would read "you run a Design
 * Consultancy", which is not how a person writes a sentence. And the generic check reads a
 * Capitalised word in a kind as a NAME, so a Title Case kind lost every word that said
 * what the firm does: measured on the first 77 extractions under version 9, four real
 * kinds were refused for "naming nothing".
 *
 * THE PAGE DECIDES WHICH WORDS ARE NAMES. A capitalised word is lowered only when the page
 * itself uses that word in lower case somewhere. A place or a brand never appears that way,
 * so it keeps its capital and is still read as a name. All-caps tokens (HR, IT) and mixed-
 * case short forms (SaaS) are left alone, so the acronym check still sees them and refuses
 * each one that is not on the known list. A word the page only ever capitalises stays
 * capitalised, and the kind is then refused (kindHoldsAName): that fails to the template,
 * which is the safe side.
 *
 * ONLY THE PAGE'S PROSE COUNTS. The first version looked for the lower-case form anywhere
 * in the text, and an email address or a link holds the firm's own name in lower case:
 * "a Northtown Consultancy" was lowered on the strength of "hello@northtown-design.example"
 * and the name check then no longer saw a name. Addresses and links are taken out first.
 *
 * KNOWN LIMIT, not fixed: a place whose name is also a common word ("Reading", "Mobile")
 * is lowered when the page uses the common word elsewhere. It needs the extraction to put
 * a place in the kind, which its prompt forbids. On the Backlog.
 */
export function sentenceCaseKind(kind: string, sourceText: string): string {
  const prose = proseOnly(sourceText)
  return kind.trim().split(/\s+/).map((token, i) => {
    if (i === 0) return token.toLowerCase() === 'a' || token.toLowerCase() === 'an' ? token.toLowerCase() : token
    return token.split('-').map(part => {
      const bare = part.replace(/[^A-Za-z]/g, '')
      // A capital and then lower case only: a mixed-case short form ("SaaS") never matches.
      if (!/^[A-Z][a-z]+$/.test(bare)) return part
      const lower = bare.toLowerCase()
      // Case-SENSITIVE on purpose: the lower-case form has to be on the page as a word.
      const onPageInLowerCase = new RegExp(`(?<![A-Za-z])${lower}(?![A-Za-z])`).test(prose)
      return onPageInLowerCase ? part.replace(bare, lower) : part
    }).join('-')
  }).join(' ')
}

/**
 * Does a kind END on a word for what the firm IS? "an IT consulting" does not: it is the
 * front of "an IT consulting firm" with the noun left off, and the opener would read "you
 * run an IT consulting". Measured on 77 real extractions: five of the 23 stored kinds ended
 * this way, each one faithful to its quote, so the faithfulness judge had passed it.
 *
 * Held by the form of the last word only: a word ending in -ing is a description of the
 * work, never the name of the thing that does it. Plain English, no market's wording, and
 * deliberately not a list of nouns a firm may be, which no list would cover.
 *
 * Checked at extraction and AGAIN at composition on the stored kind, so it reaches a fact
 * already paid for without a new extraction.
 */
export function kindEndsOnItsNoun(kind: string): boolean {
  const last = (kind.trim().split(/\s+/).pop() ?? '').replace(/[^A-Za-z]/g, '').toLowerCase()
  return last.length > 0 && !(last.length > 4 && last.endsWith('ing')) && !JOINING_TAIL_WORDS.has(last)
}

/** A kind cannot end on one of these: "a consultancy and", "an agency for". */
const JOINING_TAIL_WORDS = new Set([
  'and', 'or', 'for', 'of', 'in', 'to', 'with', 'the', 'a', 'an', 'by', 'at', 'on', 'from', 'that', 'which', 'who', 'as',
])

/** The page text with addresses and links taken out: what a person reads as sentences. */
function proseOnly(text: string): string {
  return text
    .split(/\s+/)
    .filter(token => !(/@|:\/\/|^www\./i.test(token) || /[A-Za-z0-9]\.[A-Za-z]{2,}/.test(token)))
    .join(' ')
}

/** Words that join a noun to another phrase. A kind of firm is a noun phrase with none of them. */
const KIND_PREPOSITIONS = new Set(['with', 'for', 'of', 'in', 'to', 'by', 'at', 'on', 'from', 'into', 'between', 'about', 'through', 'across'])

/**
 * A KIND IS A SHORT NOUN PHRASE, NOT A PHRASE ABOUT SOMETHING. "a working relationship with
 * a coach" passed every other check on 2026-10-02 (its page says "coaching is a working
 * relationship with a coach", so the words stand together after "is a") and would have
 * opened "you are a working relationship with a coach". What a firm IS takes no
 * preposition: "a dental practice", "an HR consultancy". "A provider of cold rooms" is
 * refused with it, which fails to the template, the safe side.
 */
export function kindHoldsAPreposition(kind: string): boolean {
  return kind.trim().split(/\s+/).slice(1).some(word => KIND_PREPOSITIONS.has(word.toLowerCase().replace(/[^a-z]/g, '')))
}

/**
 * Is a quote written as a HEADING: nearly every word of four letters or more capitalised?
 * Then its capitals say nothing about which words are names.
 */
function quoteIsAHeading(quote: string): boolean {
  const long = quote.split(/[^\p{L}]+/u).filter(word => word.length >= 4)
  if (long.length < 2) return false
  return long.filter(word => /^\p{Lu}/u.test(word)).length / long.length >= 0.8
}

/**
 * A CLAUSE IN THE CASE OF RUNNING PROSE. As a kind is (sentenceCaseKind): a word is lowered
 * where the page writes it in lower case. And when the clause's own quote is a heading,
 * every Title Case word is lowered: "you provide Fractional Executive Services" was lifted
 * from a heading, and in a sentence it reads as scraped. All-caps tokens are left alone.
 *
 * A NAME KEEPS ITS CAPITAL where the page uses it as one in running text: a capitalised
 * word after a lower-case one, with a lower-case word, an all-caps token ("Power BI"), a
 * possessive or the end of the sentence after it. Version 18 lowered every word and shipped
 * a product's name in lower case; version 19 still lowered "Power" in "Power BI" on a page
 * that also says "the power of your data".
 *
 * A RUN OF TITLE CASE IS LOWERED WHOLE OR NOT AT ALL (versions 20 and 21). "Executive Coaching and
 * Leadership Development" on a page that writes "coaching" and "leadership" in lower case
 * came out "Executive coaching and leadership Development". When any word of a run of two
 * or more capitalised words is lowered, the rest of the run is lowered with it, names
 * excepted.
 *
 * What is left of the cost: a name the page writes ONLY in headings or only at the start of
 * a sentence is lowered with the rest. Miscased, never false.
 */
export function sentenceCaseClause(does: string, quote: string, sourceText: string): string {
  const prose = proseOnly(sourceText)
  const usedAsAName = (word: string) =>
    new RegExp(`(?<=\\b[a-z][a-z']*\\s)${word}(?=\\s[a-z]|\\s[A-Z0-9]{2,}\\b|['’]s\\b|[.,;:!?)]|$)`).test(prose)
  const onPageInLowerCase = (lower: string) => new RegExp(`(?<![A-Za-z])${lower}(?![A-Za-z])`).test(prose)
  const heading = quoteIsAHeading(quote)
  const tokens = does.trim().split(/\s+/).map((token, i) => token.split('-').map(part => {
    const bare = part.replace(/[^A-Za-z]/g, '')
    const title = i > 0 && /^[A-Z][a-z]+$/.test(bare)
    const name = title && usedAsAName(bare)
    return { part, bare, title, name, lowered: title && !name && (heading || onPageInLowerCase(bare.toLowerCase())) }
  }))
  // Runs of consecutive tokens that each hold a Title Case part. A JOINING WORD BETWEEN TWO
  // OF THEM DOES NOT END THE RUN: "Category Management and Strategic Sourcing" is one
  // heading-style phrase, and read as two runs it came out "category management and
  // Strategic Sourcing" (two real lines of the version 20 run).
  const isTitleToken = tokens.map(parts => parts.some(p => p.title))
  const joins = (i: number) => /^(?:and|or|&|of)$/i.test(tokens[i].map(p => p.part).join('-'))
  const inRun = isTitleToken.map((title, i) => title || (i > 0 && i + 1 < tokens.length && joins(i) && isTitleToken[i - 1] && isTitleToken[i + 1]))
  for (let i = 0; i < tokens.length; i++) {
    if (!inRun[i]) continue
    let j = i
    while (j + 1 < tokens.length && inRun[j + 1]) j++
    const run = tokens.slice(i, j + 1).flat().filter(p => p.title)
    if (run.length >= 2 && run.some(p => p.lowered)) for (const p of run) if (!p.name) p.lowered = true
    i = j
  }
  return tokens.map(parts => parts.map(p => (p.lowered ? p.part.replace(p.bare, p.bare.toLowerCase()) : p.part)).join('-')).join(' ')
}

/**
 * How many words of a clause say something SPECIFIC, by the shared lists alone. A repair
 * that cuts a clause is kept only when two or more are left: "you help organisations
 * prepare" has one, and it shipped ahead of a sound broad line for the same firm.
 */
export function specificWordCount(does: string): number {
  const tokens = genericTokens(does).filter(t => !STOP_WORDS_FOR_GENERIC.has(t.lower))
  const names = (part: string) => !(sharedGeneric(part) || FIRM_NOUNS.has(part)
    || VAGUE_FOR_WHOM.has(part) || VAGUE_FOR_WHOM.has(`${part}s`) || VAGUE_FOR_WHOM.has(`${part}es`))
  const isFirmWord = (t: GenericToken) => t.parts.every(part => FIRM_NOUNS.has(part))
  return tokens.filter((t, i) => {
    // A word about size or ownership says nothing WHERE IT DESCRIBES THE FIRM ("a small
    // business"), and is content where it describes the work: "public relations", "private
    // tuition". As clauseIsGeneric reads it. Until version 20 it was set aside wherever it
    // stood, and a sound first item of two such words was dropped as naming too little.
    if (t.parts.some(part => FIRM_DESCRIPTOR_WORDS.has(part))) {
      const next = tokens[i + 1]
      return next !== undefined && !isFirmWord(next) && t.parts.some((part, j) => names(part) && !isSloganBuilding(t, j))
    }
    return t.parts.some((part, j) => names(part) && !isSloganBuilding(t, j))
  }).length
}

/**
 * Does a kind still hold a Capitalised word after it has been put in running prose? That
 * is a word the page only ever writes with a capital: a place, a brand, or a noun the page
 * only uses in headings. Either way the opener would carry a capital mid-sentence ("you
 * run a design Consultancy") or a place the extraction prompt forbids, so the kind is
 * refused. All-caps tokens and mixed-case short forms ("SaaS") are not names: they are
 * short forms, and findUnexplainedAcronyms refuses each one not on the known list, so a
 * kind holding one is refused for that and for nothing else.
 */
export function kindHoldsAName(kind: string): boolean {
  return kind.trim().split(/\s+/).slice(1).some(token =>
    token.split('-').some(part => {
      const bare = part.replace(/[^A-Za-z]/g, '')
      return /^[A-Z][a-z]/.test(bare) && !isMixedCaseShortForm(bare)
    }))
}

/**
 * Words that can follow a COMPLETE kind in a sentence: what comes after "a dental
 * practice" is "in", "for", "that", "serving", "based", "run by", never another plain noun.
 */
const FOLLOWS_A_COMPLETE_KIND = new Set([
  'in', 'for', 'of', 'with', 'and', 'or', 'that', 'which', 'who', 'whose', 'where', 'when', 'to', 'at', 'on', 'by',
  'from', 'as', 'but', 'so', 'because', 'while', 'since', 'across', 'within', 'throughout', 'near', 'around', 'under',
  'over', 'into', 'through', 'about', 'than', 'then', 'plus', 'after', 'before', 'between',
  'we', 'our', 'us', 'you', 'your', 'it', 'its', 'they', 'their', 'this', 'these', 'those', 'the', 'a', 'an',
  'is', 'are', 'was', 'were', 'has', 'have', 'had', 'can', 'will', 'does', 'do', 'not', 'now', 'also', 'here', 'there',
  'run', 'built', 'known', 'led', 'made', 'driven', 'born', 'set', 'held', 'grown', 'bound', 'given', 'chosen',
  // Plain words that open what a page says NEXT about a kind it has finished naming:
  // "a bakery just outside Northtown", "a law firm proud to ...", "a clinic open six days".
  // Measured by review on 2026-10-01: 22 of 50 ordinary follow-on words refused a sound kind.
  'just', 'right', 'close', 'outside', 'inside', 'beyond', 'without', 'like', 'unlike', 'if', 'too', 'both', 'still',
  'always', 'only', 'today', 'proud', 'ready', 'open', 'well',
])

/** The joining words. After a kind they are not an ending by themselves: see phraseRunsOn. */
const JOINS_TWO_THINGS = new Set(['and', 'or'])

/**
 * Words that INTRODUCE a kind where a page states what the firm is: "We are a print shop",
 * "Northtown is an HR consultancy", "the print shop for small presses", "as a law firm".
 */
const INTRODUCES_A_KIND = new Set(['a', 'an', 'the', 'is', 'are', 'am', 'as', "we're", "i'm", 'be', 'become', 'became'])

/** A word between the introducer and the kind may be a describing word, never one of these. */
const NOT_A_DESCRIBING_WORD = new Set(['in', 'of', 'for', 'to', 'with', 'and', 'or', 'by', 'at', 'on', 'from', 'into', 'across', 'about'])

/**
 * Singular nouns a kind of firm ENDS on, in any market. Used for one thing: after a kind,
 * a run of words that closes on one of these is the rest of the noun phrase ("a cold room"
 * + "engineering firm"), not a verb form ("a dental practice" + "serving local families").
 */
const KIND_HEAD_NOUNS = new Set([
  'business', 'company', 'firm', 'organisation', 'organization', 'enterprise', 'corporation', 'partnership',
  'provider', 'supplier', 'group', 'team', 'agency', 'practice', 'studio', 'consultancy', 'shop', 'store', 'clinic',
  'bureau', 'office', 'charity', 'house', 'lab', 'network', 'collective', 'institute', 'school', 'service',
])

export type KindInQuote = 'said' | 'absent' | 'not_introduced' | 'carried_on'

/**
 * Does the quote SAY the kind, as a statement of what the firm is?
 *
 * THE RULE: somewhere in the quote the kind's words stand together, in order, with "a",
 * "an", "the" or a form of "be" in front of them (up to two describing words may sit
 * between, which is where the praise the kind left out was), and the noun phrase ends
 * where the kind ends.
 *
 *   'said'            that is so.
 *   'absent'          the kind's words are in the quote, and not together in that order.
 *                     The kind is a recomposition, and nothing on the page says it.
 *   'not_introduced'  the words stand together with nothing in front: a heading or the
 *                     firm's own NAME ("Northtown Board Search"), which is where a kind
 *                     with its noun left off comes from when its quote stops short too.
 *   'carried_on'      the phrase runs on past the kind: "a web design" against "a web
 *                     design studio". The noun was left off.
 *
 * WHY CODE AND NOT THE JUDGE. Version 12 asked the faithfulness judge whether each clause
 * "reads as a sentence". Measured on 77 real prospects the same day: it failed sound lines
 * (its own prompt's example among them) and the broad rung fell from 12 to 5. What the
 * page itself writes after "a" or "an" is a noun phrase by construction, in any market,
 * and code can read that.
 *
 * WHAT IT COSTS. A page that states its kind without an article ("Award-winning print
 * shop.") or with a word in the middle the kind left out is refused. That fails to the
 * template, the safe side. Checked at extraction and AGAIN at composition on the stored
 * kind and its stored quote.
 */
export function kindInQuote(kind: string, quote: string): KindInQuote {
  const body = kind.trim().split(/\s+/).slice(1)
  if (body.length === 0) return 'absent'
  const escaped = body.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  // Not glued to a hyphenated prefix: "an executive search firm" is not said by "a
  // non-executive search firm", and the stranded "non-" read as a describing word.
  const re = new RegExp(`(?<![A-Za-z0-9])(?<![A-Za-z0-9]-)(${escaped.join('[\\s-]+')})(?![A-Za-z0-9])`, 'gi')
  let found = false
  let carriedOn = false
  // The kind writes "and" where the page wrote "&": the same word, so the page says it.
  quote = quote.replace(/\s*&\s*/g, ' and ')
  for (const m of quote.matchAll(re)) {
    found = true
    const at = m.index ?? 0
    const runsOn = phraseRunsOn(m[1], quote.slice(at + m[1].length))
    if (runsOn) { carriedOn = true; continue }
    if (isIntroduced(quote.slice(0, at))) return 'said'
  }
  if (!found) return 'absent'
  return carriedOn ? 'carried_on' : 'not_introduced'
}

/**
 * Is the text that ends just before the kind an introduction of it?
 *
 * Walks back from the kind to the introducer over DESCRIBING words only. A word code can
 * see is a describing word (hyphenated, followed by a comma, or on the size-and-ownership
 * or praise lists) costs nothing; up to two words it cannot classify are allowed, which is
 * where an unlisted adjective sits. A preposition or a joining word in between ends it:
 * "leaders IN safety consultancy" is not the firm being one.
 *
 * The first version looked at the last three words and nothing else, and refused "We are
 * a small, friendly, family-run bakery": three describing words, every one of them plain.
 */
function isIntroduced(before: string): boolean {
  // Only what is in the same sentence: punctuation between the introducer and the kind
  // means the introducer belongs to something else. A comma does not end a sentence.
  const sameSentence = before.split(/[.!?;:|()\n•·–—]/).pop() ?? ''
  const raw = sameSentence.trim().split(/\s+/).filter(Boolean)
  let unclassified = 2
  for (let i = raw.length - 1, steps = 0; i >= 0 && steps < 7; i--, steps++) {
    const word = raw[i].toLowerCase().replace(/’/g, "'").replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '')
    if (INTRODUCES_A_KIND.has(word)) return true
    if (NOT_A_DESCRIBING_WORD.has(word)) return false
    const describes = raw[i].endsWith(',') || word.includes('-') || FIRM_DESCRIPTOR_WORDS.has(word) || PRAISE.test(word)
    if (!describes && unclassified-- === 0) return false
  }
  return false
}

/**
 * Does the noun phrase run on past the kind, given what follows it in the quote?
 *
 * A kind is COMPLETE when what follows is the end, a full stop or other sentence mark, a
 * word that opens the next thing said about it ("in", "for", "that", "we", "based"), or a
 * new name starting. It RUNS ON when what follows is another plain word.
 *
 * A JOINING WORD OR A LIST MARK IS NOT AN ENDING BY ITSELF. Until version 15 "and", "or",
 * a comma, a slash and an opening bracket each counted as one, so "a web design" passed
 * against "We are a web design and digital marketing agency", and for a kind too long for
 * the word cap the cut-short form was the only one that passed. What matters is the word
 * AFTER the join or the mark: "a print shop, and we bind books" is complete; "a web design
 * and digital ..." has run on. The cost, accepted: "We are a bakery and cafe" is refused,
 * because code cannot tell two kinds joined from one kind with two fields.
 *
 * AN ALL-CAPS WORD carries the phrase on: "a digital" + "PR agency".
 *
 * A VERB FORM AND THE MIDDLE OF A NOUN PHRASE HAVE ONE FORM ("serving", "engineering").
 * Two shapes say the phrase ran on: the run of words closes on a noun for a firm, or it is
 * only -ing words and then ONE singular word ("lending broker", "engineering contractor":
 * the object of a verb is plural or has its own "the"). The cost: "a charity providing
 * support" is refused. Each refusal here fails to the template.
 */
function phraseRunsOn(matched: string, after: string): boolean {
  const m = after.match(/^([^A-Za-z0-9]*)([A-Za-z][A-Za-z'’-]*)?/)
  const gap = m?.[1] ?? ''
  const next = m?.[2]
  if (!next) return false
  if (/[.;:!?|\n•·–—)]/.test(gap) || /\s-\s/.test(gap)) return false
  const lastKindWord = matched.split(/[\s-]+/).pop() ?? ''
  const afterNext = after.slice(gap.length + next.length)
  if (JOINS_TWO_THINGS.has(next.toLowerCase())) {
    // "..., and we bind books" is a new clause. "... and digital marketing agency" is not.
    const following = afterNext.match(/^[^A-Za-z0-9]*([A-Za-z][A-Za-z'’-]*)/)?.[1]
    if (!following) return false
    return !opensTheNextThingSaid(following.toLowerCase())
  }
  if (/[,/(]/.test(gap)) {
    // A list mark: complete only when what follows opens the next thing said.
    return !opensTheNextThingSaid(next.toLowerCase()) && !isVerbFormNotCarryingOn(next, afterNext)
  }
  if (/^[A-Z0-9]{2,}$/.test(next)) return true
  const lower = next.toLowerCase()
  if (FOLLOWS_A_COMPLETE_KIND.has(lower) && !JOINS_TWO_THINGS.has(lower)) return false
  if (/^[A-Z]/.test(next) && /^[a-z]/.test(lastKindWord)) return false
  if (isVerbForm(lower)) return !isVerbFormNotCarryingOn(next, afterNext)
  return true
}

function opensTheNextThingSaid(lower: string): boolean {
  return FOLLOWS_A_COMPLETE_KIND.has(lower) && !JOINS_TWO_THINGS.has(lower)
}

function isVerbForm(lower: string): boolean {
  return lower.length > 4 && /(?:ing|ed|ly)$/.test(lower)
}

/** `word` has the form of a verb ("serving"). Is it one, by where the run of words ends? */
function isVerbFormNotCarryingOn(word: string, afterWord: string): boolean {
  const lower = word.toLowerCase()
  if (!isVerbForm(lower)) return false
  const run: string[] = [lower]
  for (const token of afterWord.split(/\s+/).filter(Boolean).slice(0, 3)) {
    const bare = token.toLowerCase().replace(/[^a-z'-]/g, '')
    if (!bare || FOLLOWS_A_COMPLETE_KIND.has(bare)) break
    run.push(bare)
    if (/[.,;:!?()|]/.test(token)) break
  }
  if (run.length < 2) return true
  const last = run[run.length - 1]
  if (KIND_HEAD_NOUNS.has(last)) return false
  const onlyIngBeforeLast = run.slice(0, -1).every(w => w.endsWith('ing'))
  const lastIsOneSingularWord = !isVerbForm(last) && !last.endsWith('s')
  return !(onlyIngBeforeLast && lastIsOneSingularWord)
}

const KIND_IN_QUOTE_REASON: Record<Exclude<KindInQuote, 'said'>, string> = {
  absent: 'the quote does not say the kind in those words, in that order',
  not_introduced: 'the quote has no "a", "an" or "is" in front of the kind: a heading or a name, not a statement of what the firm is',
  carried_on: 'stops before its noun: the quote carries the phrase on',
}

/**
 * Every reason a kind does not read after "you run" or "you are", by its FORM. Empty when
 * it reads. One function so extraction and composition hold the same rules: composition
 * runs it again on the stored kind and its stored quote.
 */
export function kindFormReasons(kind: string, quote: string | null): string[] {
  const reasons: string[] = []
  if (!kindEndsOnItsNoun(kind)) reasons.push('ends on a word for the work or a joining word, not on what the firm is ("... consulting" with no "firm")')
  if (kindHoldsAPreposition(kind)) reasons.push('holds a preposition: a kind names what the firm is in a few words, not a phrase about something ("a working relationship with a coach")')
  if (kindHoldsAName(kind)) reasons.push('holds a word the page only ever capitalises: a name, or a heading\'s word')
  if (quote !== null) {
    const inQuote = kindInQuote(kind, quote)
    if (inQuote !== 'said') reasons.push(KIND_IN_QUOTE_REASON[inQuote])
  }
  return reasons
}

/** The same question about a KIND of firm ("an HR consultancy"), as the broad line carries it. */
export function kindIsGeneric(kind: string, clientGeneric: ReadonlySet<string> = NO_CLIENT_WORDS): boolean {
  return clauseIsGeneric(`you run ${kind.trim()}`, clientGeneric, { kind: true })
}
const STOP_WORDS_FOR_GENERIC = new Set(['you', 'your', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'the', 'a', 'an', 'their', 'our', 'all', 'other'])

export interface ClauseVerdict {
  ok: boolean
  reasons: string[]
}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}

/**
 * The Round 4 and Round 6 deterministic checks on the {does} clause, against the decoded
 * source page text.
 *
 * `quote` is the clause's own quote. Give it whenever there is one: a short form is judged
 * as the quote writes it (checks version 23), and without it a short form the model wrote
 * in lower case is not seen. Extraction always passes it.
 */
export function checkDoesClause(does: string, sourceText: string, clientGeneric: ReadonlySet<string> = NO_CLIENT_WORDS, quote: string | null = null): ClauseVerdict {
  const reasons: string[] = []
  const clause = does.trim()
  const w = words(clause)
  if (w.length === 0) return { ok: false, reasons: ['empty'] }
  if (w[0] !== 'you') reasons.push('does not start with lower-case "you"')
  const verb = (w[1] ?? '').toLowerCase()
  const wrongEnding = (verb.endsWith('ing') || verb.endsWith('ed')) && !BASE_VERBS_ENDING_ING_OR_ED.has(verb)
  if (!/^[a-z]+$/.test(verb) || BE_VERBS.has(verb) || wrongEnding) {
    reasons.push(`second word "${verb}" is not a present-tense verb`)
  }
  if (w.length > DOES_MAX_WORDS) reasons.push(`${w.length} words, over ${DOES_MAX_WORDS}`)
  if (/[.!?;:]/.test(clause.replace(/[.]$/, ''))) reasons.push('more than one clause or sentence')
  if (/[.!?]$/.test(clause)) reasons.push('ends with punctuation; the frame supplies it')
  if (/\byou\b/i.test(w.slice(1).join(' '))) reasons.push('a second "you": more than one clause')
  // "We run your entire operation" is said to the firm's CUSTOMER. Turned round to "you run
  // your entire operation" and said to the firm, "your" now points at the firm itself, and
  // the clause says something the page never did. No rewording of one word fixes that.
  if (/\b(your|yours|yourself)\b/i.test(clause)) reasons.push('holds "your": the page\'s "your" is its customer, not the firm')
  if (/,\s*(and|but|while|which|who|so)\b/i.test(clause)) reasons.push('more than one clause')
  // One thing, or two joined by "and". A comma makes a list, and a list of three in the
  // opener breaks the style rules for every email that carries it.
  if (clause.includes(',')) reasons.push('holds a comma: one thing, or two joined by "and"')
  // Digits inside a category acronym ("B2B") are not a number.
  const withoutAcronyms = clause.replace(/\bB2[BC]\b/gi, '')
  if (/\d/.test(withoutAcronyms) || NUMBER_WORDS.test(clause)) reasons.push('contains a number')
  if (findFirmographicFigures(clause).length > 0) reasons.push('contains a firmographic figure')
  for (const [name, re] of [['praise', PRAISE], ['absence', ABSENCE], ['time', TIME], ['hedge', HEDGE], ['audience', AUDIENCE], ['marketing', MARKETING]] as const) {
    const m = clause.match(re)
    if (m) reasons.push(`${name} word "${m[0]}"`)
  }
  if (/[—–&]|--|\s-\s/.test(clause)) reasons.push('dash or ampersand')
  // A clause is words. "DATA + X + Y consultancy" passed, and reads as a logo.
  if (/[+|/\\*#@=%<>~^]/.test(clause)) reasons.push('holds a symbol: a clause is written in words')
  // Read with the capitals of the clause's own quote: see shortFormProblems.
  reasons.push(...shortFormProblems(clause, quote))
  // A proper noun not in the source is an invention. Capitalised words after the first.
  const lowerSource = sourceText.toLowerCase()
  for (const token of w.slice(1)) {
    const bare = token.replace(/[^A-Za-z0-9'-]/g, '')
    if (!/^[A-Z]/.test(bare)) continue
    // Hyphenated compounds are checked part by part: "AI-agent" is on a page that writes
    // "AI agent", and is not an invented name.
    const parts = bare.split('-').filter(part => /^[A-Z]/.test(part))
    for (const part of parts) {
      if (!lowerSource.includes(part.toLowerCase())) reasons.push(`proper noun "${part}" is not in the source`)
    }
  }
  if (clauseIsGeneric(clause, clientGeneric)) reasons.push('names nothing specific: true of any firm')
  // A clause about a parent group or the firm's own structure is not what it does.
  if (/\b(part of|member of|subsidiary|owned by|division of)\b/i.test(clause)) reasons.push('describes ownership, not work')
  return { ok: reasons.length === 0, reasons }
}

/**
 * Short forms every business reader knows. Everything else in capitals is an acronym the
 * reader may not: "HCM", "CXO", "CIO", "DVBE". A LIST of what is known, because that set is
 * small and what is unknown is not.
 */
const KNOWN_ACRONYMS = new Set(['HR', 'IT', 'AI', 'UK', 'US', 'USA', 'EU', 'UAE', 'CEO', 'B2B', 'B2C'])
/** The same list as the extraction prompt states it: the model is told exactly what code allows. */
export const KNOWN_ACRONYM_LIST = [...KNOWN_ACRONYMS].join(', ')

/**
 * NO UNEXPLAINED ACRONYM IN THE OPENER (operator note 4 on the fifth reading). "Can see you
 * optimize and implement HCM and payroll providers" went to a reader in a file he read:
 * true to the page, and one word of it means nothing to most people.
 *
 * An acronym is a token of two to six capitals and digits, with at least one capital,
 * optionally a plural "s", or a mixed-case short form ("SaaS", see isMixedCaseShortForm).
 * A hyphenated word is read part by part. Returned as written.
 *
 * READ WITH THE QUOTE'S CAPITALS (checks version 23). Given the quote the words came from,
 * each word is also read as the quote writes it, matched whole and without regard to case.
 * The model may write "a pr agency" from a page that says "a PR agency", and this function
 * saw an acronym only in capitals: the kind passed every check and composed into "you run a
 * pr agency". Now it is refused exactly as "a PR agency" is, and reported as the quote
 * writes it. Where the quote writes one word both ways, a capitals form counts: the safe
 * side. A caller that HAS the quote must pass it; without it only the text's own capitals
 * are read.
 *
 * NO CLAUSE IS SHORTENED TO HIDE ONE BY DELETING THE ACRONYM ALONE. For part of 2026-10-02
 * the acronym was left out and the rest of the clause kept. That wrote "you install
 * maintain fire alarms" from "you install CCTV and maintain fire alarms" and "you offer
 * both content writing" from "you offer both SEO and content writing", and each passed
 * every check: nothing in the form of the words around an acronym says whether the clause
 * stands without it. So that repair is gone. The list cut and the length cut (clauseForms)
 * still run by their own rules, and a cut that happens to leave the acronym out is kept,
 * because what it leaves is a sound, true clause ("you install fire alarm systems" from
 * "you install fire alarm systems, CCTV cameras, and door entry systems"). Otherwise a
 * clause holding one is refused, as a kind is, and the next candidate or rung is used.
 *
 * NOT A ROMAN NUMERAL. Letters I, V and X in an order a numeral can take ("phase II
 * clinical trials", "a class IV laser", "XIV") are a number written in letters, not a
 * short form of anything, and the trade that writes them has no other way to. ONLY IN A
 * NUMERAL'S ORDER, since version 23: until then any string of the three passed, and "you
 * install VX ventilation units" composed. The price: the few real short forms spelt as a
 * numeral ("IV" for a drip) pass as numerals.
 */
export function findUnexplainedAcronyms(text: string, quote: string | null = null): string[] {
  const inQuote = quote ? quoteSpellings(quote) : null
  const found: string[] = []
  for (const part of shortFormParts(text)) {
    // The quote's capitals count only for a word the quote never writes in lower case. A
    // heading in capitals ("COLD ROOMS. We install cold rooms ...") is not an acronym when
    // the same page writes the same word as an ordinary word (merge review, 2026-10-02).
    const quoted = inQuote?.get(part.toLowerCase()) ?? []
    const spellings = quoted.includes(part.toLowerCase()) ? [part] : [part, ...quoted]
    const unexplained = spellings.find(isUnexplainedShortForm)
    if (unexplained !== undefined) found.push(unexplained)
  }
  return found
}

/** I to XXXIX, in an order a numeral takes. "VX", "IIII" and "VVV" are not numerals. */
const ROMAN_NUMERAL = /^(?=[IVX])X{0,3}(IX|IV|V?I{0,3})$/

/** A short form a reader may not know: see findUnexplainedAcronyms. */
function isUnexplainedShortForm(part: string): boolean {
  if (isMixedCaseShortForm(part)) return true
  if (!/^[A-Z0-9]{2,6}s?$/.test(part) || !/[A-Z]/.test(part)) return false
  if (ROMAN_NUMERAL.test(part)) return false
  return !KNOWN_ACRONYMS.has(part.replace(/s$/, '')) && !KNOWN_ACRONYMS.has(part)
}

/**
 * The words of a text as the acronym check reads them. A hyphen and a slash both join two
 * words ("HR/HCM support"), and a possessive is the word plus an ending ("an HCM's
 * rollout"): each part is read on its own.
 */
function shortFormParts(text: string): string[] {
  return text.split(/\s+/).flatMap(token =>
    token.replace(/['’]s\b/g, '').replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').split(/[-/]/)).filter(Boolean)
}

/** Every way the quote writes each of its words, keyed by the word in lower case. */
function quoteSpellings(quote: string): Map<string, string[]> {
  const spellings = new Map<string, string[]>()
  for (const part of shortFormParts(quote)) {
    const key = part.toLowerCase()
    const seen = spellings.get(key) ?? []
    if (!seen.includes(part)) seen.push(part)
    spellings.set(key, seen)
  }
  return spellings
}

/** A quote with capitals and no lower-case letter at all: a banner or a heading in capitals. */
function quoteInCapitalsThroughout(quote: string): boolean {
  return /[A-Z]/.test(quote) && !/[a-z]/.test(quote)
}

/**
 * Short forms the TEXT writes in lower case where its quote writes them only in capitals:
 * "an hr consultancy" from "We are an HR consultancy". Those that are unexplained are
 * already reported by findUnexplainedAcronyms; these are the KNOWN ones (and numerals),
 * which would otherwise ship as "you run an hr consultancy". A word the quote also writes
 * in lower case is not one: "IT" and the pronoun "it" are the same letters.
 */
function shortFormsWrittenInLowerCase(text: string, quote: string): Array<{ written: string; quoted: string }> {
  const inQuote = quoteSpellings(quote)
  const found: Array<{ written: string; quoted: string }> = []
  for (const part of shortFormParts(text)) {
    if (part !== part.toLowerCase()) continue
    const spellings = inQuote.get(part) ?? []
    if (spellings.includes(part)) continue
    const quoted = spellings.find(s =>
      ((/^[A-Z0-9]{2,6}s?$/.test(s) && /[A-Z]/.test(s)) || isMixedCaseShortForm(s)) && !isUnexplainedShortForm(s))
    if (quoted !== undefined) found.push({ written: part, quoted })
  }
  return found
}

const QUOTE_IN_CAPITALS_REASON = 'its quote is written in capitals throughout, so which of its words are short forms cannot be told'

/**
 * Every short-form problem with a clause or a kind, against the quote it came from, as
 * reasons. Used by checkDoesClause and checkFirmKind, and the one call composition needs to
 * re-check a stored clause against its stored quote.
 *
 * A QUOTE IN CAPITALS THROUGHOUT ("WE FIT COLD ROOMS") cannot show which of its words are
 * short forms: read by its capitals every short word is one. So the clause is refused for
 * that, in its own words, rather than for "COLD", and only the clause's own capitals are
 * read for acronyms. Fails to the next candidate or rung, the safe side.
 */
export function shortFormProblems(text: string, quote: string | null): string[] {
  const unexplained = (acronym: string) => `unexplained acronym "${acronym}": a reader may not know it`
  if (quote !== null && quoteInCapitalsThroughout(quote)) {
    return [QUOTE_IN_CAPITALS_REASON, ...findUnexplainedAcronyms(text).map(unexplained)]
  }
  return [
    ...findUnexplainedAcronyms(text, quote).map(unexplained),
    ...(quote === null ? [] : shortFormsWrittenInLowerCase(text, quote)
      .map(({ written, quoted }) => `writes "${written}" in lower case where its quote writes "${quoted}": a short form is written as the page writes it`)),
  ]
}

/**
 * Written "and": an ampersand is a spelling of the word, and the same word is not an added one.
 *
 * ONLY WHERE IT JOINS TWO WORDS: a space on both sides ("pay & reward"), or two or more
 * lower-case letters on both ("pay&reward"). Until version 20 every ampersand was rewritten,
 * so "M&A advisory" became "M and A advisory" and passed: the one-letter halves are skipped
 * by every word check. Nobody in that trade writes it so. Left alone, a letter-ampersand-
 * letter token is refused for its ampersand, as it was before version 16.
 */
export function ampersandAsAnd(text: string): string {
  return text
    .replace(/\s+&\s+/g, ' and ')
    .replace(/(?<=[a-z]{2})&(?=[a-z]{2})/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A word a trailing phrase opens on. What comes before it USUALLY stands as a clause without
 * it, and not always: "practices so [that ...]", "landlords deal [with ...]" and "homes that
 * want [to ...]" each end just before one of these. cutToWordCap holds the kept part to the
 * form of its last word for that reason.
 */
const TAIL_OPENERS = new Set([
  'to', 'through', 'for', 'during', 'across', 'by', 'with', 'in', 'on', 'at', 'from', 'of', 'that', 'which', 'who',
  'while', 'so', 'as', 'within', 'throughout', 'via', 'using',
])
/** A repaired clause is still a clause: "you" plus a verb plus at least two more words. */
const REPAIR_MIN_WORDS = 4

/**
 * Verbs that happen to end the way nouns do. "you help families manage" must not pass for
 * the "-age" of "storage". A list, so it catches what it names; the rest is the form rule.
 */
const VERBS_WITH_A_NOUN_ENDING = new Set([
  'manage', 'engage', 'encourage', 'leverage', 'ensure', 'secure', 'assure', 'insure', 'procure', 'nurture',
  'capture', 'measure', 'restructure', 'bring', 'mention', 'position', 'transition', 'implement', 'complement',
  'supplement', 'document', 'experience', 'influence', 'balance', 'finance', 'advance', 'enhance', 'reference',
])

/**
 * Does a word have the FORM of a noun: a plural, or an ending nouns have? Code has no
 * dictionary. A noun with neither ("design", "support", "advice") is not recognised, and
 * whatever needed it is refused: the safe side.
 */
function hasNounForm(word: string): boolean {
  const last = word.toLowerCase().replace(/[^a-z]/g, '')
  if (VERBS_WITH_A_NOUN_ENDING.has(last)) return false
  return hasPluralForm(last) || /(?:ing|tion|sion|ment|ance|ence|ship|ity|ics|acy|ncy|egy|ogy|ure|ness|ism|age)$/.test(last)
}

function hasPluralForm(word: string): boolean {
  const last = word.toLowerCase().replace(/[^a-z]/g, '')
  return last.length > 3 && last.endsWith('s') && !/(?:ous|less|ss|us|is)$/.test(last)
}

/** Endings that are as often a describing word as a noun: "engaging", "secure", "average". */
const AMBIGUOUS_NOUN_ENDING = /(?:ing|ure|age)$/

/** Does a list item end as a DESCRIBING phrase does: "market aligned", "low cost", "simple to use"? */
function itemDescribes(item: string): boolean {
  if (/\sto\s/i.test(` ${item} `)) return true
  const last = (words(item).pop() ?? '').toLowerCase().replace(/[^a-z]/g, '')
  return /(?:ly|ed|al|ive|able|ible|ic|ous|ful|less)$/.test(last)
    || ['cost', 'based', 'free', 'first', 'proof', 'ready', 'friendly', 'efficient', 'simple', 'secure', 'safe',
      'fast', 'easy', 'quick', 'clear', 'fair', 'lean', 'new', 'modern', 'smart'].includes(last)
}

/** A head that needs BOTH sides of what follows it: "the gap between A, B", "everything from A, to B". */
const NEEDS_BOTH_SIDES = /\b(?:between|everything from|ranging from|both|either|(?:mix|range|combination|variety|blend|number|selection) of)\b/i

/**
 * THE FIRST ITEM OF A LIST (operator note 6 on the fourth reading: "use the first item of a
 * comma list"). "you provide digital marketing, website design, and brand development" is
 * refused for its commas: an opener holds one thing. Its first item, "you provide digital
 * marketing", is what the page says and nothing more.
 *
 * ONLY WHERE THE CUT LEAVES A PHRASE THAT STANDS. A list of describing words shares the
 * noun at its end ("committed, effective, and sustainable cultures"), and cut at the first
 * comma it reads "you help organisations create committed". So the cut is made only when
 * the first item has two words or more after its verb AND either every item has two words
 * or more, or the last item is a single word (so no noun at the end is shared). Anything
 * else returns null and the clause is refused as before. The result is checked like any
 * other clause and judged like any other.
 *
 * THREE MORE REFUSALS, version 20, each from a clause that passed and read broken:
 *   - a later item that ends as a describing phrase does means the list is one of
 *     describing words ("engaging, inclusive and well attended events");
 *   - a first item ending -ing, -ure or -age is a noun only as often as not ("coaching",
 *     "engaging"), so it also needs two later items to read: one later item after a comma
 *     is a pair of describing words ("engaging, well attended events");
 *   - a head that needs both sides ("the gap between finance teams, IT and operations").
 * KNOWN LIMIT: a describing item with no describing ending and not on the short list
 * ("bespoke") is not recognised.
 */
export function firstItemOfList(does: string): string | null {
  const clause = does.trim()
  const firstComma = clause.indexOf(',')
  if (firstComma < 0) return null
  const head = clause.slice(0, firstComma).trim()
  const headWords = words(head)
  if (headWords.length < REPAIR_MIN_WORDS) return null
  if (NEEDS_BOTH_SIDES.test(head)) return null
  const rest = clause.slice(firstComma + 1)
    .split(/,|\s+(?:and|or)\s+/i)
    .map(item => item.trim().replace(/^(?:and|or)\s+/i, ''))
    .filter(Boolean)
  if (rest.length === 0) return null
  const sizes = rest.map(item => words(item).length)
  const everyItemIsAPhrase = sizes.every(n => n >= 2)
  const noSharedNounAtTheEnd = sizes[sizes.length - 1] === 1
  if (!everyItemIsAPhrase && !noSharedNounAtTheEnd) return null
  if (rest.some(itemDescribes)) return null
  // AND THE FIRST ITEM ENDS ON A NOUN. Describing phrases of two words pass the test above
  // ("fair, market aligned, and motivating reward structures"), and the cut read "you help
  // organisations build fair". Code has no dictionary, so this is by the FORM of the last
  // word: a plural, or an ending nouns have. A noun with neither ("design", "support") is
  // not cut, and the clause is refused for its commas as before: the safe side.
  const last = (headWords[headWords.length - 1] ?? '').toLowerCase().replace(/[^a-z]/g, '')
  if (!hasNounForm(last)) return null
  if (AMBIGUOUS_NOUN_ENDING.test(last) && !(last.length > 3 && last.endsWith('s')) && rest.length < 2) return null
  return head
}

/** Words that need the "of" after them: "a wide range [of ...]". A cut never ends on one. */
const NEEDS_ITS_OF = new Set(['range', 'variety', 'number', 'mix', 'selection', 'series', 'kind', 'kinds', 'type', 'types', 'sort', 'sorts', 'lot', 'lots', 'part', 'parts', 'set', 'sets'])

/**
 * Words that turn a statement round or fence it in. Cut what follows one of these and the
 * clause can say the OPPOSITE of the page, or more than it: "you help councils stop
 * developers [from building on flood plains]". A clause holding one is never cut.
 */
const LIMITS_THE_CLAIM = new Set([
  'stop', 'prevent', 'against', 'avoid', 'replace', 'ban', 'without', 'instead', 'not', 'never', 'no', 'except',
  'unless', 'only', 'reduce', 'end', 'remove', 'block', 'fight', 'oppose', 'cut',
])

/**
 * A CLAUSE OVER THE WORD CAP, CUT AT ITS TRAILING PHRASE. "you work with senior executives
 * and investors to accelerate operational effectiveness through performance improvement" is
 * over the cap; cut before "through" it is the same statement with its means left off. Cut
 * before the LAST word that opens a trailing phrase and leaves the clause at or under the
 * cap. Null when the clause is under the cap already, or no such cut stands.
 *
 * THE KEPT PART MUST END ON A NOUN'S FORM (version 20). Until then any cut before a trailing
 * word was taken, and these passed every code check and composed: "you manage the IT for
 * small accountancy practices so", "you help landlords deal", "you help care homes that
 * want", "you supply commercial kitchens for a wide range", "you help firms recruit
 * graduates by working". A cut that ends otherwise is not taken and the next one to the
 * left is tried. The price: a sound cut ending on a noun with no noun's form ("a pragmatic
 * roadmap", "the startup process") is not taken either, and the clause is refused for its
 * length as it was before repairs existed.
 */
export function cutToWordCap(does: string): string | null {
  const w = words(does)
  if (w.length <= DOES_MAX_WORDS) return null
  const bare = (word: string) => word.toLowerCase().replace(/[^a-z]/g, '')
  if (w.some(word => LIMITS_THE_CLAIM.has(bare(word)))) return null
  for (let i = Math.min(DOES_MAX_WORDS, w.length - 1); i >= REPAIR_MIN_WORDS; i--) {
    if (!TAIL_OPENERS.has(bare(w[i]))) continue
    const last = bare(w[i - 1])
    const before = bare(w[i - 2] ?? '')
    if (!hasNounForm(last) || NEEDS_ITS_OF.has(last) || TAIL_OPENERS.has(last)) continue
    // AN -ING WORD THAT IS A VERB, NOT A NOUN. Straight after a trailing word it is that
    // phrase's verb ("by working [with ...]"). Straight after a plural it says what those
    // people do ("charities working [with young people]"), where after a describing word or
    // a singular it is the name of a service ("executive coaching", "equipment servicing").
    // The price: "sales training" is refused with it.
    if (last.endsWith('ing') && (TAIL_OPENERS.has(before) || hasPluralForm(before))) continue
    return w.slice(0, i).join(' ').replace(/[,;]+$/, '')
  }
  return null
}

/**
 * Every form of a clause worth checking, in order: as written, then the repairs. EACH
 * REPAIR ONLY REMOVES WORDS, which is the one thing the extraction itself is allowed to do
 * to a quote ("you may leave a word out; you may never put one in"), so a repaired clause
 * holds no word the page does not. IT CAN STILL CLAIM MORE THAN THE PAGE: a limit left off
 * ("for firms that cannot afford counsel") makes a wider statement. The judge is told that
 * a left-off ending is not twisting, on purpose and by measurement, so it does not hold
 * this; cutToWordCap refuses to cut a clause holding a word that fences the claim in, and
 * what is left is a statement that is true and broader than the page's.
 *
 * TWO REPAIRS AND NO THIRD: a list cut to its first item, and a clause cut at its trailing
 * phrase. There is none for an unexplained acronym. One was tried and removed the same day:
 * see findUnexplainedAcronyms.
 */
export type ClauseRepair = 'none' | 'first_item' | 'cut_to_cap' | 'first_item_then_cut'

export function clauseForms(does: string): Array<{ does: string; repair: ClauseRepair }> {
  const written = ampersandAsAnd(does)
  const forms: Array<{ does: string; repair: ClauseRepair }> = [{ does: written, repair: 'none' }]
  // A REPAIR THAT LEAVES LITTLE IS NOT ONE. See specificWordCount.
  const worthKeeping = (form: string) => specificWordCount(form) >= 2
  const first = firstItemOfList(written)
  if (first) {
    if (worthKeeping(first)) forms.push({ does: first, repair: 'first_item' })
    const firstCut = cutToWordCap(first)
    if (firstCut && worthKeeping(firstCut)) forms.push({ does: firstCut, repair: 'first_item_then_cut' })
  }
  const cut = cutToWordCap(written)
  if (cut && worthKeeping(cut)) forms.push({ does: cut, repair: 'cut_to_cap' })
  return forms
}

/** The longest kind of firm, in words, article included. */
export const FIRM_KIND_MAX_WORDS = 6

/** The two verbs the broad line may open on. */
export type KindVerb = 'run' | 'are'

export function isKindVerb(value: unknown): value is KindVerb {
  return value === 'run' || value === 'are'
}

/**
 * The broad line as a clause the opener frames can carry, exactly as the specific one:
 * "you run an HR consultancy", "you are an organisational consultant".
 *
 * THE VERB IS GIVEN, NEVER GUESSED. A kind that names an organisation takes "run"; one that
 * names a person or a maker takes "are". The first version said "you run" in front of
 * every kind. The second guessed from the ending of the last word (-ant, -er, -or, -ist,
 * -ian) and so said "you run" in front of every person whose word ends otherwise: a coach,
 * an architect, an agent, an analyst. No ending and no list of professions covers every
 * market. The extraction, which has read the page, says which verb fits; the judge then
 * audits the clause that ships, verb included, and is asked whether it reads as a sentence.
 * A kind with no verb is not a broad line.
 */
export function broadClause(kind: string, verb: KindVerb): string {
  return `you ${verb} ${kind.trim()}`
}

/**
 * The BROAD rung: what kind of firm this is, with its article ("an HR consultancy" as the
 * page writes it). Held to its quote exactly as the clause is, and refused when it names
 * nothing: a kind that every prospect on this client's list shares (the client's own
 * generic_kind_words), with or without a word about its size, ownership or place.
 */
export function checkFirmKind(kind: string, quote: string, sourceText: string, clientGeneric: ReadonlySet<string> = NO_CLIENT_WORDS): ClauseVerdict {
  const reasons: string[] = []
  const phrase = kind.trim()
  const w = words(phrase)
  if (w.length === 0) return { ok: false, reasons: ['empty'] }
  if (!/^(a|an)$/.test(w[0])) reasons.push('does not start with "a" or "an"')
  if (w.length < 2) reasons.push('names no kind of firm')
  if (w.length > FIRM_KIND_MAX_WORDS) reasons.push(`${w.length} words, over ${FIRM_KIND_MAX_WORDS}`)
  if (/[.!?;:,]|[—–&]|--|\s-\s/.test(phrase)) reasons.push('holds punctuation, a dash or an ampersand')
  if (/\d/.test(phrase.replace(/\bB2[BC]\b/gi, '')) || NUMBER_WORDS.test(phrase)) reasons.push('contains a number')
  if (/\b(your|yours|you)\b/i.test(phrase)) reasons.push('holds "you" or "your"')
  reasons.push(...shortFormProblems(phrase, quote))
  for (const [name, re] of [['praise', PRAISE], ['absence', ABSENCE], ['time', TIME], ['hedge', HEDGE], ['audience', AUDIENCE], ['marketing', MARKETING]] as const) {
    const m = phrase.match(re)
    if (m) reasons.push(`${name} word "${m[0]}"`)
  }
  const lowerSource = sourceText.toLowerCase()
  for (const token of w.slice(1)) {
    const bare = token.replace(/[^A-Za-z0-9'-]/g, '')
    if (!/^[A-Z]/.test(bare)) continue
    for (const part of bare.split('-').filter(part => /^[A-Z]/.test(part))) {
      if (!lowerSource.includes(part.toLowerCase())) reasons.push(`proper noun "${part}" is not in the source`)
    }
  }
  const absent = findWordsAbsentFromQuote(phrase, quote, { carrierAfterYou: false })
  if (absent.length > 0) reasons.push(`not in the quote: ${absent.join(', ')}`)
  reasons.push(...kindFormReasons(phrase, quote))
  if (kindIsGeneric(phrase, clientGeneric)) reasons.push('names nothing specific: true of any firm on this client\'s list')
  return { ok: reasons.length === 0, reasons }
}

const CATEGORY_ACRONYMS = new Set(['UK', 'US', 'EU', 'IT', 'HR', 'AI', 'B2B', 'B2C', 'SaaS', 'SME', 'SMEs'])

/** The {for_whom} checks: a plural customer category, never a name, never bare-vague. */
export function checkForWhom(forWhom: string, sourceText: string): ClauseVerdict {
  const reasons: string[] = []
  const phrase = forWhom.trim()
  const w = words(phrase)
  if (w.length === 0) return { ok: false, reasons: ['empty'] }
  if (w.length > FOR_WHOM_MAX_WORDS) reasons.push(`${w.length} words, over ${FOR_WHOM_MAX_WORDS}`)
  // Vague when EVERY content word is a bare category noun: "businesses", and equally
  // "corporations and organizations". Tier 2 needs a SPECIFIC customer group; a qualified
  // one ("growth-stage companies", "boutique hotels") passes.
  //
  // Determiners are not content ("our clients" is as bare as "clients", and in the sender's
  // offer it reads as the SENDER's clients), and a category noun is as vague in the singular
  // as in the plural ("business owners" is two bare nouns).
  const DETERMINERS = ['and', 'or', 'the', 'other', 'their', 'our', 'your', 'its', 'my', 'these', 'those', 'such', 'various', 'many', 'some']
  const isVague = (t: string) => VAGUE_FOR_WHOM.has(t) || VAGUE_FOR_WHOM.has(`${t}s`) || VAGUE_FOR_WHOM.has(`${t}es`)
  const contentWords = w.map(t => t.toLowerCase().replace(/[^a-z-]/g, '')).filter(t => t && !DETERMINERS.includes(t))
  if (contentWords.every(t => isVague(t))) reasons.push(`bare vague category "${phrase}"`)
  // The group is printed inside the sender's sentence. An ampersand, a dash or a list of
  // three breaks a style rule there and used to cost the prospect the whole firm-fact email.
  if (/[—–&]|--|,/.test(phrase)) reasons.push('holds an ampersand, a dash or a comma')
  if (/\d/.test(phrase) || NUMBER_WORDS.test(phrase)) reasons.push('contains a number')
  // A RANGE IS NOT A GROUP. "small businesses to multinational corporations" means
  // everyone, and shipped as "We book first meetings with small businesses to multinational
  // corporations for you" in a real composed email (2026-09-30).
  if (/\b(to|through|from|any|every|all|of all sizes|of any size)\b/i.test(phrase)) reasons.push('a range or "everyone", not a specific group')
  // A capitalised word is a name ("Acme customers", "NHS trusts"), except a short list of
  // category acronyms that are not organisations.
  const named = w.filter(t => /^[A-Z]/.test(t) && !CATEGORY_ACRONYMS.has(t.replace(/[^A-Za-z0-9]/g, '')))
  if (named.length > 0) reasons.push(`looks like a named organisation ("${named.join(' ')}")`)
  // Plural at the head or the tail: "regional food wholesalers" ends on the plural, and
  // "businesses seeking IT help" opens on it. Both fit "meetings with {for_whom}".
  const isPlural = (t: string) => /s$/.test(t) || ['people', 'staff', 'children'].includes(t)
  if (!isPlural(w[w.length - 1].toLowerCase()) && !isPlural(w[0].toLowerCase())) reasons.push('not plural')
  for (const [name, re] of [['praise', PRAISE], ['absence', ABSENCE], ['audience', AUDIENCE]] as const) {
    const m = phrase.match(re)
    if (m) reasons.push(`${name} word "${m[0]}"`)
  }
  // At least one content word of the category must be on the page.
  const lowerSource = sourceText.toLowerCase()
  const content = w.map(t => t.toLowerCase().replace(/[^a-z-]/g, '')).filter(t => t.length > 3)
  if (content.length > 0 && !content.some(t => lowerSource.includes(t.replace(/s$/, '')))) {
    reasons.push('no word of it is on the page')
  }
  return { ok: reasons.length === 0, reasons }
}

/** The quote must be a verbatim span of the page (whitespace and case normalised). */
export function quoteIsVerbatim(quote: string, sourceText: string): boolean {
  const norm = (s: string) => decodePageText(s).toLowerCase().replace(/\s+/g, ' ').trim()
  const q = norm(quote)
  return q.length >= 12 && norm(sourceText).includes(q)
}

/**
 * Section ranking (Round 5, P3): a named service or niche says more than body text, and
 * body text more than the title or tagline. Lower is better.
 */
export const SECTION_RANK: Record<string, number> = { service: 0, niche: 0, body: 1, title: 2, tagline: 2 }

// ─── Faithfulness, in code (operator rule 10, 2026-10-01) ─────────────────────
//
// THE RULE AS GIVEN: code fails any noun in the clause that is absent from the source quote.
//
// WHAT IS BUILT, AND WHY IT IS WIDER. There is no part-of-speech tagger here, and nouns
// cannot be isolated safely without one. Measured on the 32 distinct real clauses stored on
// 2026-09-30, a nouns-only approximation passed a clause the judge had failed ("advice and
// strategies to corporations", read as an infinitive) and could not catch a real added VERB:
// "you help grantmakers select and implement..." against a quote saying "streamline" and
// "implement". So every content word of the clause must be in the quote, except "help" or
// "provide" straight after "you". That subsumes the noun rule and catches both of the
// operator's must-fail controls deterministically.
//
// TWO FORMS OF ONE WORD MATCH BY INFLECTION ONLY: a plural, a tense, an -ing form. The
// first matcher allowed any pair of endings on a shared stem, derivational ones included
// (-al, -ation, -ship, -ic, -y), so it called leadership and leaders one word, and general
// and generation, market and marketing, police and policy, medical and medication. Each of
// those lets an added concept through a check whose whole point is that it cannot be argued
// with. Found by review on 2026-10-01; the pairs are now a test. The price: "install" no
// longer matches "installation". The extraction prompt says so, and tells the model to keep
// the page's noun and open on "you provide".
//
// STILL EQUAL, AND KNOWN: an -ing noun and its verb are one word here ("marketing" and
// "market", "training" and "train"). Telling them apart needs the part of speech. The judge
// is the second gate on those.
//
// A REJECTED CLAUSE SHIPS THE TEMPLATE, which is always safe. That is why every doubt in
// this section resolves to "not the same word".

/** Words the quote check ignores: grammar, not content. Shared with the judge's prompt. */
export const QUOTE_CHECK_STOP_WORDS: readonly string[] = [
  'you', 'your', 'we', 'our', 'us', 'they', 'their', 'them', 'its', 'this', 'that', 'these', 'those',
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'into', 'through',
  'during', 'across', 'over', 'under', 'between', 'within', 'about', 'as', 'via', 'per', 'up', 'down', 'out',
  'off', 'who', 'which', 'what', 'when', 'where', 'how',
]
const STOP = new Set(QUOTE_CHECK_STOP_WORDS)
/**
 * Exempt ONLY as the word straight after "you": "you provide IT support" still checks
 * "support". Exactly the two the extraction prompt allows. "deliver", "offer" and "support"
 * were here too, and each is a real service in some trade: "you deliver parcels" against a
 * quote about software that TRACKS parcels passed the check.
 */
export const CARRIER_VERBS: readonly string[] = ['help', 'provide']

/** British and American spellings are one word: organise / organize. */
function spell(word: string): string {
  return word.toLowerCase().replace(/is(e|es|ed|ing|ation|ations|ational)$/, 'iz$1')
}

/** Irregular forms no ending rule reaches. Generic English, a short list on purpose. */
const IRREGULAR_BASE: Record<string, string> = {
  built: 'build', sold: 'sell', made: 'make', ran: 'run', using: 'use', used: 'use', bought: 'buy',
  paid: 'pay', led: 'lead', kept: 'keep', held: 'hold', taught: 'teach', grew: 'grow', grown: 'grow',
  wrote: 'write', written: 'write', gave: 'give', given: 'give', took: 'take', taken: 'take',
  chose: 'choose', chosen: 'choose', found: 'find', sent: 'send', brought: 'bring', met: 'meet',
}

/**
 * The base forms a word could be an INFLECTION of, itself included.
 *   plurals      cities -> city, boxes -> box, trays -> tray
 *   past tense   supplied -> supply, managed -> manage, fitted -> fit
 *   -ing form    making -> make, running -> run, designing -> design
 * Nothing derivational: no -ation, -ment, -al, -ship, -er.
 *
 * A stem is at least three letters, so "thing" is never read as "the" plus -ing, and
 * "feed" is never read as the past tense of "fee".
 */
function baseForms(word: string): Set<string> {
  const forms = new Set([word])
  const irregular = IRREGULAR_BASE[word]
  if (irregular) forms.add(irregular)
  if (word.endsWith('ies') && word.length > 4) forms.add(word.slice(0, -3) + 'y')
  if (/(s|x|z|ch|sh)es$/.test(word)) forms.add(word.slice(0, -2))
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) forms.add(word.slice(0, -1))
  if (word.endsWith('ied') && word.length > 4) forms.add(word.slice(0, -3) + 'y')
  for (const ending of ['ed', 'ing']) {
    if (!word.endsWith(ending)) continue
    const stem = word.slice(0, -ending.length)
    if (stem.length < 3) continue
    forms.add(stem)
    forms.add(stem + 'e')
    if (/([b-df-hj-np-tv-z])\1$/.test(stem)) forms.add(stem.slice(0, -1))
  }
  return forms
}

/** Two forms of one word: their possible base forms meet. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true
  const formsB = baseForms(b)
  for (const form of baseForms(a)) if (formsB.has(form)) return true
  return false
}

/**
 * The content words of a clause that its source quote does not contain. Empty means
 * faithful in form.
 *
 * `carrierAfterYou: false` is for the customer group, which has no leading "you" and so no
 * carrier verb to exempt.
 */
export function findWordsAbsentFromQuote(clause: string, quote: string, opts: { carrierAfterYou?: boolean } = {}): string[] {
  const tokens = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^A-Za-z0-9]+/).filter(t => t.length > 1)
  const quoteTokens = tokens(quote)
  const quoteWords = [...new Set(quoteTokens.map(spell))]
  const absent: string[] = []
  tokens(clause).forEach((token, index) => {
    // Acronyms (IT, HR, AI, B2B) must appear in capitals: "IT" must not match the pronoun.
    if (/^[A-Z0-9]+$/.test(token) && /[A-Z]/.test(token) && token.length <= 4) {
      if (!quoteTokens.includes(token)) absent.push(token)
      return
    }
    const word = spell(token)
    if (STOP.has(word)) return
    if (opts.carrierAfterYou !== false && index === 1 && CARRIER_VERBS.includes(word)) return
    if (!quoteWords.some(q => sameWord(word, q))) absent.push(token)
  })
  return [...new Set(absent)]
}
