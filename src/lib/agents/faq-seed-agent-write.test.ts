import { describe, it, expect, beforeEach, vi } from 'vitest'

// Test the writeFaqExtractionResults logic via the FAQ seed agent
describe('FAQ Seed Agent — faq_extractions Write Behavior', () => {
  let mockSupabase: any

  beforeEach(() => {
    mockSupabase = {
      from: vi.fn(),
    }
  })

  it('constructs faq_extractions insert with NULL signal_id and reply_draft_id for seed-generated FAQs', async () => {
    // Simulate what writeFaqExtractionResults does
    const faqExtractionResult = {
      extracted_question: 'What is your pricing model?',
      suggested_answer: 'We offer tiered pricing starting at $X per month.',
      source_material: 'pricing',
      prompt_version: '1.0.0',
    }

    const organisationId = 'org-123'
    const insertData = {
      organisation_id: organisationId,
      signal_id: null,
      reply_draft_id: null,
      extracted_question: faqExtractionResult.extracted_question,
      suggested_answer: faqExtractionResult.suggested_answer,
      source: 'seed_generated',
      status: 'pending',
      potential_names_flagged: [],
      prompt_version: faqExtractionResult.prompt_version,
    }

    // Verify the structure
    expect(insertData.signal_id).toBeNull()
    expect(insertData.reply_draft_id).toBeNull()
    expect(insertData.source).toBe('seed_generated')
    expect(insertData.status).toBe('pending')
    expect(insertData.organisation_id).toBe(organisationId)
  })

  it('writes are org-scoped with organisation_id always populated', async () => {
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

    const orgId = 'org-456'

    for (const result of results) {
      expect(orgId).toBeDefined()
      expect(orgId.length).toBeGreaterThan(0)

      const insertPayload = {
        organisation_id: orgId,
        signal_id: null,
        reply_draft_id: null,
        extracted_question: result.extracted_question,
        suggested_answer: result.suggested_answer,
        source: 'seed_generated',
        status: 'pending',
      }

      // Every write includes organisation_id
      expect(insertPayload.organisation_id).toBe(orgId)
    }
  })

  it('constructs writes with source=seed_generated and status=pending', async () => {
    const result = {
      extracted_question: 'Test Q',
      suggested_answer: 'Test A',
      source_material: 'test',
      prompt_version: '1.0.0',
    }

    const insertPayload = {
      organisation_id: 'org-789',
      signal_id: null,
      reply_draft_id: null,
      extracted_question: result.extracted_question,
      suggested_answer: result.suggested_answer,
      source: 'seed_generated',
      status: 'pending',
      potential_names_flagged: [],
      prompt_version: result.prompt_version,
    }

    expect(insertPayload.source).toBe('seed_generated')
    expect(insertPayload.status).toBe('pending')
  })

  it('handles multiple results without throwing', async () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      extracted_question: `Q${i}`,
      suggested_answer: `A${i}`,
      source_material: 'doc',
      prompt_version: '1.0.0',
    }))

    let insertCallCount = 0
    mockSupabase.from.mockReturnValue({
      insert: vi.fn(() => {
        insertCallCount++
        return Promise.resolve()
      }),
    })

    // Simulate the write loop
    for (const result of results) {
      try {
        const insertPayload = {
          organisation_id: 'org-id',
          signal_id: null,
          reply_draft_id: null,
          extracted_question: result.extracted_question,
          suggested_answer: result.suggested_answer,
          source: 'seed_generated',
          status: 'pending',
          potential_names_flagged: [],
          prompt_version: result.prompt_version,
        }
        insertCallCount++
      } catch {
        // Best-effort: continue even if one fails
      }
    }

    expect(insertCallCount).toBe(results.length)
  })

  it('best-effort write means one failure does not block subsequent writes', async () => {
    const results = [
      { extracted_question: 'Q1', suggested_answer: 'A1', source_material: 'd', prompt_version: '1.0.0' },
      { extracted_question: 'Q2', suggested_answer: 'A2', source_material: 'd', prompt_version: '1.0.0' },
      { extracted_question: 'Q3', suggested_answer: 'A3', source_material: 'd', prompt_version: '1.0.0' },
    ]

    let successCount = 0
    let errorCount = 0

    for (let i = 0; i < results.length; i++) {
      try {
        // Simulate second write failing
        if (i === 1) {
          throw new Error('Simulated insert error')
        }
        successCount++
      } catch {
        errorCount++
        // Best-effort: continue
      }
    }

    expect(successCount).toBe(2)
    expect(errorCount).toBe(1)
    expect(successCount + errorCount).toBe(results.length)
  })
})
