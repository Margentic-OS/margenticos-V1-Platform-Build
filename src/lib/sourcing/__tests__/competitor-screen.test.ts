// The competitor screen: a prospect that sells what the client sells is not researched.
//
// Operator rule 7 of the second reading, with a planted case per check. Every company,
// category and phrase below is INVENTED, and the invented client sells vehicle repair, so
// nothing here leans on any real client's market (Rule Zero).
//
// WHAT THESE TESTS CANNOT SHOW: whether the model reads a real record correctly. The
// model is a stand-in here. That is measured by a dry run on real prospects
// (scripts/run-competitor-screen.ts), and these tests hold everything around the model:
// who is asked about, what counts as evidence, what is written, and which way each
// failure falls.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COMPETITOR_JUDGE_MAX_TOKENS,
  COMPETITOR_JUDGE_SYSTEM_PROMPT,
  COMPETITOR_SCREEN_VERSION,
  EVIDENCE_MAX_ITEMS,
  EVIDENCE_MAX_WORDS,
  MIN_EVIDENCE_FOR_YES,
  SITE_TEXT_SHOWN_CHARS,
  buildCompetitorJudgeMessage,
  categoriesFingerprint,
  companyRecordFromRow,
  describeCompetitorScreen,
  findPhraseHits,
  readJudgeReply,
  screenCompetitors,
  storedVerdictFor,
  type CompanyRecord,
  type CompetitorJudgeClient,
  type CompetitorScreenRow,
} from '../competitor-screen'
import { COMPETITOR_REMOVAL_REASON, isCompetitorExcluded } from '../competitor-verdict'
import { classifyTier, REMOVAL_REASONS } from '../tier-classification'
import { DISQUALIFIER_LABELS } from '@/lib/operator/prospect-status'
import { readCompetitorCategories, type CompetitorCategory } from '@/lib/outbound-brief/brief'

const ORG = 'org-1'

const REPAIR: CompetitorCategory = {
  id: 'C1',
  statement: 'Workshops whose main business is repairing vehicles for customers.',
  phrases: ['vehicle repair', 'car servicing', 'mot testing'],
  not_this: 'Parts suppliers and driving schools stay in scope even when they list repair among their services.',
  source: 'invented',
}

const content = (categories: unknown) => ({ outbound_brief: { competitor_categories: categories } })

function row(id: string, over: Partial<CompetitorScreenRow> & { tags?: string[] } = {}): CompetitorScreenRow {
  const { tags, ...rest } = over
  return {
    id,
    company_name: `Company ${id}`,
    company_industry: 'retail',
    website_url: null,
    apollo_enrichment_data: { organization: { keywords: tags ?? ['tyres', 'batteries'] } },
    competitor_check: null,
    outbound_upload_status: 'pending',
    tiering_reason: 'tier_1 (score 80)',
    ...rest,
  }
}

interface Written { id: string; update: Record<string, unknown> }

/**
 * A database stand-in that HONOURS the filters the screen applies and THROWS on anything
 * it does not implement, so a query the screen stops making, or starts making, fails a
 * test instead of being swallowed.
 */
function fakeDb(rows: CompetitorScreenRow[], opts: { messaging?: unknown; readError?: string; writeError?: string } = {}) {
  const written: Written[] = []
  let prospectReads = 0
  const client = {
    from(table: string) {
      if (table === 'strategy_documents') {
        const filters: Record<string, unknown> = {}
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (c: string, v: unknown) => { filters[c] = v; return chain },
          order: () => chain,
          limit: () => chain,
          then: (resolve: (v: unknown) => void) => {
            const wanted = filters.organisation_id === ORG && filters.document_type === 'messaging' && filters.status === 'active'
            resolve({ data: wanted && opts.messaging !== undefined ? [{ content: opts.messaging }] : [], error: null })
          },
        }
        return chain
      }
      if (table === 'prospect_research_results') {
        throw new Error('the test supplies its own site text; the default loader must not run')
      }
      if (table !== 'prospects') throw new Error(`fake does not implement table ${table}`)
      const filters: Record<string, unknown> = {}
      let update: Record<string, unknown> | null = null
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (u: Record<string, unknown>) => { update = u; return chain },
        eq: (c: string, v: unknown) => { filters[c] = v; return chain },
        in: (c: string, v: unknown[]) => { filters[`${c}_in`] = v; return chain },
        then: (resolve: (v: unknown) => void) => {
          if (filters.organisation_id !== ORG) { resolve({ data: [], error: null }); return }
          if (update) {
            if (opts.writeError) { resolve({ data: null, error: { message: opts.writeError } }); return }
            written.push({ id: filters.id as string, update })
            resolve({ data: null, error: null })
            return
          }
          prospectReads++
          if (opts.readError) { resolve({ data: null, error: { message: opts.readError } }); return }
          const ids = (filters.id_in as string[] | undefined) ?? []
          resolve({ data: rows.filter(r => ids.includes(r.id)), error: null })
        },
      }
      return chain
    },
  }
  return { client: client as never, written, reads: () => prospectReads }
}

/** A model stand-in: answers from a table keyed by company name, and counts its calls. */
type Answer = string | Error | { text: string; stop_reason: string }
function fakeJudge(answers: Record<string, Answer | Answer[]>) {
  const asked: string[] = []
  const categoriesAsked: string[] = []
  const maxTokens: number[] = []
  const client: CompetitorJudgeClient = {
    messages: {
      async create(body) {
        const message = body.messages[0].content
        const name = /^Name: (.*)$/m.exec(message)?.[1] ?? ''
        asked.push(name)
        categoriesAsked.push(/^CATEGORY: (.*)$/m.exec(message)?.[1] ?? '')
        maxTokens.push(body.max_tokens)
        const entry = answers[name]
        // A list is consumed in order, one reply per call about that company.
        const answer = Array.isArray(entry) ? entry.shift() : entry
        if (answer === undefined) throw new Error(`the fake judge has no answer for ${name}`)
        if (answer instanceof Error) throw answer
        const text = typeof answer === 'string' ? answer : answer.text
        const stop_reason = typeof answer === 'string' ? 'end_turn' : answer.stop_reason
        return { content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 20 }, stop_reason }
      },
    },
  }
  return { client, asked, categoriesAsked, maxTokens }
}

/** No homepage could be read. */
const noSite = async () => null
/** A homepage was read, and says nothing about the category. Most tests are not about the homepage. */
const aSite = async () => ({ text: 'Welcome. We have served local customers since the works opened. Call for opening hours.', origin: 'fetched' as const })
const reply = (in_category: string, evidence: string[], main = 'vehicle repair') =>
  JSON.stringify({ main_business: main, in_category, evidence })

// ─── Step 1: phrases ─────────────────────────────────────────────────────────

describe('the phrase step', () => {
  const record = (tags: string[], name = 'Northfield Motors'): CompanyRecord =>
    ({ name, industry: 'retail', other_industries: [], tags })

  it('finds a phrase as whole words, folding case and hyphens', () => {
    expect(findPhraseHits(record(['Vehicle-Repair services']), [REPAIR]).map(h => h.phrase)).toEqual(['vehicle repair'])
  })

  it('PLANTED: a phrase inside a longer word is not a hit', () => {
    // "mot testing" must not be found in "remote testing".
    expect(findPhraseHits(record(['remote testing', 'vehicle repairs manual']), [REPAIR])).toEqual([])
  })

  it('finds a phrase in the company name and in the industry labels', () => {
    expect(findPhraseHits(record(['tyres'], 'Northfield Car Servicing Ltd'), [REPAIR]).map(h => h.found_in))
      .toEqual(['Northfield Car Servicing Ltd'])
    expect(findPhraseHits({ name: 'N', industry: 'vehicle repair', other_industries: [], tags: [] }, [REPAIR])).toHaveLength(1)
  })

  it('PLANTED: reads EVERY tag, including one far past the first twenty-five', () => {
    // The research judge is shown the first 25 tags. A phrase at position 60 would be
    // invisible through that reader, and this company would never be asked about.
    const tags = Array.from({ length: 59 }, (_, i) => `tag ${i}`).concat('mot testing')
    const built = companyRecordFromRow(row('p1', { tags }))
    expect(built?.tags).toHaveLength(60)
    expect(findPhraseHits(built!, [REPAIR]).map(h => h.phrase)).toEqual(['mot testing'])
  })

  it('a row with nothing on file is unscreenable, which is not the same as clear', () => {
    expect(companyRecordFromRow({ id: 'p1', company_name: null, company_industry: null, apollo_enrichment_data: null })).toBeNull()
  })
})

// ─── The narrow reader ───────────────────────────────────────────────────────

describe('reading the categories from the messaging document', () => {
  it('PLANTED: a copy fault elsewhere in the brief does not switch the screen off', () => {
    // readBrief would return no brief at all for this document: it has no pain angles, no
    // outcomes, nothing but the list. The screen reads the list by itself.
    const read = readCompetitorCategories(content([REPAIR]))
    expect(read.categories).toHaveLength(1)
    expect(read.problems).toEqual([])
  })

  it('drops an unusable category, names it, and keeps the others', () => {
    const read = readCompetitorCategories(content([REPAIR, { id: 'C2', statement: 'No phrases', phrases: [], source: 'x' }]))
    expect(read.categories.map(c => c.id)).toEqual(['C1'])
    expect(read.problems.join(' ')).toMatch(/C2: phrases must be a non-empty list/)
  })

  it('no list at all is "nothing to screen for", not a fault', () => {
    expect(readCompetitorCategories({ outbound_brief: {} })).toEqual({ categories: [], present: false, problems: [] })
    expect(readCompetitorCategories(null)).toEqual({ categories: [], present: false, problems: [] })
  })
})

// ─── Step 2: the model's reply, checked by code ──────────────────────────────

describe('reading the model reply', () => {
  const record: CompanyRecord = {
    name: 'Northfield Motors', industry: 'retail', other_industries: ['automotive'],
    tags: ['vehicle repair', 'mot testing', 'tyres', 'batteries'],
  }
  const site = 'Northfield Motors. We repair and service cars and vans for drivers across the county, six days a week.'
  const read = (raw: string, siteText: string | null = null, r: CompanyRecord = record) => readJudgeReply(raw, r, REPAIR, siteText)

  it('a yes stands on two different pieces code found, each naming the category\'s work', () => {
    const r = read(reply('yes', ['vehicle repair', 'mot testing']))
    expect(r).toMatchObject({ in_category: 'yes', downgraded: false })
    expect(r?.evidence).toEqual(['vehicle repair', 'mot testing'])
    expect(MIN_EVIDENCE_FOR_YES).toBe(2)
  })

  it('PLANTED: a yes resting on one piece is recorded as unclear, not as a yes', () => {
    expect(read(reply('yes', ['vehicle repair']))).toMatchObject({ in_category: 'unclear', downgraded: true })
  })

  it('PLANTED: the same tag cited twice, in two spellings, is one piece', () => {
    expect(read(reply('yes', ['vehicle repair', 'Vehicle Repair']))).toMatchObject({ in_category: 'unclear', downgraded: true })
    // The fold is the one the match uses, hyphen included. The first version deduped on
    // lower case only, so this pair counted as two.
    expect(read(reply('yes', ['vehicle repair', 'Vehicle-Repair']))).toMatchObject({ in_category: 'unclear', downgraded: true })
  })

  it('PLANTED: a tag that is in the record but is about something else does not count', () => {
    // "batteries" is a real tag. It says nothing about repair. The first version counted
    // any tag in the record, so the one phrase tag plus any other tag made a yes.
    const r = read(reply('yes', ['vehicle repair', 'batteries']))
    expect(r).toMatchObject({ in_category: 'unclear', downgraded: true })
    expect(r?.evidence).toEqual(['vehicle repair'])
  })

  it('PLANTED: the company name counts only when it names the category\'s work', () => {
    expect(read(reply('yes', ['vehicle repair', 'Northfield Motors']))).toMatchObject({ in_category: 'unclear', downgraded: true })
    const named: CompanyRecord = { ...record, name: 'Northfield Vehicle Repair', tags: ['mot testing', 'tyres'] }
    expect(read(reply('yes', ['Northfield Vehicle Repair', 'mot testing']), null, named)).toMatchObject({ in_category: 'yes', downgraded: false })
  })

  it('PLANTED: evidence that is not in the record does not count', () => {
    const r = read(reply('yes', ['vehicle repair', 'full workshop services']))
    expect(r).toMatchObject({ in_category: 'unclear', downgraded: true })
    expect(r?.evidence).toEqual(['vehicle repair'])
  })

  it('a run of words from the homepage is evidence', () => {
    expect(read(reply('yes', ['vehicle repair', 'We repair and service cars and vans']), site)).toMatchObject({ in_category: 'yes', downgraded: false })
    // Two runs from the homepage and no tag at all is also a yes.
    expect(read(reply('yes', ['We repair and service cars and vans', 'six days a week']), site)).toMatchObject({ in_category: 'yes' })
  })

  it('PLANTED: one or two words from the homepage are not evidence', () => {
    expect(read(reply('yes', ['vehicle repair', 'service cars']), site)).toMatchObject({ in_category: 'unclear', downgraded: true })
  })

  it('PLANTED: homepage text the model was never shown cannot be cited', () => {
    const long = 'x '.repeat(SITE_TEXT_SHOWN_CHARS) + 'we repair every make of vehicle'
    expect(read(reply('yes', ['vehicle repair', 'we repair every make of vehicle']), long)).toMatchObject({ in_category: 'unclear', downgraded: true })
  })

  it('no and unclear need no evidence', () => {
    expect(read(reply('no', []))).toMatchObject({ in_category: 'no', downgraded: false })
    expect(read(reply('unclear', []))).toMatchObject({ in_category: 'unclear', downgraded: false })
  })

  it('PLANTED: a reply that is not a verdict is null, never a pass', () => {
    expect(read('I think this company repairs vehicles.')).toBeNull()
    expect(read('{"in_category": "probably"}')).toBeNull()
    expect(read('{"in_category": ')).toBeNull()
  })

  it('shows the model the category, its neighbours, every tag and the homepage, and not the phrases that matched', () => {
    const message = buildCompetitorJudgeMessage(record, REPAIR, site)
    expect(message).toContain(REPAIR.statement)
    expect(message).toContain(REPAIR.not_this!)
    expect(message).toContain('Tags (4): vehicle repair, mot testing, tyres, batteries')
    expect(message).toContain(site)
    expect(message).not.toMatch(/matched|phrase/i)
    expect(buildCompetitorJudgeMessage(record, REPAIR, null)).toContain('(could not be read)')
  })

  it('the prompt asks for what the code counts, and caps the evidence so a yes fits the reply', () => {
    // Prompt and validator agree: a tag is evidence only when it names the category\'s work.
    expect(COMPETITOR_JUDGE_SYSTEM_PROMPT).toContain("THAT NAMES THE CATEGORY'S WORK")
    expect(COMPETITOR_JUDGE_SYSTEM_PROMPT).toContain('A tag about something else is not evidence')
    expect(COMPETITOR_JUDGE_SYSTEM_PROMPT).toContain(`Give at most ${EVIDENCE_MAX_ITEMS} items, each at most ${EVIDENCE_MAX_WORDS} words.`)
  })

  it('Rule Zero: the judge prompt names no market', () => {
    const lower = COMPETITOR_JUDGE_SYSTEM_PROMPT.toLowerCase()
    const MARKET_WORDS = ['lead', 'outbound', 'appointment', 'agency', 'consult', 'marketing', 'margentic', 'founder', 'email']
    expect(MARKET_WORDS.filter(w => lower.includes(w))).toEqual([])
  })
})

// ─── The screen ──────────────────────────────────────────────────────────────

describe('screenCompetitors', () => {
  const workshop = row('p-workshop', { company_name: 'Northfield Motors', tags: ['vehicle repair', 'mot testing', 'tyres'] })
  const supplier = row('p-supplier', { company_name: 'Hartwell Parts', tags: ['car parts', 'vehicle repair', 'batteries', 'delivery'] })
  const unrelated = row('p-unrelated', { company_name: 'Lakeside Bakery', tags: ['bread', 'cakes'] })
  const YES = reply('yes', ['vehicle repair', 'mot testing'])

  const screen = (db: ReturnType<typeof fakeDb>, ids: string[], judge: ReturnType<typeof fakeJudge>, extra: Record<string, unknown> = {}) =>
    screenCompetitors({
      supabase: db.client, organisationId: ORG, prospectIds: ids, messagingContent: content([REPAIR]),
      persist: true, client: judge.client, loadSiteText: aSite, ...extra,
    })

  // ── The three states of the list ──

  it('PLANTED: a client with no competitor list is not screened: no prospect read, no model asked', async () => {
    const db = fakeDb([workshop], { messaging: { outbound_brief: {} } })
    const judge = fakeJudge({})
    const result = await screenCompetitors({ supabase: db.client, organisationId: ORG, prospectIds: ['p-workshop'], persist: true, client: judge.client, loadSiteText: aSite })
    expect(result).toMatchObject({ ok: true, screened: false, cleared: ['p-workshop'], excluded: [], held: [] })
    expect(db.reads()).toBe(0)
    expect(judge.asked).toEqual([])
  })

  it('PLANTED: a list with nothing usable in it REFUSES the run; it is not read as "no list"', async () => {
    // Somebody wrote a list. Passing the run would research every company it was written
    // to stop, with a warning in a log nobody reads.
    const db = fakeDb([workshop])
    const result = await screen(db, ['p-workshop'], fakeJudge({}), { messagingContent: content([{ id: 'C1', statement: 'Workshops.', phrases: ['mo'], source: 'x' }]) })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toMatch(/The competitor list in the outbound brief cannot be used.*C1: every phrase must be at least 3 characters/)
    expect(db.reads()).toBe(0)
  })

  it('one unusable category among several is skipped, and the operator is told in the sentence', async () => {
    const db = fakeDb([unrelated])
    const result = await screen(db, ['p-unrelated'], fakeJudge({}), { messagingContent: content([REPAIR, { id: 'C2', statement: 'No phrases', phrases: [], source: 'x' }]) })
    if (!result.ok) throw new Error(result.error)
    expect(result.problems.join(' ')).toMatch(/C2: phrases must be a non-empty list/)
    expect(describeCompetitorScreen(result)).toMatch(/part of the competitor list could not be used and was skipped \(C2: phrases must be a non-empty list\)/)
  })

  it('reads the list from the ACTIVE messaging document when the caller holds none', async () => {
    const db = fakeDb([unrelated], { messaging: content([REPAIR]) })
    const result = await screenCompetitors({ supabase: db.client, organisationId: ORG, prospectIds: ['p-unrelated'], persist: true, client: fakeJudge({}).client, loadSiteText: aSite })
    expect(result).toMatchObject({ ok: true, screened: true, cleared: ['p-unrelated'] })
  })

  // ── Who is asked, and what each answer does ──

  it('PLANTED: a company with no phrase costs no model call and is never written to', async () => {
    const db = fakeDb([unrelated])
    const judge = fakeJudge({})
    const result = await screen(db, ['p-unrelated'], judge)
    expect(result).toMatchObject({ ok: true, cleared: ['p-unrelated'], judge_calls: 0 })
    expect(judge.asked).toEqual([])
    expect(db.written).toEqual([])
  })

  it('PLANTED: a competitor is excluded, loses its tier, and the verdict says what it rested on', async () => {
    const db = fakeDb([workshop, unrelated])
    const judge = fakeJudge({ 'Northfield Motors': YES })
    const result = await screen(db, ['p-workshop', 'p-unrelated'], judge)
    expect(result).toMatchObject({ ok: true, excluded: ['p-workshop'], cleared: ['p-unrelated'], held: [], judge_calls: 1 })
    expect(db.written).toHaveLength(1)
    const { id, update } = db.written[0]
    expect(id).toBe('p-workshop')
    expect(update).toMatchObject({ sourced_tier: null, fit_score: null, tiering_reason: COMPETITOR_REMOVAL_REASON })
    expect(update.competitor_check).toMatchObject({
      version: COMPETITOR_SCREEN_VERSION, outcome: 'excluded', in_category: 'yes', category_id: 'C1', categories_asked: ['C1'],
      phrase_hits: ['vehicle repair', 'mot testing'], evidence: ['vehicle repair', 'mot testing'], site_text: 'fetched',
    })
    expect(isCompetitorExcluded(update.competitor_check)).toBe(true)
  })

  it('PLANTED: the neighbour the brief keeps in scope is judged, cleared, and keeps its tier', async () => {
    // A parts supplier that lists repair once among other things. The phrase gets it asked
    // about; the answer keeps it. Excluding on the phrase alone would have removed a buyer.
    const db = fakeDb([supplier])
    const judge = fakeJudge({ 'Hartwell Parts': reply('no', [], 'car parts') })
    const result = await screen(db, ['p-supplier'], judge)
    expect(result).toMatchObject({ ok: true, cleared: ['p-supplier'], excluded: [] })
    expect(db.written).toHaveLength(1)
    expect(Object.keys(db.written[0].update)).toEqual(['competitor_check'])
    expect(db.written[0].update.competitor_check).toMatchObject({ outcome: 'clear', in_category: 'no' })
  })

  it('PLANTED: unclear stays in scope', async () => {
    const db = fakeDb([supplier])
    const result = await screen(db, ['p-supplier'], fakeJudge({ 'Hartwell Parts': reply('unclear', []) }))
    expect(result).toMatchObject({ ok: true, cleared: ['p-supplier'], excluded: [], held: [] })
    expect(db.written[0].update.competitor_check).toMatchObject({ outcome: 'clear', in_category: 'unclear' })
  })

  it('PLANTED: a yes that rests on the one phrase tag and an unrelated tag is unclear, and the company stays in scope', async () => {
    const db = fakeDb([supplier])
    const result = await screen(db, ['p-supplier'], fakeJudge({ 'Hartwell Parts': reply('yes', ['vehicle repair', 'batteries']) }))
    expect(result).toMatchObject({ ok: true, cleared: ['p-supplier'], excluded: [] })
    expect(db.written[0].update.competitor_check).toMatchObject({ outcome: 'clear', in_category: 'unclear', downgraded: true })
  })

  it('the homepage the model was shown can carry the yes', async () => {
    const db = fakeDb([supplier])
    const judge = fakeJudge({ 'Hartwell Parts': reply('yes', ['vehicle repair', 'we repair and service cars and vans']) })
    const result = await screen(db, ['p-supplier'], judge, {
      loadSiteText: async () => ({ text: 'Hartwell. We repair and service cars and vans every day.', origin: 'stored' as const }),
    })
    expect(result).toMatchObject({ ok: true, excluded: ['p-supplier'] })
    expect(db.written[0].update.competitor_check).toMatchObject({ outcome: 'excluded', site_text: 'stored' })
  })

  // ── No usable answer holds ──

  it('PLANTED: a model call that fails HOLDS the prospect: not researched, nothing written', async () => {
    const db = fakeDb([workshop])
    const result = await screen(db, ['p-workshop'], fakeJudge({ 'Northfield Motors': new Error('overloaded') }))
    expect(result).toMatchObject({ ok: true, held: ['p-workshop'], cleared: [], excluded: [] })
    expect(db.written).toEqual([])
    if (!result.ok) throw new Error('expected a result')
    expect(result.details[0]).toMatchObject({ outcome: 'held', held_reason: 'no_verdict' })
  })

  it('PLANTED: a reply that does not parse holds the prospect too', async () => {
    const db = fakeDb([workshop])
    const result = await screen(db, ['p-workshop'], fakeJudge({ 'Northfield Motors': 'It looks like a workshop to me.' }))
    expect(result).toMatchObject({ ok: true, held: ['p-workshop'], cleared: [] })
  })

  it('PLANTED: a reply cut off at the token limit is asked again once, with room, and both calls are counted', async () => {
    const db = fakeDb([workshop])
    const judge = fakeJudge({ 'Northfield Motors': [{ text: '{"in_category": "yes", "evidence": ["vehicle rep', stop_reason: 'max_tokens' }, YES] })
    const result = await screen(db, ['p-workshop'], judge)
    expect(result).toMatchObject({ ok: true, excluded: ['p-workshop'], held: [] })
    expect(judge.maxTokens).toEqual([COMPETITOR_JUDGE_MAX_TOKENS, COMPETITOR_JUDGE_MAX_TOKENS * 2])
    if (!result.ok) throw new Error('expected a result')
    expect(result.usage).toEqual({ input_tokens: 200, output_tokens: 40 })
  })

  it('PLANTED: cut off twice is a hold, and the cut-off text is never read as a verdict', async () => {
    const db = fakeDb([workshop])
    const cut = { text: reply('no', []), stop_reason: 'max_tokens' }
    const result = await screen(db, ['p-workshop'], fakeJudge({ 'Northfield Motors': [cut, { ...cut }] }))
    expect(result).toMatchObject({ ok: true, held: ['p-workshop'], cleared: [] })
    expect(db.written).toEqual([])
  })

  it('PLANTED: with no way to ask, a company carrying a phrase is held, not passed', async () => {
    const db = fakeDb([workshop, unrelated])
    const saved = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const result = await screenCompetitors({ supabase: db.client, organisationId: ORG, prospectIds: ['p-workshop', 'p-unrelated'], messagingContent: content([REPAIR]), persist: true, apiKey: null, loadSiteText: aSite })
      expect(result).toMatchObject({ ok: true, held: ['p-workshop'], cleared: ['p-unrelated'], judge_calls: 0 })
      if (!result.ok) throw new Error('expected a result')
      expect(result.details.find(d => d.prospect_id === 'p-workshop')).toMatchObject({ held_reason: 'no_api_key' })
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
    }
  })

  it('PLANTED: past the call budget the rest are held, and said to be', async () => {
    const second = row('p-second', { company_name: 'Second Garage', tags: ['car servicing'] })
    const db = fakeDb([workshop, second])
    const result = await screen(db, ['p-workshop', 'p-second'], fakeJudge({ 'Northfield Motors': reply('no', []) }), { maxJudgeCalls: 1 })
    expect(result).toMatchObject({ ok: true, cleared: ['p-workshop'], held: ['p-second'], judge_calls: 1 })
    if (!result.ok) throw new Error('expected a result')
    expect(result.details.find(d => d.prospect_id === 'p-second')).toMatchObject({ held_reason: 'call_budget' })
  })

  // ── The homepage gets one retry ──

  it('PLANTED: a "no" given without the homepage is HELD the first time, and a marker is left on the row', async () => {
    // Judged on the provider\'s record alone the screen excluded nobody, so a record-only
    // "no" stored as clear would clear a competitor for good because a fetch failed once.
    const db = fakeDb([supplier])
    const result = await screen(db, ['p-supplier'], fakeJudge({ 'Hartwell Parts': reply('no', []) }), { loadSiteText: noSite })
    expect(result).toMatchObject({ ok: true, held: ['p-supplier'], cleared: [] })
    if (!result.ok) throw new Error('expected a result')
    expect(result.details[0]).toMatchObject({ outcome: 'held', held_reason: 'site_unreadable' })
    expect(db.written).toHaveLength(1)
    expect(db.written[0].update.competitor_check).toMatchObject({ outcome: 'pending_site', fingerprint: categoriesFingerprint([REPAIR]) })
    // The marker is not a verdict: it excludes nobody and is never reused as one.
    expect(isCompetitorExcluded(db.written[0].update.competitor_check)).toBe(false)
    expect(storedVerdictFor(db.written[0].update.competitor_check, categoriesFingerprint([REPAIR]), ['C1'])).toBeNull()
  })

  it('PLANTED: the second time the homepage cannot be read, the record-only answer stands', async () => {
    // A site that never loads must not hold a buyer forever.
    const marker = { version: COMPETITOR_SCREEN_VERSION, fingerprint: categoriesFingerprint([REPAIR]), outcome: 'pending_site' }
    const db = fakeDb([{ ...supplier, competitor_check: marker }])
    const result = await screen(db, ['p-supplier'], fakeJudge({ 'Hartwell Parts': reply('no', []) }), { loadSiteText: noSite })
    expect(result).toMatchObject({ ok: true, cleared: ['p-supplier'], held: [] })
    expect(db.written[0].update.competitor_check).toMatchObject({ outcome: 'clear', site_text: 'none' })
  })

  it('PLANTED: a marker left under an older list does not count as the first try', async () => {
    const marker = { version: COMPETITOR_SCREEN_VERSION, fingerprint: 'an-older-list', outcome: 'pending_site' }
    const db = fakeDb([{ ...supplier, competitor_check: marker }])
    const result = await screen(db, ['p-supplier'], fakeJudge({ 'Hartwell Parts': reply('no', []) }), { loadSiteText: noSite })
    expect(result).toMatchObject({ ok: true, held: ['p-supplier'], cleared: [] })
  })

  it('a yes needs no homepage: an exclusion backed by two phrase tags stands without one', async () => {
    const db = fakeDb([workshop])
    const result = await screen(db, ['p-workshop'], fakeJudge({ 'Northfield Motors': YES }), { loadSiteText: noSite })
    expect(result).toMatchObject({ ok: true, excluded: ['p-workshop'], held: [] })
    expect(db.written[0].update.competitor_check).toMatchObject({ outcome: 'excluded', site_text: 'none' })
  })

  it('PLANTED: a dry run that cannot read the homepage holds and leaves NO marker', async () => {
    const db = fakeDb([supplier])
    const result = await screen(db, ['p-supplier'], fakeJudge({ 'Hartwell Parts': reply('no', []) }), { loadSiteText: noSite, persist: false })
    expect(result).toMatchObject({ ok: true, held: ['p-supplier'] })
    expect(db.written).toEqual([])
  })

  // ── More than one category ──

  describe('a company carrying phrases from two categories', () => {
    const TYRES: CompetitorCategory = { id: 'C2', statement: 'Shops whose main business is fitting tyres.', phrases: ['tyre fitting', 'wheel alignment'], source: 'invented' }
    // Two phrases for C2, one for C1: C2 is asked about first.
    const both = row('p-both', { company_name: 'Quay Tyres', tags: ['tyre fitting', 'wheel alignment', 'vehicle repair'] })
    const list = content([REPAIR, TYRES])

    it('PLANTED: is asked about each, most phrases first, and the second can exclude it', async () => {
      // The first version asked about one category and stored the "no" for the whole list.
      const db = fakeDb([both])
      const judge = fakeJudge({ 'Quay Tyres': [reply('no', []), reply('yes', ['vehicle repair', 'Welcome. We have served local customers'])] })
      const result = await screen(db, ['p-both'], judge, { messagingContent: list })
      expect(judge.categoriesAsked).toEqual([TYRES.statement, REPAIR.statement])
      expect(result).toMatchObject({ ok: true, excluded: ['p-both'], judge_calls: 2 })
      expect(db.written[0].update.competitor_check).toMatchObject({ outcome: 'excluded', category_id: 'C1', categories_asked: ['C2', 'C1'] })
    })

    it('stops at the first yes', async () => {
      const db = fakeDb([both])
      const judge = fakeJudge({ 'Quay Tyres': [reply('yes', ['tyre fitting', 'wheel alignment'])] })
      const result = await screen(db, ['p-both'], judge, { messagingContent: list })
      expect(judge.categoriesAsked).toEqual([TYRES.statement])
      expect(result).toMatchObject({ ok: true, excluded: ['p-both'], judge_calls: 1 })
    })

    it('is clear only when every category it carries phrases for said no', async () => {
      const db = fakeDb([both])
      const result = await screen(db, ['p-both'], fakeJudge({ 'Quay Tyres': [reply('no', []), reply('no', [])] }), { messagingContent: list })
      expect(result).toMatchObject({ ok: true, cleared: ['p-both'], judge_calls: 2 })
      expect(db.written[0].update.competitor_check).toMatchObject({ outcome: 'clear', categories_asked: ['C2', 'C1'] })
    })

    it('PLANTED: a stored "clear" that asked about one category is not reused for a company that now carries two', () => {
      const fingerprint = categoriesFingerprint([REPAIR, TYRES])
      const clear = { version: COMPETITOR_SCREEN_VERSION, fingerprint, outcome: 'clear', category_id: 'C2', categories_asked: ['C2'] }
      expect(storedVerdictFor(clear, fingerprint, ['C2'])).not.toBeNull()
      expect(storedVerdictFor(clear, fingerprint, ['C2', 'C1'])).toBeNull()
      // An exclusion needs no such test: one yes is enough.
      expect(storedVerdictFor({ ...clear, outcome: 'excluded' }, fingerprint, ['C2', 'C1'])).not.toBeNull()
    })

    it('PLANTED: the call budget counts every question, and a company cut short is held, not cleared on half an answer', async () => {
      const db = fakeDb([both])
      const result = await screen(db, ['p-both'], fakeJudge({ 'Quay Tyres': [reply('no', [])] }), { messagingContent: list, maxJudgeCalls: 1 })
      expect(result).toMatchObject({ ok: true, held: ['p-both'], cleared: [], judge_calls: 1 })
      expect(db.written).toEqual([])
    })
  })

  // ── A stored verdict ──

  it('PLANTED: a stored verdict under the SAME list is reused, and the model is not asked again', async () => {
    const fingerprint = categoriesFingerprint([REPAIR])
    const stored = { version: COMPETITOR_SCREEN_VERSION, fingerprint, outcome: 'clear', in_category: 'no', category_id: 'C1', categories_asked: ['C1'], phrase_hits: ['vehicle repair'], main_business: 'car parts', evidence: [] }
    const db = fakeDb([{ ...supplier, competitor_check: stored }])
    const judge = fakeJudge({})
    const result = await screen(db, ['p-supplier'], judge)
    expect(result).toMatchObject({ ok: true, cleared: ['p-supplier'], judge_calls: 0 })
    expect(judge.asked).toEqual([])
    expect(db.written).toEqual([])
  })

  it('PLANTED: a changed list retires the stored verdict and the company is asked about again', async () => {
    const old = { version: COMPETITOR_SCREEN_VERSION, fingerprint: categoriesFingerprint([REPAIR]), outcome: 'clear', in_category: 'no', category_id: 'C1', categories_asked: ['C1'], phrase_hits: ['vehicle repair'], main_business: 'car parts', evidence: [] }
    const narrower = { ...REPAIR, not_this: 'Parts suppliers stay in scope.' }
    expect(categoriesFingerprint([narrower])).not.toBe(categoriesFingerprint([REPAIR]))
    expect(storedVerdictFor(old, categoriesFingerprint([narrower]), ['C1'])).toBeNull()
    const db = fakeDb([{ ...supplier, competitor_check: old }])
    const judge = fakeJudge({ 'Hartwell Parts': reply('no', []) })
    const result = await screen(db, ['p-supplier'], judge, { messagingContent: content([narrower]) })
    expect(result).toMatchObject({ ok: true, judge_calls: 1 })
    expect(judge.asked).toEqual(['Hartwell Parts'])
  })

  it('the fingerprint ignores order and case of phrases, and nothing else', () => {
    const reordered = { ...REPAIR, phrases: ['MOT Testing', 'vehicle repair', 'car servicing'] }
    expect(categoriesFingerprint([reordered])).toBe(categoriesFingerprint([REPAIR]))
    expect(categoriesFingerprint([{ ...REPAIR, phrases: [...REPAIR.phrases, 'bodywork'] }])).not.toBe(categoriesFingerprint([REPAIR]))
    expect(categoriesFingerprint([{ ...REPAIR, statement: 'Something else.' }])).not.toBe(categoriesFingerprint([REPAIR]))
  })

  // ── The way back ──

  describe('a prospect excluded under an older list', () => {
    const excluded = (over: Partial<CompetitorScreenRow> = {}) => ({
      ...supplier, tiering_reason: 'competitor',
      competitor_check: { version: COMPETITOR_SCREEN_VERSION, fingerprint: 'older-list', outcome: 'excluded', category_id: 'C1' },
      ...over,
    })

    it('PLANTED: is restored when it still carries a phrase and the model now says no', async () => {
      const db = fakeDb([excluded()])
      const result = await screen(db, ['p-supplier'], fakeJudge({ 'Hartwell Parts': reply('no', []) }))
      expect(result).toMatchObject({ ok: true, cleared: ['p-supplier'], restored: ['p-supplier'] })
      expect(db.written[0].update).toMatchObject({ tiering_reason: null })
      expect(isCompetitorExcluded(db.written[0].update.competitor_check)).toBe(false)
    })

    it('PLANTED: is restored when its PHRASE was taken off the list, with no model asked', async () => {
      // The natural way to narrow a list drawn too wide. Before this the row was counted as
      // "no phrase", nothing was written, and tiering re-excluded it on every later run.
      const withoutPhrase = { ...REPAIR, phrases: ['car servicing', 'mot testing'] }
      const db = fakeDb([excluded()])
      const judge = fakeJudge({})
      const result = await screen(db, ['p-supplier'], judge, { messagingContent: content([withoutPhrase]) })
      expect(judge.asked).toEqual([])
      expect(result).toMatchObject({ ok: true, cleared: ['p-supplier'], restored: ['p-supplier'], judge_calls: 0 })
      expect(db.written[0].update).toMatchObject({ tiering_reason: null })
      expect(db.written[0].update.competitor_check).toMatchObject({ outcome: 'clear', restored: true, fingerprint: categoriesFingerprint([withoutPhrase]) })
    })

    it('PLANTED: is restored when the whole category was deleted and the list is now empty', async () => {
      const db = fakeDb([excluded()])
      const result = await screen(db, ['p-supplier'], fakeJudge({}), { messagingContent: content([]) })
      expect(result).toMatchObject({ ok: true, screened: true, cleared: ['p-supplier'], restored: ['p-supplier'] })
      expect(db.written[0].update).toMatchObject({ tiering_reason: null })
    })

    it('PLANTED: is NOT restored by a document that carries no list at all, or by a list that cannot be used', async () => {
      // A missing or broken list must not release competitors.
      const none = fakeDb([excluded()])
      expect(await screen(none, ['p-supplier'], fakeJudge({}), { messagingContent: { outbound_brief: {} } })).toMatchObject({ ok: true, screened: false, restored: [] })
      expect(none.written).toEqual([])
      const broken = fakeDb([excluded()])
      expect((await screen(broken, ['p-supplier'], fakeJudge({}), { messagingContent: content([{ id: 'C1', statement: '', phrases: [], source: 'x' }]) })).ok).toBe(false)
      expect(broken.written).toEqual([])
    })

    it('PLANTED: a restore clears the removal reason only when that reason is the competitor one', async () => {
      // Removed for something else since: tiering\'s reason stays.
      const db = fakeDb([excluded({ tiering_reason: 'company_too_large' })])
      await screen(db, ['p-supplier'], fakeJudge({}), { messagingContent: content([]) })
      expect(Object.keys(db.written[0].update)).toEqual(['competitor_check'])
    })

    it('PLANTED: a dry run reports the restore and writes nothing', async () => {
      const db = fakeDb([excluded()])
      const result = await screen(db, ['p-supplier'], fakeJudge({}), { messagingContent: content([]), persist: false })
      expect(result).toMatchObject({ ok: true, restored: ['p-supplier'] })
      expect(db.written).toEqual([])
    })

    it('PLANTED: a restore that could not be written is reported as still excluded', async () => {
      const db = fakeDb([excluded()], { writeError: 'gateway timeout' })
      const result = await screen(db, ['p-supplier'], fakeJudge({}), { messagingContent: content([]) })
      expect(result).toMatchObject({ ok: true, excluded: ['p-supplier'], restored: [], cleared: [] })
    })
  })

  // ── Writes ──

  it('PLANTED: an uploaded prospect keeps its tier; the verdict is recorded and nothing else changes', async () => {
    const db = fakeDb([{ ...workshop, outbound_upload_status: 'uploaded' }])
    const result = await screen(db, ['p-workshop'], fakeJudge({ 'Northfield Motors': YES }))
    expect(result).toMatchObject({ ok: true, excluded: ['p-workshop'] })
    expect(Object.keys(db.written[0].update)).toEqual(['competitor_check'])
  })

  it('PLANTED: a dry run answers everything and writes nothing', async () => {
    const db = fakeDb([workshop])
    const result = await screen(db, ['p-workshop'], fakeJudge({ 'Northfield Motors': YES }), { persist: false })
    expect(result).toMatchObject({ ok: true, excluded: ['p-workshop'] })
    expect(db.written).toEqual([])
  })

  it('PLANTED: a verdict that could not be written is a hold, not an exclusion that exists only in memory', async () => {
    const db = fakeDb([workshop], { writeError: 'gateway timeout' })
    const result = await screen(db, ['p-workshop'], fakeJudge({ 'Northfield Motors': YES }))
    expect(result).toMatchObject({ ok: true, held: ['p-workshop'], excluded: [] })
  })

  it('PLANTED: a screen that could not read the selection says so and does not pass it', async () => {
    const db = fakeDb([workshop], { readError: 'gateway timeout' })
    const result = await screen(db, ['p-workshop'], fakeJudge({}))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.error).toMatch(/Could not read the selection to check it for competitors: gateway timeout/)
  })

  it('PLANTED: another organisation\'s prospect is never read, judged or written', async () => {
    const db = fakeDb([workshop])
    const judge = fakeJudge({})
    const result = await screenCompetitors({ supabase: db.client, organisationId: 'another-org', prospectIds: ['p-workshop'], messagingContent: content([REPAIR]), persist: true, client: judge.client, loadSiteText: aSite })
    // The row does not come back for the other organisation, so there is nothing to screen.
    expect(result).toMatchObject({ ok: true, unscreenable: 1, judge_calls: 0 })
    expect(db.written).toEqual([])
  })

  it('says in one sentence what it did, and nothing when it did nothing', () => {
    const base = { ok: true as const, screened: true, cleared: [], restored: [], unscreenable: 0, judge_calls: 0, usage: { input_tokens: 0, output_tokens: 0 }, details: [], problems: [] }
    expect(describeCompetitorScreen({ ...base, excluded: [], held: [] })).toBeNull()
    expect(describeCompetitorScreen({ ...base, excluded: ['a'], held: [] })).toMatch(/^1 excluded as a competitor/)
    expect(describeCompetitorScreen({ ...base, excluded: ['a', 'b'], held: ['c'] })).toMatch(/2 excluded as competitors.*; 1 held because the competitor check gave no answer/)
  })
})

// ─── Tiering honours the verdict ─────────────────────────────────────────────

describe('tiering and a stored competitor verdict', () => {
  const spec = {
    buyer_criterion: null,
    company_headcount_max: 50,
    industries: ['Retail'],
    industries_excluded: [],
    keywords: [],
  } as never
  const prospect = (competitor_check: unknown) => ({
    id: 'p1', organisation_id: ORG, email_status: 'verified', enrichment_status: 'enriched',
    job_title: 'Owner', company_headcount: 10, company_industry: null, company_name: 'Northfield Motors',
    competitor_check,
  })

  it('PLANTED: an excluded company is removed as a competitor whatever else is true of it', async () => {
    const result = await classifyTier(prospect({ outcome: 'excluded' }), spec)
    expect(result).toMatchObject({ sourced_tier: null, fit_score: null, tiering_reason: 'competitor' })
  })

  it('PLANTED: it comes FIRST, so an unverified address does not relabel the removal', async () => {
    const result = await classifyTier({ ...prospect({ outcome: 'excluded' }), email_status: 'unverified' }, spec)
    expect(result.tiering_reason).toBe('competitor')
  })

  it('a clear verdict, or none, changes nothing', async () => {
    const withClear = await classifyTier(prospect({ outcome: 'clear' }), spec)
    const withNone = await classifyTier(prospect(null), spec)
    expect(withClear.tiering_reason).not.toBe('competitor')
    expect(withClear).toEqual(withNone)
  })

  // THE VERDICT ONLY WORKS IF THE CALLER SELECTED IT. The field is optional on the type and
  // every caller casts its rows, so dropping the column from a select compiles, and the next
  // re-tier then hands every excluded competitor its tier back with the suite green. A
  // source pin, with its limit: it proves the column is asked for, not that the path runs.
  it.each([
    ['the tiering pass', 'src/lib/sourcing/tiering-trigger.ts', /\.select\('[^']*\bcompetitor_check\b[^']*'\)/],
    ['the tiering replay', 'src/lib/sourcing/tiering-replay.ts', /REPLAY_COLUMNS =[\s\S]{0,400}?\bcompetitor_check\b/],
    ['the industry-tag re-tier', 'src/app/api/operator/industry-tag-mappings/route.ts', /\.select\('[^']*\bcompetitor_check\b[^']*'\)/],
  ])('PLANTED: %s selects the stored verdict', (_name, file, pattern) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8')
    expect(source).toContain('classifyTier')   // the control: the right file was read
    expect(source).toMatch(pattern)
  })

  it('the industry-tag re-tier hands the verdict to the classifier', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/api/operator/industry-tag-mappings/route.ts'), 'utf8')
    expect(source).toMatch(/competitor_check:\s*prospect\.competitor_check/)
  })

  it('the reason is registered and has operator wording', () => {
    expect(REMOVAL_REASONS as readonly string[]).toContain(COMPETITOR_REMOVAL_REASON)
    expect(DISQUALIFIER_LABELS[COMPETITOR_REMOVAL_REASON]).toBe('Sells the same service as this client')
  })
})
