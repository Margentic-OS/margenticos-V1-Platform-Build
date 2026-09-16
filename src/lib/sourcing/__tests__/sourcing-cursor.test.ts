// Drawing from a POSITION in the result set instead of re-reading the top of it.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS IS FOR, MEASURED
//
// The handler set page = 1 on every run. Three consecutive runs for the live client on
// 2026-09-15:
//
//     21:30:45   cap 30   returned 30   written 24   duplicates  6
//     21:31:52   cap 36   returned 36   written  4   duplicates 32
//     21:32:32   cap 44   returned 44   written  8   duplicates 36
//     -----------------------------------------------------------
//                         returned 110  written 36   duplicates 74   = 67.3%
//
// Run 3's window added exactly records 37 to 44 over run 2's, which is 8, and it wrote
// exactly 8. The model predicts the observation, which is the evidence a cursor fixes it.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE THREE THINGS THAT MUST NOT SILENTLY BREAK
//
//   1. the position is SAVED after a run
//   2. it is READ on the next run, and the next run starts there
//   3. a run at the 50,000 ceiling SAYS SO, rather than returning nothing new
//
// The third matters most and is the hardest to keep honest, because at the ceiling the
// provider returns nothing and "nothing" is exactly what a healthy run that found nobody
// new returns. The wall is roughly 1,250 runs away at current batch sizes, so nobody who
// meets it will remember that it was predicted.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readCursor, advanceCursor } from '../sourcing-cursor'
import {
  addressForOffset,
  isAtCeiling,
  windowBelowCeiling,
  remainingBelowCeiling,
  RECORD_CEILING,
} from '../record-position'

const ORG = 'org-1'
const ICP = 'icp-doc-1'

interface Upserted { payload: Record<string, unknown> }

/**
 * A stand-in for the cursor table.
 *
 * It HONOURS the organisation filter and THROWS on anything it does not implement. A fake
 * that silently returns its chain for an unimplemented call cannot test the filter that
 * call represents: the rows come back either way, and deleting the filter from the real
 * query fails nothing.
 */
function fakeSupabase(
  row: { record_offset: number; icp_document_id: string | null } | null,
  opts: { readError?: string; writeError?: string } = {},
) {
  const upserts: Upserted[] = []
  let filteredOrg: string | null = null

  const client = {
    from(table: string) {
      if (table !== 'sourcing_cursors') throw new Error(`unexpected table ${table}`)
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: string) => {
          if (col !== 'organisation_id') throw new Error(`fake does not implement eq on ${col}`)
          filteredOrg = val
          return chain
        },
        maybeSingle: async () => {
          if (opts.readError) return { data: null, error: { message: opts.readError } }
          if (filteredOrg !== ORG) return { data: null, error: null }
          return { data: row, error: null }
        },
        upsert: async (payload: Record<string, unknown>) => {
          if (opts.writeError) return { error: { message: opts.writeError } }
          upserts.push({ payload })
          return { error: null }
        },
      }
      return chain
    },
  } as unknown as SupabaseClient

  return { client, upserts }
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('the arithmetic that turns an offset into a page', () => {
  it('converts with page = floor(offset / per_page) + 1', () => {
    expect(addressForOffset(0, 100).page).toBe(1)
    expect(addressForOffset(99, 100).page).toBe(1)
    expect(addressForOffset(100, 100).page).toBe(2)
    expect(addressForOffset(250, 100).page).toBe(3)
  })

  // THE CASE THE 2026-09-15 RUNS WOULD HAVE HIT. Caps of 30, 36 and 44 mean per_page
  // changes between runs, so an offset rarely lands on a page boundary. Without the
  // in-page skip the run re-reads the prefix and leans on dedupe, which is the behaviour
  // the cursor exists to remove.
  it('reports how much of the first page was already consumed', () => {
    expect(addressForOffset(30, 44)).toEqual({ page: 1, skipInPage: 30 })
    expect(addressForOffset(66, 44)).toEqual({ page: 2, skipInPage: 22 })
    expect(addressForOffset(88, 44)).toEqual({ page: 3, skipInPage: 0 })
  })

  // A negative offset is a caller bug. Clamping it to 0 would restart the client at the top
  // of the result set and look exactly like the cursor working.
  it('refuses a negative offset rather than quietly restarting at the top', () => {
    expect(() => addressForOffset(-1, 100)).toThrow(/zero or positive/)
  })

  it('refuses a per_page that cannot address anything', () => {
    expect(() => addressForOffset(0, 0)).toThrow(/positive integer/)
  })
})

describe('1. the position is SAVED', () => {
  it('writes start + recordsRead after a run', async () => {
    const { client, upserts } = fakeSupabase(null)

    const end = await advanceCursor(client, ORG, ICP, 120, 44)

    expect(end).toBe(164)
    expect(upserts).toHaveLength(1)
    expect(upserts[0].payload.record_offset).toBe(164)
    expect(upserts[0].payload.organisation_id).toBe(ORG)
  })

  // THE DISTINCTION THE WHOLE DESIGN RESTS ON. Post-filters and dedupe both drop rows, so
  // advancing by survivors would re-read every dropped record on every later run, and drop
  // each one again for the same reason. The cursor would crawl while appearing to move.
  it('advances by records READ, not by prospects written', async () => {
    const { client, upserts } = fakeSupabase(null)

    // A run that read 44 records and, after post-filters and dedupe, wrote only 8.
    await advanceCursor(client, ORG, ICP, 0, 44)

    expect(upserts[0].payload.record_offset).toBe(44)
    expect(upserts[0].payload.record_offset).not.toBe(8)
  })

  it('leaves the position alone when a run read nothing', async () => {
    const { client, upserts } = fakeSupabase(null)
    const end = await advanceCursor(client, ORG, ICP, 300, 0)
    expect(end).toBe(300)
    expect(upserts[0].payload.record_offset).toBe(300)
  })

  // A lost write costs one repeated window, which dedupe absorbs. Throwing would fail a run
  // whose prospects are already committed, which is worse.
  it('reports the old position and does not throw when the write fails', async () => {
    const { client } = fakeSupabase(null, { writeError: 'connection lost' })
    const end = await advanceCursor(client, ORG, ICP, 120, 44)
    expect(end).toBe(120)
  })
})

describe('2. the position is READ on the next run', () => {
  it('returns the stored offset', async () => {
    const { client } = fakeSupabase({ record_offset: 164, icp_document_id: ICP })
    const cursor = await readCursor(client, ORG, ICP)
    expect(cursor.recordOffset).toBe(164)
    expect(cursor.wasReset).toBe(false)
  })

  it('starts at zero for a client that has never been sourced', async () => {
    const { client } = fakeSupabase(null)
    const cursor = await readCursor(client, ORG, ICP)
    expect(cursor.recordOffset).toBe(0)
    expect(cursor.wasReset).toBe(false)
  })

  // A MISSING ROW AND A FAILED READ ARE NOT THE SAME THING. No row means "never sourced"
  // and 0 is right. An error means the position is UNKNOWN, and 0 is then the most
  // expensive guess available: it re-reads the whole result set and hands the problem back
  // to dedupe. Same shape as the verification trigger refusing to run on an unreadable
  // daily budget rather than assuming zero used.
  it('throws when the position cannot be read, rather than assuming zero', async () => {
    const { client } = fakeSupabase(null, { readError: 'connection lost' })
    await expect(readCursor(client, ORG, ICP)).rejects.toThrow(/Refusing to start from zero/)
  })

  // The offset indexes into ONE result set. A new ICP is a different query, so carrying the
  // offset over would skip the first N records of a set nobody has read.
  it('resets to zero when the ICP changed, and says so', async () => {
    const { client } = fakeSupabase({ record_offset: 4000, icp_document_id: 'an-older-icp' })
    const cursor = await readCursor(client, ORG, 'a-new-icp')
    expect(cursor.recordOffset).toBe(0)
    expect(cursor.wasReset).toBe(true)
  })

  it('keeps the position when the ICP is unchanged', async () => {
    const { client } = fakeSupabase({ record_offset: 4000, icp_document_id: ICP })
    const cursor = await readCursor(client, ORG, ICP)
    expect(cursor.recordOffset).toBe(4000)
    expect(cursor.wasReset).toBe(false)
  })

  // Resetting on "don't know" would quietly restart a client at the top, which is the
  // failure this whole file is about. Only reset when both sides are known AND differ.
  it('does not reset when the stored ICP is unknown', async () => {
    const { client } = fakeSupabase({ record_offset: 4000, icp_document_id: null })
    const cursor = await readCursor(client, ORG, ICP)
    expect(cursor.recordOffset).toBe(4000)
    expect(cursor.wasReset).toBe(false)
  })
})

describe('3. a run at the ceiling SAYS SO', () => {
  it('knows where the wall is', () => {
    expect(RECORD_CEILING).toBe(50_000)
    expect(isAtCeiling(49_999)).toBe(false)
    expect(isAtCeiling(50_000)).toBe(true)
    expect(isAtCeiling(50_001)).toBe(true)
  })

  it('reports nothing remaining at or past the wall, never a negative', () => {
    expect(remainingBelowCeiling(49_960)).toBe(40)
    expect(remainingBelowCeiling(50_000)).toBe(0)
    expect(remainingBelowCeiling(60_000)).toBe(0)
  })

  // THE CLAMP. A run near the wall must ask for the records that exist and no more, rather
  // than requesting a full batch and receiving a 422 it would report as a generic failure.
  it('clamps the last window to what is actually left', () => {
    expect(windowBelowCeiling(49_960, 44)).toBe(40)
    expect(windowBelowCeiling(0, 44)).toBe(44)
  })

  // THE ONE THAT MATTERS. Zero remaining must be reachable as its own distinguishable
  // state, not as an empty window that looks like an ordinary quiet run.
  it('returns a zero window at the wall, which the caller must not read as "nobody new"', () => {
    expect(windowBelowCeiling(50_000, 44)).toBe(0)
    expect(isAtCeiling(50_000)).toBe(true)
  })
})
