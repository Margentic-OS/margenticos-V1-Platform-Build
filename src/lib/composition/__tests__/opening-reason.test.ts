// A personalised Email 1 is sent only if it was held to one of the client's approved
// trigger reasons as they read today (operator note 5; ADR-065, amended).
//
// The verdict is pure. Every way it can hold is planted, and every way it must NOT hold is
// a control: a rule that held everything would pass the planted cases alone.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect } from 'vitest'
import { describeReasonHold, loadTriggersChecked, openingReasonVerdict, OPENING_WITHOUT_APPROVED_REASON } from '../opening-reason'

const REASON = 'New equipment has to be kept busy, so more work has to be won.'
const TRIGGERS = [
  { trigger: 'Added equipment', reason: REASON },
  { trigger: 'Won an award', reason: '' },
]
const judge = (approved_reason?: unknown) => ({ bridge: 'A line.', ...(approved_reason === undefined ? {} : { approved_reason }) })

describe('openingReasonVerdict', () => {
  it('control: an opening held to a reason the client still has is sent', () => {
    expect(openingReasonVerdict({ tier: 'research', judge: judge({ state: 'approved', reason: REASON }), triggers: TRIGGERS }))
      .toEqual({ ok: true, why: 'held_to_a_current_reason', reason: REASON })
    // Whitespace around either copy of the sentence is not a difference.
    expect(openingReasonVerdict({ tier: 'research', judge: judge({ state: 'approved', reason: ` ${REASON} ` }), triggers: TRIGGERS }).ok).toBe(true)
  })

  it('PLANTED: an opening with no record of what it was held to was written before the rule', () => {
    expect(openingReasonVerdict({ tier: 'research', judge: judge(), triggers: TRIGGERS })).toEqual({ ok: false, why: 'written_before_the_rule' })
    expect(openingReasonVerdict({ tier: 'research', judge: null, triggers: TRIGGERS })).toEqual({ ok: false, why: 'written_before_the_rule' })
    expect(openingReasonVerdict({ tier: 'research', judge: 'not an object', triggers: TRIGGERS })).toEqual({ ok: false, why: 'written_before_the_rule' })
  })

  it('PLANTED: held to a reason the client has since reworded or removed', () => {
    expect(openingReasonVerdict({ tier: 'research', judge: judge({ state: 'approved', reason: 'The old wording.' }), triggers: TRIGGERS }))
      .toEqual({ ok: false, why: 'reason_since_changed' })
    expect(openingReasonVerdict({ tier: 'research', judge: judge({ state: 'approved', reason: '' }), triggers: TRIGGERS }))
      .toEqual({ ok: false, why: 'reason_since_changed' })
  })

  it('PLANTED: written when the client had no approved reasons, and it has some now', () => {
    expect(openingReasonVerdict({ tier: 'research', judge: judge({ state: 'not_checked', why: 'no_trigger_has_a_reason' }), triggers: TRIGGERS }))
      .toEqual({ ok: false, why: 'not_held_to_a_reason' })
  })

  it('a client with no approved reason on any trigger is not held to one (control)', () => {
    const none = [{ trigger: 'Added equipment', reason: '' }, { trigger: 'Won an award', reason: '  ' }]
    expect(openingReasonVerdict({ tier: 'research', judge: judge(), triggers: none })).toEqual({ ok: true, why: 'client_has_no_approved_reasons' })
    expect(openingReasonVerdict({ tier: 'research', judge: null, triggers: [] })).toEqual({ ok: true, why: 'client_has_no_approved_reasons' })
  })

  it('only the research tier is asked (control)', () => {
    for (const tier of ['firm_fact', 'template'] as const) {
      expect(openingReasonVerdict({ tier, judge: null, triggers: TRIGGERS })).toEqual({ ok: true, why: 'not_personalised' })
    }
  })

  it('the sentence on the row names the code and the remedy, and never the backfill as one', () => {
    const text = describeReasonHold({ ok: false, why: 'written_before_the_rule' })
    expect(text.startsWith(`${OPENING_WITHOUT_APPROVED_REASON}: `)).toBe(true)
    expect(text).toContain('run this prospect\'s research again')
    expect(text).toContain('The follow-up backfill cannot fix this')
  })
})

// A FAKE THAT HONOURS EVERY FILTER THE READ APPLIES, and throws on any it does not know.
function fakeSupabase(opts: { segments?: unknown; segmentsError?: string; docs?: unknown[]; docsError?: string }) {
  const seen: Array<{ table: string; filters: Record<string, unknown> }> = []
  const from = (table: string) => {
    const filters: Record<string, unknown> = {}
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (column: string, value: unknown) => { filters[column] = value; return chain },
      order: () => chain,
      maybeSingle: async () => {
        seen.push({ table, filters })
        return opts.segmentsError ? { data: null, error: { message: opts.segmentsError } } : { data: opts.segments ?? null, error: null }
      },
      then: (resolve: (v: unknown) => void) => {
        seen.push({ table, filters })
        if (table !== 'strategy_documents') throw new Error(`fake: unexpected awaited read of ${table}`)
        const rows = (opts.docs ?? []) as Array<Record<string, unknown>>
        const kept = rows.filter(r => Object.entries(filters).every(([k, v]) => r[k] === undefined || r[k] === v))
        resolve(opts.docsError ? { data: null, error: { message: opts.docsError } } : { data: kept, error: null })
      },
    }
    return new Proxy(chain, {
      get(target, prop) {
        if (prop in target) return target[prop as string]
        throw new Error(`fake supabase does not implement ${String(prop)}`)
      },
    })
  }
  return { client: { from } as never, seen }
}

const icp = (segment_id: string | null, triggers: unknown[], over: Record<string, unknown> = {}) =>
  ({ organisation_id: 'org1', status: 'active', document_type: 'icp', segment_id, content: { tier_1: { triggers } }, ...over })

describe('loadTriggersChecked', () => {
  it('reads the ICP for the segment, both trigger shapes, and drops an empty trigger', async () => {
    const { client } = fakeSupabase({ docs: [icp('seg-2', ['Other']), icp('seg-1', [{ trigger: 'Added equipment', reason: ` ${REASON} ` }, 'Won an award', { trigger: ' ' }])] })
    expect(await loadTriggersChecked(client, 'org1', 'seg-1')).toEqual({
      ok: true, triggers: [{ trigger: 'Added equipment', reason: REASON }, { trigger: 'Won an award', reason: '' }],
    })
  })

  it('PLANTED: a failed documents read is a FAILURE, never "no approved reasons"', async () => {
    const { client } = fakeSupabase({ docsError: 'gateway timeout' })
    const read = await loadTriggersChecked(client, 'org1', 'seg-1')
    expect(read.ok).toBe(false)
    expect(read).toMatchObject({ error: expect.stringContaining('gateway timeout') })
  })

  it('PLANTED: a failed segment read is a failure too', async () => {
    const { client } = fakeSupabase({ segmentsError: 'gateway timeout', docs: [icp('seg-1', ['x'])] })
    expect((await loadTriggersChecked(client, 'org1', null)).ok).toBe(false)
  })

  it('PLANTED: only this organisation\'s ACTIVE ICP is read', async () => {
    const { client, seen } = fakeSupabase({ docs: [
      icp('seg-1', [{ trigger: 'Another client', reason: 'Not ours.' }], { organisation_id: 'org2' }),
      icp('seg-1', [{ trigger: 'Superseded', reason: 'Old.' }], { status: 'superseded' }),
      icp('seg-1', [{ trigger: 'Added equipment', reason: REASON }]),
    ] })
    const read = await loadTriggersChecked(client, 'org1', 'seg-1')
    expect(read).toEqual({ ok: true, triggers: [{ trigger: 'Added equipment', reason: REASON }] })
    expect(seen.find(s => s.table === 'strategy_documents')?.filters).toEqual({ organisation_id: 'org1', status: 'active', document_type: 'icp' })
  })

  it('a prospect with no segment uses the default segment\'s ICP', async () => {
    const { client } = fakeSupabase({ segments: { id: 'seg-1' }, docs: [icp('seg-2', ['Other']), icp('seg-1', [{ trigger: 'Added equipment', reason: REASON }])] })
    expect(await loadTriggersChecked(client, 'org1', null)).toEqual({ ok: true, triggers: [{ trigger: 'Added equipment', reason: REASON }] })
  })

  it('no ICP at all is an empty list, which is a client with no approved reasons', async () => {
    const { client } = fakeSupabase({ docs: [] })
    expect(await loadTriggersChecked(client, 'org1', 'seg-1')).toEqual({ ok: true, triggers: [] })
  })
})
