// A personalised follow-up is written from THE FINDING EMAIL 1 OPENED ON, and from nothing
// else research found (operator note 4 on the second reading, 2026-10-01).
//
// Three things are held here:
//   1. candidatesForThread returns the chosen finding and its supporting one, only.
//   2. THE JOIN: produceOpening really hands that narrowed list to the follow-up writer.
//      A helper that is correct and never called is the failure this project keeps paying for.
//   3. The follow-up prompt no longer invites a second fact, and no longer tells the writer
//      a rejection costs both emails, which stopped being true when each email began to be
//      accepted on its own.
//
// RULE ZERO. Every fixture is invented and industry-neutral.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { writeAndJudgeOpening } = vi.hoisted(() => ({ writeAndJudgeOpening: vi.fn() }))
const { writeFollowups } = vi.hoisted(() => ({ writeFollowups: vi.fn() }))

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: vi.fn() } } }))

// importOriginal on both, so buildFindingsBlock and the real prompt stay REAL.
vi.mock('../write-opening', async importOriginal => ({
  ...(await importOriginal<typeof import('../write-opening')>()),
  writeAndJudgeOpening,
}))
vi.mock('../write-followups', async importOriginal => ({
  ...(await importOriginal<typeof import('../write-followups')>()),
  writeFollowups,
}))
vi.mock('@/lib/composition/compose-sequence', () => ({
  getVariantEmail1Frame: () => ({ p3: 'The offer line.', cta: 'Is that useful?', authoredOpening: 'The approved opening.' }),
  composeEmail1WithOpening: () => ({ body: 'The composed Email 1.', subject_line: 'a subject' }),
  variantOfferAngles: () => ({}),
}))

import { candidatesForThread, produceOpening } from '../produce-opening'
import { buildFollowupSystemPrompt } from '../write-followups'
import { FatalApiError } from '@/lib/agents/fatal-api-error'
import type { ObservationCandidate, ProspectContext } from '../types'

const candidate = (id: string, observation: string, score: number): ObservationCandidate => ({
  id, observation, source: 'website', provenance: 'example.com', date: null, is_composite: false,
  scores: { specific: true, verifiable: true, inferential: true, relevant: true, useful: true, non_judgemental: true },
  passes_all: true, score_total: score, model_readable_claim: true,
  opposite_reading: null, inference_direction: 'compatible_with_both',
  readability: { hard_fail: false, penalty: 0, max_sentence_words: 7, hedges: [], nominalisation_density: 0, nominalisation_over_threshold: false, reasons: [] },
  demoted: false, rejection_reason: null,
} as unknown as ObservationCandidate)

// The highest-scoring candidate is deliberately NOT the selected one: a narrowing that kept
// "the best" instead of "the chosen" would pass a fixture where they are the same.
const AWARD = candidate('c-award', 'You won the regional safety award in May.', 9)
const PRESS = candidate('c-press', 'You added a second press in March.', 6)
const DEPOT = candidate('c-depot', 'You opened a second depot in April.', 5)
const TALK = candidate('c-talk', 'You spoke at the trade fair in June.', 4)
const ALL = [AWARD, PRESS, DEPOT, TALK]

describe('candidatesForThread', () => {
  it('PLANTED: returns the chosen finding and the supporting one, and no other', () => {
    expect(candidatesForThread(ALL, 'c-press', 'c-depot').map(c => c.id)).toEqual(['c-press', 'c-depot'])
  })

  it('returns the chosen finding alone when nothing supports it', () => {
    expect(candidatesForThread(ALL, 'c-press', null).map(c => c.id)).toEqual(['c-press'])
    expect(candidatesForThread(ALL, 'c-press', 'c-press').map(c => c.id)).toEqual(['c-press'])
    expect(candidatesForThread(ALL, 'c-press', 'not-in-the-list').map(c => c.id)).toEqual(['c-press'])
  })

  it('returns everything when no selection is known, because narrowing to nothing leaves no finding at all', () => {
    expect(candidatesForThread(ALL, null, null)).toBe(ALL)
    expect(candidatesForThread(ALL, undefined, 'c-depot')).toBe(ALL)
    expect(candidatesForThread(ALL, 'not-in-the-list', null)).toBe(ALL)
  })
})

const ctx: ProspectContext = {
  id: 'p1', organisation_id: 'org1', segment_id: null, first_name: 'Sam', last_name: null,
  company_name: 'Example Co', country: null, role: null, job_title: 'Owner', email: null,
  linkedin_url: null, website_url: null, company: null,
}

// Greeting, an opener, a middle, the question, the sign-off. The reference shown to the
// writer is the middle: the opener and the question are stripped, so a template with no
// middle paragraph has no reference and no follow-up call is made at all.
const template = (middle: string) => [
  '{{first_name}},', 'Most operators in this position find the same thing each quarter.', middle,
  'Does that match what you see?', 'Sam\nExample Co',
].join('\n\n')
const MESSAGING = {
  variants: {
    A: {
      emails: [
        { sequence_position: 2, body: template('The second email says how the work runs, in two plain sentences. It names no result.') },
        { sequence_position: 3, body: template('The third email looks at the same thing from another side. It stays short.') },
      ],
    },
  },
} as never

const EMPTY = { prose: null, failures: [] }

beforeEach(() => {
  writeAndJudgeOpening.mockReset()
  writeFollowups.mockReset()
  writeAndJudgeOpening.mockResolvedValue({
    opening: 'You added a second press in March. That usually means more work to win.',
    observation: 'You added a second press in March.', bridge: 'That usually means more work to win.',
    question: 'Worth a short call?', subject: null, written_won: true, retry_used: false, retries_used: 0,
    strong_material: false, judge_reasoning: 'send', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, calls: 0 },
    comparisons: [], gate_failures: [], attempts: [],
  })
  writeFollowups.mockResolvedValue({ email2: EMPTY, email3: EMPTY, usage: null, retries_used: 0, attempts: [] })
})

describe('produceOpening hands the follow-up writer the thread, not the whole research', () => {
  const run = (selected: string | null, supporting: string | null) => produceOpening({
    apiKey: 'k', clientName: 'Client', ctx, candidates: ALL,
    selectedCandidateId: selected, supportingCandidateId: supporting, relevanceReason: 'R',
    prospectReason: 'A second press means more work has to be won.',
    messagingContent: MESSAGING, variantId: 'A', writeFollowupEmails: true,
  })

  it('PLANTED: the findings block carries the chosen finding and its support, and none of the others', async () => {
    await run('c-press', 'c-depot')
    expect(writeFollowups).toHaveBeenCalledTimes(1)
    const params = writeFollowups.mock.calls[0][0] as { findings: string; findingsEvidence: string; supportingEvent: string | null; prospectReason: string | null }
    expect(params.findings).toContain(PRESS.observation)
    expect(params.findings).toContain(DEPOT.observation)
    // The planted facts. Either one in the block is a fact a follow-up could open on.
    expect(params.findings).not.toContain(AWARD.observation)
    expect(params.findings).not.toContain(TALK.observation)
    expect(params.findings).toContain('[SELECTED BY SYNTHESIS]')
    // The reason and the supporting event still travel, as before.
    expect(params.prospectReason).toBe('A second press means more work has to be won.')
    expect(params.supportingEvent).toBe(DEPOT.observation)
  })

  it('the gates still read the WHOLE evidence, so a name Email 1 itself used is not rejected', async () => {
    await run('c-press', null)
    const params = writeFollowups.mock.calls[0][0] as { findings: string; findingsEvidence: string }
    expect(params.findings).not.toContain(AWARD.observation)
    expect(params.findingsEvidence).toContain(AWARD.observation)
    expect(params.findingsEvidence).toContain(PRESS.observation)
  })

  it('with no selection on record the writer is shown everything, as before', async () => {
    await run(null, null)
    const params = writeFollowups.mock.calls[0][0] as { findings: string }
    for (const c of ALL) expect(params.findings).toContain(c.observation)
  })
})

describe('a failed follow-up call costs the follow-ups, never the research', () => {
  const run = () => produceOpening({
    apiKey: 'k', clientName: 'Client', ctx, candidates: ALL,
    selectedCandidateId: 'c-press', supportingCandidateId: null, relevanceReason: 'R',
    prospectReason: 'A second press means more work has to be won.',
    messagingContent: MESSAGING, variantId: 'A', writeFollowupEmails: true,
  })

  it('PLANTED: an ordinary API failure returns the winning Email 1 with no follow-ups', async () => {
    // Before this the throw left produceOpening, and the caller stores the research AFTER
    // it returns: a paid full-price run was discarded with no row left to reuse.
    writeFollowups.mockRejectedValue(new Error('connection reset'))
    const out = await run()
    expect(out.written_won).toBe(true)
    expect(out.opening).toContain('second press')
    expect(out.email2).toMatchObject({ prose: null, body: null, failures: [] })
    expect(out.email3).toMatchObject({ prose: null, body: null, failures: [] })
    // No fingerprint: nothing was written against this Email 1, so the upload holds it.
    expect(out.followup_email1_fingerprint).toBeNull()
  })

  it('PLANTED: a spent balance still stops the run', async () => {
    writeFollowups.mockRejectedValue(new FatalApiError('credit balance too low', new Error('400')))
    await expect(run()).rejects.toBeInstanceOf(FatalApiError)
  })
})

describe('the follow-up prompt and the thread', () => {
  const prompt = buildFollowupSystemPrompt()

  it('PLANTED: no longer invites a second fact', () => {
    expect(prompt).not.toMatch(/second usable fact/i)
    expect(prompt).toContain('Stay on the thing email 1 observed')
    expect(prompt).toContain('neither email may open on it')
  })

  it('still says one finding, and still says email 3 takes a different angle on it', () => {
    expect(prompt).toContain('ONE FINDING, DEVELOPED ACROSS THE THREE')
    expect(prompt).toContain('EMAIL 3 TAKES A DIFFERENT ANGLE ON THE SAME FINDING')
  })

  it('PLANTED: agrees with the code about what a rejection costs', () => {
    // Each email is accepted on its own since 2026-09-25. The prompt said BOTH.
    expect(prompt).not.toMatch(/costs BOTH follow-ups/)
    expect(prompt).toContain('a rejection costs that email')
  })
})
