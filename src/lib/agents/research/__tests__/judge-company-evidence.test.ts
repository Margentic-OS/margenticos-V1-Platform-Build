// The fit judge must be shown the company it is grading.
//
// Measured before this change, on one client's 111 researched prospects: 17 had a staff
// count in what the judge read and 15 a company description, while staff count and industry
// sat in their own columns on all 111. See company-facts.ts.
//
// Each case below names ONE fact and proves it reaches the judge's message, so deleting that
// fact from the mapping or from the formatter fails a test that says which fact went missing.
// The loader case uses a fake that returns ONLY the columns the select asked for, so dropping
// a column from the select fails too, instead of passing on a row the fake handed over anyway.

import { describe, it, expect } from 'vitest'
import { buildSynthesisParams, type ClientDocContext, type DetectedSignal } from '../synthesize'
import { companyFactsFromRow, formatCompanyFacts, COMPANY_FACTS_PREAMBLE, KEYWORD_LIMIT } from '../company-facts'
import { loadProspectContext } from '../prospect-context'
import type { CompanyFacts } from '../company-facts'
import type { ProspectContext, RawSourceData } from '../types'

const CLIENT_CTX: ClientDocContext = {
  clientName:         'Placeholder Client',
  buyerTitle:         'Placeholder Buyer',
  icpSummary:         'Placeholder summary of who the client sells to.',
  positioningSummary: 'Placeholder positioning.',
  valuePropContext:   'Placeholder value proposition.',
  tovRules:           'Placeholder tone rules.',
}

const SIGNAL: DetectedSignal = { has_dateable_signal: true, signal_observation: 'Placeholder dated item' }

const KEYWORDS = Array.from({ length: 40 }, (_, i) => `placeholder-keyword-${String(i + 1).padStart(2, '0')}`)

/** A prospect row carrying every company fact the platform records. */
const ROW = {
  company_headcount: 12,
  company_industry: 'Placeholder Industry A',
  website_url: 'placeholder-company.example',
  apollo_enrichment_data: {
    organization: {
      industries: ['placeholder industry a', 'Placeholder Industry B'],
      secondary_industries: ['Placeholder Industry C'],
      founded_year: 2011,
      organization_revenue: 1_200_000,
      keywords: KEYWORDS,
      website_url: 'http://www.placeholder-company.example',
    },
  },
}

function prospect(company: CompanyFacts | null): ProspectContext {
  return {
    id: 'p-1', organisation_id: 'org-1', segment_id: 'seg-1',
    first_name: 'Placeholder', last_name: 'Person', company_name: 'Placeholder Company',
    country: null, role: null, job_title: 'Placeholder Title', email: null,
    linkedin_url: null, website_url: 'placeholder-company.example',
    company,
  }
}

function sources(): RawSourceData {
  return {
    linkedin:   { available: false, profile_data: null, recent_posts: [], formatted: null, error: 'not fetched' },
    apollo:     { available: true, formatted: 'Seniority: placeholder', raw: null, error: undefined },
    website:    { available: true, url: 'https://placeholder-company.example', content: 'Placeholder website text.', fetch_method: 'fetch', error: undefined },
    web_search: { available: false, person_search: null, company_search: null, combined: null, error: 'not run', providers: [], search_count: 0, result_count: 0 },
  } as unknown as RawSourceData
}

const judgeReads = (company: CompanyFacts | null) =>
  buildSynthesisParams(prospect(company), sources(), CLIENT_CTX, SIGNAL).messages[0].content as string

const FULL = judgeReads(companyFactsFromRow(ROW))

describe('every company fact already on file reaches the fit judge', () => {
  it.each([
    ['staff count',          'Staff count: 12'],
    ['industry',             'Industry: Placeholder Industry A'],
    ['other industries',     'Placeholder Industry B'],
    ['secondary industries', 'Placeholder Industry C'],
    ['founded year',         'Founded: 2011'],
    ['recorded revenue',     'Recorded revenue: 1,200,000'],
    ['keywords',             'placeholder-keyword-01'],
    ['website',              'Website: placeholder-company.example'],
  ])('%s', (_fact, expected) => {
    expect(FULL).toContain(expected)
  })

  it('arrives in its own section, opened by the instruction that none of it is copy', () => {
    expect(FULL).toContain(`## Company on file\n\n${COMPANY_FACTS_PREAMBLE}\n\nStaff count: 12`)
    expect(FULL.indexOf('## Company on file')).toBeLessThan(FULL.indexOf('## Research gathered'))
  })
})

describe('what the section leaves out, and why', () => {
  it('does not repeat the primary industry among the others, whatever its case', () => {
    expect(FULL.match(/placeholder industry a/gi)).toHaveLength(1)
  })

  it(`sends the first ${KEYWORD_LIMIT} keywords and says how many there were`, () => {
    expect(FULL).toContain(`placeholder-keyword-${KEYWORD_LIMIT}`)
    expect(FULL).not.toContain(`placeholder-keyword-${KEYWORD_LIMIT + 1}`)
    expect(FULL).toContain(`(first ${KEYWORD_LIMIT} of 40)`)
  })

  it('never presents a revenue of zero as a figure, because the source records unknown as zero', () => {
    const row = { ...ROW, apollo_enrichment_data: { organization: { ...ROW.apollo_enrichment_data.organization, organization_revenue: 0 } } }
    expect(formatCompanyFacts(companyFactsFromRow(row))).not.toMatch(/revenue/i)
  })

  it('still shows the columns when the stored enrichment subset is absent', () => {
    const facts = companyFactsFromRow({ company_headcount: 7, company_industry: 'Placeholder Industry A', website_url: null, apollo_enrichment_data: null })
    expect(formatCompanyFacts(facts)).toBe('Staff count: 7\nIndustry: Placeholder Industry A')
  })

  it('returns null when nothing is on file', () => {
    expect(companyFactsFromRow({ company_headcount: null, company_industry: '  ', website_url: null, apollo_enrichment_data: { organization: {} } })).toBeNull()
  })
})

describe('a prospect with nothing on file gets the request it got before this section existed', () => {
  it('has no company section', () => {
    expect(judgeReads(null)).not.toContain('## Company on file')
  })

  it('differs from a prospect WITH facts by exactly that section and nothing else', () => {
    const withoutSection = FULL.replace(/## Company on file\n\n[\s\S]*?\n\n(?=## Recency check)/, '')
    expect(withoutSection).not.toBe(FULL)
    expect(withoutSection).toBe(judgeReads(null))
  })
})

describe('the loader carries the facts from the row it read', () => {
  // Returns ONLY the columns the select named. A fake that handed back the whole row would
  // pass even after a column was dropped from the select, which is the failure worth catching.
  function projectingClient(row: Record<string, unknown>) {
    const writes: unknown[] = []
    const client = {
      from: () => ({
        select: (cols: string) => {
          const wanted = cols.split(',').map(c => c.trim())
          const chain = {
            eq: () => chain,
            single: async () => ({ data: Object.fromEntries(wanted.map(c => [c, row[c] ?? null])), error: null }),
          }
          return chain
        },
        update: (payload: unknown) => { writes.push(payload); return { eq: () => ({ eq: async () => ({ error: null }) }) } },
      }),
    }
    return { client: client as never, writes }
  }

  it('builds the same company facts the row holds, and writes nothing when the segment is set', async () => {
    const { client, writes } = projectingClient({
      id: 'p-1', organisation_id: 'org-1', segment_id: 'seg-1', variant_id: null,
      first_name: 'Placeholder', last_name: 'Person', company_name: 'Placeholder Company',
      role: null, job_title: 'Placeholder Title', email: null, linkedin_url: null,
      ...ROW,
    })
    const { ctx } = await loadProspectContext(client, 'p-1', 'org-1')
    expect(ctx.company).toEqual(companyFactsFromRow(ROW))
    expect(ctx.company?.staff_count).toBe(12)
    expect(ctx.company?.industry).toBe('Placeholder Industry A')
    expect(writes).toHaveLength(0)
  })

  it('carries the sourced job title, which the judge\'s header reads', async () => {
    const { client } = projectingClient({
      id: 'p-1', organisation_id: 'org-1', segment_id: 'seg-1', variant_id: null,
      first_name: 'Placeholder', last_name: 'Person', company_name: 'Placeholder Company',
      role: null, job_title: 'Placeholder Title', email: null, linkedin_url: null,
      ...ROW,
    })
    const { ctx } = await loadProspectContext(client, 'p-1', 'org-1')
    expect(ctx.job_title).toBe('Placeholder Title')
  })
})
