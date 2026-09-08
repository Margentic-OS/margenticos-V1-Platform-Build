// A stand-in for the search provider, for tests that must not touch the network.
//
// ─── IT ANSWERS THE QUESTION IT WAS ASKED, OR IT THROWS ──────────────────────
//
// CLAUDE.md records three separate defects caused by a fake that silently accepted a filter
// it did not implement: the production code kept applying the filter, the fake ignored it,
// and the test stayed green in both worlds. So this one is built the other way round.
//
// `populationFor` receives the WHOLE request object, so every constraint the code under test
// applies is visible to the answer. A test that wants to assert differencing behaviour has to
// write a function that actually differs by constraint; there is no way to write one that
// ignores a parameter and still produces the numbers the test expects.
//
// And a request that reaches it with no recognisable shape throws rather than returning a
// default, because a default here is indistinguishable from a measurement.

import { vi } from 'vitest'

export interface FakeProviderOptions {
  /** The population for a given request. Receives the whole request. */
  populationFor: (request: Record<string, unknown>) => number
  /** Rows to return when a sample is asked for. Defaults to synthesised placeholder rows. */
  rowsFor?: (request: Record<string, unknown>, perPage: number) => unknown[]
  /** When set, every call after this many throws a 429. */
  rateLimitAfter?: number
}

export interface FakeProvider {
  /** Every request body the code under test sent, in order. */
  calls: Record<string, unknown>[]
  restore: () => void
}

/**
 * Placeholder rows. Employer names are synthesised from the index and name nothing.
 *
 * Deliberately NOT plausible-looking company names. A plausible one would be a real
 * organisation somewhere, and a fixture naming a real organisation is the thing Rule Zero
 * forbids.
 */
function defaultRows(perPage: number): unknown[] {
  return Array.from({ length: perPage }, (_, i) => ({
    id: `row-${i}`,
    first_name: `First${i}`,
    title: `Title-${i % 4}`,
    organization: { name: `Org-${i}` },
  }))
}

export function installFakeProvider(options: FakeProviderOptions): FakeProvider {
  const calls: Record<string, unknown>[] = []
  const original = global.fetch

  // The fake stands in for the provider, so it stands in for the provider's credential too.
  // Without this the code under test refuses before it reaches the fake, and every test in
  // the file fails for a reason that has nothing to do with what it is testing.
  const originalKey = process.env.APOLLO_API_KEY
  process.env.APOLLO_API_KEY = 'fake-key-for-tests'

  global.fetch = vi.fn(async (_url: unknown, init: unknown) => {
    const body = JSON.parse(((init as { body: string }).body)) as Record<string, unknown>
    calls.push(body)

    if (options.rateLimitAfter !== undefined && calls.length > options.rateLimitAfter) {
      return {
        ok: false, status: 429,
        headers: { get: () => '30' },
        text: async () => 'rate limited',
      } as unknown as Response
    }

    const total = options.populationFor(body)
    if (!Number.isFinite(total)) {
      throw new Error('fake provider: populationFor returned no number for this request')
    }

    const perPage = typeof body.per_page === 'number' ? body.per_page : 1
    const people = options.rowsFor
      ? options.rowsFor(body, perPage)
      : defaultRows(Math.min(perPage, Math.max(0, total)))

    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ total_entries: total, people }),
      text: async () => '',
    } as unknown as Response
  }) as unknown as typeof fetch

  return {
    calls,
    restore: () => {
      global.fetch = original
      if (originalKey === undefined) delete process.env.APOLLO_API_KEY
      else process.env.APOLLO_API_KEY = originalKey
    },
  }
}

/** A judge that must never be called. Used to prove an ordering claim rather than assume it. */
export const forbiddenJudge = async (): Promise<never> => {
  throw new Error(
    'The judge was called. Round zero is supposed to reach its conclusion without one, so ' +
    'this is the ordering being wrong rather than a test being wrong.',
  )
}
