// unresolved_fields must survive THE REAL AGENT, not a hand-copy of it.
//
// WHY THIS FILE EXISTS. icp-unresolved-fields.test.ts has a local runAgentOutputPipeline()
// whose comment says "Mirrors icp-generation-agent.ts steps 8 and 9 exactly". That is a
// second list kept in step with the first by hand, and CLAUDE.md names the shape: the
// production code is correct and the test is structurally incapable of noticing when it
// stops being. Proved by mutation on 2026-08-27: inserting
//
//     delete (scrubbedDocument as Record<string, unknown>).unresolved_fields
//
// immediately before JSON.stringify in the real agent left the whole suite green. The key
// would have been absent from every row written to document_suggestions, the approval
// banner would never have appeared again, and nothing would have said so.
//
// This test calls runIcpGenerationAgent itself and asserts on the row it actually writes.
//
// THE FAKE THROWS on anything it does not implement. A fake that silently returns a chain
// for an unimplemented method cannot test the filter it swallowed, which is the third
// silent-failure shape in CLAUDE.md.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Module mocks: everything that leaves the process ────────────────────────

const mockCreate = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate }
  },
}))

vi.mock('@/lib/agents/log-agent-run', () => ({
  startAgentRun: vi.fn(async () => ({
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
  })),
}))

vi.mock('@/lib/agents/tools/webSearch', () => ({
  runResearchQueries: vi.fn(async () => ({ results: [], limitedNote: '' })),
  formatResearchForPrompt: vi.fn(() => ''),
}))

// Spread the real module first, then override only the two functions this test needs to
// control. A hand-listed mock goes stale the moment the module gains an export, and it
// fails as "No X export is defined on the mock", which reads like a bug in the code under
// test rather than a bug in the mock. That happened when countTruncatedPages was added.
vi.mock('@/lib/agents/website-context', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/agents/website-context')>()),
  fetchWebsiteContext: vi.fn(async () => []),
  formatWebsiteContextForPrompt: vi.fn(() => ''),
}))

import { runIcpGenerationAgent } from '../icp-generation-agent'

// ─── The document the model returns ──────────────────────────────────────────

const UNRESOLVED = [
  {
    field_path: 'tier_1.company_profile.revenue_range',
    why_unresolved: 'Intake gave no revenue figure and headcount alone cannot imply one.',
    question_to_settle_it: 'What revenue range did your best clients bill last year?',
  },
  {
    field_path: 'tier_1.company_profile.geography',
    why_unresolved: 'Currency was EUR but no country was named.',
    question_to_settle_it: 'Which countries do your clients operate in?',
  },
]

function modelDocument() {
  return {
    jtbd_statement: 'Take outbound off the founder so quoting does not stop during delivery.',
    summary: 'Firms that sell through relationships and want a second route to demand.',
    tier_1: {
      label: 'Ideal Client',
      description: 'Owner-led firms where one person carries delivery and sales.',
      company_profile: {
        revenue_range: '',
        headcount: '5 to 20 employees',
        stage: 'established, pre-systematisation',
        industries: ['Management Consulting'],
        geography: '',
        business_model: 'project-based services',
      },
      buyer_profile: {
        title: 'Founder',
        seniority: 'Founder-led, no dedicated sales function',
        day_to_day: 'Delivery fills the calendar and quoting waits for a gap.',
        identity: 'A practitioner first, a seller second.',
      },
      four_forces: { push: ['Work arrives in clumps.'], pull: [], anxiety: [], habit: [] },
      triggers: [],
      switching_costs: [],
      disqualifiers: [],
    },
    tier_2: { label: 'Good Client' },
    tier_3: { label: 'Do Not Target' },
    unresolved_fields: UNRESOLVED,
  }
}

// ─── A Supabase fake that honours what the agent asks for, and throws otherwise ──

type Captured = { table: string; payload: Record<string, unknown> }

function makeSupabaseFake(captured: Captured[]) {
  const notImplemented = (method: string, table: string) => () => {
    throw new Error(`supabase fake: ${table}.${method}() is not implemented`)
  }

  function selectChain(table: string, rows: unknown[]) {
    const chain: Record<string, unknown> = {
      // Every filter the agent uses is recorded and honoured by returning the same rows.
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      // intake_files narrows file_purpose with .in(); honoured by returning the same
      // (empty) row set rather than swallowed. Any OTHER table calling .in() is a query
      // this fake has not been taught, so it still throws below.
      in: () => {
        if (table !== 'intake_files') return notImplemented('in', table)()
        return chain
      },
      // .single() is used for "newest existing doc" and for the pending-duplicate check.
      // Both treat a thrown/absent row as "none", so returning an error is the honest
      // empty answer rather than a silent empty array.
      single: async () => ({ data: null, error: { message: 'no rows' } }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
    }
    return chain
  }

  return {
    from(table: string) {
      if (table === 'intake_responses') {
        return {
          select: () => selectChain(table, [
            {
              field_key: 'company_what_you_do',
              field_label: 'What does your company do?',
              response_value: 'We deliver hot meals to primary schools.',
              section: 'Company',
              is_critical: true,
            },
          ]),
          insert: notImplemented('insert', table),
        }
      }
      if (table === 'strategy_documents') {
        return { select: () => selectChain(table, []), insert: notImplemented('insert', table) }
      }
      if (table === 'patterns') {
        return { select: () => selectChain(table, []), insert: notImplemented('insert', table) }
      }
      if (table === 'intake_files') {
        return { select: () => selectChain(table, []), insert: notImplemented('insert', table) }
      }
      if (table === 'document_suggestions') {
        return {
          select: () => selectChain(table, []),
          insert: (payload: Record<string, unknown>) => {
            captured.push({ table, payload })
            return {
              select: () => ({
                single: async () => ({ data: { id: 'suggestion-1' }, error: null }),
              }),
            }
          },
        }
      }
      throw new Error(`supabase fake: table ${table} is not implemented`)
    },
  } as never
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('unresolved_fields survives the REAL ICP agent write path', () => {
  let captured: Captured[]

  beforeEach(() => {
    captured = []
    // The agent guards on this before constructing the client. The client itself is
    // mocked above, so the value is never used for anything.
    process.env.ANTHROPIC_API_KEY = 'test-key-not-a-secret'
    mockCreate.mockReset()
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(modelDocument()) }],
    })
  })

  async function run() {
    const result = await runIcpGenerationAgent({
      organisation_id: '00000000-0000-0000-0000-0000000000aa',
      supabase: makeSupabaseFake(captured),
    })
    expect(result.suggestion_id).toBe('suggestion-1')
    const row = captured.find(c => c.table === 'document_suggestions')
    expect(row, 'agent wrote no document_suggestions row').toBeTruthy()
    return row!.payload
  }

  it('writes a document_suggestions row at all', async () => {
    const payload = await run()
    expect(payload.document_type).toBe('icp')
  })

  it('the written suggested_value still contains unresolved_fields', async () => {
    // THE GUARD. Any mutation between JSON.parse and the insert that drops, renames or
    // flattens this key fails here. Deleting the key in the agent leaves every other test
    // in the suite green.
    const payload = await run()
    const stored = JSON.parse(payload.suggested_value as string) as Record<string, unknown>
    expect(stored.unresolved_fields).toBeDefined()
    expect(Array.isArray(stored.unresolved_fields)).toBe(true)
    expect(stored.unresolved_fields).toEqual(UNRESOLVED)
  })

  it('every entry keeps all three keys through the real write path', async () => {
    const payload = await run()
    const stored = JSON.parse(payload.suggested_value as string) as {
      unresolved_fields: Array<Record<string, string>>
    }
    expect(stored.unresolved_fields).toHaveLength(2)
    for (const entry of stored.unresolved_fields) {
      expect(entry.field_path).toBeTruthy()
      expect(entry.why_unresolved).toBeTruthy()
      expect(entry.question_to_settle_it).toBeTruthy()
    }
  })

  it('an empty unresolved_fields array is written as [] rather than dropped', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ ...modelDocument(), unresolved_fields: [] }) }],
    })
    const payload = await run()
    const stored = JSON.parse(payload.suggested_value as string) as Record<string, unknown>
    expect('unresolved_fields' in stored).toBe(true)
    expect(stored.unresolved_fields).toEqual([])
  })
})
