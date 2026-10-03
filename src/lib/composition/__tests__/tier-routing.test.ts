// Tier routing through composeSequence itself, in the order the operator set (2026-09-30):
//
//   tier 1  research     a personalised opening that passed every gate
//   tier 2  firm_fact    fresh website text, identity and faithfulness passed, a specific
//                        {for_whom}, and the client's switch on
//   tier 3  template     the slot-free template
//
// plus: the tier, the variant and the template version (messaging_doc_id) recorded on every
// send; sequence coherence both ways; and a dry run that writes nothing.
//
// The database is a recording stand-in. It returns the prospect row it is given and records
// every table it is asked to WRITE, so "wrote nothing" is an observation, not an assumption.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createClient } from '@supabase/supabase-js'

vi.mock('@supabase/supabase-js')
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

import { composeSequence } from '../compose-sequence'
import { logger } from '@/lib/logger'
import { decideFollowupFills } from '../firm-fact-email1'
import { countWords } from '../personalization'
import { EMAIL_WORD_LIMITS } from '@/agents/messaging-generation-agent'
import type { ComposeDocs } from '../compose-sequence'
import { recordSentSequence } from '../record-sent-sequence'
import { FIRM_FACT_CHECKS_VERSION } from '@/lib/agents/research/firm-fact-checks'
import { buildMessagingContent } from '@/agents/outbound-template-agent'
import {
  INVENTED_OPENER_FRAMES,
  INVENTED_PEER_FRAMES,
  INVENTED_SIGNOFF,
  inventedBrief,
  inventedPeerBrief,
  inventedVariants,
} from '@/lib/outbound-templates/__tests__/fixtures/invented-client'

const CLIENT = 'client-1'
const DOC_ID = 'doc-version-7'

function content(enabled = true): Record<string, any> {
  return buildMessagingContent({
    base: {}, brief: inventedBrief(),
    result: { opener_frames: INVENTED_OPENER_FRAMES, variants: inventedVariants() },
    signoff: INVENTED_SIGNOFF, firmFactTierEnabled: enabled,
  }) as Record<string, any>
}

const FRESH = new Date(Date.now() - 5 * 86_400_000).toISOString()
const GOOD_FACT = {
  version: FIRM_FACT_CHECKS_VERSION,
  passed: true, does: 'you run dental clinics', for_whom: 'bakeries',
  peer_group_label: 'software makers', research_result_id: 'rr-1', source_fetched_at: FRESH,
}

function prospect(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prospect-1', organisation_id: CLIENT, segment_id: null, variant_id: 'A',
    personalisation_trigger: null, personalisation_question: null, personalisation_subject: null,
    followup_email2: null, followup_email3: null, followup_email1_fingerprint: null,
    has_dateable_signal: false, signal_relevance: null, role: 'CEO', job_title: 'CEO',
    first_name: 'Ada', last_name: 'Lee', company_name: 'Testco', firm_fact: null,
    ...overrides,
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

function docs(c: Record<string, any>): ComposeDocs {
  return { messagingDoc: c, messagingDocId: DOC_ID } as unknown as ComposeDocs
}

async function compose(row: Record<string, unknown>, c = content(), dryRun?: { firmFact?: unknown }) {
  const db = database(row)
  const seq = await composeSequence({ prospect_id: row.id as string, client_id: CLIENT, preloadedDocs: docs(c), dryRun })
  return { seq, ...db }
}

const email = (seq: Awaited<ReturnType<typeof composeSequence>>, n: number) => seq.emails.find(e => e.sequence_position === n)!

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test'
})

describe('tier routing, in order', () => {
  it('tier 1: a researched opening wins even when a passing firm fact exists', async () => {
    const { seq } = await compose(prospect({ personalisation_trigger: 'Your team opened a second office in Leeds.', firm_fact: GOOD_FACT }))
    expect(seq.opening.tier).toBe('research')
    expect(email(seq, 1).body).toContain('Your team opened a second office in Leeds.')
    expect(email(seq, 1).body).not.toContain('you run dental clinics')
  })

  it('tier 2: no research, a passing fact with a specific for_whom, switch on', async () => {
    const { seq } = await compose(prospect({ firm_fact: GOOD_FACT }))
    expect(seq.opening.tier).toBe('firm_fact')
    expect(email(seq, 1).body).toContain('you run dental clinics.')
    // The pain line names the reader's own group as its source (2026-10-03).
    expect(email(seq, 1).body).toMatch(/\n\n(When we chat to software makers, a lot of them say|Talking to software makers, we hear that) /)
    expect(email(seq, 1).body).toContain('bakeries')
    // Follow-ups are the template's paragraphs, with the same group named as their source.
    expect(email(seq, 2).body).toContain('When we chat to software makers, a lot of them say a new market starts slower than hoped.')
  })

  it.each([
    ['no fact at all', null, 'no_fact'],
    ['a fact that failed', { ...GOOD_FACT, passed: false }, 'fact_did_not_pass'],
    ['a fact from a stale page', { ...GOOD_FACT, source_fetched_at: '2026-01-01T00:00:00Z' }, 'stale_source'],
  ])('tier 3: %s ships the slot-free template', async (_name, fact, reason) => {
    const { seq } = await compose(prospect({ firm_fact: fact }))
    expect(seq.opening).toMatchObject({ tier: 'template', detail: { reason } })
    expect(email(seq, 1).body).toMatch(/^\{\{first_name\}\}\n\n(When we chat to exporters, a lot of them say buyers abroad|Talking to exporters, we hear that buyers leave)/)
    expect(email(seq, 1).body).not.toMatch(/\{(does|for_whom|peer_group|company)\}/)
    expect(email(seq, 1).body).not.toContain('dental clinics')
  })

  it('tier 2 without a customer group: the opener still ships, on the slot-free offer (rule 9)', async () => {
    const { seq } = await compose(prospect({ firm_fact: { ...GOOD_FACT, for_whom: null } }))
    expect(seq.opening.tier).toBe('firm_fact')
    expect(email(seq, 1).body).toContain('you run dental clinics.')
    expect(email(seq, 1).body).toMatch(/buyers abroad|your buyers/)
  })

  it('tier 3: the client switch off beats a passing fact', async () => {
    const { seq } = await compose(prospect({ firm_fact: GOOD_FACT }), content(false))
    expect(seq.opening).toMatchObject({ tier: 'template', detail: { reason: 'tier_off' } })
  })
})

describe('what is recorded on every send', () => {
  it.each([
    ['research', { personalisation_trigger: 'Your team opened a second office in Leeds.' }],
    ['firm_fact', { firm_fact: GOOD_FACT }],
    ['template', {}],
  ])('%s: tier, variant and template version', async (tier, overrides) => {
    const { seq, client } = await compose(prospect(overrides))
    const record = database(prospect(overrides))
    await recordSentSequence(record.client as never, CLIENT, 'prospect-1', seq)
    const row = record.writes.find(w => w.table === 'sent_sequences' && w.op === 'insert')!.payload as Record<string, unknown>
    expect(row).toMatchObject({ opening_tier: tier, variant_id: 'A', messaging_doc_id: DOC_ID })
    // Which wording of each line shipped is on the record for every tier (rule 8).
    expect((row.opening_detail as { wording?: unknown }).wording).toBeTruthy()
    expect(client).toBeDefined()
  })
})

describe('sequence coherence at composition (tier 1), both ways', () => {
  it('a validated document: no follow-up reuses Email 1\'s angle, and nothing is swapped', async () => {
    const { seq } = await compose(prospect({ personalisation_trigger: 'Your team opened a second office in Leeds.' }))
    const detail = seq.opening.detail as { email1_angle: string; followup_angles: Record<number, string>; swaps: unknown[] }
    expect(detail.email1_angle).toBe('PA1')
    expect([detail.followup_angles[2], detail.followup_angles[3]]).not.toContain('PA1')
    expect(detail.swaps).toEqual([])
    expect(email(seq, 2).body).toContain('When we chat to exporters, a lot of them say a new market starts slower than hoped.')
  })

  it('a document whose Email 2 repeats Email 1\'s angle: Email 2 is replaced from another variant', async () => {
    const c = content()
    // Not a document the validator would pass: variant A's Email 2 is marked as the SAME
    // angle its Email 1 uses. Its Email 3 is moved off PA3 so variant B's Email 2 (PA3)
    // is free, and B's Email 2 is lengthened so Email 3 stays no longer than Email 2.
    c.variants.A.lines.followups[0].angle = 'PA1'
    c.variants.A.lines.followups[1].angle = 'PA2'
    c.variants.B.emails[1].body = c.variants.B.emails[1].body.replace('Sam\nQuillmere', 'That cost is easy to miss when it happens.\n\nSam\nQuillmere')
    const { seq } = await compose(prospect({ personalisation_trigger: 'Your team opened a second office in Leeds.' }), c)
    const detail = seq.opening.detail as { swaps: Array<{ position: number; to_variant: string; to_angle: string }>; followup_angles: Record<number, string> }
    expect(detail.swaps).toContainEqual(expect.objectContaining({ position: 2, to_variant: 'B', to_angle: 'PA3' }))
    expect(detail.followup_angles[2]).not.toBe('PA1')
    expect(email(seq, 2).body).toContain('When we chat to exporters, a few say they tried free tools first to save money.')
    expect(email(seq, 2).body).not.toContain('a new market starts slower')
  })

  it('does not touch the follow-ups of a template-tier prospect', async () => {
    const c = content()
    c.variants.A.lines.followups[0].angle = 'PA1'
    const { seq } = await compose(prospect({}), c)
    expect(seq.opening.tier).toBe('template')
    expect(email(seq, 2).body).toContain('a new market starts slower')
  })
})

describe('dry run', () => {
  it('assigns a variant and writes nothing', async () => {
    const { seq, writes } = await compose(prospect({ variant_id: null }), content(), {})
    expect(['A', 'B']).toContain(seq.variant_id)
    expect(writes).toEqual([])
  })

  it('a normal run DOES write the variant assignment (control)', async () => {
    const { writes } = await compose(prospect({ variant_id: null }))
    expect(writes.some(w => w.table === 'prospects' && w.op === 'update')).toBe(true)
  })

  it('honours a supplied firm fact only in a dry run', async () => {
    const dry = await compose(prospect({ firm_fact: null }), content(), { firmFact: GOOD_FACT })
    expect(dry.seq.opening.tier).toBe('firm_fact')
    expect(dry.writes).toEqual([])
  })
})

describe('wording rotation at composition (rule 8)', () => {
  it('tier 3 rotates the approved wordings across prospects and records the choice', async () => {
    const bodies = new Set<string>()
    for (let i = 0; i < 24; i++) {
      const { seq } = await compose(prospect({ id: `prospect-${i}` }))
      expect(seq.opening.tier).toBe('template')
      const detail = seq.opening.detail as { wording: Record<string, number>; wording_counts: Record<string, number> }
      expect(detail.wording_counts).toMatchObject({ pain: 2, offer: 2, question: 2 })
      bodies.add(email(seq, 1).body)
    }
    expect(bodies.size).toBeGreaterThan(3)
  })

  it('tier 1 always keeps wording 0 of the offer, the one the opening was written against', async () => {
    const c = content()
    // Wording 0 of the offer, behind the lead-in, which names the firm on every tier (2026-10-03).
    const offerZero = 'If Testco is seeing this too, we translate your pages and a native speaker checks each one, so your buyers can read your site.'
    for (let i = 0; i < 12; i++) {
      const { seq } = await compose(prospect({ id: `prospect-${i}`, personalisation_trigger: 'Your team opened a second office in Leeds.' }), c)
      expect(email(seq, 1).body).toContain(offerZero)
      expect((seq.opening.detail as { wording: Record<string, number | null> }).wording).toMatchObject({ pain: null, offer: 0 })
    }
  })

  it('a document whose stored body has drifted from its lines ships the stored body, and says why', async () => {
    const c = content()
    c.variants.A.emails[0].body = c.variants.A.emails[0].body.replace('sales can stall', 'sales may stall')
    const { seq } = await compose(prospect({}), c)
    expect(email(seq, 1).body).toContain('sales may stall')
    expect(seq.opening.detail).toMatchObject({ wording: null, wording_not_rotated: 'stored_body_differs_from_lines' })
  })
})


describe('the reader\'s firm by name in the template follow-ups (fourth reading, note 2)', () => {
  const slotFills = (seq: Awaited<ReturnType<typeof composeSequence>>) => seq.followups.slot_fills ?? {}

  it('PLANTED: a template-tier prospect with a usable name gets it in Email 2 and in the Email 3 offer', async () => {
    const { seq } = await compose(prospect({ company_name: 'The Testco Company, Inc.' }))
    expect(seq.opening.tier).toBe('template')
    expect(email(seq, 2).body).toContain('Does that match what Testco sees?')
    expect(email(seq, 3).body).toContain('so people overseas can read what Testco sells.')
    expect(email(seq, 3).body).not.toContain('{company}')
    expect(slotFills(seq)[2]).toEqual({ company: true, for_whom: false, peer_group: false })
    expect(slotFills(seq)[3]).toEqual({ company: true, for_whom: false, peer_group: false })
    // Email 4 holds no slot in this document: it is the stored body, and the record says why.
    expect(slotFills(seq)[4]).toEqual({ reason: 'no_slots' })
    // The word count is of what ships.
    expect(email(seq, 3).word_count).toBe(email(seq, 3).body.replace('Not for you? Just reply stop.', '').trim().split(/\s+/).length)
  })

  it.each([
    ['no name on the record', null],
    ['a name with a dash standing between words', 'Testco – Cold Storage'],
    ['a name that ends in a full stop', 'Testco Bros.'],
    ['a value that is not a firm', 'Self-employed'],
    ['the reader\'s own name with a legal form after it', 'Ada Lee Ltd'],
    ['a name written all in capitals', 'TESTCO HOLDINGS LIMITED'],
    ['a name of only generic words', 'Global Group Ltd'],
  ])('PLANTED: %s ships the slot-free follow-ups exactly as stored', async (_why, companyName) => {
    const c = content()
    const { seq } = await compose(prospect({ company_name: companyName }), c)
    for (const position of [2, 3, 4]) {
      expect(email(seq, position).body.startsWith(c.variants.A.emails[position - 1].body), `Email ${position}`).toBe(true)
    }
    expect(email(seq, 3).body).toContain('so people overseas can read what you sell.')
    expect(slotFills(seq)[3]).toEqual({ reason: 'nothing_held' })
  })

  // THE FIRM'S OWN TRADE WORDS (review of 2026-10-02, round two). companyShortName takes a
  // generic-looking word off a name; "Logistics" is generic for most firms and is this
  // firm's trade. The stored record says so, and the same record the peer rung is built
  // from is now passed to the follow-ups.
  it('PLANTED: a firm whose stored industry holds the word its name is cut to keeps its full name', async () => {
    const { seq } = await compose(prospect({ company_name: 'Logistics Solutions', company_industry: 'logistics and supply chain' }))
    expect(email(seq, 3).body).toContain('so people overseas can read what Logistics Solutions sells.')
    const c = content()
    const direct = decideFollowupFills({
      messagingContent: c, body: c.variants.A.emails[2].body, position: 3, companyName: 'Logistics Solutions', forWhom: null,
      company: { name: 'Logistics Solutions', industry: 'logistics and supply chain', tags: [] },
    })
    expect(direct.filled && direct.fills.company).toBe('Logistics Solutions')
  })

  it('the same name with no record, or a record of another trade, is cut to "Logistics" (control: the known limit without the record)', async () => {
    const { seq } = await compose(prospect({ company_name: 'Logistics Solutions' }))
    expect(email(seq, 3).body).toContain('so people overseas can read what Logistics sells.')
    const c = content()
    const direct = decideFollowupFills({
      messagingContent: c, body: c.variants.A.emails[2].body, position: 3, companyName: 'Logistics Solutions', forWhom: null,
      company: { name: 'Logistics Solutions', industry: 'marketing', tags: ['advertising'] },
    })
    expect(direct.filled && direct.fills.company).toBe('Logistics')
  })

  it('PLANTED: a stored follow-up that has drifted from its lines ships untouched, and the record says why', async () => {
    // The same proof the tier 3 wording rotation asks for: if the stored body is not the
    // slot-free rendering of the lines, nobody can say the filled rendering is the approved copy.
    const c = content()
    c.variants.A.emails[2].body = c.variants.A.emails[2].body.replace('Would a short call be useful?', 'Would a call be useful?')
    const { seq } = await compose(prospect({}), c)
    expect(email(seq, 3).body).toContain('Would a call be useful?')
    expect(email(seq, 3).body).toContain('what you sell.')
    expect(slotFills(seq)[3]).toEqual({ reason: 'stored_body_differs_from_lines' })
    // Email 2 was not touched by the drift and still carries the name.
    expect(email(seq, 2).body).toContain('Does that match what Testco sees?')
  })

  it('PLANTED: the follow-up fills never touch Email 1: only its lead-in names the firm, and its fingerprint is the unnamed one', async () => {
    // Since 2026-10-03 Email 1's lead-in names the firm on every tier ("If Testco is seeing
    // this too, we ..."). That is the ONLY difference, and it is made after the fingerprint
    // the follow-ups are written against is taken.
    const c = content()
    const named = await compose(prospect({ company_name: 'Testco' }), c)
    const unnamed = await compose(prospect({ company_name: null }), c)
    expect(email(named.seq, 1).body.replace('If Testco is seeing this too,', "If you're seeing this too,")).toBe(email(unnamed.seq, 1).body)
    expect(named.seq.followups.email1_fingerprint).toBe(unnamed.seq.followups.email1_fingerprint)
    expect(email(named.seq, 1).body.split('Testco')).toHaveLength(2)
  })

  it('PLANTED: a personalised prospect keeps its generated follow-up as written; the template one beside it is named', async () => {
    const c = content()
    // First compose to learn the fingerprint the generated copy must have been written against.
    const row = prospect({ personalisation_trigger: 'Your team opened a second office in Leeds.' })
    const first = await compose(row, c)
    const generated = 'A second office usually means a second market to sell into. That is where pages in one language start to cost sales.'
    const { seq } = await compose({ ...row, followup_email2: generated, followup_email1_fingerprint: first.seq.followups.email1_fingerprint }, c)
    if (seq.followups.arm !== 'generated') return   // the arm is assigned by prospect id; at 100% generated this always runs
    expect(seq.followups.positions[2].mode).toBe('generated')
    expect(email(seq, 2).body).toContain(generated)
    expect(email(seq, 2).body).not.toContain('Testco')
    expect(slotFills(seq)[2]).toBeUndefined()
    // Email 3 fell back to the template, and the template names the firm.
    expect(seq.followups.positions[3].mode).toBe('template')
    expect(email(seq, 3).body).toContain('Testco')
  })

  it('PLANTED: {for_whom} in a follow-up is filled only from what Email 1 itself shipped', async () => {
    const c = content()
    // Give Email 2's first paragraph a customer-group form.
    const p = c.variants.A.lines.followups[0].paragraphs[0]
    // Its slot_free form is the paragraph as stored, so the stored body still matches the lines.
    p.text = 'When we chat to exporters, a lot of them say a new market starts slower when {for_whom} are slow to buy.'
    p.slots = ['for_whom']
    p.slot_free = 'When we chat to exporters, a lot of them say a new market starts slower than hoped.'
    const tier2 = await compose(prospect({ firm_fact: GOOD_FACT }), c)
    expect(tier2.seq.opening.tier).toBe('firm_fact')
    expect(email(tier2.seq, 2).body).toContain('when bakeries are slow to buy.')
    expect(slotFills(tier2.seq)[2]).toEqual({ company: true, for_whom: true, peer_group: false })
    // Email 3 holds no customer-group paragraph: the record says what WENT IN, so its
    // for_whom is false although the prospect holds one.
    expect(email(tier2.seq, 3).body).not.toContain('bakeries')
    expect(slotFills(tier2.seq)[3]).toEqual({ company: true, for_whom: false, peer_group: true })
    // A template-tier prospect holds no customer group: that paragraph is slot-free, and the
    // paragraph that names the firm is still filled, on its own.
    const tier3 = await compose(prospect({}), c)
    expect(email(tier3.seq, 2).body).toContain('a new market starts slower than hoped.')
    expect(email(tier3.seq, 2).body).toContain('Does that match what Testco sees?')
  })
  it('PLANTED: a filled follow-up over its word band ships the stored body, and the record says why', () => {
    // Email 2 padded until its slot-free body sits exactly on the band's ceiling. A one-word
    // name in place of "you" keeps the count; a four-word name goes over.
    const variants = inventedVariants()
    const first = variants.A.followups[0].paragraphs[0]
    const build = () => buildMessagingContent({
      base: {}, brief: inventedBrief(), result: { opener_frames: INVENTED_OPENER_FRAMES, variants },
      signoff: INVENTED_SIGNOFF, firmFactTierEnabled: true,
    }) as Record<string, any>
    let c = build()
    while (countWords(c.variants.A.emails[1].body) < EMAIL_WORD_LIMITS.email2MaxWords) {
      first.text = first.text.replace(/\.$/, ' again.')
      c = build()
    }
    const body = c.variants.A.emails[1].body
    expect(countWords(body)).toBe(EMAIL_WORD_LIMITS.email2MaxWords)
    const long = decideFollowupFills({ messagingContent: c, body, position: 2, companyName: 'Northtown Cold Room Engineering', forWhom: null })
    expect(long).toEqual({ filled: false, reason: 'filled_body_over_band' })
    // Control: the same document and a one-word name fills.
    const short = decideFollowupFills({ messagingContent: c, body, position: 2, companyName: 'Testco', forWhom: null })
    expect(short.filled).toBe(true)
  })

  it('PLANTED: lines written from an older brief are not filled from', async () => {
    const c = content()
    c.variants.A.lines.brief_version = c.outbound_brief.brief_version - 1
    const { seq } = await compose(prospect({}), c)
    expect(email(seq, 2).body.startsWith(c.variants.A.emails[1].body)).toBe(true)
    expect(slotFills(seq)[2]).toEqual({ reason: 'body_is_not_a_stored_template' })
    // Control: with the lines current, the same prospect is named.
    const current = await compose(prospect({}), content())
    expect(email(current.seq, 2).body).toContain('Testco')
  })
})

// ── The peer rung through composeSequence itself (fifth reading, note 1, 2026-10-02) ──────
//
// "Build, don't check": the broadest rung is assembled from the prospect's STORED record.
// composeSequence is where that record is read off the prospect row: the provider's
// industry, the company's name, and the keywords on the stored enrichment. These tests run
// the whole composition, so they hold the row-to-record step as well as the decision.

describe('the peer rung, from the prospect row to the email', () => {
  /**
   * The invented client's document WITH a peer kind and a site-free frame, and its peer label
   * moved apart from the kind. The shared fixture's "software makers" under "you run a
   * software company" fails the peer rung on "software" since the after-opener label was
   * withdrawn (2026-10-03; planted below), and these tests are about the rung shipping.
   */
  const PEER_LABEL_APART = 'app makers'
  function peerContent(enabled = true): Record<string, any> {
    const brief = inventedPeerBrief()
    brief.peer_groups[0].label = PEER_LABEL_APART
    return buildMessagingContent({
      base: {}, brief,
      result: { opener_frames: INVENTED_PEER_FRAMES, variants: inventedVariants() },
      signoff: INVENTED_SIGNOFF, firmFactTierEnabled: enabled,
    }) as Record<string, any>
  }

  // An invented company. Its stored industry is one the brief has a kind for, and its name
  // holds a word the brief lists as true of every firm this client writes to ("export").
  const SOFTWARE_EXPORTER = { company_name: 'Kessel Export', company_industry: 'software publishers' }
  const PEER_EMAIL1 = /^\{\{first_name\}\}\n\nCan see you run a software company\.\n\n(When we chat to app makers, a lot of them say|Talking to app makers, we hear that) /
  const TEMPLATE_EMAIL1 = /^\{\{first_name\}\}\n\n(When we chat to exporters, a lot of them say buyers abroad|Talking to exporters, we hear that buyers leave)/

  it('PLANTED: a row with a stored industry, a name that says the kind and no firm fact composes tier firm_fact, rung peer', async () => {
    const { seq } = await compose(prospect(SOFTWARE_EXPORTER), peerContent())
    expect(seq.opening.tier).toBe('firm_fact')
    expect(seq.opening.detail).toMatchObject({
      rung: 'peer',
      fact_reason: 'no_fact',
      research_result_id: null,
      peer: { peer_group_id: 'PG1', industry: 'Software Publishers', evidence: { word: 'export', found_in: 'name' } },
      fills: { peer_group: PEER_LABEL_APART },
    })
    // The group's own label is named; nothing stands in for it (2026-10-03).
    expect('peer_label_replaced' in (seq.opening.detail as Record<string, unknown>)).toBe(false)
    expect(email(seq, 1).body).toMatch(PEER_EMAIL1)
    // The frame that names their site is never over a line nobody read on their site.
    expect(email(seq, 1).body).not.toContain('Your site says')
    // The follow-ups are the template's paragraphs, with the same group named as their source.
    expect(email(seq, 2).body).toContain(`When we chat to ${PEER_LABEL_APART}, a lot of them say a new market starts slower than hoped.`)
    // The word count is of the Email 1 that ships.
    expect(email(seq, 1).word_count).toBe(countWords(email(seq, 1).body.replace('Not for you? Just reply stop.', '').trim()))
  })

  it('PLANTED: the shared peer fixture, "software makers" under "you run a software company", ships the peer rung from the row to the email (2026-10-03)', async () => {
    const shared = buildMessagingContent({
      base: {}, brief: inventedPeerBrief(), result: { opener_frames: INVENTED_PEER_FRAMES, variants: inventedVariants() },
      signoff: INVENTED_SIGNOFF, firmFactTierEnabled: true,
    }) as Record<string, any>
    const { seq } = await compose(prospect(SOFTWARE_EXPORTER), shared)
    // Until 2026-10-03 the label's word "software" failed the rung and the template shipped.
    expect(seq.opening).toMatchObject({ tier: 'firm_fact', detail: { rung: 'peer', fills: { peer_group: 'software makers' } } })
    expect(email(seq, 1).body).toContain('you run a software company')
    expect(email(seq, 1).body).toContain('software makers')
  })

  it('the same row with no stored industry composes the template, and the record says why there was no peer rung (control)', async () => {
    const { seq } = await compose(prospect({ ...SOFTWARE_EXPORTER, company_industry: null }), peerContent())
    expect(seq.opening).toMatchObject({ tier: 'template', detail: { reason: 'no_fact', peer_reason: 'no_stored_industry' } })
    expect(email(seq, 1).body).toMatch(TEMPLATE_EMAIL1)
    expect(email(seq, 1).body).not.toContain('Can see')
    expect(email(seq, 1).body).not.toContain('a software company')
  })

  it('PLANTED: the keywords on the stored enrichment are read: a plain name is evidenced by a tag', async () => {
    const plainName = { company_name: 'Kessel', company_industry: 'software publishers' }
    const { seq } = await compose(
      prospect({ ...plainName, apollo_enrichment_data: { organization: { keywords: ['cloud hosting', 'food exporter'] } } }),
      peerContent(),
    )
    expect(seq.opening.tier).toBe('firm_fact')
    expect(seq.opening.detail).toMatchObject({ rung: 'peer', peer: { evidence: { word: 'exporter', found_in: 'tag' } } })
    expect(email(seq, 1).body).toMatch(PEER_EMAIL1)
    // Control: the same plain name with no keywords stored says nothing about the kind of
    // firm, so the sentence is not written. The industry alone is never enough.
    const bare = await compose(prospect(plainName), peerContent())
    expect(bare.seq.opening).toMatchObject({ tier: 'template', detail: { reason: 'no_fact', peer_reason: 'kind_not_evidenced' } })
    expect(email(bare.seq, 1).body).toMatch(TEMPLATE_EMAIL1)
    // And keywords that do not say it either change nothing. Since 2026-10-02 that includes
    // a keyword that only HOLDS the word and is about something else: "export tools" was
    // evidence until then, and "tools for exporters" names the firm's customers.
    for (const keywords of [['cloud hosting'], ['cloud hosting', 'export tools'], ['tools for exporters']]) {
      const other = await compose(prospect({ ...plainName, apollo_enrichment_data: { organization: { keywords } } }), peerContent())
      expect(other.seq.opening, keywords.join(', ')).toMatchObject({ tier: 'template', detail: { peer_reason: 'kind_not_evidenced' } })
    }
  })

  // ── What is recorded and logged when a rung is REJECTED (review of 2026-10-02) ──
  //
  // Until then the peer rung's failure was written into `reason`, so a prospect who never
  // had a firm fact was recorded, and logged, as "firm-fact Email 1 rejected".
  describe('a rejected rung is recorded and logged as the rung it was', () => {
    const HARD_KIND = 'an independent telecommunications infrastructure consultancy'
    const hardPeerContent = () => {
      const brief = inventedPeerBrief()
      brief.peer_groups[0].kind = HARD_KIND
      return buildMessagingContent({
        base: {}, brief, result: { opener_frames: INVENTED_PEER_FRAMES, variants: inventedVariants() },
        signoff: INVENTED_SIGNOFF, firmFactTierEnabled: true,
      }) as Record<string, any>
    }
    const warnings = () => vi.mocked(logger.warn).mock.calls.map(call => ({ message: String(call[0]), context: (call[1] ?? {}) as Record<string, unknown> }))
    const rejections = () => warnings().filter(w => / rejected, template ships$/.test(w.message))

    it('PLANTED: no firm fact, and the line built from the record fails with its real words: the detail keeps "no_fact" and the peer failure apart, and the log names the record-built line', async () => {
      vi.mocked(logger.warn).mockClear()
      const { seq } = await compose(prospect(SOFTWARE_EXPORTER), hardPeerContent())
      expect(seq.opening.tier).toBe('template')
      const detail = seq.opening.detail as Record<string, unknown>
      expect(detail).toMatchObject({ reason: 'no_fact', peer_reason: 'revalidation_failed' })
      expect('violations' in detail).toBe(false)
      expect((detail.peer_violations as string[]).join(' ')).toContain('opener_clause_grade')
      expect(rejections().map(w => w.message)).toEqual(['compose-sequence: the Email 1 built from the stored record was rejected, template ships'])
      expect(rejections()[0].context).toMatchObject({ reason: 'no_fact', peer_reason: 'revalidation_failed' })
      expect((rejections()[0].context.peer_violations as string[]).join(' ')).toContain('opener_clause_grade')
      // It is never called a firm-fact rejection: this prospect has no firm fact.
      expect(warnings().some(w => w.message.includes('firm-fact Email 1 rejected'))).toBe(false)
    })

    it('a stored fact whose own rung fails is still logged as a firm-fact rejection, with its violations (control)', async () => {
      vi.mocked(logger.warn).mockClear()
      const hardFact = { ...GOOD_FACT, does: 'you provide organisational internationalisation documentation', for_whom: null }
      const { seq } = await compose(prospect({ company_name: 'Kessel', firm_fact: hardFact }), peerContent())
      expect(seq.opening).toMatchObject({ tier: 'template', detail: { reason: 'revalidation_failed', peer_reason: 'no_stored_industry' } })
      expect(rejections().map(w => w.message)).toEqual(['compose-sequence: firm-fact Email 1 rejected, template ships'])
      expect((rejections()[0].context.violations as string[]).join(' ')).toContain('opener_clause_grade')
    })

    it('a prospect with no fact and no line from the record is the resting state: nothing is logged as rejected (control)', async () => {
      vi.mocked(logger.warn).mockClear()
      const { seq } = await compose(prospect({ company_name: 'Kessel', company_industry: 'software publishers' }), peerContent())
      expect(seq.opening).toMatchObject({ tier: 'template', detail: { reason: 'no_fact', peer_reason: 'kind_not_evidenced' } })
      expect(rejections()).toEqual([])
    })
  })

  it('PLANTED: a row holding neither a company name nor an industry has no record to build from: peer_reason no_record', async () => {
    const { seq } = await compose(prospect({ company_name: null, company_industry: null }), peerContent())
    expect(seq.opening).toMatchObject({ tier: 'template', detail: { reason: 'no_fact', peer_reason: 'no_record' } })
  })

  it('PLANTED: the order still holds: research first, then a passing fact from their site, then the peer line', async () => {
    const researched = await compose(prospect({ ...SOFTWARE_EXPORTER, personalisation_trigger: 'Your team opened a second office in Leeds.' }), peerContent())
    expect(researched.seq.opening.tier).toBe('research')
    expect(email(researched.seq, 1).body).not.toContain('a software company')

    const withFact = await compose(prospect({ ...SOFTWARE_EXPORTER, firm_fact: GOOD_FACT }), peerContent())
    expect(withFact.seq.opening).toMatchObject({ tier: 'firm_fact', detail: { rung: 'specific', research_result_id: 'rr-1' } })
    expect(email(withFact.seq, 1).body).toContain('you run dental clinics.')
    expect(email(withFact.seq, 1).body).not.toContain('a software company')

    // Control: the same row with neither is the peer rung.
    const neither = await compose(prospect(SOFTWARE_EXPORTER), peerContent())
    expect(neither.seq.opening).toMatchObject({ tier: 'firm_fact', detail: { rung: 'peer' } })
  })

  it('PLANTED: a stored fact that gives no rung falls to the peer line, and the record keeps the fact\'s reason', async () => {
    const { seq } = await compose(prospect({ ...SOFTWARE_EXPORTER, firm_fact: { ...GOOD_FACT, passed: false } }), peerContent())
    expect(seq.opening).toMatchObject({ tier: 'firm_fact', detail: { rung: 'peer', fact_reason: 'fact_did_not_pass', research_result_id: null } })
    expect(email(seq, 1).body).toMatch(PEER_EMAIL1)
  })

  it('PLANTED: the client\'s switch off beats the peer rung, and nothing about it is recorded', async () => {
    const { seq } = await compose(prospect(SOFTWARE_EXPORTER), peerContent(false))
    expect(seq.opening).toMatchObject({ tier: 'template', detail: { reason: 'tier_off' } })
    expect('peer_reason' in (seq.opening.detail as Record<string, unknown>)).toBe(false)
    expect(email(seq, 1).body).toMatch(TEMPLATE_EMAIL1)
  })

  it('PLANTED: a document whose brief holds no kind for the industry ships the template for the same row', async () => {
    // The shared fixture: no peer kind and no site-free frame. An older document is not
    // given a peer line by a newer row.
    const { seq } = await compose(prospect(SOFTWARE_EXPORTER), content())
    expect(seq.opening).toMatchObject({ tier: 'template', detail: { reason: 'no_fact', peer_reason: 'no_kind_for_industry' } })
    expect(email(seq, 1).body).toMatch(TEMPLATE_EMAIL1)
  })

  it('PLANTED: the send record carries the tier, the rung and what the line was built from', async () => {
    const { seq } = await compose(prospect(SOFTWARE_EXPORTER), peerContent())
    const record = database(prospect(SOFTWARE_EXPORTER))
    await recordSentSequence(record.client as never, CLIENT, 'prospect-1', seq)
    const row = record.writes.find(w => w.table === 'sent_sequences' && w.op === 'insert')!.payload as Record<string, unknown>
    expect(row).toMatchObject({
      opening_tier: 'firm_fact',
      variant_id: 'A',
      messaging_doc_id: DOC_ID,
      opening_detail: { rung: 'peer', fact_reason: 'no_fact', peer: { peer_group_id: 'PG1', industry: 'Software Publishers', evidence: { word: 'export', found_in: 'name' } } },
    })
  })

  it('PLANTED: a dry run composes the peer rung and writes nothing', async () => {
    const { seq, writes } = await compose(prospect({ ...SOFTWARE_EXPORTER, variant_id: null }), peerContent(), {})
    expect(seq.opening).toMatchObject({ tier: 'firm_fact', detail: { rung: 'peer' } })
    expect(writes).toEqual([])
  })

  describe('the row is read with the columns the peer rung needs', () => {
    // The stand-in above hands back the whole row whatever was asked for, so it cannot tell
    // whether composeSequence ASKS the database for the two columns. This one returns only
    // the columns named in the select, as the real database does.
    function databaseReturningOnlySelectedColumns(row: Record<string, unknown>) {
      const selected: string[][] = []
      const from = (table: string) => {
        let columns: string[] | null = null
        const chain: any = new Proxy({}, {
          get(_t, prop: string) {
            if (prop === 'select') {
              return (list?: string) => {
                if (table === 'prospects' && typeof list === 'string' && list.trim() !== '*') {
                  columns = list.split(',').map(column => column.trim())
                  selected.push(columns)
                }
                return chain
              }
            }
            if (prop === 'single' || prop === 'maybeSingle') {
              return () => {
                if (table !== 'prospects') return Promise.resolve({ data: null, error: null })
                const data = columns === null ? row : Object.fromEntries(columns.filter(column => column in row).map(column => [column, row[column]]))
                return Promise.resolve({ data, error: null })
              }
            }
            if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res)
            return () => chain
          },
        })
        return chain
      }
      const client = { from }
      vi.mocked(createClient).mockReturnValue(client as unknown as ReturnType<typeof createClient>)
      return { client, selected }
    }

    it('the stand-in really does drop a column that was not asked for (control)', async () => {
      const { client } = databaseReturningOnlySelectedColumns({ id: 'prospect-1', company_industry: 'software publishers', company_name: 'Kessel Export' })
      const { data } = await client.from('prospects').select('id, company_name').eq('id', 'prospect-1').single()
      expect(data).toEqual({ id: 'prospect-1', company_name: 'Kessel Export' })
    })

    it('PLANTED: the industry and the stored enrichment are asked for, so the peer rung is still built when only the selected columns come back', async () => {
      // A name with no evidence in it: the rung can only ship if the keywords were read too.
      const row = prospect({
        company_name: 'Kessel', company_industry: 'software publishers',
        apollo_enrichment_data: { organization: { keywords: ['food exporter'] } },
      })
      const { selected } = databaseReturningOnlySelectedColumns(row)
      const seq = await composeSequence({ prospect_id: 'prospect-1', client_id: CLIENT, preloadedDocs: docs(peerContent()), dryRun: {} })
      expect(selected.length).toBeGreaterThan(0)
      expect(selected.some(columns => columns.includes('company_industry') && columns.includes('apollo_enrichment_data') && columns.includes('company_name'))).toBe(true)
      expect(seq.opening).toMatchObject({ tier: 'firm_fact', detail: { rung: 'peer', peer: { evidence: { word: 'exporter', found_in: 'tag' } } } })
    })
  })
})

// ── Email 1's lead-in names the reader's firm, on every tier (operator, 2026-10-03) ────────
//
// "If Testco is seeing this too, we ...": composition names the firm in the lead-in after the
// Email 1 fingerprint is taken, and records it in slot_fills[1]. Run through composeSequence
// so the row-to-name step and the record are held as well as the decision.

describe('Email 1\'s lead-in names the reader\'s firm, on every tier (2026-10-03)', () => {
  const slotFills = (seq: Awaited<ReturnType<typeof composeSequence>>) => seq.followups.slot_fills ?? {}
  const NAMED = '\n\nIf Testco is seeing this too, we '
  const UNNAMED = "\n\nIf you're seeing this too, we "
  function peerContentApart(): Record<string, any> {
    const brief = inventedPeerBrief()
    brief.peer_groups[0].label = 'app makers'
    return buildMessagingContent({
      base: {}, brief, result: { opener_frames: INVENTED_PEER_FRAMES, variants: inventedVariants() },
      signoff: INVENTED_SIGNOFF, firmFactTierEnabled: true,
    }) as Record<string, any>
  }

  it.each<[string, Record<string, unknown>, () => Record<string, any>, string]>([
    ['research', { personalisation_trigger: 'Your team opened a second office in Leeds.' }, content, 'research'],
    ['firm_fact, specific rung', { firm_fact: GOOD_FACT }, content, 'firm_fact'],
    ['firm_fact, peer rung', { company_name: 'Testco Export', company_industry: 'software publishers' }, peerContentApart, 'firm_fact'],
    ['template', {}, content, 'template'],
  ])('PLANTED: %s: the lead-in names the firm, the record says so, and the word count is of the named email', async (_name, row, doc, tier) => {
    const { seq } = await compose(prospect(row), doc())
    expect(seq.opening.tier).toBe(tier)
    const body = email(seq, 1).body
    expect(body).toMatch(/\n\nIf Testco[^,]* is seeing this too, we /)
    expect(body).not.toContain(UNNAMED)
    expect(slotFills(seq)[1]).toEqual({ company: true, for_whom: false })
    expect(email(seq, 1).word_count).toBe(countWords(body.replace('Not for you? Just reply stop.', '').trim()))
  })

  it('PLANTED: with no usable name the slot-free clause ships, and the record says why', async () => {
    for (const row of [{ company_name: null }, { company_name: null, firm_fact: GOOD_FACT }]) {
      const { seq } = await compose(prospect(row))
      expect(email(seq, 1).body).toContain(UNNAMED)
      expect(slotFills(seq)[1]).toEqual({ reason: 'nothing_held' })
    }
  })

  it('PLANTED: a document written before the lead-in existed ships Email 1 as it was, and says so', async () => {
    const variants = inventedVariants()
    delete variants.A.email1.lead_in
    const c = buildMessagingContent({
      base: {}, brief: inventedBrief(), result: { opener_frames: INVENTED_OPENER_FRAMES, variants },
      signoff: INVENTED_SIGNOFF, firmFactTierEnabled: true,
    }) as Record<string, any>
    const { seq } = await compose(prospect({}), c)
    expect(email(seq, 1).body).toContain('\n\nWe translate your pages')
    expect(email(seq, 1).body).not.toContain('If ')
    expect(slotFills(seq)[1]).toEqual({ reason: 'no_lead_in' })
  })

  it('the name in the lead-in is the same reading as the follow-ups\' (control)', async () => {
    const { seq } = await compose(prospect({ company_name: 'The Testco Company, Inc.' }))
    expect(email(seq, 1).body).toContain(NAMED)
    expect(email(seq, 2).body).toContain('Does that match what Testco sees?')
  })
})
