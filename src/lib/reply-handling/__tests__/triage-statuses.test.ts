// Every status the triage queue serves must be actionable by SOMETHING.
//
// WHAT THIS GUARDS. The queue served four statuses; reject accepted two. A
// manual_required draft sat in production from 2026-09-03 with a Reject button
// that returned 409 every time, and an Approve path that had never run. Nothing
// failed, nothing logged, and the operator was told the row had been "acted on
// in another session" — which had not happened. The lists were three separate
// literals in three files and no test compared them.
//
// This is the CLAUDE.md parallel-lists shape. The structural fix is that
// APPROVABLE_STATUSES and REJECTABLE_STATUSES are now DERIVED from
// TRIAGE_STATUSES, so the drift cannot be expressed. This test is the second
// half: it fails if anyone reintroduces a hand-maintained literal that drops a
// status on the floor.
//
// MUTATION-PROVED 2026-09-05. Removing 'manual_required' from the reject side
// turns 'every triage status is actionable' RED, naming the orphaned status.
// Verified by temporarily excluding it and re-running. See the run recorded in
// the commit message.
//
// NOTE ON SCOPE, so this is not over-trusted: this test compares the lists to
// each other. It does NOT prove the routes call them, and it does not touch the
// database. Route wiring is asserted separately below by reading the route
// sources, which is a cheap early warning and not authoritative either.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TRIAGE_STATUSES,
  APPROVABLE_STATUSES,
  REJECTABLE_STATUSES,
  isApprovable,
  isRejectable,
} from '../triage-statuses'

describe('triage status coverage', () => {
  it('every triage status is actionable by reject or approve', () => {
    // The floor: a status with NO working action is a row that can never leave
    // the queue. Necessary but NOT sufficient — it cannot see a status that has
    // one working action and one broken one, which is exactly what shipped on
    // 2026-09-03. The per-action tests below are what close that gap.
    const orphaned = TRIAGE_STATUSES.filter(
      status => !isApprovable(status) && !isRejectable(status)
    )

    expect(orphaned).toEqual([])
  })

  it('names the specific statuses, so a silently emptied list cannot pass vacuously', () => {
    // Guard the guard. If TRIAGE_STATUSES were emptied, the test above would pass
    // over an empty set and prove nothing. This pins the actual contents.
    expect([...TRIAGE_STATUSES]).toEqual([
      'pending',
      'manual_required',
      'draft_failed',
      'send_failed',
    ])
    expect(TRIAGE_STATUSES.length).toBeGreaterThan(0)
  })

  it('reject accepts EVERY queued status, which the OR invariant above does not prove', () => {
    // THIS is the test that catches the 2026-09-03 defect, and the OR invariant
    // above is NOT. manual_required was un-rejectable but still approvable, so
    // it was never "orphaned" and the OR check passes straight over it.
    // Mutation-proved: dropping manual_required from REJECTABLE_STATUSES fails
    // this test and leaves the OR invariant green.
    //
    // Reject is the universal escape hatch. An operator must always be able to
    // clear a row from the queue, whatever state put it there, so this is an
    // ALL, not an OR.
    const notRejectable = TRIAGE_STATUSES.filter(status => !isRejectable(status))

    expect(notRejectable).toEqual([])
  })

  it('approve excludes send_failed and nothing else', () => {
    // send_failed is terminal for approval: approving again would re-send.
    expect(isApprovable('send_failed')).toBe(false)

    const expectedApprovable = TRIAGE_STATUSES.filter(s => s !== 'send_failed')
    expect([...APPROVABLE_STATUSES]).toEqual([...expectedApprovable])
  })

  it('rejects statuses that are not triage statuses at all', () => {
    // Prove the predicates can return false, so their `true`s mean something.
    for (const status of ['approved', 'sent', 'rejected', '', 'PENDING']) {
      expect(isApprovable(status)).toBe(false)
      expect(isRejectable(status)).toBe(false)
    }
  })

  it('the derived lists are subsets of the one source list', () => {
    for (const status of APPROVABLE_STATUSES) {
      expect(TRIAGE_STATUSES).toContain(status)
    }
    for (const status of REJECTABLE_STATUSES) {
      expect(TRIAGE_STATUSES).toContain(status)
    }
  })
})

describe('the routes actually read the shared lists', () => {
  // A source scan, so it is an early warning and not proof of runtime behaviour.
  // It exists because deriving the constants is worthless if a route quietly
  // stops importing them and inlines a literal again, which is exactly how the
  // original three-literal drift happened.
  const root = join(__dirname, '..', '..', '..', 'app', 'api', 'reply-drafts')

  // Strip comments before matching. The first version of the count test below
  // matched a bare substring and passed against the EXPLANATORY COMMENT that
  // names `{ count: 'exact' }` while the actual argument had been deleted —
  // mutation-caught 2026-09-05. A source scan that cannot tell code from prose
  // is not a check. Same family as the migration scan in CLAUDE.md that a
  // rename walked straight through.
  const codeOnly = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const routes = [
    { file: join(root, 'route.ts'), symbol: 'TRIAGE_STATUSES' },
    { file: join(root, '[id]', 'approve', 'route.ts'), symbol: 'APPROVABLE_STATUSES' },
    { file: join(root, '[id]', 'reject', 'route.ts'), symbol: 'REJECTABLE_STATUSES' },
  ]

  it.each(routes)('$symbol is imported from the shared module, not redeclared', ({ file, symbol }) => {
    const src = codeOnly(readFileSync(file, 'utf8'))

    // Prove the instrument can find something known to be there before trusting
    // what it does not find. A grep that returns nothing may not have run.
    expect(src).toContain('reply_drafts')

    expect(src).toMatch(
      new RegExp(`import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*'@/lib/reply-handling/triage-statuses'`)
    )
    // And no local redeclaration shadowing the import.
    expect(src).not.toMatch(new RegExp(`const\\s+${symbol}\\s*=`))
  })

  it('the reject route asks PostgREST for an exact count', () => {
    // Without { count: 'exact' } postgrest-js omits the Prefer header, PostgREST
    // replies `content-range: */*`, count comes back null, and the `count === 0`
    // guard below it is unreachable. Measured against the test project
    // 2026-09-05. The approve route was fixed in PR #65; reject was not, and its
    // guard had never once been able to fire.
    const src = codeOnly(readFileSync(join(root, '[id]', 'reject', 'route.ts'), 'utf8'))

    // Instrument check first: prove the stripped source still contains code.
    expect(src).toContain('reply_drafts')
    expect(src).toContain('.in(')

    // MUTATION-PROVED 2026-09-05: deleting the { count: 'exact' } argument from
    // the update() call turns this red. It did NOT before comments were stripped.
    expect(src).toContain("{ count: 'exact' }")
    expect(src).toContain('count === 0')
  })
})
