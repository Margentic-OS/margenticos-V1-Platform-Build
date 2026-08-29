// Research descriptor resolution — SHARED by the ICP and positioning document agents.
//
// WHY THIS IS A LIB MODULE AND NOT A HELPER INSIDE ONE AGENT. Both document agents build
// web-research queries from the same intake, and both need the same three answers: is this
// text usable as a search term, who is the buyer, and where does this client operate.
// They had SEPARATE COPIES of that logic and the copies diverged: the ICP agent was fixed
// on 2026-08-28 and again on 2026-08-29 while the positioning agent kept the original,
// so for a day the same intake produced a checked query in one document and raw narrative
// prose in the other. One module means the next fix cannot land in only one of them.
//
// It lives under src/lib/agents/ rather than being imported agent-to-agent. An agent
// importing another agent is the shape CLAUDE.md's one-file-one-agent rule exists to stop,
// and it is also how circular imports get built: those pass tsc and vitest and fail only
// `npm run build`.
//
// Nothing here names an industry, a service type or a buyer archetype. Every list is a
// closed grammatical class or a documented heuristic over generic English.

/** The subset of an intake row these helpers read. Both agents' row types satisfy it. */
export interface IntakeRow {
  field_key: string
  field_label: string
  response_value: string | null
  section: string
  is_critical: boolean
}

/** Reads a single intake answer, trimmed. Returns '' when absent. */
export function intakeValue(intake: IntakeRow[], key: string): string {
  return intake.find(r => r.field_key === key)?.response_value?.trim() ?? ''
}


// Splits text into sentences and keeps whole ones up to a word budget.
//
// WHY WHOLE SENTENCES. The previous version took the first N words flat, which cut mid
// clause and left a dangling fragment on the end of the search term. The one live
// ideal-client answer that passes the usability check below produced
// "... 15-80 staff. Usually the founder is", and those last four words are a subject
// with no predicate. They are noise to a search engine and they were in every query.
//
// If the FIRST sentence alone is over budget there is nothing to keep whole, so it is cut
// at the budget as before. That is the honest fallback, not a special case.
function firstSentences(text: string, maxWords: number): string {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0)
  const kept: string[] = []
  let words = 0
  for (const sentence of sentences) {
    const n = sentence.split(/\s+/).filter(Boolean).length
    if (kept.length > 0 && words + n > maxWords) break
    kept.push(sentence.trim())
    words += n
    if (words >= maxWords) break
  }
  return trimDanglingFunctionWords(
    kept.join(' ').split(/\s+/).filter(Boolean).slice(0, maxWords).join(' ').trim())
}

// Function words that carry no meaning as the LAST token of a search fragment. A hard cut
// at the word budget lands on one of these often, and the result is a query ending
// "...on a contractual basis with", where the trailing three words are pure noise: they
// promise a complement that was cut off.
//
// Closed class, and trailing position only. The same words are load-bearing anywhere else
// in the fragment, so this never touches the middle.
const DANGLING_TAIL =
  /(?:\s+\b(?:with|to|for|into|on|at|by|from|of|and|or|the|a|an|in|as|that|which|who|is|are|was|were)\b)+[\s,;:]*$/i

function trimDanglingFunctionWords(text: string): string {
  let out = text.replace(/[\s,;:]+$/, '')
  // Applied repeatedly: "basis with the" needs three passes, and one pass of a greedy
  // alternation still stops at the first non-match from the right.
  for (let i = 0; i < 6; i++) {
    const next = out.replace(DANGLING_TAIL, '').replace(/[\s,;:]+$/, '')
    if (next === out) break
    out = next
  }
  return out
}

// Condenses a free-text intake answer into a short search fragment.
// Search engines degrade badly on long natural-language strings, so we take the leading
// sentences only. Returns '' when the answer is too thin to be worth searching, which is
// what makes the caller fall back rather than assume anything about the client's industry.
export function condense(text: string, maxWords: number): string {
  const cleaned = text
    .replace(/["‘’“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Intake answers are written in the first person ("We supply hot school meals to
    // primary schools"). The leading clause is noise in a search engine, so drop it
    // and keep the subject matter. Nothing here depends on the words that follow.
    //
    // TWO PASSES, and the second one is not redundant. The named list handles the
    // MULTI-WORD verbs, where stripping one token would leave a stranded preposition
    // ("We work with founder-led businesses" must lose both words, not just "work").
    .replace(/^(we|our team|our company|i)\s+(are|is|do|help|supply|provide|offer|sell|deliver|work with|specialise in|specialize in|run)\s+/i, '')
    // The general pass catches every other verb. A FIXED VERB LIST WAS A BUG: it rejected
    // "We manufacture industrial fasteners", because "manufacture" is not on the list, so
    // the text kept its "We" opener, usableDescriptor rejected the pronoun, and the client
    // got no research at all. The list can never be complete, and its incompleteness fails
    // in the direction of losing research rather than of a worse query.
    //
    // This is the same shape as the prose word-floor applied to a parsed phrase: a rule
    // written for one field, correct there, and wrong when it meets a different one.
    .replace(/^(we|our team|our company|i)\s+\S+\s+/i, '')
    // A strip can leave a stranded leading function word. Mirror of the trailing trim.
    .replace(/^(?:\b(?:with|to|for|into|on|at|by|from|of|and|or|as|that|which|who)\b\s+)+/i, '')
  return firstSentences(cleaned, maxWords)
}

// A condensed intake answer is USABLE as a search descriptor only if it reads as a
// description of a kind of organisation. The check replaces an emptiness check that could
// not tell a thin answer from an off-question one: `clients_clone` is answered in prose by
// a person describing a relationship, and a non-empty answer that never names a buyer is
// the common case, not the edge case.
//
// Measured against the real intake of all five organisations on 2026-08-28. Four of the
// five `clients_clone` answers fail this check and one passes, and the four that fail are
// the four that produced queries no search engine could serve.
//
// Both criteria are category-level. Neither names an industry, a buyer archetype or a
// service type, so the check behaves the same for any client in any market.
//
// The failure is deliberately asymmetric, but NOT in the direction it used to be. A false
// reject now costs research entirely (see resolveBuyerDescriptor), where it used to fall
// through to the service description. That is the point: a wrong population researched
// confidently is worse than no population researched at all.

// Criterion one: the descriptor must open with a noun phrase.
// A subject pronoun has no antecedent a search engine can resolve, and a subordinating
// conjunction opens a story rather than naming a population. Possessives are deliberately
// absent: "our clients are hospital procurement leads" opens with "our" and is a perfectly
// good descriptor, so rejecting on it would cost more than it saves.
const NON_DESCRIPTOR_OPENERS = new Set([
  'i', 'we', 'they', 'he', 'she', 'it', 'you', 'them', 'us', 'me',
  'this', 'that', 'these', 'those',
  'when', 'if', 'because', 'after', 'before', 'since', 'while', 'although', 'though', 'once',
])

// Criterion two: the descriptor must not be about the person who filled in the form.
// A first-person singular marker anywhere in it means the answer turned into the
// respondent's own story, which is what "let me solve our problem" and "was my first" are.
// Plural "we" and "our" are not included: a client describing their own buyer often says
// "companies we sell to", and that is still a descriptor.
const FIRST_PERSON_SINGULAR = /\b(i|me|my|mine|myself)\b/i

// Applies the two criteria above. Shared, because a free-text intake answer and an
// extracted recipient phrase must both read as a population, but they do NOT share a
// length floor. See the two constants below.
function readsAsPopulation(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return false

  const firstWord = words[0].toLowerCase().replace(/[^a-z']/g, '')
  if (NON_DESCRIPTOR_OPENERS.has(firstWord)) return false

  return !FIRST_PERSON_SINGULAR.test(text)
}

// TWO FLOORS, CHOSEN BY THE CALLER, because "too short to be worth searching" means
// different things for a sentence somebody typed and for a noun phrase we parsed out.
// Getting this wrong has now cost research twice, in both directions, so the choice is
// explicit at every call site rather than defaulted.

/**
 * Floor for a FREE-TEXT answer, where shortness means the person did not really answer.
 * "they needed support" is three words of narrative and names no population.
 */
export const MIN_PROSE_WORDS = 3

/**
 * Floor for a NOUN PHRASE: an extracted recipient, or a category name. Here shortness is
 * precision, not thinness. Both of these were rejected by the prose floor and both are
 * exactly the right search term:
 *   "B2B consultants"       the buyer, parsed out of a service description
 *   "industrial fasteners"  the category, after the first-person opener is stripped
 */
export const MIN_PHRASE_WORDS = 2

// Returns the descriptor when it is usable as a search term, and '' when it is not.
// Exported for tests.
export function usableDescriptor(condensed: string, minWords: number = MIN_PROSE_WORDS): string {
  const words = condensed.split(/\s+/).filter(Boolean)
  if (words.length < minWords) return ''
  return readsAsPopulation(condensed) ? condensed : ''
}

// ─── Buyer descriptor resolution ──────────────────────────────────────────────

// THE DEFECT THIS REPLACES, measured across three ICP generations on 2026-08-27/28.
//
// `const buyer = cloneClient || whatYouDo` fell back to the SERVICE DESCRIPTION when the
// ideal-client answer was unusable. A service description names what the client sells, not
// who buys it, so the buyer-population queries asked about the wrong thing entirely. The
// live query read "<service description> typical company size revenue headcount profile
// 2025", which is not a population a search engine can serve, and research came back empty
// on all four queries for four of the five organisations.
//
// The service description is still the right place to look, but for the RECIPIENT inside
// it rather than for the whole string. Every service description names who it is for:
// "... to founder-led businesses", "... into hospitals, care homes", "help B2B
// consultants ...". Extracting the complement of a recipient marker is a grammatical rule
// and holds in any industry.

export type BuyerDescriptorSource =
  /** `clients_clone` — the field that actually asks who the buyer is. */
  | 'ideal_client'
  /** The recipient named inside `company_what_you_do`. */
  | 'service_recipient'
  /** Neither yielded a population. Research is skipped rather than guessed. */
  | 'none'

export interface BuyerDescriptor {
  /** The search term. '' exactly when source is 'none'. */
  text: string
  source: BuyerDescriptorSource
}

// Recipient markers, most explicit first. All are closed-class function words or the
// small set of verbs that take a beneficiary. Nothing here names an industry or a buyer.
//
// ORDER IS LOAD-BEARING. The prepositions are tried before the verbs because a service
// description commonly contains both: "We sell medical mattresses into hospitals" matches
// "sell" earlier in the string than "into", and matching on "sell" returns the PRODUCT
// ("medical mattresses into hospitals") instead of the buyer. Measured on the live
// intake: preposition-first is what turns that case from a product string into
// "hospitals, care homes".
const RECIPIENT_MARKERS: RegExp[] = [
  /\b(?:to|into|for)\s+/i,
  /\b(?:help|helps|helping|serve|serves|serving|support|supports|supporting)\s+/i,
  /\bwith\s+/i,
]

// Tokens that cannot continue a noun phrase naming a population. The extraction stops at
// the first one, so an adjunct clause after the recipient is dropped rather than searched.
// Closed-class: prepositions that open an adjunct, subordinators, and relativisers.
const RECIPIENT_BOUNDARY_FUNCTION_WORDS =
  'on|through|by|using|via|across|from|so|who|which|that|because|when|while|and then'

// Generic English verbs that open a predicate about the recipient rather than continuing
// to name them. "help B2B consultants GET more meetings" names the buyer in the two words
// before the verb; without this the phrase runs on into the benefit being sold and the
// query asks about the outcome instead of the population.
//
// THIS ONE IS A HEURISTIC AND THE OTHER LIST IS NOT, which is why they are separate.
// Function words are a closed class and can be enumerated. Verbs cannot, so this list is
// the common ones and will miss others. The miss is safe by construction: an unrecognised
// verb leaves a LONGER descriptor, capped at MAX_RECIPIENT_WORDS, which is the behaviour
// before this list existed. It cannot produce a different population, only a wordier
// version of the right one.
//
// Every verb here is industry-neutral. None names a service, a sector or a buyer type,
// so the boundary falls in the same grammatical place for any client in any market.
const RECIPIENT_BOUNDARY_VERBS =
  'get|gets|getting|achieve|achieves|grow|grows|scale|scales|reduce|reduces|' +
  'increase|increases|improve|improves|save|saves|win|wins|build|builds|run|runs|' +
  'manage|manages|find|finds|generate|generates|become|becomes|avoid|avoids|' +
  'stop|stops|make|makes|hit|hits|move|moves|turn|turns|keep|keeps'

const RECIPIENT_BOUNDARY = new RegExp(
  `\\b(?:${RECIPIENT_BOUNDARY_FUNCTION_WORDS}|${RECIPIENT_BOUNDARY_VERBS})\\b`, 'i')

// A recipient phrase longer than this is no longer naming a population, it is describing
// the engagement. Caps the damage when no boundary token appears.
const MAX_RECIPIENT_WORDS = 8

// Pulls the recipient out of a service description. Returns '' when the description names
// no recipient, which is a real outcome and not an error: "We make industrial fasteners"
// genuinely does not say who buys them.
// Exported for tests.
export function recipientFromServiceDescription(raw: string): string {
  const text = raw.replace(/["‘’“”]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return ''

  for (const marker of RECIPIENT_MARKERS) {
    const match = marker.exec(text)
    if (!match) continue

    // Everything after the marker, cut at the end of its own sentence.
    let tail = text.slice(match.index + match[0].length).split(/[.!?;:]/)[0]

    const boundary = RECIPIENT_BOUNDARY.exec(tail)
    if (boundary) tail = tail.slice(0, boundary.index)

    const phrase = tail
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, MAX_RECIPIENT_WORDS)
      .join(' ')
      // "etc" and a trailing comma are list punctuation, not part of the population.
      .replace(/[,\s]*\betc\.?$/i, '')
      .replace(/[,\s]+$/, '')
      .trim()

    if (usableDescriptor(phrase, MIN_PHRASE_WORDS)) return phrase
  }

  return ''
}

// Resolves the population the research is about, in the order the intake actually answers
// the question. Exported for tests and for the proof harness.
export function resolveBuyerDescriptor(intake: IntakeRow[]): BuyerDescriptor {
  const val = (key: string) => intakeValue(intake, key)

  // 1. The field that asks the question. When it is answered with a population, use it.
  const idealClient = usableDescriptor(condense(val('clients_clone'), 12))
  if (idealClient) return { text: idealClient, source: 'ideal_client' }

  // 2. Otherwise the recipient named inside the service description.
  const recipient = recipientFromServiceDescription(val('company_what_you_do'))
  if (recipient) return { text: recipient, source: 'service_recipient' }

  // 3. Nothing in intake names a population. The caller skips research and says so.
  return { text: '', source: 'none' }
}

// ─── Geography ────────────────────────────────────────────────────────────────

// Country-code top-level domains that genuinely signal where a business operates.
// This is an allowlist on purpose. The ccTLDs sold as generic vanity domains (.io, .ai,
// .co, .me, .tv and the rest) are absent, so they yield no hint rather than a wrong one.
const COUNTRY_BY_CCTLD: Record<string, string> = {
  ie: 'Ireland',        uk: 'United Kingdom', de: 'Germany',     fr: 'France',
  es: 'Spain',          it: 'Italy',          nl: 'Netherlands', be: 'Belgium',
  pt: 'Portugal',       at: 'Austria',        ch: 'Switzerland', se: 'Sweden',
  no: 'Norway',         dk: 'Denmark',        fi: 'Finland',     pl: 'Poland',
  cz: 'Czech Republic', gr: 'Greece',         ro: 'Romania',     hu: 'Hungary',
  ca: 'Canada',         au: 'Australia',      nz: 'New Zealand', us: 'United States',
  in: 'India',          sg: 'Singapore',      za: 'South Africa', jp: 'Japan',
  br: 'Brazil',         mx: 'Mexico',
}

// Geography comes from the ccTLD of the client's own website and from NOTHING ELSE.
//
// It used to come from currency, which is the inference CLAUDE.md's geography rule
// forbids: EUR spans twenty-odd countries, so a single-country client was searched
// against the whole zone. On the live school-meals client that produced "Ireland" in the
// service description and "Europe" in the same query string, contradicting itself.
//
// ACCEPTED TRADE-OFF, stated because it is a real cost and not an oversight. A generic
// TLD now yields NO geographic hint at all, where currency previously supplied a
// confident wrong one. Three of the five live organisations are on .com and lose their
// hint. A query with no geography returns broader results; a query with the wrong
// geography returns results about the wrong market and reads as though it worked.
// Broader beats wrong, and the fix for broader is a real country signal in intake,
// which does not exist today: there is no country field, and CLAUDE.md forbids
// reconstructing one from currency.
//
// Exported for tests.
export function geographyFromIntake(url: string): string {
  const host = url
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '')

  const labels = host.split('.').filter(Boolean)
  if (labels.length < 2) return ''

  return COUNTRY_BY_CCTLD[labels[labels.length - 1]] ?? ''
}

// ─── Query assembly ───────────────────────────────────────────────────────────

// Joins query fragments, dropping the ones that are empty. Without this an absent
// geography hint leaves a double space in the middle of every query string.
export function q(...parts: string[]): string {
  return parts.filter(s => s.trim().length > 0).join(' ').replace(/\s+/g, ' ').trim()
}
