import { describe, it, expect, vi } from 'vitest'
import { shouldUseMockEnrichment, getEnrichmentLiveFlag, setEnrichmentLiveFlag } from './enrichment-mode'

const createMockSupabase = (configData: any = {}, error: any = null) => {
  const isChain = vi.fn().mockResolvedValue({
    data: configData,
    error,
  })

  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          is: isChain,
        }),
      }),
    }),
  } as any
}

const createMockSupabaseForUpdate = (error: any = null) => {
  const eqChain = vi.fn().mockResolvedValue({
    error,
  })

  return {
    from: vi.fn().mockReturnValue({
      update: vi.fn().mockReturnValue({
        eq: eqChain,
      }),
    }),
  } as any
}

describe('enrichment-mode', () => {
  describe('shouldUseMockEnrichment', () => {
    it('returns true (mock mode) when enrichment_live is absent or false', async () => {
      const supabase = createMockSupabase({
        config: {},
      })

      const result = await shouldUseMockEnrichment(supabase, 'test-org')
      expect(result).toBe(true)
    })

    it('returns true (safe default) when enrichment_live flag is missing', async () => {
      const supabase = createMockSupabase({
        config: {},
      })

      const result = await shouldUseMockEnrichment(supabase, 'test-org')
      expect(result).toBe(true)
    })

    it('returns true (safe default) when registry lookup fails', async () => {
      const supabase = createMockSupabase(null, { message: 'Not found' })

      const result = await shouldUseMockEnrichment(supabase, 'test-org')
      expect(result).toBe(true)
    })

    it('returns true (safe default) on exception', async () => {
      const supabase = {
        from: vi.fn().mockImplementation(() => {
          throw new Error('Network error')
        }),
      } as any

      const result = await shouldUseMockEnrichment(supabase, 'test-org')
      expect(result).toBe(true)
    })
  })

  describe('getEnrichmentLiveFlag', () => {
    it('returns false on error (safe default for UI)', async () => {
      const supabase = createMockSupabase(null, { message: 'Error' })

      const result = await getEnrichmentLiveFlag(supabase)
      expect(result).toBe(false)
    })
  })

  describe('setEnrichmentLiveFlag', () => {
    it('sets enrichment_live flag to true', async () => {
      const supabase = createMockSupabaseForUpdate(null)

      await setEnrichmentLiveFlag(supabase, true)

      const updateCall = supabase.from().update
      expect(updateCall).toHaveBeenCalledWith({
        config: { enrichment_live: true },
      })
    })

    it('sets enrichment_live flag to false', async () => {
      const supabase = createMockSupabaseForUpdate(null)

      await setEnrichmentLiveFlag(supabase, false)

      const updateCall = supabase.from().update
      expect(updateCall).toHaveBeenCalledWith({
        config: { enrichment_live: false },
      })
    })

    it('throws on error', async () => {
      const supabase = createMockSupabaseForUpdate({ message: 'Update failed' })

      await expect(setEnrichmentLiveFlag(supabase, true)).rejects.toThrow(
        'Failed to set enrichment_live flag',
      )
    })
  })

})
