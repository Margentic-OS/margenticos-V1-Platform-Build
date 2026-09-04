// Tests for getDailyVerificationLimit.
//
// The bug being guarded: the daily verification budget was `const FREE_DAILY_LIMIT = 100`,
// the validator's free-tier allowance, on an account that moved to pay-as-you-go on
// 2026-09-01. A vendor's commercial terms cannot be a compile-time constant.
//
// THE FAKE HONOURS EVERY FILTER AND THROWS ON ANYTHING IT DOES NOT IMPLEMENT. CLAUDE.md
// records three cases where a fake silently returned its chain for an unimplemented call,
// so the guard under test could be deleted with the suite still green. `single()` throws
// here on purpose: two rows carry capability 'can_validate_email', so a `.single()` would
// error in production the moment a second validator is registered, and a fake that
// swallowed it would hide that.

import { describe, it, expect, vi } from 'vitest'
import {
  getDailyVerificationLimit,
  FALLBACK_DAILY_VERIFICATION_LIMIT,
  DAILY_VERIFICATION_LIMIT_KEY,
} from './verification-limits'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

type FakeOpts = {
  row?: unknown
  error?: { message: string } | null
  throwFromFrom?: boolean
}

function makeRegistryFake(opts: FakeOpts) {
  const calls = { table: '', columns: '', filters: [] as Array<[string, unknown]> }

  const chain: Record<string, unknown> = {
    select: (cols: string) => {
      calls.columns = cols
      return chain
    },
    eq: (col: string, val: unknown) => {
      calls.filters.push([col, val])
      return chain
    },
    single: () => {
      throw new Error(
        'fake: .single() is not implemented — two rows carry can_validate_email, so this ' +
        'read must use maybeSingle() together with an is_active filter',
      )
    },
    limit: () => {
      throw new Error('fake: .limit() is not implemented')
    },
    is: (col: string) => {
      throw new Error(`fake: .is('${col}') is not implemented`)
    },
    maybeSingle: async () => ({
      data: opts.error ? null : (opts.row ?? null),
      error: opts.error ?? null,
    }),
  }

  const client = {
    from: (table: string) => {
      if (opts.throwFromFrom) throw new Error('Network error')
      calls.table = table
      return chain
    },
  }

  return { client: client as never, calls }
}

const withLimit = (value: unknown) => ({ config: { [DAILY_VERIFICATION_LIMIT_KEY]: value } })

describe('getDailyVerificationLimit', () => {
  it('returns the configured limit, so the number is editable without a deploy', async () => {
    const { client } = makeRegistryFake({ row: withLimit(10500) })
    expect(await getDailyVerificationLimit(client)).toEqual({ limit: 10500, source: 'config' })
  })

  it('reports a configured limit that differs from the fallback as coming from config', async () => {
    // The whole point of the change: a value that is NOT the compiled default must be
    // reachable, and must be distinguishable from having fallen back to it.
    const { client } = makeRegistryFake({ row: withLimit(7) })
    const result = await getDailyVerificationLimit(client)
    expect(result.limit).toBe(7)
    expect(result.limit).not.toBe(FALLBACK_DAILY_VERIFICATION_LIMIT)
    expect(result.source).toBe('config')
  })

  it('selects on capability and is_active, never on a tool name', async () => {
    // Tool agnosticism, enforced rather than asserted in a comment. Swapping validator is a
    // registry edit; naming the vendor here would make it a code change.
    const { client, calls } = makeRegistryFake({ row: withLimit(10500) })
    await getDailyVerificationLimit(client)

    expect(calls.table).toBe('integrations_registry')
    expect(calls.filters).toEqual([
      ['capability', 'can_validate_email'],
      ['is_active', true],
    ])
    const filterValues = JSON.stringify(calls.filters).toLowerCase()
    for (const vendor of ['myemailverifier', 'hunter', 'bouncer']) {
      expect(filterValues).not.toContain(vendor)
    }
  })

  it('falls back when the registry read errors', async () => {
    const { client } = makeRegistryFake({ error: { message: 'boom' } })
    const result = await getDailyVerificationLimit(client)
    expect(result).toMatchObject({ limit: FALLBACK_DAILY_VERIFICATION_LIMIT, source: 'fallback' })
    expect(result.reason).toContain('boom')
  })

  it('falls back when there is no active row', async () => {
    const { client } = makeRegistryFake({ row: null })
    const result = await getDailyVerificationLimit(client)
    expect(result).toMatchObject({ limit: FALLBACK_DAILY_VERIFICATION_LIMIT, source: 'fallback' })
    expect(result.reason).toContain('no active')
  })

  it('falls back when the key is absent, including on a row whose other config is fine', async () => {
    const { client } = makeRegistryFake({ row: { config: { rate_limit_per_minute: 30 } } })
    const result = await getDailyVerificationLimit(client)
    expect(result).toMatchObject({ limit: FALLBACK_DAILY_VERIFICATION_LIMIT, source: 'fallback' })
    expect(result.reason).toContain(DAILY_VERIFICATION_LIMIT_KEY)
  })

  it('falls back when the config row still carries only the retired free-tier key', async () => {
    // The migration renames free_daily_limit to daily_verification_limit. If it has not been
    // applied, the code must fall back rather than read the retired key, so the two halves
    // can land in either order without a silent wrong answer.
    const { client } = makeRegistryFake({ row: { config: { free_daily_limit: 100 } } })
    const result = await getDailyVerificationLimit(client)
    expect(result).toMatchObject({ limit: FALLBACK_DAILY_VERIFICATION_LIMIT, source: 'fallback' })
  })

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 12.5],
    ['a numeric string', '500'],
    ['null', null],
    ['a boolean', true],
  ])('falls back rather than coercing when the value is %s', async (_label, value) => {
    // A mistyped config row must not become either a stalled sweep (0) or a coerced number.
    const { client } = makeRegistryFake({ row: withLimit(value) })
    const result = await getDailyVerificationLimit(client)
    expect(result.limit).toBe(FALLBACK_DAILY_VERIFICATION_LIMIT)
    expect(result.source).toBe('fallback')
  })

  it('falls back when the client throws outright', async () => {
    const { client } = makeRegistryFake({ throwFromFrom: true })
    const result = await getDailyVerificationLimit(client)
    expect(result).toMatchObject({ limit: FALLBACK_DAILY_VERIFICATION_LIMIT, source: 'fallback' })
    expect(result.reason).toContain('Network error')
  })

  it('never returns a bigger budget than the compiled default when it could not read one', async () => {
    // Direction of caution. Verification is resumable on the next sweep; an overrun is not.
    for (const opts of [{ error: { message: 'x' } }, { row: null }, { throwFromFrom: true }]) {
      const { client } = makeRegistryFake(opts)
      const { limit } = await getDailyVerificationLimit(client)
      expect(limit).toBeLessThanOrEqual(FALLBACK_DAILY_VERIFICATION_LIMIT)
    }
  })
})
