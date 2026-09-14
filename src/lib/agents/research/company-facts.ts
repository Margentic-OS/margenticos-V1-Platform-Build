// The company, as already recorded, for the fit judge.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS CLOSES
//
// The synthesis judge grades whether a prospect's COMPANY fits the client, and it was barely
// shown the company. Measured 2026-09-11 on one client's 111 researched prospects: 17 had a
// staff count in what the judge read and 15 had a company description, while staff count and
// industry sat in their own columns on all 111.
//
// The reason is a seam nobody owned. Enrichment writes staff count and industry to
// prospects.company_headcount and prospects.company_industry, and keeps an allow-listed
// organisation subset in apollo_enrichment_data (see apollo-enrichment-subset.ts). The judge's
// enrichment section is formatted from that subset, and the subset deliberately carries
// neither figure, because both already have columns. So the lines formatApolloLines prints for
// them only ever appeared for prospects researched through the older live lookup.
//
// ═════════════════════════════════════════════════════════════════════════════
// NO NEW LOOKUP
//
// Everything below was bought at enrichment and is read from the prospect row. Nothing here
// calls a provider, and nothing here may: the point is to stop wasting what was already paid.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IS DELIBERATELY NOT HERE
//
//   a description      NOT ON FILE. The allow-list keeps none, so there is nothing to pass.
//                      The 15 prospects that had one got it from the older live lookup, and
//                      it still reaches the judge through the enrichment section for them.
//   headcount growth   already in the enrichment section. This block adds what was missing.
//   country            the PERSON's country, not the company's (see the enrichment handler).
//   naics / sic codes  the same classification as the industries, as numbers nobody reads.
//   linkedin url, ids  identifiers, not facts about the company.
//
// ═════════════════════════════════════════════════════════════════════════════
// FIGURES ARE NEVER COPY
//
// Staff count and revenue are exactly the figures the writer's validator bans from email
// (BANNED_FIRMOGRAPHIC). They are here to judge fit, and the section says so to the model.

export interface CompanyFacts {
  staff_count: number | null
  industry: string | null
  /** Every other industry the record lists, primary removed, duplicates removed. */
  other_industries: string[]
  founded_year: number | null
  /** The source records an unknown revenue as 0, so 0 is carried as null, never as a figure. */
  recorded_revenue: number | null
  /** The first KEYWORD_LIMIT keywords, in the order the record holds them. */
  keywords: string[]
  keywords_total: number
  website: string | null
}

/** The prospect columns companyFactsFromRow reads. Every select that feeds it must name all four. */
export interface CompanyFactRow {
  company_headcount: unknown
  company_industry: unknown
  website_url: unknown
  apollo_enrichment_data: unknown
}

/**
 * How many keywords reach the judge. Measured: median 53 per company, maximum 113. The first
 * 25 say what a company does; the rest are long-tail tags that cost tokens and add little.
 */
export const KEYWORD_LIMIT = 25

/** The line that opens the section. Exported so a test can hold it to its promise. */
export const COMPANY_FACTS_PREAMBLE =
  'Recorded for this prospect\'s company when the prospect was enriched. Use these facts when ' +
  'judging fit. They are never email copy: do not quote any figure from this section to the prospect.'

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(text).filter((s): s is string => s !== null) : [])

function distinct(values: string[]): string[] {
  const seen = new Set<string>()
  return values.filter(v => (seen.has(v.toLowerCase()) ? false : (seen.add(v.toLowerCase()), true)))
}

/**
 * Every company fact on file for one prospect row, or null when there are none.
 *
 * Pure: no clock, no database, no provider. The inline path and the batch path both call it,
 * which is what keeps them showing the judge the same thing.
 */
export function companyFactsFromRow(row: CompanyFactRow): CompanyFacts | null {
  const stored = row.apollo_enrichment_data
  const org = stored && typeof stored === 'object'
    ? ((stored as Record<string, unknown>).organization as Record<string, unknown> | undefined) ?? null
    : null

  const industry = text(row.company_industry)
  const listed = distinct([...strings(org?.industries), ...strings(org?.secondary_industries)])
  const keywords = distinct(strings(org?.keywords))

  const facts: CompanyFacts = {
    staff_count: positive(row.company_headcount),
    industry,
    other_industries: industry ? listed.filter(i => i.toLowerCase() !== industry.toLowerCase()) : listed,
    founded_year: positive(org?.founded_year),
    recorded_revenue: positive(org?.organization_revenue),
    keywords: keywords.slice(0, KEYWORD_LIMIT),
    keywords_total: keywords.length,
    website: text(row.website_url) ?? text(org?.website_url),
  }

  const empty = facts.staff_count === null && facts.industry === null && facts.other_industries.length === 0
    && facts.founded_year === null && facts.recorded_revenue === null && facts.keywords.length === 0
    && facts.website === null
  return empty ? null : facts
}

const withCommas = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** The lines the judge reads, one fact per line. null when there is nothing to show. */
export function formatCompanyFacts(facts: CompanyFacts | null): string | null {
  if (!facts) return null
  const lines: string[] = []
  if (facts.staff_count !== null) lines.push(`Staff count: ${facts.staff_count}`)
  if (facts.industry) lines.push(`Industry: ${facts.industry}`)
  if (facts.other_industries.length) {
    lines.push(`${facts.industry ? 'Also listed under' : 'Industries'}: ${facts.other_industries.join(', ')}`)
  }
  if (facts.founded_year !== null) lines.push(`Founded: ${facts.founded_year}`)
  if (facts.recorded_revenue !== null) lines.push(`Recorded revenue: ${withCommas(facts.recorded_revenue)}`)
  if (facts.keywords.length) {
    const count = facts.keywords_total > facts.keywords.length ? ` (first ${facts.keywords.length} of ${facts.keywords_total})` : ''
    lines.push(`Keywords${count}: ${facts.keywords.join(', ')}`)
  }
  if (facts.website) lines.push(`Website: ${facts.website}`)
  return lines.length ? lines.join('\n') : null
}
