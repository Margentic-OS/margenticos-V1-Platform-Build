// Guards the truncation flag added 2026-08-28.
//
// The cap itself is old: fetch-website.ts has cut every page at 3,000 characters since it
// was written. What was missing was any record that it had happened, so a page cut
// mid-word was indistinguishable from a page that was genuinely short, both to a reader of
// intake_website_pages and to the four document agents reading it in their prompt.
//
// These tests are about VISIBILITY, not about the cap. The cap is deliberately unchanged.

import { describe, it, expect, vi } from 'vitest'
import {
  formatWebsiteContextForPrompt,
  countTruncatedPages,
  fetchWebsiteContext,
  type WebsitePageContext,
} from '../website-context'

function page(over: Partial<WebsitePageContext> = {}): WebsitePageContext {
  return { page_label: 'about', url: 'https://example.com/about', text: 'body text', truncated: false, ...over }
}

describe('formatWebsiteContextForPrompt', () => {
  it('marks a truncated page so the agent does not read the cut as the end of the page', () => {
    const out = formatWebsiteContextForPrompt([page({ truncated: true })])
    expect(out).toContain('cut at the fetch limit')
    // The agent must not treat absence below the cut as evidence of anything.
    expect(out).toContain('do not infer anything from what is absent')
  })

  it('says nothing about truncation when nothing was truncated', () => {
    const out = formatWebsiteContextForPrompt([page()])
    expect(out).not.toContain('cut at the fetch limit')
  })

  it('marks only the pages that were actually cut', () => {
    const out = formatWebsiteContextForPrompt([
      page({ page_label: 'homepage', truncated: true }),
      page({ page_label: 'services', truncated: false }),
    ])
    expect(out.match(/cut at the fetch limit/g)).toHaveLength(1)
  })

  it('still keeps the page text, because a cut page is usable and not discarded', () => {
    const out = formatWebsiteContextForPrompt([page({ text: 'certified thermos flasks', truncated: true })])
    expect(out).toContain('certified thermos flasks')
  })
})

describe('countTruncatedPages', () => {
  it('counts only truncated pages', () => {
    expect(countTruncatedPages([])).toBe(0)
    expect(countTruncatedPages([page(), page()])).toBe(0)
    expect(countTruncatedPages([page({ truncated: true }), page(), page({ truncated: true })])).toBe(2)
  })
})

describe('fetchWebsiteContext', () => {
  // The fake honours the columns actually asked for, and THROWS on anything it does not
  // implement. A fake that silently returns rows for an unrequested column is how a
  // dropped filter passes a green suite in this repo's own history.
  function fakeClient(rows: Record<string, unknown>[], captured: { select?: string } = {}) {
    const chain = {
      eq: () => chain,
      order: () => Promise.resolve({ data: rows, error: null }),
      limit: () => { throw new Error('fake does not implement limit') },
    }
    return {
      from: (table: string) => {
        if (table !== 'intake_website_pages') throw new Error(`unexpected table ${table}`)
        return { select: (cols: string) => { captured.select = cols; return chain } }
      },
    } as never
  }

  it('asks the database for the truncation column', async () => {
    // Mutation guard: drop extraction_truncated from the select and every page silently
    // reports truncated:false, which is exactly the invisible state this work removes.
    const captured: { select?: string } = {}
    await fetchWebsiteContext(fakeClient([], captured), 'org-1', 'test')
    expect(captured.select).toContain('extraction_truncated')
  })

  it('carries the flag through from the row', async () => {
    const pages = await fetchWebsiteContext(
      fakeClient([
        { page_label: 'homepage', url: 'u1', extracted_text: 'a', extraction_truncated: true },
        { page_label: 'about', url: 'u2', extracted_text: 'b', extraction_truncated: false },
      ]),
      'org-1',
      'test',
    )
    expect(pages.map(p => p.truncated)).toEqual([true, false])
  })

  it('treats a missing or null flag as not truncated rather than as undefined', async () => {
    // Rows written before the column existed, and any row the backfill did not match.
    const pages = await fetchWebsiteContext(
      fakeClient([{ page_label: 'homepage', url: 'u1', extracted_text: 'a', extraction_truncated: null }]),
      'org-1',
      'test',
    )
    expect(pages[0].truncated).toBe(false)
  })

  it('returns nothing and does not throw when the read fails', async () => {
    const chain = { eq: () => chain, order: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }
    const client = { from: () => ({ select: () => chain }) } as never
    await expect(fetchWebsiteContext(client, 'org-1', 'test')).resolves.toEqual([])
  })
})

describe('the cap itself is unchanged', () => {
  it('is still 3,000 characters per page', async () => {
    // Deliberate. This session made truncation VISIBLE and was instructed not to raise the
    // cap and not to re-fetch. If someone raises it later, this test should be updated in
    // the same commit and the reasoning recorded, rather than the change passing silently.
    const src = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../../intake/fetch-website.ts', import.meta.url), 'utf-8'))
    expect(src).toContain('const MAX_CHARS_PER_PAGE = 3_000')
  })
})
