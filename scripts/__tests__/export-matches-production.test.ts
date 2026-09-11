// THE EXPORT SKIPS WHO PRODUCTION SKIPS, AND RESOLVES THE SEGMENT PRODUCTION RESOLVES.
// Added 2026-09-11.
//
// Until then the export wrote for a suppressed prospect (#29 of the pinned 41, operator_stop)
// in every run, and in unpinned mode briefed the writer against the segment the prospect row
// happened to hold, which is null for every prospect that bypassed the sourcing path, while
// the agent resolves the organisation's default first.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { mailabilityForResearch } from '../export-writer-run'
import { resolveSegmentId } from '@/lib/agents/research/prospect-context'
import { checkResearchEligibility } from '@/lib/sourcing/send-eligibility-policy'
import type { SupabaseClient } from '@supabase/supabase-js'

// The policy's own "verified and valid" shape, from send-eligibility-policy.test.ts.
const ELIGIBLE = {
  independent_verified_at: '2026-08-10T12:00:00Z',
  independent_email_status: 'Valid',
  email_send_ineligible_reason: null,
  verification_provider: null,
  second_pass_status: null,
  second_pass_provider: null,
}

describe('mailabilityForResearch: production does not write for a prospect it cannot mail', () => {
  it('precondition: the fixture is one the policy itself calls eligible', () => {
    expect(checkResearchEligibility(ELIGIBLE).eligible).toBe(true)
  })

  it('writes for an eligible, unsuppressed prospect', () => {
    expect(mailabilityForResearch({ suppressed: false, ...ELIGIBLE })).toEqual({ mailable: true })
  })

  it('skips a suppressed prospect even when its email is eligible', () => {
    expect(mailabilityForResearch({ suppressed: true, ...ELIGIBLE })).toEqual({ mailable: false, reason: 'suppressed' })
  })

  it('skips a prospect the policy rejects, with the policy\'s own reason', () => {
    expect(mailabilityForResearch({ suppressed: false, ...ELIGIBLE, independent_verified_at: null }))
      .toEqual({ mailable: false, reason: 'no_verdict' })
  })
})

describe('resolveSegmentId: the rule loadProspectContext uses, without the write', () => {
  // A fake that honours exactly the calls the rule makes and THROWS on anything else, so an
  // added filter or a write cannot pass silently. The eq filters are recorded and asserted.
  function fake(defaultId: string | null) {
    const eqs: Array<[string, unknown]> = []
    const chain = {
      select: (cols: string) => { expect(cols).toBe('id'); return chain },
      eq: (col: string, val: unknown) => { eqs.push([col, val]); return chain },
      single: async () => ({ data: defaultId ? { id: defaultId } : null, error: null }),
    }
    const client = {
      from: (table: string) => {
        expect(table).toBe('segments')
        return new Proxy(chain, { get: (t, p) => { if (!(p in t)) throw new Error(`fake does not implement ${String(p)}`); return t[p as keyof typeof t] } })
      },
    }
    return { client: client as unknown as SupabaseClient, eqs }
  }

  it('keeps the prospect\'s own segment and makes no query', async () => {
    const { client, eqs } = fake('seg-default')
    expect(await resolveSegmentId(client, 'seg-own', 'org-1')).toBe('seg-own')
    expect(eqs).toEqual([])
  })

  it('falls back to the organisation\'s default segment', async () => {
    const { client, eqs } = fake('seg-default')
    expect(await resolveSegmentId(client, null, 'org-1')).toBe('seg-default')
    expect(eqs).toEqual([['organisation_id', 'org-1'], ['is_default', true]])
  })
})
