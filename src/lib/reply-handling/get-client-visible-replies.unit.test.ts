// Unit tests for getClientVisibleReplies, with a faked Supabase client.
//
// The sibling file get-client-visible-replies.test.ts drives the real database and is the
// stronger test, but it only runs where live credentials are configured. This file runs
// everywhere, and it can assert something the live test cannot: the exact filters the
// function sent, including the ones whose absence would be invisible in the results.
//
// A missing .eq('status', 'sent') on the drafts query, for instance, produces output that
// looks entirely reasonable right up until the day it shows a client a draft their
// operator has not approved yet.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Records every filter applied, per table, so the queries can be asserted directly.
interface Recorded {
  table: string
  eq: Array<[string, unknown]>
  in: Array<[string, readonly unknown[]]>
  select: string
}

const state = vi.hoisted(() => ({
  calls: [] as Recorded[],
  actions: [] as Record<string, unknown>[],
  drafts: [] as Record<string, unknown>[],
  meetings: [] as Record<string, unknown>[],
}))

vi.mock('@supabase/supabase-js', () => ({
  /* eslint-disable @typescript-eslint/no-explicit-any */
  createClient: () => ({
    from(table: string) {
      const rec: Recorded = { table, eq: [], in: [], select: '' }
      state.calls.push(rec)

      const rows = () =>
        table === 'reply_handling_actions' ? state.actions
        : table === 'reply_drafts' ? state.drafts
        : state.meetings

      const builder: any = {
        select: (cols: string) => { rec.select = cols; return builder },
        eq: (col: string, val: unknown) => { rec.eq.push([col, val]); return builder },
        in: (col: string, vals: readonly unknown[]) => { rec.in.push([col, vals]); return builder },
        order: () => builder,
        limit: () => builder,
        then: (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null }),
      }
      return builder
    },
  }),
  /* eslint-enable @typescript-eslint/no-explicit-any */
}))

import { getClientVisibleReplies, CLIENT_VISIBLE_INTENTS } from './get-client-visible-replies'

const ORG = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'

function action(overrides: Record<string, unknown> = {}) {
  return {
    id: 'action-1',
    created_at: '2026-08-24T15:20:00.000Z',
    updated_at: '2026-08-24T15:21:00.000Z',
    action_taken: 'log_only',
    action_succeeded: null,
    action_payload: null,
    signal_id: 'signal-1',
    prospect_id: 'prospect-1',
    prospect: {
      first_name: 'Alice',
      last_name: 'Prospect',
      job_title: 'Managing Director',
      company_name: 'Prospect Co',
      email: 'alice@prospect.example',
    },
    signal: {
      raw_data: { subject: 'Interested', body: { text: 'Line one.\n\nLine two.' } },
      original_outbound_body: 'The email we sent that prompted this.',
    },
    ...overrides,
  }
}

function tableCall(table: string): Recorded | undefined {
  return state.calls.find(c => c.table === table)
}

beforeEach(() => {
  state.calls.length = 0
  state.actions = [action()]
  state.drafts = []
  state.meetings = []
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
})

// ── The queries themselves ────────────────────────────────────────────────────

describe('the filters that must be on every query', () => {
  it('scopes all three queries to the organisation', async () => {
    state.drafts = []
    state.meetings = []
    await getClientVisibleReplies(ORG)

    // Org-scoping here has no RLS backstop: this filter IS the gate.
    for (const table of ['reply_handling_actions', 'reply_drafts', 'meetings']) {
      const call = tableCall(table)
      expect(call, `no query was made against ${table}`).toBeDefined()
      expect(call!.eq).toContainEqual(['organisation_id', ORG])
    }
  })

  it('filters on exactly the five client-visible intents', async () => {
    await getClientVisibleReplies(ORG)

    const call = tableCall('reply_handling_actions')!
    const intentFilter = call.in.find(([col]) => col === 'classified_intent')
    expect(intentFilter).toBeDefined()
    expect([...intentFilter![1]]).toEqual([...CLIENT_VISIBLE_INTENTS])
    expect(intentFilter![1]).toHaveLength(5)
  })

  it('never SELECTs the classification, so it cannot leak by accident', async () => {
    await getClientVisibleReplies(ORG)

    const select = tableCall('reply_handling_actions')!.select
    expect(select).not.toContain('classified_intent')
    expect(select).not.toContain('classification_confidence')
    expect(select).not.toContain('classification_reasoning')
    expect(select).not.toContain('tier_assigned')
  })

  it('asks only for drafts at status sent', async () => {
    await getClientVisibleReplies(ORG)

    // Without this, a draft sitting in the operator's approval queue renders on a
    // client's screen as something already said in their name.
    expect(tableCall('reply_drafts')!.eq).toContainEqual(['status', 'sent'])
  })

  it('skips the follow-up queries entirely when there are no replies', async () => {
    state.actions = []
    const result = await getClientVisibleReplies(ORG)

    expect(result).toEqual([])
    expect(tableCall('reply_drafts')).toBeUndefined()
    expect(tableCall('meetings')).toBeUndefined()
  })
})

// ── What comes back ───────────────────────────────────────────────────────────

describe('the shape a card is built from', () => {
  it('carries name, title, company and the time they replied', async () => {
    const [reply] = await getClientVisibleReplies(ORG)

    expect(reply.prospect.first_name).toBe('Alice')
    expect(reply.prospect.job_title).toBe('Managing Director')
    expect(reply.prospect.company_name).toBe('Prospect Co')
    expect(reply.received_at).toBe('2026-08-24T15:20:00.000Z')
  })

  it('returns the reply verbatim, with its newlines and no truncation', async () => {
    const long = 'x'.repeat(600)
    state.actions = [action({
      signal: {
        raw_data: { subject: 's', body: { text: `Para one.\n\n${long}` } },
        original_outbound_body: null,
      },
    })]

    const [reply] = await getClientVisibleReplies(ORG)
    expect(reply.reply_body).toContain('\n\n')
    expect(reply.reply_body.length).toBeGreaterThan(600)
  })

  it('reads a body that arrived as a bare string rather than an object', async () => {
    state.actions = [action({
      signal: { raw_data: { subject: 's', body: 'Just a string.' }, original_outbound_body: null },
    })]

    const [reply] = await getClientVisibleReplies(ORG)
    expect(reply.reply_body).toBe('Just a string.')
  })

  it('carries the prompting email', async () => {
    const [reply] = await getClientVisibleReplies(ORG)
    expect(reply.prompting_email).toBe('The email we sent that prompted this.')
  })

  it('carries no intent, confidence, tier or action anywhere in the payload', async () => {
    const replies = await getClientVisibleReplies(ORG)
    const serialised = JSON.stringify(replies)

    for (const key of ['classified_intent', 'classification_confidence', 'tier_assigned', 'action_taken']) {
      expect(replies[0]).not.toHaveProperty(key)
      expect(serialised).not.toContain(key)
    }
  })
})

// ── What we said in their name ────────────────────────────────────────────────

describe('the reply sent on the client behalf', () => {
  it('is null when nothing has been sent', async () => {
    const [reply] = await getClientVisibleReplies(ORG)
    expect(reply.sent_on_their_behalf).toBeNull()
  })

  it('shows a sent draft, with the timestamp it went out', async () => {
    state.drafts = [{
      signal_id: 'signal-1',
      final_sent_body: 'What we said in their name.',
      sent_at: '2026-08-24T16:00:00.000Z',
    }]

    const [reply] = await getClientVisibleReplies(ORG)
    expect(reply.sent_on_their_behalf).toEqual({
      body: 'What we said in their name.',
      sent_at: '2026-08-24T16:00:00.000Z',
    })
  })

  it('shows a Tier 1 automatic reply that succeeded, stamped when the send completed', async () => {
    state.actions = [action({
      action_taken: 'send_reply',
      action_succeeded: true,
      action_payload: { reply_body: 'Grab a slot here.', calendar_link: 'https://cal.example/x' },
    })]

    const [reply] = await getClientVisibleReplies(ORG)
    // updated_at, not created_at: the row is written before the send and updated after it.
    expect(reply.sent_on_their_behalf).toEqual({
      body: 'Grab a slot here.',
      sent_at: '2026-08-24T15:21:00.000Z',
    })
  })

  it('does NOT show a Tier 1 reply whose send failed', async () => {
    state.actions = [action({
      action_taken: 'send_reply',
      action_succeeded: false,
      action_payload: { reply_body: 'This never left the building.' },
    })]

    const [reply] = await getClientVisibleReplies(ORG)
    expect(reply.sent_on_their_behalf).toBeNull()
  })

  it('does NOT show a Tier 1 reply that has not resolved yet', async () => {
    state.actions = [action({
      action_taken: 'send_reply',
      action_succeeded: null,
      action_payload: { reply_body: 'Still in flight.' },
    })]

    expect((await getClientVisibleReplies(ORG))[0].sent_on_their_behalf).toBeNull()
  })

  it('prefers the operator-approved reply when both somehow exist', async () => {
    state.actions = [action({
      action_succeeded: true,
      action_payload: { reply_body: 'The automatic one.' },
    })]
    state.drafts = [{
      signal_id: 'signal-1',
      final_sent_body: 'The one a human approved.',
      sent_at: '2026-08-24T16:00:00.000Z',
    }]

    const [reply] = await getClientVisibleReplies(ORG)
    expect(reply.sent_on_their_behalf?.body).toBe('The one a human approved.')
  })

  it('skips a half-built sent row rather than rendering it', async () => {
    // sent_at without a body, or a body without sent_at, cannot be shown honestly.
    state.drafts = [
      { signal_id: 'signal-1', final_sent_body: null, sent_at: '2026-08-24T16:00:00.000Z' },
    ]
    expect((await getClientVisibleReplies(ORG))[0].sent_on_their_behalf).toBeNull()

    state.calls.length = 0
    state.drafts = [{ signal_id: 'signal-1', final_sent_body: 'Body', sent_at: null }]
    expect((await getClientVisibleReplies(ORG))[0].sent_on_their_behalf).toBeNull()
  })

  it('does not attach one reply sent text to a different reply', async () => {
    state.actions = [action(), action({ id: 'action-2', signal_id: 'signal-2', prospect_id: 'prospect-2' })]
    state.drafts = [{
      signal_id: 'signal-2',
      final_sent_body: 'Only for the second one.',
      sent_at: '2026-08-24T16:00:00.000Z',
    }]

    const replies = await getClientVisibleReplies(ORG)
    expect(replies.find(r => r.id === 'action-1')!.sent_on_their_behalf).toBeNull()
    expect(replies.find(r => r.id === 'action-2')!.sent_on_their_behalf?.body).toBe('Only for the second one.')
  })
})

// ── The badge ─────────────────────────────────────────────────────────────────

describe('the badge', () => {
  it('is interested when the prospect has no meeting', async () => {
    const [reply] = await getClientVisibleReplies(ORG)
    expect(reply.badge).toBe('interested')
    expect(reply.meeting).toBeNull()
  })

  it('is meeting_booked, with the date, when the prospect has one', async () => {
    state.meetings = [{
      prospect_id: 'prospect-1',
      scheduled_start_at: '2026-09-02T14:00:00.000Z',
      meeting_date: null,
    }]

    const [reply] = await getClientVisibleReplies(ORG)
    expect(reply.badge).toBe('meeting_booked')
    expect(reply.meeting?.scheduled_for).toBe('2026-09-02T14:00:00.000Z')
  })

  it('falls back to meeting_date when there is no scheduled start', async () => {
    state.meetings = [{ prospect_id: 'prospect-1', scheduled_start_at: null, meeting_date: '2026-09-02' }]
    expect((await getClientVisibleReplies(ORG))[0].meeting?.scheduled_for).toBe('2026-09-02')
  })

  it('still badges a meeting whose date is unknown', async () => {
    state.meetings = [{ prospect_id: 'prospect-1', scheduled_start_at: null, meeting_date: null }]
    const [reply] = await getClientVisibleReplies(ORG)
    expect(reply.badge).toBe('meeting_booked')
    expect(reply.meeting?.scheduled_for).toBeNull()
  })

  it('does not badge one prospect meeting onto another prospect', async () => {
    state.actions = [action(), action({ id: 'action-2', signal_id: 'signal-2', prospect_id: 'prospect-2' })]
    state.meetings = [{ prospect_id: 'prospect-2', scheduled_start_at: '2026-09-02T14:00:00.000Z', meeting_date: null }]

    const replies = await getClientVisibleReplies(ORG)
    expect(replies.find(r => r.id === 'action-1')!.badge).toBe('interested')
    expect(replies.find(r => r.id === 'action-2')!.badge).toBe('meeting_booked')
  })
})

// ── Failing loudly ────────────────────────────────────────────────────────────

describe('a missing service-role key', () => {
  it('throws rather than returning an empty list', async () => {
    // An empty list reads as "you have had no replies", which is the most damaging thing
    // this page could say incorrectly.
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    await expect(getClientVisibleReplies(ORG)).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/)
  })
})
