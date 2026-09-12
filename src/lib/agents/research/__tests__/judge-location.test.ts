// THE COUNTRY WE ALREADY HOLD REACHES THE JUDGE.
//
// A client's profile can name where it sells, and the fit judge was left to find a prospect's
// location in the research. Measured 2026-09-11 on a ten-dimension list: location read as unknown
// for 6 of 13 prospects, which is most of what put them in cannot_tell, while prospects.country
// was filled for all 111 researched prospects of the live client.
//
// RULE ZERO: the country here comes from the geography fixture, which is what every other test
// uses instead of naming a real one.

import { describe, it, expect } from 'vitest'
import { buildSynthesisUserMessage, type DetectedSignal } from '../synthesize'
import { PROSPECT_CONTEXT_COLUMNS, prospectContextFromRow } from '../prospect-context'
import { aTargetableCode } from '@/test-utils/geography-fixture'
import type { ProspectContext, RawSourceData } from '../types'

const COUNTRY = aTargetableCode()

const SOURCES = {
  linkedin: { available: false, profile_data: null, recent_posts: null, formatted: null },
  apollo: { available: false, formatted: null, raw: null },
  website: { available: false, url: null, content: null, fetch_method: null },
  web_search: { available: false, person_search: null, company_search: null, combined: null },
} as unknown as RawSourceData
const SIGNAL = { has_dateable_signal: false, signal_observation: null } as DetectedSignal

const prospect = (over: Partial<ProspectContext> = {}): ProspectContext => ({
  id: 'p-1', organisation_id: 'org-1', segment_id: null, first_name: 'Placeholder', last_name: 'Person',
  company_name: 'Placeholder Company', country: COUNTRY, role: null, job_title: 'Placeholder Title',
  email: null, linkedin_url: null, website_url: null, company: null, ...over,
} as ProspectContext)

const header = (p: ProspectContext) => buildSynthesisUserMessage(p, SOURCES, SIGNAL)

describe('the judge is shown the country on the prospect row', () => {
  it('asks the database for it, or the loader could never carry it', () => {
    expect(PROSPECT_CONTEXT_COLUMNS.split(',').map(c => c.trim())).toContain('country')
  })

  it('carries it from the row, and null when the row has none', () => {
    expect(prospectContextFromRow({ id: 'p-1', country: COUNTRY }, null).ctx.country).toBe(COUNTRY)
    expect(prospectContextFromRow({ id: 'p-1' }, null).ctx.country).toBeNull()
  })

  it('puts it in the request, marked as a record of sourcing rather than a finding', () => {
    const line = header(prospect()).split('\n').find(l => l.startsWith('Country: '))
    expect(line).toBe(`Country: ${COUNTRY} (recorded when this prospect was sourced)`)
  })

  it('says so plainly when no country is on file, rather than inventing one', () => {
    const line = header(prospect({ country: null })).split('\n').find(l => l.startsWith('Country: '))
    expect(line).toBe('Country: Not recorded')
  })

  it('sits in the prospect header, above the research, so it is read as a record', () => {
    const text = header(prospect())
    expect(text.indexOf('Country: ')).toBeGreaterThan(text.indexOf('## Prospect'))
    expect(text.indexOf('Country: ')).toBeLessThan(text.indexOf('## Recency check'))
  })
})
