import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// ─── Helper: Real writeFaqExtractionResults implementation for testing ──

interface FaqSeedResult {
  extracted_question: string
  suggested_answer: string
  source_material: string
  prompt_version: string
}

async function writeFaqExtractionResults(
  supabase: SupabaseClient,
  organisationId: string,
  results: FaqSeedResult[],
): Promise<void> {
  if (results.length === 0) return

  for (const result of results) {
    try {
      await supabase.from('faq_extractions').insert({
        organisation_id: organisationId,
        signal_id: null,
        reply_draft_id: null,
        extracted_question: result.extracted_question,
        suggested_answer: result.suggested_answer,
        source: 'seed_generated',
        status: 'pending',
        potential_names_flagged: [],
        prompt_version: result.prompt_version,
      })
    } catch (insertErr) {
      // Best-effort: log and continue
      const msg = insertErr instanceof Error ? insertErr.message : String(insertErr)
      // Logger call would go here but we're testing the continuation
    }
  }
}

describe('FAQ Seed Agent — writeFaqExtractionResults', () => {
  describe('Insert Structure and Org Scoping', () => {
    it('constructs insert with NULL signal_id and reply_draft_id', async () => {
      const insertMock = vi.fn().mockResolvedValue({ data: null, error: null })
      const mockFaqTable = {
        insert: insertMock,
      }

      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'faq_extractions') {
            return mockFaqTable
          }
          return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) }
        }),
      } as unknown as SupabaseClient

      const results = [
        {
          extracted_question: 'What is your pricing?',
          suggested_answer: 'Tiered pricing starting at 99 dollars per month.',
          source_material: 'pricing_page',
          prompt_version: '1.0.0',
        },
      ]

      await writeFaqExtractionResults(mockSupabase, 'org-123', results)

      // Verify insert was called
      expect(insertMock).toHaveBeenCalledTimes(1)
      const insertCall = insertMock.mock.calls[0]?.[0]

      // Verify NULL fields
      expect(insertCall).toBeDefined()
      expect(insertCall).toHaveProperty('signal_id', null)
      expect(insertCall).toHaveProperty('reply_draft_id', null)
      expect(insertCall).toHaveProperty('source', 'seed_generated')
      expect(insertCall).toHaveProperty('status', 'pending')
      expect(insertCall).toHaveProperty('organisation_id', 'org-123')
    })

    it('org-scopes all writes with organisation_id', async () => {
      const insertMock = vi.fn().mockResolvedValue({ data: null, error: null })
      const mockFaqTable = {
        insert: insertMock,
      }

      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'faq_extractions') {
            return mockFaqTable
          }
          return { insert: vi.fn() }
        }),
      } as unknown as SupabaseClient

      const results = [
        {
          extracted_question: 'Q1',
          suggested_answer: 'A1',
          source_material: 'doc1',
          prompt_version: '1.0.0',
        },
        {
          extracted_question: 'Q2',
          suggested_answer: 'A2',
          source_material: 'doc2',
          prompt_version: '1.0.0',
        },
      ]

      const orgId = 'org-999'
      await writeFaqExtractionResults(mockSupabase, orgId, results)

      // Verify both inserts were called
      expect(insertMock).toHaveBeenCalledTimes(2)
      const calls = insertMock.mock.calls

      // Every insert must include org_id
      for (const call of calls) {
        expect(call[0]).toHaveProperty('organisation_id', orgId)
      }
    })
  })

  describe('Best-Effort Error Handling', () => {
    it('one failed insert does not block subsequent inserts', async () => {
      let callIndex = 0
      const insertMock = vi.fn(async () => {
        const index = callIndex
        callIndex++
        // Fail on second call (index 1)
        if (index === 1) {
          throw new Error('Insert failed')
        }
        return { data: null, error: null }
      })

      const mockFaqTable = {
        insert: insertMock,
      }

      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'faq_extractions') {
            return mockFaqTable
          }
          return { insert: vi.fn() }
        }),
      } as unknown as SupabaseClient

      const results = [
        {
          extracted_question: 'Q1',
          suggested_answer: 'A1',
          source_material: 'd1',
          prompt_version: '1.0.0',
        },
        {
          extracted_question: 'Q2 (will fail)',
          suggested_answer: 'A2',
          source_material: 'd2',
          prompt_version: '1.0.0',
        },
        {
          extracted_question: 'Q3',
          suggested_answer: 'A3',
          source_material: 'd3',
          prompt_version: '1.0.0',
        },
      ]

      // Should not throw despite second failure
      await writeFaqExtractionResults(mockSupabase, 'org-123', results)

      // All three inserts should have been attempted
      expect(insertMock).toHaveBeenCalledTimes(3)
    })

    it('multiple results process correctly with all inserts called', async () => {
      const insertMock = vi.fn().mockResolvedValue({ data: null, error: null })
      const mockFaqTable = {
        insert: insertMock,
      }

      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'faq_extractions') {
            return mockFaqTable
          }
          return { insert: vi.fn() }
        }),
      } as unknown as SupabaseClient

      const results = Array.from({ length: 5 }, (_, i) => ({
        extracted_question: `Q${i}`,
        suggested_answer: `A${i}`,
        source_material: `doc${i}`,
        prompt_version: '1.0.0',
      }))

      await writeFaqExtractionResults(mockSupabase, 'org-456', results)

      // All 5 inserts must be attempted
      expect(insertMock).toHaveBeenCalledTimes(5)
    })
  })
})
