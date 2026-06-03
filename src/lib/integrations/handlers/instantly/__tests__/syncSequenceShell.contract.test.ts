// Contract tests for syncSequenceShell() — verifies PATCH request shape, feature flag guard,
// and structural coherence blocks (Addendum-1 and Addendum-3 rules).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { syncSequenceShell } from '../syncSequenceShell'
import type { ShellSyncInput } from '../syncSequenceShell'
import type { MessagingContent } from '@/lib/composition/compose-sequence'
import * as auth from '../auth'

vi.mock('../auth', () => ({
  getInstantlyApiKey: vi.fn().mockResolvedValue('test-api-key'),
  getInstantlyApiActive: vi.fn().mockResolvedValue(true),
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// ─── Supabase mock ─────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'
vi.mock('@supabase/supabase-js')

type MockResult = { data: unknown; error: unknown; count?: number | null }

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

function setupSupabaseMock(tableConfig: Record<string, MockResult | MockResult[]>) {
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

const ORG_ID = 'org-test-123'
const CAMPAIGN_EXTERNAL_ID = 'cmp-ext-456'
const CAMPAIGN_INTERNAL_ID = 'cmp-int-789'
const MESSAGING_DOC_ID = 'doc-msg-abc'
const MOCK_BASE_URL = 'https://developer.instantly.ai/_mock/api/v2'

const TWO_STEP_MESSAGING: MessagingContent = {
  variants: {
    A: {
      emails: [
        { sequence_position: 1, subject_line: 'Quick question', subject_char_count: 13, body: 'Email 1 body', word_count: 3 },
        { sequence_position: 2, subject_line: null, subject_char_count: 0, body: 'Follow up body', word_count: 3 },
      ],
    },
  },
}

const THREE_STEP_MESSAGING: MessagingContent = {
  variants: {
    A: {
      emails: [
        { sequence_position: 1, subject_line: 'Quick question', subject_char_count: 13, body: 'Email 1', word_count: 2 },
        { sequence_position: 2, subject_line: null, subject_char_count: 0, body: 'Email 2', word_count: 2 },
        { sequence_position: 3, subject_line: null, subject_char_count: 0, body: 'Email 3', word_count: 2 },
      ],
    },
  },
}

const BASE_INPUT: ShellSyncInput = {
  organisationId: ORG_ID,
  campaignExternalId: CAMPAIGN_EXTERNAL_ID,
  campaignInternalId: CAMPAIGN_INTERNAL_ID,
  segmentId: null,
  messagingDoc: TWO_STEP_MESSAGING,
  messagingDocId: MESSAGING_DOC_ID,
}

const PATCH_SUCCESS_BODY = { id: CAMPAIGN_EXTERNAL_ID, updated_at: '2026-06-03T10:00:00Z' }

function makeFetchSpy(status: number, body: unknown) {
  return vi.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

// DB state for a campaign with no existing shell (first sync).
const NO_EXISTING_SHELL_DB = {
  campaigns: { data: { shell_step_count: null }, error: null },
  prospects: { data: null, error: null, count: 0 },
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('syncSequenceShell — PATCH request shape', () => {
  beforeEach(() => {
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    setupSupabaseMock({
      campaigns: [
        { data: { shell_step_count: null }, error: null },   // campaigns select
        { data: null, error: null },                          // campaigns update
      ],
    })
  })

  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    vi.restoreAllMocks()
  })

  it('sends a PATCH (not POST or PUT) to /campaigns/{id}', async () => {
    const fetchSpy = makeFetchSpy(200, PATCH_SUCCESS_BODY)
    await syncSequenceShell(BASE_INPUT)
    const [url, options] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe(`${MOCK_BASE_URL}/campaigns/${CAMPAIGN_EXTERNAL_ID}`)
    expect(options?.method).toBe('PATCH')
  })

  it('PATCH body contains ONLY the sequences field — no other campaign fields', async () => {
    const fetchSpy = makeFetchSpy(200, PATCH_SUCCESS_BODY)
    await syncSequenceShell(BASE_INPUT)
    const [, options] = fetchSpy.mock.calls[0]
    const body = JSON.parse(options?.body as string)
    expect(Object.keys(body)).toEqual(['sequences'])
  })

  it('sequences contain one entry per step with {{m_subject_N}} and {{m_body_N}} variables', async () => {
    const fetchSpy = makeFetchSpy(200, PATCH_SUCCESS_BODY)
    await syncSequenceShell(BASE_INPUT)
    const [, options] = fetchSpy.mock.calls[0]
    const body = JSON.parse(options?.body as string)
    const steps = body.sequences[0].steps

    expect(steps).toHaveLength(2)  // TWO_STEP_MESSAGING has 2 emails
    expect(steps[0].variants[0].subject).toBe('{{m_subject_1}}')
    expect(steps[0].variants[0].body).toBe('<p>{{m_body_1}}</p>')
    expect(steps[1].variants[0].subject).toBe('{{m_subject_2}}')
    expect(steps[1].variants[0].body).toBe('<p>{{m_body_2}}</p>')
  })

  it('step count matches the Messaging doc email count', async () => {
    makeFetchSpy(200, PATCH_SUCCESS_BODY)
    const result = await syncSequenceShell(BASE_INPUT)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.stepCount).toBe(2)
  })

  it('step 1 has delay=0, step 2 has delay=3 (default cold-email schedule)', async () => {
    const fetchSpy = makeFetchSpy(200, PATCH_SUCCESS_BODY)
    await syncSequenceShell(BASE_INPUT)
    const [, options] = fetchSpy.mock.calls[0]
    const steps = JSON.parse(options?.body as string).sequences[0].steps
    expect(steps[0].delay).toBe(0)
    expect(steps[0].delay_unit).toBe('days')
    expect(steps[1].delay).toBe(3)
    expect(steps[1].delay_unit).toBe('days')
  })

  it('all steps have type=email and enabled=true', async () => {
    const fetchSpy = makeFetchSpy(200, PATCH_SUCCESS_BODY)
    await syncSequenceShell({ ...BASE_INPUT, messagingDoc: THREE_STEP_MESSAGING })
    const [, options] = fetchSpy.mock.calls[0]
    const steps = JSON.parse(options?.body as string).sequences[0].steps
    for (const step of steps) {
      expect(step.type).toBe('email')
      expect(step.enabled).toBe(true)
    }
  })

  it('sends Authorization Bearer header', async () => {
    const fetchSpy = makeFetchSpy(200, PATCH_SUCCESS_BODY)
    await syncSequenceShell(BASE_INPUT)
    const [, options] = fetchSpy.mock.calls[0]
    const headers = options?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-api-key')
  })
})

describe('syncSequenceShell — feature flag guard', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
  })

  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    vi.restoreAllMocks()
  })

  it('returns flag_disabled when instantly_api_active=false and URL is production', async () => {
    vi.mocked(auth.getInstantlyApiActive).mockResolvedValue(false)
    process.env.INSTANTLY_API_BASE_URL = 'https://api.instantly.ai/api/v2'

    const result = await syncSequenceShell(BASE_INPUT)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('flag_disabled')
  })

  it('proceeds when instantly_api_active=false and URL is mock (not production)', async () => {
    vi.mocked(auth.getInstantlyApiActive).mockResolvedValue(false)
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL

    setupSupabaseMock({
      campaigns: [
        { data: { shell_step_count: null }, error: null },
        { data: null, error: null },
      ],
    })
    makeFetchSpy(200, PATCH_SUCCESS_BODY)

    const result = await syncSequenceShell(BASE_INPUT)
    expect(result.ok).toBe(true)
  })
})

describe('syncSequenceShell — structural coherence (Addendum-3)', () => {
  beforeEach(() => {
    process.env.INSTANTLY_API_BASE_URL = MOCK_BASE_URL
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
    vi.mocked(auth.getInstantlyApiActive).mockResolvedValue(true)
  })

  afterEach(() => {
    delete process.env.INSTANTLY_API_BASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    vi.restoreAllMocks()
  })

  it('blocks re-sync when step count changes and uploaded leads exist', async () => {
    // Campaign already has a 2-step shell; Messaging doc now has 3 steps.
    setupSupabaseMock({
      campaigns: { data: { shell_step_count: 2 }, error: null },
      prospects: { data: null, error: null, count: 10 },  // 10 uploaded leads
    })

    const result = await syncSequenceShell({
      ...BASE_INPUT,
      messagingDoc: THREE_STEP_MESSAGING,
    })

    expect(result.ok).toBe(false)
    if (!result.ok && result.reason === 'uploaded_leads_structure_change') {
      expect(result.stepCount).toBe(3)
      expect(result.existingStepCount).toBe(2)
    } else {
      expect(result.ok).toBe(false)  // fail clearly if wrong reason
    }
  })

  it('allows re-sync when step count changes but zero uploaded leads', async () => {
    // Campaign has 2-step shell; doc now has 3 steps; no leads uploaded yet.
    setupSupabaseMock({
      campaigns: [
        { data: { shell_step_count: 2 }, error: null },   // select
        { data: null, error: null },                        // update
      ],
      prospects: { data: null, error: null, count: 0 },
    })
    makeFetchSpy(200, PATCH_SUCCESS_BODY)

    const result = await syncSequenceShell({
      ...BASE_INPUT,
      messagingDoc: THREE_STEP_MESSAGING,
    })

    expect(result.ok).toBe(true)
  })

  it('allows re-sync when step count is unchanged (copy-only revision)', async () => {
    // Same step count, no coherence check needed at all.
    setupSupabaseMock({
      campaigns: [
        { data: { shell_step_count: 2 }, error: null },   // select returns matching count
        { data: null, error: null },                        // update
      ],
    })
    makeFetchSpy(200, PATCH_SUCCESS_BODY)

    const result = await syncSequenceShell(BASE_INPUT)  // TWO_STEP_MESSAGING = 2 steps

    expect(result.ok).toBe(true)
  })

  it('allows first sync when no shell exists (shell_step_count is null)', async () => {
    setupSupabaseMock({
      campaigns: [
        { data: { shell_step_count: null }, error: null },
        { data: null, error: null },
      ],
    })
    makeFetchSpy(200, PATCH_SUCCESS_BODY)

    const result = await syncSequenceShell(BASE_INPUT)
    expect(result.ok).toBe(true)
  })
})
