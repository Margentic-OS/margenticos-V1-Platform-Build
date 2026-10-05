// Writer v2 through composeSequence: the switch, the three tiers, the footer, and what the
// send records in place of the variant. Same recording stand-in as tier-routing.test.ts: it
// returns the prospect row it is given and records every write.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'

vi.mock('@supabase/supabase-js')
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

import { composeSequence, WriterV2NotReadyError, type ComposeDocs } from '../compose-sequence'
import { recordSentSequence } from '../record-sent-sequence'
import { OPT_OUT_FOOTER } from '../opt-out-footer'
import { buildMessagingContent } from '@/agents/outbound-template-agent'
import type { WriterV2Record } from '@/lib/writer-v2/record'
import {
  INVENTED_OPENER_FRAMES,
  INVENTED_SIGNOFF,
  inventedBrief,
  inventedVariants,
} from '@/lib/outbound-templates/__tests__/fixtures/invented-client'

const CLIENT = 'client-1'
const DOC_ID = 'doc-version-7'

const content = () => buildMessagingContent({
  base: {}, brief: inventedBrief(),
  result: { opener_frames: INVENTED_OPENER_FRAMES, variants: inventedVariants() },
  signoff: INVENTED_SIGNOFF, firmFactTierEnabled: true,
}) as Record<string, unknown>

const ORG_ON = { sequence_writer_v2_enabled: true, name: 'Testco Outreach', founder_first_name: 'Dana' }
const ORG_OFF = { ...ORG_ON, sequence_writer_v2_enabled: false }

function record(over: Partial<WriterV2Record> = {}): WriterV2Record {
  return {
    record_version: 1, written_at: '2026-10-03T12:00:00Z', model: 'claude-sonnet-4-6', tier: 'personalised',
    emails: [
      { position: 1, subject: 'the summit', body: 'Ada,\n\nSaw you spoke at the Vantor summit in June.\n\nWorth a chat?' },
      { position: 2, subject: null, body: 'Ada,\n\nSomething firms like yours tell us.\n\nUseful?' },
      { position: 3, subject: null, body: 'Ada,\n\nOne more angle.\n\nWorth a chat?' },
      { position: 4, subject: null, body: 'Ada,\n\nLast one from me.' },
    ],
    fact_used: { fact_id: 'R1', quote: 'Spoke at the Vantor summit' }, link_sentence: 'x',
    angles: [1, 2, 3, 4].map(email => ({ email, angle: `angle ${email}` })),
    attempts: [], copied_phrases: [], playbook_version: 3, playbook_source: 'document',
    messaging_doc_id: DOC_ID, research_result_id: 'rr-1',
    ...over,
  }
}

function prospect(over: Record<string, unknown> = {}) {
  return {
    id: 'prospect-1', organisation_id: CLIENT, segment_id: null, variant_id: 'A',
    personalisation_trigger: null, personalisation_question: null, personalisation_subject: null,
    followup_email2: null, followup_email3: null, followup_email1_fingerprint: null,
    has_dateable_signal: false, signal_relevance: null, role: 'CEO', job_title: 'CEO',
    first_name: 'Ada', last_name: 'Lee', company_name: 'Testco', firm_fact: null,
    organisation: ORG_ON, writer_v2_sequence: record(),
    ...over,
  }
}

interface Write { table: string; op: 'update' | 'insert'; payload: unknown }

function database(row: Record<string, unknown>) {
  const writes: Write[] = []
  const from = (table: string) => {
    const chain: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'update' || prop === 'insert' || prop === 'upsert') {
          return (payload: unknown) => { writes.push({ table, op: prop === 'insert' ? 'insert' : 'update', payload }); return chain }
        }
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve({ data: table === 'prospects' ? row : null, error: null })
        if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res)
        return () => chain
      },
    })
    return chain
  }
  const client = { from }
  vi.mocked(createClient).mockReturnValue(client as unknown as ReturnType<typeof createClient>)
  return { writes, client }
}

const CLIENT_FOOTER = "Not the right moment? Just reply 'no thanks' and I won't write again."
const docs = (playbookFooter?: string): ComposeDocs => ({
  messagingDoc: playbookFooter ? { ...content(), writer_playbook: { ...PLAYBOOK_STUB, opt_out_footer: playbookFooter } } : content(),
  messagingDocId: DOC_ID,
}) as unknown as ComposeDocs

// Enough of a playbook to validate; composition reads only its footer.
const PLAYBOOK_STUB = {
  version: 3, market_story: 'x', angles: [{ name: 'a', detail: 'b' }, { name: 'c', detail: 'd' }], offer: 'x', proof: 'x',
  never_claim: [], calls_to_action: { guidance: 'x', never: [] }, voice: 'x', examples: [{ label: 'e', origin: 'approved', emails: [{ body: 'x' }] }],
}

async function compose(row: Record<string, unknown>, dryRun?: Parameters<typeof composeSequence>[0]['dryRun'], playbookFooter?: string) {
  const db = database(row)
  const seq = await composeSequence({ prospect_id: row.id as string, client_id: CLIENT, preloadedDocs: docs(playbookFooter), dryRun })
  return { seq, ...db }
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test'
})

describe('writer v2 composition', () => {
  it('a personalised sequence ships its own four emails: no variant, sign-off and footer on each, follow-ups generated', async () => {
    const { seq, writes } = await compose(prospect())
    expect(seq.variant_id).toBeNull()
    expect(seq.opening.tier).toBe('writer_v2')
    expect(seq.writer).toEqual({ version: 'v2', tier: 'personalised', playbook_version: 3 })
    expect(seq.emails.map(e => e.sequence_position)).toEqual([1, 2, 3, 4])
    for (const e of seq.emails) {
      expect(e.body.startsWith('{{first_name}},\n\n')).toBe(true)
      expect(e.body).toContain('\n\nDana\nTestco Outreach\n\n' + OPT_OUT_FOOTER)
      expect(e.body.split(OPT_OUT_FOOTER)).toHaveLength(2)
    }
    expect(seq.emails[0].subject_line).toBe('the summit')
    expect(seq.emails.slice(1).every(e => e.subject_line === null)).toBe(true)
    expect(seq.followups.positions).toEqual({ 2: { mode: 'generated', fell_back_reason: null }, 3: { mode: 'generated', fell_back_reason: null } })
    // No variant assignment is written for a sequence that came from no variant.
    expect(writes.filter(w => w.table === 'prospects')).toEqual([])
  })

  it('switch on and nothing written yet: not ready, never the old copy', async () => {
    await expect(compose(prospect({ writer_v2_sequence: null, personalisation_trigger: 'An old opening.' }))).rejects.toBeInstanceOf(WriterV2NotReadyError)
  })

  it('a sequence written from a trial playbook file never ships, and composes only in a dry run that asks', async () => {
    const trial = prospect({ writer_v2_sequence: record({ playbook_source: 'file', messaging_doc_id: null }) })
    await expect(compose(trial)).rejects.toThrow(/trial playbook file/)
    const { seq } = await compose(prospect({ organisation: ORG_OFF }), { writerV2: { sequence: record({ playbook_source: 'file' }), allowTrialPlaybook: true } })
    expect(seq.writer?.tier).toBe('personalised')
  })

  it('the template tier ships the approved template, with every old-writer column set aside', async () => {
    const { seq } = await compose(prospect({
      writer_v2_sequence: record({ tier: 'template', emails: null }),
      personalisation_trigger: 'A stale opening from an old run.',
      personalisation_question: 'A stale question?',
      firm_fact: { passed: true, does: 'you run dental clinics' },
    }))
    expect(seq.writer).toEqual({ version: 'v2', tier: 'template', playbook_version: 3 })
    expect(seq.opening.tier).toBe('template')
    expect(seq.variant_id).toBe('A')
    const all = seq.emails.map(e => e.body).join('\n')
    expect(all).not.toContain('A stale opening')
    expect(all).not.toContain('A stale question')
    expect(all).not.toContain('dental clinics')
  })

  it('switch off: the old path, whatever is stored', async () => {
    const { seq } = await compose(prospect({ organisation: ORG_OFF }))
    expect(seq.writer).toBeUndefined()
    expect(seq.variant_id).toBe('A')
    expect(seq.opening.tier).not.toBe('writer_v2')
  })

  it('the send records writer, tier and playbook version in place of the variant', async () => {
    const { seq } = await compose(prospect())
    const { writes, client } = database(prospect())
    await recordSentSequence(client as never, CLIENT, 'prospect-1', seq)
    const row = writes.find(w => w.table === 'sent_sequences')!.payload as Record<string, unknown>
    expect(row).toMatchObject({ variant_id: null, opening_tier: null, sequence_writer: 'v2', writer_tier: 'personalised', playbook_version: 3, followup_arm: 'generated' })
  })

  it('an old-path send records v1 and no writer tier', async () => {
    const { seq } = await compose(prospect({ organisation: ORG_OFF }))
    const { writes, client } = database(prospect())
    await recordSentSequence(client as never, CLIENT, 'prospect-1', seq)
    const row = writes.find(w => w.table === 'sent_sequences')!.payload as Record<string, unknown>
    expect(row).toMatchObject({ variant_id: 'A', sequence_writer: 'v1', writer_tier: null, playbook_version: null })
  })
})

describe('the opt-out footer is the client\'s own for a writer v2 client', () => {
  it('every email of a v2 sequence carries the playbook footer, once, and the sequence says which', async () => {
    const { seq } = await compose(prospect(), undefined, CLIENT_FOOTER)
    expect(seq.opt_out_footer).toBe(CLIENT_FOOTER)
    for (const e of seq.emails) {
      expect(e.body.endsWith(`\n\n${CLIENT_FOOTER}`)).toBe(true)
      expect(e.body).not.toContain(OPT_OUT_FOOTER)
    }
  })

  it('the template tier of a v2 client carries it too', async () => {
    const { seq } = await compose(prospect({ writer_v2_sequence: record({ tier: 'template', emails: null }) }), undefined, CLIENT_FOOTER)
    expect(seq.emails.every(e => e.body.endsWith(CLIENT_FOOTER))).toBe(true)
  })

  it('an old-path client keeps the default footer whatever its document holds', async () => {
    const { seq } = await compose(prospect({ organisation: ORG_OFF }), undefined, CLIENT_FOOTER)
    expect(seq.opt_out_footer).toBe(OPT_OUT_FOOTER)
    expect(seq.emails.every(e => e.body.endsWith(OPT_OUT_FOOTER))).toBe(true)
  })

  it('a v2 client with no footer in its playbook gets the default', async () => {
    const { seq } = await compose(prospect())
    expect(seq.opt_out_footer).toBe(OPT_OUT_FOOTER)
  })

  it('the HTML spaces the client footer as a notice, as it does the default', async () => {
    const { plainTextToHtml, composedToVariables } = await import('../custom-variables')
    expect(plainTextToHtml(`Hi\n\n${CLIENT_FOOTER}`, CLIENT_FOOTER)).toMatch(/<p style="margin-top:\d+px">Not the right moment/)
    const { seq } = await compose(prospect(), undefined, CLIENT_FOOTER)
    const vars = composedToVariables(seq.emails, 'Ada', seq.opt_out_footer)
    expect(vars.m_body_1).toMatch(/<p style="margin-top:\d+px">Not the right moment/)
  })

  it('a footer that says "unsubscribe", runs over two lines or uses a dash is refused', async () => {
    const { optOutFooterProblems } = await import('@/lib/writer-v2/playbook')
    expect(optOutFooterProblems(CLIENT_FOOTER)).toEqual([])
    expect(optOutFooterProblems('Click to unsubscribe').join()).toMatch(/unsubscribe/)
    expect(optOutFooterProblems('Line one\nLine two').join()).toMatch(/one line/)
    expect(optOutFooterProblems('Not now — reply no').join()).toMatch(/dash/)
  })
})
