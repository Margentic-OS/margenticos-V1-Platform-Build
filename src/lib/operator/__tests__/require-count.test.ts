// requireCount refuses to turn a failure into a zero.
//
// WHAT THIS DOES AND DOES NOT COVER. These are unit tests on the helper. The three call
// sites it was written for are server components that build a Supabase query and read the
// result, and testing those end to end would mean faking the whole client for no more
// confidence than this gives: the helper is the only place the decision is made, and the
// type signature is what forces the sites through it. What a future change could still do
// is stop CALLING it, which no test here would catch. The guard against that is that the
// sites no longer have a `?? 0` to fall back to.

import { describe, it, expect } from 'vitest'
import { requireCount } from '../require-count'

describe('requireCount', () => {
  it('returns a real count', () => {
    expect(requireCount({ count: 100, error: null }, 'prospects')).toBe(100)
  })

  it('returns a genuine zero, which is a real answer and must survive', () => {
    // The point is not "never return zero". An empty queue is a fact. The point is that
    // zero must come from the database rather than from a failure.
    expect(requireCount({ count: 0, error: null }, 'prospects')).toBe(0)
  })

  it('RAISES on a failed count instead of reporting zero', () => {
    expect(() =>
      requireCount(
        { count: null, error: { message: 'canceling statement due to statement timeout' } },
        'prospects awaiting approval for organisation abc',
      ),
    ).toThrow(/Could not count prospects awaiting approval for organisation abc/)
  })

  it('names the underlying database error, so the operator can tell why', () => {
    expect(() =>
      requireCount({ count: null, error: { message: 'connection reset by peer' } }, 'prospects'),
    ).toThrow(/connection reset by peer/)
  })

  it('RAISES when the count is null with no error, which means count: exact was omitted', () => {
    // Not hypothetical. postgrest-js only sends the Prefer: count= header when the option
    // is passed, and two call sites in this repo had idempotency guards made permanently
    // unreachable by exactly this.
    expect(() => requireCount({ count: null, error: null }, 'prospects')).toThrow(/count: 'exact'/)
  })

  it('an error takes precedence over a count that happens to be present', () => {
    expect(() =>
      requireCount({ count: 0, error: { message: 'permission denied' } }, 'prospects'),
    ).toThrow(/permission denied/)
  })
})
