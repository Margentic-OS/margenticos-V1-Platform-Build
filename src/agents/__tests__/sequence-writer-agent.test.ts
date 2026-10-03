// The writer v2 agent: the tier ladder, one retry per tier with the failures stated, the spend
// ledger, and storage only while the prospect is pending. The model and the database are
// stand-ins. The database fake honours the filters the agent applies to its WRITE, and throws
// on a table it was not built for, so a dropped filter or a stray query fails here rather than
// passing quietly.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/composition/compose-sequence', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/composition/compose-sequence')>()),
  fetchApprovedMessagingDoc: vi.fn(async () => ({ content: { writer_playbook: PLAYBOOK }, doc_id: 'doc-9' })),
}))

import { writeSequenceForProspect, maybeWriteSequenceAfterResearch } from '../sequence-writer-agent'
import { produceOpening, WRITER_V2_SKIPPED_REASON } from '@/lib/agents/research/produce-opening'
import type { WriterPlaybook } from '@/lib/writer-v2/playbook'

// Invented names only: this repository is public.
const PLAYBOOK: WriterPlaybook = {
  version: 2,
  market_story: 'Founder-led firms whose new business depends on the founder.',
  angles: [{ name: 'Delivery eats the pipeline', detail: 'Outreach stops when a project lands.' }, { name: 'Burned before', detail: 'Generic messages to the wrong people.' }],
  offer: 'We run outreach end to end and book meetings with the right buyers.',
  proof: 'Full visibility of every person contacted and every email sent.',
  never_claim: [{ rule: 'Results or guarantees', patterns: ['\\bguarantee'] }],
  calls_to_action: { guidance: 'Aim for a conversation.', never: [] },
  voice: 'Warm and direct.',
  examples: [{ label: 'Example', origin: 'approved', emails: [{ body: 'Sam,\n\nWorth a chat?' }] }],
}

const TODAY = new Date(Date.UTC(2026, 9, 3))
const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ')

function sequence(opening: string, factId: string, claim: string | null) {
  return JSON.stringify({
    fact_used: { fact_id: factId, quote: '' },
    link_sentence: 'x',
    angles: [1, 2, 3, 4].map(email => ({ email, angle: email === 2 ? 'Delivery eats the pipeline' : email === 3 ? 'Burned before' : 'a' })),
    emails: [
      { email: 1, subject: 'hello', body: `Riley,\n\n${opening}\n\n${words(40)}.\n\nWorth a chat?` },
      { email: 2, subject: null, body: `Riley,\n\n${words(35)}.\n\nUseful?` },
      { email: 3, subject: null, body: `Riley,\n\n${words(35)}.\n\nWorth a quick chat?` },
      { email: 4, subject: null, body: 'Riley,\n\nLast one from me.' },
    ],
    prospect_claims: claim ? [{ email: 1, sentence: claim, fact_id: factId }] : [],
    sender_claims: [],
  })
}
const GOOD_PERSONAL = sequence('Saw you spoke at the Vantor summit in June.', 'R1', 'Saw you spoke at the Vantor summit in June.')
const GOOD_SEMI = sequence('Firms like yours tell us outreach stops when delivery is busy.', 'FIRM', null)
const BAD = sequence('We guarantee you new clients.', 'none', null)

function anthropic(replies: string[]) {
  const calls: Array<{ messages: Array<{ role: string; content: unknown }>; model: string }> = []
  const create = vi.fn(async (params: { messages: Array<{ role: string; content: unknown }>; model: string }) => {
    calls.push({ messages: JSON.parse(JSON.stringify(params.messages)), model: params.model })
    const text = replies[calls.length - 1]
    if (text === undefined) throw new Error('the test gave no reply for this call')
    return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500 } }
  })
  return { client: { messages: { create } } as never, calls }
}

function database(opts: { candidates?: unknown[]; firmFact?: unknown; status?: string; industry?: string | null } = {}) {
  const usageRows: unknown[] = []
  const prospectUpdates: Array<{ payload: unknown; filters: Record<string, unknown> }> = []
  const row = {
    id: 'p-1', segment_id: null, first_name: 'Riley', last_name: 'Marlow', job_title: 'Founder', role: null,
    company_name: 'Kessel Partners LLC', company_industry: opts.industry === undefined ? 'Management Consulting' : opts.industry, apollo_enrichment_data: null,
    firm_fact: opts.firmFact ?? null, current_research_result_id: 'rr-1', outbound_upload_status: opts.status ?? 'pending',
  }
  const from = (table: string) => {
    const filters: Record<string, unknown> = {}
    let op: 'select' | 'update' | 'insert' = 'select'
    let payload: unknown = null
    const chain: any = {
      select: () => chain,
      eq: (c: string, v: unknown) => { filters[c] = v; return chain },
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (p: unknown) => { op = 'update'; payload = p; return chain },
      insert: (p: unknown) => { op = 'insert'; payload = p; if (table === 'research_usage') usageRows.push(p); return Promise.resolve({ error: null }) },
      single: () => Promise.resolve({ data: table === 'organisations' ? { name: 'Testco', founder_first_name: 'Dana' } : row, error: null }),
      maybeSingle: () => Promise.resolve({ data: { candidates: opts.candidates ?? [] }, error: null }),
      then: (res: (v: unknown) => unknown) => {
        if (table === 'prospects' && op === 'update') {
          prospectUpdates.push({ payload, filters: { ...filters } })
          const matches = filters.outbound_upload_status === row.outbound_upload_status
          return Promise.resolve({ data: matches ? [{ id: row.id }] : [], error: null }).then(res)
        }
        if (table === 'prospects') return Promise.resolve({ data: [], error: null }).then(res)
        throw new Error(`fake does not implement a list read of ${table}`)
      },
    }
    if (!['organisations', 'prospects', 'prospect_research_results', 'research_usage'].includes(table)) throw new Error(`fake has no table ${table}`)
    return chain
  }
  return { supabase: { from } as never, usageRows, prospectUpdates }
}

const RESEARCH = [{ id: 'c1', observation: 'Spoke at the Vantor summit in June 2026', source: 'linkedin', provenance: 'post', date: '2026-06-12', is_composite: false }]
const FIRM = { quote: 'Kessel helps founders hire their first managers.', source_url: 'https://example.com', source_fetched_at: '2026-09-01T00:00:00Z' }

async function run(db: ReturnType<typeof database>, replies: string[], persist = true) {
  const ai = anthropic(replies)
  const result = await writeSequenceForProspect({ supabase: db.supabase, anthropic: ai.client, client_id: 'org-1', prospect_id: 'p-1', usagePath: 'cli', persist, today: TODAY, memory: { followUpAnglePairs: [], questions: [] } })
  return { ...result, calls: ai.calls }
}

describe('sequence writer agent', () => {
  it('personalised: one passing call, stored on the pending prospect, one ledger row priced as the writer', async () => {
    const db = database({ candidates: RESEARCH, firmFact: FIRM })
    const r = await run(db, [GOOD_PERSONAL])
    expect(r.record.tier).toBe('personalised')
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0].model).toBe('claude-sonnet-4-6')
    expect(r.record).toMatchObject({ playbook_version: 2, playbook_source: 'document', messaging_doc_id: 'doc-9' })
    expect(r.persisted).toBe(true)
    expect(db.prospectUpdates[0].filters).toMatchObject({ id: 'p-1', organisation_id: 'org-1', outbound_upload_status: 'pending' })
    expect(db.usageRows).toEqual([expect.objectContaining({ arm: 'writer_v2', research_result_id: null, path: 'cli', followups: null, opening: expect.objectContaining({ calls: 1, input_tokens: 1000 }) })])
  })

  it('a failing attempt is retried ONCE with its failures stated, then falls to semi-personalised', async () => {
    const db = database({ candidates: RESEARCH, firmFact: FIRM })
    const r = await run(db, [BAD, BAD, GOOD_SEMI])
    expect(r.record.tier).toBe('semi_personalised')
    expect(r.calls).toHaveLength(3)
    const retryPrompt = r.calls[1].messages.at(-1)!.content as string
    expect(retryPrompt).toMatch(/Your sequence failed these checks/)
    expect(retryPrompt).toMatch(/Results or guarantees/)
    // The semi tier is offered only the standing fact.
    const semiPrompt = r.calls[2].messages[0].content as string
    expect(semiPrompt).toMatch(/TIER: SEMI-PERSONALISED/)
    expect(semiPrompt).toContain('FIRM [what the firm does')
    expect(semiPrompt).not.toContain('R1 [research]')
    expect(r.record.attempts.map(a => [a.tier, a.failures.length > 0])).toEqual([['personalised', true], ['personalised', true], ['semi_personalised', false]])
  })

  it('both tiers failing twice ends at the template: four calls, no emails stored, the spend still recorded', async () => {
    const db = database({ candidates: RESEARCH, firmFact: FIRM })
    const r = await run(db, [BAD, BAD, BAD, BAD])
    expect(r.record).toMatchObject({ tier: 'template', emails: null })
    expect(r.calls).toHaveLength(4)
    expect((db.usageRows[0] as { opening: { calls: number } }).opening.calls).toBe(4)
  })

  it('no qualifying research and no standing fact: the template, with no call and no ledger row', async () => {
    const db = database({ candidates: [{ ...RESEARCH[0], date: '2024-01-01' }], industry: null })
    const r = await run(db, [])
    expect(r.record.tier).toBe('template')
    expect(r.calls).toHaveLength(0)
    expect(db.usageRows).toEqual([])
  })

  it('a sequence the personalised step passed that opens on the standing fact is recorded as semi-personalised', async () => {
    const db = database({ candidates: RESEARCH, firmFact: FIRM })
    const r = await run(db, [GOOD_SEMI])
    expect(r.calls).toHaveLength(1)
    expect(r.record.tier).toBe('semi_personalised')
    expect(r.record.attempts[0].tier).toBe('personalised')
  })

  it('a prospect no longer pending is not overwritten', async () => {
    const db = database({ candidates: RESEARCH, status: 'uploaded' })
    const r = await run(db, [GOOD_PERSONAL])
    expect(r.persisted).toBe(false)
  })

  it('a trial run writes nothing to the prospect', async () => {
    const db = database({ candidates: RESEARCH })
    await run(db, [GOOD_PERSONAL], false)
    expect(db.prospectUpdates).toEqual([])
  })

  it('after research: a no-op when the switch is off, and never throws when on', async () => {
    const db = database()
    await expect(maybeWriteSequenceAfterResearch({ supabase: db.supabase, apiKey: 'k', client_id: 'org-1', prospect_id: 'p-1', writerV2Enabled: false, usagePath: 'queue' })).resolves.toBeUndefined()
    const broken = { from: () => { throw new Error('database down') } } as never
    await expect(maybeWriteSequenceAfterResearch({ supabase: broken, apiKey: 'k', client_id: 'org-1', prospect_id: 'p-1', writerV2Enabled: true, usagePath: 'queue' })).resolves.toBeUndefined()
  })
})

describe('the old writer is skipped for a writer v2 client', () => {
  it('returns the not-written shape with NO code, before any model call', async () => {
    const opening = await produceOpening({ writerV2Enabled: true, apiKey: 'unused' } as never)
    expect(opening.written_won).toBe(false)
    expect(opening.not_written_reason).toBeUndefined()
    expect(opening.judge_reasoning).toBe(WRITER_V2_SKIPPED_REASON)
    expect(opening.usage.calls).toBe(0)
  })
})
