// The unresearched count, and the proof that adding it did not touch the send gate.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THE FAKES THROW INSTEAD OF RETURNING THE CHAIN
//
// CLAUDE.md records three filters that were silently swallowed by a fake that returned
// `chain` for every method it had not implemented. The tests stayed green in both worlds:
// with the filter and without it. So both fakes below implement exactly eq, not and is,
// and THROW on anything else. If the gate grows a filter these cannot express, these tests
// fail loudly rather than quietly measuring a different query than production runs.

import { describe, it, expect } from 'vitest'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import {
  sendGateCountQuery,
  unresearchedSendGateCountQuery,
  describeUnresearchedOpener,
  describeUnresearchedOnButton,
} from '../unresearched-send-gate'

// ─── Fake 1: records the predicate, so the gate's shape can be compared ──────────

interface FilterCall { method: string; args: unknown[] }

/** Anything not a filter method we implement throws, rather than resolving to the chain. */
function guard<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop, recv) {
      if (prop in t) return Reflect.get(t, prop, recv)
      if (typeof prop === 'symbol') return undefined
      throw new Error(`fake does not implement .${String(prop)}() — the query under test uses it, so this test is not measuring production`)
    },
  })
}

function recordingClient(): { client: ServiceRoleClient; calls: FilterCall[] } {
  const calls: FilterCall[] = []
  const chain: Record<string, unknown> = {}
  const self = guard(chain)
  chain.eq = (c: string, v: unknown) => { calls.push({ method: 'eq', args: [c, v] }); return self }
  chain.not = (c: string, op: string, v: unknown) => { calls.push({ method: 'not', args: [c, op, v] }); return self }
  chain.is = (c: string, v: unknown) => { calls.push({ method: 'is', args: [c, v] }); return self }

  const client = {
    from: (table: string) => ({
      select: (cols: string, opts: unknown) => {
        calls.push({ method: 'from.select', args: [table, cols, opts] })
        return self
      },
    }),
  }
  return { client: client as unknown as ServiceRoleClient, calls }
}

// ─── Fake 2: honours the predicate against rows, so the count can be checked ─────

interface ProspectRow {
  organisation_id: string
  outbound_upload_status: string
  email: string | null
  sourced_tier: string | null
  email_send_eligible: boolean
  client_review_status: string
  suppressed: boolean
  research_ran_at: string | null
}

function countingClient(rows: ProspectRow[]): ServiceRoleClient {
  const makeChain = (predicates: ((r: ProspectRow) => boolean)[]) => {
    const chain: Record<string, unknown> = {}
    const self = guard(chain)
    const add = (p: (r: ProspectRow) => boolean) => {
      predicates.push(p)
      return self
    }
    chain.eq = (c: string, v: unknown) => add(r => (r as unknown as Record<string, unknown>)[c] === v)
    chain.not = (c: string, op: string, v: unknown) => {
      if (op !== 'is' || v !== null) throw new Error(`fake only implements .not(col, 'is', null), got .not(${c}, ${op}, ${String(v)})`)
      return add(r => (r as unknown as Record<string, unknown>)[c] != null)
    }
    chain.is = (c: string, v: unknown) => {
      if (v !== null) throw new Error(`fake only implements .is(col, null)`)
      return add(r => (r as unknown as Record<string, unknown>)[c] == null)
    }
    // Awaiting the builder runs the predicates, the way PostgREST would.
    chain.then = (resolve: (value: { count: number; error: null }) => unknown) =>
      Promise.resolve(resolve({ count: rows.filter(r => predicates.every(p => p(r))).length, error: null }))
    return self
  }

  return {
    from: () => ({ select: () => makeChain([]) }),
  } as unknown as ServiceRoleClient
}

// ─── Fixtures: one sendable population, mixed research state ────────────────────
//
// Deliberately generic. Nothing here names an industry, a revenue band or a company type.

const ORG = 'org-under-test'

function sendable(overrides: Partial<ProspectRow> = {}): ProspectRow {
  return {
    organisation_id: ORG,
    outbound_upload_status: 'pending',
    email: 'contact@example.test',
    sourced_tier: 'tier_1',
    email_send_eligible: true,
    client_review_status: 'approved',
    suppressed: false,
    research_ran_at: '2026-09-17T00:00:00.000Z',
    ...overrides,
  }
}

const NEVER_RESEARCHED = { research_ran_at: null }

describe('unresearched count', () => {
  it('counts only the sendable prospects with no research, against a mixed population', async () => {
    const rows = [
      sendable(),                    // researched, sendable
      sendable(),                    // researched, sendable
      sendable(NEVER_RESEARCHED),    // unresearched, sendable
      sendable(NEVER_RESEARCHED),    // unresearched, sendable
      sendable(NEVER_RESEARCHED),    // unresearched, sendable
    ]
    const pending = await sendGateCountQuery(countingClient(rows), ORG)
    const unresearched = await unresearchedSendGateCountQuery(countingClient(rows), ORG)

    expect(pending.count).toBe(5)
    expect(unresearched.count).toBe(3)
  })

  it('never counts a prospect the send gate itself refuses, however unresearched it is', async () => {
    // Each row below has no research AND fails exactly one gate clause. None may be counted:
    // an operator warned about a prospect that is not going to be sent is being given a
    // number they cannot reconcile with the button beside it.
    const rows = [
      sendable(NEVER_RESEARCHED),                                            // the only countable row
      sendable({ ...NEVER_RESEARCHED, organisation_id: 'other-org' }),       // another client's data
      sendable({ ...NEVER_RESEARCHED, outbound_upload_status: 'uploaded' }), // already sent
      sendable({ ...NEVER_RESEARCHED, email: null }),                        // nothing to send to
      sendable({ ...NEVER_RESEARCHED, sourced_tier: null }),                 // no tier verdict
      sendable({ ...NEVER_RESEARCHED, email_send_eligible: false }),         // undeliverable
      sendable({ ...NEVER_RESEARCHED, client_review_status: 'pending' }),    // client has not approved
      sendable({ ...NEVER_RESEARCHED, suppressed: true }),                   // suppressed
    ]
    const unresearched = await unresearchedSendGateCountQuery(countingClient(rows), ORG)
    expect(unresearched.count).toBe(1)
  })

  it('is zero, not absent, when every sendable prospect has been researched', async () => {
    const rows = [sendable(), sendable()]
    const unresearched = await unresearchedSendGateCountQuery(countingClient(rows), ORG)
    expect(unresearched.count).toBe(0)
  })
})

describe('the send gate itself is unchanged by this work', () => {
  // The frozen predicate, in order. If this literal has to be edited, applySendGate changed,
  // and changing it changes WHICH PROSPECTS ARE UPLOADED, not just what is displayed.
  const FROZEN_SEND_GATE: FilterCall[] = [
    { method: 'from.select', args: ['prospects', 'id', { count: 'exact', head: true }] },
    { method: 'eq',  args: ['organisation_id', ORG] },
    { method: 'eq',  args: ['outbound_upload_status', 'pending'] },
    { method: 'not', args: ['email', 'is', null] },
    { method: 'not', args: ['sourced_tier', 'is', null] },
    { method: 'eq',  args: ['email_send_eligible', true] },
    { method: 'eq',  args: ['client_review_status', 'approved'] },
    { method: 'eq',  args: ['suppressed', false] },
  ]

  it('applies exactly the frozen predicate, byte for byte', () => {
    const { client, calls } = recordingClient()
    sendGateCountQuery(client, ORG)
    expect(JSON.stringify(calls)).toBe(JSON.stringify(FROZEN_SEND_GATE))
  })

  it('adds the research clause AFTER the gate, leaving the gate byte-for-byte identical', () => {
    const { client, calls } = recordingClient()
    unresearchedSendGateCountQuery(client, ORG)

    // The gate prefix is identical to the count the operator compares against...
    expect(JSON.stringify(calls.slice(0, FROZEN_SEND_GATE.length))).toBe(JSON.stringify(FROZEN_SEND_GATE))
    // ...and the research condition is one added clause, not an edit to any existing one.
    expect(calls.slice(FROZEN_SEND_GATE.length)).toEqual([
      { method: 'is', args: ['research_ran_at', null] },
    ])
  })

  it('leaves no research condition inside the gate, so the upload still claims every sendable prospect', () => {
    // This is the DO-NOT that matters most. If a research clause ever migrates into
    // applySendGate, the claim silently shrinks and the operator's own count shrinks with
    // it, so nothing on screen looks wrong. Asserted on the gate query alone.
    const { client, calls } = recordingClient()
    sendGateCountQuery(client, ORG)
    const mentionsResearch = calls.some(c => c.args.some(a => typeof a === 'string' && a.includes('research')))
    expect(mentionsResearch).toBe(false)
  })
})

describe('the sentence the operator reads', () => {
  it('says nothing at all when the count is zero', () => {
    expect(describeUnresearchedOpener(21, 0)).toBeNull()
    expect(describeUnresearchedOnButton(0)).toBeNull()
  })

  it('names the count, the population and the consequence', () => {
    expect(describeUnresearchedOpener(21, 18)).toBe(
      '18 of these 21 have never been researched. They will send your standard opening line, not one written for each person.',
    )
  })

  it('reads as English when only one prospect is affected', () => {
    expect(describeUnresearchedOpener(3, 1)).toBe(
      '1 of these 3 has never been researched. It will send your standard opening line, not one written for that person.',
    )
    expect(describeUnresearchedOnButton(1)).toBe('1 with your standard opener')
  })

  it('carries the same fact onto the button', () => {
    expect(describeUnresearchedOnButton(18)).toBe('18 with your standard opener')
  })

  it('says nothing when the whole population is unresearched but empty', () => {
    expect(describeUnresearchedOpener(0, 0)).toBeNull()
  })
})
