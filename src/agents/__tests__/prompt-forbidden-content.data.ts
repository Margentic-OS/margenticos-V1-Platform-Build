// ═══════════════════════════════════════════════════════════════════════════
// DATA FILE. NOT A MODULE ANYTHING BUILDS A PROMPT FROM.
//
// THIS FILE CONTAINS, ON PURPOSE, THE EXACT STRINGS WE ARE BANNING FROM PROMPT
// TEXT. Their presence here is the whole mechanism: a deny list works by holding
// the thing it denies. That makes this the one legitimate place in the repository
// where these terms may live, and it makes importing it into anything that
// assembles a prompt the single worst thing that could be done with it.
//
// THE CONSTRAINT, STATED SO IT CANNOT BE MISSED:
//   Nothing under src/ that builds, loads, formats or sends prompt text may import
//   this file. It is imported by its own test and by nothing else.
//   prompt-forbidden-content.test.ts asserts that, by reading every prompt-building
//   module and failing if any names this file. That test is the enforcement; this
//   comment is only the explanation.
//
// WHAT IS DELIBERATELY ABSENT: real company names, real people, real prospects,
// real clients. Enumerating them in a PUBLIC repository would publish the very
// thing the swap pass exists to remove, and the list could never be complete
// anyway. Names are caught structurally instead, by ORG_NAME_SHAPE below, and
// removed by the swap pass. Do not add a real name here. If a real name is the
// only way to catch something, the answer is a structural pattern, not an entry.
//
// HOW TO EXTEND: add a pattern, run the test, read the new hits. If a pattern
// produces a hit on text that is doing its job correctly, the pattern is wrong,
// not the prompt. A scan people stop trusting is a scan people start exempting.
// ═══════════════════════════════════════════════════════════════════════════

export interface Pattern { label: string; re: RegExp }

// ─── Category 1: named industry or sector ────────────────────────────────────
//
// DUPLICATED FROM prompt-industry-agnostic.test.ts, KNOWINGLY. That scan is a
// per-file baseline ratchet over the FIVE document-agent markdown files. This one
// covers every runtime prompt source there is, markdown and TypeScript template
// literal alike, which is fourteen. Sharing one list would mean sharing one
// baseline regime, and the two have different jobs. Consolidating them is worth
// doing once the swap pass has driven both to zero; until then two lists that
// agree is the lesser evil, and this comment is what stops the drift being silent.
export const NAMED_INDUSTRY: Pattern[] = [
  // TWO TERMS ARE QUALIFIED RATHER THAN BARE, each because the bare form produced a
  // false positive on text that was doing its job:
  //   "construction" matched "sentence construction" in the messaging prompt.
  //   "logistics"    matched "agreement, hostility, or pure logistics" in the FAQ
  //                  extraction prompt, where it is ordinary English for "practical
  //                  arrangements" and names no industry at all.
  // Both now require an industry noun after them. Narrowing the pattern is the
  // correct response to a false positive; exempting the line is not.
  {
    label: 'named industry or sector',
    re: /\b(consult(ing|ant|ancy)|school catering|catering suppl|logistics (compan|firm|provider|sector|industry|business|operator)|SaaS|manufactur(ing|er)|recruitment agenc|law firm|accountanc|hospitality|construction (firm|compan|industry|sector|business)|e-?commerce|fintech|healthcare provider)\b/i,
  },
]

// ─── Category 2: buyer title or archetype asserted as a default ──────────────
//
// THE QUALIFIER IS THE WHOLE PATTERN. A prompt may legitimately use the WORD
// "founder" while instructing the model to derive the buyer from the ICP document.
// What it may not do is assert one as the default the model should assume. So each
// pattern requires the assertion frame, not the noun:
//   "e.g. Founder / Managing Director"     <- a default, in a schema placeholder
//   "typically the founder"                <- a default, in prose
//   "the founder is your buyer"            <- a default, stated outright
// and not:
//   "read the buyer title from the ICP document"
const TITLE = '(founder|co-?founder|owner|managing director|ceo|cto|cmo|coo|cfo|vp of [a-z ]{3,20}|head of [a-z ]{3,20}|sales director|marketing director|operations director|practice lead|principal|partner)'

export const BUYER_ARCHETYPE: Pattern[] = [
  {
    label: 'buyer title given as a schema default or example value',
    re: new RegExp(`e\\.g\\.[^"\\n]{0,40}\\b${TITLE}\\b`, 'i'),
  },
  {
    // THE NEGATIVE LOOKBEHIND IS LOAD-BEARING, NOT DEFENSIVE. Without it this fired
    // on messaging-agent.md L798, "Do not assume the prospect is a founder", which is
    // the rule FORBIDDING the assumption doing its job perfectly. Flagging the rule
    // that enforces the thing you are scanning for is the fastest way to teach people
    // the scan is noise. An assertion and its prohibition read almost identically to
    // a regex; the difference is entirely in the few words before the verb.
    label: 'buyer title asserted as the typical or default buyer',
    re: new RegExp(`(?<!\\b(?:do not|do NOT|don't|never|must not|cannot|can't|avoid|without)\\s{1,4})\\b(typically|usually|normally|generally|most often|by default|assume)\\b[^.\\n]{0,40}\\b(the |a |an )?${TITLE}\\b`, 'i'),
  },
  {
    label: 'buyer archetype asserted as the reader',
    re: new RegExp(`\\b(the|your) ${TITLE}\\b[^.\\n]{0,30}\\b(is|are) (your|the) (buyer|reader|audience|prospect|target)\\b`, 'i'),
  },
  {
    label: 'founder-led asserted as the buyer archetype',
    re: /\bfounder[- ]led\b/i,
  },
]

// ─── Category 3: revenue band, headcount band, currency figure ───────────────
//
// EVERY ONE OF THESE REQUIRES A FIGURE. This is the calibration that decides
// whether the scan is usable. The bare nouns "revenue" and "headcount" appear
// throughout the prompts inside the RULES THAT FORBID THEM, for example
//   "- a currency amount, a revenue figure, a headcount, a price or a volume"
// which is the ban being stated correctly. A pattern on the bare noun would fire
// on 20+ lines that are working exactly as intended, and that is precisely how a
// scan earns a blanket exemption and stops scanning. So: no figure, no hit.
export const MONEY_AND_SIZE: Pattern[] = [
  {
    label: 'currency symbol followed by a digit',
    re: /[£$€¥]\s?\d/,
  },
  {
    label: 'a digit followed by K or M as a magnitude',
    re: /\b\d+(?:\.\d+)?\s?[KM]\b/,
  },
  {
    label: 'a spelled-out money magnitude',
    re: /\b\d+(?:\.\d+)?\s?(?:bn|billion|million|thousand)\b/i,
  },
  {
    label: 'a headcount band or figure',
    // "2-8 people", "5 to 20 employees", "team of 12", "5-person", "1–2 person"
    re: /\b(?:team of \d+|\d+\s?[-–—]\s?\d+\s?(?:people|employees|person|staff)|\d+\s+to\s+\d+\s+(?:people|employees|staff)|\d+[- ]person|\d+\s?(?:employees|staff|headcount))\b/i,
  },
  {
    label: 'a revenue or ARR band',
    re: /\b(?:ARR|MRR|revenue|turnover|billings?)\b[^.\n]{0,25}[£$€¥]?\s?\d|\b\d[^.\n]{0,25}\b(?:ARR|MRR)\b/i,
  },
]

// ─── Category 4: a real organisation, by name shape ──────────────────────────
//
// NOT A LIST OF COMPANIES, and it must never become one. A corporate suffix is
// the one part of a company name that is structural rather than arbitrary, so it
// is the only part a pattern can honestly catch. This will not catch a name
// without a suffix. That is a known and accepted limit: the swap pass removes
// those, and this catches the regression shape most likely to be pasted back in.
export const ORG_NAME_SHAPE: Pattern[] = [
  {
    label: 'a company-name suffix, which implies a real named organisation',
    re: /\b[A-Z][A-Za-z&'-]{1,24}\s+(?:Ltd|Limited|Inc|Incorporated|LLC|PLC|GmbH|S\.?A\.?R\.?L|BV|NV|Pty|AB|AG|SpA|Oy)\b\.?/,
  },
  {
    label: 'a domain name, which is a real organisation by another route',
    re: /\b[a-z0-9][a-z0-9-]{1,30}\.(?:com|co\.uk|io|ai|net|org|ie|de|fr)\b/i,
  },
]

// The whole deny list, in the order violations are reported.
export const FORBIDDEN: { category: string; patterns: Pattern[] }[] = [
  { category: 'named industry or sector', patterns: NAMED_INDUSTRY },
  { category: 'buyer title or archetype as default', patterns: BUYER_ARCHETYPE },
  { category: 'revenue, headcount or currency figure', patterns: MONEY_AND_SIZE },
  { category: 'named organisation', patterns: ORG_NAME_SHAPE },
]

export const ALL_PATTERNS: Pattern[] = FORBIDDEN.flatMap(c => c.patterns)
