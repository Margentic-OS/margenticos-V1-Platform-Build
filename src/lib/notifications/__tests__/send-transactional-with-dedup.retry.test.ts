// A failed send must not block its own retry.
//
// THE DEFECT THIS LOCKS OUT.
//
// sendTransactionalEmailWithDedup wrote the notifications_log row, sent, and on failure
// returned { sent: false, reason: 'email_send_failed' } WITHOUT TOUCHING THE ROW. The row is
// the dedup key, so the next invocation found it and returned 'already_sent'. The
// notification was suppressed for ever by its own bookkeeping; nothing retried it, and the
// table recorded an intent to send as though it were a delivery.
//
// Three notification paths ran through this helper and all three inherited it:
// reply_needs_action (the operator's only reply alert), first_meeting, and the meeting
// outcome confirmation.
//
// The damage was once unbounded. sendFirstReplyEmail keyed on the ORGANISATION id, so one
// failed send meant that client could never be told about a reply again. Production still
// holds exactly one such row: notification_type 'first_reply', subject_id = the MargenticOS
// organisation id, written 2026-09-03. Re-keying to the signal id reduced the blast radius
// to one reply; this commit removes the permanence.
//
// MUTATION-PROVED. Delete the `await releaseNotificationClaim(...)` call in the
// !result.success branch of send-transactional-with-dedup.ts and
// 'retries on the next attempt after a failed send' goes red, with the second attempt
// returning already_sent and sendTransactionalEmail called only once.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// vi.hoisted, because vi.mock's factory is lifted above the const and would otherwise read
// it before initialisation.
const { sendTransactionalEmail } = vi.hoisted(() => ({ sendTransactionalEmail: vi.fn() }))
vi.mock('@/lib/email/send', () => ({ sendTransactionalEmail }))

import { sendTransactionalEmailWithDedup } from '../send-transactional-with-dedup'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'

const ORG = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'
const SUBJECT = 'd2b261b6-128d-46d6-aea9-aaf71974bea7'

// ── Fake notifications_log ────────────────────────────────────────────────────
//
// Models the UNIQUE (organisation_id, notification_type, subject_id) index faithfully,
// because the whole argument rests on it: the claim is the insert, and a second insert of
// the same key must come back 23505 rather than succeeding quietly.
//
// It also honours the delete's .eq() filters rather than clearing the table. A fake that
// ignored them would make a released-claim test pass even if the production code deleted the
// wrong row, which is the shape this codebase has been bitten by before.
function createFakeLog(opts: { failDelete?: boolean } = {}) {
  const rows: { organisation_id: string; notification_type: string; subject_id: string }[] = []
  const deleteCalls: Record<string, string>[] = []

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const client: any = {
    from(table: string) {
      if (table !== 'notifications_log') {
        throw new Error(`fake does not implement table ${table}`)
      }
      return {
        insert: async (row: { organisation_id: string; notification_type: string; subject_id: string }) => {
          const clash = rows.some(
            (r) =>
              r.organisation_id === row.organisation_id &&
              r.notification_type === row.notification_type &&
              r.subject_id === row.subject_id,
          )
          if (clash) {
            return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
          }
          rows.push(row)
          return { error: null }
        },
        delete: () => {
          const filters: Record<string, string> = {}
          const builder: any = {
            eq(column: string, value: string) {
              filters[column] = value
              return builder
            },
            // Awaiting the chain is what runs the delete.
            then(resolve: (v: { error: unknown }) => unknown) {
              deleteCalls.push({ ...filters })
              if (opts.failDelete) {
                return resolve({ error: { code: '42501', message: 'permission denied' } })
              }
              for (let i = rows.length - 1; i >= 0; i--) {
                const r = rows[i] as unknown as Record<string, string>
                if (Object.entries(filters).every(([k, v]) => r[k] === v)) rows.splice(i, 1)
              }
              return resolve({ error: null })
            },
          }
          return builder
        },
        // Anything else is not implemented, and must say so rather than chain silently.
        select: () => {
          throw new Error('fake does not implement select: the claim is an insert, never a read')
        },
      }
    },
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return { client: client as ServiceRoleClient, rows, deleteCalls }
}

function params(supabase: ServiceRoleClient) {
  return {
    supabase,
    organisationId: ORG,
    notificationType: 'reply_needs_action',
    subjectId: SUBJECT,
    to: 'operator@example.com',
    subject: 'A prospect replied',
    html: '<p>A prospect replied.</p>',
    audience: 'operator' as const,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a failed send releases its claim', () => {
  it('retries on the next attempt after a failed send', async () => {
    const fake = createFakeLog()

    sendTransactionalEmail.mockResolvedValueOnce({ success: false, error: 'Resend 500' })
    const first = await sendTransactionalEmailWithDedup(params(fake.client))

    expect(first).toEqual({ sent: false, reason: 'email_send_failed' })
    // THE LOAD-BEARING ASSERTION. Under the old code the row stood here for ever.
    expect(fake.rows).toHaveLength(0)

    sendTransactionalEmail.mockResolvedValueOnce({ success: true })
    const second = await sendTransactionalEmailWithDedup(params(fake.client))

    // The retry actually sent, rather than being told the mail had already gone.
    expect(second).toEqual({ sent: true })
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(2)
    expect(fake.rows).toHaveLength(1)
  })

  it('releases the exact claim and no other row', async () => {
    const fake = createFakeLog()

    // A neighbouring claim that must survive: same org and type, different subject.
    sendTransactionalEmail.mockResolvedValueOnce({ success: true })
    await sendTransactionalEmailWithDedup({
      ...params(fake.client),
      subjectId: 'aaaaaaaa-0000-0000-0000-000000000001',
    })
    expect(fake.rows).toHaveLength(1)

    sendTransactionalEmail.mockResolvedValueOnce({ success: false, error: 'Resend 500' })
    await sendTransactionalEmailWithDedup(params(fake.client))

    // The failed one is gone, the neighbour is untouched.
    expect(fake.rows.map((r) => r.subject_id)).toEqual(['aaaaaaaa-0000-0000-0000-000000000001'])
    expect(fake.deleteCalls).toEqual([
      {
        organisation_id: ORG,
        notification_type: 'reply_needs_action',
        subject_id: SUBJECT,
      },
    ])
  })

  it('releases the claim when the send throws, not only when it returns failure', async () => {
    const fake = createFakeLog()

    sendTransactionalEmail.mockRejectedValueOnce(new Error('socket hang up'))
    const first = await sendTransactionalEmailWithDedup(params(fake.client))

    expect(first).toEqual({ sent: false, reason: 'error' })
    expect(fake.rows).toHaveLength(0)

    sendTransactionalEmail.mockResolvedValueOnce({ success: true })
    expect(await sendTransactionalEmailWithDedup(params(fake.client))).toEqual({ sent: true })
  })
})

describe('what the release deliberately does NOT change', () => {
  it('a successful send keeps its claim, so a second attempt does not double-send', async () => {
    const fake = createFakeLog()

    sendTransactionalEmail.mockResolvedValueOnce({ success: true })
    expect(await sendTransactionalEmailWithDedup(params(fake.client))).toEqual({ sent: true })

    const second = await sendTransactionalEmailWithDedup(params(fake.client))

    // Duplicate mail to a client is not recoverable, so this direction must stay closed.
    expect(second).toEqual({ sent: false, reason: 'already_sent' })
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(fake.rows).toHaveLength(1)
  })

  it('a claim that cannot be recorded refuses to send rather than sending undeduplicated', async () => {
    const fake = createFakeLog()
    // Make the insert fail with something that is not a unique violation.
    const broken = {
      from: () => ({
        insert: async () => ({ error: { code: '42501', message: 'permission denied' } }),
      }),
    } as unknown as ServiceRoleClient

    const result = await sendTransactionalEmailWithDedup(params(broken))

    expect(result).toEqual({ sent: false, reason: 'error' })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(fake.rows).toHaveLength(0)
  })

  it('a failed release leaves the row, which is the old behaviour and no worse', async () => {
    const fake = createFakeLog({ failDelete: true })

    sendTransactionalEmail.mockResolvedValueOnce({ success: false, error: 'Resend 500' })
    const first = await sendTransactionalEmailWithDedup(params(fake.client))

    expect(first).toEqual({ sent: false, reason: 'email_send_failed' })
    // The row could not be removed, so this subject stays deduped. Recorded here so the
    // limit is explicit rather than discovered: releaseNotificationClaim logs it at error
    // because it is the one case where a notification is still permanently lost.
    expect(fake.rows).toHaveLength(1)

    const second = await sendTransactionalEmailWithDedup(params(fake.client))
    expect(second).toEqual({ sent: false, reason: 'already_sent' })
  })
})
