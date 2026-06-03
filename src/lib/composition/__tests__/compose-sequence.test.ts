// Unit tests for compose-sequence.ts — approval gating and snapshot race behaviour.
//
// Three scenarios mandated by Addendum-2:
//   (a) Messaging doc is active but client_approval_status='pending' → throws with named reason
//   (b) composeSequence with all docs pre-approved (preloadedDocs path) → returns composed sequence
//   (c) Mid-batch race: snapshot taken, DB doc becomes unapproved, batch still succeeds from snapshot

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { composeSequence } from '../compose-sequence'
import type { MessagingContent, ComposeDocs } from '../compose-sequence'

// ─── Static mocks ─────────────────────────────────────────────────────────────

vi.mock('@supabase/supabase-js')

vi.mock('@/lib/composition/personalization', () => ({
  generatePersonalization: vi.fn().mockResolvedValue({
    bridge: null,
    cta: 'Worth a quick call to see if it fits?',
  }),
  countWords: (text: string) => text.split(/\s+/).filter(Boolean).length,
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// ─── Mock helpers ──────────────────────────────────────────────────────────────

type MockResult = { data: unknown; error: unknown; count?: number | null }

// Creates a Supabase-like chainable query proxy.
// Every fluent method (.select, .eq, .order, .limit, .not, .update) returns self.
// Terminal calls (.single, .maybeSingle) and direct await resolve to `result`.
function makeChain(result: MockResult): unknown {
  const proxy: unknown = new Proxy({} as Record<string, unknown>, {
    get(_, prop: string) {
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(result)
      if (prop === 'then') {
        return (res: (v: MockResult) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(result).then(res, rej)
      }
      return (..._args: unknown[]) => proxy
    },
  })
  return proxy
}

// Configures the createClient mock with a per-table dispatch.
// Pass an array as the table value for sequential calls (consumed via shift).
function setupSupabaseMock(
  tableConfig: Record<string, MockResult | MockResult[]>,
): ReturnType<typeof vi.fn> {
  const mockFrom = vi.fn((table: string) => {
    const entry = tableConfig[table]
    if (Array.isArray(entry)) {
      const next = entry.shift() ?? { data: null, error: null }
      return makeChain(next)
    }
    return makeChain(entry ?? { data: null, error: null })
  })

  vi.mocked(createClient).mockReturnValue({ from: mockFrom } as unknown as ReturnType<typeof createClient>)
  return mockFrom
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CLIENT_ID = 'client-test-abc'
const PROSPECT_ID = 'prospect-test-123'

// Prospect with variant pre-assigned and trigger set → skips round-robin and ICP DB calls.
const PROSPECT_ROW = {
  id: PROSPECT_ID,
  organisation_id: CLIENT_ID,
  segment_id: null,
  variant_id: 'A',
  personalisation_trigger: 'Just saw your recent funding announcement.',
  has_dateable_signal: false,
  signal_relevance: null,
  role: 'CEO',
  first_name: 'Alice',
  last_name: 'Smith',
  company_name: 'Acme Corp',
}

const MESSAGING_CONTENT: MessagingContent = {
  variants: {
    A: {
      emails: [
        {
          sequence_position: 1,
          subject_line: 'Quick question',
          subject_char_count: 13,
          body: '{{first_name}}\n\nJust saw your recent funding announcement.\n\nWe help founders build consistent outbound pipelines.\n\nWorth a call?\n\nDoug',
          word_count: 22,
        },
        {
          sequence_position: 2,
          subject_line: null,
          subject_char_count: 0,
          body: 'Following up on my last note.\n\nDoug',
          word_count: 7,
        },
      ],
    },
  },
}

// Pre-built snapshot that would be captured at gate-pass time via fetchComposeDocs().
const APPROVED_DOCS: ComposeDocs = {
  messagingDoc: MESSAGING_CONTENT,
  icpPainPoint: 'founders struggling to build consistent outbound pipeline',
  positioningValueHook: 'consistent pipeline without founder involvement',
}

// DB state where the Messaging doc is absent or unapproved (simulates pending revision).
const UNAPPROVED_DB_STATE = {
  prospects: { data: PROSPECT_ROW, error: null },
  segments: { data: null, error: null },
  strategy_documents: { data: null, error: { code: 'PGRST116', message: 'no rows returned' } },
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('compose-sequence — approval gating', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
  })

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    vi.clearAllMocks()
  })

  it('(a) throws when Messaging doc is active but client_approval_status is not approved', async () => {
    setupSupabaseMock(UNAPPROVED_DB_STATE)

    await expect(
      composeSequence({ prospect_id: PROSPECT_ID, client_id: CLIENT_ID }),
    ).rejects.toThrow('no active + approved Messaging document found')
  })

  it('(b) returns a composed sequence when preloadedDocs carries all approved docs', async () => {
    // With preloadedDocs, no strategy_documents queries happen — only prospect fetch.
    setupSupabaseMock({
      prospects: { data: PROSPECT_ROW, error: null },
    })

    const result = await composeSequence({
      prospect_id: PROSPECT_ID,
      client_id: CLIENT_ID,
      preloadedDocs: APPROVED_DOCS,
    })

    expect(result.prospect_id).toBe(PROSPECT_ID)
    expect(result.client_id).toBe(CLIENT_ID)
    expect(result.variant_id).toBe('A')
    expect(result.emails).toHaveLength(
      (MESSAGING_CONTENT.variants!.A!.emails as unknown[]).length,
    )
    // Trigger is applied to email 1 body
    expect(result.emails[0].body).toContain('Just saw your recent funding announcement.')
  })

  it('(c) mid-batch snapshot: composes from snapshot even when DB doc becomes unapproved', async () => {
    // DB is in the "after revision" state: strategy_documents returns nothing.
    // This simulates the race where a client approves a new version mid-batch.
    setupSupabaseMock(UNAPPROVED_DB_STATE)

    // Without snapshot: should fail (proves DB is correctly "empty").
    await expect(
      composeSequence({ prospect_id: PROSPECT_ID, client_id: CLIENT_ID }),
    ).rejects.toThrow('no active + approved Messaging document found')

    // Reset tableConfig for the second call (prospect array entry was consumed).
    setupSupabaseMock(UNAPPROVED_DB_STATE)

    // With snapshot: should succeed — snapshot isolates composition from DB state.
    const result = await composeSequence({
      prospect_id: PROSPECT_ID,
      client_id: CLIENT_ID,
      preloadedDocs: APPROVED_DOCS,
    })

    expect(result.emails).toHaveLength(
      (MESSAGING_CONTENT.variants!.A!.emails as unknown[]).length,
    )
    expect(result.variant_id).toBe('A')
  })
})
