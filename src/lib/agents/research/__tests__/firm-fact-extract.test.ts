// extractFirmFact against a FAKE model client. No network.
//
// The fake implements exactly the two methods the code calls and THROWS on anything else,
// so a new call path cannot pass silently (CLAUDE.md: a fake that does not honour a call
// cannot test it). run() records every call, so tests can prove a gate stopped a payment.

import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { extractFirmFact, judgeFaithfulness, FIRM_FACT_EXTRACTION_PROMPT, FIRM_FACT_JUDGE_PROMPT } from '../firm-fact'
import { CARRIER_VERBS, FIRM_FACT_EXTRACTION_MODEL, FIRM_FACT_JUDGE_MODEL, QUOTE_CHECK_STOP_WORDS } from '../firm-fact-checks'

const PAGE_TEXT =
  'Coldharbour Rooms | Home Services About Contact ' +
  'Cold rooms built to last. ' +
  'We design and fit cold rooms for regional food wholesalers and bakeries across the north. ' +
  'We are a cold room engineering firm. ' +
  'Our engineers handle survey, build and servicing. Get a quote today. '.repeat(3)

const SOURCE = { text: PAGE_TEXT, url: 'coldharbourrooms.co.uk', fetched_at: '2026-09-28T00:00:00Z', research_result_id: 'rr-1' }
const PEERS = [{ id: 'PG1', label: 'engineering firms' }, { id: 'PG2', label: 'software makers' }]

const GOOD_CANDIDATE = {
  does: 'you design and fit cold rooms for food wholesalers',
  for_whom: 'regional food wholesalers',
  quote: 'We design and fit cold rooms for regional food wholesalers and bakeries across the north.',
  section: 'service',
}
// The judge's raw answer: a word-by-word audit of the clause against the quote.
const GOOD_VERDICT = {
  words: ['design', 'fit', 'cold', 'rooms', 'food', 'wholesalers'].map(word => ({ word, stated: true })),
  twists_the_quote: false, added_number: false, added_praise: false, customers_supported: true, peer_group_supported: true,
}

const GOOD_KIND = { kind: 'a cold room engineering firm', verb: 'run', quote: 'We are a cold room engineering firm.' }

interface FakeOptions {
  tokens?: number
  /** The extraction's TOP-LEVEL peer_group, which is where the prompt asks for it. Omitted: PG1. */
  peerGroup?: string | null
  /** clientGenericWords for the run: what names nothing on this client's list. */
  genericWords?: ReadonlySet<string>
  candidates?: unknown[]
  /** The extraction's firm_kind. Omitted: none, so a test is about the specific clause unless it says otherwise. */
  firmKind?: unknown
  /** The judge's answer for ITEM A (the specific clause), in the flat shape of one item. */
  verdict?: unknown
  /** The judge's answer for the broad line. Omitted: every word of it stated. */
  kindVerdict?: Record<string, unknown>
  /** The judge's whole raw answer, when a test needs to plant its shape. */
  rawJudge?: unknown
  /** The extraction's answer as raw text, when a test needs to plant its shape. */
  rawExtraction?: string
  extractionStop?: string
  judgeStop?: string
  judgeTokens?: number
  extractionUsage?: { input_tokens: number; output_tokens: number }
}

/**
 * The judge's answer in the shape the judge is asked for: one entry per ITEM in the
 * request. The fake reads the request, so an item the code did not send gets no answer and
 * an item it did send always does: a test cannot pass because the fake answered a question
 * nobody asked.
 */
function judgeAnswer(user: string, opts: FakeOptions) {
  const { customers_supported, peer_group_supported, ...itemA } = { ...(opts.verdict ?? GOOD_VERDICT) } as Record<string, unknown>
  const lines = user.split('\n')
  const clauseOf = (letter: string) => {
    const at = lines.indexOf(`ITEM ${letter}`)
    return at < 0 ? null : (lines.slice(at).find(l => l.startsWith('CLAUSE: ')) ?? '').slice('CLAUSE: '.length)
  }
  const isKind = (clause: string | null) => !!clause && (clause.startsWith('you run a') || clause.startsWith('you are a'))
  const kindAudit = (clause: string) => ({
    words: clause.split(/\s+/).filter(w => !['you', 'a', 'an'].includes(w)).map(word => ({ word, stated: true })),
    twists_the_quote: false, added_number: false, added_praise: false,
    ...(opts.kindVerdict ?? {}),
  })
  const items = ['A', 'B'].flatMap(letter => {
    const clause = clauseOf(letter)
    if (clause === null) return []
    return [{ item: letter, ...(isKind(clause) ? kindAudit(clause) : itemA) }]
  })
  return { items, customers_supported, peer_group_supported }
}

function fakeClient(opts: FakeOptions = {}) {
  const client = {
    messages: {
      countTokens: async (p: { model: string }) => {
        return { input_tokens: p.model === FIRM_FACT_EXTRACTION_MODEL ? (opts.tokens ?? 2000) : (opts.judgeTokens ?? 300) }
      },
      create: async (p: { model: string; messages?: Array<{ content: string }> }) => {
        if (p.model === FIRM_FACT_EXTRACTION_MODEL) {
          return {
            stop_reason: opts.extractionStop ?? 'end_turn',
            usage: opts.extractionUsage ?? { input_tokens: 2000, output_tokens: 150 },
            // IN THE SHAPE THE PROMPT ASKS FOR: peer_group at the top level. The fake used to
            // put it inside the candidate, an older shape the code still tolerates, so the
            // read of the top-level field could be deleted with every test green while
            // every real prospect, and every broad-only fact, lost its peer label.
            content: [{ type: 'text', text: opts.rawExtraction ?? JSON.stringify({ peer_group: opts.peerGroup === undefined ? 'PG1' : opts.peerGroup, candidates: opts.candidates ?? [GOOD_CANDIDATE], firm_kind: opts.firmKind ?? null }) }],
          }
        }
        if (p.model === FIRM_FACT_JUDGE_MODEL) {
          return {
            stop_reason: opts.judgeStop ?? 'end_turn',
            usage: { input_tokens: 300, output_tokens: 120 },
            content: [{ type: 'text', text: JSON.stringify(opts.rawJudge ?? judgeAnswer(p.messages?.[0]?.content ?? '', opts)) }],
          }
        }
        throw new Error(`fake client: unexpected model ${p.model}`)
      },
    },
  }
  return new Proxy(client, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof typeof target]
      throw new Error(`fake client does not implement ${String(prop)}`)
    },
  }) as unknown as Anthropic
}

function run(opts: FakeOptions = {}, companyName = 'Coldharbour Rooms Ltd') {
  const calls: Array<{ kind: string; model: string; user?: string }> = []
  type Req = { model: string; messages?: Array<{ content: string }> }
  const base = fakeClient(opts) as unknown as { messages: { countTokens: (p: Req) => Promise<unknown>; create: (p: Req) => Promise<unknown> } }
  const client = {
    messages: {
      countTokens: (p: Req) => { calls.push({ kind: 'count', model: p.model }); return base.messages.countTokens(p) },
      create: (p: Req) => { calls.push({ kind: 'create', model: p.model, user: p.messages?.[0]?.content }); return base.messages.create(p) },
    },
  } as unknown as Anthropic
  // No client words unless a test says otherwise: an explicit empty set, because the
  // parameter is required so that a caller which DROPS the brief's words does not compile.
  return extractFirmFact({ client, companyName, source: SOURCE, peerGroups: PEERS, genericWords: opts.genericWords ?? new Set<string>() }).then(outcome => ({ outcome, calls }))
}

describe('extractFirmFact', () => {
  it('passes a faithful fact and keeps for_whom and peer group (control)', async () => {
    const { outcome, calls } = await run()
    expect(outcome.record.passed).toBe(true)
    expect(outcome.record.does).toBe(GOOD_CANDIDATE.does)
    expect(outcome.record.for_whom).toBe('regional food wholesalers')
    expect(outcome.record.peer_group_label).toBe('engineering firms')
    expect(outcome.record.research_result_id).toBe('rr-1')
    expect(outcome.record.cost_usd_full_price).toBeGreaterThan(0)
    expect(calls.filter(c => c.kind === 'create').map(c => c.model)).toEqual([FIRM_FACT_EXTRACTION_MODEL, FIRM_FACT_JUDGE_MODEL])
  })

  it('the fake answers in the shape the prompt asks for (control on the fake)', () => {
    expect(FIRM_FACT_EXTRACTION_PROMPT).toContain('{"peer_group":"<id>" or null,"candidates":[')
    expect(GOOD_CANDIDATE).not.toHaveProperty('peer_group')
  })

  it('PLANTED: a BROAD-ONLY fact keeps its peer label, read from the top of the answer', async () => {
    // No specific clause survives, so there is no candidate to carry a peer group: the
    // top-level field is the only place the label can come from.
    const { outcome } = await run({ candidates: [], firmKind: GOOD_KIND, peerGroup: 'PG1' })
    expect(outcome.record.passed).toBe(true)
    expect(outcome.record.does).toBeNull()
    expect(outcome.record.kind).toBe('a cold room engineering firm')
    expect(outcome.record.peer_group_label).toBe('engineering firms')
  })

  it('a peer group the model did not name, or one not in the brief, is no label', async () => {
    expect((await run({ peerGroup: null })).outcome.record.peer_group_label).toBeNull()
    expect((await run({ peerGroup: 'PG9' })).outcome.record.peer_group_label).toBeNull()
  })

  it('PLANTED: the client\'s generic words reach both rungs at extraction', async () => {
    // A client whose whole list is cold room firms: the kind names nothing for them, and
    // neither does a clause made only of those words.
    const genericWords = new Set(['cold', 'room', 'rooms', 'engineering'])
    const kindOnly = await run({ candidates: [], firmKind: GOOD_KIND, genericWords })
    expect(kindOnly.outcome.record.passed).toBe(false)
    expect(JSON.stringify(kindOnly.outcome.record)).toContain('names nothing specific')
    // Control: the same answer with no client words passes (the test above).
    const clause = { ...GOOD_CANDIDATE, does: 'you provide cold rooms', for_whom: null, quote: 'We design and fit cold rooms for regional food wholesalers and bakeries across the north.' }
    const generic = await run({ candidates: [clause], genericWords })
    expect(generic.outcome.record.passed).toBe(false)
    expect(JSON.stringify(generic.outcome.record)).toContain('names nothing specific')
  })

  it('PLANTED: a Title Case kind is stored in the case of running prose, and passes', async () => {
    // The page says "cold room engineering firm" in lower case, so a Title Case answer is
    // the same kind. Stored capitalised it read as a name and was refused for naming nothing.
    const { outcome } = await run({ candidates: [], firmKind: { kind: 'a Cold Room Engineering firm', verb: 'run', quote: 'We are a cold room engineering firm.' } })
    expect(outcome.record.passed).toBe(true)
    expect(outcome.record.kind).toBe('a cold room engineering firm')
  })

  it('PLANTED: the prompt and the check agree that a kind names the field of work', async () => {
    expect(FIRM_FACT_EXTRACTION_PROMPT).toContain("It names the FIELD OF WORK, never only the company's size, ownership, legal form, age or place")
    // And code holds it when the model does not: the kind is on the page, and names nothing.
    const page = { kind: 'a small business', verb: 'run', quote: 'We are a cold room engineering firm.' }
    const { outcome } = await run({ candidates: [], firmKind: { ...page, quote: 'We are a small business.' } })
    expect(outcome.record.passed).toBe(false)
  })

  it('does not submit when the request is over the token cap, even after a cut (pre-submit gate)', async () => {
    const { outcome, calls } = await run({ tokens: 9000 })
    expect(outcome.record.reason).toBe('firm_fact_cost_ceiling')
    expect(calls.some(c => c.kind === 'create')).toBe(false)
  })

  it('pays nothing for a page that is not the company (identity check)', async () => {
    const { outcome, calls } = await run({}, 'Brightwater Advisory')
    expect(outcome.record.reason).toBe('identity_mismatch')
    expect(calls).toEqual([])
  })

  it('fails a fact the judge finds unfaithful', async () => {
    const { outcome } = await run({ verdict: { ...GOOD_VERDICT, words: [...GOOD_VERDICT.words, { word: 'energy-saving', stated: false }] } })
    expect(outcome.record.passed).toBe(false)
    expect(outcome.record.reason).toBe('judge_not_faithful')
    expect(outcome.record.judge?.added_concepts).toEqual(['energy-saving'])
  })

  it('fails a judge answer with no word audit (silence is not "nothing added")', async () => {
    const { words: _omitted, ...withoutAudit } = GOOD_VERDICT
    const { outcome } = await run({ verdict: withoutAudit })
    expect(outcome.record.reason).toBe('judge_not_faithful')
  })

  it('fails a judge audit that marks nothing either way (stated must be literally true)', async () => {
    const { outcome } = await run({ verdict: { ...GOOD_VERDICT, words: [{ word: 'design', stated: 'yes' }] } })
    expect(outcome.record.reason).toBe('judge_not_faithful')
  })

  it('never reaches the judge when the clause holds a word its own quote does not (rule 10, in code)', async () => {
    const { outcome, calls } = await run({ candidates: [{ ...GOOD_CANDIDATE, does: 'you design and fit energy cold rooms for food wholesalers' }] })
    expect(outcome.record.reason).toBe('failed_deterministic_checks')
    expect(outcome.record.check_reasons.join(' ')).toContain('not in the quote: energy')
    expect(calls.filter(c => c.kind === 'create').map(c => c.model)).toEqual([FIRM_FACT_EXTRACTION_MODEL])
  })

  it('fails a fact with any unsupported claim', async () => {
    const { outcome } = await run({ verdict: { ...GOOD_VERDICT, words: [{ word: 'x', stated: false }] } })
    expect(outcome.record.reason).toBe('judge_not_faithful')
  })

  it('fails a judge answer with no claims at all (nothing judged is not faithful)', async () => {
    const { outcome } = await run({ verdict: { ...GOOD_VERDICT, words: [] } })
    expect(outcome.record.reason).toBe('judge_not_faithful')
  })

  it('keeps the clause but drops an unsupported customer group', async () => {
    const { outcome } = await run({ verdict: { ...GOOD_VERDICT, customers_supported: false, peer_group_supported: false } })
    expect(outcome.record.passed).toBe(true)
    expect(outcome.record.for_whom).toBeNull()
    expect(outcome.record.peer_group_id).toBeNull()
  })

  const PROVIDE = { ...GOOD_CANDIDATE, does: 'you provide cold rooms for food wholesalers' }
  const provideAudit = (provideStated: boolean) => ({ ...GOOD_VERDICT, words: [
    { word: 'provide', stated: provideStated }, { word: 'cold', stated: true }, { word: 'rooms', stated: true },
    { word: 'for', stated: false }, { word: 'food', stated: true }, { word: 'wholesalers', stated: true },
  ] })
  it('ignores a judge audit entry for a small grammar word code itself skips', async () => {
    // The judge is told to skip them and, measured live, audited them anyway ("for" here)
    // and failed clauses on them. Code holds that list.
    const { outcome } = await run({ candidates: [PROVIDE], verdict: provideAudit(true) })
    expect(outcome.record.passed).toBe(true)
    expect(outcome.record.judge?.added_concepts).toEqual([])
  })
  it('lets the JUDGE fail the carrier verb: "you provide" what the firm does not provide', async () => {
    // Code cannot tell: every noun of "you provide cold rooms" is in the quote, and so it
    // would be in "you provide parcels" for a firm that builds software to track them. For
    // one day both gates skipped the verb. The judge is asked about it and code listens.
    const { outcome } = await run({ candidates: [PROVIDE], verdict: provideAudit(false) })
    expect(outcome.record.reason).toBe('judge_not_faithful')
    expect(outcome.record.judge?.added_concepts).toEqual(['provide'])
  })
  it('fails an audit that does not cover every word of the clause', async () => {
    // One word of six audited, and it was "stated": nothing was skimmed, five were skipped.
    const { outcome } = await run({ verdict: { ...GOOD_VERDICT, words: [{ word: 'design', stated: true }] } })
    expect(outcome.record.reason).toBe('judge_not_faithful')
    expect(outcome.record.judge?.added_concepts.join(' ')).toContain('wholesalers (not audited)')
  })
  it('counts a hyphenated audit entry as covering both its words (control)', async () => {
    const words = [{ word: 'design', stated: true }, { word: 'fit', stated: true }, { word: 'cold-rooms', stated: true }, { word: 'food wholesalers', stated: true }]
    const { outcome } = await run({ verdict: { ...GOOD_VERDICT, words } })
    expect(outcome.record.passed).toBe(true)
  })
  it.each([
    ['says the clause does not mean what the quote means', { twists_the_quote: true }],
    ['says a number was added', { added_number: true }],
    ['says praise was added', { added_praise: true }],
    ['leaves twists_the_quote unanswered', { twists_the_quote: undefined }],
    ['answers added_praise with a string', { added_praise: 'false' }],
    ['leaves added_number unanswered', { added_number: undefined }],
  ])('fails a verdict that %s', async (_name, change) => {
    const { outcome } = await run({ verdict: { ...GOOD_VERDICT, ...change } })
    expect(outcome.record.passed).toBe(false)
    expect(outcome.record.reason).toBe('judge_not_faithful')
  })
  it('fails closed on a truncated judge answer, and on a judge request over its token cap', async () => {
    expect((await run({ judgeStop: 'max_tokens' })).outcome.record.reason).toBe('judge_truncated')
    const over = await run({ judgeTokens: 5000 })
    expect(over.outcome.record.reason).toBe('firm_fact_cost_ceiling')
    // Not submitted: the judge model was counted and never called.
    expect(over.calls.filter(c => c.kind === 'create').map(c => c.model)).toEqual([FIRM_FACT_EXTRACTION_MODEL])
  })
  it('does not ignore a word that is not on code\'s skip list (control)', async () => {
    const { outcome } = await run({ verdict: { ...GOOD_VERDICT, words: [...GOOD_VERDICT.words, { word: 'energy-saving', stated: false }] } })
    expect(outcome.record.reason).toBe('judge_not_faithful')
  })

  it('drops a customer group holding a word its quote does not (rule 10 reaches for_whom)', async () => {
    // The page says "regional food wholesalers". "independent" is on no part of it. Until
    // 2026-10-01 one word of the group anywhere on the page was enough.
    const { outcome } = await run({ candidates: [{ ...GOOD_CANDIDATE, for_whom: 'independent food wholesalers' }] })
    expect(outcome.record.passed).toBe(true)          // the clause still ships
    expect(outcome.record.for_whom).toBeNull()        // the invented group does not
    expect(outcome.record.check_reasons.join(' ')).toContain('not in the quote: independent')
  })

  it('never calls the judge when the quote is not on the page', async () => {
    const { outcome, calls } = await run({ candidates: [{ ...GOOD_CANDIDATE, quote: 'We build fridges for supermarkets everywhere.' }] })
    expect(outcome.record.reason).toBe('failed_deterministic_checks')
    expect(calls.filter(c => c.kind === 'create').map(c => c.model)).toEqual([FIRM_FACT_EXTRACTION_MODEL])
  })

  it('prefers a service detail over a tagline, whatever order they come in', async () => {
    // A VALID tagline candidate, so this is a test of ranking and not of one being rejected.
    const tagline = { ...GOOD_CANDIDATE, does: 'you provide cold rooms built to last', for_whom: null, quote: 'Cold rooms built to last.', section: 'tagline' }
    const { outcome } = await run({ candidates: [tagline, GOOD_CANDIDATE] })
    expect(outcome.record.section).toBe('service')
    expect(outcome.record.does).toBe(GOOD_CANDIDATE.does)
  })

  it('fails closed on a truncated extraction: an answer cut off with nothing whole in it', async () => {
    for (const cut of ['{"peer_group":null,"candidates":[{"does":"you des', '```json\n{"peer_group":null,"candidates":[{"does":"you design"}', '']) {
      const { outcome, calls } = await run({ extractionStop: 'max_tokens', rawExtraction: cut })
      expect(outcome.record.reason, JSON.stringify(cut)).toBe('extraction_truncated')
      // The judge is never paid to audit half an answer.
      expect(calls.filter(c => c.kind === 'create').map(c => c.model)).toEqual([FIRM_FACT_EXTRACTION_MODEL])
    }
  })
  it('PLANTED: a cut-off answer with a WHOLE answer in it is read, checked and judged like any other', async () => {
    // Read from real extractions: a complete answer, "Wait, let me fix", and a second
    // answer cut off part way. The whole one was thrown away with the cut one: a paid
    // failure on a prospect that had passed before.
    const whole = JSON.stringify({ peer_group: 'PG1', candidates: [GOOD_CANDIDATE], firm_kind: null })
    const text = '```json\n' + whole + '\n```\n\nWait, let me fix the JSON properly:\n\n```json\n{"peer_group":"PG1","candidates":[{"does":"you des'
    const { outcome, calls } = await run({ extractionStop: 'max_tokens', rawExtraction: text })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'specific', does: GOOD_CANDIDATE.does })
    expect(calls.filter(c => c.kind === 'create').map(c => c.model)).toEqual([FIRM_FACT_EXTRACTION_MODEL, FIRM_FACT_JUDGE_MODEL])
    // Control: the whole answer is still held to every check. One that fails them fails.
    const bad = JSON.stringify({ peer_group: 'PG1', candidates: [{ ...GOOD_CANDIDATE, does: 'you design and fit 40 cold rooms for food wholesalers' }], firm_kind: null })
    const failed = await run({ extractionStop: 'max_tokens', rawExtraction: '```json\n' + bad + '\n```\nWait:\n```json\n{"peer' })
    expect(failed.outcome.record).toMatchObject({ passed: false, reason: 'failed_deterministic_checks' })
  })
  it('tells the model to write its answer once', () => {
    expect(FIRM_FACT_EXTRACTION_PROMPT).toContain('Write it ONCE and stop')
  })

  it('discards a fact whose ACTUAL cost broke the ceiling (post-call reconciliation, planted)', async () => {
    const { outcome } = await run({ extractionUsage: { input_tokens: 9000, output_tokens: 300 } })
    expect(outcome.record.passed).toBe(false)
    expect(outcome.record.reason).toBe('cost_ceiling_exceeded_after_call')
  })

  it('reports no fact when the page has none', async () => {
    const { outcome } = await run({ candidates: [] })
    expect(outcome.record.reason).toBe('no_fact_on_page')
  })
})

describe('the two prompts and the code check agree on what may be skipped', () => {
  // Three texts state one rule: the extraction prompt (what the model may write), the code
  // check (what code ignores) and the judge prompt (what the judge ignores). They disagreed:
  // the judge was told to audit "provide", which the extraction prompt allows and code
  // skips, so a clause code passed was a clause the judge's own instructions failed.
  it('the judge is given exactly the words code skips', () => {
    expect(FIRM_FACT_JUDGE_PROMPT).toContain(`Skip only these: ${QUOTE_CHECK_STOP_WORDS.join(', ')}.`)
    // The carrier verbs are NOT skipped: the judge is asked whether each is fair.
    for (const verb of CARRIER_VERBS) expect(FIRM_FACT_JUDGE_PROMPT).toContain(`"${verb}"`)
    expect(FIRM_FACT_JUDGE_PROMPT).toContain('straight after "you" is a special case')
    expect(QUOTE_CHECK_STOP_WORDS).not.toContain('provide')
  })
  it('the extraction prompt allows the same two openings and no others', () => {
    expect(FIRM_FACT_EXTRACTION_PROMPT).toContain('"you help" and "you provide" are the only two openings')
    for (const verb of CARRIER_VERBS) expect(FIRM_FACT_EXTRACTION_PROMPT).toContain(`"you ${verb}"`)
  })
  it('tells the model it may leave a banned word out, so a page that uses one is not a dead end', () => {
    expect(FIRM_FACT_EXTRACTION_PROMPT).toContain('YOU MAY LEAVE A WORD OUT. YOU MAY NEVER PUT ONE IN.')
  })
})

describe('the fallback ladder (second reading, note 6)', () => {
  const BAD_CLAUSE = { ...GOOD_CANDIDATE, does: 'you design and fit 40 cold rooms for food wholesalers' }

  it('passes at the SPECIFIC rung and keeps the kind of firm as the rung below it', async () => {
    const { outcome, calls } = await run({ firmKind: GOOD_KIND })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'specific', does: GOOD_CANDIDATE.does, kind: GOOD_KIND.kind })
    // ONE judge call audits both rungs: that is what keeps the ladder inside the ceiling.
    expect(calls.filter(c => c.kind === 'create').map(c => c.model)).toEqual([FIRM_FACT_EXTRACTION_MODEL, FIRM_FACT_JUDGE_MODEL])
  })
  it('falls to the BROAD rung when the clause fails its code checks', async () => {
    const { outcome } = await run({ candidates: [BAD_CLAUSE], firmKind: GOOD_KIND })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'broad', does: null, kind: GOOD_KIND.kind, for_whom: null, section: 'kind' })
    expect(outcome.record.quote).toBe(GOOD_KIND.quote)
  })
  it('falls to the BROAD rung when the judge fails the clause, and never offers the clause to composition', async () => {
    const { outcome } = await run({ firmKind: GOOD_KIND, verdict: { ...GOOD_VERDICT, twists_the_quote: true } })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'broad', does: null, kind: GOOD_KIND.kind })
    expect(outcome.record.check_reasons.join(' ')).toContain('judge:')
  })
  it('falls to the BROAD rung when the page has no specific clause at all', async () => {
    const { outcome } = await run({ candidates: [], firmKind: GOOD_KIND })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'broad', kind: GOOD_KIND.kind })
  })
  it('keeps the specific rung when the kind fails, and stores no kind', async () => {
    const { outcome } = await run({ firmKind: GOOD_KIND, kindVerdict: { twists_the_quote: true } })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'specific', kind: null })
  })
  it.each([
    ['a word that is not in its quote', { kind: 'a cold room design firm', verb: 'run', quote: GOOD_KIND.quote }, 'not in the quote: design'],
    ['a quote that is not on the page', { kind: 'a dental practice', verb: 'run', quote: 'We are a dental practice.' }, 'quote is not verbatim'],
    ['a kind that names nothing', { kind: 'a firm', verb: 'run', quote: GOOD_KIND.quote }, 'names nothing specific'],
    ['praise', { kind: 'a leading cold room engineering firm', verb: 'run', quote: GOOD_KIND.quote }, 'praise word'],
    ['no article', { kind: 'cold room engineering firm', verb: 'run', quote: GOOD_KIND.quote }, 'does not start with "a" or "an"'],
    // The form checks (checks version 12). Each kind is otherwise sound and has its verb.
    ['a joining word at its end', { kind: 'a cold room engineering firm and', verb: 'run', quote: GOOD_KIND.quote }, 'joining word'],
    ['no verb', { kind: GOOD_KIND.kind, quote: GOOD_KIND.quote }, 'no verb given for the kind'],
    ['a verb that is neither of the two', { kind: GOOD_KIND.kind, verb: 'own', quote: GOOD_KIND.quote }, 'no verb given for the kind'],
  ])('refuses a kind with %s, and with no clause either the prospect gets the template', async (_name, firmKind, expected) => {
    const { outcome, calls } = await run({ candidates: [BAD_CLAUSE], firmKind })
    expect(outcome.record.passed).toBe(false)
    expect(outcome.record.reason).toBe('failed_deterministic_checks')
    expect(outcome.record.check_reasons.join(' ')).toContain(expected)
    // Neither rung survived its code checks, so the judge was never paid for.
    expect(calls.filter(c => c.kind === 'create').map(c => c.model)).toEqual([FIRM_FACT_EXTRACTION_MODEL])
  })
  it('lets the JUDGE fail the broad line: "you run" a kind of firm the quote only sells to', async () => {
    // Every word of the kind is in the quote, and so it would be in a quote about the
    // firm's customers. Code cannot tell; the judge is asked about "run" and code listens.
    const { outcome } = await run({
      candidates: [BAD_CLAUSE], firmKind: GOOD_KIND,
      kindVerdict: { words: [{ word: 'run', stated: false }, { word: 'cold', stated: true }, { word: 'room', stated: true }, { word: 'engineering', stated: true }, { word: 'firm', stated: true }] },
    })
    expect(outcome.record).toMatchObject({ passed: false, reason: 'judge_not_faithful' })
  })
  it('fails a rung the judge did not answer for: no verdict is not a pass', async () => {
    // Two items sent, one answered.
    const { outcome } = await run({
      firmKind: GOOD_KIND,
      rawJudge: { items: [{ item: 'A', ...GOOD_VERDICT }], customers_supported: true, peer_group_supported: true },
    })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'specific', kind: null })
  })
  it('PLANTED: the verb is the extraction\'s: the judge is shown it, and it is stored with the kind', async () => {
    // Code used to pick the verb from the last word's ending. A kind that names a person
    // with no such ending shipped as "you run ...". The model says which verb; the judge
    // audits the clause that will ship; composition reads the stored verb.
    const asAPerson = await run({ candidates: [], firmKind: { ...GOOD_KIND, verb: 'are' } })
    expect(asAPerson.outcome.record).toMatchObject({ passed: true, rung: 'broad', kind: GOOD_KIND.kind, kind_verb: 'are' })
    const judgeSaw = asAPerson.calls.find(c => c.kind === 'create' && c.model === FIRM_FACT_JUDGE_MODEL)?.user ?? ''
    expect(judgeSaw).toContain(`CLAUSE: you are ${GOOD_KIND.kind}`)
    // Control: "run" is stored and shown the same way.
    const asAFirm = await run({ candidates: [], firmKind: GOOD_KIND })
    expect(asAFirm.outcome.record.kind_verb).toBe('run')
    expect(asAFirm.calls.find(c => c.kind === 'create' && c.model === FIRM_FACT_JUDGE_MODEL)?.user).toContain(`CLAUSE: you run ${GOOD_KIND.kind}`)
  })
  it('PLANTED: "are" after "you" need not be in the judge\'s audit; "run" must be, and an audited "are" can still fail', async () => {
    // The judge leaves "are" out of its audit as a grammar word. Two sound lines of 77 real
    // prospects failed for "are (not audited)" and nothing else.
    const words = (list: string[]) => list.map(word => ({ word, stated: true }))
    const kindWords = ['cold', 'room', 'engineering', 'firm']
    const are = { ...GOOD_KIND, verb: 'are' }
    const omitted = await run({ candidates: [], firmKind: are, kindVerdict: { words: words(kindWords) } })
    expect(omitted.outcome.record).toMatchObject({ passed: true, rung: 'broad', kind_verb: 'are' })
    // An "are" the judge DID audit, and found not stated, still fails the line.
    const refused = await run({ candidates: [], firmKind: are, kindVerdict: { words: [{ word: 'are', stated: false }, ...words(kindWords)] } })
    expect(refused.outcome.record).toMatchObject({ passed: false, reason: 'judge_not_faithful' })
    // "run" is a claim about the firm: left out of the audit, the line fails.
    const run_ = await run({ candidates: [], firmKind: GOOD_KIND, kindVerdict: { words: words(kindWords) } })
    expect(run_.outcome.record).toMatchObject({ passed: false, reason: 'judge_not_faithful' })
    expect(JSON.stringify(run_.outcome.record.judge_broad)).toContain('run (not audited)')
    // And "are" anywhere else in a clause is an ordinary word that must be audited.
    // Through the judge alone, so the code check on the clause is not what answers.
    const later = await judgeFaithfulness(
      fakeClient({ verdict: { ...GOOD_VERDICT, words: words(['design', 'rooms', 'cold']) } }),
      { quote: 'We design rooms that are cold.', does: 'you design rooms that are cold', forWhom: null, peerLabel: null },
    )
    expect(later.verdict?.added_concepts.join(' ')).toContain('are (not audited)')
    // ...including a SECOND "are" in a clause that opens "you are": only the one straight
    // after "you" is the linking verb.
    const second = await judgeFaithfulness(
      fakeClient({ kindVerdict: { words: words(['print', 'shop', 'whose', 'rooms', 'cold']) } }),
      { quote: 'We are a print shop whose rooms are cold.', does: 'you are a print shop whose rooms are cold', forWhom: null, peerLabel: null },
    )
    expect(second.verdict?.added_concepts.join(' ')).toContain('are (not audited)')
  })
  it('PLANTED: a kind with no verb is dropped, the clause still ships, and no verb is stored', async () => {
    const { outcome } = await run({ firmKind: { kind: GOOD_KIND.kind, quote: GOOD_KIND.quote } })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'specific', kind: null, kind_verb: null })
    expect(outcome.record.check_reasons.join(' ')).toContain('no verb given for the kind')
  })
  it('PLANTED: a kind cut short before its noun is dropped in code, before the judge is paid for it', async () => {
    // "a cold room" against a quote that reads "a cold room engineering firm" would be the
    // known limit (an -ing word follows). This quote carries the phrase on with a plain noun.
    const page = PAGE_TEXT + ' We are a cold room firm.'
    const client = fakeClient({ candidates: [], firmKind: { kind: 'a cold', verb: 'run', quote: 'We are a cold room firm.' } })
    const outcome = await extractFirmFact({ client, companyName: 'Coldharbour Rooms Ltd', source: { ...SOURCE, text: page }, peerGroups: PEERS, genericWords: new Set<string>() })
    expect(outcome.record.passed).toBe(false)
    expect(outcome.record.reason).toBe('failed_deterministic_checks')
    expect(outcome.record.check_reasons.join(' ')).toContain('stops before its noun')
  })
  it('PLANTED: a kind its quote does not SAY is dropped in code: a heading, or the firm\'s own name', async () => {
    // The case the judge was asked about under version 12 and could not hold. The page text
    // holds "Cold rooms built to last." as a heading: the words, and no statement.
    const { outcome, calls } = await run({ candidates: [], firmKind: { kind: 'a cold rooms', verb: 'run', quote: 'Cold rooms built to last.' } })
    expect(outcome.record).toMatchObject({ passed: false, reason: 'failed_deterministic_checks' })
    expect(outcome.record.check_reasons.join(' ')).toContain('a heading or a name')
    // The judge was never paid for it.
    expect(calls.filter(c => c.kind === 'create').map(c => c.model)).toEqual([FIRM_FACT_EXTRACTION_MODEL])
  })
  it('PLANTED: when the model answers twice, the LAST answer is the one read', async () => {
    // Read from a real extraction: an answer, "Wait, ... let me fix", and a second answer.
    // The first block was taken and the correction thrown away.
    const first = JSON.stringify({ peer_group: 'PG1', candidates: [], firm_kind: { kind: 'a cold', verb: 'run', quote: GOOD_KIND.quote } })
    const second = JSON.stringify({ peer_group: 'PG1', candidates: [], firm_kind: GOOD_KIND })
    const text = '```json\n' + first + '\n```\n\nWait, that is not a whole phrase. Let me fix:\n\n```json\n' + second + '\n```'
    const { outcome } = await run({ rawExtraction: text })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'broad', kind: GOOD_KIND.kind })
    // Control: a single fenced answer, and a bare one, still parse.
    expect((await run({ rawExtraction: '```json\n' + second + '\n```' })).outcome.record.passed).toBe(true)
    expect((await run({ rawExtraction: second })).outcome.record.passed).toBe(true)
    // And a second block that is cut off falls back to the first whole one.
    const cut = '```json\n' + second + '\n```\nLet me fix:\n```json\n{"peer_group":null,"candid```'
    expect((await run({ rawExtraction: cut })).outcome.record.passed).toBe(true)
    // ...and so does one with its braces and still not JSON: a parse error on the last
    // block is not the end of the answer.
    const broken = '```json\n' + second + '\n```\nLet me fix:\n```json\n{"peer_group":null,"candidates":[{"does":"x"}\n```'
    expect((await run({ rawExtraction: broken })).outcome.record.passed).toBe(true)
  })
  it('reports no fact only when the page gave neither a clause nor a kind', async () => {
    expect((await run({ candidates: [] })).outcome.record.reason).toBe('no_fact_on_page')
  })
})

describe('repair by removal reaches the extraction (checks version 16)', () => {
  const LIST_QUOTE = 'We design and fit cold rooms for regional food wholesalers and bakeries across the north.'
  it('PLANTED: a clause that is a list ships as its first item, and the record says what was done', async () => {
    const listed = { does: 'you design cold rooms, fit cold rooms, and service cold rooms', for_whom: null, quote: LIST_QUOTE, section: 'service' }
    // Not every word is in the quote ("service"), so as written it fails twice over; its
    // first item is in the quote and holds no comma.
    const { outcome, calls } = await run({ candidates: [listed], verdict: { ...GOOD_VERDICT, words: ['design', 'cold', 'rooms'].map(word => ({ word, stated: true })) } })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'specific', does: 'you design cold rooms' })
    expect(outcome.record.check_reasons.join(' | ')).toContain('repaired by removal (first_item) to [you design cold rooms]')
    // The JUDGE was shown the repaired clause, not the one the model wrote.
    const judgeSaw = calls.find(c => c.kind === 'create' && c.model === FIRM_FACT_JUDGE_MODEL)?.user ?? ''
    expect(judgeSaw).toContain('CLAUSE: you design cold rooms\n')
    expect(judgeSaw).not.toContain('service cold rooms')
  })
  it('PLANTED: a repaired clause is held to every check: one that still fails is still refused', async () => {
    const listed = { does: 'you design 40 cold rooms, fit cold rooms, and service cold rooms', for_whom: null, quote: LIST_QUOTE, section: 'service' }
    const { outcome } = await run({ candidates: [listed] })
    expect(outcome.record).toMatchObject({ passed: false, reason: 'failed_deterministic_checks' })
    expect(outcome.record.check_reasons.join(' | ')).toContain('(first_item)')
  })
  it('PLANTED: the judge can still refuse a repaired clause', async () => {
    const listed = { does: 'you design cold rooms, fit cold rooms, and service cold rooms', for_whom: null, quote: LIST_QUOTE, section: 'service' }
    const { outcome } = await run({ candidates: [listed], verdict: { ...GOOD_VERDICT, words: ['design', 'cold', 'rooms'].map(word => ({ word, stated: true })), twists_the_quote: true } })
    expect(outcome.record).toMatchObject({ passed: false, reason: 'judge_not_faithful' })
  })
  it('a clause that passes as written is not touched (control)', async () => {
    const { outcome } = await run()
    expect(outcome.record.does).toBe(GOOD_CANDIDATE.does)
    expect(outcome.record.check_reasons.join(' | ')).not.toContain('repaired')
  })
  it('PLANTED: a kind written with "&" is stored with "and" and passes against the quote that wrote "&"', async () => {
    const page = PAGE_TEXT + ' We are a cold room & freezer firm.'
    const client = fakeClient({ candidates: [], firmKind: { kind: 'a cold room & freezer firm', verb: 'run', quote: 'We are a cold room & freezer firm.' } })
    const outcome = await extractFirmFact({ client, companyName: 'Coldharbour Rooms Ltd', source: { ...SOURCE, text: page }, peerGroups: PEERS, genericWords: new Set<string>() })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'broad', kind: 'a cold room and freezer firm' })
  })
})

describe('a slogan is tried last: after every other candidate AND its repairs', () => {
  // The extraction marks a slogan's section "tagline", and is told it is used only when
  // nothing better is on the page. Until the pre-merge review of 2026-10-02 the order of
  // tries did not hold that: every candidate was tried as written before any was repaired,
  // so a slogan that passed as written beat a service line that needed one cut.
  const QUOTE = 'We design and fit cold rooms for regional food wholesalers and bakeries across the north.'
  const LONG_SERVICE = { does: 'you design and fit cold rooms for regional food wholesalers and bakeries across the north', for_whom: null, quote: QUOTE, section: 'service' }
  const TAGLINE = { does: 'you provide cold rooms built to last', for_whom: null, quote: 'Cold rooms built to last.', section: 'tagline' }
  // The fake judge gives one audit whatever clause it is shown, so it covers both clauses:
  // whichever ships passes, and the test is about WHICH ONE ships.
  const AUDIT = { ...GOOD_VERDICT, words: ['design', 'fit', 'cold', 'rooms', 'regional', 'food', 'wholesalers', 'bakeries', 'provide', 'built', 'last'].map(word => ({ word, stated: true })) }

  it('the slogan passes every check as written, so it is the order that decides (control)', async () => {
    const { outcome } = await run({ candidates: [TAGLINE], verdict: AUDIT })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'specific', does: TAGLINE.does, section: 'tagline' })
  })
  it.each([
    ['the slogan given first', [TAGLINE, LONG_SERVICE]],
    ['the slogan given second', [LONG_SERVICE, TAGLINE]],
  ])('PLANTED: a service line that passes only when cut ships ahead of a slogan that passes as written (%s)', async (_order, candidates) => {
    const { outcome, calls } = await run({ candidates, verdict: AUDIT })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'specific', section: 'service' })
    expect(outcome.record.does).not.toBe(TAGLINE.does)
    expect(outcome.record.does!.startsWith('you design and fit cold rooms')).toBe(true)
    expect(outcome.record.check_reasons.join(' | ')).toContain('repaired by removal (cut_to_cap)')
    // The judge was shown the service line and never the slogan.
    const judgeSaw = calls.find(c => c.kind === 'create' && c.model === FIRM_FACT_JUDGE_MODEL)?.user ?? ''
    expect(judgeSaw).not.toContain(TAGLINE.does)
  })
  it('PLANTED: the slogan is still used when no other candidate passes in any form', async () => {
    // A service line with a number in it has no repair: nothing better is on the page.
    const bad = { ...GOOD_CANDIDATE, does: 'you design and fit 40 cold rooms for food wholesalers' }
    const { outcome } = await run({ candidates: [bad, TAGLINE], verdict: AUDIT })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'specific', does: TAGLINE.does, section: 'tagline' })
  })
  it('a page title is not a slogan: it keeps its place among the other candidates (control)', async () => {
    // 'title' is as often a plain description of the firm as a slogan, so it is not moved.
    const title = { ...TAGLINE, section: 'title' }
    const { outcome } = await run({ candidates: [LONG_SERVICE, title], verdict: AUDIT })
    expect(outcome.record).toMatchObject({ passed: true, does: TAGLINE.does, section: 'title' })
  })
})

describe('an unexplained acronym at extraction: the clause is refused, never repaired', () => {
  // The repair that left the acronym out was removed on 2026-10-02. What the page says is
  // sound here, and so was what the repair wrote; the point is that code no longer writes
  // a clause the model did not.
  const quote = 'We design HCM and cold room systems for regional food wholesalers.'
  const page = `${PAGE_TEXT} ${quote}`
  const withAcronym = { does: 'you design HCM and cold room systems for food wholesalers', for_whom: null, quote, section: 'service' }
  const audit = { ...GOOD_VERDICT, words: ['design', 'fit', 'cold', 'room', 'rooms', 'systems', 'food', 'wholesalers'].map(word => ({ word, stated: true })) }
  const extract = (opts: FakeOptions) => extractFirmFact({
    client: fakeClient({ verdict: audit, ...opts }), companyName: 'Coldharbour Rooms Ltd',
    source: { ...SOURCE, text: page }, peerGroups: PEERS, genericWords: new Set<string>(),
  })

  it('PLANTED: alone on the page, it fails the code checks and the judge is never paid', async () => {
    const outcome = await extract({ candidates: [withAcronym] })
    expect(outcome.record).toMatchObject({ passed: false, reason: 'failed_deterministic_checks', does: null })
    expect(outcome.record.check_reasons.join(' | ')).toContain('unexplained acronym "HCM"')
    expect(outcome.record.check_reasons.join(' | ')).not.toContain('repaired by removal')
    expect(outcome.usage.judge).toBeNull()
  })
  it('PLANTED: the next candidate is used', async () => {
    const outcome = await extract({ candidates: [withAcronym, GOOD_CANDIDATE] })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'specific', does: GOOD_CANDIDATE.does })
  })
  it('PLANTED: with no other candidate, the next rung is used', async () => {
    const outcome = await extract({ candidates: [withAcronym], firmKind: GOOD_KIND })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'broad', does: null, kind: GOOD_KIND.kind })
  })
  it('the same clause with a known acronym in its place ships as written (control)', async () => {
    const known = { ...withAcronym, does: withAcronym.does.replace('HCM', 'HR'), quote: quote.replace('HCM', 'HR') }
    const outcome = await extractFirmFact({
      client: fakeClient({ verdict: { ...audit, words: [...audit.words, { word: 'HR', stated: true }] }, candidates: [known] }),
      companyName: 'Coldharbour Rooms Ltd', source: { ...SOURCE, text: `${PAGE_TEXT} ${known.quote}` }, peerGroups: PEERS, genericWords: new Set<string>(),
    })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'specific', does: known.does })
  })
})

describe('which candidate ships, and in what case (checks version 17)', () => {
  const QUOTE = 'We design and fit cold rooms for regional food wholesalers and bakeries across the north.'
  it('PLANTED: a second candidate that passes AS WRITTEN ships ahead of a first candidate that passes only when cut', async () => {
    // The first candidate is over the word cap and passes once cut at its trailing phrase.
    // The second says what the firm does, whole. Before version 17 the cut one shipped.
    const long = { does: 'you design and fit cold rooms for regional food wholesalers and bakeries across the north', for_whom: null, quote: QUOTE, section: 'service' }
    const whole = { does: 'you design and fit cold rooms', for_whom: null, quote: QUOTE, section: 'service' }
    const { outcome } = await run({ candidates: [long, whole], verdict: { ...GOOD_VERDICT, words: ['design', 'fit', 'cold', 'rooms'].map(word => ({ word, stated: true })) } })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'specific', does: 'you design and fit cold rooms' })
    expect(outcome.record.check_reasons.join(' | ')).not.toContain('repaired by removal')
  })
  it('a lone candidate that passes only when cut still ships, cut (control)', async () => {
    const long = { does: 'you design and fit cold rooms for regional food wholesalers and bakeries across the north', for_whom: null, quote: QUOTE, section: 'service' }
    const { outcome } = await run({ candidates: [long], verdict: { ...GOOD_VERDICT, words: ['design', 'fit', 'cold', 'rooms', 'regional', 'food', 'wholesalers', 'bakeries'].map(word => ({ word, stated: true })) } })
    expect(outcome.record.passed).toBe(true)
    expect(outcome.record.check_reasons.join(' | ')).toContain('repaired by removal (cut_to_cap)')
    expect(outcome.record.does!.split(/\s+/).length).toBeLessThanOrEqual(12)
  })
  it('PLANTED: a clause lifted from a heading is stored in the case of running prose; a name keeps its capital', async () => {
    // The page writes "cold rooms" in lower case in its prose, and "Coldharbour" only ever with a capital.
    const heading = { does: 'you design Cold Rooms for Coldharbour', for_whom: null, quote: 'Coldharbour Rooms | Home Services About Contact Cold rooms built to last. We design and fit cold rooms', section: 'service' }
    const { outcome } = await run({ candidates: [heading], verdict: { ...GOOD_VERDICT, words: ['design', 'cold', 'rooms', 'Coldharbour'].map(word => ({ word, stated: true })) } })
    expect(outcome.record.does).toBe('you design cold rooms for Coldharbour')
  })
})

describe('checks version 23 at extraction: a short form is judged as its quote writes it', () => {
  // The model may write a short form in lower case ("a pr agency"); code used to see an
  // acronym only in capitals, so the kind passed and composed "you run a pr agency".
  const kindQuote = 'Coldharbour Rooms is a PR agency for food wholesalers.'
  const doesQuote = 'We provide PR for regional food wholesalers.'
  const page = `${PAGE_TEXT} ${kindQuote} ${doesQuote}`
  const extract = (opts: FakeOptions) => extractFirmFact({
    client: fakeClient(opts), companyName: 'Coldharbour Rooms Ltd',
    source: { ...SOURCE, text: page }, peerGroups: PEERS, genericWords: new Set<string>(),
  })

  it('PLANTED: a kind the model lower-cased is dropped for the acronym its quote writes, before the judge is paid for it', async () => {
    const outcome = await extract({ candidates: [], firmKind: { kind: 'a pr agency', verb: 'run', quote: kindQuote } })
    expect(outcome.record).toMatchObject({ passed: false, reason: 'failed_deterministic_checks' })
    expect(outcome.record.kind ?? null).toBeNull()
    expect(outcome.record.check_reasons.join(' | ')).toContain('kind dropped [a pr agency]: unexplained acronym "PR"')
    expect(outcome.usage.judge).toBeNull()
  })
  it('PLANTED: a clause the model lower-cased is refused for that acronym, and the next candidate ships', async () => {
    const lowered = { does: 'you provide pr for food wholesalers', for_whom: null, quote: doesQuote, section: 'service' }
    const outcome = await extract({ candidates: [lowered, GOOD_CANDIDATE] })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'specific', does: GOOD_CANDIDATE.does })
    expect(outcome.record.check_reasons.join(' | ')).toContain('[you provide pr for food wholesalers] does: unexplained acronym "PR"')
  })
  it('a kind that says the field in plain words passes as before (control)', async () => {
    const outcome = await extract({ candidates: [], firmKind: GOOD_KIND })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'broad', kind: GOOD_KIND.kind })
  })
})

describe('a judge that gave no verdict still leaves the kind it was asked about in the record', () => {
  // Composition's peer-rung veto reads every kind a stored fact holds, including any
  // "kind dropped [<kind>]:" line. A judge that returned nothing used to end the run before
  // any such line was written, so the veto could not see the kind (the peer review,
  // 2026-10-02). The format is parsed there: "kind dropped [" must not change.
  it.each([
    ['a truncated judge answer', { judgeStop: 'max_tokens' }, 'judge_truncated'],
    ['a judge request over its token cap', { judgeTokens: 5000 }, 'firm_fact_cost_ceiling'],
  ] as const)('PLANTED: %s records "kind dropped [<kind>]: judge gave no verdict"', async (_what, opts, reason) => {
    const { outcome } = await run({ firmKind: GOOD_KIND, ...opts })
    expect(outcome.record).toMatchObject({ passed: false, reason })
    expect(outcome.record.kind ?? null).toBeNull()
    expect(outcome.record.check_reasons).toContain(`kind dropped [${GOOD_KIND.kind}]: judge gave no verdict`)
  })
  it('with no kind to drop, nothing is written about one (control)', async () => {
    const { outcome } = await run({ judgeStop: 'max_tokens' })
    expect(outcome.record.reason).toBe('judge_truncated')
    expect(outcome.record.check_reasons.join(' | ')).not.toContain('kind dropped')
  })
  it('a judge that answers writes no such line (control)', async () => {
    const { outcome } = await run({ firmKind: GOOD_KIND })
    expect(outcome.record).toMatchObject({ passed: true, kind: GOOD_KIND.kind })
    expect(outcome.record.check_reasons.join(' | ')).not.toContain('judge gave no verdict')
  })
})

// ── Mutation round, 2026-10-02: the candidate loop ────────────────────────────────────────
//
// Each test below holds a rule of the candidate loop that could be removed with every
// other test in this file green. Each has a control beside it.

describe('mutation round: the candidate loop, rules no test held', () => {
  // A second sound clause from the same page, so a test about which candidate ships is
  // about ranking and never about one of them being refused.
  const BUILT = { does: 'you provide cold rooms built to last', for_whom: null, quote: 'Cold rooms built to last.' }
  const BUILT_VERDICT = { ...GOOD_VERDICT, words: ['provide', 'cold', 'rooms', 'built', 'last'].map(word => ({ word, stated: true })) }

  it('the second clause passes on its own, so it is the ranking that keeps it back below (control)', async () => {
    const { outcome } = await run({ candidates: [{ ...BUILT, section: 'title' }], verdict: BUILT_VERDICT })
    expect(outcome.record).toMatchObject({ passed: true, rung: 'specific', does: BUILT.does, section: 'title' })
  })
  it('PLANTED: a line from the body of the page ships ahead of a tagline that came first', async () => {
    const { outcome } = await run({ candidates: [{ ...BUILT, section: 'tagline' }, { ...GOOD_CANDIDATE, section: 'body' }] })
    expect(outcome.record).toMatchObject({ passed: true, does: GOOD_CANDIDATE.does, section: 'body' })
  })
  it('PLANTED: a niche ships ahead of a body line that came first', async () => {
    const { outcome } = await run({ candidates: [{ ...BUILT, section: 'body' }, { ...GOOD_CANDIDATE, section: 'niche' }] })
    expect(outcome.record).toMatchObject({ passed: true, does: GOOD_CANDIDATE.does, section: 'niche' })
  })
  it('two candidates of one rank ship in the order given (control: rank decided the three above, not position)', async () => {
    const { outcome } = await run({ candidates: [{ ...BUILT, section: 'title' }, { ...GOOD_CANDIDATE, section: 'tagline' }], verdict: BUILT_VERDICT })
    expect(outcome.record).toMatchObject({ passed: true, does: BUILT.does, section: 'title' })
  })

  it('PLANTED: a customer group that fails its own checks is dropped, though every word of it is in the quote', async () => {
    // Seven words against a cap of five. The quote holds each of them, so only checkForWhom refuses it.
    const group = 'food wholesalers and bakeries across the north'
    const { outcome } = await run({ candidates: [{ ...GOOD_CANDIDATE, for_whom: group }] })
    expect(outcome.record.passed).toBe(true)
    expect(outcome.record.for_whom).toBeNull()
    expect(outcome.record.check_reasons.join(' | ')).toContain(`for_whom dropped [${group}]: 7 words, over 5`)
  })
  it('PLANTED: "provide" as the second word of a customer group is a word like any other, and must be in the quote', async () => {
    // A clause may open "you provide" with the verb absent from its quote. A customer group
    // has no "you" in front of it and gets no such allowance.
    const { outcome } = await run({ candidates: [{ ...GOOD_CANDIDATE, for_whom: 'bakeries provide wholesalers' }] })
    expect(outcome.record.passed).toBe(true)
    expect(outcome.record.for_whom).toBeNull()
    expect(outcome.record.check_reasons.join(' | ')).toContain('for_whom dropped [bakeries provide wholesalers]: not in the quote: provide')
  })
  it('a customer group that passes both is kept (control)', async () => {
    const { outcome } = await run({ candidates: [{ ...GOOD_CANDIDATE, for_whom: 'food wholesalers and bakeries' }] })
    expect(outcome.record.for_whom).toBe('food wholesalers and bakeries')
    expect(outcome.record.check_reasons.join(' | ')).not.toContain('for_whom dropped')
  })
})
