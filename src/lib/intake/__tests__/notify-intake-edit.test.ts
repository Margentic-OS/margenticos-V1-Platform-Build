// The operator notification for a changed intake answer.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ServiceRoleClient } from '@/lib/supabase/service-role'
import {
  INTAKE_EDIT_NOTIFICATION_TYPE,
  intakeEditSubjectKey,
  notifyOperatorOfIntakeEdit,
} from '../notify-intake-edit'
import type { IntakeAnswerChange } from '../answer-change'

const sendWithDedup = vi.hoisted(() => vi.fn())

vi.mock('@/lib/notifications/send-transactional-with-dedup', () => ({
  sendTransactionalEmailWithDedup: sendWithDedup,
}))

const ORG_ID = '11111111-2222-3333-4444-555555555555'

const CHANGE: IntakeAnswerChange = {
  fieldKey: 'company_what_you_do',
  fieldLabel: 'What does your company do?',
  previous: 'The old answer.',
  next: 'The new answer.',
}

/**
 * A Supabase stand-in that honours the filters this module applies.
 *
 * It THROWS on anything it does not implement rather than returning a chainable that
 * silently swallows the call. A fake that quietly accepts an unimplemented filter cannot
 * test that filter, which is its own documented silent-failure shape in CLAUDE.md.
 */
function fakeClient(opts: {
  orgName?: string | null
  orgError?: string
  operatorEmail?: string | null
  operatorError?: string
} = {}) {
  const calls: { table: string; filters: [string, unknown][] }[] = []

  const client = {
    from(table: string) {
      const filters: [string, unknown][] = []
      calls.push({ table, filters })
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => { filters.push([col, val]); return chain },
        limit: () => chain,
        single: async () => {
          if (table === 'organisations') {
            if (opts.orgError) return { data: null, error: { message: opts.orgError } }
            const name = 'orgName' in opts ? opts.orgName : 'Test Org'
            return { data: { name }, error: null }
          }
          if (table === 'users') {
            if (opts.operatorError) return { data: null, error: { message: opts.operatorError } }
            // `in`, NOT `??`. The first version defaulted with `??`, so passing
            // operatorEmail: null fell through to a real address and the "no operator
            // could be resolved" test passed against a client that had resolved one. A
            // fake that does not honour its own input cannot test what it claims to.
            const email = 'operatorEmail' in opts ? opts.operatorEmail : 'operator@example.test'
            return { data: { email }, error: null }
          }
          throw new Error(`fake does not implement table ${table}`)
        },
      }
      return chain
    },
  }

  return { client: client as unknown as ServiceRoleClient, calls }
}

beforeEach(() => {
  sendWithDedup.mockReset()
  sendWithDedup.mockResolvedValue({ sent: true })
})

describe('the dedup key identifies the CHANGE, not the field', () => {
  // Keying on the field alone would send one email per question for ever: a client who
  // corrects the same answer in March and again in June would be told about once. That is
  // the permanent-suppression shape af594db removed from this very helper.
  it('two different edits of the SAME field derive different keys', () => {
    const first = intakeEditSubjectKey(ORG_ID, [{ ...CHANGE, previous: 'A', next: 'B' }])
    const second = intakeEditSubjectKey(ORG_ID, [{ ...CHANGE, previous: 'B', next: 'C' }])
    expect(first).not.toBe(second)
  })

  it('the SAME edit derives the same key, so a race cannot double send', () => {
    const a = intakeEditSubjectKey(ORG_ID, [CHANGE])
    const b = intakeEditSubjectKey(ORG_ID, [CHANGE])
    expect(a).toBe(b)
  })

  it('a different organisation derives a different key', () => {
    const a = intakeEditSubjectKey(ORG_ID, [CHANGE])
    const b = intakeEditSubjectKey('99999999-2222-3333-4444-555555555555', [CHANGE])
    expect(a).not.toBe(b)
  })

  it('the order changes arrive in does not change the key', () => {
    const other = { ...CHANGE, fieldKey: 'clients_clone', fieldLabel: 'Who?' }
    expect(intakeEditSubjectKey(ORG_ID, [CHANGE, other]))
      .toBe(intakeEditSubjectKey(ORG_ID, [other, CHANGE]))
  })

  it('stores nothing the client typed', () => {
    const key = intakeEditSubjectKey(ORG_ID, [CHANGE])
    expect(key).not.toContain(CHANGE.previous)
    expect(key).not.toContain(CHANGE.next)
  })
})

describe('what it sends', () => {
  it('sends as operator mail, which is what exempts it from the prospect style rules', async () => {
    const { client } = fakeClient()
    await notifyOperatorOfIntakeEdit(client, {
      organisationId: ORG_ID, changes: [CHANGE], flaggedDocumentTypes: ['icp'],
    })

    expect(sendWithDedup).toHaveBeenCalledTimes(1)
    const params = sendWithDedup.mock.calls[0][0]
    expect(params.audience).toBe('operator')
    expect(params.notificationType).toBe(INTAKE_EDIT_NOTIFICATION_TYPE)
    expect(params.organisationId).toBe(ORG_ID)
    expect(params.to).toBe('operator@example.test')
  })

  it('goes through the shared dedup helper, so it inherits claim and release', async () => {
    // The point of routing through this helper rather than sendTransactionalEmail directly:
    // af594db made a failed send give its claim back, so a retry is not blocked for ever.
    const { client } = fakeClient()
    await notifyOperatorOfIntakeEdit(client, {
      organisationId: ORG_ID, changes: [CHANGE], flaggedDocumentTypes: [],
    })
    expect(sendWithDedup).toHaveBeenCalled()
  })

  it('names what changed and what is flagged, in both renderings', async () => {
    const { client } = fakeClient()
    await notifyOperatorOfIntakeEdit(client, {
      organisationId: ORG_ID, changes: [CHANGE], flaggedDocumentTypes: ['icp'],
    })

    const { subject, html, text } = sendWithDedup.mock.calls[0][0]
    expect(subject).toContain(CHANGE.fieldLabel)
    for (const body of [html, text]) {
      expect(body).toContain(CHANGE.previous)
      expect(body).toContain(CHANGE.next)
      expect(body).toContain('ICP')
    }
  })

  it('reports the flagged documents it was GIVEN, never a guess from the field key', async () => {
    // company_what_you_do feeds the ICP, so a caller recomputing from the map would say
    // "ICP" here. The truth is that nothing was newly flagged, because it was already stale.
    const { client } = fakeClient()
    await notifyOperatorOfIntakeEdit(client, {
      organisationId: ORG_ID, changes: [CHANGE], flaggedDocumentTypes: [],
    })

    const { text } = sendWithDedup.mock.calls[0][0]
    expect(text).toContain('No live document was newly flagged')
    expect(text).not.toContain('ICP')
  })
})

describe('it refuses to send an empty or unattributable notification', () => {
  it('sends nothing when no answer changed', async () => {
    const { client } = fakeClient()
    const result = await notifyOperatorOfIntakeEdit(client, {
      organisationId: ORG_ID, changes: [], flaggedDocumentTypes: [],
    })
    expect(result.sent).toBe(false)
    expect(sendWithDedup).not.toHaveBeenCalled()
  })

  it('sends nothing when the organisation cannot be read', async () => {
    const { client } = fakeClient({ orgError: 'boom' })
    const result = await notifyOperatorOfIntakeEdit(client, {
      organisationId: ORG_ID, changes: [CHANGE], flaggedDocumentTypes: [],
    })
    expect(result.sent).toBe(false)
    expect(sendWithDedup).not.toHaveBeenCalled()
  })

  it('sends nothing when no operator address can be resolved', async () => {
    const { client } = fakeClient({ operatorEmail: null })
    const result = await notifyOperatorOfIntakeEdit(client, {
      organisationId: ORG_ID, changes: [CHANGE], flaggedDocumentTypes: [],
    })
    expect(result.sent).toBe(false)
    expect(sendWithDedup).not.toHaveBeenCalled()
  })
})

describe('isolation', () => {
  it('reads the organisation with an explicit organisation filter', async () => {
    const { client, calls } = fakeClient()
    await notifyOperatorOfIntakeEdit(client, {
      organisationId: ORG_ID, changes: [CHANGE], flaggedDocumentTypes: [],
    })

    const orgRead = calls.find(c => c.table === 'organisations')
    expect(orgRead?.filters).toContainEqual(['id', ORG_ID])
  })

  it('looks the operator up by ROLE, never by an organisation', async () => {
    // ADR-021: the operator does not belong to the client's organisation, so this lookup is
    // deliberately cross-organisation. Filtering it would resolve nobody and silence the alert.
    const { client, calls } = fakeClient()
    await notifyOperatorOfIntakeEdit(client, {
      organisationId: ORG_ID, changes: [CHANGE], flaggedDocumentTypes: [],
    })

    const userRead = calls.find(c => c.table === 'users')
    expect(userRead?.filters).toContainEqual(['role', 'operator'])
    expect(userRead?.filters.map(f => f[0])).not.toContain('organisation_id')
  })
})
