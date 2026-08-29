// AUTO-EXTRACTED from c7d42c1 (c7d42c1) by scripts/regen-before-research-queries.ts.
// DO NOT EDIT. Regenerate with:
//   npx tsx scripts/regen-before-research-queries.ts
//
// This is src/agents/positioning-generation-agent.ts as it SHIPPED at c7d42c1, the commit immediately before the
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
// leading words only. Returns '' when the answer is too thin to be worth searching.
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

// Derives 4 competitor-focused research queries from the client's intake data.
// Unlike the ICP agent (which researches buyer pain), positioning research targets:
//   1. How direct competitors position themselves — the dominant narrative to differentiate against
//   2. What buyers search for — the category language they use when looking for this service
//   3. What satisfied buyers say — value language from case studies and reviews
//   4. What failure modes look like — the white space no competitor owns
//
// Every query interpolates the client's own intake text. Nothing here names an
// industry or a service type. An earlier version selected between two hardcoded
// consulting literals on each branch, so intake could not change the query.
// Exported for tests: the industry-agnosticism guarantee is only meaningful if
// something asserts that intake text actually reaches the query strings.
export function buildPositioningQueriesBefore(intake: IntakeRow[]): string[] {
  const val = (key: string) =>
    intake.find(r => r.field_key === key)?.response_value?.trim() ?? ''

  const whatYouDo  = condense(val('company_what_you_do'), 12)
  const currency   = val('company_currency')
  const offer      = condense(val('offer_deliverables'), 12)
  const buyer      = condense(val('clients_clone'), 12)

  // A soft geographic hint only, used to narrow search results.
  const geoHint = currency === 'GBP' ? 'UK'
    : currency === 'EUR' ? 'Europe'
    : currency === 'USD' ? 'US'
    : 'English-speaking markets'

  // What this client sells. Falls back to their deliverables when the service
  // description is thin, and to the buyer description when both are thin.
  const service = whatYouDo || offer || buyer

  // Query 1: Competitor positioning — what do others selling this claim?
  const competitorPositioningQuery = service
    ? `${service} providers positioning messaging claims ${geoHint} 2025`
    : `B2B service providers positioning messaging claims ${geoHint} 2025`

  // Query 2: Buyer search language — how do buyers describe what they want?
  const buyerSearchQuery = buyer
    ? `${buyer} "looking for" OR "need help with" ${service} ${geoHint} 2025`
    : `${service} buyer search intent category language ${geoHint} 2025`

  // Query 3: Case study and review language — what do satisfied buyers say?
  const caseStudyQuery = service
    ? `${service} case study results testimonial review ${geoHint} 2025`
    : `B2B service case study results testimonial review ${geoHint} 2025`

  // Query 4: Failure modes and white space — what frustrations do buyers voice?
  const failureModeQuery = service
    ? `${service} "didn't work" OR "failed" OR "disappointed" review complaints 2025`
    : `B2B service provider "didn't work" OR "failed" OR "disappointed" review complaints 2025`

  return [competitorPositioningQuery, buyerSearchQuery, caseStudyQuery, failureModeQuery]
}
