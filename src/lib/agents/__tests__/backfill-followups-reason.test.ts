// The follow-up backfill argues from the SAME approved reason Email 1 was held to, and does
// not write follow-ups for an Email 1 the upload would hold (ADR-064 and ADR-065, amended
// 2026-10-01 after two reviews).
//
// What was wrong, in order of discovery:
//   1. the backfill handed the follow-up writer the sentence synthesis had stored, a
//      paraphrase the client never approved;
//   2. it wrote follow-ups for openings written before the approved-reason rule, which
//      then satisfied the upload's thread rule and shipped;
//   3. the fix for 2 checked only prospects the backfill did not skip as "already
//      carried", so a pre-rule opening holding a current follow-up still shipped. The rule
//      now lives at the upload (opening-reason.ts), and the backfill reads the same
//      verdict FIRST, before anything is paid for.
//
// THE JOIN IS TESTED, not each half: followupsForStoredEmail1 is driven with the real
// verdict and the real candidatesForThread, and only the paid call and the database reads
// are stubbed. backfillCohort, the run loop, is driven with injected functions.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  writeFollowups: vi.fn(),
  loadStoredFindings: vi.fn(),
  writerInputForStored: vi.fn(),
  loadClientContext: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() } } }))
vi.mock('@/lib/agents/research/write-followups', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/agents/research/write-followups')>()),
  writeFollowups: h.writeFollowups,
}))
vi.mock('@/lib/agents/prospect-research-agent-v2', () => ({
  loadStoredFindings: h.loadStoredFindings,
  stripNulls: (v: unknown) => v,
}))
vi.mock('../../../../scripts/export-writer-run', () => ({
  writerInputForStored: h.writerInputForStored,
  // One cent per call, so a test can see that a paid check was counted.
  usdForUsage: (usage: { calls?: number } | null) => (usage?.calls ?? 0) * 0.01,
}))
vi.mock('@/lib/agents/research/synthesize', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/agents/research/synthesize')>()),
  loadClientContext: h.loadClientContext,
}))
vi.mock('@/lib/composition/compose-sequence', () => ({
  getVariantEmail1Frame: () => ({ p3: 'The offer line.', cta: 'Is that useful?', authoredOpening: 'The approved opening.' }),
  composeEmail1WithOpening: () => ({ body: 'The composed Email 1.', subject_line: 'a subject' }),
  variantOfferAngles: () => ({}),
  fetchApprovedMessagingDoc: vi.fn(),
}))

import {
  backfillCohort, carriesOneFollowup, followupsForStoredEmail1, followupUpdateFor,
  EMAIL1_NARROWED_SINCE, STILL_HELD_REMEDY,
  type FollowupsForStoredEmail1, type StoredEmail1Row,
} from '../../../../scripts/backfill-followups'
import { fingerprintEmail1 } from '@/lib/composition/followup-assignment'
import type { ObservationCandidate } from '@/lib/agents/research/types'

const candidate = (id: string, observation: string): ObservationCandidate => ({
  id, observation, source: 'website', provenance: 'example.com', date: null, is_composite: false,
  scores: { specific: true, verifiable: true, inferential: true, relevant: true, useful: true, non_judgemental: true },
  passes_all: true, score_total: 6, model_readable_claim: true,
  opposite_reading: null, inference_direction: 'compatible_with_both',
  readability: { hard_fail: false, penalty: 0, max_sentence_words: 7, hedges: [], nominalisation_density: 0, nominalisation_over_threshold: false, reasons: [] },
  demoted: false, rejection_reason: null,
} as unknown as ObservationCandidate)

const APPROVED = 'New equipment has to be kept busy, so more work has to be won.'
const TRIGGERS = [
  { trigger: 'Added equipment', reason: APPROVED },
  { trigger: 'Won an award', reason: '' },
]
const PARAPHRASE = 'A sentence synthesis wrote and nobody approved.'
const HELD = { opening_judge: { bridge: 'B.', approved_reason: { state: 'approved', reason: APPROVED } } }

const PRESS = candidate('c-press', 'You added a second press in March.')
const AWARD = candidate('c-award', 'You won the regional safety award in May.')
const DEPOT = candidate('c-depot', 'You opened a second depot in April.')
const ALL = [AWARD, PRESS, DEPOT]

const template = (middle: string) => [
  '{{first_name}},', 'Most operators in this position find the same thing each quarter.', middle,
  'Does that match what you see?', 'Sam\nExample Co',
].join('\n\n')
const CONTENT = {
  variants: {
    A: {
      emails: [
        { sequence_position: 2, body: template('The second email says how the work runs, in two plain sentences. It names no result.') },
        { sequence_position: 3, body: template('The third email looks at the same thing from another side. It stays short.') },
      ],
    },
  },
} as never

// The fingerprint of the Email 1 the mocked composer returns, so a row can be made "current".
const TODAY = fingerprintEmail1('The composed Email 1.')

const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1', organisation_id: 'org1', segment_id: null, variant_id: 'A', first_name: 'Sam',
  company_name: 'Example Co', job_title: 'Owner',
  personalisation_trigger: 'You added a second press in March. That usually means more work to win.',
  personalisation_question: 'Worth a short call?', personalisation_subject: null,
  current_research_result_id: 'r1',
  followup_email2: null, followup_email3: null, followup_email1_fingerprint: null,
  ...HELD,
  ...over,
})

const run = (over: Record<string, unknown> = {}, triggers: typeof TRIGGERS | [] = TRIGGERS) => followupsForStoredEmail1({
  supabase: {} as never, orgId: 'org1', row: row(over) as never, content: CONTENT, clientName: 'Client', apiKey: 'k', triggers,
})

const stored = (createdAt: string) => ({ result_id: 'r1', created_at: createdAt })
const AFTER = '2026-10-01T10:00:00+00:00'
const BEFORE = '2026-09-29T10:00:00+00:00'

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset()
  h.loadStoredFindings.mockResolvedValue(stored(AFTER))
  h.writerInputForStored.mockResolvedValue({
    candidates: ALL, selectedCandidateId: 'c-press', supportingCandidateId: null,
    relevanceReason: 'R', selectionReason: null, prospectReason: PARAPHRASE,
  })
  h.loadClientContext.mockResolvedValue({ buyerTitle: null, triggers: TRIGGERS })
  h.writeFollowups.mockResolvedValue({ email2: { prose: 'Two.', failures: [] }, email3: { prose: 'Three.', failures: [] }, usage: { calls: 2 }, retries_used: 0, attempts: [] })
})

describe('the backfill argues from the reason Email 1 was held to', () => {
  it('positive control: the fixture reaches the follow-up writer at all', async () => {
    const out = await run()
    expect(out.status).toBe('ran')
    expect(h.writeFollowups).toHaveBeenCalledTimes(1)
    expect(out.usd).toBeCloseTo(0.02)
  })

  it('PLANTED: the writer is handed the client\'s approved sentence, never the stored paraphrase', async () => {
    await run()
    const params = h.writeFollowups.mock.calls[0][0] as { prospectReason: string | null }
    expect(params.prospectReason).toBe(APPROVED)
    expect(params.prospectReason).not.toBe(PARAPHRASE)
  })

  it('a client with no approved reasons at all keeps the stored reason, as the research path does', async () => {
    const out = await run({ opening_judge: null }, [])
    expect(out.status).toBe('ran')
    expect((h.writeFollowups.mock.calls[0][0] as { prospectReason: string | null }).prospectReason).toBe(PARAPHRASE)
  })
})

describe('the backfill does not pay to write for an Email 1 the upload would hold', () => {
  const skipped = (why: string) => ({ status: 'skipped', reason: 'opening_without_approved_reason', why, usd: 0, carriesOne: false })

  it('PLANTED: an opening with no record of what it was held to: skipped, no model call, no read', async () => {
    expect(await run({ opening_judge: { bridge: 'Growth like that is exciting.' } })).toEqual(skipped('written_before_the_rule'))
    expect(await run({ opening_judge: null })).toEqual(skipped('written_before_the_rule'))
    expect(h.writeFollowups).not.toHaveBeenCalled()
    expect(h.loadStoredFindings).not.toHaveBeenCalled()
  })

  it('PLANTED: an opening held to a reason the client has since reworded: skipped', async () => {
    expect(await run({ opening_judge: { bridge: 'B.', approved_reason: { state: 'approved', reason: 'The old wording of the reason.' } } }))
      .toEqual(skipped('reason_since_changed'))
    expect(h.writeFollowups).not.toHaveBeenCalled()
  })

  it('PLANTED: decided BEFORE "already carried": a pre-rule opening that already holds current follow-ups is still refused', async () => {
    // This is the prospect that slipped through: both follow-ups stored against today's
    // Email 1, so the backfill skipped it as carried, and the thread rule let it upload.
    const out = await run({ opening_judge: { bridge: 'B.' }, followup_email2: 'Two.', followup_email3: 'Three.', followup_email1_fingerprint: TODAY })
    expect(out).toEqual(skipped('written_before_the_rule'))
    // Control: the same row with the opening held to a current reason is "already carried".
    expect(await run({ followup_email2: 'Two.', followup_email3: 'Three.', followup_email1_fingerprint: TODAY }))
      .toEqual({ status: 'skipped', reason: 'current', usd: 0, carriesOne: true })
  })

  it('PLANTED: when no triggers are handed in they are read, and a failed read stops the run', async () => {
    const failing = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'gateway timeout' } }) }) }) }) }) }
    await expect(followupsForStoredEmail1({
      supabase: failing as never, orgId: 'org1', row: row() as never, content: CONTENT, clientName: 'Client', apiKey: 'k',
    })).rejects.toThrow(/gateway timeout/)
    expect(h.writeFollowups).not.toHaveBeenCalled()
  })

  it('no research inside the window says whether the prospect already carries one follow-up', async () => {
    h.loadStoredFindings.mockResolvedValue(null)
    expect(await run()).toEqual({ status: 'skipped', reason: 'no_stored_findings', usd: 0, carriesOne: false })
    expect(await run({ followup_email3: 'Three.', followup_email1_fingerprint: TODAY }))
      .toEqual({ status: 'skipped', reason: 'no_stored_findings', usd: 0, carriesOne: true })
  })
})

describe('carriesOneFollowup: the upload\'s own rule, read from the row', () => {
  it.each([
    [{ followup_email2: 'Two.', followup_email3: null, followup_email1_fingerprint: 'fp' }, true],
    [{ followup_email2: null, followup_email3: 'Three.', followup_email1_fingerprint: 'fp' }, true],
    [{ followup_email2: null, followup_email3: null, followup_email1_fingerprint: 'fp' }, false],
    [{ followup_email2: '  ', followup_email3: null, followup_email1_fingerprint: 'fp' }, false],
    [{ followup_email2: 'Two.', followup_email3: 'Three.', followup_email1_fingerprint: 'an-older-email-1' }, false],
    [{ followup_email2: 'Two.', followup_email3: 'Three.', followup_email1_fingerprint: null }, false],
  ])('%j -> %s', (r, expected) => {
    expect(carriesOneFollowup(r, 'fp')).toBe(expected)
  })
})

describe('which findings the follow-up writer is shown', () => {
  it('PLANTED: research from the narrowing onward: the chosen finding only', async () => {
    h.loadStoredFindings.mockResolvedValue(stored(AFTER))
    await run()
    const findings = (h.writeFollowups.mock.calls[0][0] as { findings: string }).findings
    expect(findings).toContain(PRESS.observation)
    expect(findings).not.toContain(AWARD.observation)
    expect(findings).not.toContain(DEPOT.observation)
  })

  it('PLANTED: research from before it: every finding, because that Email 1 may sit on another one', async () => {
    h.loadStoredFindings.mockResolvedValue(stored(BEFORE))
    await run()
    const findings = (h.writeFollowups.mock.calls[0][0] as { findings: string }).findings
    for (const c of ALL) expect(findings).toContain(c.observation)
  })

  it('the boundary is after the change reached main, not the day it was written', () => {
    // f8384e2e: authored 2026-09-28, on main from 2026-10-01T00:40Z. A row from the days
    // between was written by code that did not narrow, so it must compare as "before".
    expect('2026-09-28T12:00:00+00:00' >= EMAIL1_NARROWED_SINCE).toBe(false)
    expect('2026-09-30T23:00:00+00:00' >= EMAIL1_NARROWED_SINCE).toBe(false)
    expect('2026-10-01T00:39:00+00:00' >= EMAIL1_NARROWED_SINCE).toBe(false)
    expect('2026-10-01T02:00:00+00:00' >= EMAIL1_NARROWED_SINCE).toBe(true)
  })
})

describe('followupUpdateFor: three columns at most, and never an Email 1 column', () => {
  const none = { followup_email2: null, followup_email3: null, followup_email1_fingerprint: null }
  it('writes what the run produced and the fingerprint it was written against', () => {
    expect(followupUpdateFor(none, { email2: 'Two.', email3: 'Three.' }, 'fp'))
      .toEqual({ update: { followup_email1_fingerprint: 'fp', followup_email2: 'Two.', followup_email3: 'Three.' }, email1Moved: false })
  })
  it('PLANTED: a position that already holds copy against THIS Email 1 is kept when the run could not fill it', () => {
    const { update } = followupUpdateFor({ followup_email2: 'Kept.', followup_email3: null, followup_email1_fingerprint: 'fp' }, { email2: null, email3: 'Three.' }, 'fp')
    expect(update).toEqual({ followup_email1_fingerprint: 'fp', followup_email3: 'Three.' })
    expect('followup_email2' in update).toBe(false)
  })
  it('PLANTED: nothing is preserved once Email 1 has moved: stale copy is never stamped current', () => {
    const { update, email1Moved } = followupUpdateFor({ followup_email2: 'Stale.', followup_email3: 'Stale too.', followup_email1_fingerprint: 'older' }, { email2: null, email3: 'Three.' }, 'fp')
    expect(email1Moved).toBe(true)
    expect(update).toEqual({ followup_email1_fingerprint: 'fp', followup_email2: null, followup_email3: 'Three.' })
  })
  it('PLANTED: names only the three follow-up columns, whatever it is given', () => {
    const { update } = followupUpdateFor({ ...none, personalisation_trigger: 'x' } as never, { email2: 'Two.', email3: null }, 'fp')
    expect(Object.keys(update).sort()).toEqual(['followup_email1_fingerprint', 'followup_email2', 'followup_email3'])
  })
})

describe('backfillCohort: the run loop', () => {
  const ran = (over: Partial<Extract<FollowupsForStoredEmail1, { status: 'ran' }>> = {}): FollowupsForStoredEmail1 => ({
    status: 'ran', fingerprint: 'fp', storedResultId: 'r1', usd: 0.01, carriesOne: false,
    result: { email2: { prose: 'Two.', failures: [] }, email3: { prose: 'Three.', failures: [] }, usage: null, retries_used: 0, attempts: [{ n: 1 }] } as never,
    ...over,
  })
  const skip = (reason: Extract<FollowupsForStoredEmail1, { status: 'skipped' }>['reason'], carriesOne = false, usd = 0): FollowupsForStoredEmail1 =>
    ({ status: 'skipped', reason, usd, carriesOne })
  const rejected = (carriesOne = false) => ran({ carriesOne, result: { email2: { prose: null, failures: ['a gate'] }, email3: { prose: null, failures: ['another gate'] }, usage: null, retries_used: 1, attempts: [] } as never })
  const cohort = (...ids: string[]): StoredEmail1Row[] => ids.map(id => ({ id, followup_email2: null, followup_email3: null, followup_email1_fingerprint: null }))

  function drive(outcomes: Record<string, FollowupsForStoredEmail1>, opts: { limit?: number | null; commit?: boolean; storeError?: string } = {}) {
    const stores: Array<{ id: string; update: Record<string, string | null> }> = []
    const attempts: string[] = []
    const lines: string[] = []
    const asked: string[] = []
    return backfillCohort({
      cohort: cohort(...Object.keys(outcomes)), limit: opts.limit ?? null, commit: opts.commit ?? true,
      forOne: async r => { asked.push(r.id); return outcomes[r.id] },
      recordAttempts: async id => { attempts.push(id); return null },
      store: async (id, update) => { stores.push({ id, update }); return opts.storeError ?? null },
      log: line => lines.push(line),
    }).then(totals => ({ totals, stores, attempts, lines, asked }))
  }

  it('control: writes what ran, counts what was already carried', async () => {
    const { totals, stores, attempts } = await drive({ a: ran(), b: skip('current', true) })
    expect(totals).toMatchObject({ written: 1, current: 1, skipped: 0, ran: 1, notLookedAt: 0, lastId: 'b' })
    expect(stores).toEqual([{ id: 'a', update: { followup_email1_fingerprint: 'fp', followup_email2: 'Two.', followup_email3: 'Three.' } }])
    expect(attempts).toEqual(['r1'])
    expect(totals.stillHeld.size).toBe(0)
  })

  it('PLANTED: --limit counts prospects the writer RAN for, so skips in front do not use it up', async () => {
    const { totals, asked } = await drive({ a: skip('current', true), b: skip('opening_without_approved_reason'), c: ran(), d: ran(), e: ran() }, { limit: 2 })
    expect(asked).toEqual(['a', 'b', 'c', 'd'])
    expect(totals).toMatchObject({ ran: 2, written: 2, notLookedAt: 1, lastId: 'd' })
  })

  it('PLANTED: a paid call that ended in a skip still reaches the total', async () => {
    const { totals } = await drive({ a: skip('no_reference', false, 0.03), b: ran() })
    expect(totals.usd).toBeCloseTo(0.04)
    expect(totals.ran).toBe(1)
  })

  it('PLANTED: a prospect is listed as still held only when the upload would really hold it', async () => {
    const { totals } = await drive({
      a: skip('opening_without_approved_reason'),
      b: skip('no_stored_findings', false),
      c: skip('no_stored_findings', true),     // one position already carries today's Email 1
      d: skip('no_reference', false),
      e: rejected(false),
      f: rejected(true),
      g: skip('template_arm'),
      h: skip('current', true),
    })
    expect(Object.fromEntries(totals.stillHeld)).toEqual({
      opening_without_approved_reason: ['a'],
      no_stored_findings: ['b'],
      no_reference: ['d'],
      both_follow_ups_rejected: ['e'],
    })
  })

  it('PLANTED: an opening with no approved reason is listed even if it carries a follow-up: the upload holds it regardless', async () => {
    const { totals } = await drive({ a: skip('opening_without_approved_reason', true) })
    expect(totals.stillHeld.get('opening_without_approved_reason')).toEqual(['a'])
  })

  it('PLANTED: a dry run writes nothing and records no attempts', async () => {
    const { totals, stores, attempts } = await drive({ a: ran(), b: rejected() }, { commit: false })
    expect(stores).toEqual([])
    expect(attempts).toEqual([])
    expect(totals.written).toBe(1)
  })

  it('PLANTED: attempts are recorded even when both follow-ups were rejected', async () => {
    const { attempts, stores, totals } = await drive({ a: rejected() })
    expect(attempts).toEqual(['r1'])
    expect(stores).toEqual([])
    expect(totals).toMatchObject({ written: 0, skipped: 1, ran: 1 })
  })

  it('a failed write is a skip, not a written prospect', async () => {
    const { totals } = await drive({ a: ran() }, { storeError: 'connection lost' })
    expect(totals).toMatchObject({ written: 0, skipped: 1 })
  })

  it('every reason a prospect can be left held has its own remedy, and only two say to run research again', () => {
    expect(Object.keys(STILL_HELD_REMEDY).sort()).toEqual(['both_follow_ups_rejected', 'no_reference', 'no_stored_findings', 'opening_without_approved_reason'])
    expect(STILL_HELD_REMEDY.opening_without_approved_reason).toContain('Run its research again')
    expect(STILL_HELD_REMEDY.no_stored_findings).toContain('Run its research again')
    expect(STILL_HELD_REMEDY.no_reference).toContain('Fix the messaging document')
    expect(STILL_HELD_REMEDY.both_follow_ups_rejected).toContain('may pass on another run')
    expect(STILL_HELD_REMEDY.both_follow_ups_rejected).not.toContain('research')
  })
})
