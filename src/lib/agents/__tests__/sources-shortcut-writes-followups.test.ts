// The batch path's stored-findings shortcut writes follow-ups, like the rest of the batch
// path (review of 2026-10-01).
//
// Phase 2 of the batch path has always written emails 2 and 3. A reuse run never reaches
// phase 2: phase 1 hands it to the single-job agent and returns. That call left
// write_followups at its default of false, so every reuse run produced a personalised
// Email 1 with nothing carrying it, and the upload now holds exactly that (ADR-064).
//
// This drives the real runProspectResearchSources and reads the argument it passes.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  loadStoredFindings: vi.fn(),
  runProspectResearchAgentV2: vi.fn(),
  fetchAllSources: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }))
vi.mock('@/lib/agents/log-agent-run', () => ({
  startAgentRun: async () => ({ complete: vi.fn(), fail: vi.fn() }),
}))
vi.mock('../research/prospect-context', () => ({
  loadProspectContext: async () => ({ ctx: { id: 'p1', organisation_id: 'org1' }, extras: {} }),
}))
vi.mock('../research/fetch-sources', () => ({ fetchAllSources: h.fetchAllSources }))
vi.mock('../prospect-research-agent-v2', () => ({
  loadStoredFindings: h.loadStoredFindings,
  runProspectResearchAgentV2: h.runProspectResearchAgentV2,
  buildSourceTracking: vi.fn(),
}))
vi.mock('@/lib/composition/compose-sequence', () => ({ fetchApprovedMessagingDoc: vi.fn() }))
vi.mock('../research/produce-opening', () => ({ resolveVariantId: vi.fn() }))
vi.mock('../research/synthesize', () => ({ buildSynthesisRequest: vi.fn() }))

import { runProspectResearchSources } from '../prospect-research-sources-agent'
import { QUEUE_CONFIG } from '@/lib/queue/config'

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  h.loadStoredFindings.mockResolvedValue({ result_id: 'r1', created_at: '2026-09-30T00:00:00Z' })
  h.runProspectResearchAgentV2.mockResolvedValue({ research_result_id: 'r2', qualification_status: 'qualified' })
})

describe('the stored-findings shortcut', () => {
  it('positive control: with findings on file it takes the shortcut and fetches nothing', async () => {
    const out = await runProspectResearchSources({ prospect_id: 'p1', client_id: 'org1' } as never)
    expect(out).toEqual({ outcome: 'completed_from_stored', research_result_id: 'r2' })
    expect(h.fetchAllSources).not.toHaveBeenCalled()
    expect(h.runProspectResearchAgentV2).toHaveBeenCalledTimes(1)
  })

  it('PLANTED: asks the single-job agent to write follow-ups', async () => {
    await runProspectResearchSources({ prospect_id: 'p1', client_id: 'org1' } as never)
    expect(h.runProspectResearchAgentV2.mock.calls[0][0]).toMatchObject({
      prospect_id: 'p1', client_id: 'org1', use_stored_findings: true, research_path: 'queue',
      write_followups: true,
    })
  })

  it('PLANTED: and forbids it to fetch: the shortcut is budgeted for a reuse run and nothing else', async () => {
    // The agent reads the stored findings a second time. If that read fails it used to
    // fall back to four sources, a synthesis, the writer AND the follow-up writer, inside
    // this job. With the flag it throws, and the job is retried.
    await runProspectResearchSources({ prospect_id: 'p1', client_id: 'org1' } as never)
    expect(h.runProspectResearchAgentV2.mock.calls[0][0]).toMatchObject({ stored_findings_required: true })
  })

  it('PLANTED: is budgeted for that work: the same worst case as phase 2, inside the lease', () => {
    // The shortcut now runs the writer, the judges and the follow-up writer, which is what
    // research_collect runs. A smaller figure lets the worker claim a job it cannot finish.
    expect(QUEUE_CONFIG.research_sources.worstCaseSeconds).toBeGreaterThanOrEqual(QUEUE_CONFIG.research_collect.worstCaseSeconds)
    expect(QUEUE_CONFIG.research_sources.leaseSeconds).toBeGreaterThan(QUEUE_CONFIG.research_sources.worstCaseSeconds)
  })
})
