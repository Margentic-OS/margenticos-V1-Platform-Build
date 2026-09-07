// A Supabase stand-in that HONOURS FILTERS, and throws on the ones it does not implement.
//
// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// The doubles it replaces were written like this:
//
//     select: function () { return this },
//     eq:     function () { return this },
//     maybeSingle: vi.fn().mockResolvedValue({ data: MOCK_DOC }),
//
// Every filter was accepted and discarded, and the document came back whatever was
// asked for. So the ownership check on the revise route was not merely untested, it was
// untestable: deleting `.eq('organisation_id', orgId)` from the route left the entire
// suite green. The tests read as though they were about ownership and were about
// nothing. That is the failure this file is here to make impossible.
//
// The rule it follows, and the one worth keeping: a fake either honours a filter or
// throws on it. Silently returning the chain is the failure mode, because it cannot be
// distinguished from a filter that worked. A fake that throws on `.limit()` is a better
// fake than one that ignores it.

export type Row = Record<string, unknown>

type Op = 'eq' | 'neq' | 'in' | 'gte' | 'is'

interface Filter {
  op: Op
  column: string
  value: unknown
}

function matches(row: Row, filter: Filter): boolean {
  const actual = row[filter.column]
  switch (filter.op) {
    case 'eq':  return actual === filter.value
    case 'neq': return actual !== filter.value
    case 'in':  return (filter.value as readonly unknown[]).includes(actual)
    case 'gte': return String(actual) >= String(filter.value)
    case 'is':  return actual === filter.value
  }
}

// Anything the route might call that this fake does not model. Throwing names the gap
// instead of quietly widening the result set.
const UNIMPLEMENTED = [
  'limit', 'order', 'range', 'lt', 'lte', 'like', 'ilike', 'contains', 'or', 'not', 'match',
] as const

export interface FakeTable {
  rows: Row[]
}

export interface FakeDbOptions {
  tables: Record<string, Row[]>
  // Rows an insert should produce, by table. Defaults to echoing what was inserted with
  // a generated id, which is what the route reads back.
  onInsert?: (table: string, values: Row) => { data: Row | null; error: { code?: string; message: string } | null }
  rpc?: (fn: string, args: Row) => { data: unknown; error: { message: string } | null }
  // Forces the read of one table to fail, so the route's error branch can be exercised.
  failReadOn?: { table: string; message: string }
}

class FakeQuery {
  private filters: Filter[] = []
  private countMode = false
  private insertValues: Row | null = null
  private selectAfterInsert = false

  constructor(
    private readonly table: string,
    private readonly store: Record<string, Row[]>,
    private readonly opts: FakeDbOptions,
  ) {
    for (const name of UNIMPLEMENTED) {
      ;(this as unknown as Row)[name] = () => {
        throw new Error(
          `fake-supabase: .${name}() is not implemented for '${this.table}'. ` +
          `Implement it and honour it, or the assertion above it proves nothing.`,
        )
      }
    }
  }

  select(_columns?: string, options?: { count?: string; head?: boolean }) {
    if (options?.count) this.countMode = true
    if (this.insertValues) this.selectAfterInsert = true
    return this
  }

  eq(column: string, value: unknown)  { this.filters.push({ op: 'eq',  column, value }); return this }
  neq(column: string, value: unknown) { this.filters.push({ op: 'neq', column, value }); return this }
  gte(column: string, value: unknown) { this.filters.push({ op: 'gte', column, value }); return this }
  is(column: string, value: unknown)  { this.filters.push({ op: 'is',  column, value }); return this }
  in(column: string, value: readonly unknown[]) {
    if (!Array.isArray(value)) {
      throw new Error(`fake-supabase: .in('${column}') expects an array`)
    }
    this.filters.push({ op: 'in', column, value })
    return this
  }

  insert(values: Row) { this.insertValues = values; return this }

  private rows(): Row[] {
    return (this.store[this.table] ?? []).filter(row => this.filters.every(f => matches(row, f)))
  }

  private readFailure() {
    const fail = this.opts.failReadOn
    return fail && fail.table === this.table ? { message: fail.message } : null
  }

  async maybeSingle() {
    const failure = this.readFailure()
    if (failure) return { data: null, error: failure }
    const found = this.rows()
    if (found.length > 1) {
      return { data: null, error: { message: `fake-supabase: ${found.length} rows matched maybeSingle()` } }
    }
    return { data: found[0] ?? null, error: null }
  }

  async single() {
    if (this.insertValues) return this.runInsert()
    const failure = this.readFailure()
    if (failure) return { data: null, error: failure }
    const found = this.rows()
    if (found.length !== 1) {
      return { data: null, error: { message: `fake-supabase: single() matched ${found.length} rows` } }
    }
    return { data: found[0], error: null }
  }

  private runInsert() {
    const values = this.insertValues as Row
    if (this.opts.onInsert) return this.opts.onInsert(this.table, values)
    const inserted = { id: `${this.table}-inserted-id`, ...values }
    this.store[this.table] = [...(this.store[this.table] ?? []), inserted]
    return { data: inserted, error: null }
  }

  // Awaiting the builder directly is how the route runs its count queries.
  then(resolve: (value: unknown) => unknown) {
    const failure = this.readFailure()
    if (failure) return Promise.resolve({ data: null, count: null, error: failure }).then(resolve)
    const found = this.rows()
    const value = this.countMode
      ? { data: null, count: found.length, error: null }
      : { data: found, count: null, error: null }
    return Promise.resolve(value).then(resolve)
  }
}

export function makeFakeSupabase(opts: FakeDbOptions) {
  const store: Record<string, Row[]> = {}
  for (const [table, rows] of Object.entries(opts.tables)) {
    store[table] = rows.map(r => ({ ...r }))
  }

  return {
    store,
    client: {
      from: (table: string) => new FakeQuery(table, store, opts),
      rpc: async (fn: string, args: Row) =>
        opts.rpc
          ? opts.rpc(fn, args)
          : { data: null, error: { message: `fake-supabase: no rpc handler for ${fn}` } },
    },
  }
}
