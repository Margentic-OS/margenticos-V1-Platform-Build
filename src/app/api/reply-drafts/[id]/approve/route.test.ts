// The approve route's concurrency guard is real.
//
// THE DEFECT THIS LOCKS OUT, verified against @supabase/postgrest-js 2.103.2.
//
// The route branches on `count === 0` to return 409 when another approval won the race. It
// did not pass { count: 'exact' }. update() appends the 'Prefer: count=' header only
// `if (count)`, so without the option the response carries no count, the client returns
// null, `null === 0` is false, and the 409 branch was UNREACHABLE. Two concurrent approvals
// both fell through to the send.
//
// The .in('status', APPROVABLE_STATUSES) filter was always correct. Nothing was reading its
// result. That is the shape where a guard looks present in review and does nothing.
//
// MUTATION-PROVED: removing { count: 'exact' } from the update turns the 409 test red,
// because the fake only reports a count when the caller asked for one — exactly as
// PostgREST does. A fake that always returned a count would let the mutation pass and would
// be testing its own behaviour rather than the route's.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
  }),
}))

const sendApprovedDraft = vi.hoisted(() =>
  vi.fn(async () => ({ kind: 'sent' as const, instantly_message_id: 'msg-1' }))
)
vi.mock('@/lib/reply-handling/send-approved-draft', () => ({ sendApprovedDraft }))

// What the fake was asked to update, including whether a count was requested.
const state = vi.hoisted(() => ({
  draftStatus: 'manual_required' as string,
  // Rows the UPDATE's own filters would actually match.
  matchingRows: 1,
  updateCalls: [] as Array<{ values: Record<string, unknown>; options: unknown }>,
}))

vi.mock('@supabase/supabase-js', () => ({
  /* eslint-disable @typescript-eslint/no-explicit-any */
  createClient: () => ({
    from(table: string) {
      if (table === 'users') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: { role: 'operator' }, error: null }) }) }),
        }
      }
      if (table === 'reply_drafts') {
        const b: any = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({
            data: { id: 'draft-1', organisation_id: 'org-1', status: state.draftStatus },
            error: null,
          }),
          update: (values: Record<string, unknown>, options?: unknown) => {
            state.updateCalls.push({ values, options })
            const chain: any = {
              eq: () => chain,
              // PostgREST returns a count ONLY when the caller requested one. Modelling that
              // faithfully is the whole point: a fake that always returned a number would
              // make the missing-option bug invisible, which is how it survived review.
              in: async () => ({
                error: null,
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

function approveRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/reply-drafts/draft-1/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const params = Promise.resolve({ id: 'draft-1' })

beforeEach(() => {
  vi.clearAllMocks()
  state.draftStatus = 'manual_required'
  state.matchingRows = 1
  state.updateCalls.length = 0
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
})

describe('POST /api/reply-drafts/[id]/approve', () => {
  it('asks PostgREST for an exact count, without which the guard cannot fire', async () => {
    await POST(approveRequest({ final_body: 'A body the operator wrote.', edited: false }), { params })

    expect(state.updateCalls).toHaveLength(1)
    expect(state.updateCalls[0].options).toEqual({ count: 'exact' })
  })

  it('returns 409 when another approval already moved the draft', async () => {
    // The compare-and-set matched nothing: someone else won between the read and the write.
    state.matchingRows = 0

    const res = await POST(approveRequest({ final_body: 'A body.', edited: false }), { params })

    expect(res.status).toBe(409)
    // And crucially it did NOT send. Falling through to the send is what the missing count
    // option actually caused.
    expect(sendApprovedDraft).not.toHaveBeenCalled()
  })

  it('sends when the compare-and-set wins', async () => {
    const res = await POST(approveRequest({ final_body: 'A body.', edited: false }), { params })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'sent' })
    expect(sendApprovedDraft).toHaveBeenCalledTimes(1)
  })

  it('writes the operator body into ai_draft_body for a manual_required row', async () => {
    // manual_required rows have ai_draft_body NULL, and a NOT NULL constraint applies once
    // the row leaves a placeholder status. The route coalesces it; if it stopped, approving
    // one of these would fail at the database rather than here.
    await POST(approveRequest({ final_body: 'Operator wrote this.', edited: false }), { params })

    expect(state.updateCalls[0].values).toMatchObject({
      status: 'approved',
      final_sent_body: 'Operator wrote this.',
      ai_draft_body: 'Operator wrote this.',
    })
  })

  it('leaves ai_draft_body untouched on a normal pending row', async () => {
    state.draftStatus = 'pending'

    await POST(approveRequest({ final_body: 'Operator edited the AI draft.', edited: true }), { params })

    // The AI draft is the immutable record of what the model produced. Overwriting it would
    // destroy the only evidence of what the operator changed.
    expect(state.updateCalls[0].values).not.toHaveProperty('ai_draft_body')
  })
})
