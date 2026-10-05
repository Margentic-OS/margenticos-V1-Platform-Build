import { describe, it, expect, vi } from 'vitest'

// PLANTED: the two things Postgres jsonb refuses, as a fetched page can deliver them.
const NUL = '\u0000'
const LONE_HIGH = '\uD83D'          // the first half of an emoji, cut off
const LONE_LOW = '\uDE00'           // a second half with no first
const EMOJI = '😀'        // a whole emoji, which must survive
const DIRTY = `Our${NUL} team${LONE_HIGH} grew ${EMOJI} this year${LONE_LOW}.`
const CLEAN = `Our team grew ${EMOJI} this year.`

vi.mock('../sources/linkedin', () => ({ fetchLinkedInSource: async () => ({ available: true, posts: [{ text: DIRTY }] }) }))
vi.mock('../sources/apollo', () => ({ fetchApolloSource: async () => ({ available: true, raw: { [`head${LONE_HIGH}line`]: DIRTY } }), apolloSourceFromRow: () => null }))
vi.mock('../sources/website', () => ({ fetchWebsiteSource: async () => ({ available: true, text: DIRTY, pages: [DIRTY, 42, null] }) }))
vi.mock('../sources/web-search', () => ({ fetchWebSearchSource: async () => ({ available: true, combined: DIRTY, search_count: 1 }) }))
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { stripNulls } from '../strip-nulls'
import { fetchAllSources } from '../fetch-sources'

/** What Postgres would be sent: no \u0000 escape and no unpaired surrogate escape. */
const storable = (value: unknown) => {
  const json = JSON.stringify(value)
  return !/\\u0000/.test(json) && !/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(json) && !/(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i.test(json)
}

describe('stripNulls also removes lone surrogates', () => {
  it('PLANTED: the dirty string is NOT storable as it is (control)', () => {
    expect(storable({ text: DIRTY })).toBe(false)
  })

  it('removes the null character and both lone surrogate halves, keeps a whole emoji, in nested JSON and keys', () => {
    const out = stripNulls({ a: [DIRTY, { [`k${LONE_LOW}`]: DIRTY }], n: 3, z: null })
    expect(out).toEqual({ a: [CLEAN, { k: CLEAN }], n: 3, z: null })
    expect(storable(out)).toBe(true)
  })

  it('PLANTED: everything fetchAllSources returns is storable, however dirty the page was', async () => {
    const raw = await fetchAllSources({ id: 'p-1' } as never, { apollo_enrichment_data: null } as never)
    expect(storable(raw)).toBe(true)
    expect((raw.website as unknown as { text: string }).text).toBe(CLEAN)
  })
})
