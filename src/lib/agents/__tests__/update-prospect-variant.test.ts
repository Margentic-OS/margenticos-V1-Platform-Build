// What updateProspect WRITES about the variant, against a fake database client.
//
// The collect caller is tested to PASS the variant a prospect is leaving, on its main path
// (research-collect-snapshot.test.ts). The inline caller's argument and the collect path's
// not-mailable branch have no test of their own. This is the other half of that join: that
// the write puts it on the row, beside the new variant, and puts nothing there when there is
// nothing to record. The fake implements the one chain
// updateProspect uses and throws on any other call.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const updates: Array<{ table: string; payload: Record<string, unknown>; filters: Array<[string, unknown]> }> = []

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      update: (payload: Record<string, unknown>) => {
        const filters: Array<[string, unknown]> = []
        const chain = {
          eq: (column: string, value: unknown) => {
            filters.push([column, value])
            return chain
          },
          then: (resolve: (v: { error: null }) => void) => {
            updates.push({ table, payload, filters })
            resolve({ error: null })
          },
        }
        return chain
      },
      select: () => { throw new Error('fake does not implement select') },
      insert: () => { throw new Error('fake does not implement insert') },
    }),
  }),
}))

import { updateProspect } from '../prospect-research-agent-v2'

const CTX = { id: 'p-1', organisation_id: 'org-1' } as unknown as Parameters<typeof updateProspect>[0]
const SYNTHESIS = {
  icp_fit: 'strong', has_dateable_signal: false, signal_observation: null,
  qualification_status: 'qualified', qualification_reason: null, confidence: 'high',
} as unknown as Parameters<typeof updateProspect>[1]
const OPENING = { written_won: false, opening: null, question: null, subject: null } as unknown as Parameters<typeof updateProspect>[3]

beforeEach(() => {
  updates.length = 0
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
})

describe('updateProspect and the variant', () => {
  it('writes the chosen variant and, beside it, the variant the prospect left', async () => {
    await updateProspect(CTX, SYNTHESIS, 'rr-1', OPENING, null, null, 'B', 'D')
    expect(updates).toHaveLength(1)
    const { table, payload, filters } = updates[0]
    expect(table).toBe('prospects')
    expect(filters).toEqual([['id', 'p-1'], ['organisation_id', 'org-1']])
    expect(payload.variant_id).toBe('B')
    expect(payload.variant_reassigned_from).toBe('D')
    expect(typeof payload.variant_reassigned_at).toBe('string')
  })
  it('writes the variant alone when the prospect left nothing behind', async () => {
    await updateProspect(CTX, SYNTHESIS, 'rr-1', OPENING, null, null, 'B', null)
    expect(updates[0].payload.variant_id).toBe('B')
    expect(updates[0].payload).not.toHaveProperty('variant_reassigned_from')
    expect(updates[0].payload).not.toHaveProperty('variant_reassigned_at')
  })
  it('records no move when this run chose no variant', async () => {
    // A reassignment with no new variant is not a reassignment: nothing may be written.
    await updateProspect(CTX, SYNTHESIS, 'rr-1', OPENING, null, null, null, 'D')
    expect(updates[0].payload).not.toHaveProperty('variant_id')
    expect(updates[0].payload).not.toHaveProperty('variant_reassigned_from')
  })
})
