// Which research record a grader reads.
//
// A reuse run writes a research row that fetched nothing and makes it the prospect's current
// one. Twelve uploaded prospects were left like that, with their full row still on file. These
// tests hold the reader to the newest row that HOLDS evidence, inside the right organisation,
// and hold the grader to that reader and to writing nothing.

import { describe, it, expect, vi } from 'vitest'

const { built } = vi.hoisted(() => ({ built: [] as Array<{ ctx: unknown; raw: unknown }> }))
vi.mock('../synthesize', () => ({
  buildSynthesisRequest: async (ctx: unknown, raw: unknown) => {
    built.push({ ctx, raw })
    return { params: { model: 'placeholder-model', max_tokens: 1, messages: [] }, clientCtx: {}, detectedSignal: {} }
  },
  synthesisFromMessage: () => ({ icp_fit: 'moderate' }),
}))

import { loadEvidenceRecord, holdsEvidence } from '../evidence-record'
import { gradeFromEvidence } from '../grade-from-evidence'
import { readProspectContext } from '../prospect-context'

type Row = Record<string, unknown>

/**
 * An in-memory client that honours eq, order and limit, and REFUSES writes. A fake that
 * ignored the organisation filter could not catch a grader reading another client's research.
 */
function fakeDb(tables: Record<string, Row[]>) {
  const writes: string[] = []
  const client = {
    from(name: string) {
      const filters: Array<[string, unknown]> = []
      let orderBy: string | null = null
      let ascending = true
      let rowLimit: number | null = null
      const rows = () => {
        let out = (tables[name] ?? []).filter(r => filters.every(([c, v]) => r[c] === v))
        if (orderBy) out = [...out].sort((a, b) => String(a[orderBy!]).localeCompare(String(b[orderBy!])) * (ascending ? 1 : -1))
        return rowLimit === null ? out : out.slice(0, rowLimit)
      }
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return chain },
        order: (c: string, o?: { ascending?: boolean }) => { orderBy = c; ascending = o?.ascending !== false; return chain },
        limit: (n: number) => { rowLimit = n; return chain },
        single: async () => { const r = rows(); return r.length === 1 ? { data: r[0], error: null } : { data: null, error: { message: 'not exactly one row' } } },
        then: (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null }),
        update: () => { writes.push(`update ${name}`); return chain },
        insert: () => { writes.push(`insert ${name}`); return chain },
      }
      return chain
    },
  }
  return { client: client as never, writes }
}

const ORG = 'org-1'
const P = 'p-1'
const skipped = { error: 'skipped: stored findings reused' }

const REUSE = {
  id: 'reuse', prospect_id: P, organisation_id: ORG, created_at: '2026-08-20T22:51:00Z', sources_successful: [],
  raw_linkedin: skipped, raw_apollo: skipped, raw_website: skipped, raw_web_search: skipped,
}
const FULL = {
  id: 'full', prospect_id: P, organisation_id: ORG, created_at: '2026-08-20T15:24:00Z', sources_successful: ['apollo', 'website'],
  raw_linkedin: { error: 'not fetched' },
  raw_apollo: { available: true, formatted: 'Placeholder enrichment lines', raw: null },
  raw_website: { available: true, url: 'https://placeholder.example', content: 'Placeholder full website text', fetch_method: 'direct' },
  raw_web_search: { error: 'no results' },
}
const OLDER_FULL = { ...FULL, id: 'older-full', created_at: '2026-08-19T10:00:00Z' }
const OTHER_CLIENT = {
  ...FULL, id: 'other-client', organisation_id: 'org-2', created_at: '2026-09-01T00:00:00Z',
  raw_website: { available: true, url: 'https://other.example', content: 'Placeholder other client text', fetch_method: 'direct' },
}
const PROSPECT = {
  id: P, organisation_id: ORG, segment_id: null, variant_id: null, first_name: 'Placeholder', last_name: 'Person',
  company_name: 'Placeholder Company', role: null, job_title: 'Placeholder Title', email: null, linkedin_url: null,
  website_url: null, apollo_enrichment_data: null, company_headcount: 9, company_industry: 'Placeholder Industry A',
}

describe('loadEvidenceRecord reads the newest record that holds evidence', () => {
  it('passes over a newer record that fetched nothing', async () => {
    const { client } = fakeDb({ prospect_research_results: [REUSE, FULL, OLDER_FULL] })
    expect((await loadEvidenceRecord(client, P, ORG))?.id).toBe('full')
  })

  it('never reads another organisation\'s record, however new', async () => {
    const { client } = fakeDb({ prospect_research_results: [OTHER_CLIENT, REUSE, FULL] })
    expect((await loadEvidenceRecord(client, P, ORG))?.id).toBe('full')
  })

  it('carries the stored sources through, and marks an unavailable one as unavailable', async () => {
    const { client } = fakeDb({ prospect_research_results: [REUSE, FULL] })
    const record = await loadEvidenceRecord(client, P, ORG)
    expect(record?.raw.website.content).toBe('Placeholder full website text')
    expect(record?.raw.apollo.formatted).toBe('Placeholder enrichment lines')
    expect(record?.raw.linkedin.available).toBe(false)
  })

  it('returns null when no record holds evidence', async () => {
    const { client } = fakeDb({ prospect_research_results: [REUSE] })
    expect(await loadEvidenceRecord(client, P, ORG)).toBeNull()
  })

  it('knows a record with no successful source holds no evidence', () => {
    expect(holdsEvidence([])).toBe(false)
    expect(holdsEvidence(null)).toBe(false)
    expect(holdsEvidence(['website'])).toBe(true)
  })
})

describe('the grader grades from that record and writes nothing', () => {
  it('builds the judge\'s request from the record that holds evidence', async () => {
    built.length = 0
    // A default segment is on file and the prospect has none, so a loader that stamps would write.
    const { client, writes } = fakeDb({
      prospects: [PROSPECT], prospect_research_results: [REUSE, FULL],
      segments: [{ id: 'seg-1', organisation_id: ORG, is_default: true }],
    })
    const anthropic = { messages: { create: vi.fn(async () => ({ content: [] })) } }
    const result = await gradeFromEvidence({ supabase: client, anthropic: anthropic as never, prospect_id: P, client_id: ORG })
    expect(result.evidence_record_id).toBe('full')
    expect((built[0].raw as { website: { content: string } }).website.content).toBe('Placeholder full website text')
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1)
    expect(writes).toEqual([])
  })

  it('attempts no grade, and calls no model, when nothing holds evidence', async () => {
    const { client } = fakeDb({ prospects: [PROSPECT], prospect_research_results: [REUSE] })
    const anthropic = { messages: { create: vi.fn() } }
    const result = await gradeFromEvidence({ supabase: client, anthropic: anthropic as never, prospect_id: P, client_id: ORG })
    expect(result.synthesis).toBeNull()
    expect(result.reason).toMatch(/holds any evidence/)
    expect(anthropic.messages.create).not.toHaveBeenCalled()
  })

  it('reads the prospect without stamping a missing segment', async () => {
    const { client, writes } = fakeDb({ prospects: [PROSPECT], segments: [{ id: 'seg-1', organisation_id: ORG, is_default: true }] })
    const { ctx } = await readProspectContext(client, P, ORG)
    expect(ctx.segment_id).toBeNull()
    expect(ctx.company?.staff_count).toBe(9)
    expect(writes).toEqual([])
  })
})
