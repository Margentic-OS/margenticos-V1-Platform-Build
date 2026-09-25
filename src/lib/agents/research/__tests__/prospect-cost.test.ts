// What a prospect cost, priced from returned usage rather than from an average.
//
// THE DEFECT THIS GUARDS. The batch progress log multiplied a prospect count by
// COST_APIFY + 0.020. That 0.020 is the midpoint of a range cost-constants.ts itself
// records as "roughly 8x low, because they priced ONE call rather than four", and the sum
// carried NO web search term, though web search costs more per prospect than the whole
// figure it printed. Measured against the runs of 2026-09-24 it understated by 7.4x to 9.5x.

import { describe, it, expect } from 'vitest'
import {
  prospectCostUsd,
  usdForTokens,
  USD_PER_MTOK,
  COST_APIFY,
  COST_WEB_SEARCH_PER_SEARCH,
} from '../cost-constants'

const ZERO_WS = { input_tokens: 0, output_tokens: 0, model: null }
const NO_SONNET = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

describe('usdForTokens', () => {
  it('prices Sonnet input and output at the published rate', () => {
    // 1M input + 1M output at 3.00 / 15.00.
    expect(usdForTokens({ input_tokens: 1e6, output_tokens: 1e6 }, 'claude-sonnet-4-6')).toBeCloseTo(18, 6)
  })

  it('CHARGES FOR CACHE TOKENS, which is the whole reason this is not a two-line sum', () => {
    // This pipeline reads ~6x more cached input than fresh input, and a cache read bills at
    // a tenth of input. A price table ignoring them is wrong by more than it measures.
    const withCache = usdForTokens(
      { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6 },
      'claude-sonnet-4-6',
    )
    expect(withCache).toBeCloseTo(3.75 + 0.30, 6)
    expect(withCache).toBeGreaterThan(0)
  })

  it('prices Haiku three times cheaper than Sonnet, so a blended count could not be priced', () => {
    const t = { input_tokens: 1e6, output_tokens: 0 }
    expect(usdForTokens(t, 'claude-haiku-4-5-20251001')).toBeCloseTo(1, 6)
    expect(usdForTokens(t, 'claude-sonnet-4-6')).toBeCloseTo(3, 6)
  })

  it('prices an UNKNOWN model at the most expensive rate, never at zero', () => {
    const t = { input_tokens: 1e6, output_tokens: 0 }
    const dearest = Math.max(...Object.values(USD_PER_MTOK).map(r => r.input))
    expect(usdForTokens(t, 'claude-something-unreleased')).toBeCloseTo(dearest, 6)
    expect(usdForTokens(t, null)).toBeCloseTo(dearest, 6)
    // The failure mode being excluded: a renamed model silently costing nothing.
    expect(usdForTokens(t, 'claude-something-unreleased')).toBeGreaterThan(0)
  })
})

describe('prospectCostUsd', () => {
  // The measured shape of one prospect on the 2026-09-21 profile: synthesis output ~8,700
  // tokens, and 2.83 billable searches at the console-confirmed $0.01.
  const measured = {
    sonnet: {
      input_tokens: 3016,
      output_tokens: 6610,
      cache_creation_input_tokens: 3018,
      cache_read_input_tokens: 21421,
    },
    webSearch: { input_tokens: 9487, output_tokens: 368, model: 'claude-haiku-4-5-20251001' },
    webSearchCount: 3,
    apifyRan: true,
  }

  it('is several times the figure the progress log used to print', () => {
    const OLD_CONSTANT = COST_APIFY + 0.020
    expect(prospectCostUsd(measured)).toBeGreaterThan(OLD_CONSTANT * 3)
  })

  it('INCLUDES web search, both the fee and the tokens that buy it', () => {
    const withSearch = prospectCostUsd(measured)
    const withoutSearch = prospectCostUsd({ ...measured, webSearch: ZERO_WS, webSearchCount: 0 })
    const searchCost = withSearch - withoutSearch
    // The fee alone is 3 x $0.01. If the tokens were being dropped — the original blind
    // spot — the difference would equal the fee exactly.
    expect(searchCost).toBeGreaterThan(measured.webSearchCount * COST_WEB_SEARCH_PER_SEARCH)
    expect(searchCost).toBeCloseTo(
      measured.webSearchCount * COST_WEB_SEARCH_PER_SEARCH
        + usdForTokens(measured.webSearch, measured.webSearch.model),
      8,
    )
  })

  it('charges the Apify ceiling only when the actor ran', () => {
    const ran    = prospectCostUsd({ ...measured, apifyRan: true })
    const didNot = prospectCostUsd({ ...measured, apifyRan: false })
    expect(ran - didNot).toBeCloseTo(COST_APIFY, 8)
  })

  it('costs a stored-findings reuse nothing, because it calls nothing', () => {
    expect(prospectCostUsd({
      sonnet: NO_SONNET, webSearch: ZERO_WS, webSearchCount: 0, apifyRan: false,
    })).toBe(0)
  })

  it('never returns zero for a prospect that made calls', () => {
    // The shape that made a failing run look free.
    expect(prospectCostUsd(measured)).toBeGreaterThan(0)
  })
})
