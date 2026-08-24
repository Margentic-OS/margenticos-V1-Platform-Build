// An in-memory stand-in for the job_queue database functions.
//
// WHAT THIS IS FOR, AND WHAT IT IS NOT FOR.
//
// It mirrors the semantics of the SQL in 20260824160000_job_queue.sql so the TypeScript
// layer can be tested without a live database. It is used to test what the TypeScript
// controls: the spend gate, error classification, failure isolation between jobs, the
// attempt cap as the wrappers drive it, and the fairness plan.
//
// It is NOT evidence for the DATABASE-level guarantees, and no test here claims it is.
// FOR UPDATE SKIP LOCKED disjointness under genuine concurrency, the partial unique
// index, and the CHECK constraints are properties of Postgres. They were proven against
// the live database with 20 SQL assertions during C1 and are re-proven by the worker in
// C3. A JavaScript fake runs on one thread and could not disprove them if they broke.

import type { JobRow, JobType } from '../types'

let idCounter = 0

/** The default holder for a job created directly in the 'claimed' state. */
export const TEST_WORKER = 'worker-one'

export function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  idCounter += 1
  const now = new Date().toISOString()

  // job_queue_claim_fields_consistent is a real CHECK constraint: a row in state
  // 'claimed' MUST carry claimed_by and lease_expires_at. A fake that emits a claimed
  // row with claimed_by null is producing a row the database would reject, and every
  // test built on it would be testing an impossible state.
  const claimedDefaults =
    overrides.state === 'claimed'
      ? {
          claimed_by: overrides.claimed_by ?? TEST_WORKER,
          lease_expires_at:
            overrides.lease_expires_at ?? new Date(Date.now() + 300_000).toISOString(),
        }
      : {}

  return {
    id: `job-${idCounter}`,
    job_type: 'research' as JobType,
    organisation_id: 'org-a',
    prospect_id: `prospect-${idCounter}`,
    state: 'queued',
    claimed_by: null,
    lease_expires_at: null,
    attempts: 0,
    max_attempts: 3,
    run_after: now,
    last_error: null,
    last_error_class: null,
    spend_recorded_at: null,
    spend_detail: null,
    result_summary: null,
    enqueued_by: 'test',
    created_at: now,
    updated_at: now,
    ...overrides,
    ...claimedDefaults,
  }
}

export interface FakeQueueOptions {
  /** Force a specific RPC to return an error, to test the failure paths. */
  failRpc?: Record<string, string>
  /** Force a specific RPC to throw, rather than return an error. */
  throwRpc?: Record<string, Error>
}

/**
 * A Supabase-client-shaped object backed by an array of rows.
 *
 * Only the surface the queue library actually uses is implemented: .rpc() for the eight
 * functions, and .from('system_flags') / .from('job_queue') for the two direct reads.
 */
export function createFakeQueue(initialRows: JobRow[] = [], options: FakeQueueOptions = {}) {
  const rows: JobRow[] = initialRows.map(r => ({ ...r }))
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
  const selectCalls: string[] = []

  function find(id: string): JobRow | undefined {
    return rows.find(r => r.id === id)
  }

  // Mirrors job_queue_backoff: exponential from 30s, capped at 900s, plus jitter.
  function backoffMs(attempts: number): number {
    const base = Math.min(Math.pow(2, Math.max(attempts, 0)) * 30, 900)
    return base * 1000 * (1 + Math.random() * 0.3)
  }

  const handlers: Record<string, (args: any) => JobRow[] | null> = {
    enqueue_job(args) {
      // Mirrors the partial unique index: one live job per (job_type, prospect_id).
      const live = rows.find(
        r =>
          r.job_type === args.p_job_type &&
          r.prospect_id === args.p_prospect_id &&
          (r.state === 'queued' || r.state === 'claimed'),
      )
      if (live) return []

      const row = makeJob({
        job_type: args.p_job_type,
        organisation_id: args.p_organisation_id,
        prospect_id: args.p_prospect_id,
        enqueued_by: args.p_enqueued_by,
        max_attempts: args.p_max_attempts ?? 3,
      })
      rows.push(row)
      return [row]
    },

    claim_jobs(args) {
      const now = Date.now()
      const eligible = rows
        .filter(
          r =>
            r.job_type === args.p_job_type &&
            r.organisation_id === args.p_organisation_id &&
            r.state === 'queued' &&
            new Date(r.run_after).getTime() <= now,
        )
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, args.p_limit)

      for (const r of eligible) {
        r.state = 'claimed'
        r.claimed_by = args.p_worker
        r.lease_expires_at = new Date(now + args.p_lease_seconds * 1000).toISOString()
        r.attempts += 1
        r.updated_at = new Date().toISOString()
      }
      return eligible.map(r => ({ ...r }))
    },

    queue_next_organisations(args) {
      const now = Date.now()
      const queued = rows.filter(
        r =>
          r.job_type === args.p_job_type &&
          r.state === 'queued' &&
          new Date(r.run_after).getTime() <= now,
      )
      const byOrg = new Map<string, JobRow[]>()
      for (const r of queued) {
        if (!byOrg.has(r.organisation_id)) byOrg.set(r.organisation_id, [])
        byOrg.get(r.organisation_id)!.push(r)
      }
      return Array.from(byOrg.entries())
        .map(([organisation_id, list]) => ({
          organisation_id,
          oldest: list.map(r => r.created_at).sort()[0],
          depth: list.length,
        }))
        .sort((a, b) => a.oldest.localeCompare(b.oldest)) as unknown as JobRow[]
    },

    record_job_spend(args) {
      const row = find(args.p_job_id)
      // Mirrors  WHERE spend_recorded_at IS NULL : the first stamp is the true one.
      if (row && row.spend_recorded_at === null) {
        row.spend_recorded_at = new Date().toISOString()
        row.spend_detail = args.p_detail
        row.updated_at = new Date().toISOString()
      }
      return null
    },

    complete_job(args) {
      const row = find(args.p_job_id)
      if (!row || row.state !== 'claimed') return []
      // THE FENCE, mirrored from the SQL: a worker whose lease was reclaimed matches
      // nothing and changes nothing.
      if (args.p_worker !== undefined && row.claimed_by !== args.p_worker) return []
      row.state = 'done'
      row.result_summary = args.p_summary
      row.lease_expires_at = null
      row.updated_at = new Date().toISOString()
      return [{ ...row }]
    },

    fail_job(args) {
      const row = find(args.p_job_id)
      if (!row || row.state !== 'claimed') return []
      // THE FENCE, mirrored from the SQL.
      if (args.p_worker !== undefined && row.claimed_by !== args.p_worker) return []
      const terminal =
        args.p_force_terminal === true ||
        args.p_error_class === 'permanent' ||
        row.attempts >= row.max_attempts
      row.state = terminal ? 'failed' : 'queued'
      row.last_error = args.p_error
      row.last_error_class = args.p_error_class
      row.run_after = new Date(Date.now() + backoffMs(row.attempts)).toISOString()
      row.lease_expires_at = null
      row.updated_at = new Date().toISOString()
      return [{ ...row }]
    },

    reclaim_expired_jobs(args) {
      const now = Date.now()
      const expired = rows
        .filter(
          r =>
            r.state === 'claimed' &&
            r.lease_expires_at !== null &&
            new Date(r.lease_expires_at).getTime() <= now,
        )
        .slice(0, args.p_limit ?? 100)

      for (const r of expired) {
        const terminal = r.attempts >= r.max_attempts
        r.last_error =
          `Lease expired at ${r.lease_expires_at} while held by ${r.claimed_by ?? 'unknown worker'}. ` +
          `Attempt ${r.attempts} of ${r.max_attempts}.` +
          (r.spend_recorded_at !== null
            ? ' Spend was already recorded for this job, so it must not call the paid API again.'
            : '')
        r.last_error_class = 'transient'
        r.state = terminal ? 'failed' : 'queued'
        r.run_after = new Date(now + backoffMs(r.attempts)).toISOString()
        r.claimed_by = null
        r.lease_expires_at = null
        r.updated_at = new Date().toISOString()
      }
      return expired.map(r => ({ ...r }))
    },
  }

  const client = {
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args })

      if (options.throwRpc?.[fn]) throw options.throwRpc[fn]
      if (options.failRpc?.[fn]) return { data: null, error: { message: options.failRpc[fn] } }

      const handler = handlers[fn]
      if (!handler) return { data: null, error: { message: `unknown rpc ${fn}` } }
      return { data: handler(args), error: null }
    },

    from(table: string) {
      selectCalls.push(table)
      return {
        select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
          const builder: any = {
            _filters: {} as Record<string, unknown>,
            eq(col: string, val: unknown) {
              this._filters[col] = val
              return this
            },
            maybeSingle: async () => {
              if (options.failRpc?.[`select:${table}`]) {
                return { data: null, error: { message: options.failRpc[`select:${table}`] } }
              }
              if (table === 'system_flags') {
                const key = builder._filters.key
                const flag = fakeFlags.get(key as string)
                return { data: flag === undefined ? null : { enabled: flag }, error: null }
              }
              return { data: null, error: null }
            },
            then: undefined,
          }
          if (opts?.count === 'exact' && opts?.head) {
            // countInFlight path
            return {
              eq(col: string, val: unknown) {
                builder._filters[col] = val
                return this
              },
              then(resolve: (v: unknown) => void) {
                const matching = rows.filter(r =>
                  Object.entries(builder._filters).every(([k, v]) => (r as any)[k] === v),
                )
                resolve({ count: matching.length, error: null })
              },
            }
          }
          return builder
        },
        update: (patch: Record<string, unknown>) => ({
          eq(col: string, val: unknown) {
            const matched = table === 'system_flags' && col === 'key' && fakeFlags.has(val as string)
            if (matched) fakeFlags.set(val as string, patch.enabled as boolean)

            // Mirrors PostgREST: .update().eq() resolves with error null even when it
            // matched nothing, and only .select() reveals how many rows were touched.
            // That asymmetry is the whole reason setQueueFlag now calls .select().
            const result = {
              data: matched ? [{ key: val }] : [],
              error: null as { message: string } | null,
            }
            return {
              select: async () =>
                options.failRpc?.['update:system_flags']
                  ? { data: null, error: { message: options.failRpc['update:system_flags'] } }
                  : result,
              then: (resolve: (v: unknown) => void) => resolve({ error: result.error }),
            }
          },
        }),
      }
    },
  }

  const fakeFlags = new Map<string, boolean>()

  return {
    client: client as any,
    rows,
    rpcCalls,
    selectCalls,
    flags: fakeFlags,
    get: find,
  }
}
