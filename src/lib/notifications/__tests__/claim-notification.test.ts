// Tests for claimNotification.
//
// The bug: three callers claimed one-time notifications through the SESSION client
// against notifications_log, which is service-role only (RLS on, zero policies). Every
// insert failed 42501. The two publish routes discarded that error and gated the send on
// a SELECT that could therefore never find anything, so the dedup never applied and every
// invocation sent. updateWarmupCompletedAt gated on the insert instead and so never sent
// at all.
//
// The fake below ENFORCES unique_notification_per_subject
// (organisation_id, notification_type, subject_id) and returns a real 23505 on the second
// insert, because a fake that accepts every insert cannot test a uniqueness guard. It also
// THROWS on any method it does not implement rather than returning itself, so a query
// shape this file did not anticipate fails loudly instead of silently passing.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { claimNotification } from '../claim-notification'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

type Row = { organisation_id: string; notification_type: string; subject_id: string }

/**
 * In-memory notifications_log that honours the unique index, the way Postgres does.
 * `forcedError` simulates a non-unique failure such as the 42501 this code used to hit.
 */
function makeNotificationsLogFake(forcedError?: { code: string; message: string }) {
  const rows: Row[] = []

  const client = {
    from: (table: string) => {
      if (table !== 'notifications_log') {
        throw new Error(`fake: unexpected table ${table}`)
      }
      return {
        insert: async (row: Row) => {
          if (forcedError) return { error: forcedError }
          const clash = rows.some(
            r =>
              r.organisation_id === row.organisation_id &&
              r.notification_type === row.notification_type &&
              r.subject_id === row.subject_id,
          )
          if (clash) {
            return {
              error: {
                code: '23505',
                message:
                  'duplicate key value violates unique constraint "unique_notification_per_subject"',
              },
            }
          }
          rows.push(row)
          return { error: null }
        },
        select: () => {
          throw new Error('fake: .select() not implemented — the claim must be an INSERT, not a SELECT')
        },
        upsert: () => {
          throw new Error('fake: .upsert() not implemented — upsert would defeat the unique guard')
        },
      }
    },
  }

  return { client: client as unknown as ServiceRoleClient, rows }
}

const PARAMS = {
  organisationId: '0ed34697-0fa9-4f08-ac15-d3504ac45caf',
  notificationType: 'list_ready',
  subjectId: 'list_ready_2026-09-01_14',
}

describe('claimNotification', () => {
  beforeEach(() => vi.clearAllMocks())

  it('claims on the first call', async () => {
    const { client, rows } = makeNotificationsLogFake()
    expect(await claimNotification(client, PARAMS)).toBe('claimed')
    expect(rows).toHaveLength(1)
  })

  // ── The assertion this whole task is about ────────────────────────────────

  it('does NOT claim twice for the same marker: the second call hits 23505', async () => {
    const { client, rows } = makeNotificationsLogFake()

    const first = await claimNotification(client, PARAMS)
    const second = await claimNotification(client, PARAMS)

    expect(first).toBe('claimed')
    expect(second).toBe('already_sent')
    // Exactly one marker, so exactly one send. This is the property that was absent.
    expect(rows).toHaveLength(1)
  })

  it('only one of many concurrent claims wins', async () => {
    const { client, rows } = makeNotificationsLogFake()

    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimNotification(client, PARAMS)),
    )

    expect(results.filter(r => r === 'claimed')).toHaveLength(1)
    expect(results.filter(r => r === 'already_sent')).toHaveLength(4)
    expect(rows).toHaveLength(1)
  })

  it('treats a different subject_id as a separate notification', async () => {
    const { client, rows } = makeNotificationsLogFake()

    expect(await claimNotification(client, PARAMS)).toBe('claimed')
    expect(await claimNotification(client, { ...PARAMS, subjectId: 'list_ready_2026-09-02_09' })).toBe('claimed')
    expect(rows).toHaveLength(2)
  })

  it('treats a different organisation as a separate notification', async () => {
    const { client, rows } = makeNotificationsLogFake()

    expect(await claimNotification(client, PARAMS)).toBe('claimed')
    expect(await claimNotification(client, { ...PARAMS, organisationId: 'other-org' })).toBe('claimed')
    expect(rows).toHaveLength(2)
  })

  // ── The original failure, reproduced ──────────────────────────────────────

  it("returns 'failed', NOT 'claimed', on the 42501 the session client used to produce", async () => {
    // This is exactly what notifications_log returned to the session client: RLS/grant
    // denial. The caller must not send, because an unrecorded send repeats forever.
    const { client, rows } = makeNotificationsLogFake({
      code: '42501',
      message: 'permission denied for table notifications_log',
    })

    const result = await claimNotification(client, PARAMS)

    expect(result).toBe('failed')
    expect(result).not.toBe('claimed')
    expect(rows).toHaveLength(0)
  })

  it("returns 'failed' on an unexpected error rather than assuming it is safe to send", async () => {
    const { client } = makeNotificationsLogFake({ code: '08006', message: 'connection failure' })
    expect(await claimNotification(client, PARAMS)).toBe('failed')
  })

  it("distinguishes 'failed' from 'already_sent' — they must not collapse", async () => {
    const { client: denied } = makeNotificationsLogFake({ code: '42501', message: 'permission denied' })
    const { client: fresh } = makeNotificationsLogFake()

    await claimNotification(fresh, PARAMS)

    // A denied claim and a duplicate claim both mean "do not send", but only one of them
    // means the mail already went. Collapsing them is how a permanent failure gets read
    // as healthy dedup and nobody notices the email stopped.
    expect(await claimNotification(denied, PARAMS)).toBe('failed')
    expect(await claimNotification(fresh, PARAMS)).toBe('already_sent')
  })
})
