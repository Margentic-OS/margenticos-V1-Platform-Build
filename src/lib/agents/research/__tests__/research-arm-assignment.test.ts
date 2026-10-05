// The research arm's life in the database: assigned once, before research, stored once, never
// redrawn, held and released by batch, and standard whenever the split is not ready.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THE FAKE THROWS ON EVERYTHING IT DOES NOT IMPLEMENT
//
// CLAUDE.md records three filters that a fake silently swallowed, so the suite stayed green with them
// removed. The fake below implements exactly the filters these functions use (select, eq, in, is,
// update, maybeSingle) and throws on anything else. It also RECORDS every write with its filters, so a
// test can assert that a write was conditional (`is research_arm null`), which is the "stored once"
// property, rather than asserting only the final value.

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { drawResearchArm, balancedArmPlan, armOf } from '../research-arm'
import {
  assignResearchArms,
  readStoredArm,
  releaseShortReasoningBatch,
  settleInlineArm,
} from '../research-arm-store'

type Row = Record<string, unknown>
type Filter = { op: 'eq' | 'in' | 'is'; col: string; value: unknown }
interface WriteRecord { table: string; patch: Row; filters: Filter[] }

interface FakeOptions {
  failRead?: string[]
  failWrite?: string[]
}

/** An in-memory stand-in for the one client these functions use. Throws on anything else. */
function fakeDb(tables: Record<string, Row[]>, options: FakeOptions = {}) {
  const writes: WriteRecord[] = []

  function from(table: string) {
    const filters: Filter[] = []
    let patch: Row | null = null

    const matches = (row: Row) => filters.every(f => {
      const actual = row[f.col] ?? null
      if (f.op === 'eq') return actual === f.value
      if (f.op === 'is') return actual === f.value
      return (f.value as unknown[]).includes(actual)
    })

    const run = (single: boolean) => {
      const rows = (tables[table] ?? []).filter(matches)
      if (patch !== null) {
        if (options.failWrite?.includes(table)) return Promise.resolve({ data: null, error: { message: `write to ${table} failed` } })
        for (const row of rows) Object.assign(row, patch)
        writes.push({ table, patch: { ...patch }, filters: [...filters] })
        return Promise.resolve({ data: rows.map(r => ({ id: r.id })), error: null })
      }
      if (options.failRead?.includes(table)) return Promise.resolve({ data: null, error: { message: `read of ${table} failed` } })
      return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null })
    }

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, value: unknown) => { filters.push({ op: 'eq', col, value }); return builder },
      in: (col: string, value: unknown[]) => { filters.push({ op: 'in', col, value }); return builder },
      is: (col: string, value: unknown) => { filters.push({ op: 'is', col, value }); return builder },
      update: (p: Row) => { patch = p; return builder },
      maybeSingle: () => run(true),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run(false).then(resolve, reject),
    }
    return new Proxy(builder, {
      get(target, prop) {
        if (prop in target) return target[prop as keyof typeof target]
        if (typeof prop === 'symbol') return undefined
        throw new Error(`fake does not implement .${String(prop)}() — the research-arm code uses it, so this test is not measuring production`)
      },
    })
  }

  return { client: { from } as unknown as SupabaseClient, writes, tables }
}

const ORG = 'org-1'
const sequence = (values: number[]) => {
  let i = 0
  return () => values[i++ % values.length]
}

function prospect(id: string, extra: Row = {}): Row {
  return { id, organisation_id: ORG, research_arm: null, research_arm_released_at: null, ...extra }
}

describe('research arm: the draw', () => {
  it('a draw below one half is the short arm, and one half or above is standard', () => {
    expect(drawResearchArm(() => 0.49)).toBe('short_reasoning')
    expect(drawResearchArm(() => 0.5)).toBe('standard')
    expect(drawResearchArm(() => 0.99)).toBe('standard')
  })

  it('the balanced plan puts exactly half of six prospects in each arm, for any shuffle', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    for (const seed of [0.01, 0.37, 0.8]) {
      const plan = balancedArmPlan(ids, sequence([seed, 0.2, 0.6, 0.4, 0.9]))
      const arms = [...plan.values()]
      expect(arms.filter(a => a === 'short_reasoning')).toHaveLength(3)
      expect(arms.filter(a => a === 'standard')).toHaveLength(3)
    }
  })

  it('the balanced plan refuses an odd count rather than giving one arm an extra prospect', () => {
    expect(() => balancedArmPlan(['a', 'b', 'c'])).toThrow(/even number/)
  })

  it('an unset arm reads as standard, because research before the split was standard', () => {
    expect(armOf(null)).toBe('standard')
    expect(armOf(undefined)).toBe('standard')
    expect(armOf('short_reasoning')).toBe('short_reasoning')
  })
})

describe('research arm: assignment, before research, stored once', () => {
  it('on the batch path with the split on, each unset prospect gets the coin, written only while NULL', async () => {
    const db = fakeDb({
      organisations: [{ id: ORG, research_arm_split_enabled: true }],
      prospects: [prospect('a'), prospect('b'), prospect('c')],
      prospect_research_results: [],
    })
    const counts = await assignResearchArms(db.client, ORG, ['a', 'b', 'c'], sequence([0.1, 0.9, 0.2]))

    expect(db.tables.prospects.map(p => [p.id, p.research_arm])).toEqual([['a', 'short_reasoning'], ['b', 'standard'], ['c', 'short_reasoning']])
    expect(counts.assigned).toEqual({ standard: 1, short_reasoning: 2 })
    // The stored-once property: every write was conditional on the arm still being NULL.
    for (const w of db.writes) expect(w.filters).toContainEqual({ op: 'is', col: 'research_arm', value: null })
  })

  it('a stored arm is never redrawn, even when a fresh draw would give the other arm', async () => {
    const db = fakeDb({
      organisations: [{ id: ORG, research_arm_split_enabled: true }],
      prospects: [prospect('a', { research_arm: 'short_reasoning' })],
      prospect_research_results: [],
    })
    const counts = await assignResearchArms(db.client, ORG, ['a'], () => 0.9)
    expect(db.tables.prospects[0].research_arm).toBe('short_reasoning')
    expect(counts.kept).toBe(1)
    expect(db.writes).toHaveLength(0)
  })

  it('a prospect with prior research of any age is standard, because its findings predate the split', async () => {
    const db = fakeDb({
      organisations: [{ id: ORG, research_arm_split_enabled: true }],
      prospects: [prospect('a')],
      prospect_research_results: [{ id: 'r1', organisation_id: ORG, prospect_id: 'a' }],
    })
    await assignResearchArms(db.client, ORG, ['a'], () => 0.1)
    expect(db.tables.prospects[0].research_arm).toBe('standard')
  })
})

describe('research arm: the fallback, when the split is not ready', () => {
  it('with the switch off, every prospect is standard and nothing is held', async () => {
    const db = fakeDb({
      organisations: [{ id: ORG, research_arm_split_enabled: false }],
      prospects: [prospect('a'), prospect('b')],
      prospect_research_results: [],
    })
    const counts = await assignResearchArms(db.client, ORG, ['a', 'b'], () => 0.1)
    expect(db.tables.prospects.map(p => p.research_arm)).toEqual(['standard', 'standard'])
    expect(counts.assigned.short_reasoning).toBe(0)
  })

  it('an unreadable switch falls back to standard and does not stop research', async () => {
    const db = fakeDb({
      organisations: [{ id: ORG, research_arm_split_enabled: true }],
      prospects: [prospect('a')],
      prospect_research_results: [],
    }, { failRead: ['organisations'] })
    await expect(assignResearchArms(db.client, ORG, ['a'], () => 0.1)).resolves.toBeDefined()
    expect(db.tables.prospects[0].research_arm).toBe('standard')
  })

  it('an unreadable prior-research check fails closed to standard, never to a guessed short arm', async () => {
    const db = fakeDb({
      organisations: [{ id: ORG, research_arm_split_enabled: true }],
      prospects: [prospect('a')],
      prospect_research_results: [],
    }, { failRead: ['prospect_research_results'] })
    await assignResearchArms(db.client, ORG, ['a'], () => 0.1)
    expect(db.tables.prospects[0].research_arm).toBe('standard')
  })

  it('a failed arm write throws, so the enqueue refuses rather than researching a prospect with no record', async () => {
    const db = fakeDb({
      organisations: [{ id: ORG, research_arm_split_enabled: true }],
      prospects: [prospect('a')],
      prospect_research_results: [],
    }, { failWrite: ['prospects'] })
    await expect(assignResearchArms(db.client, ORG, ['a'], () => 0.1)).rejects.toThrow(/could not store/)
  })
})

describe('research arm: the inline path and the reads', () => {
  it('the inline path settles an unset prospect to standard, and keeps a stored short arm as it is', async () => {
    const db = fakeDb({
      prospects: [prospect('a'), prospect('b', { research_arm: 'short_reasoning' })],
    })
    expect(await settleInlineArm(db.client, ORG, 'a')).toBe('standard')
    expect(await settleInlineArm(db.client, ORG, 'b')).toBe('short_reasoning')
    expect(db.writes.map(w => w.filters)).toEqual([[
      { op: 'eq', col: 'id', value: 'a' },
      { op: 'eq', col: 'organisation_id', value: ORG },
      { op: 'is', col: 'research_arm', value: null },
    ]])
  })

  it('a prospect outside the organisation has no arm to read, so the read throws', async () => {
    const db = fakeDb({ prospects: [prospect('a', { organisation_id: 'org-2' })] })
    await expect(readStoredArm(db.client, ORG, 'a')).rejects.toThrow(/not in organisation/)
  })
})

describe('research arm: release, by batch', () => {
  const tables = () => ({
    synthesis_batches: [{ id: 'b1', organisation_id: ORG }, { id: 'b2', organisation_id: 'org-2' }],
    synthesis_batch_entries: [
      { batch_id: 'b1', organisation_id: ORG, prospect_id: 'a' },
      { batch_id: 'b1', organisation_id: ORG, prospect_id: 'b' },
    ],
    prospects: [
      prospect('a', { research_arm: 'short_reasoning' }),
      prospect('b', { research_arm: 'standard' }),
      prospect('c', { research_arm: 'short_reasoning' }),
    ],
  })

  it('releases the held short prospects of its own batch once, and leaves other batches and standard prospects alone', async () => {
    const db = fakeDb(tables())
    const first = await releaseShortReasoningBatch(db.client, ORG, 'b1')
    expect(first).toEqual({ prospectsInBatch: 2, released: 1 })
    const byId = Object.fromEntries(db.tables.prospects.map(p => [p.id, p]))
    expect(byId.a.research_arm_released_at).toEqual(expect.any(String))
    expect(byId.b.research_arm_released_at).toBeNull()
    expect(byId.c.research_arm_released_at).toBeNull()

    const again = await releaseShortReasoningBatch(db.client, ORG, 'b1')
    expect(again.released).toBe(0)
  })

  it('refuses a batch that belongs to another organisation', async () => {
    const db = fakeDb(tables())
    await expect(releaseShortReasoningBatch(db.client, ORG, 'b2')).rejects.toThrow(/not an organisation/)
  })
})
