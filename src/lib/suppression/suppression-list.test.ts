// Tests for the global suppression list: normalisation, idempotency, revocation.
//
// These drive the real recordSuppression / lookupSuppressedEmails / revokeSuppression
// against a fake Supabase that enforces the SAME constraints the database enforces:
//   - the partial unique index on (email) WHERE revoked_at IS NULL
//   - the CHECK that stored email equals lower(btrim(email))
// A fake that accepted anything would prove nothing about idempotency or normalisation.

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  flush: vi.fn(() => Promise.resolve()),
}))

import {
  normaliseEmail,
  recordSuppression,
  lookupSuppressedEmails,
  revokeSuppression,
  isSuppressed,
} from './suppression-list'

interface FakeRow {
  id: string
  email: string
  reason: string
  source_org_id: string | null
  source_signal_id: string | null
  revoked_at: string | null
  revoked_reason: string | null
}

// A fake suppressed_emails table that reproduces the two constraints that matter.
function createFakeSuppressionDb(seed: FakeRow[] = []) {
  const rows: FakeRow[] = [...seed]
  let nextId = seed.length + 1

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const client: any = {
    from(table: string) {
      if (table !== 'suppressed_emails') throw new Error(`unexpected table ${table}`)

      // ── SELECT path ──
      const selectBuilder = (state: { emails?: string[]; activeOnly?: boolean }) => ({
        in(_col: string, values: string[]) {
          state.emails = values
          return selectBuilder(state)
        },
        is(_col: string, _v: null) {
          state.activeOnly = true
          return selectBuilder(state)
        },
        then(resolve: (v: unknown) => unknown) {
          const matched = rows.filter(r =>
            (state.emails ?? []).includes(r.email) &&
            (state.activeOnly ? r.revoked_at === null : true)
          )
          return resolve({ data: matched.map(r => ({ email: r.email })), error: null })
        },
      })

      // ── UPDATE path (revocation) ──
      const updateBuilder = (patch: Record<string, unknown>, state: { email?: string; activeOnly?: boolean }) => ({
        eq(_col: string, value: string) {
          state.email = value
          return updateBuilder(patch, state)
        },
        is(_col: string, _v: null) {
          state.activeOnly = true
          return updateBuilder(patch, state)
        },
        select(_cols: string) {
          const targets = rows.filter(r =>
            r.email === state.email && (state.activeOnly ? r.revoked_at === null : true)
          )
          for (const t of targets) Object.assign(t, patch)
          return Promise.resolve({ data: targets.map(t => ({ id: t.id })), error: null })
        },
      })

      return {
        select: (_cols: string) => selectBuilder({}),
        update: (patch: Record<string, unknown>) => updateBuilder(patch, {}),
        insert: async (row: Record<string, unknown>) => {
          const email = row.email as string

          // CHECK (email = lower(btrim(email)))
          if (email !== email.trim().toLowerCase()) {
            return { error: { code: '23514', message: 'suppressed_emails_email_normalised' } }
          }

          // UNIQUE (email) WHERE revoked_at IS NULL
          if (rows.some(r => r.email === email && r.revoked_at === null)) {
            return { error: { code: '23505', message: 'suppressed_emails_active_unique' } }
          }

          rows.push({
            id: `row-${nextId++}`,
            email,
            reason: row.reason as string,
            source_org_id: (row.source_org_id as string) ?? null,
            source_signal_id: (row.source_signal_id as string) ?? null,
            revoked_at: null,
            revoked_reason: null,
          })
          return { error: null }
        },
      }
    },
  }

  return { client, rows }
}

describe('normaliseEmail', () => {
  it('lowercases and trims, so capitalisation cannot dodge suppression', () => {
    expect(normaliseEmail('  BOB@X.COM ')).toBe('bob@x.com')
    expect(normaliseEmail('Bob@X.Com')).toBe('bob@x.com')
    expect(normaliseEmail('bob@x.com')).toBe('bob@x.com')
  })

  it('does not fold plus-addresses or strip dots', () => {
    // Provider-specific guesses would suppress mailboxes that never bounced.
    expect(normaliseEmail('bob+news@x.com')).toBe('bob+news@x.com')
    expect(normaliseEmail('b.o.b@x.com')).toBe('b.o.b@x.com')
  })
})

describe('recordSuppression', () => {
  let db: ReturnType<typeof createFakeSuppressionDb>

  beforeEach(() => {
    db = createFakeSuppressionDb()
  })

  it('stores a bounced address lowercased and trimmed', async () => {
    const outcome = await recordSuppression(db.client, {
      email: '  Bob@X.COM  ',
      reason: 'bounced',
      source_org_id: 'org-a',
      source_signal_id: 'signal-1',
    })

    expect(outcome).toBe('recorded')
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0].email).toBe('bob@x.com')
    expect(db.rows[0].reason).toBe('bounced')
    expect(db.rows[0].source_org_id).toBe('org-a')
    expect(db.rows[0].source_signal_id).toBe('signal-1')
  })

  it('is idempotent: the same address twice does not duplicate or error', async () => {
    const first = await recordSuppression(db.client, {
      email: 'dupe@x.com', reason: 'bounced', source_org_id: 'org-a', source_signal_id: 'signal-1',
    })
    const second = await recordSuppression(db.client, {
      email: 'dupe@x.com', reason: 'bounced', source_org_id: 'org-a', source_signal_id: 'signal-1',
    })

    expect(first).toBe('recorded')
    expect(second).toBe('already_suppressed')
    expect(db.rows).toHaveLength(1)
  })

  it('is idempotent across capitalisation, not just across exact repeats', async () => {
    // The failure this guards: two rows for one human, one of which the lookup misses.
    await recordSuppression(db.client, {
      email: 'bob@x.com', reason: 'bounced', source_org_id: 'org-a', source_signal_id: null,
    })
    const second = await recordSuppression(db.client, {
      email: 'BOB@X.COM', reason: 'bounced', source_org_id: 'org-a', source_signal_id: null,
    })

    expect(second).toBe('already_suppressed')
    expect(db.rows).toHaveLength(1)
  })

  it('refuses a blank address rather than writing an unusable row', async () => {
    const outcome = await recordSuppression(db.client, {
      email: '   ', reason: 'bounced', source_org_id: 'org-a', source_signal_id: null,
    })

    expect(outcome).toBe('error')
    expect(db.rows).toHaveLength(0)
  })

  it('re-suppresses after a revocation instead of being blocked by history', async () => {
    await recordSuppression(db.client, {
      email: 'again@x.com', reason: 'bounced', source_org_id: 'org-a', source_signal_id: null,
    })
    await revokeSuppression(db.client, 'again@x.com', 'mailbox restored')

    const second = await recordSuppression(db.client, {
      email: 'again@x.com', reason: 'bounced', source_org_id: 'org-a', source_signal_id: null,
    })

    // The partial index only covers active rows, so the revoked one does not block this.
    expect(second).toBe('recorded')
    expect(db.rows).toHaveLength(2)
    expect(db.rows.filter(r => r.revoked_at === null)).toHaveLength(1)
  })
})

describe('lookupSuppressedEmails', () => {
  it('matches a stored bob@x.com when asked for BOB@X.COM', async () => {
    // The headline normalisation case: if this fails, capitalisation defeats suppression.
    const db = createFakeSuppressionDb()
    await recordSuppression(db.client, {
      email: 'bob@x.com', reason: 'bounced', source_org_id: 'org-a', source_signal_id: null,
    })

    const result = await lookupSuppressedEmails(db.client, ['BOB@X.COM'])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.suppressed.has('bob@x.com')).toBe(true)
    expect(isSuppressed(result.suppressed, 'BOB@X.COM')).toBe(true)
    expect(isSuppressed(result.suppressed, '  Bob@X.Com  ')).toBe(true)
  })

  it('does not match an address that was never suppressed', async () => {
    const db = createFakeSuppressionDb()
    await recordSuppression(db.client, {
      email: 'bounced@x.com', reason: 'bounced', source_org_id: 'org-a', source_signal_id: null,
    })

    const result = await lookupSuppressedEmails(db.client, ['fine@x.com'])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.suppressed.size).toBe(0)
  })

  it('ignores a revoked entry, so revocation actually takes effect', async () => {
    const db = createFakeSuppressionDb()
    await recordSuppression(db.client, {
      email: 'lifted@x.com', reason: 'bounced', source_org_id: 'org-a', source_signal_id: null,
    })

    const before = await lookupSuppressedEmails(db.client, ['lifted@x.com'])
    expect(before.ok && before.suppressed.has('lifted@x.com')).toBe(true)

    await revokeSuppression(db.client, 'lifted@x.com', 'confirmed deliverable by client')

    const after = await lookupSuppressedEmails(db.client, ['lifted@x.com'])
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.suppressed.has('lifted@x.com')).toBe(false)

    // The row survives. Revocation is never a delete.
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0].revoked_at).not.toBeNull()
    expect(db.rows[0].revoked_reason).toBe('confirmed deliverable by client')
  })

  it('fails closed when the query errors, rather than returning an empty set', async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const brokenClient: any = {
      from: () => ({
        select: () => ({
          in: () => ({
            is: () => ({
              then: (resolve: (v: unknown) => unknown) =>
                resolve({ data: null, error: { code: '42501', message: 'permission denied' } }),
            }),
          }),
        }),
      }),
    }

    const result = await lookupSuppressedEmails(brokenClient, ['someone@x.com'])

    // An unknown list must never be treated as an empty one.
    expect(result.ok).toBe(false)
  })

  it('returns an empty set without querying when given no addresses', async () => {
    const db = createFakeSuppressionDb()
    const result = await lookupSuppressedEmails(db.client, [])
    expect(result.ok && result.suppressed.size).toBe(0)
  })
})

describe('revokeSuppression', () => {
  it('normalises the address it is given, so a revoke by BOB@X.COM lifts bob@x.com', async () => {
    const db = createFakeSuppressionDb()
    await recordSuppression(db.client, {
      email: 'bob@x.com', reason: 'unsubscribed', source_org_id: 'org-a', source_signal_id: null,
    })

    const result = await revokeSuppression(db.client, '  BOB@X.COM ', 'asked to be re-added')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.revoked).toBe(1)
  })

  it('requires a reason, because an unexplained lift is not auditable', async () => {
    const db = createFakeSuppressionDb()
    await recordSuppression(db.client, {
      email: 'bob@x.com', reason: 'bounced', source_org_id: 'org-a', source_signal_id: null,
    })

    const result = await revokeSuppression(db.client, 'bob@x.com', '   ')

    expect(result.ok).toBe(false)
    expect(db.rows[0].revoked_at).toBeNull()
  })

  it('reports zero revoked for an address that was never on the list', async () => {
    const db = createFakeSuppressionDb()
    const result = await revokeSuppression(db.client, 'stranger@x.com', 'housekeeping')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.revoked).toBe(0)
  })
})
