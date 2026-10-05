// F2a: a proposal that fails must reach the operator, not only Sentry.
//
// Before this change, proposeIcpFilterSpec recorded a failure in Sentry and returned it to a
// caller that was already done (the save had succeeded). The ICP read as finished while the
// search kept its old settings, and nothing on the operator's screen said so.
//
// Three things are proved here, each with a positive control in the same block:
//   1. A failed proposal is written onto the document as a refusal, naming the step.
//   2. A later success clears that mark; a skipped outcome writes nothing at all.
//   3. A failure to WRITE the mark is logged and never thrown back at the caller.
// And one defect found while building it: a document READ that errored was reported as "not
// found" at warn, so a gateway cut on that read was a silent skip. It is a failure now.
//
// THE FAKES honour every method they use and throw on anything else. A "no write happened"
// assertion is only meaningful next to a control showing the same fake records a write.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const models = vi.hoisted(() => ({
  service: null as unknown,
}))

vi.mock('@sentry/nextjs', () => ({
  withScope: (fn: (s: unknown) => void) => fn({ setExtra() {}, setContext() {}, setTag() {} }),
  captureMessage: () => {},
  captureException: () => {},
  flush: async () => true,
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/supabase/service-role', () => ({
  createServiceRoleClient: async () => models.service,
}))
vi.mock('@/agents/buyer-criterion-agent', () => ({ deriveBuyerCriterionWithVocabulary: vi.fn() }))
vi.mock('@/agents/fit-dimensions-agent', () => ({ deriveFitDimensions: vi.fn() }))
vi.mock('@/lib/sourcing/resolve-icp-geography', () => ({ resolveIcpGeography: vi.fn() }))

import { proposeIcpFilterSpec } from '@/lib/sourcing/propose-icp-filter-spec'
import { logger } from '@/lib/logger'

const DOC = 'doc-active-icp'

interface ReadResult {
  data: Record<string, unknown> | null
  error: { message: string } | null
}

// The user-scoped read the proposal starts with. Only select, eq and maybeSingle exist: any other
// method is a TypeError, so an unimplemented call fails loudly rather than returning nothing.
function fakeUserClient(read: ReadResult): SupabaseClient {
  return {
    from(table: string) {
      if (table !== 'strategy_documents') throw new Error(`fake does not implement ${table}`)
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => read,
      }
      return chain
    },
  } as unknown as SupabaseClient
}

interface WriteRecord {
  values: Record<string, unknown>
  eqs: [string, unknown][]
}

// The service-role write the outcome is recorded with. It records every update it is asked for
// and returns the error it was built with, so a failed write can be provoked on purpose.
function fakeServiceClient(writeError: string | null) {
  const writes: WriteRecord[] = []
  const client = {
    from(table: string) {
      if (table !== 'strategy_documents') throw new Error(`fake does not implement ${table}`)
      return {
        update(values: Record<string, unknown>) {
          const record: WriteRecord = { values, eqs: [] }
          writes.push(record)
          return {
            eq(column: string, value: unknown) {
              record.eqs.push([column, value])
              return Promise.resolve({ error: writeError ? { message: writeError } : null })
            },
          }
        },
      }
    },
  }
  return { client, writes }
}

const ACTIVE_ICP: Record<string, unknown> = {
  id: DOC,
  document_type: 'icp',
  status: 'active',
  content: {},
  organisation_id: 'org-1',
  icp_filter_spec: null,
  icp_filter_spec_proposed: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  models.service = fakeServiceClient(null).client
})

describe('a failed document read is a failure, not a skip', () => {
  it('reports the read as failed, names the step, and logs at error', async () => {
    const outcome = await proposeIcpFilterSpec(
      fakeUserClient({ data: null, error: { message: 'Gateway Timeout' } }),
      DOC,
    )

    expect(outcome).toEqual({ outcome: 'failed', step: 'read the document', error: 'Gateway Timeout' })
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('read the document failed'),
      expect.anything(),
    )
  })

  it('CONTROL: a document that is genuinely absent is still a quiet skip, not a failure', async () => {
    const outcome = await proposeIcpFilterSpec(fakeUserClient({ data: null, error: null }), DOC)

    expect(outcome).toEqual({ outcome: 'skipped', why: 'not_found' })
    expect(logger.error).not.toHaveBeenCalled()
  })
})

describe('the outcome is written onto the document', () => {
  it('a failed proposal is recorded as a proposal_failed refusal on that document', async () => {
    const { client, writes } = fakeServiceClient(null)
    models.service = client

    await proposeIcpFilterSpec(fakeUserClient({ data: null, error: { message: 'Gateway Timeout' } }), DOC)

    // CONTROL: the fake does record a write. Without this, "one write" would be unverifiable.
    expect(writes).toHaveLength(1)
    expect(writes[0].eqs).toEqual([['id', DOC]])
    const refusal = writes[0].values.icp_filter_spec_refusal as Record<string, unknown>
    expect(refusal.reason).toBe('proposal_failed')
    expect(refusal.detail).toBe('read the document: Gateway Timeout')
    expect(typeof refusal.recorded_at).toBe('string')
  })

  it('a skipped outcome writes nothing, because there is no active ICP to say anything about', async () => {
    const { client, writes } = fakeServiceClient(null)
    models.service = client

    const outcome = await proposeIcpFilterSpec(
      fakeUserClient({ data: { ...ACTIVE_ICP, document_type: 'messaging' }, error: null }),
      DOC,
    )

    expect(outcome).toEqual({ outcome: 'skipped', why: 'not_icp' })
    expect(writes).toHaveLength(0)
  })
})

describe('a failure to record the mark is logged, never thrown at the caller', () => {
  it('returns the proposal outcome even when the write of the mark fails', async () => {
    const { client, writes } = fakeServiceClient('permission denied for table strategy_documents')
    models.service = client

    const outcome = await proposeIcpFilterSpec(
      fakeUserClient({ data: null, error: { message: 'Gateway Timeout' } }),
      DOC,
    )

    // The attempt was made and was refused: the control for the zero above.
    expect(writes).toHaveLength(1)
    expect(outcome).toEqual({ outcome: 'failed', step: 'read the document', error: 'Gateway Timeout' })
    expect(logger.error).toHaveBeenCalledWith(
      'proposeIcpFilterSpec: could not record the outcome on the document',
      expect.objectContaining({
        document_id: DOC,
        outcome: 'failed',
        error: 'permission denied for table strategy_documents',
      }),
    )
  })
})
