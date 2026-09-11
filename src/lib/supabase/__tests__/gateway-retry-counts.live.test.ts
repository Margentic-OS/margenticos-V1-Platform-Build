// record_gateway_retry against the real test database: it adds, it keeps one row per day
// and method, and it refuses a method the retry never uses.
//
// Uses OPTIONS, which nothing in the app retries in practice, so a concurrent run of the app
// against the test database cannot move this row between the two reads. The assertion is
// "at least two" rather than "exactly two" in case another run of this same file overlaps.

import { describe, it, expect } from 'vitest'
import { createTestServiceClient } from '@/test-utils/test-database'

describe('record_gateway_retry (live)', () => {
  const supabase = createTestServiceClient('gateway-retry-counts.live.test.ts')
  const today = new Date().toISOString().slice(0, 10)

  async function optionsCount(): Promise<number> {
    const { data, error } = await supabase
      .from('gateway_retry_counts')
      .select('retries')
      .eq('day', today)
      .eq('method', 'OPTIONS')
      .maybeSingle()
    if (error) throw new Error(`could not read gateway_retry_counts: ${error.message}`)
    return data?.retries ?? 0
  }

  it('each call adds one to today\'s row for that method', async () => {
    const before = await optionsCount()

    for (let i = 0; i < 2; i++) {
      const { error } = await supabase.rpc('record_gateway_retry', { p_method: 'OPTIONS' })
      expect(error).toBeNull()
    }

    expect(await optionsCount()).toBeGreaterThanOrEqual(before + 2)
  })

  it('refuses a write method, because writes are never retried', async () => {
    const { error } = await supabase.rpc('record_gateway_retry', { p_method: 'POST' })
    expect(error?.code).toBe('23514')
  })
})
