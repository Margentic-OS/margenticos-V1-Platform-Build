// AUTO-EXTRACTED from origin/main (68b4385) by scripts/prove-research-queries.ts's sibling
// step. This is the PRE-FIX builder, copied mechanically rather than by hand so the
// "before" column of the proof is the code that actually shipped.
//
// Do not edit. Regenerate with:
//   git show origin/main:src/agents/icp-generation-agent.ts

export interface IntakeRow {
  field_key: string
  field_label: string
  response_value: string | null
  section: string
  is_critical: boolean
}

export function condense(text: string, maxWords: number): string {
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

export function buildResearchQueriesBefore(intake: IntakeRow[]): string[] {
  const val = (key: string) =>
    intake.find(r => r.field_key === key)?.response_value?.trim() ?? ''

  const whatYouDo   = condense(val('company_what_you_do'), 12)
  const cloneClient = condense(val('clients_clone'), 12)
  const trigger     = condense(val('clients_trigger'), 12)
  const currency    = val('company_currency')

  // A soft geographic hint only. The ICP prompt's geography rules forbid inferring a
  // market from currency in the DOCUMENT; this narrows search results, nothing more.
  const geoHint = currency === 'GBP' ? 'UK'
    : currency === 'EUR' ? 'Europe'
    : currency === 'USD' ? 'US'
    : 'English-speaking markets'

  // The buyer we are researching. Falls back to the service description when the
  // ideal-client answer is thin, and to neither when both are thin.
  const buyer = cloneClient || whatYouDo

  // Query 1: Buyer pain points — the language real buyers use for the problem this
  // client solves. Grounds four_forces.push entries in market reality.
  const buyerPainQuery = buyer
    ? `${buyer} challenges problems pain points ${geoHint} 2025`
    : `B2B buyer challenges problems pain points ${geoHint} 2025`

  // Query 2: Trigger events — what business events cause this buyer to act?
  const triggerQuery = trigger
    ? `${buyer} ${trigger} buying trigger why now ${geoHint}`
    : `${buyer} buying trigger events when do they invest ${geoHint}`

  // Query 3: Buyer profile reality check — team size, revenue norms, stage language.
  const buyerProfileQuery = buyer
    ? `${buyer} typical company size revenue headcount profile ${geoHint} 2025`
    : `B2B buyer typical company size revenue headcount profile ${geoHint} 2025`

  // Query 4: Competitive landscape — how do others selling THIS CLIENT'S service to
  // THIS CLIENT'S buyer position themselves? Informs disqualifiers and switching costs.
  const competitorQuery = whatYouDo
    ? `${whatYouDo} providers competitors positioning ${geoHint} 2025`
    : `${buyer} suppliers competitors positioning ${geoHint} 2025`

  return [buyerPainQuery, triggerQuery, buyerProfileQuery, competitorQuery]
}
