// A cross-organisation FAQ reference is REFUSED and RECORDED, not just refused.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
//
// sendApprovedDraft's tier-3 FAQ extraction validates that every FK it is about to
// write (similar_faq_id, similar_pending_extraction_id) belongs to the organisation
// the draft belongs to. Service role bypasses RLS, so the application is the layer
// that has to ask.
//
// The check was correct. The RECORD was not. Both branches built a message naming the
// offending id and the organisation:
//
//     const msg = `CRITICAL: similar_faq_id ${...} does not belong to organisation ${...}`
//
// and then never passed it to logger.error. The call logged a generic line carrying
// draft_id and the offending id, with no organisation on it at all, and `msg` was
// discarded. That shipped and stayed for months.
//
// WHY THE MISSING LOG MATTERED MORE THAN IT LOOKS. There is a database trigger,
// validate_faq_extractions_org_consistency(), that rejects a cross-org write even from
// service role — see src/lib/faq/write-enforcement.test.ts. But it is never reached
// here, because this check `continue`s BEFORE the insert. So the application refusing
// quietly means a cross-organisation reference produces no row, no trigger error, and
// no usable log line. It is invisible end to end. The log is the only evidence that
// exists, which is exactly why discarding it was the defect.
//
// tsc could not catch it: tsconfig sets strict but not noUnusedLocals. No test covered
// this path at all — measured before writing this file, zero of the nine tests in
// send-approved-draft.test.ts reach tier 3.
//
// WHAT THIS FILE PINS. That the constructed message, with the real ids in it, reaches
// the log; that the write is still refused; and that a clean same-organisation
// reference is written and logs nothing. The last one is the control: without it the
// error assertions could pass against code that logs CRITICAL unconditionally.
//
// Runs entirely against a fabricated organisation. No database, no network, no email.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const logger = vi.hoisted(() => ({
  info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({ logger }))

vi.mock('@/lib/integrations/handlers/instantly/reply-actions', () => ({
  sendThreadReply: vi.fn(async () => ({ ok: true, message_id: 'provider-msg-1', error: null })),
}))
vi.mock('@/lib/integrations/handlers/instantly/auth', () => ({
  getInstantlyApiKey: vi.fn(async () => 'test-key'),
  getInstantlyApiActive: vi.fn(async () => false),
}))
vi.mock('@/lib/integrations/handlers/instantly/constants', () => ({
  resolveInstantlyBaseUrl: () => 'https://mock.test',
}))

// Non-null, or the extraction block is skipped and every assertion below passes vacuously.
vi.mock('@/lib/reply-handling/load-org-context', () => ({
  loadOrgContext: vi.fn(async () => ({
    tovDocument: 'tov',
    positioningDocument: 'positioning',
    organisationName: 'Test Organisation',
    senderFirstName: 'Alex',
  })),
}))

// The agent is stubbed at the module boundary. What it returns is the input to the
// ownership check, which is the thing under test.
const extractFaq = vi.hoisted(() => vi.fn())
vi.mock('@/lib/agents/faq-extraction-agent', () => ({ extractFaq }))

import { sendApprovedDraft } from '../send-approved-draft'

const OWN_ORG = 'test-org-1'
const OTHER_ORG = 'test-org-2-belongs-to-somebody-else'

function extractionResult(over: Record<string, unknown> = {}) {
  return {
    extracted_question: 'A question the prospect asked.',
    captured_answer: 'The answer the operator sent.',
    similar_faq_id: null,
    similar_pending_extraction_id: null,
    similarity_score: null,
    potential_names_flagged: [],
    prompt_version: 'test-v1',
    ...over,
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// rows: id -> owning organisation_id. A row absent from the map does not exist, which is
// how the dangling-reference case is expressed.
function createFakeDb(opts: { faqs?: Record<string, string>; extractions?: Record<string, string> } = {}) {
  const faqs = opts.faqs ?? {}
  const extractions = opts.extractions ?? {}
  const inserted: Array<Record<string, unknown>> = []

  const draft = {
    id: 'test-draft-1',
    organisation_id: OWN_ORG,
    signal_id: 'test-signal-1',
    prospect_id: 'test-prospect-1',
    tier: 3,                       // tier 3 is the only tier that runs FAQ extraction
    status: 'approved',
    final_sent_body: 'Happy to talk. Grab a slot here: {booking_link}',
    ai_draft_body: null,
  }
  const org = { name: 'Test Organisation', founder_first_name: 'Alex', booking_url: 'https://booking.test/alex' }
  const signal = {
    id: 'test-signal-1',
    raw_data: {
      id: 'provider-thread-1',
      eaccount: 'sender@test.invalid',
      subject: 'Re: a subject',
      body: { text: 'A question from the prospect.' },
    },
    original_outbound_body: 'The original outbound email.',
  }

  // An ownership lookup that ignored .eq('id', ...) would answer the same for every id,
  // and this whole file would be testing nothing. The id is captured and honoured.
  function ownershipLookup(rows: Record<string, string>) {
    let wanted: string | null = null
    const b: any = {
      select: () => b,
      eq: (col: string, val: string) => {
        if (col !== 'id') throw new Error(`fake ownershipLookup does not implement filter on ${col}`)
        wanted = val
        return b
      },
      maybeSingle: async () => {
        if (wanted === null) throw new Error('fake ownershipLookup: .eq("id", ...) was never applied')
        const owner = rows[wanted]
        return { data: owner ? { organisation_id: owner } : null, error: null }
      },
    }
    return b
  }

  const client: any = {
    inserted,
    from(table: string) {
      if (table === 'reply_drafts') {
        const b: any = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: draft, error: null }),
          update: (values: Record<string, unknown>, options?: { count?: string }) => {
            if (typeof values.status === 'string') draft.status = values.status
            const settled = { error: null, count: options?.count === 'exact' ? 1 : null }
            const chain: any = {
              eq: () => chain,
              in: async () => settled,
              then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(settled)),
            }
            return chain
          },
        }
        return b
      }
      if (table === 'organisations') {
        const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: org, error: null }) }
        return b
      }
      if (table === 'signals') {
        const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: signal, error: null }) }
        return b
      }
      if (table === 'faqs') return ownershipLookup(faqs)
      if (table === 'faq_extractions') {
        const b: any = {
          ...ownershipLookup(extractions),
          insert: async (row: Record<string, unknown>) => {
            inserted.push(row)
            return { error: null }
          },
        }
        return b
      }
      throw new Error(`fake does not implement table ${table}`)
    },
  }
  return client
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function errorCalls() {
  return logger.error.mock.calls.filter(
    (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('ownership validation failed'),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a similar_faq_id owned by another organisation', () => {
  it('records the CRITICAL message, naming the faq and the organisation it should have belonged to', async () => {
    extractFaq.mockResolvedValue([extractionResult({ similar_faq_id: 'faq-owned-elsewhere' })])
    const db = createFakeDb({ faqs: { 'faq-owned-elsewhere': OTHER_ORG } })

    await sendApprovedDraft('test-draft-1', db)

    const calls = errorCalls()
    expect(calls).toHaveLength(1)

    const [message, meta] = calls[0] as [string, Record<string, unknown>]
    expect(message).toBe('send-approved-draft: FAQ ownership validation failed')

    // THE ASSERTION THIS FILE EXISTS FOR. The constructed message must reach the log.
    // Discarding it again, or replacing it with a constant, fails here.
    expect(meta.detail).toEqual(expect.stringContaining('CRITICAL'))
    expect(meta.detail).toEqual(expect.stringContaining('faq-owned-elsewhere'))
    expect(meta.detail).toEqual(expect.stringContaining(OWN_ORG))

    // Structured fields, so an aggregator can filter without parsing the prose.
    expect(meta).toMatchObject({
      draft_id: 'test-draft-1',
      faq_id: 'faq-owned-elsewhere',
      organisation_id: OWN_ORG,
      actual_organisation_id: OTHER_ORG,   // a real row, owned by somebody else
    })
  })

  it('still refuses the write', async () => {
    extractFaq.mockResolvedValue([extractionResult({ similar_faq_id: 'faq-owned-elsewhere' })])
    const db = createFakeDb({ faqs: { 'faq-owned-elsewhere': OTHER_ORG } })

    await sendApprovedDraft('test-draft-1', db)

    expect(db.inserted).toHaveLength(0)
  })

  it('distinguishes a dangling id from a real row owned elsewhere', async () => {
    // No row at all. Different incident: a broken reference, not an isolation failure.
    extractFaq.mockResolvedValue([extractionResult({ similar_faq_id: 'faq-that-does-not-exist' })])
    const db = createFakeDb({ faqs: {} })

    await sendApprovedDraft('test-draft-1', db)

    const [, meta] = errorCalls()[0] as [string, Record<string, unknown>]
    expect(meta.actual_organisation_id).toBeNull()
    expect(meta.detail).toEqual(expect.stringContaining('faq-that-does-not-exist'))
    expect(db.inserted).toHaveLength(0)
  })
})

describe('a similar_pending_extraction_id owned by another organisation', () => {
  it('records the CRITICAL message, naming the extraction and the organisation', async () => {
    extractFaq.mockResolvedValue([
      extractionResult({ similar_pending_extraction_id: 'extraction-owned-elsewhere' }),
    ])
    const db = createFakeDb({ extractions: { 'extraction-owned-elsewhere': OTHER_ORG } })

    await sendApprovedDraft('test-draft-1', db)

    const calls = errorCalls()
    expect(calls).toHaveLength(1)

    const [message, meta] = calls[0] as [string, Record<string, unknown>]
    expect(message).toBe('send-approved-draft: pending extraction ownership validation failed')

    expect(meta.detail).toEqual(expect.stringContaining('CRITICAL'))
    expect(meta.detail).toEqual(expect.stringContaining('extraction-owned-elsewhere'))
    expect(meta.detail).toEqual(expect.stringContaining(OWN_ORG))

    expect(meta).toMatchObject({
      draft_id: 'test-draft-1',
      extraction_id: 'extraction-owned-elsewhere',
      organisation_id: OWN_ORG,
      actual_organisation_id: OTHER_ORG,
    })

    expect(db.inserted).toHaveLength(0)
  })
})

describe('the control: a reference the organisation really owns', () => {
  // Without this, every assertion above would still pass against code that logged
  // CRITICAL on every extraction and never wrote anything.
  it('writes the extraction and logs no ownership failure', async () => {
    extractFaq.mockResolvedValue([
      extractionResult({ similar_faq_id: 'faq-we-own', similarity_score: 0.9 }),
    ])
    const db = createFakeDb({ faqs: { 'faq-we-own': OWN_ORG } })

    await sendApprovedDraft('test-draft-1', db)

    expect(errorCalls()).toHaveLength(0)
    expect(db.inserted).toHaveLength(1)
    expect(db.inserted[0]).toMatchObject({
      organisation_id: OWN_ORG,
      reply_draft_id: 'test-draft-1',
      similar_faq_id: 'faq-we-own',
      status: 'pending',
      source: 'reply_extracted',
    })
  })
})
