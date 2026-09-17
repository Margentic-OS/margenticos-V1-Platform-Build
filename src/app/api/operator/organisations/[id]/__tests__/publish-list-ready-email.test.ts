// THE LIST_READY EMAIL, END TO END THROUGH THE PUBLISH ROUTE.
//
// THE BUG. notifications_log.subject_id is `uuid`. Both publish routes built a readable
// batch key, `list_ready_${date}_${hour}`, and passed it straight in. Postgres rejected
// every one with 22P02, claimNotification returned 'failed', and the route then correctly
// refused to send, because an unrecorded send cannot be deduplicated. A fail-closed gate on
// a precondition that could never be met. Measured on production 2026-09-16: 34 prospects
// published, 0 list_ready rows ever written for that organisation.
//
// WHY THE EXISTING TESTS DID NOT CATCH IT. src/lib/notifications/__tests__ has a good fake
// that honours the unique index and returns a real 23505, but it accepts ANY string as a
// subject, because nothing in it models the column TYPE. The production code was wrong and
// the fake was structurally incapable of noticing. Same shape as "a fake that does not
// honour a filter cannot test that filter".
//
// SO THE FAKE HERE REJECTS A NON-UUID WITH 22P02, exactly as the column does. That single
// property is what makes this a mutation proof: put the raw batchId back and the email
// count goes to zero.
//
// Fixtures are industry-neutral and invented.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const ORG = '0a111111-2222-4333-8444-555555555555'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// vi.hoisted, because vi.mock factories are hoisted above every other statement and a
// plain `const` here is not initialised when the factory runs. The first draft used one
// and the suite failed to collect with "Cannot access 'sendTransactionalEmail' before
// initialization" — a load error, which reports as a failed FILE with zero failed tests.
const { sendTransactionalEmail } = vi.hoisted(() => ({
  sendTransactionalEmail: vi.fn(async () => ({ ok: true })),
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }))
// importOriginal rather than a bare factory: a whole-module mock drops every export the
// factory does not name, so an unrelated import from this module elsewhere in the graph
// would break on a change that has nothing to do with this test.
vi.mock('@/lib/email/send', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/email/send')>()),
  sendTransactionalEmail,
}))

interface NotificationRow { organisation_id: string; notification_type: string; subject_id: string }

/** Survives between POSTs within a test, so the second publish meets the first claim. */
let notificationRows: NotificationRow[] = []
/** Simulates a claim that fails for a reason other than uniqueness, e.g. the old 42501. */
let forcedClaimError: { code: string; message: string } | null = null
let unpublishedCount = 0

function serviceClient() {
  return {
    from(table: string) {
      if (table === 'notifications_log') {
        return {
          insert: async (row: NotificationRow) => {
            if (forcedClaimError) return { error: forcedClaimError }
            // THE COLUMN IS uuid. This is the whole point of this fake.
            if (!UUID_RE.test(row.subject_id)) {
              return {
                error: {
                  code: '22P02',
                  message: 'invalid input syntax for type uuid: "' + row.subject_id + '"',
                },
              }
            }
            const clash = notificationRows.some(
              r => r.organisation_id === row.organisation_id &&
                   r.notification_type === row.notification_type &&
                   r.subject_id === row.subject_id,
            )
            if (clash) return { error: { code: '23505', message: 'duplicate key value' } }
            notificationRows.push(row)
            return { error: null }
          },
        }
      }
      if (table !== 'prospects') throw new Error('fake: unexpected table ' + table)
      return {
        update: () => {
          const b: Record<string, unknown> = {
            eq: () => b,
            is: () => b,
            not: () => b,
            select: async () => {
              // Only step 1 reports new rows; the backfill that follows returns none.
              const n = unpublishedCount
              unpublishedCount = 0
              return { data: Array.from({ length: n }, (_, i) => ({ id: 'p' + i })), error: null }
            },
            then: (resolve: (v: unknown) => void) => resolve({ error: null }),
          }
          return b
        },
        select: () => {
          const b: Record<string, unknown> = {
            eq: () => b,
            not: () => b,
            then: (resolve: (v: unknown) => void) => resolve({ count: 12, error: null }),
          }
          return b
        },
      }
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'op-1' } }, error: null }) },
    from: (table: string) => {
      if (table === 'users') {
        return {
          select: (cols: string) => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: { email: 'client@example.invalid' }, error: null }),
              }),
              single: async () =>
                cols.includes('role')
                  ? { data: { role: 'operator' }, error: null }
                  : { data: { email: 'client@example.invalid' }, error: null },
            }),
          }),
        }
      }
      if (table === 'organisations') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: {
                  id: ORG,
                  name: 'Test Client',
                  founder_first_name: 'Robin',
                  client_review_enabled: true,
                },
                error: null,
              }),
            }),
          }),
        }
      }
      throw new Error('session fake: unexpected table ' + table)
    },
  })),
}))

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => serviceClient()) }))

import { POST } from '../publish-all-tiers/route'
import { deriveSubjectId } from '@/lib/notifications/claim-notification'

const req = () => ({}) as never
const ctx = () => ({ params: Promise.resolve({ id: ORG }) })

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  notificationRows = []
  forcedClaimError = null
  unpublishedCount = 3
  sendTransactionalEmail.mockClear()
})

describe('publish-all-tiers: the list_ready email', () => {
  it('a successful claim sends the email exactly once', async () => {
    const res = await POST(req(), ctx())

    expect(res.status).toBe(200)
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(notificationRows).toHaveLength(1)
    // MUTATION PROOF: pass the raw batchId instead of deriving it, the insert comes back
    // 22P02, the claim fails, and this drops to 0 sends.
    expect(notificationRows[0].subject_id).toMatch(UUID_RE)
    expect(notificationRows[0].notification_type).toBe('list_ready')
  })

  it('a second publish in the same window does NOT send a duplicate', async () => {
    await POST(req(), ctx())
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)

    unpublishedCount = 3 // more rows published, same hour
    await POST(req(), ctx())

    // The unique index arbitrates: the second claim returns 23505, so 'already_sent'.
    // MUTATION PROOF for the dedup property: swap deriveSubjectId for crypto.randomUUID()
    // and this becomes 2, because every publish would claim a fresh subject.
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(notificationRows).toHaveLength(1)
  })

  it('a genuinely failed claim still refuses to send', async () => {
    // Not a uniqueness clash. This is the 42501 shape the code used to hit through a
    // session client. An unrecorded send cannot be deduplicated, so it must not go.
    forcedClaimError = { code: '42501', message: 'permission denied for table notifications_log' }

    const res = await POST(req(), ctx())

    expect(res.status).toBe(200) // the publish itself still succeeds
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(notificationRows).toHaveLength(0)
  })
})

describe('deriveSubjectId', () => {
  it('is deterministic, which is what preserves the dedup window', () => {
    expect(deriveSubjectId('list_ready_2026-09-16_20')).toBe(
      deriveSubjectId('list_ready_2026-09-16_20'),
    )
  })

  it('separates different windows, so a later publish can notify again', () => {
    expect(deriveSubjectId('list_ready_2026-09-16_20')).not.toBe(
      deriveSubjectId('list_ready_2026-09-16_21'),
    )
  })

  it('produces a value the uuid column accepts, which the raw key never did', () => {
    expect(deriveSubjectId('list_ready_2026-09-16_20')).toMatch(UUID_RE)
    expect('list_ready_2026-09-16_20').not.toMatch(UUID_RE)
  })
})
