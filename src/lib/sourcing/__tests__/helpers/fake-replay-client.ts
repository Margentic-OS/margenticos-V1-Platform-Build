// A Supabase fake for the tiering replay and the proposal panel.
//
// EVERY METHOD EITHER APPLIES ITS FILTER OR THROWS. It serves the three reads those two
// modules make, and nothing else:
//
//   prospects           the paged read of enriched prospects (eq, order, range)
//                       the count of removed prospects (select with count + head, eq, is, not)
//   strategy_documents  one row by id and organisation (eq, maybeSingle)
//   industry_tag_mappings   the operator's tag mappings, always empty here
//
// and one database function call, when a test supplies an answer for it.
//
// A table, column or method outside that list throws and names itself. See CLAUDE.md,
// "A fake that does not honour a filter cannot test that filter".

import type { SupabaseClient } from '@supabase/supabase-js'

export type FakeRow = Record<string, unknown>

export interface ReplayFakeOptions {
  // `object` and not FakeRow: an interface has no index signature, and a typed prospect is
  // exactly what a test wants to hand over.
  prospects?: readonly object[]
  documents?: readonly object[]
  /** Fail the paged prospects read once this many pages have been served. */
  failProspectsAfterPages?: number
  /** Fail the removed-prospects count. */
  failCount?: boolean
  /** Fail the document read. */
  failDocument?: boolean
  /** Forbid any read of prospects: the test asserts none is made. */
  forbidProspects?: boolean
  /** Answer a database function call. Without this, any rpc throws. */
  rpc?: (name: string, args: Record<string, unknown>) => { data: unknown; error: { message: string } | null }
}

export interface ReplayFake {
  client: SupabaseClient
  /** One entry per paged prospects request, as [from, to]. */
  ranges: Array<[number, number]>
  /** Every table read, in order. */
  tables: string[]
  /** Every database function call, in order. */
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>
}

export function fakeReplayClient(options: ReplayFakeOptions = {}): ReplayFake {
  const ranges: Array<[number, number]> = []
  const tables: string[] = []
  const rpcCalls: ReplayFake['rpcCalls'] = []
  let pagesServed = 0

  function prospectsChain() {
    if (options.forbidProspects) throw new Error('fake: prospects were read, and this test forbids it')
    let rows = [...(options.prospects ?? [])] as FakeRow[]
    let counting = false
    let ordered = false
    const chain = {
      select(_columns: string, opts?: { count?: string; head?: boolean }) {
        if (opts) {
          if (opts.count !== 'exact' || opts.head !== true) {
            throw new Error('fake: only select(..., { count: "exact", head: true }) is implemented')
          }
          counting = true
        }
        return chain
      },
      eq(column: string, value: unknown) {
        if (column !== 'organisation_id' && column !== 'enrichment_status') {
          throw new Error(`fake: prospects.eq(${column}) is not implemented`)
        }
        rows = rows.filter(row => row[column] === value)
        return chain
      },
      is(column: string, value: unknown) {
        if (value !== null) throw new Error(`fake: prospects.is(${column}, non-null) is not implemented`)
        rows = rows.filter(row => row[column] === null)
        return chain
      },
      not(column: string, operator: string, value: unknown) {
        if (operator !== 'is' || value !== null) {
          throw new Error(`fake: prospects.not(${column}, ${operator}, ...) is not implemented`)
        }
        rows = rows.filter(row => row[column] !== null)
        return chain
      },
      order(column: string, opts?: { ascending?: boolean }) {
        if (column !== 'id' || opts?.ascending === false) {
          throw new Error(`fake: prospects.order(${column}) descending or by another column is not implemented`)
        }
        rows.sort((a, b) => String(a.id).localeCompare(String(b.id)))
        ordered = true
        return chain
      },
      async range(from: number, to: number) {
        if (counting) throw new Error('fake: range on a count query is not implemented')
        if (!ordered) throw new Error('fake: a paged read with no order would overlap or skip rows')
        ranges.push([from, to])
        if (options.failProspectsAfterPages !== undefined && pagesServed >= options.failProspectsAfterPages) {
          return { data: null, error: { message: 'connection reset' } }
        }
        pagesServed += 1
        return { data: rows.slice(from, to + 1), error: null }
      },
      // The count query is awaited directly.
      then(resolve: (value: unknown) => void) {
        if (!counting) throw new Error('fake: a prospects read was awaited without range() or a count')
        resolve(options.failCount
          ? { count: null, error: { message: 'count failed' } }
          : { count: rows.length, error: null })
      },
    }
    return chain
  }

  function documentsChain() {
    let rows = [...(options.documents ?? [])] as FakeRow[]
    const chain = {
      select(_columns: string) { return chain },
      eq(column: string, value: unknown) {
        if (column !== 'id' && column !== 'organisation_id') {
          throw new Error(`fake: strategy_documents.eq(${column}) is not implemented`)
        }
        rows = rows.filter(row => row[column] === value)
        return chain
      },
      async maybeSingle() {
        if (options.failDocument) return { data: null, error: { message: 'read failed' } }
        return { data: rows[0] ?? null, error: null }
      },
    }
    return chain
  }

  const client = {
    from(table: string) {
      tables.push(table)
      if (table === 'prospects') return prospectsChain()
      if (table === 'strategy_documents') return documentsChain()
      if (table === 'industry_tag_mappings') {
        return { select: () => Promise.resolve({ data: [], error: null }) }
      }
      throw new Error(`fake: table ${table} is not implemented`)
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (!options.rpc) throw new Error(`fake: rpc ${name} was called and this test supplies no answer`)
      rpcCalls.push({ name, args })
      return options.rpc(name, args)
    },
  }

  return { client: client as unknown as SupabaseClient, ranges, tables, rpcCalls }
}
