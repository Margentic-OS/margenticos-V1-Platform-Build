// The competitor screen sits in front of BOTH research entry points, and each one acts on
// what it says.
//
// competitor-screen.test.ts proves what the screen decides. This file proves the join: a
// test on each end shows both ends work, not that one hands to the other. Here the screen
// is replaced by a stand-in that excludes one prospect and holds another, and each entry
// point is checked for what it then researches or queues, and what it tells the operator.
//
// The stand-in is the screen ONLY. The selection, the guards and the enqueue are real.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

const screen = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('@/lib/sourcing/competitor-screen', async importOriginal => {
  const real = await importOriginal<typeof import('../competitor-screen')>()
  return { ...real, screenCompetitors: screen.fn }
})

const batch = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('@/lib/agents/prospect-research-agent-v2', () => ({
  runProspectResearchAgentV2Batch: batch.fn,
  STORED_FINDINGS_MAX_AGE_DAYS: 30,
}))
vi.mock('@/lib/agents/log-agent-run', () => ({
  startAgentRun: async () => ({ run_id: 'run-1', complete: async () => {}, fail: async () => {} }),
}))

import { runResearchBatchForOrg } from '@/lib/operator/research-batch-entry'
import { enqueueResearchForOrganisation } from '@/lib/queue/enqueue/research'

const ORG = 'org-1'
const IDS = ['p-buyer', 'p-competitor', 'p-held']

/** What the stand-in screen returns: one excluded, one held, the rest cleared. */
function screenResult(ids: string[]) {
  const excluded = ids.filter(id => id === 'p-competitor')
  const held = ids.filter(id => id === 'p-held')
  return {
    ok: true as const,
    screened: true,
    cleared: ids.filter(id => id !== 'p-competitor' && id !== 'p-held'),
    excluded,
    held,
    restored: [],
    unscreenable: 0,
    judge_calls: excluded.length + held.length,
    usage: { input_tokens: 0, output_tokens: 0 },
    details: [],
    problems: [],
  }
}

/** Enough of the database for both entry points to reach the screen and go past it. */
function fake(ids: string[], opts: { trigger?: string } = {}) {
  const enqueued: Array<Record<string, unknown>> = []
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        not: () => chain,
        in: () => chain,
        or: () => chain,
        gte: () => chain,
        neq: () => chain,
        order: () => chain,
        limit: () => chain,
        single: async () => ({ data: { id: ORG, name: 'Client' }, error: null }),
        maybeSingle: async () => ({ data: { id: ORG }, error: null }),
        then: (resolve: (v: unknown) => void) => {
          if (table === 'prospects') {
            resolve({
              data: ids.map(id => ({
                id,
                personalisation_trigger: opts.trigger ?? null,
                independent_verified_at: '2026-08-10T00:00:00Z',
                independent_email_status: 'Valid',
                email_send_ineligible_reason: null,
                verification_provider: 'a-verifier',
                second_pass_status: null,
                second_pass_provider: null,
                sourcing_run_id: null,
              })),
              error: null,
            })
            return
          }
          // job_queue (nothing live), prospect_research_results (nothing stored),
          // agent_runs (nothing in flight).
          resolve({ data: [], error: null })
        },
      }
      return chain
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn !== 'enqueue_job') return { data: null, error: { message: `unexpected rpc ${fn}` } }
      enqueued.push(args)
      return { data: [{ id: `job-${enqueued.length}`, ...args }], error: null }
    },
  }
  return { client: client as unknown as SupabaseClient, enqueued }
}

beforeEach(() => {
  screen.fn.mockReset()
  batch.fn.mockReset()
  screen.fn.mockImplementation(async (input: { prospectIds: string[] }) => screenResult(input.prospectIds))
  batch.fn.mockResolvedValue({
    total: 1, completed: 1, failed: 0, skipped: 0, failures: [], distinct_questions: 1,
    bridge_frame_collisions: [], question_collisions: [], abstract_noun_total: 0,
  })
})

describe('the inline research entry point and the competitor screen', () => {
  it('PLANTED: researches only what the screen cleared, and says who was passed over', async () => {
    const f = fake(IDS)
    const result = await runResearchBatchForOrg({ supabase: f.client, organisation_id: ORG, scope: 'unresearched', runtime_budget_seconds: 10_000 })

    expect(screen.fn).toHaveBeenCalledTimes(1)
    expect(screen.fn.mock.calls[0][0]).toMatchObject({ organisationId: ORG, prospectIds: IDS, persist: true })
    expect(batch.fn).toHaveBeenCalledTimes(1)
    expect(batch.fn.mock.calls[0][0].prospect_ids).toEqual(['p-buyer'])

    if (!result.ok) throw new Error(`expected a run, got: ${result.error}`)
    expect(result).toMatchObject({ prospects_selected: 1, competitors_excluded: 1, competitor_check_held: 1 })
    expect(result.competitor_note).toMatch(/1 excluded as a competitor.*1 held because the competitor check gave no answer/)
  })

  it('PLANTED: explicit prospect ids are screened too', async () => {
    const f = fake(['p-competitor'])
    const result = await runResearchBatchForOrg({ supabase: f.client, organisation_id: ORG, scope: 'unresearched', prospect_ids: ['p-competitor'] })
    expect(batch.fn).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toMatch(/Nothing to research\. Every selected prospect was passed over by the competitor check: 1 excluded as a competitor/)
  })

  it('PLANTED: a screen that could not look refuses the run; nothing is researched on a guess', async () => {
    screen.fn.mockResolvedValue({ ok: false, error: 'Could not read the selection to check it for competitors: gateway timeout' })
    const f = fake(IDS)
    const result = await runResearchBatchForOrg({ supabase: f.client, organisation_id: ORG, scope: 'unresearched' })
    expect(batch.fn).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toMatch(/^Refused: Could not read the selection to check it for competitors: gateway timeout Nothing was researched\.$/)
  })

  it('PLANTED: passes the follow-up option to the research batch, off unless the caller sets it', async () => {
    // Not about the competitor screen, and kept here because this is the file that already
    // stands the research batch in. The option is what lets the command line write the
    // personalised Emails 2 and 3; dropped at this hop, every prospect researched there is
    // held at upload.
    await runResearchBatchForOrg({ supabase: fake(['p-buyer']).client, organisation_id: ORG, scope: 'unresearched' })
    expect(batch.fn.mock.calls[0][0].write_followups).toBe(false)
    await runResearchBatchForOrg({ supabase: fake(['p-buyer']).client, organisation_id: ORG, scope: 'unresearched', write_followups: true })
    expect(batch.fn.mock.calls[1][0].write_followups).toBe(true)
  })

  it('a screen that excludes nobody changes nothing', async () => {
    const f = fake(['p-buyer'])
    const result = await runResearchBatchForOrg({ supabase: f.client, organisation_id: ORG, scope: 'unresearched' })
    if (!result.ok) throw new Error(`expected a run, got: ${result.error}`)
    expect(batch.fn.mock.calls[0][0].prospect_ids).toEqual(['p-buyer'])
    expect(result).toMatchObject({ competitors_excluded: 0, competitor_check_held: 0, competitor_note: null })
  })
})

describe('the queue research entry point and the competitor screen', () => {
  it('PLANTED: queues a job only for what the screen cleared', async () => {
    const f = fake(IDS)
    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')

    expect(screen.fn).toHaveBeenCalledTimes(1)
    expect(screen.fn.mock.calls[0][0]).toMatchObject({ organisationId: ORG, prospectIds: IDS, persist: true })
    expect(f.enqueued.map(e => e.p_prospect_id)).toEqual(['p-buyer'])

    if (!result.ok) throw new Error(`expected an enqueue, got: ${result.error}`)
    expect(result).toMatchObject({ created: 1, competitorsExcluded: 1, competitorCheckHeld: 1 })
    expect(result.competitorNote).toMatch(/1 excluded as a competitor/)
  })

  it('PLANTED: when the screen passes nobody, nothing is queued and the operator is told why', async () => {
    const f = fake(['p-competitor', 'p-held'])
    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')
    expect(f.enqueued).toEqual([])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toMatch(/Nothing to research\. Every eligible prospect was passed over by the competitor check/)
  })

  it('PLANTED: a screen that could not look queues nothing', async () => {
    screen.fn.mockResolvedValue({ ok: false, error: 'Could not check the selection for competitors: boom' })
    const f = fake(IDS)
    const result = await enqueueResearchForOrganisation(f.client, ORG, 'unresearched', 'test')
    expect(f.enqueued).toEqual([])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toMatch(/^Refused: Could not check the selection for competitors: boom Nothing was queued\.$/)
  })

  it('the screen is NOT run when another guard already refused the batch', async () => {
    // The screen costs model calls. A batch the trigger guard is about to refuse must not
    // pay for them first.
    const withTrigger = fake(IDS, { trigger: 'an opening already written' }).client
    const result = await enqueueResearchForOrganisation(withTrigger, ORG, 'unresearched', 'test')
    expect(result.ok).toBe(false)
    expect(screen.fn).not.toHaveBeenCalled()
  })
})
