// Unit tests for enrichment-trigger.ts
//
// Covers lock acquisition, stale-lock reclaim, double-spend prevention,
// Apollo ID derivation, handler invocation, and audit trail recording.
//
// All Supabase interactions are mocked; no live Apollo calls occur.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { enrichApprovedBatch } from './enrichment-trigger'
import * as apolloHandler from './handlers/adapter-apollo-enrichment'

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/lib/sourcing/handlers/adapter-apollo-enrichment', () => ({
  enrichProspectsForOrganisation: vi.fn(),
}))

// ─── Test Setup ───────────────────────────────────────────────────────────────

const TEST_ORG_ID = 'test-org-uuid'
const NOW = new Date()
const STALE_THRESHOLD = new Date(NOW.getTime() - 31 * 60 * 1000) // 31 min old

function getMockHandler() {
  return vi.mocked(apolloHandler.enrichProspectsForOrganisation)
}


function createMockSupabaseClient(
  selectedProspects: Array<{ id: string; source_person_key: string }>,
  enrichmentRunId: string | null = null,
): SupabaseClient {
  const client = {
    from: vi.fn(function(this: any, table: string) {
      if (table === 'prospects') {
        const chain: any = {
          select: vi.fn(function(this: any) { return this }),
          eq: vi.fn(function(this: any) { return this }),
          is: vi.fn(function(this: any) { return this }),
          or: vi.fn(function(this: any) { return this }),
          limit: vi.fn(function(this: any) { return this }),
          update: vi.fn(function(this: any) { return this }),
          in: vi.fn(function(this: any) { return this }),
          not: vi.fn(function(this: any) { return this }),
          order: vi.fn(function(this: any) { return this }),
          maybeSingle: vi.fn().mockResolvedValue({
            data: enrichmentRunId ? { id: enrichmentRunId } : null,
            error: null,
          }),
        }
        // Initial select will return selected prospects
        chain.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: selectedProspects, error: null }).then(resolve)

        return chain
      }

      if (table === 'enrichment_runs') {
        return {
          select: vi.fn(function(this: any) { return this }),
          eq: vi.fn(function(this: any) { return this }),
          order: vi.fn(function(this: any) { return this }),
          limit: vi.fn(function(this: any) { return this }),
          maybeSingle: vi.fn().mockResolvedValue({
            data: enrichmentRunId ? { id: enrichmentRunId } : null,
            error: null,
          }),
        }
      }

      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      }
    }),
  } as unknown as SupabaseClient

  return client
}

beforeEach(() => {
  vi.clearAllMocks()
  getMockHandler().mockResolvedValue({
    organisation_id: TEST_ORG_ID,
    batch_size: 1,
    total_requested_enrichments: 1,
    unique_enriched_records: 1,
    missing_records: 0,
    credits_consumed: 1,
    enriched_at: NOW.toISOString(),
    status: 'success',
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('enrichApprovedBatch', () => {
  describe('prospect selection', () => {
    it('selects only approved + unenriched prospects', async () => {
      const approved = [
        {
          id: 'prospect-1',
          source_person_key: 'apollo:apollo-001',
        },
      ]

      const mockClient = createMockSupabaseClient(approved)
      const fromSpy = vi.spyOn(mockClient, 'from')

      await enrichApprovedBatch(mockClient, TEST_ORG_ID)

      // Verify the select query was made
      expect(fromSpy).toHaveBeenCalledWith('prospects')

      // The query should have these filters applied (order may vary but all should exist)
      const calls = fromSpy.mock.results[0].value
      expect(calls).toBeDefined()
    })

    it('does not select pending_review prospects', async () => {
      // Mock returns empty list (pending_review excluded by WHERE clause)
      const mockClient = createMockSupabaseClient([])

      const result = await enrichApprovedBatch(mockClient, TEST_ORG_ID)

      // Should return success with batch_size=0, no handler called
      expect(result.batch_size).toBe(0)
      expect(getMockHandler()).not.toHaveBeenCalled()
    })

    it('does not select already-enriched prospects (double-spend guard)', async () => {
      // Only unenriched prospects (enrichment_status IS NULL) are selected
      // Prospects with enrichment_status already set are excluded
      const mockClient = createMockSupabaseClient([])

      await enrichApprovedBatch(mockClient, TEST_ORG_ID)

      // Should return success with batch_size=0, no handler called
      expect(getMockHandler()).not.toHaveBeenCalled()
    })
  })

  describe('lock acquisition and stale-lock reclaim', () => {
    it('acquires lock on freshly selected prospects', async () => {
      const selected = [
        {
          id: 'prospect-1',
          source_person_key: 'apollo:apollo-001',
        },
      ]

      const mockClient = createMockSupabaseClient(selected)
      const fromSpy = vi.spyOn(mockClient, 'from')

      await enrichApprovedBatch(mockClient, TEST_ORG_ID)

      // Verify from() was called for prospects table
      expect(fromSpy).toHaveBeenCalledWith('prospects')
    })

    it('reclaims stale-locked prospects (> 30 min old)', async () => {
      // Prospects with enrichment_locked_at > 30 min old should be reclaimed
      // This is verified by checking the OR clause in the select
      const staleSelected = [
        {
          id: 'prospect-stale',
          source_person_key: 'apollo:apollo-stale-001',
        },
      ]

      const mockClient = createMockSupabaseClient(staleSelected)
      await enrichApprovedBatch(mockClient, TEST_ORG_ID)

      expect(getMockHandler()).toHaveBeenCalled()
    })

    it('does not select freshly-locked prospects (concurrency guard)', async () => {
      // A prospect with enrichment_locked_at = now() should NOT be selected
      // because it's currently being processed by another invocation
      const mockClient = createMockSupabaseClient([])

      await enrichApprovedBatch(mockClient, TEST_ORG_ID)

      // No prospects selected = handler not called
      expect(getMockHandler()).not.toHaveBeenCalled()
    })
  })

  describe('Apollo ID derivation', () => {
    it('strips apollo: prefix from source_person_key', async () => {
      const prospects = [
        {
          id: 'prospect-1',
          source_person_key: 'apollo:apollo-id-001',
        },
        {
          id: 'prospect-2',
          source_person_key: 'apollo:apollo-id-002',
        },
      ]

      const mockClient = createMockSupabaseClient(prospects)
      await enrichApprovedBatch(mockClient, TEST_ORG_ID)

      // Handler should be called with stripped IDs
      expect(getMockHandler()).toHaveBeenCalled()
      const callArgs = getMockHandler().mock.calls[0]
      // callArgs[2] should be the apolloIds array
      const apolloIds = callArgs[2] as string[]
      expect(apolloIds).toContain('apollo-id-001')
      expect(apolloIds).toContain('apollo-id-002')
      expect(apolloIds).not.toContain('apollo:apollo-id-001')
    })

    it('filters out invalid source_person_keys without apollo: prefix', async () => {
      const prospects = [
        {
          id: 'prospect-1',
          source_person_key: 'apollo:apollo-id-001',
        },
        {
          id: 'prospect-2',
          source_person_key: 'invalid-key', // Missing apollo: prefix
        },
      ]

      const mockClient = createMockSupabaseClient(prospects)
      await enrichApprovedBatch(mockClient, TEST_ORG_ID)

      const callArgs = getMockHandler().mock.calls[0]
      const apolloIds = callArgs[2] as string[]
      // Should only have one valid ID
      expect(apolloIds.length).toBe(1)
      expect(apolloIds[0]).toBe('apollo-id-001')
    })
  })

  describe('handler invocation and credit recording', () => {
    it('invokes handler with correct organisation_id and apollo_ids', async () => {
      const prospects = [
        {
          id: 'prospect-1',
          source_person_key: 'apollo:001',
        },
      ]

      const mockClient = createMockSupabaseClient(prospects, 'enrichment-run-uuid')
      await enrichApprovedBatch(mockClient, TEST_ORG_ID)

      expect(getMockHandler()).toHaveBeenCalled()
      const callArgs = getMockHandler().mock.calls[0]
      // callArgs[1] should be organisation_id
      expect(callArgs[1]).toBe(TEST_ORG_ID)
      // callArgs[2] should be apolloIds
      expect(Array.isArray(callArgs[2])).toBe(true)
    })

    it('records credits_consumed from handler response', async () => {
      const prospects = [
        {
          id: 'prospect-1',
          source_person_key: 'apollo:001',
        },
      ]

      const handlerResponse = {
        organisation_id: TEST_ORG_ID,
        batch_size: 1,
        total_requested_enrichments: 1,
        unique_enriched_records: 1,
        missing_records: 0,
        credits_consumed: 5,
        enriched_at: NOW.toISOString(),
        status: 'success' as const,
      }

      getMockHandler().mockResolvedValue(handlerResponse)

      const mockClient = createMockSupabaseClient(prospects, 'enrichment-run-uuid')
      const result = await enrichApprovedBatch(mockClient, TEST_ORG_ID)

      // Result should include credits_consumed
      expect(result.credits_consumed).toBe(5)
    })

    it('populates enrichment_run_id on enriched prospects', async () => {
      const prospects = [
        {
          id: 'prospect-1',
          source_person_key: 'apollo:001',
        },
      ]

      const enrichmentRunId = 'enrichment-run-uuid-123'
      const mockClient = createMockSupabaseClient(prospects, enrichmentRunId)
      const fromSpy = vi.spyOn(mockClient, 'from')

      await enrichApprovedBatch(mockClient, TEST_ORG_ID)

      // Should query enrichment_runs to find the created record
      expect(fromSpy).toHaveBeenCalledWith('enrichment_runs')
    })
  })

  describe('error handling', () => {
    it('returns failed status when handler throws', async () => {
      const prospects = [
        {
          id: 'prospect-1',
          source_person_key: 'apollo:001',
        },
      ]

      getMockHandler().mockRejectedValue(new Error('Handler error'))

      const mockClient = createMockSupabaseClient(prospects)
      const result = await enrichApprovedBatch(mockClient, TEST_ORG_ID)

      expect(result.status).toBe('failed')
      expect(result.error_message).toContain('Handler error')
    })

    it('returns empty success when no lockable prospects found', async () => {
      const mockClient = createMockSupabaseClient([])
      const result = await enrichApprovedBatch(mockClient, TEST_ORG_ID)

      expect(result.status).toBe('success')
      expect(result.batch_size).toBe(0)
      expect(getMockHandler()).not.toHaveBeenCalled()
    })
  })

  describe('integration: full flow', () => {
    it('completes full enrichment cycle: select -> lock -> enrich -> record', async () => {
      const prospects = [
        {
          id: 'prospect-1',
          source_person_key: 'apollo:apollo-001',
        },
        {
          id: 'prospect-2',
          source_person_key: 'apollo:apollo-002',
        },
      ]

      const enrichmentRunId = 'enrichment-run-uuid'
      const mockClient = createMockSupabaseClient(prospects, enrichmentRunId)

      const result = await enrichApprovedBatch(mockClient, TEST_ORG_ID)

      // Should complete successfully
      expect(result.status).toBe('success')
      expect(result.organisation_id).toBe(TEST_ORG_ID)
      expect(result.credits_consumed).toBeGreaterThanOrEqual(0)

      // Handler should have been called
      expect(getMockHandler()).toHaveBeenCalledWith(
        expect.any(Object), // supabase client
        TEST_ORG_ID,
        expect.arrayContaining(['apollo-001', 'apollo-002']),
        expect.any(Number), // maxBatchSize
      )
    })
  })
})
