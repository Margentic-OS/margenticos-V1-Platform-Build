// The fit judge's request settings.
//
// The synthesis call grades icp_fit. It ran at the API default temperature of 1.0 and, on
// byte-identical input, disagreed with itself on 4 of 7 prospects. A verdict gains nothing
// from sampling variety, so this call is pinned to 0.
//
// The writer is deliberately NOT pinned (see the comment above its messages.create in
// write-opening.ts). Nothing in this file touches it.

import { describe, it, expect } from 'vitest'
import { buildSynthesisParams, type ClientDocContext, type DetectedSignal } from '../synthesize'
import type { ProspectContext, RawSourceData } from '../types'

const CLIENT_CTX: ClientDocContext = {
  clientName:         'Placeholder Client',
  buyerTitle:         'Placeholder Buyer',
  icpSummary:         'Placeholder summary of who the client sells to.',
  positioningSummary: 'Placeholder positioning.',
  valuePropContext:   'Placeholder value proposition.',
  tovRules:           'Placeholder tone rules.',
}

const SIGNAL: DetectedSignal = { has_dateable_signal: false, signal_observation: 'Placeholder dated item' }

function prospect(overrides: Partial<ProspectContext> = {}): ProspectContext {
  return {
    id: 'p-1', organisation_id: 'org-1', segment_id: 'seg-1',
    first_name: 'Placeholder', last_name: 'Person', company_name: 'Placeholder Company',
    role: null, job_title: 'Placeholder Title', email: null,
    linkedin_url: null, website_url: null, company: null,
    ...overrides,
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

describe('the fit judge does not sample', () => {
  it('sends temperature 0 on the live path', () => {
    expect(buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL, '5m').temperature).toBe(0)
  })

  it('sends temperature 0 on the batch path, which builds the same request with a longer cache', () => {
    expect(buildSynthesisParams(prospect(), sources(), CLIENT_CTX, SIGNAL, '1h').temperature).toBe(0)
  })
})
