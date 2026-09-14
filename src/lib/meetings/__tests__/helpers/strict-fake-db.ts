// An in-memory database for booking and billing tests that CANNOT quietly ignore a filter.
//
// WHY STRICT. CLAUDE.md, "A fake that does not honour a filter cannot test that filter":
// a fake whose .not() or .eq() returns the chain without applying it lets a test pass while
// the guard it claims to prove is gone. Here every filter this fake offers is applied to the
// rows, every method it does not offer THROWS by name, and the two unique keys the booking
// path relies on are enforced with the real error code, 23505. So deleting a guard in the
// code under test changes what these rows hold, and the test sees it.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Row = Record<string, unknown>

// Mirrors the UNIQUE constraints that exist in the database (migration
// 20260911160000_booking_detection_additive.sql). NULLs never collide, as in Postgres.
const UNIQUE_KEYS: Record<string, string[][]> = {
  meetings: [['booking_uid']],
  unattributed_bookings: [['provider', 'provider_booking_uid']],
}

// Postgres LIKE with backslash escapes, matched case-insensitively (ILIKE).
function likeToRegex(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '\\' && i + 1 < pattern.length) {
      out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    } else if (char === '%') {
      out += '.*'
    } else if (char === '_') {
      out += '.'
    } else {
      out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`, 'i')
}

function collides(table: string, rows: Row[], candidate: Row, except?: Row): boolean {
  for (const cols of UNIQUE_KEYS[table] ?? []) {
    if (cols.some(c => candidate[c] === null || candidate[c] === undefined)) continue
    if (rows.some(r => r !== except && cols.every(c => r[c] === candidate[c]))) return true
  }
  return false
}

export interface StrictFakeDb {
  client: any
  tables: Record<string, Row[]>
  /** Every table touched, in order. An empty list proves nothing was read or written. */
  calls: string[]
  /** Make every insert into this table fail, to prove a failure is not reported as success. */
  failInsertsInto?: string
}

export function createStrictFakeDb(
  seed: Record<string, Row[]>,
  // silentlyBlockUpdatesTo makes every update to that table match nothing and return no
  // error, which is exactly what a row-level-security policy without UPDATE does to a caller.
  // It exists to reproduce "the write touched 0 rows and nobody said so".
  opts: { failInsertsInto?: string; silentlyBlockUpdatesTo?: string } = {},
): StrictFakeDb {
  const tables: Record<string, Row[]> = {}
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map(r => ({ ...r }))
  const calls: string[] = []
  let nextId = 1

  function from(table: string) {
    if (!(table in tables)) throw new Error(`strict fake: table "${table}" is not seeded`)
    calls.push(table)

    const filters: Array<(row: Row) => boolean> = []
    let op: 'select' | 'insert' | 'update' = 'select'
    let payload: Row = {}
    let limitTo: number | null = null

    function execute(): { data: any; error: any; count?: number } {
      const rows = tables[table]
      if (op === 'insert') {
        if (opts.failInsertsInto === table) return { data: null, error: { code: 'XX000', message: 'simulated failure' } }
        const row: Row = { id: `${table}-${nextId++}`, ...payload }
        if (collides(table, rows, row)) {
          return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint on ${table}` } }
        }
        rows.push(row)
        return { data: [{ ...row }], error: null }
      }
      const matched = rows.filter(r => filters.every(f => f(r)))
      if (op === 'update') {
        // What RLS without an UPDATE policy does to a caller: the statement succeeds, no
        // error is raised, and it matched nothing. Checked BEFORE the rows are touched,
        // so a blocked update leaves the seeded rows exactly as they were.
        if (opts.silentlyBlockUpdatesTo === table) return { data: [], error: null, count: 0 }
        for (const r of matched) {
          if (collides(table, rows, { ...r, ...payload }, r)) {
            return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint on ${table}` } }
          }
        }
        for (const r of matched) Object.assign(r, payload)
        return { data: matched.map(r => ({ ...r })), error: null, count: matched.length }
      }
      const limited = limitTo === null ? matched : matched.slice(0, limitTo)
      return { data: limited.map(r => ({ ...r })), error: null }
    }

    const methods: Record<string, (...args: any[]) => any> = {
      select: () => proxy,
      insert: (row: Row) => { op = 'insert'; payload = row; return proxy },
      update: (values: Row) => { op = 'update'; payload = values; return proxy },
      eq: (col: string, value: unknown) => { filters.push(r => r[col] === value); return proxy },
      in: (col: string, values: unknown[]) => { filters.push(r => values.includes(r[col])); return proxy },
      is: (col: string, value: unknown) => {
        if (value !== null) throw new Error('strict fake: is() is implemented for null only')
        filters.push(r => r[col] === null || r[col] === undefined)
        return proxy
      },
      not: (col: string, operator: string, value: unknown) => {
        if (operator !== 'is' || value !== null) throw new Error(`strict fake: not(${operator}) is not implemented`)
        filters.push(r => r[col] !== null && r[col] !== undefined)
        return proxy
      },
      ilike: (col: string, pattern: string) => {
        const regex = likeToRegex(pattern)
        filters.push(r => typeof r[col] === 'string' && regex.test(r[col] as string))
        return proxy
      },
      limit: (n: number) => { limitTo = n; return proxy },
      maybeSingle: async () => {
        const result = execute()
        if (result.error) return { data: null, error: result.error }
        if (result.data.length > 1) return { data: null, error: { message: 'multiple rows for maybeSingle' } }
        return { data: result.data[0] ?? null, error: null }
      },
      single: async () => {
        const result = execute()
        if (result.error) return { data: null, error: result.error }
        if (result.data.length !== 1) return { data: null, error: { message: `single expected 1 row, got ${result.data.length}` } }
        return { data: result.data[0], error: null }
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve().then(execute).then(resolve, reject),
    }

    const proxy: any = new Proxy(methods, {
      get(target, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop in target) return target[prop]
        throw new Error(`strict fake: .${prop}() is not implemented, so it cannot be silently ignored`)
      },
    })
    return proxy
  }

  return { client: { from }, tables, calls }
}
