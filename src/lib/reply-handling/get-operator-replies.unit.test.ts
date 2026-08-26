// Unit tests for getOperatorRepliesForOrg, with a faked Supabase client.
//
// This is the mirror image of get-client-visible-replies.unit.test.ts. That file proves a
// filter is PRESENT; this one proves the same filter is ABSENT, because the operator view
// exists precisely to show what the client chokepoint removes.
//
// The failure this guards against is a quiet one. If someone ever "tidies up" by routing
// this function through the chokepoint, or copies its .in('classified_intent', ...) across,
// the page keeps rendering and simply stops showing opt-outs and hostile replies. Nothing
// errors. The operator just stops seeing half the replies again, which is the exact state
// this view was built to end.

import { describe, it, expect, beforeEach, vi } from 'vitest'

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
}))

vi.mock('@supabase/supabase-js', () => ({
  /* eslint-disable @typescript-eslint/no-explicit-any */
  createClient: () => ({
    from(table: string) {
      const rec: Recorded = { table, eq: [], in: [], select: '' }
      state.calls.push(rec)

      const rows = () => (table === 'reply_handling_actions' ? state.actions : state.drafts)

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

import { getOperatorRepliesForOrg } from './get-operator-replies'
import { CLIENT_VISIBLE_INTENTS } from './get-client-visible-replies'

const ORG = '0ed34697-0fa9-4f08-ac15-d3504ac45caf'

let seq = 0

function action(intent: string, overrides: Record<string, unknown> = {}) {
  seq += 1
  return {
    id: `action-${seq}`,
    created_at: '2026-08-25T09:00:00.000Z',
    classified_intent: intent,
    classification_confidence: 0.91,
    action_taken: 'log_only',
    action_succeeded: null,
    signal_id: `signal-${seq}`,
    prospect: {
      first_name: 'Alice',
      last_name: 'Prospect',
      job_title: 'Managing Director',
      company_name: 'Prospect Co',
      email: 'alice@prospect.example',
    },
    signal: {
      raw_data: { subject: 'Re: intro', body: { text: 'Line one.\n\nLine two.' } },
      original_outbound_body: 'The email we sent that prompted this.',
    },
    ...overrides,
  }
}

function tableCall(table: string): Recorded | undefined {
  return state.calls.find(c => c.table === table)
}

const ALL_EIGHT = [
  'positive_direct_booking',
  'positive_passive',
  'information_request_commercial',
  'information_request_generic',
  'objection_mild',
  'opt_out',
  'out_of_office',
  'unclear',
]

beforeEach(() => {
  seq = 0
  state.calls.length = 0
  state.actions = [action('positive_passive')]
  state.drafts = []
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
})

// ── The filter that must NOT be there ─────────────────────────────────────────

describe('it does not apply the client intent filter', () => {
  it('sends no classified_intent filter to the database at all', async () => {
    state.actions = ALL_EIGHT.map(i => action(i))
    await getOperatorRepliesForOrg(ORG)

    const call = tableCall('reply_handling_actions')!
    expect(call.in.find(([col]) => col === 'classified_intent')).toBeUndefined()
  })

  it('returns the three intents a client may never see', async () => {
    state.actions = ALL_EIGHT.map(i => action(i))
    const result = await getOperatorRepliesForOrg(ORG)

    const intents = result.groups.map(g => g.intent)
    for (const hidden of ['opt_out', 'out_of_office', 'unclear']) {
      expect(intents, `${hidden} is missing from the operator view`).toContain(hidden)
      expect(CLIENT_VISIBLE_INTENTS).not.toContain(hidden)
    }
    expect(result.total).toBe(8)
  })

  it('counts how many are hidden from the client', async () => {
    state.actions = ALL_EIGHT.map(i => action(i))
    const result = await getOperatorRepliesForOrg(ORG)

    // 3 of the 8: opt_out, out_of_office, unclear.
    expect(result.hiddenFromClientCount).toBe(3)
    expect(result.groups.filter(g => !g.client_visible).map(g => g.intent).sort())
      .toEqual(['opt_out', 'out_of_office', 'unclear'])
  })
})

// ── Org scoping, which is the only gate left once RLS is bypassed ─────────────

describe('org scoping', () => {
  it('scopes both queries to the organisation', async () => {
    state.drafts = [{ signal_id: 'signal-1', tier: 2, status: 'pending', ai_draft_body: 'x', final_sent_body: null, sent_at: null, send_error: null }]
    await getOperatorRepliesForOrg(ORG)

    for (const table of ['reply_handling_actions', 'reply_drafts']) {
      const call = tableCall(table)
      expect(call, `no query was made against ${table}`).toBeDefined()
      expect(call!.eq).toContainEqual(['organisation_id', ORG])
    }
  })

  it('refuses to run without a service-role key rather than returning nothing', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    await expect(getOperatorRepliesForOrg(ORG)).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/)
  })
})

// ── Grouping and counts ──────────────────────────────────────────────────────

describe('grouping', () => {
  it('counts each intent and omits intents with no replies', async () => {
    state.actions = [
      action('opt_out'),
      action('opt_out'),
      action('positive_passive'),
    ]
    const result = await getOperatorRepliesForOrg(ORG)

    expect(result.total).toBe(3)
    expect(result.groups).toHaveLength(2)
    const optOut = result.groups.find(g => g.intent === 'opt_out')!
    expect(optOut.count).toBe(2)
    expect(optOut.replies).toHaveLength(2)
    expect(optOut.label).toBe('Opted out')
    expect(optOut.client_visible).toBe(false)
  })

  it('orders positive intents before the ones that end a conversation', async () => {
    state.actions = [action('unclear'), action('positive_direct_booking'), action('opt_out')]
    const result = await getOperatorRepliesForOrg(ORG)

    expect(result.groups.map(g => g.intent)).toEqual([
      'positive_direct_booking',
      'opt_out',
      'unclear',
    ])
  })

  it('appends an unrecognised intent instead of dropping it', async () => {
    state.actions = [action('positive_passive'), action('something_new')]
    const result = await getOperatorRepliesForOrg(ORG)

    expect(result.total).toBe(2)
    const last = result.groups[result.groups.length - 1]
    expect(last.intent).toBe('something_new')
    // No label exists for it, so it shows under its raw name rather than blank.
    expect(last.label).toBe('something_new')
    expect(last.client_visible).toBe(false)
  })
})

// ── What each card carries ───────────────────────────────────────────────────

describe('the reply payload', () => {
  it('carries the body verbatim, newlines and all, not a 300-character snippet', async () => {
    const long = 'A'.repeat(400)
    state.actions = [action('unclear', {
      signal: {
        raw_data: { subject: 'Re: intro', body: { text: long } },
        original_outbound_body: 'What we sent.',
      },
    })]
    const result = await getOperatorRepliesForOrg(ORG)

    expect(result.groups[0].replies[0].reply_body).toHaveLength(400)
  })

  it('carries the email that prompted the reply, which lives on signals', async () => {
    const result = await getOperatorRepliesForOrg(ORG)
    expect(result.groups[0].replies[0].prompting_email).toBe('The email we sent that prompted this.')
  })

  it('attaches a draft at any status, including one still awaiting approval', async () => {
    state.drafts = [{
      signal_id: 'signal-1',
      tier: 2,
      status: 'pending',
      ai_draft_body: 'Drafted, not sent.',
      final_sent_body: null,
      sent_at: null,
      send_error: null,
    }]
    const result = await getOperatorRepliesForOrg(ORG)

    const draft = result.groups[0].replies[0].draft!
    // The client chokepoint filters drafts to status 'sent'. The operator queue IS the
    // pending ones, so this view must not inherit that filter.
    expect(tableCall('reply_drafts')!.eq).not.toContainEqual(['status', 'sent'])
    expect(draft.status).toBe('pending')
    expect(draft.tier).toBe(2)
    expect(draft.ai_draft_body).toBe('Drafted, not sent.')
  })

  it('returns an empty result without querying drafts when there are no replies', async () => {
    state.actions = []
    const result = await getOperatorRepliesForOrg(ORG)

    expect(result).toEqual({ total: 0, hiddenFromClientCount: 0, groups: [] })
    expect(tableCall('reply_drafts')).toBeUndefined()
  })
})
