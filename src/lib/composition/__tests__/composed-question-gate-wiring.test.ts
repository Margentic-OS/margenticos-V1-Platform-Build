// The composed-question gate must actually RUN on the send path, not merely exist.
//
// A pure module with its own passing tests proves the counting is right and proves nothing
// about whether anything calls it. Deleting the call in composeSequence would leave every
// test in email1-frame-shape.test.ts green while the shipped email went unchecked. This
// file exercises composeSequence itself so that deletion turns something red.
//
// Fixtures invented and industry-neutral.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { composeSequence } from '../compose-sequence'
import type { MessagingContent, ComposeDocs } from '../compose-sequence'

vi.mock('@supabase/supabase-js')

vi.mock('@/lib/composition/personalization', () => ({
  generateBridge: vi.fn().mockResolvedValue({ bridge: null }),
  countWords: (text: string) => text.split(/\s+/).filter(Boolean).length,
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
import { logger } from '@/lib/logger'

const CLIENT_ID = 'client-wiring-1'
const PROSPECT_ID = 'prospect-wiring-1'

function makeChain(result: { data: unknown; error: unknown }): unknown {
  const proxy: unknown = new Proxy({} as Record<string, unknown>, {
    get(_, prop: string) {
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(result)
      if (prop === 'then') {
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(result).then(res, rej)
      }
      return () => proxy
    },
  })
  return proxy
}

function setupSupabaseMock(tableConfig: Record<string, { data: unknown; error: unknown }>) {
  const mockFrom = vi.fn((table: string) => makeChain(tableConfig[table] ?? { data: null, error: null }))
  vi.mocked(createClient).mockReturnValue({ from: mockFrom } as unknown as ReturnType<typeof createClient>)
}

const PROSPECT_ROW = {
  id: PROSPECT_ID,
  organisation_id: CLIENT_ID,
  segment_id: null,
  variant_id: 'A',
  // NOT from research, so composition leaves the authored paragraphs in place. The gate
  // must fire on the document's own copy, which is exactly the case nothing else covers.
  personalisation_trigger: null,
  has_dateable_signal: false,
  signal_relevance: null,
  role: 'a role',
  first_name: 'Robin',
  last_name: 'Vale',
  company_name: 'Northwind Advisory',
}

const SIGN_OFF = 'Robin\nNorthwind Advisory'

function docWith(secondParagraph: string): MessagingContent {
  return {
    variants: {
      A: {
        emails: [
          {
            sequence_position: 1,
            subject_line: 'a short subject',
            subject_char_count: 15,
            body: [
              '{{first_name}}',
              'The rota gets rebuilt by hand every week.',
              secondParagraph,
              'Worth a look to see if it fits where you are?',
              SIGN_OFF,
            ].join('\n\n'),
            word_count: 30,
          },
        ],
      },
    },
  } as unknown as MessagingContent
}

function docsFor(content: MessagingContent): ComposeDocs {
  return {
    messagingDoc: content,
    messagingDocId: '550e8400-e29b-41d4-a716-446655440000',
    icpPainPoint: undefined,
    positioningValueHook: undefined,
  } as unknown as ComposeDocs
}

const gateWarnings = () =>
  vi.mocked(logger.warn).mock.calls.filter(c => String(c[0]).includes('composed-question-gate'))

describe('composeSequence runs the composed-question gate', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    setupSupabaseMock({ prospects: { data: PROSPECT_ROW, error: null } })
  })
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    vi.clearAllMocks()
  })

  it('warns when the composed Email 1 carries a second question', async () => {
    const result = await composeSequence({
      prospect_id: PROSPECT_ID,
      client_id: CLIENT_ID,
      preloadedDocs: docsFor(docWith('Is the rebuild still done by hand?')),
    })

    expect(result.emails[0].body).toContain('Is the rebuild still done by hand?')
    const hits = gateWarnings()
    expect(hits).toHaveLength(1)
    expect(hits[0][1]).toMatchObject({
      prospectId: PROSPECT_ID,
      clientId: CLIENT_ID,
      variantId: 'A',
      count: 2,
      mode: 'report',
    })
  })

  // REPORT-ONLY MEANS THE SEND IS UNAFFECTED. Pinned so a later flip to 'block' has to
  // change this test deliberately rather than by accident.
  it('still returns the sequence, because the gate is report-only', async () => {
    const result = await composeSequence({
      prospect_id: PROSPECT_ID,
      client_id: CLIENT_ID,
      preloadedDocs: docsFor(docWith('Is the rebuild still done by hand?')),
    })
    expect(result.emails).toHaveLength(1)
    expect(result.variant_id).toBe('A')
  })

  it('stays silent on a compliant composed Email 1', async () => {
    await composeSequence({
      prospect_id: PROSPECT_ID,
      client_id: CLIENT_ID,
      preloadedDocs: docsFor(docWith('We take that rebuild off the desk and keep it running.')),
    })
    expect(gateWarnings()).toHaveLength(0)
  })
})
