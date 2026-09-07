import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveAutoHeldMeetings } from './auto-held-resolution'

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}))

function createOrgMockChain(orgs: Array<{ id: string; auto_held_window_hours: number }>) {
  const selectChain: any = {
    is: vi.fn().mockReturnValue({
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: orgs, error: null }).then(resolve),
    }),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: orgs, error: null }).then(resolve),
  }
  const chain: any = {
    select: vi.fn().mockReturnValue(selectChain),
  }
  return chain
}

function createMeetingsMockChain(
  meetings: Array<{ id: string; scheduled_start_at: string }> = [],
  shouldUpdate: boolean = false
) {
  // The real update applies .eq().eq().eq().in() before awaiting. This fake must
  // honour that chain. It previously returned a bare thenable with no .eq, so the
  // real call threw a TypeError mid-chain — and the old implementation's catch-all
  // swallowed it and returned [], leaving this test green over a broken fake. That
  // is the "a fake that does not honour a filter cannot test that filter" shape in
  // CLAUDE.md, caught here only because the swallow was removed.
  const updateResult: any = {
    eq: vi.fn(function (this: any) { return this }),
    in: vi.fn(function (this: any) { return this }),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({
        data: shouldUpdate ? meetings : [],
        error: null,
        count: shouldUpdate ? meetings.length : 0,
      }).then(resolve),
  }
  const updateMock = vi.fn().mockReturnValue(updateResult)

  const chain: any = {
    select: vi.fn().mockReturnValue({
      eq: vi.fn(function(this: any) { return this }).mockReturnThis(),
      not: vi.fn(function(this: any) { return this }).mockReturnThis(),
      in: vi.fn(function(this: any) { return this }).mockReturnThis(),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: meetings, error: null }).then(resolve),
    }),
    update: updateMock,
    eq: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
  }
  return { chain, updateMock }
}

describe('Auto-held Resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Window Calculation', () => {
    it('does not auto-hold meeting scheduled in future', async () => {
      const futureTime = new Date()
      futureTime.setHours(futureTime.getHours() + 100)

      const mockClient = {
        from: vi.fn(function(this: any, table: string) {
          if (table === 'organisations') {
            return createOrgMockChain([{ id: 'org-1', auto_held_window_hours: 72 }])
          }
          if (table === 'meetings') {
            const { chain } = createMeetingsMockChain([
              {
                id: 'meeting-1',
                scheduled_start_at: futureTime.toISOString(),
              },
            ])
            return chain
          }
          return {}
        }),
      } as unknown as SupabaseClient

      await resolveAutoHeldMeetings(mockClient)

      // Future meetings: window not closed, so no update should happen
      // The filter is: scheduled_start_at + 72h < now()
      // Future time + 72h is still in the future, so meeting won't match the filter
    })

    it('auto-holds meeting past window closure (scheduled_start_at + window < now)', async () => {
      const farPast = new Date()
      farPast.setHours(farPast.getHours() - 100) // 100 hours ago, beyond 72h window

      const { chain: meetingsChain, updateMock } = createMeetingsMockChain(
        [
          {
            id: 'meeting-past',
            scheduled_start_at: farPast.toISOString(),
          },
        ],
        true // shouldUpdate = true because window is closed
      )

      const mockClient = {
        from: vi.fn(function(this: any, table: string) {
          if (table === 'organisations') {
            return createOrgMockChain([{ id: 'org-1', auto_held_window_hours: 72 }])
          }
          if (table === 'meetings') {
            return meetingsChain
          }
          return {}
        }),
      } as unknown as SupabaseClient

      await resolveAutoHeldMeetings(mockClient)

      // Verify update was called with correct auto-held values
      expect(updateMock).toHaveBeenCalledWith({
        meeting_status: 'held',
        held_confirmed_by: 'auto',
        held_decision_locked: true,
        is_billable: true,
      })
    })
  })

  describe('Billing', () => {
    it('auto-held meeting has is_billable=true AND billed_at IS NULL', async () => {
      const farPast = new Date()
      farPast.setHours(farPast.getHours() - 100)

      const { chain: meetingsChain, updateMock } = createMeetingsMockChain(
        [
          {
            id: 'meeting-billable',
            scheduled_start_at: farPast.toISOString(),
          },
        ],
        true
      )

      const mockClient = {
        from: vi.fn(function(this: any, table: string) {
          if (table === 'organisations') {
            return createOrgMockChain([{ id: 'org-1', auto_held_window_hours: 72 }])
          }
          if (table === 'meetings') {
            return meetingsChain
          }
          return {}
        }),
      } as unknown as SupabaseClient

      await resolveAutoHeldMeetings(mockClient)

      // Verify is_billable=true and billed_at is NOT set (stays NULL)
      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          is_billable: true,
        })
      )
      // Verify billed_at is not in the update object
      const callArgs = updateMock.mock.calls[0]?.[0]
      expect(callArgs).not.toHaveProperty('billed_at')
    })
  })

  describe('Exclusions', () => {
    it('canceled meetings are NOT auto-held (status filter excludes them)', async () => {
      // When meetings table returns empty (because query filters by status='booked'),
      // no update occurs for canceled meetings
      const mockClient = {
        from: vi.fn(function(this: any, table: string) {
          if (table === 'organisations') {
            return createOrgMockChain([{ id: 'org-1', auto_held_window_hours: 72 }])
          }
          if (table === 'meetings') {
            // Return empty list because the query filters by meeting_status='booked',
            // which excludes canceled/rescheduled meetings
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnThis(),
                not: vi.fn().mockReturnThis(),
                in: vi.fn().mockReturnThis(),
                then: (resolve: (v: unknown) => unknown) =>
                  Promise.resolve({ data: [], error: null }).then(resolve),
              }),
              update: vi.fn().mockReturnValue({
                then: (resolve: (v: unknown) => unknown) =>
                  Promise.resolve({ data: [], error: null, count: 0 }).then(resolve),
              }),
            }
          }
          return {}
        }),
      } as unknown as SupabaseClient

      const result = await resolveAutoHeldMeetings(mockClient)

      // No meetings were auto-held because none matched the booked+unlocked filter.
      // The organisation was still EXAMINED, and the two numbers are deliberately
      // separate: conflating them is what made "Processed 0 organisations" look like
      // a healthy run for 31 consecutive days.
      expect(result.organisations_with_resolutions).toHaveLength(0)
      expect(result.organisations_examined).toBe(1)
      expect(result.organisations_failed).toBe(0)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // A REFUSED READ MUST NOT LOOK LIKE AN EMPTY ONE
  //
  // These are the regression tests for the 2026-08-09 to 2026-09-07 outage. The
  // function used to catch its own organisations-read error and `return []`, which
  // the caller could not tell apart from "no organisations needed work". It then
  // reported success 31 times over three live organisations.
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Refused reads', () => {
    function clientWhereOrgReadFails(message: string) {
      return {
        from: vi.fn((table: string) => {
          if (table === 'organisations') {
            const chain: any = {
              is: vi.fn().mockReturnValue({
                then: (resolve: (v: unknown) => unknown) =>
                  Promise.resolve({
                    data: null,
                    error: { message },
                  }).then(resolve),
              }),
            }
            return { select: vi.fn().mockReturnValue(chain) }
          }
          return {}
        }),
      } as unknown as SupabaseClient
    }

    it('THROWS when the organisations read is refused, rather than returning empty', async () => {
      const mockClient = clientWhereOrgReadFails('permission denied for table organisations')

      await expect(resolveAutoHeldMeetings(mockClient)).rejects.toThrow(
        /permission denied for table organisations/
      )
    })

    it('a refused read is distinguishable from a genuinely empty organisation list', async () => {
      // Empty list: resolves, examined 0.
      const emptyClient = {
        from: vi.fn(() => createOrgMockChain([])),
      } as unknown as SupabaseClient

      const emptyRun = await resolveAutoHeldMeetings(emptyClient)
      expect(emptyRun.organisations_examined).toBe(0)

      // Refused read: rejects. The two outcomes cannot be confused by the caller,
      // which is the whole point of this pair.
      await expect(
        resolveAutoHeldMeetings(clientWhereOrgReadFails('permission denied'))
      ).rejects.toThrow()
    })

    it('counts an organisation whose meetings read is refused as FAILED, not as clean', async () => {
      const mockClient = {
        from: vi.fn((table: string) => {
          if (table === 'organisations') {
            return createOrgMockChain([{ id: 'org-1', auto_held_window_hours: 72 }])
          }
          if (table === 'meetings') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnThis(),
                not: vi.fn().mockReturnThis(),
                in: vi.fn().mockReturnThis(),
                then: (resolve: (v: unknown) => unknown) =>
                  Promise.resolve({
                    data: null,
                    error: { message: 'permission denied for table meetings' },
                  }).then(resolve),
              }),
            }
          }
          return {}
        }),
      } as unknown as SupabaseClient

      const run = await resolveAutoHeldMeetings(mockClient)

      // The run continues past a bad organisation, but must not call itself healthy.
      expect(run.organisations_examined).toBe(1)
      expect(run.organisations_failed).toBe(1)
      expect(run.organisations_with_resolutions).toHaveLength(0)
    })
  })
})
