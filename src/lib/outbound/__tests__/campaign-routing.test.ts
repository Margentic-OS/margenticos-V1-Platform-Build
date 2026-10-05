import { describe, expect, it } from 'vitest'
import { checkRegionConfig, routeProspectToCampaign } from '../campaign-routing'
import { toIso2CountryCode } from '@/lib/sourcing/country-code'

const US = { id: 'us', region_countries: null }
const UKIE = { id: 'ukie', region_countries: ['GB', 'IE'] }

function routedId(campaigns: Array<{ id: string; region_countries: string[] | null }>, country: string | null) {
  const r = routeProspectToCampaign(campaigns, country, 'default')
  return r.ok ? r.campaign.id : `refused: ${r.reason}`
}

describe('routeProspectToCampaign', () => {
  it('GB and IE go to the campaign that names them', () => {
    expect(routedId([US, UKIE], 'GB')).toBe('ukie')
    expect(routedId([US, UKIE], 'IE')).toBe('ukie')
  })

  it('every other country, and unknown, goes to the catch-all', () => {
    for (const c of ['US', 'CA', 'DE', 'AU']) expect(routedId([US, UKIE], c)).toBe('us')
    expect(routedId([US, UKIE], null)).toBe('us')
    expect(routedId([US, UKIE], '')).toBe('us')
  })

  it('order of the campaigns does not matter', () => {
    expect(routedId([UKIE, US], 'GB')).toBe('ukie')
    expect(routedId([UKIE, US], 'US')).toBe('us')
  })

  it('a vendor spelling is normalised before matching', () => {
    expect(routedId([US, UKIE], 'United Kingdom')).toBe('ukie')
    expect(routedId([US, UKIE], 'ireland')).toBe('ukie')
    expect(routedId([US, UKIE], ' gb ')).toBe('ukie')
    expect(routedId([US, UKIE], 'UK')).toBe('ukie')
  })

  it('a single catch-all campaign takes everyone, as before regions existed', () => {
    for (const c of ['GB', 'US', null]) expect(routedId([US], c)).toBe('us')
  })

  it('refuses when no campaign names the country and there is no catch-all', () => {
    expect(routedId([UKIE], 'US')).toMatch(/^refused: .*no campaign for US and no catch-all/)
    expect(routedId([UKIE], null)).toMatch(/^refused: .*unknown country/)
    // ...while still routing the countries it does name
    expect(routedId([UKIE], 'GB')).toBe('ukie')
  })

  it('refuses every prospect when two campaigns are catch-alls', () => {
    const r = routeProspectToCampaign([US, { id: 'us2', region_countries: null }], 'GB', 'default')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/ambiguous/)
  })

  it('refuses every prospect when a country is named twice, including prospects elsewhere', () => {
    const clash = [US, UKIE, { id: 'gb2', region_countries: ['GB'] }]
    expect(routedId(clash, 'GB')).toMatch(/^refused: .*GB is named by two campaigns/)
    expect(routedId(clash, 'US')).toMatch(/^refused/)
  })

  it('refuses with no campaigns at all', () => {
    expect(routedId([], 'US')).toMatch(/^refused: No campaign configured/)
  })
})

describe('checkRegionConfig', () => {
  it('accepts one catch-all plus disjoint regions', () => {
    expect(checkRegionConfig([US, UKIE, { id: 'de', region_countries: ['DE'] }]).ok).toBe(true)
  })
})

describe('toIso2CountryCode: two-letter aliases', () => {
  it('UK is an alias for GB, not an ISO-2 code', () => {
    expect(toIso2CountryCode('UK')).toBe('GB')
    expect(toIso2CountryCode('uk')).toBe('GB')
  })
  it('a real ISO-2 code still passes through', () => {
    expect(toIso2CountryCode('GB')).toBe('GB')
    expect(toIso2CountryCode('ie')).toBe('IE')
  })
})
