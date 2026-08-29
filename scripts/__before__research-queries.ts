// AUTO-EXTRACTED from ef20336 (ef20336) by scripts/regen-before-research-queries.ts.
// DO NOT EDIT. Regenerate with:
//   npx tsx scripts/regen-before-research-queries.ts
//
// This is src/agents/icp-generation-agent.ts as it SHIPPED at ef20336, the commit immediately before the
// fix this proves. Sliced out of that commit rather than retyped, so the "before" column
// of the proof table is evidence and not a recollection.

export interface IntakeRow {
  field_key: string
  field_label: string
  response_value: string | null
  section: string
  is_critical: boolean
}

// Condenses a free-text intake answer into a short search fragment.
// Search engines degrade badly on long natural-language strings, so we take the
// leading words only. Returns '' when the answer is too thin to be worth searching,
// which is what makes the caller fall back to a description-only query rather than
// to a hardcoded assumption about the client's industry.
function condense(text: string, maxWords: number): string {
  return text
    .replace(/["\u2018\u2019\u201c\u201d]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Intake answers are written in the first person ("We supply hot school meals to
    // primary schools"). The leading clause is noise in a search engine, so drop it
    // and keep the subject matter. Nothing here depends on the words that follow.
    .replace(/^(we|our team|our company|i)\s+(are|is|do|help|supply|provide|offer|sell|deliver|work with|specialise in|specialize in|run)\s+/i, '')
    .split(' ')
    .slice(0, maxWords)
    .join(' ')
    .trim()
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
// The failure is deliberately asymmetric. A false reject falls back to the service
// description, which is still a real search term. A false accept sends a sentence of
// narrative prose to a search engine and the research comes back empty, which is the
// failure this is here to stop.

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

// Below this a descriptor carries no more information than the generic fallback already
// does, so there is nothing to gain by interpolating it.
const MIN_DESCRIPTOR_WORDS = 3

// Returns the descriptor when it is usable as a search term, and '' when it is not.
// '' is what makes the caller fall back, so an unusable answer and a missing answer take
// the same path. Exported for tests.
function usableDescriptor(condensed: string): string {
  const words = condensed.split(/\s+/).filter(Boolean)
  if (words.length < MIN_DESCRIPTOR_WORDS) return ''

  const firstWord = words[0].toLowerCase().replace(/[^a-z']/g, '')
  if (NON_DESCRIPTOR_OPENERS.has(firstWord)) return ''

  if (FIRST_PERSON_SINGULAR.test(condensed)) return ''

  return condensed
}

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
function geographyFromIntake(url: string): string {
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

// Joins query fragments, dropping the ones that are empty. Without this an absent
// geography hint leaves a double space in the middle of every query string.
function q(...parts: string[]): string {
  return parts.filter(s => s.trim().length > 0).join(' ').replace(/\s+/g, ' ').trim()
}

// Derives 4 targeted search queries from the client's intake data.
// Queries cover: buyer pain points, buying triggers, buyer firmographics, and the
// client's competitive landscape. Each one informs a distinct part of the ICP.
//
// Every query interpolates the client's own intake text. Nothing here names an
// industry, a service type or a buyer archetype. An earlier version selected between
// two hardcoded consulting literals on each branch, so intake could not change the
// query: the .length checks gated which literal was used, and the intake values were
// never interpolated. That put MargenticOS's own competitive set into every client's
// research, whatever business the client was in.
// Exported for tests: the industry-agnosticism guarantee is only meaningful if
// something asserts that intake text actually reaches the query strings.
export function buildResearchQueriesBefore(intake: IntakeRow[]): string[] {
  const val = (key: string) =>
    intake.find(r => r.field_key === key)?.response_value?.trim() ?? ''

  // Every intake answer used as a search term goes through the same usability check, so
  // an off-question answer takes the same path as a missing one.
  const whatYouDo   = usableDescriptor(condense(val('company_what_you_do'), 12))
  const cloneClient = usableDescriptor(condense(val('clients_clone'), 12))
  const trigger     = condense(val('clients_trigger'), 12)

  // The client's own domain, not their currency. See geographyFromIntake.
  const geoHint = geographyFromIntake(val('company_url') || val('assets_website'))

  // The buyer we are researching. Falls back to the service description when the
  // ideal-client answer is unusable, and to neither when both are.
  const buyer = cloneClient || whatYouDo

  // Query 1: Buyer pain points — the language real buyers use for the problem this
  // client solves. Grounds four_forces.push entries in market reality.
  const buyerPainQuery = q(buyer || 'B2B buyer', 'challenges problems pain points', geoHint, '2025')

  // Query 2: Trigger events — what business events cause this buyer to act?
  const triggerQuery = trigger
    ? q(buyer, trigger, 'buying trigger why now', geoHint)
    : q(buyer || 'B2B buyer', 'buying trigger events when do they invest', geoHint)

  // Query 3: Buyer profile reality check — team size, revenue norms, stage language.
  const buyerProfileQuery = q(
    buyer || 'B2B buyer', 'typical company size revenue headcount profile', geoHint, '2025')

  // Query 4: Competitive landscape — how do others selling THIS CLIENT'S service to
  // THIS CLIENT'S buyer position themselves? Informs disqualifiers and switching costs.
  const competitorQuery = whatYouDo
    ? q(whatYouDo, 'providers competitors positioning', geoHint, '2025')
    : q(buyer || 'B2B', 'suppliers competitors positioning', geoHint, '2025')

  return [buyerPainQuery, triggerQuery, buyerProfileQuery, competitorQuery]
}
