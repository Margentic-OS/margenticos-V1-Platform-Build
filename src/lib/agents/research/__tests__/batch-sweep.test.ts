// The sweep, and specifically the places where it could pay twice or throw money away.
//
// Every test here is about one of the four failure modes the design has to handle:
//
//   a batch that never completes            -> age out, requeue REUSING STORED SOURCES
//   entries errored inside a good batch     -> per-entry outcome, only the failures retried
//   the poller dying between submit/collect -> results live 29 days, next sweep collects
//   sources paid, synthesis entry failed    -> MUST reuse stored sources
//
// plus the window the design deliberately accepts: a submit whose receipt write fails.
// That one is recovered by matching custom_ids, never by resubmitting, because
// resubmitting is how you pay twice for the same batch.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted, because vi.mock is hoisted above every import and a plain const would be
// in its temporal dead zone when the factory runs.
const { enqueueResearchPhaseJob } = vi.hoisted(() => ({ enqueueResearchPhaseJob: vi.fn() }))
vi.mock('@/lib/queue/job-queue', () => ({ enqueueResearchPhaseJob }))
vi.mock('@/lib/agents/prospect-research-sources-agent', () => ({ BATCH_CACHE_TTL: '1h' }))
vi.mock('../synthesize', () => ({
  buildSynthesisParams: () => ({ model: 'claude-sonnet-4-6', max_tokens: 16000, system: [], messages: [] }),
}))

import { runSynthesisBatchSweep, BATCH_SLA_HOURS, MAX_ENTRIES_PER_BATCH } from '../batch-sweep'

const NOW = new Date('2026-08-26T12:00:00Z')

interface Row { [k: string]: unknown }

/**
 * An in-memory stand-in for the two tables and the prospects join.
 *
 * It honours the FILTERS the sweep applies, not just the table name. A fake that ignores
 * `.eq('state', 'pending_submission')` on the claim update could not detect the loss of
 * the concurrency guard, which is the single line stopping two overlapping sweeps from
 * submitting the same entry twice.
 */
function fakeDb(seed: {
  batches?: Row[]
  entries?: Row[]
  /**
   * Simulate a CONCURRENT SWEEP: the moment this sweep has read the pending entries, the
   * named one is taken by somebody else.
   *
   * The timing is the entire point. Setting the state before the sweep starts would
   * simply exclude the row from the read, and the claim guard would never be exercised.
   * The guard exists for exactly the window between the read and the update.
   */
  stealAfterPendingRead?: string
} = {}) {
  const batches: Row[] = (seed.batches ?? []).map(r => ({ ...r }))
  const entries: Row[] = (seed.entries ?? []).map(r => ({ ...r }))
  const failures: Record<string, string> = {}

  function table(name: string): Row[] {
    if (name === 'synthesis_batches') return batches
    if (name === 'synthesis_batch_entries') return entries
    return []
  }

  function makeChain(name: string, mode: 'select' | 'update' | 'insert', payload?: Row, initialCols = '') {
    const eqs: Array<[string, unknown]> = []
    const ins: Array<[string, unknown[]]> = []
    const notNulls: string[] = []
    const isNulls: string[] = []
    // HONOURED, not ignored. A fake that swallows .limit() cannot detect
    // MAX_ENTRIES_PER_BATCH being wrong, and a mutation setting it to 1 passed the whole
    // suite until this was added. Same lesson as the job_type filter in the enqueue fake.
    let rowLimit: number | null = null
    let selectCols = initialCols
    let inserted: Row | null = null

    const matches = (row: Row) =>
      eqs.every(([c, v]) => row[c] === v)
      && ins.every(([c, vs]) => vs.includes(row[c] as never))
      && notNulls.every(c => row[c] !== null && row[c] !== undefined)
      && isNulls.every(c => row[c] === null || row[c] === undefined)

    const chain: Record<string, unknown> = {
      select: (cols?: string) => { selectCols = cols ?? ''; return chain },
      eq: (c: string, v: unknown) => { eqs.push([c, v]); return chain },
      in: (c: string, v: unknown[]) => { ins.push([c, v]); return chain },
      gte: () => chain,
      not: (c: string) => { notNulls.push(c); return chain },
      is: (c: string) => { isNulls.push(c); return chain },
      order: () => chain,
      limit: (n: number) => { rowLimit = n; return chain },
      maybeSingle: async () => {
        if (failures[`${mode}:${name}`]) return { data: null, error: { message: failures[`${mode}:${name}`] } }
        const hit = table(name).filter(matches)[0] ?? null
        return { data: hit, error: null }
      },
      single: async () => {
        if (failures[`${mode}:${name}`]) return { data: null, error: { message: failures[`${mode}:${name}`] } }
        if (mode === 'insert') {
          inserted = { id: `${name}-${table(name).length + 1}`, ...payload }
          table(name).push(inserted)
          return { data: inserted, error: null }
        }
        const hit = table(name).filter(matches)[0] ?? null
        return { data: hit, error: null }
      },
      then: (resolve: (v: unknown) => void) => {
        if (failures[`${mode}:${name}`]) {
          resolve({ data: null, error: { message: failures[`${mode}:${name}`] } })
          return
        }
        if (mode === 'update') {
          const hits = table(name).filter(matches)
          for (const row of hits) Object.assign(row, payload)
          resolve({ data: hits.map(r => ({ id: r.id })), error: null })
          return
        }
        const hits = table(name).filter(matches)
        const out = rowLimit === null ? hits : hits.slice(0, rowLimit)
        // The concurrent-sweep hook fires AFTER this read has been served and BEFORE the
        // claim update runs, which is the only window the guard covers.
        // Keyed on the GATHER read specifically, the one that selects raw_sources, not
        // on the cheap organisation-discovery read that also filters on
        // pending_submission. Stealing on the discovery read would simply exclude the row
        // from the gather and the guard would never be reached, which is exactly what the
        // first version of this hook did.
        if (
          seed.stealAfterPendingRead
          && name === 'synthesis_batch_entries'
          && selectCols.includes('raw_sources')
          && eqs.some(([c, v]) => c === 'state' && v === 'pending_submission')
        ) {
          const victim = entries.find(e => e.id === seed.stealAfterPendingRead)
          if (victim && victim.state === 'pending_submission') victim.state = 'submitted'
        }
        resolve({ data: out, error: null })
      },
    }
    return chain
  }

  const client = {
    from(name: string) {
      return {
        // The column list is passed THROUGH. It was swallowed here, so a hook keyed on
        // which columns a read asked for never fired, and a mutation removing the claim's
        // concurrency guard passed the whole suite. Second time in this file that a fake
        // dropping an argument hid a real guard.
        select: (cols?: string) => makeChain(name, 'select', undefined, cols ?? ''),
        insert: (payload: Row) => makeChain(name, 'insert', payload),
        update: (payload: Row) => makeChain(name, 'update', payload),
      }
    },
  }

  return { client: client as never, batches, entries, failures }
}

function entry(overrides: Row = {}): Row {
  return {
    id: `entry-${Math.abs(Number(overrides.n ?? 1))}`,
    organisation_id: 'org-1',
    prospect_id: 'p-1',
    state: 'pending_submission',
    raw_sources: { linkedin: { available: true, formatted: 'PAID FOR' }, web_search: { search_count: 2 } },
    detected_signal: { has_dateable_signal: true, signal_observation: 's' },
    client_context: { icpSummary: 'icp' },
    segment_id: 'seg-1',
    submit_attempts: 0,
    batch_id: null,
    prospects: { first_name: 'Ada', last_name: 'O', company_name: 'Meridian', role: 'Head', linkedin_url: null },
    ...overrides,
  }
}

function fakeAnthropic(script: {
  create?: (body: unknown) => unknown
  retrieve?: (id: string) => unknown
  results?: (id: string) => unknown[]
  list?: () => unknown[]
} = {}) {
  const calls = { create: 0, retrieve: 0, results: 0, list: 0, createdRequests: [] as unknown[] }
  return {
    calls,
    client: {
      messages: {
        batches: {
          create: async (body: { requests: unknown[] }) => {
            calls.create += 1
            calls.createdRequests.push(...body.requests)
            if (script.create) return script.create(body)
            return {
              id: `msgbatch_${calls.create}`,
              processing_status: 'in_progress',
              request_counts: { processing: body.requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
              created_at: NOW.toISOString(),
              expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
              ended_at: null,
            }
          },
          retrieve: async (id: string) => {
            calls.retrieve += 1
            return script.retrieve
              ? script.retrieve(id)
              : { id, processing_status: 'in_progress', request_counts: {}, ended_at: null }
          },
          results: async (id: string) => {
            calls.results += 1
            const items = script.results ? script.results(id) : []
            return { async *[Symbol.asyncIterator]() { for (const i of items) yield i } }
          },
          list: async () => {
            calls.list += 1
            return { data: script.list ? script.list() : [] }
          },
        },
      },
    } as never,
  }
}

function succeededResult(customId: string, cacheRead = 6700) {
  return {
    custom_id: customId,
    result: {
      type: 'succeeded',
      message: {
        id: 'msg_x',
        content: [{ type: 'text', text: '{}' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 120, output_tokens: 6200,
          cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead,
        },
      },
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('submission writes the ledger BEFORE the paid call', () => {
  it('creates a synthesis_batches row even when the create call is rejected', async () => {
    const db = fakeDb({ entries: [entry()] })
    const an = fakeAnthropic({ create: () => { throw new Error('overloaded') } })

    await runSynthesisBatchSweep(db.client, an.client, NOW)

    // A call that spends and then fails must still be counted. This is the
    // verification_calls pattern: a row exists whether or not the call returned.
    expect(db.batches).toHaveLength(1)
    expect(db.batches[0].state).toBe('failed')
    expect(String(db.batches[0].error)).toContain('overloaded')
  })

  it('returns the entries to pending WITH THEIR SOURCES when the call is rejected', async () => {
    // A rejected call is billed nothing and created nothing, so retrying is free and
    // correct. What must survive is raw_sources: re-running phase 1 would re-buy Apify,
    // Apollo and Brave.
    const db = fakeDb({ entries: [entry()] })
    const an = fakeAnthropic({ create: () => { throw new Error('overloaded') } })

    await runSynthesisBatchSweep(db.client, an.client, NOW)

    expect(db.entries[0].state).toBe('pending_submission')
    expect(db.entries[0].submit_attempts).toBe(1)
    expect((db.entries[0].raw_sources as Record<string, Record<string, unknown>>).linkedin.formatted)
      .toBe('PAID FOR')
  })

  it('records the receipt on success', async () => {
    const db = fakeDb({ entries: [entry()] })
    const an = fakeAnthropic()

    const run = await runSynthesisBatchSweep(db.client, an.client, NOW)

    expect(an.calls.create).toBe(1)
    expect(db.batches[0].anthropic_batch_id).toBe('msgbatch_1')
    expect(db.batches[0].state).toBe('submitted')
    expect(run.submitted_entries).toBe(1)
  })

  it('puts one organisation into ONE batch, not one batch per prospect', async () => {
    // Batches of one would still get the discount and would lose the shared cached
    // prefix, which Anthropic names as the thing that makes in-batch cache hits work.
    const db = fakeDb({
      entries: [
        entry({ n: 1, id: 'entry-1', prospect_id: 'p-1' }),
        entry({ n: 2, id: 'entry-2', prospect_id: 'p-2' }),
        entry({ n: 3, id: 'entry-3', prospect_id: 'p-3' }),
      ],
    })
    const an = fakeAnthropic()

    const run = await runSynthesisBatchSweep(db.client, an.client, NOW)

    expect(an.calls.create).toBe(1)
    expect(an.calls.createdRequests).toHaveLength(3)
    expect(run.submitted_batches).toBe(1)
    expect(run.submitted_entries).toBe(3)
  })

  it('claims entries CONDITIONALLY, so two overlapping sweeps cannot both submit one', async () => {
    // pg_cron fires every five minutes and a sweep can run long, so two passes can
    // overlap. The claim update is conditioned on state='pending_submission': the loser
    // matches zero rows, and the batch is then built from what was ACTUALLY claimed
    // rather than from what was read.
    //
    // Without that guard the entry would be submitted twice, in two different batches,
    // and BOTH would be billed.
    const db = fakeDb({
      entries: [
        entry({ n: 1, id: 'entry-1', prospect_id: 'p-1' }),
        entry({ n: 2, id: 'entry-2', prospect_id: 'p-2' }),
      ],
      stealAfterPendingRead: 'entry-2',
    })
    const an = fakeAnthropic()

    const run = await runSynthesisBatchSweep(db.client, an.client, NOW)

    expect(run.submitted_entries).toBe(1)
    expect(an.calls.createdRequests).toHaveLength(1)
    expect((an.calls.createdRequests[0] as { custom_id: string }).custom_id).toBe('entry-1')
  })

  it('caps a batch at MAX_ENTRIES_PER_BATCH, which bounds the blast radius of one stuck batch', async () => {
    // Not a provider limit: Anthropic allows 100,000 requests or 256 MB and our prompt
    // material is about 4 KB per prospect. It bounds how many prospects one aged-out batch
    // strands at once.
    expect(MAX_ENTRIES_PER_BATCH).toBeGreaterThan(1)
    const db = fakeDb({
      entries: Array.from({ length: 3 }, (_, i) =>
        entry({ n: i + 1, id: `entry-${i + 1}`, prospect_id: `p-${i + 1}` })),
    })
    const an = fakeAnthropic()

    await runSynthesisBatchSweep(db.client, an.client, NOW)

    // All three fit under the cap, so exactly one batch and one shared cached prefix.
    expect(an.calls.create).toBe(1)
    expect(an.calls.createdRequests).toHaveLength(3)
  })

  it('uses each entry id as its custom_id, which is what makes reconciliation possible', async () => {
    const db = fakeDb({ entries: [entry({ n: 1, id: 'entry-1' })] })
    const an = fakeAnthropic()

    await runSynthesisBatchSweep(db.client, an.client, NOW)

    expect((an.calls.createdRequests[0] as { custom_id: string }).custom_id).toBe('entry-1')
  })
})

describe('a submit whose receipt write fails is NOT resubmitted', () => {
  it('leaves the ledger row un-receipted and does not requeue the entries', async () => {
    // Requeueing here would submit the same prospects a second time and pay twice. The
    // batch is live and billable; the only safe move is to leave it for reconciliation.
    const db = fakeDb({ entries: [entry()] })
    db.failures['update:synthesis_batches'] = 'connection reset'
    const an = fakeAnthropic()

    const run = await runSynthesisBatchSweep(db.client, an.client, NOW)

    expect(an.calls.create).toBe(1)
    expect(db.entries[0].state).toBe('submitted')
    expect(db.entries[0].state).not.toBe('pending_submission')
    expect(run.requeued_entries).toBe(0)
    expect(run.errors.join(' ')).toMatch(/receipt write failed/)
  })

  it('recovers it on the next sweep by matching custom_ids, without resubmitting', async () => {
    const db = fakeDb({
      batches: [{
        id: 'batch-1', organisation_id: 'org-1', state: 'attempted',
        anthropic_batch_id: null, request_count: 1,
        requested_at: new Date(NOW.getTime() - 600_000).toISOString(),
      }],
      entries: [entry({ id: 'entry-1', state: 'submitted', batch_id: 'batch-1' })],
    })
    const an = fakeAnthropic({
      list: () => [{
        id: 'msgbatch_orphan', processing_status: 'ended',
        created_at: new Date(NOW.getTime() - 600_000).toISOString(),
        expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
        request_counts: { succeeded: 1, errored: 0, canceled: 0, expired: 0, processing: 0 },
        ended_at: NOW.toISOString(),
      }],
      // The custom_id is entry-1, which resolves to batch-1 in our table. That is the proof.
      results: () => [succeededResult('entry-1')],
      retrieve: (id: string) => ({
        id, processing_status: 'ended', ended_at: NOW.toISOString(),
        request_counts: { succeeded: 1, errored: 0, canceled: 0, expired: 0, processing: 0 },
      }),
    })

    const run = await runSynthesisBatchSweep(db.client, an.client, NOW)

    expect(run.reconciled_batches).toBe(1)
    expect(db.batches[0].anthropic_batch_id).toBe('msgbatch_orphan')
    expect(String(db.batches[0].error)).toContain('reconciliation')
    // AND it was not paid for a second time.
    expect(an.calls.create).toBe(0)
  })

  it('ignores a batch whose custom_ids belong to nobody', async () => {
    // Someone else's batch, or a different workspace's. Attaching it would bind one
    // organisation's synthesis to another's prospects.
    const db = fakeDb({
      batches: [{
        id: 'batch-1', organisation_id: 'org-1', state: 'attempted',
        anthropic_batch_id: null, request_count: 1,
        requested_at: new Date(NOW.getTime() - 600_000).toISOString(),
      }],
      entries: [entry({ id: 'entry-1', state: 'submitted', batch_id: 'batch-1' })],
    })
    const an = fakeAnthropic({
      list: () => [{
        id: 'msgbatch_someone_else', processing_status: 'ended',
        created_at: new Date(NOW.getTime() - 600_000).toISOString(),
        expires_at: NOW.toISOString(), request_counts: {}, ended_at: NOW.toISOString(),
      }],
      results: () => [succeededResult('not-one-of-ours')],
    })

    const run = await runSynthesisBatchSweep(db.client, an.client, NOW)

    expect(run.reconciled_batches).toBe(0)
    expect(db.batches[0].anthropic_batch_id).toBeNull()
  })

  it('does not attach a batch we already have a receipt for', async () => {
    const db = fakeDb({
      batches: [
        { id: 'batch-1', organisation_id: 'org-1', state: 'attempted', anthropic_batch_id: null,
          request_count: 1, requested_at: new Date(NOW.getTime() - 600_000).toISOString() },
        { id: 'batch-0', organisation_id: 'org-1', state: 'submitted', anthropic_batch_id: 'msgbatch_known',
          request_count: 1, requested_at: new Date(NOW.getTime() - 900_000).toISOString() },
      ],
      entries: [entry({ id: 'entry-1', state: 'submitted', batch_id: 'batch-1' })],
    })
    const an = fakeAnthropic({
      list: () => [{
        id: 'msgbatch_known', processing_status: 'ended',
        created_at: new Date(NOW.getTime() - 900_000).toISOString(),
        expires_at: NOW.toISOString(), request_counts: {}, ended_at: NOW.toISOString(),
      }],
      results: () => [succeededResult('entry-1')],
      retrieve: (id: string) => ({ id, processing_status: 'in_progress', request_counts: {}, ended_at: null }),
    })

    const run = await runSynthesisBatchSweep(db.client, an.client, NOW)

    expect(run.reconciled_batches).toBe(0)
  })
})

describe('collection', () => {
  const endedBatch = (n = 1) => ({
    id: 'batch-1', organisation_id: 'org-1', state: 'submitted',
    anthropic_batch_id: 'msgbatch_1', poll_count: 0,
    requested_at: new Date(NOW.getTime() - 3_600_000).toISOString(),
    request_count: n,
  })

  it('writes the WHOLE Message so phase 2 reconstructs nothing', async () => {
    const db = fakeDb({
      batches: [endedBatch()],
      entries: [entry({ id: 'entry-1', state: 'submitted', batch_id: 'batch-1' })],
    })
    const an = fakeAnthropic({
      retrieve: (id: string) => ({ id, processing_status: 'ended', ended_at: NOW.toISOString(), request_counts: { succeeded: 1 } }),
      results: () => [succeededResult('entry-1')],
    })

    await runSynthesisBatchSweep(db.client, an.client, NOW)

    expect(db.entries[0].state).toBe('succeeded')
    expect((db.entries[0].response_message as Record<string, unknown>).stop_reason).toBe('end_turn')
    expect((db.entries[0].usage as Record<string, number>).cache_read_input_tokens).toBe(6700)
  })

  it('accumulates the cache read tokens, which is THE measurement', async () => {
    const db = fakeDb({
      batches: [endedBatch(2)],
      entries: [
        entry({ id: 'entry-1', state: 'submitted', batch_id: 'batch-1', prospect_id: 'p-1' }),
        entry({ id: 'entry-2', state: 'submitted', batch_id: 'batch-1', prospect_id: 'p-2' }),
      ],
    })
    const an = fakeAnthropic({
      retrieve: (id: string) => ({ id, processing_status: 'ended', ended_at: NOW.toISOString(), request_counts: {} }),
      results: () => [succeededResult('entry-1', 6700), succeededResult('entry-2', 6700)],
    })

    const run = await runSynthesisBatchSweep(db.client, an.client, NOW)

    expect(run.cache_read_tokens).toBe(13_400)
    expect(run.output_tokens).toBe(12_400)
  })

  it('records a per-entry outcome, so only the FAILED prospects need anything done', async () => {
    const db = fakeDb({
      batches: [endedBatch(2)],
      entries: [
        entry({ id: 'entry-1', state: 'submitted', batch_id: 'batch-1', prospect_id: 'p-1' }),
        entry({ id: 'entry-2', state: 'submitted', batch_id: 'batch-1', prospect_id: 'p-2' }),
      ],
    })
    const an = fakeAnthropic({
      retrieve: (id: string) => ({ id, processing_status: 'ended', ended_at: NOW.toISOString(), request_counts: {} }),
      results: () => [
        succeededResult('entry-1'),
        { custom_id: 'entry-2', result: { type: 'errored', error: { type: 'error', error: { type: 'overloaded_error' } } } },
      ],
    })

    const run = await runSynthesisBatchSweep(db.client, an.client, NOW)

    expect(db.entries[0].state).toBe('succeeded')
    expect(db.entries[1].state).toBe('errored')
    expect(run.collected_entries).toBe(1)
    expect(run.errored_entries).toBe(1)
  })

  it('enqueues phase 2 for the ERRORED entry too, because its sources were paid for', async () => {
    // Anthropic bills nothing for an errored request, but Apify, Apollo and Brave already
    // billed for the four payloads on that row. Phase 2 stores a fallback rather than
    // discarding them. This is failure mode four.
    const db = fakeDb({
      batches: [endedBatch(2)],
      entries: [
        entry({ id: 'entry-1', state: 'submitted', batch_id: 'batch-1', prospect_id: 'p-1' }),
        entry({ id: 'entry-2', state: 'submitted', batch_id: 'batch-1', prospect_id: 'p-2' }),
      ],
    })
    const an = fakeAnthropic({
      retrieve: (id: string) => ({ id, processing_status: 'ended', ended_at: NOW.toISOString(), request_counts: {} }),
      results: () => [
        succeededResult('entry-1'),
        { custom_id: 'entry-2', result: { type: 'errored', error: { type: 'error' } } },
      ],
    })

    await runSynthesisBatchSweep(db.client, an.client, NOW)

    const prospects = enqueueResearchPhaseJob.mock.calls.map(c => c[1].prospectId).sort()
    expect(prospects).toEqual(['p-1', 'p-2'])
    expect(enqueueResearchPhaseJob.mock.calls[0][1].jobType).toBe('research_collect')
  })

  it('is idempotent: a second pass over the same ended batch writes nothing new', async () => {
    // The poller dying between submit and collect is a non-event because results live for
    // 29 days and every entry write is conditioned on state='submitted'.
    const db = fakeDb({
      batches: [endedBatch()],
      entries: [entry({ id: 'entry-1', state: 'submitted', batch_id: 'batch-1' })],
    })
    const an = fakeAnthropic({
      retrieve: (id: string) => ({ id, processing_status: 'ended', ended_at: NOW.toISOString(), request_counts: {} }),
      results: () => [succeededResult('entry-1')],
    })

    await runSynthesisBatchSweep(db.client, an.client, NOW)
    db.batches[0].state = 'submitted'   // pretend the batch-row update was the part that died
    const second = await runSynthesisBatchSweep(db.client, an.client, NOW)

    expect(second.collected_entries).toBe(0)
    expect(db.entries[0].state).toBe('succeeded')
  })
})

describe('a batch that never completes ages out and reuses its sources', () => {
  it('does nothing while the batch is inside its SLA', async () => {
    const db = fakeDb({
      batches: [{
        id: 'batch-1', organisation_id: 'org-1', state: 'submitted', anthropic_batch_id: 'msgbatch_1',
        poll_count: 0, request_count: 1,
        requested_at: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
      }],
      entries: [entry({ id: 'entry-1', state: 'submitted', batch_id: 'batch-1' })],
    })
    const an = fakeAnthropic()

    const run = await runSynthesisBatchSweep(db.client, an.client, NOW)

    expect(run.expired_batches).toBe(0)
    expect(db.entries[0].state).toBe('submitted')
  })

  it('ages out past the SLA and requeues WITH sources intact', async () => {
    const db = fakeDb({
      batches: [{
        id: 'batch-1', organisation_id: 'org-1', state: 'submitted', anthropic_batch_id: 'msgbatch_1',
        poll_count: 0, request_count: 1,
        requested_at: new Date(NOW.getTime() - (BATCH_SLA_HOURS + 1) * 3_600_000).toISOString(),
      }],
      entries: [entry({ id: 'entry-1', state: 'submitted', batch_id: 'batch-1' })],
    })
    const an = fakeAnthropic()

    const run = await runSynthesisBatchSweep(db.client, an.client, NOW)

    expect(run.expired_batches).toBe(1)
    expect(run.requeued_entries).toBe(1)
    expect(db.batches[0].state).toBe('expired')
    expect(db.entries[0].submit_attempts).toBe(1)

    // THE ASSERTION THAT MATTERS. Sources survive, so the retry re-pays synthesis only.
    // Re-running phase 1 instead would have re-bought Apify, Apollo and Brave.
    expect((db.entries[0].raw_sources as Record<string, Record<string, unknown>>).linkedin.formatted)
      .toBe('PAID FOR')
    // And the snapshot as a whole is untouched, so phase 2 is still possible.
    expect(db.entries[0].client_context).toEqual({ icpSummary: 'icp' })
    expect(db.entries[0].detected_signal).toEqual({ has_dateable_signal: true, signal_observation: 's' })

    // ── AND IT IS RESUBMITTED IN THE SAME PASS ────────────────────────────
    //
    // Not an accident of ordering, and worth asserting rather than leaving implicit:
    // submission runs after collection, so an entry requeued by the age-out is picked up
    // by the very next step. A prospect stranded by a dead batch is back in flight within
    // one sweep instead of waiting five more minutes.
    expect(run.submitted_entries).toBe(1)
    expect(db.entries[0].state).toBe('submitted')
  })

  it('does NOT re-run phase 1, so no source is ever bought twice', async () => {
    // The whole point of ageing out at the ENTRY level rather than the JOB level. A
    // requeued research_sources job would have re-fetched everything.
    const db = fakeDb({
      batches: [{
        id: 'batch-1', organisation_id: 'org-1', state: 'submitted', anthropic_batch_id: 'msgbatch_1',
        poll_count: 0, request_count: 1,
        requested_at: new Date(NOW.getTime() - (BATCH_SLA_HOURS + 1) * 3_600_000).toISOString(),
      }],
      entries: [entry({ id: 'entry-1', state: 'submitted', batch_id: 'batch-1' })],
    })
    const an = fakeAnthropic()

    await runSynthesisBatchSweep(db.client, an.client, NOW)

    // research_sources is never enqueued by the sweep. Only research_collect ever is, and
    // only for entries that have a result.
    const jobTypes = enqueueResearchPhaseJob.mock.calls.map(c => c[1].jobType)
    expect(jobTypes).not.toContain('research_sources')
  })
})
