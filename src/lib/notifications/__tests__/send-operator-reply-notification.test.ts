// The operator is told about every reply, and the client is not emailed.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE THREE DEFECTS THESE LOCK OUT, all measured 2026-09-04
//
//   RECIPIENT   The module this replaces selected `users` where role = 'client'. Searched
//               the whole notification and reply-handling layer: no path anywhere notified
//               an operator about a reply. The person who must act received nothing.
//
//   FREQUENCY   subject_id was the ORGANISATION id under UNIQUE
//               (organisation_id, notification_type, subject_id), so it fired once per
//               organisation for ever. Production held one such row from 2026-09-03, which
//               meant no future reply for that client could ever notify anyone. The Locked
//               decision says these recur for the life of the account.
//
//   COPY        The old body said "This is the only reply notification you'll get from me",
//               so repointing the recipient without rewriting would have promised an
//               operator never to tell them again.
//
// MUTATION-PROVED. Changing the recipient filter back to 'client', or the dedup key back to
// the organisation id, each turns a named test below red.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

const sendTransactionalEmail = vi.hoisted(() =>
  vi.fn(async (_args: { to: string; subject: string; html: string; text?: string }) =>
    ({ success: true, error: null as string | null }))
)
vi.mock('@/lib/email/send', () => ({ sendTransactionalEmail }))

import { sendOperatorReplyNotification } from '../send-operator-reply-notification'

const OPERATOR_EMAIL = 'operator@platform.invalid'
const CLIENT_EMAIL = 'client@client.invalid'

interface LogRow { organisation_id: string; notification_type: string; subject_id: string }

/* eslint-disable @typescript-eslint/no-explicit-any */
function createFakeDb(opts: { existingLog?: LogRow[]; noOperator?: boolean } = {}) {
  const logRows: LogRow[] = [...(opts.existingLog ?? [])]
  // Every role the code asked for, recorded. This is what makes the recipient assertion
  // real rather than incidental: a fake that ignored .eq('role', …) would hand back the
  // operator address whatever the production code selected.
  const rolesQueried: string[] = []

  const client: any = {
    logRows,
    rolesQueried,
    from(table: string) {
      if (table === 'organisations') {
        const b: any = {
          select: () => b, eq: () => b,
          single: async () => ({ data: { name: 'Test Organisation' }, error: null }),
        }
        return b
      }
      if (table === 'prospects') {
        const b: any = {
          select: () => b, eq: () => b,
          single: async () => ({ data: { first_name: 'Sam', company_name: 'Test Prospect Company' }, error: null }),
        }
        return b
      }
      if (table === 'users') {
        let role: string | null = null
        const b: any = {
          select: () => b,
          eq: (col: string, val: string) => { if (col === 'role') { role = val; rolesQueried.push(val) } return b },
          limit: () => b,
          single: async () => {
            if (role === 'operator') {
              return opts.noOperator
                ? { data: null, error: { message: 'no rows' } }
                : { data: { email: OPERATOR_EMAIL }, error: null }
            }
            if (role === 'client') return { data: { email: CLIENT_EMAIL }, error: null }
            return { data: null, error: { message: 'no rows' } }
          },
        }
        return b
      }
      if (table === 'notifications_log') {
        const filters: Record<string, string> = {}
        const b: any = {
          select: () => b,
          eq: (col: string, val: string) => { filters[col] = val; return b },
          single: async () => {
            const hit = logRows.find(r =>
              r.organisation_id === filters.organisation_id &&
              r.notification_type === filters.notification_type &&
              r.subject_id === filters.subject_id)
            return hit ? { data: { id: 'x' }, error: null } : { data: null, error: null }
          },
          // Honours the real UNIQUE (organisation_id, notification_type, subject_id).
          insert: async (row: LogRow) => {
            const clash = logRows.some(r =>
              r.organisation_id === row.organisation_id &&
              r.notification_type === row.notification_type &&
              r.subject_id === row.subject_id)
            if (clash) return { error: { code: '23505', message: 'notifications_log unique' } }
            logRows.push(row)
            return { error: null }
          },
        }
        return b
      }
      throw new Error(`fake does not implement table ${table}`)
    },
  }
  return client
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function call(db: unknown, over: Partial<Parameters<typeof sendOperatorReplyNotification>[0]> = {}) {
  return sendOperatorReplyNotification({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: db as any,
    organisationId: 'org-1',
    signalId: 'signal-1',
    prospectId: 'prospect-1',
    classifiedIntent: 'positive_passive',
    signalCreatedAt: '2026-09-05T00:00:00Z',
    ...over,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  sendTransactionalEmail.mockResolvedValue({ success: true, error: null })
})

describe('the operator is the recipient, and the client is not emailed', () => {
  it('sends to the operator address', async () => {
    const db = createFakeDb()
    const result = await call(db)

    expect(result.sent).toBe(true)
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(sendTransactionalEmail.mock.calls[0][0].to).toBe(OPERATOR_EMAIL)
  })

  it('never sends to the client address, and never queries for a client user', async () => {
    const db = createFakeDb()
    await call(db)

    expect(sendTransactionalEmail.mock.calls[0][0].to).not.toBe(CLIENT_EMAIL)
    // The stronger assertion: the client role is not even looked up. A recipient that is
    // merely unused today is one refactor away from being used again.
    expect(db.rolesQueried).toContain('operator')
    expect(db.rolesQueried).not.toContain('client')
  })

  it('does not send, loudly, when no operator can be resolved', async () => {
    const db = createFakeDb({ noOperator: true })
    const result = await call(db)

    // Failing closed matters here: silently falling back to any other user would mean
    // mailing a client an internal operator alert.
    expect(result.sent).toBe(false)
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })
})

describe('one notification per reply event, not one per account lifetime', () => {
  it('sends again for a DIFFERENT reply in the same organisation', async () => {
    const db = createFakeDb()

    await call(db, { signalId: 'signal-1' })
    await call(db, { signalId: 'signal-2' })

    // Under the old organisation-keyed dedup the second call was silently dropped, for
    // ever. This is the assertion the Locked decision requires.
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(2)
    expect(db.logRows.map((r: LogRow) => r.subject_id)).toEqual(['signal-1', 'signal-2'])
  })

  it('does not send twice for the SAME reply', async () => {
    const db = createFakeDb()

    await call(db, { signalId: 'signal-1' })
    await call(db, { signalId: 'signal-1' })

    // Reply processing retries, so the same signal genuinely does arrive here more than
    // once. Idempotency has to survive that.
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
  })

  it('is not blocked by the spent organisation-keyed row from the old notification', async () => {
    // The exact row production carries: type 'first_reply', subject_id = the organisation.
    const db = createFakeDb({
      existingLog: [{ organisation_id: 'org-1', notification_type: 'first_reply', subject_id: 'org-1' }],
    })

    const result = await call(db)

    // Changing the TYPE as well as the key is what makes this safe with no migration:
    // the old row cannot collide with the new one.
    expect(result.sent).toBe(true)
    expect(db.logRows.some((r: LogRow) => r.notification_type === 'reply_needs_action')).toBe(true)
  })

  it('keys the log row on the signal, not the organisation', async () => {
    const db = createFakeDb()
    await call(db, { signalId: 'signal-42' })

    const row = db.logRows.find((r: LogRow) => r.notification_type === 'reply_needs_action')
    expect(row!.subject_id).toBe('signal-42')
    expect(row!.subject_id).not.toBe('org-1')
  })
})

describe('the backfill guard survives the rewrite', () => {
  it('does not notify for an event predating activation', async () => {
    const db = createFakeDb()
    const result = await call(db, { signalCreatedAt: '2026-01-01T00:00:00Z' })

    // Without this, replaying historical signals would mail the operator once per row for
    // every reply the system has ever seen.
    expect(result.sent).toBe(false)
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
  })
})

describe('the body tells the operator what to do', () => {
  it('names the client and links to the reply queue', async () => {
    const db = createFakeDb()
    await call(db)

    const { subject, text } = sendTransactionalEmail.mock.calls[0][0]
    expect(subject).toContain('Test Organisation')
    expect(text).toContain('/dashboard/operator/triage')

    // The replaced copy promised the defect. If that sentence ever returns, the email is
    // telling an operator it will not write again.
    expect(text).not.toContain('only reply notification')
  })
})
