// The batch path's snapshot strips NUL before it reaches jsonb (2026-10-05).
//
// Postgres jsonb rejects U+0000 with "unsupported Unicode escape sequence" and fails the
// whole insert. stripNulls was applied to the research result writes on 2026-09-21 and the
// synthesis_batch_entries snapshot was missed. On 2026-10-05 it failed 4 of the first ~60
// batch-route prospects, each AFTER its sources were bought, and each retry re-bought them.
//
// This drives the real runProspectResearchSources to the insert. The fake insert behaves as
// Postgres does: any NUL anywhere in the payload is an error, so the test reads the outcome,
// not a call log.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  fetchAllSources: vi.fn(),
  buildSynthesisRequest: vi.fn(),
  inserted: [] as unknown[],
}))

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/agents/log-agent-run', () => ({
  startAgentRun: async () => ({ run_id: 'run-1', complete: vi.fn(), fail: vi.fn() }),
}))
vi.mock('../research/prospect-context', () => ({
  loadProspectContext: async () => ({ ctx: { id: 'p1', organisation_id: 'org1', segment_id: 'seg1' }, extras: {} }),
}))
vi.mock('../research/fetch-sources', () => ({ fetchAllSources: h.fetchAllSources }))
vi.mock('../research/source-integrity', () => ({
  assessSourceIntegrity: () => ({ complete: true, recorded: [], holding: [], successful: [], skipped: [] }),
  ResearchIncompleteError: class extends Error {},
}))
vi.mock('../prospect-research-agent-v2', () => ({
  loadStoredFindings: vi.fn(),
  runProspectResearchAgentV2: vi.fn(),
  buildSourceTracking: () => ({ sources_attempted: ['website'], sources_successful: ['website'] }),
}))
vi.mock('@/lib/composition/compose-sequence', () => ({
  fetchApprovedMessagingDoc: async () => ({ doc_id: 'doc1', content: { variants: [] } }),
}))
vi.mock('../research/produce-opening', () => ({ resolveVariantId: () => ({ variantId: 'A', basis: 'hash' }) }))
vi.mock('../research/synthesize', () => ({ buildSynthesisRequest: h.buildSynthesisRequest }))

// Postgres's behaviour at the boundary: a NUL anywhere in the serialised payload fails it.
const hasNul = (v: unknown) => JSON.stringify(v).includes('\\u0000')

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (name: string) => {
      if (name === 'synthesis_batch_entries') {
        return {
          insert: (row: unknown) => ({
            select: () => ({
              single: async () => {
                if (hasNul(row)) return { data: null, error: { message: 'unsupported Unicode escape sequence' } }
                h.inserted.push(row)
                return { data: { id: 'entry-1' }, error: null }
              },
            }),
          }),
        }
      }
      const single = async () => ({ data: name === 'organisations' ? { name: 'Placeholder Client' } : { version: '1' } })
      return { select: () => ({ eq: () => ({ single }) }) }
    },
  }),
}))

import { runProspectResearchSources } from '../prospect-research-sources-agent'
import { stripNulls } from '../research/strip-nulls'

const SCRAPED = 'Founded 2019.\u0000 We help firms grow.'

beforeEach(() => {
  h.fetchAllSources.mockReset()
  h.buildSynthesisRequest.mockReset()
  h.inserted.length = 0
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  h.fetchAllSources.mockResolvedValue({
    website: { text: SCRAPED },
    web_search: { search_count: 1, results: [{ snippet: SCRAPED }] },
  })
  h.buildSynthesisRequest.mockResolvedValue({
    clientCtx: {},
    detectedSignal: { signal_observation: SCRAPED },
  })
})

describe('the batch-path snapshot', () => {
  it('control: the fake rejects a NUL payload, as Postgres does', () => {
    expect(hasNul({ a: SCRAPED })).toBe(true)
    expect(hasNul({ a: 'clean' })).toBe(false)
  })

  it('PLANTED: scraped text carrying U+0000 still snapshots, so the paid sources are kept', async () => {
    const out = await runProspectResearchSources({ prospect_id: 'p1', client_id: 'org1', use_stored_findings: false })
    expect(out).toMatchObject({ outcome: 'queued_for_batch', entry_id: 'entry-1' })
    expect(h.inserted).toHaveLength(1)
    expect(hasNul(h.inserted[0])).toBe(false)
  })

  it('loses only the NUL: the surrounding text is stored intact', async () => {
    await runProspectResearchSources({ prospect_id: 'p1', client_id: 'org1', use_stored_findings: false })
    const row = h.inserted[0] as { raw_sources: { website: { text: string } }; detected_signal: { signal_observation: string } }
    expect(row.raw_sources.website.text).toBe('Founded 2019. We help firms grow.')
    expect(row.detected_signal.signal_observation).toBe('Founded 2019. We help firms grow.')
  })
})

describe('stripNulls', () => {
  it('strips values and keys at any depth and leaves everything else alone', () => {
    expect(stripNulls({ ['k\u0000']: ['a\u0000b', 1, null, { c: 'd\u0000' }], n: 2, t: true })).toEqual({
      k: ['ab', 1, null, { c: 'd' }], n: 2, t: true,
    })
  })
})
