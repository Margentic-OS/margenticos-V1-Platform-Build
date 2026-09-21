// PIECE 2: a prospect assigned to a variant the document no longer has.
//
// BEFORE THIS, resolveVariant returned prospect.variant_id unchanged, getVariantEmails
// could not find it, logged a warning to stdout and returned THE FIRST VARIANT'S EMAILS.
// The prospect's researched opening was written against the missing variant's offer line
// and shipped above a different one. Nothing downstream could tell.
//
// THE FAKE RECORDS THE UPDATE rather than swallowing it. A chainable proxy that returns
// itself for every method will happily accept an .update() that never happened, so a test
// built on one proves the code path ran and nothing about what it wrote. See CLAUDE.md on
// fakes that do not honour what they are given.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { composeSequence } from '../compose-sequence'
import type { MessagingContent, ComposeDocs } from '../compose-sequence'
import { assignVariantDeterministically } from '../variant-assignment'

vi.mock('@supabase/supabase-js')
vi.mock('@/lib/composition/personalization', () => ({
  generateBridge: vi.fn().mockResolvedValue({ bridge: null }),
  countWords: (t: string) => t.split(/\s+/).filter(Boolean).length,
}))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
import { logger } from '@/lib/logger'

const CLIENT_ID = 'client-reassign'
const PROSPECT_ID = 'prospect-reassign-1'

const email1 = (variant: string) => ({
  sequence_position: 1,
  subject_line: 'a subject',
  subject_char_count: 9,
  body: `{{first_name}}\n\nObservation for ${variant}.\n\nConsequence for ${variant}.\n\nOffer line for ${variant}.\n\nWorth a look?\n\nRobin\nNorthwind`,
  word_count: 0,
})
const docWith = (...keys: string[]): MessagingContent => ({
  variants: Object.fromEntries(keys.map(k => [k, { emails: [email1(k)] }])),
} as unknown as MessagingContent)

const prospectRow = (variantId: string | null) => ({
  id: PROSPECT_ID,
  organisation_id: CLIENT_ID,
  segment_id: null,
  variant_id: variantId,
  personalisation_trigger: 'A researched observation.',
  has_dateable_signal: false,
  signal_relevance: null,
  role: 'CEO',
  first_name: 'Sam',
  last_name: 'Lee',
  company_name: 'Northwind',
  job_title: 'CEO',
})

const docs = (content: MessagingContent): ComposeDocs => ({
  messagingDoc: content,
  messagingDocId: '550e8400-e29b-41d4-a716-446655440000',
  icpPainPoint: 'a pain',
  positioningValueHook: 'a hook',
})

/** Records every .update() payload so the test can assert what was written, not merely that something was. */
function harness(prospect: Record<string, unknown>) {
  const updates: Record<string, unknown>[] = []
  const chain = (result: unknown): unknown => new Proxy({} as Record<string, unknown>, {
    get(_, prop: string) {
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(result)
      if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve(result).then(res)
      if (prop === 'update') return (payload: Record<string, unknown>) => { updates.push(payload); return chain({ data: null, error: null }) }
      return () => chain(result)
    },
  })
  vi.mocked(createClient).mockReturnValue({
    from: vi.fn((table: string) =>
      chain(table === 'prospects' ? { data: prospect, error: null } : { data: null, error: null })),
  } as unknown as ReturnType<typeof createClient>)
  return updates
}

beforeEach(() => vi.clearAllMocks())

describe('the variant is still in the document', () => {
  it('keeps the assignment and writes nothing', async () => {
    const updates = harness(prospectRow('C'))
    const result = await composeSequence({
      prospect_id: PROSPECT_ID, client_id: CLIENT_ID, preloadedDocs: docs(docWith('A', 'C', 'D')),
    })
    expect(result.variant_id).toBe('C')
    expect(updates).toEqual([])
  })

  it('ships THAT variant\'s offer line, not another one', async () => {
    harness(prospectRow('C'))
    const result = await composeSequence({
      prospect_id: PROSPECT_ID, client_id: CLIENT_ID, preloadedDocs: docs(docWith('A', 'C', 'D')),
    })
    expect(result.emails[0].body).toContain('Offer line for C.')
    expect(result.emails[0].body).not.toContain('Offer line for A.')
  })
})

describe('the variant is gone from the document', () => {
  const missing = () => composeSequence({
    prospect_id: PROSPECT_ID, client_id: CLIENT_ID, preloadedDocs: docs(docWith('A', 'C', 'D')),
  })

  it('does NOT silently ship the first variant', async () => {
    harness(prospectRow('B'))
    const result = await missing()
    // The old behaviour returned 'B' and getVariantEmails fell back to 'A'. Either would
    // fail this: the returned variant must be one the document actually has.
    expect(['A', 'C', 'D']).toContain(result.variant_id)
    expect(result.variant_id).not.toBe('B')
  })

  it('reassigns to the SAME survivor the shared hash picks, so research and composition agree', async () => {
    harness(prospectRow('B'))
    const result = await missing()
    expect(result.variant_id).toBe(assignVariantDeterministically(PROSPECT_ID, ['A', 'C', 'D']))
  })

  it('is deterministic: the same prospect lands in the same place every time', async () => {
    harness(prospectRow('B')); const first = await missing()
    harness(prospectRow('B')); const second = await missing()
    expect(second.variant_id).toBe(first.variant_id)
  })

  it('RECORDS which variant it left, and when', async () => {
    const updates = harness(prospectRow('B'))
    const result = await missing()
    const move = updates.find(u => 'variant_reassigned_from' in u)
    expect(move, 'no update carried a reassignment record').toBeDefined()
    expect(move!.variant_reassigned_from).toBe('B')
    expect(move!.variant_id).toBe(result.variant_id)
    expect(typeof move!.variant_reassigned_at).toBe('string')
  })

  it('ships the offer line of the variant it moved TO', async () => {
    harness(prospectRow('B'))
    const result = await missing()
    expect(result.emails[0].body).toContain(`Offer line for ${result.variant_id}.`)
  })

  it('warns, naming both variants, so the move is visible in the log as well as the row', async () => {
    harness(prospectRow('B'))
    await missing()
    const warned = vi.mocked(logger.warn).mock.calls
      .find(c => String(c[0]).includes('reassigned off a variant'))
    expect(warned, 'no warning was logged for the reassignment').toBeDefined()
    expect((warned![1] as Record<string, unknown>).from).toBe('B')
  })
})

describe('a prospect with no variant yet', () => {
  it('is assigned normally and is NOT recorded as a reassignment', async () => {
    const updates = harness(prospectRow(null))
    const result = await composeSequence({
      prospect_id: PROSPECT_ID, client_id: CLIENT_ID, preloadedDocs: docs(docWith('A', 'C', 'D')),
    })
    expect(['A', 'C', 'D']).toContain(result.variant_id)
    expect(updates.some(u => 'variant_reassigned_from' in u)).toBe(false)
  })
})
