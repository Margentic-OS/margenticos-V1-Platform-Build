// A Supabase fake that HONOURS the filters it is given, and throws on the ones it does not.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS RATHER THAN ANOTHER HAND-ROLLED CHAIN
//
// CLAUDE.md: "A fake that does not honour a filter cannot test that filter." Three instances
// of that shape have shipped green in this repository: a swallowed .limit(), a swallowed
// .select(cols), and dropped job_type/state filters. In each case production was correct,
// the test was structurally incapable of noticing when it stopped being, and the suite was
// green in both worlds.
//
// The two existing verification fakes each swallow most of what they are handed. That was
// survivable while the only gate under test was one .or(). It is not survivable here: the
// bug being fixed is a filter missing from an ORGANISATION PICKER, and the picker's
// behaviour is entirely a product of .or(), an inner-join filter, .order() and .limit()
// working together. A fake that ignores any one of those cannot tell the fixed picker from
// the broken one.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE RULE THIS FAKE FOLLOWS
//
// Every method either applies its filter or THROWS. There is no third option, and in
// particular there is no `return chain` for something unimplemented. A fake that silently
// accepts an unknown filter is the failure mode, so an unknown filter is a loud error that
// names itself and asks to be implemented.

/** A prospect row. Loose on purpose: tests set only the columns their query reads. */
export type FakeRow = Record<string, unknown>

/** Organisations, keyed by id. The inner join resolves against this. */
export type FakeOrgs = Record<string, { archived_at: string | null }>

/** One recorded write. */
export interface Applied { table: string; ids: string[]; payload: Record<string, unknown> }
export interface Inserted { table: string; payload: Record<string, unknown> }

/**
 * Everything the chain was asked to do, so a test can assert on the QUERY as well as on its
 * result. Used by the mutation-guard tests, which assert the filter was applied at all.
 */
export interface QueryLog {
  table: string
  orFilters: string[]
  limit: number | null
  joins: string[]
}

// ─── The PostgREST or() expression parser ───────────────────────────────────
//
// The subset actually used by the four queries this fake serves:
//
//   sourced_tier.not.is.null,tiering_reason.is.null            (the tier gate)
//   verification_locked_at.is.null,verification_locked_at.lt.X (the stale-lock reclaim)
//   second_pass_locked_at.is.null,second_pass_locked_at.lt.X   (ditto, second pass)
//   independent_email_status.is.null,and(independent_email_status.eq.Grey-listed,
//                                        independent_verified_at.lt.X)
//
// Anything outside that subset throws rather than being guessed at.

/** Split on commas that are not inside parentheses. */
function splitTopLevel(expr: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of expr) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue }
    current += ch
  }
  parts.push(current)
  return parts.map(p => p.trim()).filter(Boolean)
}

function compare(actual: unknown, op: string, rawValue: string): boolean {
  if (rawValue === 'null') {
    if (op === 'is') return actual === null || actual === undefined
    throw new Error(`fake: operator "${op}" against null is not implemented`)
  }
  switch (op) {
    case 'eq': return String(actual) === rawValue
    case 'lt': return actual !== null && actual !== undefined && String(actual) < rawValue
    case 'gt': return actual !== null && actual !== undefined && String(actual) > rawValue
    case 'lte': return actual !== null && actual !== undefined && String(actual) <= rawValue
    case 'gte': return actual !== null && actual !== undefined && String(actual) >= rawValue
    case 'is': throw new Error(`fake: "is.${rawValue}" is not implemented, only is.null`)
    default: throw new Error(`fake: or() operator "${op}" is not implemented`)
  }
}

/** Evaluate one term of an or()/and() expression against a row. */
function evaluateTerm(term: string, row: FakeRow): boolean {
  const andMatch = /^and\((.*)\)$/.exec(term)
  if (andMatch) return splitTopLevel(andMatch[1]).every(t => evaluateTerm(t, row))

  const orMatch = /^or\((.*)\)$/.exec(term)
  if (orMatch) return splitTopLevel(orMatch[1]).some(t => evaluateTerm(t, row))

  // col.op.value, or col.not.op.value
  const segments = term.split('.')
  if (segments.length < 3) throw new Error(`fake: cannot parse or() term "${term}"`)
  const column = segments[0]
  if (segments[1] === 'not') {
    const op = segments[2]
    const value = segments.slice(3).join('.')
    return !compare(row[column], op, value)
  }
  const op = segments[1]
  const value = segments.slice(2).join('.')
  return compare(row[column], op, value)
}

/** True when the row satisfies the whole or() expression. */
export function evaluateOrFilter(expr: string, row: FakeRow): boolean {
  return splitTopLevel(expr).some(term => evaluateTerm(term, row))
}

// ─── The fake client ────────────────────────────────────────────────────────

interface FakeOptions {
  organisations?: FakeOrgs
  /** Value returned for a head/count select. */
  count?: number
  countError?: string
  ledgerInsertError?: string
}

export function fakeProspectsClient(rows: FakeRow[], opts: FakeOptions = {}) {
  const applied: Applied[] = []
  const inserted: Inserted[] = []
  const queries: QueryLog[] = []
  let ledgerSeq = 0

  const client = {
    from(table: string) {
      let ids: string[] = []
      let mode: 'rows' | 'count' | 'single' = 'rows'
      let selectedColumns: string[] = []

      const predicates: Array<(r: FakeRow) => boolean> = []
      const log: QueryLog = { table, orFilters: [], limit: null, joins: [] }
      let orderBy: { column: string; ascending: boolean } | null = null

      /**
       * Resolve a column reference against a row, following an embedded-resource prefix such
       * as `organisations.archived_at` into the joined record.
       *
       * A join filter naming a resource the select() never joined is an error, not a pass:
       * that is exactly how a filter goes missing and nothing notices.
       */
      function resolve(column: string, row: FakeRow): unknown {
        if (!column.includes('.')) return row[column]
        const [resource, field] = column.split('.')
        if (!log.joins.includes(resource)) {
          throw new Error(
            `fake: filter on "${column}" but select() never joined "${resource}". ` +
            `Add it to the select string, or the join filter is silently doing nothing.`,
          )
        }
        const orgs = opts.organisations ?? {}
        const joined = orgs[row.organisation_id as string]
        // !inner semantics: no matching parent row means the row is dropped entirely.
        if (!joined) return undefined
        return (joined as Record<string, unknown>)[field]
      }

      const chain: Record<string, unknown> = {
        select(cols: string, o?: { count?: string; head?: boolean }) {
          if (o?.head) mode = 'count'
          selectedColumns = cols.split(',').map(c => c.trim())
          // Record every embedded resource the select joins, and whether it is an inner join.
          for (const match of cols.matchAll(/(\w+)!inner\s*\(/g)) {
            log.joins.push(match[1])
            // !inner semantics: a row with no matching parent is dropped before any filter.
            const orgs = opts.organisations ?? {}
            predicates.push(r => Boolean(orgs[r.organisation_id as string]))
          }
          return chain
        },
        eq(column: string, value: unknown) {
          if (column === 'id') ids = [String(value)]
          predicates.push(r => {
            const actual = resolve(column, r)
            // A boolean column compared against a boolean, everything else as a string.
            if (typeof value === 'boolean') return (actual ?? false) === value
            return String(actual) === String(value)
          })
          return chain
        },
        is(column: string, value: null) {
          if (value !== null) throw new Error(`fake: .is(${column}, ${String(value)}) is not implemented`)
          predicates.push(r => { const a = resolve(column, r); return a === null || a === undefined })
          return chain
        },
        not(column: string, op: string, value: unknown) {
          if (op !== 'is' || value !== null) {
            throw new Error(`fake: .not(${column}, ${op}, ${String(value)}) is not implemented`)
          }
          predicates.push(r => { const a = resolve(column, r); return a !== null && a !== undefined })
          return chain
        },
        in(column: string, values: unknown[]) {
          if (column === 'id') ids = values.map(String)
          predicates.push(r => values.map(String).includes(String(resolve(column, r))))
          return chain
        },
        lt(column: string, value: unknown) {
          predicates.push(r => {
            const actual = resolve(column, r)
            if (actual === null || actual === undefined) return false
            return typeof value === 'number'
              ? Number(actual) < value
              : String(actual) < String(value)
          })
          return chain
        },
        gte(column: string, value: unknown) {
          predicates.push(r => {
            const actual = resolve(column, r)
            if (actual === null || actual === undefined) return false
            return typeof value === 'number' ? Number(actual) >= value : String(actual) >= String(value)
          })
          return chain
        },
        // HONOURED, and recorded so a test can assert the filter was applied at all.
        or(expr: string) {
          log.orFilters.push(expr)
          predicates.push(r => evaluateOrFilter(expr, r))
          return chain
        },
        order(column: string, o?: { ascending?: boolean }) {
          orderBy = { column, ascending: o?.ascending !== false }
          return chain
        },
        // HONOURED. Swallowing this is the shape that shipped green three times here.
        limit(n: number) { log.limit = n; return chain },
        maybeSingle() {
          mode = 'single'
          const row = rows.find(r => String(r.id) === ids[0])
          if (!row) return Promise.resolve({ data: null, error: null })
          // Project only the columns the select asked for. A counter column defaults to 0,
          // matching the database default every attempt-count reader relies on.
          const projected: FakeRow = {}
          for (const column of selectedColumns) projected[column] = row[column] ?? 0
          return Promise.resolve({ data: projected, error: null })
        },
        insert(payload: Record<string, unknown>) {
          inserted.push({ table, payload })
          const ins: Record<string, unknown> = {
            select() { return ins },
            maybeSingle() {
              if (opts.ledgerInsertError) {
                return Promise.resolve({ data: null, error: { message: opts.ledgerInsertError } })
              }
              return Promise.resolve({ data: { id: `call-${++ledgerSeq}` }, error: null })
            },
            then(resolve_: (v: unknown) => void) { resolve_({ data: null, error: null }) },
          }
          return ins
        },
        update(payload: Record<string, unknown>) {
          const upd: Record<string, unknown> = {
            eq(column: string, value: unknown) { if (column === 'id') ids = [String(value)]; return upd },
            in(column: string, values: unknown[]) { if (column === 'id') ids = values.map(String); return upd },
            then(resolve_: (v: unknown) => void) {
              applied.push({ table, ids: [...ids], payload })
              // Writes are applied to the in-memory rows, so a later read in the same run
              // sees them. Without this a lock taken in step 2 is invisible in step 3.
              for (const id of ids) {
                const row = rows.find(r => String(r.id) === id)
                if (row) Object.assign(row, payload)
              }
              resolve_({ data: null, error: null })
            },
          }
          return upd
        },
        then(resolve_: (v: unknown) => void) {
          queries.push(log)

          if (mode === 'count') {
            resolve_(
              opts.countError
                ? { count: null, error: { message: opts.countError } }
                : { count: opts.count ?? 0, error: null },
            )
            return
          }

          let selected = rows.filter(r => predicates.every(p => p(r)))

          if (orderBy) {
            const { column, ascending } = orderBy
            selected = [...selected].sort((a, b) => {
              const av = String(a[column] ?? '')
              const bv = String(b[column] ?? '')
              return ascending ? av.localeCompare(bv) : bv.localeCompare(av)
            })
          }

          if (log.limit !== null) selected = selected.slice(0, log.limit)

          resolve_({ data: selected.map(r => ({ ...r })), error: null })
        },
      }
      return chain
    },
  }

  return { client: client as never, applied, inserted, queries, rows }
}
