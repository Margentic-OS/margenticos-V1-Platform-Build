// The reject route, which had no test file at all while its sibling approve route did.
//
// THE DEFECT THIS LOCKS OUT is the one the approve route carried until PR #65 and this
// route carries the fix for: the 409 guard branches on `count === 0`, and postgrest-js
// appends the `Prefer: count=` header only `if (count)`. Without { count: 'exact' } the
// response carries no count, the client returns null, `null === 0` is false, and the
// branch is UNREACHABLE. Measured against the test project 2026-09-05: without the
// option `content-range: */*`, with it `*/0`.
//
// The .in('status', REJECTABLE_STATUSES) filter is correct either way. Nothing would be
// reading its result. That is the shape where a guard looks present in review and does
// nothing at all.
//
// The fake therefore reports a count ONLY when the caller asked for one, exactly as
// PostgREST does. A fake that always returned a number would let the mutation pass and
// would be testing its own behaviour rather than the route's.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

const state = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  role: 'operator' as string,
  roleRowMissing: false,
  draftStatus: 'pending' as string,
  draftMetadata: null as Record<string, unknown> | null,
  draftMissing: false,
  // Rows the UPDATE's own filters would actually match.
  matchingRows: 1,
  updateError: null as { message: string } | null,
  updateCalls: [] as Array<{ values: Record<string, unknown>; options: unknown }>,
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => state.user
        ? { data: { user: state.user }, error: null }
        : { data: { user: null }, error: { message: 'no session' } },
    },
  }),
}))

vi.mock('@supabase/supabase-js', () => ({
  /* eslint-disable @typescript-eslint/no-explicit-any */
  createClient: () => ({
    from(table: string) {
      if (table === 'users') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => state.roleRowMissing
                ? { data: null, error: { message: 'no row' } }
                : { data: { role: state.role }, error: null },
            }),
          }),
        }
      }
      if (table === 'reply_drafts') {
        const b: any = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => state.draftMissing
            ? { data: null, error: null }
            : {
                data: {
                  id: 'draft-1',
                  organisation_id: 'org-1',
                  status: state.draftStatus,
                  draft_metadata: state.draftMetadata,
                },
                error: null,
              },
          update: (values: Record<string, unknown>, options?: unknown) => {
            state.updateCalls.push({ values, options })
            const chain: any = {
              eq: () => chain,
              in: async () => ({
                error: state.updateError,
                count: (options as { count?: string } | undefined)?.count === 'exact'
                  ? state.matchingRows
                  : null,
              }),
            }
            return chain
          },
        }
        return b
      }
      throw new Error(`fake supabase: unexpected table ${table}`)
    },
  }),
  /* eslint-enable @typescript-eslint/no-explicit-any */
}))

import { POST } from './route'

function rejectRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/reply-drafts/draft-1/reject', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const params = Promise.resolve({ id: 'draft-1' })

beforeEach(() => {
  vi.clearAllMocks()
  state.user = { id: 'user-1' }
  state.role = 'operator'
  state.roleRowMissing = false
  state.draftStatus = 'pending'
  state.draftMetadata = null
  state.draftMissing = false
  state.matchingRows = 1
  state.updateError = null
  state.updateCalls.length = 0
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
})

describe('POST /api/reply-drafts/[id]/reject', () => {
  it('asks PostgREST for an exact count, without which the guard cannot fire', async () => {
    await POST(rejectRequest({}), { params })

    expect(state.updateCalls).toHaveLength(1)
    expect(state.updateCalls[0].options).toEqual({ count: 'exact' })
  })

  it('rejects a pending draft', async () => {
    const res = await POST(rejectRequest({}), { params })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'rejected' })
    expect(state.updateCalls[0].values.status).toBe('rejected')
    expect(state.updateCalls[0].values.reviewed_by_user_id).toBe('user-1')
  })

  it('returns 409 when another reject already moved the draft', async () => {
    // The row was rejectable when it was read and is not by the time the UPDATE lands.
    // Only the count can report this; the read above has already succeeded.
    state.matchingRows = 0

    const res = await POST(rejectRequest({}), { params })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/changed between check and update/i)
  })

  // ── The statuses the triage queue actually serves ──────────────────────────
  // A row with no draft body is rejectable: manual_required and draft_failed mean no
  // draft was ever produced, and send_failed means the operator is dismissing a row they
  // will handle outside the platform.
  for (const status of ['pending', 'manual_required', 'draft_failed', 'send_failed']) {
    it(`rejects a '${status}' draft, which the triage queue serves`, async () => {
      state.draftStatus = status
      const res = await POST(rejectRequest({}), { params })
      expect(res.status).toBe(200)
    })
  }

  it('refuses a draft that is already rejected, naming the status it found', async () => {
    state.draftStatus = 'rejected'
    const res = await POST(rejectRequest({}), { params })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('rejected')
    // And it never reached the write.
    expect(state.updateCalls).toHaveLength(0)
  })

  // ── The optional reason ────────────────────────────────────────────────────
  it('stores a trimmed reason in draft_metadata, preserving what was already there', async () => {
    state.draftMetadata = { drafter_model: 'a-model' }
    await POST(rejectRequest({ reason: '  off topic  ' }), { params })

    expect(state.updateCalls[0].values.draft_metadata).toEqual({
      drafter_model: 'a-model',
      rejection_reason: 'off topic',
    })
  })

  it('leaves existing metadata untouched when no reason is given', async () => {
    state.draftMetadata = { drafter_model: 'a-model' }
    await POST(rejectRequest({}), { params })
    expect(state.updateCalls[0].values.draft_metadata).toEqual({ drafter_model: 'a-model' })
  })

  it('treats a whitespace-only reason as no reason, not as an empty string', async () => {
    state.draftMetadata = { drafter_model: 'a-model' }
    await POST(rejectRequest({ reason: '   ' }), { params })
    // Storing rejection_reason: '' would record that a reason was given when none was.
    expect(state.updateCalls[0].values.draft_metadata).toEqual({ drafter_model: 'a-model' })
  })

  it('ignores a non-string reason rather than storing it', async () => {
    await POST(rejectRequest({ reason: { note: 'nope' } }), { params })
    expect(state.updateCalls[0].values.draft_metadata).toBeNull()
  })

  // ── The three auth checks, each proved to be load-bearing ──────────────────
  it('401s with no session, and never reaches the write', async () => {
    state.user = null
    const res = await POST(rejectRequest({}), { params })
    expect(res.status).toBe(401)
    expect(state.updateCalls).toHaveLength(0)
  })

  it('403s a non-operator, and never reaches the write', async () => {
    state.role = 'client'
    const res = await POST(rejectRequest({}), { params })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/only operators/i)
    expect(state.updateCalls).toHaveLength(0)
  })

  it('403s with a DIFFERENT message when the role row cannot be read', async () => {
    // Distinct from the refusal above on purpose: the screens surface whichever the route
    // sends, and a failed lookup is not a permissions verdict.
    state.roleRowMissing = true
    const res = await POST(rejectRequest({}), { params })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/could not verify user role/i)
  })

  it('404s when the draft does not exist', async () => {
    state.draftMissing = true
    const res = await POST(rejectRequest({}), { params })
    expect(res.status).toBe(404)
    expect(state.updateCalls).toHaveLength(0)
  })

  it('500s when the update itself errors, and does not report success', async () => {
    state.updateError = { message: 'connection reset' }
    const res = await POST(rejectRequest({}), { params })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/failed to reject/i)
  })

  it('400s without an id', async () => {
    const res = await POST(rejectRequest({}), { params: Promise.resolve({ id: '' }) })
    expect(res.status).toBe(400)
  })
})
