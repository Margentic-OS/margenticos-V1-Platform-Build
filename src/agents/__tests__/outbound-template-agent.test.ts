// The outbound template agent: the brief-only seam, Rule Zero on its prompts, the angle
// plan, the scope judge's verdict, the stored content shape, and the run loop itself.
// No model is called in this file: the run loop is driven by a FAKE client that answers the
// three prompts the agent sends and throws on anything else.

import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import {
  compactViolations,
  OUTBOUND_TEMPLATE_SYSTEM_PROMPT,
  OutboundTemplateFailure,
  PEER_LABEL_JUDGE_SYSTEM_PROMPT,
  SCOPE_JUDGE_SYSTEM_PROMPT,
  buildGenerationPrompt,
  buildMessagingContent,
  email1WordBudget,
  generateOutboundTemplates,
  judgePeerDefaultLabel,
  linesToRaw,
  mergeRepair,
  planAngles,
  neutralVariantIndex,
  lineRefsFor,
  runScopeJudge,
  scopeLineTag,
  scopeHitsFromJudge,
  parseModelJson,
  toVariantLines,
  variantKeysFor,
  type ScopeLineRef,
} from '../outbound-template-agent'
import { briefFromMessagingContent } from '@/lib/outbound-brief/brief'
import {
  INVENTED_OPENER_FRAMES,
  INVENTED_SIGNOFF,
  inventedBrief,
  inventedVariants,
} from '@/lib/outbound-templates/__tests__/fixtures/invented-client'
import { FRAME_WORDS, IDIOMS, validateTemplateDocument } from '@/lib/outbound-templates/validate-templates'

describe('the brief-only seam', () => {
  it('builds the prompt from the brief alone: no other document field reaches it', () => {
    const SENTINEL = 'SENTINEL_OLD_TEMPLATE_WORDING'
    const content = {
      outbound_brief: inventedBrief(),
      variants: { A: { emails: [{ body: `${SENTINEL} in the live template` }] } },
      icp_notes: SENTINEL,
      positioning: { hook: SENTINEL },
    }
    const brief = briefFromMessagingContent(content)
    expect(brief).not.toBeNull()
    const prompt = buildGenerationPrompt(brief!, planAngles(brief!), variantKeysFor(brief!))
    expect(prompt).not.toContain(SENTINEL)
    // Control: the brief's own wording DOES reach the prompt, so the absence above is not
    // a prompt that carries nothing.
    expect(prompt).toContain(inventedBrief().pain_angles[0].symptom)
    // Rule 5: the generator is shown the symptom, never the diagnosis held in `statement`.
    expect(prompt).not.toContain(inventedBrief().pain_angles[1].statement)
  })

  it('never shows the model an angle that conflicts with an in-scope buyer (rule 11)', () => {
    // PA4 declares conflicts_with X2. It used to be sent with the conflict stripped off, so
    // the model could read the angle, was not told it was off limits, and could write it
    // into another angle's paragraph.
    const brief = inventedBrief()
    const prompt = buildGenerationPrompt(brief, planAngles(brief), variantKeysFor(brief))
    expect(prompt).not.toContain('"PA4"')
    expect(prompt).not.toContain(brief.pain_angles[3].symptom)
    // The model is shown what an offer sells and which outcome answers each pain...
    expect(prompt).toContain('"outcomes"')
    expect(prompt).toContain('"resolved_by"')
    // ...and never who the client's competitors are: that decides who is researched.
    expect(prompt).not.toContain('competitor')
    expect(prompt).not.toContain(brief.competitor_categories[0].phrases[0])
    // Control: a usable angle of the same reach IS shown, so the absence is the rule.
    expect(prompt).toContain('"PA3"')
    expect(prompt).toContain(brief.pain_angles[2].symptom)
  })

  it('states the length budget when it is given one', () => {
    const brief = inventedBrief()
    const prompt = buildGenerationPrompt(brief, planAngles(brief), variantKeysFor(brief), { min: 39, max: 50 })
    expect(prompt).toContain('pain + lead_in + offer + question together are 39 to 50 words')
  })

  it('returns no brief for a document without a valid one', () => {
    expect(briefFromMessagingContent({ variants: {} })).toBeNull()
    expect(briefFromMessagingContent({ outbound_brief: { brief_version: 1 } })).toBeNull()
  })
})

describe('Rule Zero on the agent prompts', () => {
  // Market words from the one live client's own documents. Shared prompts must name no
  // industry, buyer type or pain; those arrive from the brief at run time.
  const MARKET_WORDS = ['referral', 'consult', 'pipeline', 'diary', 'margentic', 'founder', 'agency']
  for (const [name, prompt] of [['generation', OUTBOUND_TEMPLATE_SYSTEM_PROMPT], ['scope judge', SCOPE_JUDGE_SYSTEM_PROMPT], ['peer label judge', PEER_LABEL_JUDGE_SYSTEM_PROMPT]] as const) {
    it(`the ${name} prompt holds no market words`, () => {
      const lower = prompt.toLowerCase()
      expect(MARKET_WORDS.filter(w => lower.includes(w))).toEqual([])
    })
  }
  it('the check can see a market word (control)', () => {
    expect('Most consulting firms'.toLowerCase().includes('consult')).toBe(true)
  })
})

describe('planAngles (rules 6 and 11)', () => {
  it('makes one variant per lead angle, each leading with a different one', () => {
    const brief = inventedBrief()
    const keys = variantKeysFor(brief)
    expect(keys).toEqual(['A', 'B'])   // two most_buyers angles in the invented brief
    const plan = planAngles(brief)
    expect(Object.keys(plan)).toEqual(keys)
    expect(new Set(keys.map(k => plan[k].email1)).size).toBe(keys.length)
    for (const k of keys) {
      expect(new Set([plan[k].email1, plan[k].email2, plan[k].email3]).size).toBe(3)
      expect(brief.pain_angles.find(a => a.id === plan[k].email1)!.reach).toBe('most_buyers')
    }
  })

  it('follows the brief: a third lead angle makes a third variant', () => {
    const brief = inventedBrief()
    brief.pain_angles[2].reach = 'most_buyers'
    brief.pain_angles.push({ id: 'PA5', rank: 5, outcome: 'lost deals', statement: 's', symptom: 's', consequence: 'c', reach: 'some_buyers', resolved_by: ['O1'], source: 'invented' })
    expect(variantKeysFor(brief)).toEqual(['A', 'B', 'C'])
    expect(Object.keys(planAngles(brief))).toEqual(['A', 'B', 'C'])
  })

  it('never plans an angle that conflicts with a must_not_exclude buyer', () => {
    const brief = inventedBrief()
    const plan = planAngles(brief)
    const planned = Object.values(plan).flatMap(p => [p.email1, p.email2, p.email3])
    expect(planned).not.toContain('PA4')   // PA4 declares conflicts_with X2
    // Control: without the conflict PA4 is usable, so its absence above is the rule working.
    delete brief.pain_angles[3].conflicts_with
    brief.pain_angles[2].conflicts_with = ['X1']
    const replanned = Object.values(planAngles(brief)).flatMap(p => [p.email1, p.email2, p.email3])
    expect(replanned).toContain('PA4')
    expect(replanned).not.toContain('PA3')
  })

  it('refuses a brief with too few usable angles rather than repeating one', () => {
    const brief = inventedBrief()
    brief.pain_angles[2].conflicts_with = ['X1']   // only PA1 and PA2 remain usable
    expect(() => planAngles(brief)).toThrow(/needs two usable angles/)
  })

  describe('which variant carries the neutral offer line', () => {
    const neutral = (brief: ReturnType<typeof inventedBrief>) =>
      Object.entries(planAngles(brief)).filter(([, p]) => p.neutralOffer).map(([k]) => k)

    it('PLANTED: the lead angle whose OWN first answer is the outcome that answers them all', () => {
      // PA1 is answered first by O3, PA2 first by O1, and O1 is what answers both. So the
      // neutral line goes to the PA2 variant: there it is the natural offer for its own
      // pain and neutral for the other. This is not "the last variant": see the next test.
      const brief = inventedBrief()
      expect(neutralVariantIndex(brief)).toBe(1)
      expect(neutral(brief)).toEqual(['B'])
    })

    it('PLANTED: it follows the brief, not the position: swap the first answers and it moves', () => {
      const brief = inventedBrief()
      brief.pain_angles[0].resolved_by = ['O1', 'O3']   // PA1 is now answered first by O1
      brief.pain_angles[1].resolved_by = ['O2', 'O1']   // and PA2 first by O2
      expect(neutralVariantIndex(brief)).toBe(0)
      expect(neutral(brief)).toEqual(['A'])
    })

    it('exactly one variant, and the first in rank order when two qualify', () => {
      const brief = inventedBrief()
      brief.pain_angles[0].resolved_by = ['O1']
      brief.pain_angles[1].resolved_by = ['O1', 'O2']
      expect(neutral(brief)).toEqual(['A'])
    })

    it('falls back to the last variant when no lead angle is answered first by a common outcome', () => {
      const brief = inventedBrief()
      brief.pain_angles[0].resolved_by = ['O3', 'O1']
      brief.pain_angles[1].resolved_by = ['O2', 'O1']
      expect(neutral(brief)).toEqual(['B'])
    })

    it('a client with one lead angle has no neutral line', () => {
      const brief = inventedBrief()
      brief.pain_angles[1].reach = 'some_buyers'
      expect(neutralVariantIndex(brief)).toBe(-1)
      expect(neutral(brief)).toEqual([])
    })
  })
})

describe('scopeHitsFromJudge', () => {
  const brief = inventedBrief()
  const refs: ScopeLineRef[] = [
    { variant: 'A', line: 'email1.offer', text: 'We help you reach buyers.', kind: 'offer' },
    { variant: 'A', line: 'email1.pain', text: 'Exporters tell us buyers leave.', kind: 'pain', angle: 'PA1' },
  ]
  type Claim = { claim: string; covered_by: string | null; violates: string | null; manual_task?: unknown }
  const claimOf = (c: Claim) => ({ manual_task: false, ...c })
  const clean = (n: number | string, claims: Claim[] = []) =>
    ({ n, claims: claims.map(claimOf), proof_used: [] as unknown[], excludes: null as string | null, idiom: null as string | null, ambiguous: null as string | null, unnatural: null as string | null, fragment: false, slot_reads: true, sells_outcome: true, resolves_pain: true, asserts_about_reader: false, self_diagnosis: false, narrow_consequence: false, consequence_follows: true, question_matches: true })
  const verdict = (lines: unknown, r = refs) => scopeHitsFromJudge(lines, r, brief)
  const reasons = (lines: unknown, r = refs) => verdict(lines, r).hits.map(h => h.reason).join(' | ')

  it('passes a covered claim and a claim-free line', () => {
    expect(verdict([clean(1, [{ claim: 'we translate', covered_by: 'D1', violates: null }]), clean(2)])).toEqual({ hits: [], unplaced: [] })
  })
  it.each([
    ['a never-claim', { claim: 'instant', covered_by: 'D1', violates: 'N1' }, 'states N1'],
    ['an uncovered claim', { claim: 'we also run ads', covered_by: null, violates: null }, 'beyond scope'],
    ['an invented id', { claim: 'we translate', covered_by: 'D9', violates: null }, 'beyond scope'],
    ['a manual task (rule 2)', { claim: 'we type up your terms', covered_by: 'D1', violates: null, manual_task: true }, 'manual task'],
    ['a non-lead proof point in the Email 1 offer (rule 4)', { claim: 'you see every page', covered_by: 'PR2', violates: null }, 'not the lead differentiator'],
    ['a proof-only scope item in the Email 1 offer (rule 4)', { claim: 'one place for status', covered_by: 'D2', violates: null }, 'not the lead differentiator'],
  ])('rejects %s (planted)', (_name, claim, expected) => {
    expect(reasons([clean(1, [claim]), clean(2)])).toContain(expected)
  })
  it('allows the lead differentiator in the Email 1 offer (control for rule 4)', () => {
    expect(verdict([clean(1, [{ claim: 'a native speaker checks', covered_by: 'PR1', violates: null }]), clean(2)]).hits).toEqual([])
  })
  it('holds rule 4 on the ALTERNATE offer wording too', () => {
    const two: ScopeLineRef[] = [{ variant: 'A', line: 'email1.offer.alt', text: 'You can see every page.', kind: 'offer' }, refs[1]]
    expect(reasons([clean(1, [{ claim: 'you see every page', covered_by: 'PR2', violates: null }]), clean(2)], two)).toContain('not the lead differentiator')
  })
  it('rejects a proof point claimed in two lines of one sequence, whatever `from` says (rule 4)', () => {
    const three: ScopeLineRef[] = [...refs, { variant: 'A', line: 'email3.p2', text: 'A native speaker checks it.', kind: 'offer' }]
    expect(reasons([
      clean(1, [{ claim: 'native speaker', covered_by: 'PR1', violates: null }]), clean(2),
      clean(3, [{ claim: 'native speaker', covered_by: 'PR1', violates: null }]),
    ], three)).toContain('proof PR1 is used in 2 lines')
  })
  it('counts a line, its alternate wording and its slotted form as ONE use', () => {
    const forms: ScopeLineRef[] = [
      refs[0],
      { variant: 'A', line: 'email1.offer.alt', text: 'We help you reach buyers too.', kind: 'offer' },
      { variant: 'A', line: 'email1.offer.slotted', text: 'We help you reach [their customers].', kind: 'offer' },
      { variant: 'A', line: 'email1.offer.alt.slotted', text: 'We help [their customers] find you.', kind: 'offer' },
    ]
    const lead = [{ claim: 'native speaker', covered_by: 'PR1', violates: null }]
    expect(verdict([clean(1, lead), clean(2, lead), clean(3, lead), clean(4, lead)], forms).hits).toEqual([])
  })
  it('sees a proof point inside a QUESTION, which makes no claim (rule 4)', () => {
    // The judge is told a question is not a sender claim, so it lists none. Counted by claims
    // alone, a proof point restated in a call ask was invisible and appeared twice.
    const withAsk: ScopeLineRef[] = [...refs, { variant: 'A', line: 'email3.p3', text: 'Would a call on how a native speaker checks each page help?', kind: 'ask' }]
    const out = reasons([
      clean(1, [{ claim: 'native speaker', covered_by: 'PR1', violates: null }]), clean(2),
      { ...clean(3), proof_used: ['PR1'] },
    ], withAsk)
    expect(out).toContain('proof PR1 is used in 2 lines')
  })
  it('rejects any proof point in an Email 1 subject or question, the lead one included', () => {
    const e1: ScopeLineRef[] = [
      { variant: 'A', line: 'email1.subject', text: 'native speakers check every page', kind: 'subject' },
      { variant: 'A', line: 'email1.question.alt', text: 'Do you want every page checked by a native speaker?', kind: 'ask' },
    ]
    const out = verdict([{ ...clean(1), proof_used: ['PR1'] }, { ...clean(2), proof_used: ['PR1'] }], e1).hits.map(h => h.reason)
    expect(out.filter(r => r.includes('sits in the offer only'))).toHaveLength(2)
  })
  it('rejects a proof point used as the pain', () => {
    expect(reasons([clean(1), { ...clean(2), proof_used: ['PR1'] }])).toContain('never fills a pain')
  })
  it.each([
    ['a self-diagnosis (rule 5)', { self_diagnosis: true }, 'diagnosis'],
    ['a narrow consequence (rule 6)', { narrow_consequence: true }, 'narrower'],
  ])('rejects %s on a pain line', (_name, flags, expected) => {
    expect(reasons([clean(1), { ...clean(2), ...flags }])).toContain(expected)
  })
  it('holds a break-up paragraph to the same two questions: it names the pain again', () => {
    const close: ScopeLineRef[] = [{ variant: 'A', line: 'email4.p2', text: 'If the pages nobody translated become a priority, reply.', kind: 'close', angle: 'PA1' }]
    expect(reasons([{ ...clean(1), self_diagnosis: true }], close)).toContain('diagnosis')
  })
  it('ignores the diagnosis and consequence flags on a line that is neither a pain nor a close', () => {
    // Line 1 is an offer. Since 2026-10-03 asserts_about_reader IS read on an offer (below),
    // so it is left false here: what this proves is that the two pain questions are not.
    expect(verdict([{ ...clean(1), self_diagnosis: true, narrow_consequence: true, consequence_follows: false }, clean(2)]).hits).toEqual([])
  })

  // ── The scope judge's questions of 2026-10-03 ──
  it('PLANTED: an offer that states something about the reader, or implies they already have the outcome, is refused', () => {
    expect(reasons([{ ...clean(1), asserts_about_reader: true }, clean(2)])).toContain('implies they already have what the offer provides')
    // The same answer of false passes (control).
    expect(verdict([{ ...clean(1), asserts_about_reader: false }, clean(2)]).hits).toEqual([])
  })
  it('PLANTED: a pain whose consequence does not follow from its symptom is refused, at that line', () => {
    const { hits } = verdict([clean(1), { ...clean(2), consequence_follows: false }])
    expect(hits.map(h => [h.line, h.reason])).toEqual([['email1.pain', 'the consequence does not follow from the pain before it; say what that symptom leads to']])
  })
  it.each([
    ['missing', (l: Record<string, unknown>) => { delete l.consequence_follows }],
    ['a string', (l: Record<string, unknown>) => { l.consequence_follows = 'true' }],
  ])('PLANTED: a pain whose consequence_follows answer is %s is an unanswered question, never a pass', (_name, mutate) => {
    const pain: Record<string, unknown> = { ...clean(2) }
    mutate(pain)
    expect(reasons([clean(1), pain])).toContain('the scope judge did not say whether the consequence follows from the pain')
  })
  it('consequence_follows is not asked of an offer: a missing answer there costs nothing (control)', () => {
    const offer: Record<string, unknown> = { ...clean(1) }
    delete offer.consequence_follows
    expect(verdict([offer, clean(2)]).hits).toEqual([])
  })

  describe('question_matches: an ask is about the pain of its own email (2026-10-03)', () => {
    const PAIN = 'Exporters tell us a new market can start slowly.'
    const ask: ScopeLineRef[] = [{ variant: 'A', line: 'email2.p3', text: 'Is a slow start abroad a problem for you?', kind: 'ask', painAbove: PAIN }]
    it('PLANTED: an ask the judge says asks about something else is refused, and the pain is named', () => {
      expect(reasons([{ ...clean(1), question_matches: false }], ask)).toBe(`the question does not ask about this email's pain: "${PAIN}"`)
    })
    it.each([
      ['missing', (l: Record<string, unknown>) => { delete l.question_matches }],
      ['a string', (l: Record<string, unknown>) => { l.question_matches = 'false' }],
    ])('PLANTED: an ask whose question_matches answer is %s is an unanswered question, never a pass', (_name, mutate) => {
      const line: Record<string, unknown> = { ...clean(1) }
      mutate(line)
      expect(reasons([line], ask)).toContain('the scope judge did not say whether the question matches its email')
    })
    it('an ask the judge says matches passes (control)', () => {
      expect(verdict([{ ...clean(1), question_matches: true }], ask).hits).toEqual([])
    })
    it('an ask with no pain above it is not asked: a missing answer there costs nothing (control)', () => {
      const line: Record<string, unknown> = { ...clean(1), question_matches: false }
      expect(verdict([line], [{ ...ask[0], painAbove: undefined }]).hits).toEqual([])
    })
    it('lineRefsFor gives every ask the pain above it: Email 1\'s question both wordings, a follow-up ask its own email\'s pain', () => {
      const refs = lineRefsFor({ A: inventedVariants().A }, 'exporters', inventedBrief())
      const painAbove = (line: string) => refs.find(r => r.line === line)?.painAbove
      expect(painAbove('email1.question')).toBe(painAbove('email1.offer'))
      expect(painAbove('email1.question.alt')).toContain(' / ')
      expect(painAbove('email2.p3')).toBe('In our chats with exporters, a lot of them say a new market starts slower than hoped. So growth plans can slip, and the launch can cost more than it should.')
      expect(painAbove('email3.p3')).toBe('From what exporters tell us, free tools came first and buyers noticed the errors.')
      // A pain line has none: it is the pain (control).
      expect(painAbove('email1.pain')).toBeUndefined()
    })
  })
  it('rejects a pain or a break-up line that states something about the reader as a fact (rule 1)', () => {
    // The validator reads the form of a pain sentence, in paragraphs of kind pain only. A
    // break-up names the pain again in a "close" paragraph, where no form rule can run.
    expect(reasons([clean(1), { ...clean(2), asserts_about_reader: true }])).toContain('states something about the reader as a fact')
    const close: ScopeLineRef[] = [{ variant: 'A', line: 'email4.p1', text: 'Your new buyers abroad leave the site.', kind: 'close', angle: 'PA1' }]
    expect(reasons([{ ...clean(1), asserts_about_reader: true }], close)).toContain('states something about the reader as a fact')
  })
  it('ignores a proof_used entry that is a real id but not proof (control)', () => {
    expect(verdict([{ ...clean(1), proof_used: ['D1', 'PA1'] }, clean(2)]).hits).toEqual([])
  })

  // AN UNANSWERED QUESTION IS NOT A PASS. Each of these returned zero hits before.
  it.each([
    ['no claims list', (l: Record<string, unknown>) => { delete l.claims }, 0, 'no list of claims'],
    ['manual_task as a string', (l: Record<string, unknown>) => { l.claims = [{ claim: 'we translate', covered_by: 'D1', violates: null, manual_task: 'true' }] }, 0, 'did not say whether this claim is a manual task'],
    ['manual_task missing', (l: Record<string, unknown>) => { l.claims = [{ claim: 'we translate', covered_by: 'D1', violates: null }] }, 0, 'did not say whether this claim is a manual task'],
    ['no proof_used list', (l: Record<string, unknown>) => { delete l.proof_used }, 0, 'which proof points'],
    ['no excludes key', (l: Record<string, unknown>) => { delete l.excludes }, 0, 'whether this line excludes'],
    ['no idiom key', (l: Record<string, unknown>) => { delete l.idiom }, 0, 'whether this line uses a figure of speech'],
    ['no ambiguous key', (l: Record<string, unknown>) => { delete l.ambiguous }, 0, 'whether this line can be read two ways'],
    ['no unnatural key', (l: Record<string, unknown>) => { delete l.unnatural }, 0, 'whether this line reads as natural English'],
    ['unnatural as a list', (l: Record<string, unknown>) => { l.unnatural = ['come in steady'] }, 0, 'whether this line reads as natural English'],
    ['no fragment key', (l: Record<string, unknown>) => { delete l.fragment }, 0, 'whether this line holds a sentence fragment'],
    ['no sells_outcome key on an offer', (l: Record<string, unknown>) => { delete l.sells_outcome }, 0, 'did not answer sells_outcome and resolves_pain'],
    ['resolves_pain as a string on an offer', (l: Record<string, unknown>) => { l.resolves_pain = 'true' }, 0, 'did not answer sells_outcome and resolves_pain'],
    ['no self_diagnosis key on a pain line', (l: Record<string, unknown>) => { delete l.self_diagnosis }, 1, 'did not answer asserts_about_reader, self_diagnosis'],
    ['narrow_consequence as a string on a pain line', (l: Record<string, unknown>) => { l.narrow_consequence = 'false' }, 1, 'did not answer asserts_about_reader, self_diagnosis'],
    ['no asserts_about_reader key on a pain line', (l: Record<string, unknown>) => { delete l.asserts_about_reader }, 1, 'did not answer asserts_about_reader'],
    ['a proof_used entry that is not an id of this brief', (l: Record<string, unknown>) => { l.proof_used = ['pr1'] }, 0, 'not in the brief: "pr1"'],
    ['a proof_used entry that is not a string', (l: Record<string, unknown>) => { l.proof_used = [{ id: 'PR1' }] }, 0, 'not in the brief'],
  ])('rejects a line whose answer has %s', (_name, mutate, index, expected) => {
    const lines: Array<Record<string, unknown>> = [
      { ...clean(1, [{ claim: 'we translate', covered_by: 'D1', violates: null }]) },
      { ...clean(2) },
    ]
    mutate(lines[index])
    const { hits } = verdict(lines)
    expect(hits.map(h => h.reason).join(' | ')).toContain(expected)
    expect(hits.every(h => h.line === refs[index].line)).toBe(true)
  })
  it('reads a line number sent as a string as that line, not as no answer', () => {
    // "1" and "2" used to process the lines and then report every one as unanswered,
    // sending clean variants to an expensive repair.
    expect(verdict([clean('1', [{ claim: 'we translate', covered_by: 'D1', violates: null }]), clean('2')]).hits).toEqual([])
  })
  it('treats an answer that is not a list as nothing judged', () => {
    const { hits } = verdict({ 1: clean(1) })
    expect(hits).toHaveLength(2)
    expect(hits.every(h => h.reason.includes('returned no verdict'))).toBe(true)
  })

  it('rejects a line the judge says holds a figure of speech, and names the phrase', () => {
    // The reader rule a word list could not hold: a list catches only what it names.
    expect(reasons([{ ...clean(1), idiom: 'takes a back seat' }, clean(2)])).toContain('uses a figure of speech, say it literally: "takes a back seat"')
    // Control: null and an empty string are both "none".
    expect(verdict([{ ...clean(1), idiom: '' }, clean(2)]).hits).toEqual([])
  })
  describe('the reviewer flags unnatural phrasing (fifth reading, note 6)', () => {
    // refs[0] reads "We help you reach buyers." and refs[1] "Exporters tell us buyers leave."
    it('PLANTED: a phrase the judge says is not natural English fails the line, and is named', () => {
      expect(reasons([{ ...clean(1), unnatural: 'reach buyers' }, clean(2)]))
        .toContain('not how a native speaker would write it; keep the meaning and write it correctly: "reach buyers"')
    })
    it('null and an empty string are both "none" (control)', () => {
      expect(verdict([{ ...clean(1), unnatural: '' }, clean(2)]).hits).toEqual([])
      expect(verdict([clean(1), clean(2)]).hits).toEqual([])
    })
    it('PLANTED: a phrase that is not IN the line it was raised on is not held against it', () => {
      // The judge quotes outside its rule when it can: a phrase from another line, or one it
      // rewrote. Code holds the answer to the line's own words.
      expect(verdict([{ ...clean(1), unnatural: 'come in steady' }, clean(2)]).hits).toEqual([])
      expect(verdict([{ ...clean(1), unnatural: 'buyers leave' }, clean(2)]).hits).toEqual([])
      // Control: the same phrase on the line that holds it is a hit.
      expect(reasons([clean(1), { ...clean(2), unnatural: 'buyers leave' }])).toContain('"buyers leave"')
    })
    it('PLANTED: the brief\'s own wording is never held against a line', () => {
      // "Sales abroad can stall." is pain angle PA1's consequence in the invented brief.
      const own: ScopeLineRef[] = [refs[0], { ...refs[1], text: 'Exporters tell us buyers leave. Sales abroad can stall.' }]
      expect(scopeHitsFromJudge([clean(1), { ...clean(2), unnatural: 'Sales abroad can stall' }], own, brief).hits).toEqual([])
      // Control: wording the brief does not hold, in the same line, is a hit.
      expect(scopeHitsFromJudge([clean(1), { ...clean(2), unnatural: 'buyers leave' }], own, brief).hits).toHaveLength(1)
    })
    it('the judge is asked about correctness, in words that say what is NOT a fault', () => {
      expect(SCOPE_JUDGE_SYSTEM_PROMPT).toContain('- unnatural:')
      expect(SCOPE_JUDGE_SYSTEM_PROMPT).toContain('This is about correctness, never taste. When unsure, null.')
      expect(SCOPE_JUDGE_SYSTEM_PROMPT).toContain('"unnatural":null')
    })
  })

  it('never holds the brief\'s own confirmed wording against a line as a figure of speech', () => {
    // Measured live: the judge flagged a consequence that is in the brief word for word.
    // "Sales abroad can stall." is pain angle PA1's consequence in the invented brief.
    expect(verdict([clean(1), { ...clean(2), idiom: 'Sales abroad can stall.' }]).hits).toEqual([])
    // Control: the same answer about wording the brief does not hold is a hit.
    expect(reasons([clean(1), { ...clean(2), idiom: 'sales dry up abroad' }])).toContain('figure of speech')
  })

  // ── The second reading's notes (2026-10-01) ──
  it('rejects an offer that says only how the sender works, or ends on a feature (note 1; shape of 2026-10-02)', () => {
    expect(reasons([{ ...clean(1, [{ claim: 'we translate', covered_by: 'D1', violates: null }]), sells_outcome: false }, clean(2)]))
      .toContain('end on the outcome the reader gets')
  })
  it('PLANTED: a break-up is not asked about fragments; an ask and a pain still are (fourth reading, note 3)', () => {
    // "Break-up emails read like a person", and a person easing off opens on a phrase with
    // no verb. The fragment answer had been widened from asks to every line.
    const whole = lineRefsFor({ A: inventedVariants().A }, 'exporters', inventedBrief())
    const closeRef = whole.findIndex(r => r.kind === 'close')
    const askRef = whole.findIndex(r => r.kind === 'ask')
    expect(closeRef).toBeGreaterThanOrEqual(0)
    expect(askRef).toBeGreaterThanOrEqual(0)
    const answers = (fragmentOn: number) => whole.map((_, i) => ({ ...clean(i + 1), fragment: i === fragmentOn }))
    expect(scopeHitsFromJudge(answers(closeRef), whole, inventedBrief()).hits).toEqual([])
    expect(scopeHitsFromJudge(answers(askRef), whole, inventedBrief()).hits.map(h => h.reason).join(' | ')).toContain('holds a fragment')
    // ...and the judge is told so, in the same prompt that asks the question.
    expect(SCOPE_JUDGE_SYSTEM_PROMPT).toContain('A [close] line is always false')
  })
  it('PLANTED: a follow-up paragraph that names the reader\'s firm is judged in BOTH forms', () => {
    // The slot_free form is what most prospects receive; the slotted one is what a prospect
    // with a usable name receives. Neither may go unjudged.
    const all = lineRefsFor({ A: inventedVariants().A }, 'exporters', inventedBrief())
    const text = (line: string) => all.find(r => r.line === line)?.text
    expect(text('email3.p2')).toBe('We translate the pages your team sends most, so people overseas can read what you sell.')
    expect(text('email3.p2.slotted')).toBe("We translate the pages your team sends most, so people overseas can read what [the reader's firm] sells.")
    expect(text('email2.p3.slotted')).toBe("Does that match what [the reader's firm] sees?")
    // A paragraph with no slot has one form.
    expect(all.filter(r => r.line.startsWith('email2.p1')).map(r => r.line)).toEqual(['email2.p1'])
    // The slotted offer is judged against the same pain and outcome as its slot_free form.
    const slotted = all.find(r => r.line === 'email3.p2.slotted')!
    expect(slotted.kind).toBe('offer')
    expect(slotted.painAbove).toBe('From what exporters tell us, free tools came first and buyers noticed the errors.')
    expect(SCOPE_JUDGE_SYSTEM_PROMPT).toContain("[the reader's firm]")
  })
  it('rejects an offer that does not answer the pain above it, and names that pain (note 2)', () => {
    const offer: ScopeLineRef[] = [{ variant: 'A', line: 'email3.p2', text: 'You can see the status of every page.', kind: 'offer', painAbove: 'Buyers often notice errors.' }]
    expect(reasons([{ ...clean(1), resolves_pain: false }], offer)).toContain('does not answer the pain stated above it: "Buyers often notice errors."')
  })
  it('PLANTED: the neutral offer is judged like any other, against the pain of its own variant', () => {
    // For a day it was also judged against every OTHER lead pain. It never sits under one:
    // the selector gives it to a researched opening, which replaces the pain paragraph. Its
    // neutrality is held in code by what it may cite (neutral_offer_outcome).
    const refs = lineRefsFor(inventedVariants(), 'exporters', inventedBrief())
    const neutral = refs.find(r => r.variant === 'B' && r.line === 'email1.offer')!
    expect(inventedVariants().B.email1.offer_angle).toBeNull()
    expect(scopeLineTag(neutral)).not.toContain('NEUTRAL')
    expect(SCOPE_JUDGE_SYSTEM_PROMPT).not.toContain('NEUTRAL')
    expect(reasons([{ ...clean(1), resolves_pain: false }], [neutral])).toContain('does not answer the pain stated above it')
  })

  it('PLANTED: an outcome id under proof_used is a real item that is not proof: ignored, never "not in the brief"', () => {
    expect(verdict([{ ...clean(1), proof_used: ['O1'] }, clean(2)]).hits).toEqual([])
    // Control: an id the brief does not hold is still an answer code cannot read.
    expect(reasons([{ ...clean(1), proof_used: ['zz'] }, clean(2)])).toContain('named a proof point that is not in the brief')
  })

  it('ignores those two answers on a line that is not an offer (control)', () => {
    expect(verdict([clean(1, [{ claim: 'we translate', covered_by: 'D1', violates: null }]), { ...clean(2), sells_outcome: false, resolves_pain: false }]).hits).toEqual([])
  })
  it('rejects a phrase that can be read two ways, and names it (note 3)', () => {
    expect(reasons([clean(1), { ...clean(2), ambiguous: 'someone else' }])).toContain('can be read two ways, say who or what is meant: "someone else"')
    expect(verdict([clean(1), { ...clean(2), ambiguous: '' }]).hits).toEqual([])
  })
  it('PLANTED: a one-word answer is never excused by being INSIDE a longer word of the brief', () => {
    // The exemption was a substring test over the whole brief joined together. "it" is in
    // "site", "one" in "done", "us" in "business": the judge said the line could be read
    // two ways and code threw the answer away.
    for (const word of ['it', 'one', 'that', 'them']) {
      expect(reasons([clean(1), { ...clean(2), ambiguous: word }]), word).toContain(`can be read two ways, say who or what is meant: "${word}"`)
    }
    // And a word that only points is not excused even when the brief holds it AS a word:
    // every brief has "that" in it somewhere.
    const withWord = inventedBrief()
    withWord.pain_angles[0].symptom = 'Buyers abroad leave the site, and that costs them sales.'
    const said = (phrase: string) => scopeHitsFromJudge([clean(1), { ...clean(2), ambiguous: phrase }], refs, withWord).hits.map(h => h.reason).join(' | ')
    // A pointing word, alone or with only small joining words beside it, is never excused.
    for (const phrase of ['that', 'them', 'and that', 'the site and that'.replace('the site ', '')]) {
      expect(said(phrase), phrase).toContain('can be read two ways')
    }
    // Control: the same brief's phrase WITH a content word in it is the brief's wording.
    expect(said('that costs them sales')).toBe('')
    expect(said('leave the site')).toBe('')
  })
  it('PLANTED: an apostrophe is one character however it was typed', () => {
    const curly = inventedBrief()
    curly.pain_angles[0].consequence = 'Buyers abroad can\u2019t read the pages.'
    const hits = (b: ReturnType<typeof inventedBrief>, phrase: string) =>
      scopeHitsFromJudge([clean(1), { ...clean(2), idiom: phrase }], refs, b).hits.map(h => h.reason).join(' | ')
    expect(hits(curly, "can't read the pages")).toBe('')
    const straight = inventedBrief()
    straight.pain_angles[0].consequence = "Buyers abroad can't read the pages."
    expect(hits(straight, 'can\u2019t read the pages')).toBe('')
    // A phrase in quotation marks in the brief is still the brief's wording.
    const quoted = inventedBrief()
    quoted.pain_angles[0].consequence = "Pages that are only 'good enough' can cost sales."
    expect(hits(quoted, 'good enough')).toBe('')
    // Control: wording the brief does not hold is still a hit.
    expect(hits(straight, "can't find the pages")).toContain('figure of speech')
  })
  it('PLANTED: the brief is matched sentence by sentence, never across a full stop', () => {
    const two = inventedBrief()
    two.pain_angles[0].consequence = 'Buyers leave the site. Sales can stall.'
    // Through the idiom answer, which uses the same matching and needs no pointing word.
    expect(scopeHitsFromJudge([clean(1), { ...clean(2), idiom: 'the site sales can stall' }], refs, two).hits.map(h => h.reason).join(' | '))
      .toContain('figure of speech')
    // Control: each sentence on its own is the brief's wording.
    expect(scopeHitsFromJudge([clean(1), { ...clean(2), idiom: 'sales can stall' }], refs, two).hits).toEqual([])
  })
  it('PLANTED: an "ambiguous" answer counts only when the quote holds a word that points', () => {
    // The rule is about a word that points at somebody or something without saying which.
    // Told so, the judge still quoted phrases with nothing pointing in them, run after run,
    // and each was a paid repair that traded it for another.
    for (const phrase of ['the flow', 'who fits', 'the wrong buyers', 'new work comes and goes', 'you', 'your firm']) {
      expect(verdict([clean(1), { ...clean(2), ambiguous: phrase }]).hits, phrase).toEqual([])
    }
    for (const phrase of ['someone else', 'those missed chances', 'it can go to others', 'the right ones', 'elsewhere', 'them', 'it\u2019s', "that's the gap"]) {
      expect(reasons([clean(1), { ...clean(2), ambiguous: phrase }]), phrase).toContain('can be read two ways')
    }
  })
  it('PLANTED: an idiom or "ambiguous" answer that is not a phrase or null is an unanswered question, never "none"', () => {
    // The judge is asked for the phrase quoted exactly, or null. A list of phrases, true or
    // an object is a fault it named in a shape code could not read, and each was read as
    // "none": the line passed as judged clean.
    for (const answer of [['take a back seat'], true, { phrase: 'take a back seat' }, 1]) {
      expect(reasons([clean(1), { ...clean(2), idiom: answer }]), JSON.stringify(answer)).toContain('did not say whether this line uses a figure of speech')
    }
    for (const answer of [['someone else'], true, { phrase: 'someone else' }, 0]) {
      expect(reasons([clean(1), { ...clean(2), ambiguous: answer }]), JSON.stringify(answer)).toContain('did not say whether this line can be read two ways')
    }
    // Controls: null is "none", an empty string is "none", and a missing answer is still a hit.
    expect(verdict([clean(1), { ...clean(2), idiom: null, ambiguous: null }]).hits).toEqual([])
    expect(verdict([clean(1), { ...clean(2), idiom: '', ambiguous: '  ' }]).hits).toEqual([])
    expect(reasons([clean(1), { ...clean(2), idiom: undefined }])).toContain('did not say whether this line uses a figure of speech')
  })
  it('the judge is not shown, as plain English, a phrase the validator refuses as reading two ways', () => {
    // Prompt and validator must agree. The judge's example of a statement with one plain
    // meaning was "new work comes and goes", which the idiom list refuses.
    const ambiguousRule = SCOPE_JUDGE_SYSTEM_PROMPT.split('\n').find(line => line.startsWith('- ambiguous:')) ?? ''
    expect(ambiguousRule).toContain('These are NOT ambiguous')   // control: the right line was read
    for (const idiom of IDIOMS) expect(ambiguousRule.toLowerCase(), idiom).not.toContain(idiom)
  })
  it('still never holds the brief\'s own wording against a line (control)', () => {
    // Matched as whole words: "buyers abroad" is in PA1's symptom.
    expect(verdict([clean(1), { ...clean(2), ambiguous: 'buyers abroad' }]).hits).toEqual([])
    // ONE CONTENT WORD of the brief is its wording too. Measured on a live run: the judge
    // quoted the single word a consequence in the brief opens on, and with a two-word
    // minimum that became a fault no rewrite of the brief's own sentence could clear.
    expect(verdict([clean(1), { ...clean(2), ambiguous: 'Sales' }]).hits).toEqual([])
    expect(verdict([clean(1), { ...clean(2), ambiguous: 'site.' }]).hits).toEqual([])
    // Whole words only: a phrase cut inside a word is not the brief's wording.
    expect(reasons([clean(1), { ...clean(2), ambiguous: 'them abro' }])).toContain('can be read two ways')
    // The same matching for a figure of speech: a word inside a longer word excuses nothing.
    expect(reasons([clean(1), { ...clean(2), idiom: 'stal' }])).toContain('figure of speech')
  })

  describe('an offer\'s outcome sentence is covered by the outcome it cites', () => {
    // The offer must lead with an outcome, and only scope and proof ids were legal cover:
    // whether a correct offer passed depended on the judge not listing its first sentence.
    const offer = (outcomes: ScopeLineRef['outcomes']): ScopeLineRef[] => [{
      variant: 'A', line: 'email1.offer', text: 'Buyers abroad can read your pages and buy. We translate them.', kind: 'offer',
      painAbove: 'Exporters tell us buyers leave.', outcomes,
    }]
    const answer = (coveredBy: string) => [clean(1, [
      { claim: 'buyers abroad can read your pages and buy', covered_by: coveredBy, violates: null },
      { claim: 'we translate them', covered_by: 'D1', violates: null },
    ])]
    it('PLANTED: covered by the outcome the line cites: passes', () => {
      expect(verdict(answer('O1'), offer([{ id: 'O1', statement: 'Buyers abroad can read your pages and buy.' }])).hits).toEqual([])
    })
    it('PLANTED: covered by an outcome the line does NOT cite: beyond scope', () => {
      expect(reasons(answer('O2'), offer([{ id: 'O1', statement: 'Buyers abroad can read your pages and buy.' }]))).toContain('claim beyond scope')
    })
    it('PLANTED: an outcome id is no cover when the line cites no outcome, or is not an offer', () => {
      expect(reasons(answer('O1'), offer(undefined))).toContain('claim beyond scope')
      const pain: ScopeLineRef[] = [{ variant: 'A', line: 'email1.pain', text: 'x', kind: 'pain', angle: 'PA1', outcomes: [{ id: 'O1', statement: 's' }] }]
      expect(reasons([clean(1, [{ claim: 'c', covered_by: 'O1', violates: null }])], pain)).toContain('claim beyond scope')
    })
  })

  it('rejects a line holding a sentence fragment, and never asks it of a subject (note 10)', () => {
    expect(reasons([clean(1), { ...clean(2), fragment: true }])).toContain('holds a fragment')
    const subject: ScopeLineRef[] = [{ variant: 'A', line: 'email1.subject', text: 'new markets', kind: 'subject' }]
    const { fragment: _none, ...noFragment } = clean(1)
    expect(verdict([noFragment], subject).hits).toEqual([])
  })

  // The customer group reads as English where it sits (2026-10-01, from a generated variant).
  describe('a slotted line with a customer group in place', () => {
    const slotted: ScopeLineRef[] = [{ variant: 'A', line: 'email1.subject.slotted', text: 'steady [their customers]', kind: 'subject' }]
    it('PLANTED: rejects a line that does not read as English with the group in place', () => {
      expect(reasons([{ ...clean(1), slot_reads: false }], slotted)).toContain('with a customer group in place of {for_whom} the line does not read as plain English')
    })
    it('PLANTED: an unanswered slot_reads on a slotted line is a failure, not a pass', () => {
      const { slot_reads: _none, ...unanswered } = clean(1)
      expect(reasons([unanswered], slotted)).toContain('did not say whether this line reads as English with a customer group in place')
    })
    it('passes a slotted line the judge says reads well', () => {
      expect(verdict([clean(1)], slotted).hits).toEqual([])
    })
    it('never asks it of a line with no customer group (control)', () => {
      const { slot_reads: _none, ...unanswered } = clean(1)
      const plain: ScopeLineRef[] = [{ variant: 'A', line: 'email1.subject', text: 'new markets', kind: 'subject' }]
      expect(verdict([unanswered], plain).hits).toEqual([])
      expect(verdict([{ ...clean(1), slot_reads: false }], plain).hits).toEqual([])
    })
  })

  // EVERY EXCLUSION COUNTS (operator rule 11: the judge runs clean).
  it('counts an exclusion on a line that does not address the reader', () => {
    const peerRefs: ScopeLineRef[] = [{ variant: 'A', line: 'email2.p1', text: 'Some firms tell us a past supplier was late.', kind: 'pain', angle: 'PA3' }]
    expect(verdict([{ ...clean(1), excludes: 'X2' }], peerRefs).hits).toEqual([{ variant: 'A', line: 'email2.p1', reason: 'excludes in-scope buyer X2' }])
  })
  it('counts an exclusion on a line that addresses the reader', () => {
    const youRefs: ScopeLineRef[] = [{ variant: 'A', line: 'email2.p1', text: 'When your last supplier was late, launches slipped.', kind: 'pain', angle: 'PA3' }]
    expect(verdict([{ ...clean(1), excludes: 'X2' }], youRefs).hits).toHaveLength(1)
  })
  it('rejects a line the judge did not answer for', () => {
    expect(verdict([clean(1)]).hits).toEqual([{ variant: 'A', line: 'email1.pain', reason: 'the scope judge returned no verdict for this line' }])
  })
})

describe('what the scope judge is shown', () => {
  it('sees EVERY wording, tagged with its kind and a pain line\'s angle', () => {
    const refs = lineRefsFor({ A: inventedVariants().A }, 'exporters')
    const lines = refs.map(r => r.line)
    for (const k of ['pain', 'offer', 'question']) {
      expect(lines).toContain(`email1.${k}`)
      expect(lines).toContain(`email1.${k}.alt`)
    }
    expect(refs.find(r => r.line === 'email1.pain.alt')).toMatchObject({ kind: 'pain', angle: 'PA1' })
    expect(refs.find(r => r.line === 'email2.p1')).toMatchObject({ kind: 'pain', angle: 'PA2' })
    expect(refs.find(r => r.line === 'email3.p3')).toMatchObject({ kind: 'ask' })
    expect(refs.find(r => r.line === 'email4.p2')).toMatchObject({ kind: 'close', angle: 'PA1' })
    // An offer is shown with the pain it sits under: both wordings in Email 1, the pain
    // paragraph of its own email in a follow-up.
    expect(refs.find(r => r.line === 'email1.offer.alt')?.painAbove).toContain('When we chat to exporters, a lot of them say buyers abroad leave too soon.')
    expect(refs.find(r => r.line === 'email1.offer')?.painAbove).toContain(" / Talking to exporters, we hear that buyers leave pages they can't read.")
    expect(refs.find(r => r.line === 'email3.p2')?.painAbove).toBe('From what exporters tell us, free tools came first and buyers noticed the errors.')
    expect(refs.find(r => r.line === 'email1.pain')?.painAbove).toBeUndefined()
  })
  it('sees BOTH forms of a line that uses {for_whom}: the slot-free one and the one tier 2 ships', () => {
    // Only the slot_free form used to go. For a client whose offer uses {for_whom}, the
    // sentence a firm-fact prospect receives was never judged at all.
    const refs = lineRefsFor({ A: inventedVariants().A }, 'exporters')
    const text = (line: string) => refs.find(r => r.line === line)?.text
    expect(text('email1.offer')).toBe('We translate your pages and a native speaker checks each one, so your buyers can read your site.')
    expect(text('email1.offer.slotted')).toBe('We translate your pages and a native speaker checks each one, so [their customers] abroad can read your site.')
    expect(text('email1.offer.alt.slotted')).toContain('[their customers]')
    expect(text('email1.subject.slotted')).toBe('[their customers] abroad')
    // A line with no {for_whom} has one form, with the peer label filled in.
    expect(refs.filter(r => r.line.startsWith('email1.pain')).map(r => r.line)).toEqual(['email1.pain', 'email1.pain.alt'])
    expect(text('email1.pain')).toContain('When we chat to exporters, a lot of them say')
    // No placeholder ever reaches the judge.
    expect(refs.some(r => /\{[a-z_]+\}/.test(r.text))).toBe(false)
  })
})

describe('what the scope judge is TOLD about an offer', () => {
  // The only place the judge learns which pain an offer sits under and which outcome it
  // sells. A fake judge answers true whatever it is shown, so these read the text itself.
  const brief = inventedBrief()
  it('PLANTED: an offer carries the outcomes it cites, id and statement, when the brief is given', () => {
    const refs = lineRefsFor(inventedVariants(), 'exporters', brief)
    expect(refs.find(r => r.variant === 'A' && r.line === 'email1.offer')?.outcomes).toEqual([{ id: 'O1', statement: 'Buyers abroad can read your pages and buy.' }])
    expect(refs.find(r => r.variant === 'A' && r.line === 'email3.p2')?.outcomes).toEqual([{ id: 'O1', statement: 'Buyers abroad can read your pages and buy.' }])
    // Not on a line that is not an offer.
    expect(refs.find(r => r.variant === 'A' && r.line === 'email1.pain')?.outcomes).toBeUndefined()
  })
  it('PLANTED: the tag says the pain above and the outcome sold', () => {
    const refs = lineRefsFor(inventedVariants(), 'exporters', brief)
    const tagged = scopeLineTag(refs.find(r => r.variant === 'B' && r.line === 'email1.offer')!)
    expect(tagged).toContain('offer; the pain stated above it: "When we chat to exporters, many of them say a new market is slow to pick up.')
    expect(tagged).toContain('the outcome it sells: O1 "Buyers abroad can read your pages and buy."')
    expect(scopeLineTag(refs.find(r => r.variant === 'A' && r.line === 'email1.pain')!)).toBe('pain PA1')
  })
  it('PLANTED: the judge is told what "ambiguous" is NOT, in the words the code relies on', () => {
    // The first wording let the judge flag any loose phrase, and a variant spent its repair
    // rounds trading one flagged phrase for another until the run failed.
    for (const phrase of [
      'points at a PERSON, a GROUP or a THING without saying which one',
      'a general statement with one plain meaning',
      'plainly points at the line just before it IN THE SAME EMAIL',
      'When unsure, null.',
    ]) expect(SCOPE_JUDGE_SYSTEM_PROMPT).toContain(phrase)
  })

  it('PLANTED: the generator is told the same pointing words and question openers the validator refuses', () => {
    // The frame word list is stated to the writer word for word as the validator holds it:
    // a list the writer is not shown is a rule it can only meet by luck.
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain(`come from this list and no other: ${[...FRAME_WORDS].join(', ')}.`)
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('never "someone else", "other people", "elsewhere", or "others" on its own')
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('never one that opens "How about", "What about" or "Why not"')
  })

  it('PLANTED: the judge prompt and the tag use the same words for each part', () => {
    for (const phrase of ['the pain stated above it:', 'the outcome it sells:']) {
      expect(SCOPE_JUDGE_SYSTEM_PROMPT).toContain(phrase)
    }
    // And it is told an outcome may cover an offer's first sentence, which code accepts.
    expect(SCOPE_JUDGE_SYSTEM_PROMPT).toContain("is covered by that outcome: give the outcome's id")
  })
})

describe('the generator is told the same rules the judge and the validator hold', () => {
  it('PLANTED: no longer told to offer what the reader can "see or check"', () => {
    // The instruction that produced the transparency offer. It sat beside "the first
    // sentence says what the reader gets", and the judge failed exactly what it asked for.
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).not.toMatch(/what the reader can see or check/)
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).not.toMatch(/never say or hint what will happen to the reader's business/)
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('What never_claims forbids is the promise, not the outcome.')
    expect(SCOPE_JUDGE_SYSTEM_PROMPT).toContain('does not by itself state or imply a never_claims item')
  })
  it('PLANTED: the angle plan names the outcomes the neutral offer may lead with', () => {
    const brief = inventedBrief()
    const prompt = buildGenerationPrompt(brief, planAngles(brief), variantKeysFor(brief))
    expect(prompt).toContain('Its offer is the NEUTRAL line: offer_angle null. It leads with an outcome that answers every lead pain (PA1, PA2) and cites no other outcome: O1.')
  })
  it('the judge is sent the OUTCOMES block and each offer\'s tag', async () => {
    const seen: string[] = []
    const client = { messages: { create: async (params: { messages: Array<{ content: string }> }) => {
      seen.push(params.messages[0].content)
      const n = params.messages[0].content.split('## LINES\n')[1].split('\n').filter(l => /^\d+\. \[/.test(l)).length
      return { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify({ lines: Array.from({ length: n }, (_, i) => ({ n: i + 1, claims: [], proof_used: [], excludes: null, idiom: null, ambiguous: null, unnatural: null, fragment: false, slot_reads: true, sells_outcome: true, resolves_pain: true, asserts_about_reader: false, self_diagnosis: false, narrow_consequence: false, consequence_follows: true, question_matches: true })) }) }] }
    } } } as unknown as Anthropic
    const usage: Parameters<typeof runScopeJudge>[3] = []
    await runScopeJudge(client, inventedBrief(), { B: inventedVariants().B }, usage)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('## OUTCOMES\n[{"id":"O1","statement":"Buyers abroad can read your pages and buy."}')
    expect(seen[0]).toMatch(/\d+\. \[offer; the pain stated above it: "[^"]+"[^\]]*; the outcome it sells: O1 "[^"]+"\] \(email1\.offer\) We turn your key pages/)
    // Each line carries its own name, so the judge can see which lines are one email. An ask
    // now carries the pain above it too (question_matches, 2026-10-03).
    expect(seen[0]).toMatch(/\d+\. \[ask; the pain stated above it: "[^"]+"\] \(email2\.p3\) /)
    expect(SCOPE_JUDGE_SYSTEM_PROMPT).toContain('(email2.p3) is the third paragraph of Email 2, read straight after (email2.p2)')
  })
})

describe('toVariantLines', () => {
  const plan = { email1: 'PA1', email2: 'PA2', email3: 'PA3', neutralOffer: false }
  const line = (text: string) => ({ text, slots: [], slot_free: null, from: ['PA1'] })
  it('keeps a second wording and each paragraph\'s kind', () => {
    const v = toVariantLines({
      email1: { subject: line('s'), pain: { ...line('p'), alt: line('p2') }, offer: line('o'), question: line('q?'), offer_angle: 'a problem' },
      email2: [{ kind: 'pain', text: 'x', from: ['PA2'] }, { kind: 'ask', text: 'y?', from: ['PA2'] }],
      email3: [], email4: [],
    }, plan, 1)
    expect(v.email1.pain.alt?.text).toBe('p2')
    expect(v.email1.offer.alt).toBeUndefined()
    expect(v.followups[0].paragraphs.map(p => p.kind)).toEqual(['pain', 'ask'])
  })
  it('leaves an unknown kind undefined so the validator reports it, never guesses', () => {
    const v = toVariantLines({ email1: {}, email2: [{ kind: 'story', text: 'x', from: [] }], email3: [], email4: [] }, plan, 1)
    expect(v.followups[0].paragraphs[0].kind).toBeUndefined()
  })
  it('keeps a slot_free form only on a line that uses {for_whom}', () => {
    // A model that fills slot_free on a peer-group-only line has written a second version
    // of the line, and that version is what the stored body would ship.
    const v = toVariantLines({
      email1: {
        pain: { text: '{peer_group} often tell us x.', slots: ['peer_group'], slot_free: 'Firms always tell us x.', from: ['PA1'] },
        offer: { text: 'We do y for {for_whom}.', slots: ['for_whom'], slot_free: 'We do y for buyers.', from: ['D1'] },
      },
    }, plan, 1)
    expect(v.email1.pain.slot_free).toBeNull()
    expect(v.email1.offer.slot_free).toBe('We do y for buyers.')
  })
  it('makes a line one paragraph: a line break the model put inside it becomes a space', () => {
    const v = toVariantLines({
      email1: { question: { text: 'Buyers leave fast.\n\nIs that a problem?', slots: [], slot_free: null, from: ['PA1'] } },
      email2: [{ kind: 'ask', text: 'Growth slows.\n\nDoes that match?', from: ['PA2'] }],
    }, plan, 1)
    expect(v.email1.question.text).toBe('Buyers leave fast. Is that a problem?')
    expect(v.followups[0].paragraphs[0].text).toBe('Growth slows. Does that match?')
  })
  it('forces the neutral variant\'s offer_angle to null whatever the model wrote', () => {
    const v = toVariantLines({ email1: { offer_angle: 'something' } }, { ...plan, neutralOffer: true }, 1)
    expect(v.email1.offer_angle).toBeNull()
  })

  // ── The lead-in (2026-10-03) ──
  const LEAD_IN = { text: 'If {company} is seeing this too,', slots: ['company'], slot_free: "If you're seeing this too,", from: ['PA1'] }
  it('PLANTED: keeps the model\'s lead-in, with its slot_free form, and drops any second wording of it', () => {
    const v = toVariantLines({ email1: { lead_in: { ...LEAD_IN, alt: { ...LEAD_IN, text: 'If {company} sees this too,' } } } }, plan, 1)
    expect(v.email1.lead_in).toEqual(LEAD_IN)
    expect(v.email1.lead_in).not.toHaveProperty('alt')
  })
  it('an answer with no lead-in leaves none, so the validator says it is missing (control)', () => {
    const v = toVariantLines({ email1: { offer_angle: 'a problem' } }, plan, 1)
    expect(v.email1).not.toHaveProperty('lead_in')
  })
  it('PLANTED: a stored lead-in goes back to the model as it was, and a repair that leaves it out keeps it', () => {
    const raw = linesToRaw(inventedVariants().A)
    expect(raw.email1?.lead_in).toMatchObject({ text: 'If {company} is seeing this too,', slot_free: "If you're seeing this too," })
    const merged = mergeRepair(raw, { email1: { question: { text: 'Do buyers abroad leave?', slots: [], slot_free: null, from: ['PA1'] } } })
    expect(merged.email1?.lead_in).toEqual(raw.email1?.lead_in)
    // A repair that rewrites it is taken (control).
    const rewritten = mergeRepair(raw, { email1: { lead_in: { ...LEAD_IN, text: 'If {company} sees this too,', slot_free: 'If you see this too,' } } })
    expect(rewritten.email1?.lead_in?.text).toBe('If {company} sees this too,')
  })
  it('PLANTED: the writer is told the lead-in and the named source, and the JSON shape carries both', () => {
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('- lead_in: ONE clause that leads into the offer and names the reader\'s firm')
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('"lead_in":  { "text": "If {company} ...,", "slots": ["company"], "slot_free": "If you ...,"')
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('NAME THE SOURCE, CONVERSATIONALLY')
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('NEVER A FACELESS SOURCE')
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('"pain":     { "text": "When we chat to {peer_group}, ..."')
    // The withdrawn instruction is gone (control on the old wording).
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).not.toContain('pain: begins with {peer_group}')
  })
  it('PLANTED: the client\'s colloquialisms reach the writer from the brief, and an absent list is sent empty', () => {
    const brief = inventedBrief()
    brief.colloquialisms = ['no worries']
    expect(buildGenerationPrompt(brief, planAngles(brief), variantKeysFor(brief))).toMatch(/"colloquialisms": \[\s*"no worries"\s*\]/)
    const none = inventedBrief()
    delete none.colloquialisms
    expect(buildGenerationPrompt(none, planAngles(none), variantKeysFor(none))).toContain('"colloquialisms": []')
  })
})

describe('buildMessagingContent', () => {
  it('stores slot-free bodies, keeps the lines, replaces variants and keeps other sections', () => {
    const content = buildMessagingContent({
      base: { variants: { OLD: {} }, something_else: 1 },
      brief: inventedBrief(),
      result: { opener_frames: INVENTED_OPENER_FRAMES, variants: inventedVariants() },
      signoff: INVENTED_SIGNOFF,
      firmFactTierEnabled: false,
    }) as Record<string, any>
    expect(Object.keys(content.variants).sort()).toEqual(['A', 'B'])
    expect(content.something_else).toBe(1)
    expect(content.firm_fact_tier).toEqual({ enabled: false })
    const e1 = content.variants.A.emails[0]
    expect(e1.body).not.toMatch(/\{(does|for_whom|peer_group)\}/)
    expect(e1.body.startsWith('{{first_name}}\n\nWhen we chat to exporters, a lot of them say')).toBe(true)
    // The lead-in is stored in its slot-free form, joined in front of the offer (2026-10-03).
    expect(e1.body).toContain("\n\nIf you're seeing this too, we translate your pages")
    expect(content.variants.A.lines.email1.lead_in.text).toBe('If {company} is seeing this too,')
    expect(e1.body.endsWith('Sam\nQuillmere')).toBe(true)
    expect(content.variants.A.lines.email1.pain.text).toContain('{peer_group}')
    expect(content.variants.A.emails.map((e: any) => e.sequence_position)).toEqual([1, 2, 3, 4])
    // The offer-line selector (copy-writing a9044e5) reads the tag from Email 1.
    expect(content.variants.A.emails[0].offer_angle).toBe('buyers abroad leave pages they cannot read')
    expect(content.variants.B.emails[0].offer_angle).toBeNull()
    expect(content.variants.A.emails[1]).not.toHaveProperty('offer_angle')
    // The stored document still passes the validator it was built from.
    expect(validateTemplateDocument({
      brief: content.outbound_brief, opener_frames: content.opener_frames,
      variants: { A: content.variants.A.lines, B: content.variants.B.lines }, signoff: INVENTED_SIGNOFF,
    })).toEqual([])
  })
})

describe('parseModelJson', () => {
  it('finds the object when the prose before it holds slot braces', () => {
    expect(parseModelJson('Frames use {does} as asked.\n{"opener_frames":["Your site says {does}."]}'))
      .toEqual({ opener_frames: ['Your site says {does}.'] })
  })
  it('prefers a fenced block', () => {
    expect(parseModelJson('note {x}\n```json\n{"a":1}\n```\ntrailing }')).toEqual({ a: 1 })
  })
})

describe('mergeRepair', () => {
  const prev = linesToRaw(inventedVariants().A)
  it('keeps every line a repair answer leaves out', () => {
    // "Rewrite ONLY what failed": a model that obeys returns one line. Taken as the whole
    // variant, that answer wiped every line that had passed.
    const merged = mergeRepair(prev, { email1: { question: { text: 'Do buyers abroad leave?', slots: [], slot_free: null, from: ['PA1'] } } })
    expect(merged.email1?.question?.text).toBe('Do buyers abroad leave?')
    expect(merged.email1?.pain).toEqual(prev.email1?.pain)
    expect(merged.email1?.offer_angle).toBe(prev.email1?.offer_angle)
    expect(merged.email2).toEqual(prev.email2)
    const lines = toVariantLines(merged, { email1: 'PA1', email2: 'PA2', email3: 'PA3', neutralOffer: false }, 1)
    expect(lines.followups.map(f => f.paragraphs.length)).toEqual([3, 3, 2])
  })
  it('merges per WORDING: an answer with only the alternate replaces only the alternate', () => {
    const alt = { text: 'Do buyers abroad give up on your pages?', slots: [], slot_free: null, from: ['PA1'] }
    const merged = mergeRepair(prev, { email1: { question: { alt } } })
    expect(merged.email1?.question?.alt).toEqual(alt)
    expect(merged.email1?.question?.text).toBe(prev.email1?.question?.text)
  })
  it('merges per WORDING: an answer with only the first wording keeps the alternate that passed', () => {
    const merged = mergeRepair(prev, { email1: { question: { text: 'Do buyers abroad give up?', slots: [], slot_free: null, from: ['PA1'] } } })
    expect(merged.email1?.question?.text).toBe('Do buyers abroad give up?')
    expect(merged.email1?.question?.alt).toEqual(prev.email1?.question?.alt)
    // ...and an explicit null alt does not delete it either: the line needs two wordings.
    const nulled = mergeRepair(prev, { email1: { question: { text: 'Do buyers abroad give up?', slots: [], slot_free: null, from: ['PA1'], alt: null } } })
    expect(nulled.email1?.question?.alt).toEqual(prev.email1?.question?.alt)
  })
  it('keeps an email whose repair came back as plain strings, which hold no paragraph', () => {
    const merged = mergeRepair(prev, { email2: ['A string where an object belongs.'] })
    expect(merged.email2).toEqual(prev.email2)
  })
  it('takes a repaired email that is usable (control)', () => {
    const email4 = [{ kind: 'close', text: 'This is my last note.', from: ['PA1'] }]
    expect(mergeRepair(prev, { email4 }).email4).toEqual(email4)
  })
})

describe('email1WordBudget, held against the validator it predicts', () => {
  const brief = inventedBrief()
  it('computes the budget from the brief and the sign-off', () => {
    // 85 word ceiling (75 until 2026-10-02), less greeting 1, opener 15, sign-off 2, a
    // four-word label (3 more than the one word a slot counts as) and a five-word customer
    // group (4 more).
    // The lead-in (2026-10-03) is counted with the lines, in the form the template is checked
    // in, its slot-free one: a long name is held at composition, not here.
    expect(email1WordBudget(brief, INVENTED_SIGNOFF)).toEqual({ min: 39, max: 60 })
  })
  it('a longer sign-off and no {for_whom} move it', () => {
    const noForWhom = { ...brief, slot_policy: { for_whom_in_offer: false, source: 'invented' } }
    expect(email1WordBudget(noForWhom, { firstName: 'Sam', companyName: 'Quillmere Translation House' })).toEqual({ min: 37, max: 62 })
  })
  it('the maximum passes the word band and one word more does not (the pair, not each side)', () => {
    const { max } = email1WordBudget(brief, INVENTED_SIGNOFF)
    const own = (v: ReturnType<typeof inventedVariants>['A']) =>
      [v.email1.pain.text, v.email1.lead_in?.slot_free ?? '', v.email1.offer.text, v.email1.question.text].join(' ').trim().split(/\s+/).length
    const bandRules = (extra: number) => {
      const variants = inventedVariants()
      // One wording per line, so there is exactly one combination to measure.
      for (const key of ['pain', 'offer', 'question'] as const) delete variants.A.email1[key].alt
      const pad = max - own(variants.A) + extra
      variants.A.email1.question.text = `Is losing orders from other countries ${'really '.repeat(pad)}a problem right now?`
      expect(own(variants.A)).toBe(max + extra)
      return validateTemplateDocument({ brief, opener_frames: INVENTED_OPENER_FRAMES, variants, signoff: INVENTED_SIGNOFF })
        .filter(v => v.variant === 'A' && v.rule === 'word_band')
    }
    expect(bandRules(0)).toEqual([])
    expect(bandRules(1).length).toBeGreaterThan(0)
  })
})

// ─── The run loop, against a fake model ──────────────────────────────────────

interface FakeCall { kind: 'generation' | 'repair' | 'judge' | 'label'; user: string }

/**
 * Answers exactly the three prompts the agent sends, and throws on any other system prompt
 * or any other client method, so a new call path cannot pass silently.
 */
function fakeModel(opts: {
  generation?: (call: FakeCall, n: number) => unknown
  judge?: (lineCount: number, n: number, user: string) => string
  label?: unknown
} = {}) {
  const calls: FakeCall[] = []
  const fixture = () => ({
    opener_frames: INVENTED_OPENER_FRAMES,
    variants: Object.fromEntries(Object.entries(inventedVariants()).map(([k, v]) => [k, linesToRaw(v)])),
  })
  const cleanJudge = (lineCount: number) => JSON.stringify({
    lines: Array.from({ length: lineCount }, (_, i) => ({
      n: i + 1, claims: [], proof_used: [], excludes: null, idiom: null, ambiguous: null, unnatural: null, fragment: false, slot_reads: true, sells_outcome: true, resolves_pain: true, asserts_about_reader: false, self_diagnosis: false, narrow_consequence: false, consequence_follows: true, question_matches: true,
    })),
  })
  const reply = (text: string) => ({ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text }] })
  const streamed: string[] = []
  const client = {
    messages: {
      create: async (params: { system: string; messages: Array<{ content: string }> }) => {
        const user = params.messages[0].content
        if (params.system === PEER_LABEL_JUDGE_SYSTEM_PROMPT) {
          calls.push({ kind: 'label', user })
          return reply(JSON.stringify(opts.label ?? { excludes: null, why: '' }))
        }
        if (params.system === SCOPE_JUDGE_SYSTEM_PROMPT) {
          calls.push({ kind: 'judge', user })
          const lineCount = user.split('## LINES\n')[1].split('\n').filter(l => /^\d+\. \[/.test(l)).length
          const n = calls.filter(c => c.kind === 'judge').length
          return reply(opts.judge ? opts.judge(lineCount, n, user) : cleanJudge(lineCount))
        }
        if (params.system === OUTBOUND_TEMPLATE_SYSTEM_PROMPT) {
          const call: FakeCall = { kind: user.includes('YOUR PREVIOUS ATTEMPT FAILED') ? 'repair' : 'generation', user }
          calls.push(call)
          const n = calls.filter(c => c.kind === call.kind).length
          return reply(JSON.stringify(opts.generation ? opts.generation(call, n) : fixture()))
        }
        throw new Error('fake model: unexpected system prompt')
      },
      // The generator's calls are streamed. The fake answers them through the same create,
      // and marks the call, so a test can see which calls were streamed.
      stream: (params: { system: string; messages: Array<{ content: string }> }) => {
        streamed.push(params.system)
        return { finalMessage: () => client.messages.create(params) }
      },
    },
  }
  const proxied = new Proxy(client, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof typeof target]
      throw new Error(`fake model does not implement ${String(prop)}`)
    },
  }) as unknown as Anthropic
  return { client: proxied, calls, fixture, cleanJudge, streamed }
}

const runAgent = (fake: ReturnType<typeof fakeModel>, extra: Partial<Parameters<typeof generateOutboundTemplates>[0]> = {}) =>
  generateOutboundTemplates({ brief: inventedBrief(), signoff: INVENTED_SIGNOFF, apiKey: 'unused', client: fake.client, ...extra })

const failure = async (run: Promise<unknown>): Promise<OutboundTemplateFailure> => {
  try {
    await run
  } catch (err) {
    expect(err).toBeInstanceOf(OutboundTemplateFailure)
    return err as OutboundTemplateFailure
  }
  throw new Error('expected the run to fail')
}

describe('how each call is made', () => {
  it('PLANTED: the generator is streamed and neither thinks nor sets a temperature; the judges are plain and pinned at 0', async () => {
    // Measured on a real brief, 2026-10-01: with thinking on (adaptive, and then with a
    // budget the model did not honour) the generator spent whole calls thinking and wrote
    // nothing. Sent as one plain request, a call that long was dropped as idle.
    const seen: Array<{ system: string; thinking?: unknown; temperature?: unknown; max_tokens: number; how: 'create' | 'stream' }> = []
    const fake = fakeModel()
    const real = fake.client as unknown as { messages: { create: (p: never) => Promise<unknown>; stream: (p: never) => { finalMessage: () => Promise<unknown> } } }
    type Params = { system: string; thinking?: unknown; temperature?: unknown; max_tokens: number }
    const note = (params: Params, how: 'create' | 'stream') => seen.push({ system: params.system, thinking: params.thinking, temperature: params.temperature, max_tokens: params.max_tokens, how })
    const recording = { messages: {
      create: (params: Params) => { note(params, 'create'); return real.messages.create(params as never) },
      stream: (params: Params) => { note(params, 'stream'); return real.messages.stream(params as never) },
    } } as unknown as Anthropic
    await generateOutboundTemplates({ brief: inventedBrief(), signoff: INVENTED_SIGNOFF, apiKey: 'unused', client: recording })
    const generation = seen.filter(c => c.system === OUTBOUND_TEMPLATE_SYSTEM_PROMPT)
    const judges = seen.filter(c => c.system !== OUTBOUND_TEMPLATE_SYSTEM_PROMPT)
    expect(generation.length).toBeGreaterThan(0)
    expect(judges.length).toBeGreaterThan(0)
    for (const call of generation) {
      expect(call.thinking).toBeUndefined()
      expect(call.temperature).toBeUndefined()
      expect(call.how).toBe('stream')
    }
    for (const call of judges) {
      expect(call.thinking).toBeUndefined()
      expect(call.temperature).toBe(0)
      expect(call.how).toBe('create')
    }
  })

  it('PLANTED: the generator is told that code does the checking, so it writes one attempt', () => {
    // With some forty rules to satisfy the model checked its own draft in the answer and
    // was cut off before the JSON.
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('Write ONE honest attempt and stop.')
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('do not check your own work in the answer')
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('The answer is ONLY a JSON object, starting with "{"')
  })
})

describe('generateOutboundTemplates (the run loop)', () => {
  it('passes a clean document: one label check, one generation and one judge call PER VARIANT (the control)', async () => {
    const fake = fakeModel()
    const result = await runAgent(fake)
    expect(Object.keys(result.variants).sort()).toEqual(['A', 'B'])
    expect(result.dropped).toEqual({})
    expect(fake.calls.map(c => c.kind)).toEqual(['label', 'generation', 'generation', 'judge', 'judge'])
    // Both variants went to the judge, in every wording and form, EACH IN ITS OWN CALL.
    expect(fake.calls[3].user).toContain('so [their customers] abroad can read your site.')
    const linesIn = (user: string) => user.split('## LINES\n')[1].split('\n').filter(l => /^\d+\. \[/.test(l)).length
    expect(linesIn(fake.calls[3].user)).toBe(lineRefsFor({ A: inventedVariants().A }, 'exporters').length)
    expect(linesIn(fake.calls[4].user)).toBe(lineRefsFor({ B: inventedVariants().B }, 'exporters').length)
    // The result reports the calls actually made: label, two generation, two judge calls.
    expect(result.calls).toBe(5)
  })

  it('PLANTED: each variant is written in its own call, and the second is told what the first holds', async () => {
    // Asked for every variant at once the answer outgrew its limit before it was written.
    // And a variant written blind cannot avoid a sentence another variant already uses,
    // which code refuses.
    const fake = fakeModel()
    await runAgent(fake)
    const [first, second] = fake.calls.filter(c => c.kind === 'generation').map(c => c.user)
    expect(first).toContain('Write opener frames and variants A.')
    expect(first).not.toContain('ALREADY WRITTEN IN OTHER VARIANTS')
    expect(second).toContain('Write variant B only. The opener frames are already written: return "opener_frames": [].')
    expect(second).toContain('## ALREADY WRITTEN IN OTHER VARIANTS (use none of these sentences or subjects again)')
    // A's Email 1 lines, both wordings, as the model wrote them (slots and all).
    expect(second).toContain(JSON.stringify(inventedVariants().A.email1.pain.text))
    expect(second).toContain(JSON.stringify(inventedVariants().A.email1.offer.alt!.text))
    expect(second).toContain(JSON.stringify(inventedVariants().A.email1.subject.text))
    // B's own lines are not in its own "already written" list.
    expect(second.split('## ALREADY WRITTEN')[1]).not.toContain(inventedVariants().B.email1.question.text)
  })

  it('PLANTED: an unusable answer for ONE variant leaves that variant unjudged, and the other passes its own read', async () => {
    // All variants used to share one judge call, so one cut-off answer failed every variant.
    // The first judge call is A\'s; it never gives a usable answer. B\'s is clean.
    const fake = fakeModel({
      judge: (lineCount, _n, user) => user.includes(inventedVariants().A.email1.pain.text.replace('{peer_group}', 'exporters'))
        ? 'I could not complete the review.'
        : fakeModel().cleanJudge(lineCount),
    })
    const err = await failure(runAgent(fake))
    expect(err.message).toContain('1 of 2 variants passed')
    expect(Object.keys(err.attempt.dropped)).toEqual(['A'])
    expect(err.attempt.dropped.A).toEqual(['the scope judge did not clear the final wording'])
  })

  it('stops before writing anything when the default peer label wrongly describes an in-scope buyer (rule 7)', async () => {
    const fake = fakeModel({ label: { excludes: 'X1', why: 'the label names a narrower group' } })
    await expect(runAgent(fake)).rejects.toThrow(/default peer label "exporters" wrongly describes in-scope buyer X1/)
    expect(fake.calls.map(c => c.kind)).toEqual(['label'])
  })

  it('treats a label judge answer with no verdict as no pass', async () => {
    const fake = fakeModel({ label: { why: 'no excludes key at all' } })
    await expect(runAgent(fake)).rejects.toThrow(/peer label judge gave no verdict/)
    expect(fake.calls.map(c => c.kind)).toEqual(['label'])
  })

  it('fails the run unless EVERY planned variant passes, and keeps the attempt (rule 6)', async () => {
    // B never arrives. Three of four used to be enough; now one variant per lead angle.
    const fake = fakeModel({
      generation: () => {
        const answer = fakeModel().fixture()
        return { opener_frames: answer.opener_frames, variants: { A: answer.variants.A } }
      },
    })
    const err = await failure(runAgent(fake))
    expect(err.message).toContain('1 of 2 variants passed')
    expect(Object.keys(err.attempt.dropped)).toEqual(['B'])
    // The variant that passed is in the attempt, so the next run can keep it.
    expect(err.attempt.variants.A.email1.pain.text).toBe(inventedVariants().A.email1.pain.text)
  })

  it('never passes a variant the judge did not clear: an unusable judge answer is not a pass', async () => {
    // Not JSON at all. This used to throw out of the run after the writing was paid for.
    const fake = fakeModel({ judge: () => 'I could not complete the review.' })
    const err = await failure(runAgent(fake))
    expect(err.attempt.dropped.A).toEqual(['the scope judge did not clear the final wording'])
    expect(err.attempt.dropped.B).toEqual(['the scope judge did not clear the final wording'])
    expect(Object.keys(err.attempt.variants).sort()).toEqual(['A', 'B'])   // the wording survives
    // No repair was bought for a judge that failed to answer.
    expect(fake.calls.filter(c => c.kind === 'repair')).toEqual([])
    // Two rounds of judging (the loop, then the final read), one call per variant in each.
    expect(fake.calls.filter(c => c.kind === 'judge').length).toBe(4)
  })

  // Line 1 of the judge's list is variant A's subject, in its slot-free form.
  const flagFirstLineOnce = (lineCount: number, n: number) => {
    const lines = JSON.parse(fakeModel().cleanJudge(lineCount)).lines
    if (n === 1) lines[0].excludes = 'X1'
    return JSON.stringify({ lines })
  }
  const withNewSubject = () => {
    const answer = fakeModel().fixture()
    answer.variants.A.email1!.subject = { ...answer.variants.A.email1!.subject!, slot_free: 'buyers in other countries' }
    return answer
  }

  it('judges a repaired variant again, and only that variant', async () => {
    const fake = fakeModel({ judge: flagFirstLineOnce, generation: call => (call.kind === 'repair' ? withNewSubject() : fakeModel().fixture()) })
    const result = await runAgent(fake)
    expect(Object.keys(result.variants).sort()).toEqual(['A', 'B'])
    expect(result.variants.A.email1.subject.slot_free).toBe('buyers in other countries')
    // One judge call per variant, then the repair, then ONE more: A alone.
    expect(fake.calls.map(c => c.kind)).toEqual(['label', 'generation', 'generation', 'judge', 'judge', 'repair', 'judge'])
    // The repair is told what failed, for A only...
    expect(fake.calls[5].user).toContain('excludes in-scope buyer X1')
    // ONE variant, the frames left alone, and told what the other variant already holds.
    expect(fake.calls[5].user).toContain('Write variant A only. The opener frames are already written')
    expect(fake.calls[5].user).toContain(JSON.stringify(inventedVariants().B.email1.pain.text))
    // ...and the judge call after it holds A's lines only: B was already cleared.
    const aOnly = lineRefsFor({ A: inventedVariants().A }, 'exporters').length
    const second = fake.calls[6].user.split('## LINES\n')[1].split('\n').filter(l => /^\d+\. \[/.test(l)).length
    expect(second).toBe(aOnly)
    expect(fake.calls[6].user).toContain('buyers in other countries')
  })

  it('PLANTED: a variant that will not generate does not take the ones already written with it', async () => {
    // Each variant is its own paid call. The second failing must leave the first in the
    // attempt the caller saves, with the command to keep it.
    let generationCalls = 0
    const fake = fakeModel({ generation: () => {
      generationCalls++
      if (generationCalls >= 2) throw new Error('the provider went away')
      return fakeModel().fixture()
    } })
    const err = await failure(runAgent(fake))
    expect(err.message).toContain('generating variant B failed')
    expect(err.message).toContain('the provider went away')
    expect(Object.keys(err.attempt.variants)).toEqual(['A'])
    expect(err.attempt.variants.A.email1.pain.text).toBe(inventedVariants().A.email1.pain.text)
    expect(err.attempt.opener_frames).toEqual(INVENTED_OPENER_FRAMES)
    expect(err.attempt.dropped).toEqual({ B: ['not written: the generation call for this variant failed'] })
  })

  it('PLANTED: two failing variants are repaired in two calls, one variant each', async () => {
    // Asked to repair two variants at once the model checked both in its answer and was
    // cut off before the JSON, which cost the round and the call.
    const flagBothOnce = (lineCount: number, n: number) => {
      const lines = JSON.parse(fakeModel().cleanJudge(lineCount)).lines
      if (n <= 2) lines[0].excludes = 'X1'
      return JSON.stringify({ lines })
    }
    const reworded = () => {
      const answer = fakeModel().fixture()
      answer.variants.A.email1!.subject = { ...answer.variants.A.email1!.subject!, slot_free: 'buyers in other countries' }
      answer.variants.B.email1!.subject = { ...answer.variants.B.email1!.subject!, text: 'markets abroad' }
      return answer
    }
    const fake = fakeModel({ judge: flagBothOnce, generation: call => (call.kind === 'repair' ? reworded() : fakeModel().fixture()) })
    await runAgent(fake)
    const repairs = fake.calls.filter(c => c.kind === 'repair').map(c => c.user)
    expect(repairs).toHaveLength(2)
    // BOTH in the same round: the two repairs come before either variant is judged again.
    // One a round would also be two calls, and would take a round longer for each variant.
    expect(fake.calls.map(c => c.kind)).toEqual(['label', 'generation', 'generation', 'judge', 'judge', 'repair', 'repair', 'judge', 'judge'])
    expect(repairs[0]).toContain('Write variant A only.')
    expect(repairs[0]).not.toContain('Variant B, previous attempt')
    expect(repairs[1]).toContain('Write variant B only.')
    expect(repairs[1]).not.toContain('Variant A, previous attempt')
  })

  it('a finding stands until its line changes: the same wording is never read a second time', async () => {
    // The repair returns the variant word for word. Cleared whenever the answer merely
    // contained the variant, the rejected line went back to the judge unchanged, in
    // different company, and could pass on the second read.
    const fake = fakeModel({ judge: flagFirstLineOnce })
    const err = await failure(runAgent(fake))
    expect(err.attempt.dropped.A.join(' ')).toContain('excludes in-scope buyer X1 (not changed by the last repair)')
    // Each variant judged once. Every later round repaired A again and never re-read the same line.
    expect(fake.calls.filter(c => c.kind === 'judge')).toHaveLength(2)
    expect(fake.calls.filter(c => c.kind === 'repair').length).toBeGreaterThan(1)
  })

  it('lays a partial repair answer over the previous wording', async () => {
    const questionLine = lineRefsFor(inventedVariants(), 'exporters').findIndex(r => r.variant === 'A' && r.line === 'email1.question')
    const fake = fakeModel({
      judge: (lineCount, n) => {
        const lines = JSON.parse(fakeModel().cleanJudge(lineCount)).lines
        if (n === 1) lines[questionLine].excludes = 'X1'
        return JSON.stringify({ lines })
      },
      generation: (call) => call.kind === 'repair'
        ? { variants: { A: { email1: { question: { text: 'Are orders from other countries lower than you want?', slots: [], slot_free: null, from: ['PA1'] } } } } }
        : fakeModel().fixture(),
    })
    const result = await runAgent(fake)
    expect(result.variants.A.email1.question.text).toBe('Are orders from other countries lower than you want?')
    expect(result.variants.A.email1.question.alt?.text).toBe(inventedVariants().A.email1.question.alt!.text)
    expect(result.variants.A.email1.pain.text).toBe(inventedVariants().A.email1.pain.text)
    expect(result.variants.A.followups.map(f => f.paragraphs.length)).toEqual([3, 3, 2])
  })

  it('re-judges a kept variant and writes only the others', async () => {
    const fake = fakeModel()
    const result = await runAgent(fake, { keep: { opener_frames: [...INVENTED_OPENER_FRAMES], variants: { A: inventedVariants().A } } })
    expect(Object.keys(result.variants).sort()).toEqual(['A', 'B'])
    // The frames are kept, and B is told what the kept variant already holds.
    expect(fake.calls[1].user).toContain('Write variant B only. The opener frames are already written')
    expect(fake.calls[1].user).toContain(JSON.stringify(inventedVariants().A.email1.pain.text))
    expect(fake.calls.filter(c => c.kind === 'generation')).toHaveLength(1)
    // BOTH variants are judged: a kept variant passed last time's judge, not this one's.
    const both = lineRefsFor(inventedVariants(), 'exporters').length
    const judged = fake.calls.filter(c => c.kind === 'judge')
      .map(c => c.user.split('## LINES\n')[1].split('\n').filter(l => /^\d+\. \[/.test(l)).length)
    expect(judged).toHaveLength(2)
    expect(judged.reduce((a, b) => a + b, 0)).toBe(both)
  })

  it('PLANTED: a kept variant must match the plan\'s NEUTRAL line as well as its angle', async () => {
    // A kept variant is copied in as it stands, so nothing downstream sets its offer_angle.
    // Move the neutral line (the brief's first answers swap, as on 2026-10-01) and a variant
    // saved under the old plan would leave the document with no neutral line, or with it
    // on a variant the plan no longer names. The validator holds only "at most one".
    const moved = inventedBrief()
    moved.pain_angles[0].resolved_by = ['O1', 'O3']
    moved.pain_angles[1].resolved_by = ['O2', 'O1']
    expect(neutralVariantIndex(moved)).toBe(0)
    const saved = inventedVariants()
    expect(saved.A.email1.offer_angle).not.toBeNull()   // A was written as a tagged line
    expect(saved.B.email1.offer_angle).toBeNull()       // and B as the neutral one
    const keepA = runAgent(fakeModel(), { brief: moved, keep: { opener_frames: [...INVENTED_OPENER_FRAMES], variants: { A: saved.A } } })
    await expect(keepA).rejects.toThrow(/kept variant A carries a tagged offer line, and the plan now gives the neutral line to A/)
    const keepB = runAgent(fakeModel(), { brief: moved, keep: { opener_frames: [...INVENTED_OPENER_FRAMES], variants: { B: saved.B } } })
    await expect(keepB).rejects.toThrow(/kept variant B carries the neutral offer line, and the plan now gives a tagged line to B/)
    // Control: under the plan it was written for, the same kept variant is accepted.
    const result = await runAgent(fakeModel(), { keep: { opener_frames: [...INVENTED_OPENER_FRAMES], variants: { B: saved.B } } })
    expect(result.variants.B.email1.offer_angle).toBeNull()
  })

  it('carries the wording out when a later call throws', async () => {
    let judgeCalls = 0
    const fake = fakeModel({
      judge: (lineCount) => {
        judgeCalls++
        const lines = JSON.parse(fakeModel().cleanJudge(lineCount)).lines
        lines[0].excludes = 'X1'
        return JSON.stringify({ lines })
      },
      generation: (call) => {
        if (call.kind === 'repair') throw new Error('the API went away')
        return fakeModel().fixture()
      },
    })
    const err = await failure(runAgent(fake))
    expect(err.message).toContain('the API went away')
    expect(Object.keys(err.attempt.variants).sort()).toEqual(['A', 'B'])
    // One round of judging, one call per variant, before the repair that threw.
    expect(judgeCalls).toBe(2)
  })
})

describe('judgePeerDefaultLabel', () => {
  it('asks about the default label and the buyers that must not be excluded', async () => {
    const fake = fakeModel()
    const usage: Array<{ model: string; input_tokens: number; output_tokens: number }> = []
    expect(await judgePeerDefaultLabel(fake.client, inventedBrief(), usage)).toEqual({ excludes: null, why: '' })
    expect(fake.calls[0].user).toContain('## LABEL\nexporters')
    expect(fake.calls[0].user).toContain('"X2"')
    expect(usage).toHaveLength(1)
  })
  it('makes no call for a brief that lists no buyer to exclude', async () => {
    const fake = fakeModel()
    const brief = { ...inventedBrief(), must_not_exclude: [] }
    expect((await judgePeerDefaultLabel(fake.client, brief, [])).excludes).toBeNull()
    expect(fake.calls).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE OPERATOR'S SPEND RULES (2026-10-02): "cap per run (default $3), reuse stored
// results, Sonnet for drafts."
//
// Two inputs of the run carry them: `model`, which chooses who WRITES, and `maxUsd`, which
// stops the paying. Both are proved here against the fake client. No model is called.
//
// Imported here, beside the tests that use them, so everything above this line stands
// exactly as it was.

import {
  OUTBOUND_SCOPE_JUDGE_MODEL,
  OUTBOUND_TEMPLATE_DRAFT_MODEL,
  OUTBOUND_TEMPLATE_MODEL,
  templateRunCostUsd,
} from '../outbound-template-agent'
import { usdForTokens } from '@/lib/agents/research/cost-constants'

/**
 * THE FAKE DOES NOT RECORD THE MODEL: its calls hold the kind and the user message. So the
 * model of each call is read the way the "thinking" test above reads a call's settings: a
 * thin client in front of the fake that notes the params and passes them on unchanged.
 */
function seeingModels(fake: ReturnType<typeof fakeModel>) {
  type Params = { system: string; model: string; messages: Array<{ content: string }> }
  const seen: Array<{ kind: 'generation' | 'repair' | 'judge' | 'label'; model: string }> = []
  const real = fake.client as unknown as { messages: { create: (p: never) => Promise<unknown>; stream: (p: never) => { finalMessage: () => Promise<unknown> } } }
  const note = (params: Params) => {
    const kind = params.system === OUTBOUND_TEMPLATE_SYSTEM_PROMPT
      ? (params.messages[0].content.includes('YOUR PREVIOUS ATTEMPT FAILED') ? 'repair' as const : 'generation' as const)
      : (params.system === PEER_LABEL_JUDGE_SYSTEM_PROMPT ? 'label' as const : 'judge' as const)
    seen.push({ kind, model: params.model })
  }
  const client = { messages: {
    create: (params: Params) => { note(params); return real.messages.create(params as never) },
    stream: (params: Params) => { note(params); return real.messages.stream(params as never) },
  } } as unknown as Anthropic
  const models = (...kinds: string[]) => seen.filter(c => kinds.includes(c.kind)).map(c => c.model)
  return { client, seen, models }
}

/** A run that needs ONE repair: the judge refuses variant A's subject on its first read, and the repair rewords it. */
function fakeNeedingOneRepair() {
  return fakeModel({
    judge: (lineCount, n) => {
      const lines = JSON.parse(fakeModel().cleanJudge(lineCount)).lines
      if (n === 1) lines[0].excludes = 'X1'
      return JSON.stringify({ lines })
    },
    generation: call => {
      const answer = fakeModel().fixture()
      if (call.kind === 'repair') answer.variants.A.email1!.subject = { ...answer.variants.A.email1!.subject!, slot_free: 'buyers in other countries' }
      return answer
    },
  })
}

describe('the writer model: chosen per run, recorded on the result, and never the judges\' (spend rule: Sonnet for drafts)', () => {
  it('the three model names can be told apart where these tests need them to be (control)', () => {
    // The draft writer and the judge are the same model today. So "the judges did not follow
    // the writer" cannot be read off a draft run alone: an invented writer name proves it below.
    expect(OUTBOUND_TEMPLATE_DRAFT_MODEL).not.toBe(OUTBOUND_TEMPLATE_MODEL)
    expect(OUTBOUND_SCOPE_JUDGE_MODEL).not.toBe(OUTBOUND_TEMPLATE_MODEL)
  })

  it('PLANTED: by default every generation and repair call is made with the document model, and the result says so', async () => {
    const fake = fakeNeedingOneRepair()
    const watch = seeingModels(fake)
    const result = await runAgent(fake, { client: watch.client })
    // The run really held all three kinds of call: two written, one repaired, the rest judged.
    expect(watch.seen.map(c => c.kind)).toEqual(['label', 'generation', 'generation', 'judge', 'judge', 'repair', 'judge'])
    expect(watch.models('generation', 'repair')).toEqual([OUTBOUND_TEMPLATE_MODEL, OUTBOUND_TEMPLATE_MODEL, OUTBOUND_TEMPLATE_MODEL])
    expect(new Set(watch.models('label', 'judge'))).toEqual(new Set([OUTBOUND_SCOPE_JUDGE_MODEL]))
    expect(result.model).toBe(OUTBOUND_TEMPLATE_MODEL)
  })

  it('PLANTED: a draft run writes AND repairs with the draft model, the judges keep theirs, and the result says the draft model', async () => {
    const fake = fakeNeedingOneRepair()
    const watch = seeingModels(fake)
    const result = await runAgent(fake, { client: watch.client, model: OUTBOUND_TEMPLATE_DRAFT_MODEL })
    expect(watch.seen.map(c => c.kind)).toEqual(['label', 'generation', 'generation', 'judge', 'judge', 'repair', 'judge'])
    expect(watch.models('generation', 'repair')).toEqual([OUTBOUND_TEMPLATE_DRAFT_MODEL, OUTBOUND_TEMPLATE_DRAFT_MODEL, OUTBOUND_TEMPLATE_DRAFT_MODEL])
    expect(new Set(watch.models('label', 'judge'))).toEqual(new Set([OUTBOUND_SCOPE_JUDGE_MODEL]))
    expect(result.model).toBe(OUTBOUND_TEMPLATE_DRAFT_MODEL)
    // A draft is held to the same checks: the same document comes out of it.
    expect(Object.keys(result.variants).sort()).toEqual(['A', 'B'])
    expect(result.dropped).toEqual({})
  })

  it('PLANTED: the judges do not follow the writer: a writer of any other name leaves them on the judge model', async () => {
    const WRITER = 'vantor-writer-1'   // invented: no such model
    const fake = fakeNeedingOneRepair()
    const watch = seeingModels(fake)
    const result = await runAgent(fake, { client: watch.client, model: WRITER })
    expect(watch.models('generation', 'repair')).toEqual([WRITER, WRITER, WRITER])
    expect(watch.models('label', 'judge')).toEqual([OUTBOUND_SCOPE_JUDGE_MODEL, OUTBOUND_SCOPE_JUDGE_MODEL, OUTBOUND_SCOPE_JUDGE_MODEL, OUTBOUND_SCOPE_JUDGE_MODEL])
    expect(result.model).toBe(WRITER)
  })

  it('PLANTED: each call is recorded against the model that made it, which is what the spend is priced from', async () => {
    const result = await runAgent(fakeModel(), { model: OUTBOUND_TEMPLATE_DRAFT_MODEL })
    const byDefault = await runAgent(fakeModel())
    // label, two written, two judged.
    expect(byDefault.usage.map(u => u.model)).toEqual([
      OUTBOUND_SCOPE_JUDGE_MODEL, OUTBOUND_TEMPLATE_MODEL, OUTBOUND_TEMPLATE_MODEL, OUTBOUND_SCOPE_JUDGE_MODEL, OUTBOUND_SCOPE_JUDGE_MODEL,
    ])
    expect(result.usage.map(u => u.model)).toEqual([
      OUTBOUND_SCOPE_JUDGE_MODEL, OUTBOUND_TEMPLATE_DRAFT_MODEL, OUTBOUND_TEMPLATE_DRAFT_MODEL, OUTBOUND_SCOPE_JUDGE_MODEL, OUTBOUND_SCOPE_JUDGE_MODEL,
    ])
    // The point of a draft: the same calls cost less.
    expect(templateRunCostUsd(result.usage)).toBeLessThan(templateRunCostUsd(byDefault.usage))
  })
})

describe('templateRunCostUsd: what a run cost, from the shared price table', () => {
  const written = { model: OUTBOUND_TEMPLATE_MODEL, input_tokens: 12_000, output_tokens: 3_000 }
  const judged = { model: OUTBOUND_SCOPE_JUDGE_MODEL, input_tokens: 8_000, output_tokens: 2_000 }

  it('PLANTED: it is the sum of each call at ITS OWN model\'s price, as the shared table gives it', () => {
    // Held against usdForTokens and never against a figure typed here, so a price change in
    // the table moves both sides together.
    expect(templateRunCostUsd([written, judged])).toBeCloseTo(usdForTokens(written, written.model) + usdForTokens(judged, judged.model), 12)
    expect(templateRunCostUsd([written])).toBeCloseTo(usdForTokens(written, OUTBOUND_TEMPLATE_MODEL), 12)
    // The same tokens on the judge model are a different price: one rate for every call would fail here.
    const sameTokensJudged = { ...written, model: OUTBOUND_SCOPE_JUDGE_MODEL }
    expect(usdForTokens(written, written.model)).not.toBe(usdForTokens(sameTokensJudged, sameTokensJudged.model))
    expect(templateRunCostUsd([sameTokensJudged])).toBeCloseTo(usdForTokens(sameTokensJudged, OUTBOUND_SCOPE_JUDGE_MODEL), 12)
    expect(templateRunCostUsd([written])).not.toBeCloseTo(templateRunCostUsd([sameTokensJudged]), 6)
  })
  it('a run that made no call cost nothing (control)', () => {
    expect(templateRunCostUsd([])).toBe(0)
  })
  it('a call costs something: the price table knows both models (control)', () => {
    expect(templateRunCostUsd([written])).toBeGreaterThan(0)
    expect(templateRunCostUsd([judged])).toBeGreaterThan(0)
  })
})

describe('the spend cap: maxUsd stops the paying, and nothing written is lost (spend rule: cap per run)', () => {
  // What the fake reports for every call: one token in, one token out.
  const ONE_CALL = { input_tokens: 1, output_tokens: 1 }
  const judgeCall = { model: OUTBOUND_SCOPE_JUDGE_MODEL, ...ONE_CALL }
  const writeCall = { model: OUTBOUND_TEMPLATE_MODEL, ...ONE_CALL }
  /** The cost of the calls given, added in the order the run makes them, so the cap is the run's own number to the last digit. */
  const costOf = (...made: Array<typeof judgeCall>) => templateRunCostUsd(made)
  const kinds = (fake: ReturnType<typeof fakeModel>) => fake.calls.map(c => c.kind)

  it('PLANTED: a cap the first call already crosses stops the run before anything is written', async () => {
    const CAP = 0.000001
    // The label check is the run's first call, and it alone costs more than this cap.
    expect(costOf(judgeCall)).toBeGreaterThan(CAP)
    const fake = fakeModel()
    const err = await failure(runAgent(fake, { maxUsd: CAP }))
    expect(err.message).toContain('the spend cap was reached before this variant was written')
    expect(err.message).toContain('Stopped at the spend cap')
    // No generation call was made, and none after it either.
    expect(kinds(fake)).toEqual(['label'])
    // The attempt is what was written so far: nothing, and it says which variants are owed.
    expect(err.attempt.variants).toEqual({})
    expect(Object.keys(err.attempt.dropped).sort()).toEqual(['A', 'B'])
    expect(err.attempt.usage).toHaveLength(1)
  })

  it('PLANTED: a cap crossed by the FIRST variant stops before the second, and the attempt carries the first', async () => {
    // Under the cap after the label check, at it once variant A is written.
    const CAP = costOf(judgeCall, writeCall)
    expect(costOf(judgeCall)).toBeLessThan(CAP)
    const fake = fakeModel()
    const err = await failure(runAgent(fake, { maxUsd: CAP }))
    // A run stopped by its cap did not FAIL to write the variant: it was not asked to, and
    // the message and the reason both say so.
    expect(err.message).toContain('stopped before writing variant B')
    expect(err.message).not.toContain('failed')
    expect(err.message).toContain('the spend cap was reached before this variant was written')
    // One generation call, then nothing: not B, no judge, no repair.
    expect(kinds(fake)).toEqual(['label', 'generation'])
    expect(Object.keys(err.attempt.variants)).toEqual(['A'])
    expect(err.attempt.variants.A.email1.pain.text).toBe(inventedVariants().A.email1.pain.text)
    expect(err.attempt.opener_frames).toEqual(INVENTED_OPENER_FRAMES)
    expect(err.attempt.dropped).toEqual({ B: ['not written: the run stopped at its spend cap'] })
  })

  it('PLANTED: a cap crossed once everything is WRITTEN buys no judge call, and says the cap is why nothing passed', async () => {
    const CAP = costOf(judgeCall, writeCall, writeCall)
    const fake = fakeModel()
    const err = await failure(runAgent(fake, { maxUsd: CAP }))
    expect(kinds(fake)).toEqual(['label', 'generation', 'generation'])
    expect(err.message).toContain('0 of 2 variants passed')
    expect(err.message).toContain('Stopped at the spend cap')
    // Unjudged is not passed, and the wording is kept for the next run.
    expect(err.attempt.dropped.A).toEqual(['the scope judge did not clear the final wording'])
    expect(err.attempt.dropped.B).toEqual(['the scope judge did not clear the final wording'])
    expect(Object.keys(err.attempt.variants).sort()).toEqual(['A', 'B'])
  })

  it('PLANTED: over the cap, no repair is bought for a variant the judge refused', async () => {
    // Crossed by the first round of judging. The judge refuses A, and a repair is a paid call.
    const CAP = costOf(judgeCall, writeCall, writeCall, judgeCall)
    const fake = fakeNeedingOneRepair()
    const err = await failure(runAgent(fake, { maxUsd: CAP }))
    expect(kinds(fake)).toEqual(['label', 'generation', 'generation', 'judge', 'judge'])
    expect(err.message).toContain('1 of 2 variants passed')
    expect(err.message).toContain('Stopped at the spend cap')
    expect(err.attempt.dropped.A.join(' ')).toContain('excludes in-scope buyer X1')
  })

  it('the same run with room under the cap buys the repair and passes (control)', async () => {
    const fake = fakeNeedingOneRepair()
    const result = await runAgent(fake, { maxUsd: 3 })
    expect(kinds(fake)).toEqual(['label', 'generation', 'generation', 'judge', 'judge', 'repair', 'judge'])
    expect(Object.keys(result.variants).sort()).toEqual(['A', 'B'])
  })

  it('a generous cap changes nothing: the run completes exactly as it does with none (control)', async () => {
    const capped = fakeModel()
    const free = fakeModel()
    // The operator's default cap, a hundred thousand times what the fake's calls cost.
    const withCap = await runAgent(capped, { maxUsd: 3 })
    const without = await runAgent(free)
    expect(withCap).toEqual(without)
    expect(kinds(capped)).toEqual(kinds(free))
    expect(kinds(capped)).toEqual(['label', 'generation', 'generation', 'judge', 'judge'])
    expect(withCap.dropped).toEqual({})
  })

  it('PLANTED: a cap crossed only after everything is written AND judged still returns the result', async () => {
    // Under the cap going into the judge round, over it coming out. The work is done and
    // paid for: throwing it away would save nothing.
    const CAP = costOf(judgeCall, writeCall, writeCall, judgeCall)
    expect(costOf(judgeCall, writeCall, writeCall)).toBeLessThan(CAP)
    const fake = fakeModel()
    const result = await runAgent(fake, { maxUsd: CAP })
    expect(templateRunCostUsd(result.usage)).toBeGreaterThanOrEqual(CAP)   // the cap WAS crossed
    expect(kinds(fake)).toEqual(['label', 'generation', 'generation', 'judge', 'judge'])
    expect(Object.keys(result.variants).sort()).toEqual(['A', 'B'])
    expect(result.dropped).toEqual({})
  })
})

describe('a failed run\'s attempt carries the model that wrote it', () => {
  // The next run keeps what passed, and a draft's wording must not be taken for the
  // document model's. Three ways a run fails, and each builds its attempt separately.
  const writers: Array<[string, string | undefined, string]> = [
    ['by default', undefined, OUTBOUND_TEMPLATE_MODEL],
    ['on a draft run', OUTBOUND_TEMPLATE_DRAFT_MODEL, OUTBOUND_TEMPLATE_DRAFT_MODEL],
  ]

  it.each(writers)('PLANTED: %s, when a variant will not generate', async (_name, model, expected) => {
    let generationCalls = 0
    const fake = fakeModel({ generation: () => {
      generationCalls++
      if (generationCalls >= 2) throw new Error('the provider went away')
      return fakeModel().fixture()
    } })
    const err = await failure(runAgent(fake, model ? { model } : {}))
    expect(err.message).toContain('generating variant B failed')
    expect(err.attempt.model).toBe(expected)
  })

  it.each(writers)('PLANTED: %s, when a planned variant does not pass', async (_name, model, expected) => {
    const fake = fakeModel({ judge: () => 'I could not complete the review.' })
    const err = await failure(runAgent(fake, model ? { model } : {}))
    expect(err.message).toContain('0 of 2 variants passed')
    expect(err.attempt.model).toBe(expected)
  })

  it.each(writers)('PLANTED: %s, when a later call throws', async (_name, model, expected) => {
    const fake = fakeModel({
      judge: lineCount => {
        const lines = JSON.parse(fakeModel().cleanJudge(lineCount)).lines
        lines[0].excludes = 'X1'
        return JSON.stringify({ lines })
      },
      generation: call => {
        if (call.kind === 'repair') throw new Error('the API went away')
        return fakeModel().fixture()
      },
    })
    const err = await failure(runAgent(fake, model ? { model } : {}))
    expect(err.message).toContain('the run stopped on an error')
    expect(err.attempt.model).toBe(expected)
  })

  it('a run that passes says who wrote it in the same field (control)', async () => {
    expect((await runAgent(fakeModel())).model).toBe(OUTBOUND_TEMPLATE_MODEL)
    expect((await runAgent(fakeModel(), { model: OUTBOUND_TEMPLATE_DRAFT_MODEL })).model).toBe(OUTBOUND_TEMPLATE_DRAFT_MODEL)
  })
})

describe('the writer is shown each fault once, and a runaway answer is not paid for three times (2026-10-02)', () => {
  // The validator reports a fault in every render it shows up in. On 2026-10-02 two variants
  // went back to the writer with 56 and 58 lines, and both answers were cut off before any
  // JSON: the writer was counting words and syllables in its answer.
  const grade = (label: string, value: string) =>
    `fact email1 [short / frame 0 / ${label} / w000]: reading_grade_filled: grade ${value} with the peer label and the customer group filled in, over 5: use shorter words`

  it('PLANTED: a reading-grade fault in many renders becomes ONE line, the worst, and says how many', () => {
    const out = compactViolations([grade('software makers', '5.05'), grade('furniture makers and importers', '5.46'), grade('exporters', '5.21')])
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('grade 5.46')
    expect(out[0]).toContain('the worst of 3 renders')
    // The render tag is dropped: the writer is told which EMAIL, not which test render.
    expect(out[0].startsWith('fact email1: reading_grade_filled: ')).toBe(true)
  })

  it('PLANTED: any other rule keeps its first two distinct findings and counts the rest', () => {
    const line = (label: string) => `fact email1 [short / frame 0 / ${label} / w000]: sentence_length: 16 words: "${label} tell us that orders slow down."`
    const out = compactViolations([line('Software makers'), line('Exporters'), line('Furniture makers'), line('Importers')])
    expect(out).toHaveLength(2)
    expect(out[0]).toContain('"Software makers tell us')
    expect(out[1]).toContain('"Exporters tell us')
    // Counted as faults, never as renders, since 2026-10-02: a different detail is a
    // different finding, and the writer is not told otherwise.
    expect(out[1]).toContain('(and 2 more faults of this rule in this email, not shown)')
  })

  it('PLANTED: the same finding in several renders is said once', () => {
    // Until 2026-10-02 it carried "(and 2 more renders of this email fail the same rule)".
    // The same words three times are one fault, and there is nothing more to be told.
    const same = (tag: string) => `email1 [slot-free ${tag}]: idiom: "in waves": say it literally`
    expect(compactViolations([same('w000'), same('w001'), same('w010')]))
      .toEqual(['email1: idiom: "in waves": say it literally'])
  })

  it('two emails, or two rules, are never merged (control)', () => {
    const out = compactViolations([
      'email2 [slot-free]: sentence_length: 17 words: "A long one."',
      'email3 [slot-free]: sentence_length: 20 words: "Another long one."',
      'email3: email3_longer: Email 3 (47 words) is longer than Email 2 (39)',
    ])
    expect(out).toEqual([
      'email2: sentence_length: 17 words: "A long one."',
      'email3: sentence_length: 20 words: "Another long one."',
      'email3: email3_longer: Email 3 (47 words) is longer than Email 2 (39)',
    ])
  })

  it('a line that is not in the usual shape is passed through as it is (control)', () => {
    expect(compactViolations(['something the judge said'])).toEqual(['something the judge said'])
    expect(compactViolations([])).toEqual([])
  })

  it('the repair request tells the writer not to show working, and that code does the counting', async () => {
    const questionLine = lineRefsFor(inventedVariants(), 'exporters').findIndex(r => r.variant === 'A' && r.line === 'email1.question')
    const fake = fakeModel({
      judge: (lineCount, n) => {
        const lines = JSON.parse(fakeModel().cleanJudge(lineCount)).lines
        if (n === 1) lines[questionLine].excludes = 'X1'
        return JSON.stringify({ lines })
      },
    })
    await runAgent(fake).catch(() => undefined)
    const repair = fake.calls.find(c => c.kind === 'repair')
    expect(repair).toBeDefined()
    expect(repair!.user).toContain('NO WORKING IN THE ANSWER')
    expect(repair!.user).toContain('Your answer starts with { and holds the JSON and nothing else.')
    expect(OUTBOUND_TEMPLATE_SYSTEM_PROMPT).toContain('code does the counting')
  })

  it('PLANTED: a variant whose repair answer is cut off twice is not asked a third time, and the run keeps its wording', async () => {
    // The judge refuses the same line on every read, so the variant fails every round. Every
    // repair answer comes back cut off at the token limit, as the runaway answers did.
    const questionLine = lineRefsFor(inventedVariants(), 'exporters').findIndex(r => r.variant === 'A' && r.line === 'email1.question')
    const fake = fakeModel({
      judge: (lineCount) => {
        const lines = JSON.parse(fakeModel().cleanJudge(lineCount)).lines
        if (lines[questionLine]) lines[questionLine].excludes = 'X1'
        return JSON.stringify({ lines })
      },
    })
    type Params = { system: string; messages: Array<{ content: string }> }
    const inner = fake.client as unknown as { messages: { create: (p: Params) => Promise<Record<string, unknown>> } }
    const create = async (params: Params) => {
      const answer = await inner.messages.create(params)
      const isRepair = params.system === OUTBOUND_TEMPLATE_SYSTEM_PROMPT && params.messages[0].content.includes('YOUR PREVIOUS ATTEMPT FAILED')
      return isRepair ? { ...answer, stop_reason: 'max_tokens' } : answer
    }
    const cutOff = { messages: { create, stream: (params: Params) => ({ finalMessage: () => create(params) }) } } as unknown as Anthropic
    const err = await failure(generateOutboundTemplates({ brief: inventedBrief(), signoff: INVENTED_SIGNOFF, apiKey: 'unused', client: cutOff }))
    const repairsOfA = fake.calls.filter(c => c.kind === 'repair' && c.user.includes('Variant A, previous attempt:'))
    expect(repairsOfA).toHaveLength(2)
    // Nothing written is lost: the attempt still holds A as it was first written.
    expect(err.attempt.variants.A.email1.question.text).toBe(inventedVariants().A.email1.question.text)
    expect(Object.keys(err.attempt.dropped)).toContain('A')
  })
})

// ─── Review of 2026-10-02 (fifth reading, pre-merge) ─────────────────────────
//
// Three things the run loop did with a finding that cost money or misled the writer:
// a fault only the brief can fix was handed to the writer and paid for; a judge's
// "unnatural" quote was excused by the very brief word it bent, or dropped with no trace;
// and the writer's list of faults hid a third distinct fault and called it a re-render.

import { vi, afterEach } from 'vitest'
import { logger } from '@/lib/logger'
import { routeViolations } from '../outbound-template-agent'
import { inventedPeerBrief } from '@/lib/outbound-templates/__tests__/fixtures/invented-client'
import type { TemplateViolation } from '@/lib/outbound-templates/validate-templates'

describe('a fault only the brief can fix stops the run before anything is paid for', () => {
  const v = (variant: string, where: string, rule = 'some_rule'): TemplateViolation => ({ variant, where, rule, detail: 'detail' })

  it('PLANTED: a finding at the brief goes to the brief, and never under a variant, where a repair prompt would carry it', () => {
    const routed = routeViolations([v('*', 'brief.peer_groups', 'peer_opener_repeat'), v('A', 'email1')], ['A', 'B'])
    expect(routed.briefFaults).toEqual(['brief.peer_groups: peer_opener_repeat: detail'])
    expect(routed.byVariant).toEqual({ A: ['email1: some_rule: detail'] })
    expect(routed.frameViolations).toEqual([])
  })

  it('a frame finding goes to the frames, and a finding about the whole document to every variant (control)', () => {
    const routed = routeViolations([v('*', 'opener_frames[1]'), v('*', 'variants', 'variant_count')], ['A', 'B'])
    expect(routed.frameViolations).toEqual(['opener_frames[1]: some_rule: detail'])
    expect(routed.byVariant).toEqual({ A: ['variants: variant_count: detail'], B: ['variants: variant_count: detail'] })
    expect(routed.briefFaults).toEqual([])
  })

  it('PLANTED: a brief whose kind can never be used makes NO call of any kind, and the error names the brief', async () => {
    // Until 2026-10-03 this was planted as a kind and a peer label that say the same word
    // ("you run a software company", "Software makers ..."), refused at the brief as
    // peer_opener_repeat. That check is withdrawn with the after-opener label: the reader's
    // own group is named. The brief fault that remains is a kind on an industry no stored
    // record can resolve to, which the brief validator refuses before the template
    // validator's second net is reached.
    const brief = inventedPeerBrief()
    brief.peer_groups[0].industry = 'Software And Apps'
    const fake = fakeModel()
    const run = generateOutboundTemplates({ brief, signoff: INVENTED_SIGNOFF, apiKey: 'unused', client: fake.client })
    await expect(run).rejects.toThrow(/brief/)
    await expect(run).rejects.toThrow(/Software And Apps/)
    await expect(run).rejects.not.toBeInstanceOf(OutboundTemplateFailure)
    expect(fake.calls).toEqual([])
  })

  it('the peer brief as it stands, with no after_opener label, writes and passes (control)', async () => {
    const brief = inventedPeerBrief()
    expect(brief.peer_group_default.after_opener).toBeUndefined()
    const fake = fakeModel()
    const result = await generateOutboundTemplates({ brief, signoff: INVENTED_SIGNOFF, apiKey: 'unused', client: fake.client, keep: { opener_frames: ['Your site says {does}.', 'Can see {does}.'], variants: inventedVariants() } })
    expect(Object.keys(result.variants).sort()).toEqual(['A', 'B'])
    expect(fake.calls.map(c => c.kind)).toEqual(['label', 'judge', 'judge'])
  })
})

describe('the reviewer\'s "unnatural" answer: what the brief may excuse, and what a misplaced quote leaves behind', () => {
  const clean = (n: number) => ({ n, claims: [], proof_used: [], excludes: null, idiom: null, ambiguous: null, unnatural: null as string | null, fragment: false, slot_reads: true, sells_outcome: true, resolves_pain: true, asserts_about_reader: false, self_diagnosis: false, narrow_consequence: false, consequence_follows: true, question_matches: true })
  const line = (text: string): ScopeLineRef[] => [{ variant: 'A', line: 'email2.p2', text, kind: 'pain', angle: 'PA2' }]
  const judged = (text: string, quote: string, brief = inventedBrief()) => scopeHitsFromJudge([{ ...clean(1), unnatural: quote }], line(text), brief)
  const steadyBrief = () => {
    const brief = inventedBrief()
    brief.outcomes[1].statement = 'Orders from a new market stay steady.'
    return brief
  }

  it('PLANTED: a one-word quote is never excused because the brief uses that word: the operator\'s own example', () => {
    // "come in steady" was the fault he named. The brief may use "steady" correctly, and that
    // says nothing about whether this line bent it.
    expect(judged('Then the orders can come in steady.', 'steady', steadyBrief()).hits).toHaveLength(1)
    expect(judged('So orders can come in stall.', 'stall').hits).toHaveLength(1)
  })

  it('PLANTED: a phrase is excused only as the line has it, with the word either side: "say new market grows" is not the brief\'s', () => {
    // O2 in the invented brief is "A new market grows as planned." The line dropped its "A".
    expect(judged('Exporters often say new market grows as planned only on paper.', 'new market grows').hits).toHaveLength(1)
    expect(judged('Then the orders can come in steady.', 'come in steady', steadyBrief()).hits).toHaveLength(1)
  })

  it('the brief\'s own wording, as the brief has it, is still excused (control)', () => {
    expect(judged('Most firms hope a new market grows as planned.', 'new market grows').hits).toEqual([])
    expect(judged('Exporters tell us buyers leave. Sales abroad can stall.', 'Sales abroad can stall').hits).toEqual([])
  })

  it('PLANTED: a quote that is not in the line fails nothing, and is RETURNED, so it can be logged and counted', () => {
    const verdict = judged('Then the orders can come in slowly.', 'No worry')
    expect(verdict.hits).toEqual([])
    expect(verdict.unplaced).toEqual([{ variant: 'A', line: 'email2.p2', quote: 'No worry' }])
  })

  it('a quote that IS in the line is not returned as misplaced (control)', () => {
    expect(judged('Then the orders can come in steady.', 'come in steady').unplaced).toEqual([])
  })

  describe('in a run', () => {
    afterEach(() => { vi.restoreAllMocks() })

    it('PLANTED: the run logs each misplaced quote at warn, names the line, and counts it in its result', async () => {
      const warn = vi.spyOn(logger, 'warn')
      const fake = fakeModel({
        judge: lineCount => {
          const lines = JSON.parse(fakeModel().cleanJudge(lineCount)).lines
          lines[0].unnatural = 'No worry'
          return JSON.stringify({ lines })
        },
      })
      const result = await runAgent(fake)
      // A quote not in the line is not a hit: both variants pass, as before.
      expect(Object.keys(result.variants).sort()).toEqual(['A', 'B'])
      expect(result.unnatural_not_in_line).toEqual([
        { variant: 'A', line: 'email1.subject', quote: 'No worry' },
        { variant: 'B', line: 'email1.subject', quote: 'No worry' },
      ])
      const logged = warn.mock.calls.filter(([message]) => String(message).includes('not in the line'))
      expect(logged).toHaveLength(2)
      expect(logged[0][1]).toMatchObject({ variant: 'A', line: 'email1.subject', quote: 'No worry' })
    })

    it('a run whose judge quotes only what is in its lines reports none (control)', async () => {
      expect((await runAgent(fakeModel())).unnatural_not_in_line).toEqual([])
    })
  })
})

describe('the writer is shown every distinct fault, and told the truth about what is not shown (review of 2026-10-02)', () => {
  const consecutive = (word: string, first: string, second: string) =>
    `email1 [slot-free w000]: consecutive_word: "${word}" is said in two sentences in a row; say it once and reword the other: "${first}" then "${second}"`

  it('PLANTED: three different words said twice in a row are three lines, one per word', () => {
    const out = compactViolations([
      consecutive('abroad', 'Buyers abroad leave.', 'Sales abroad stall.'),
      consecutive('sales', 'Sales abroad stall.', 'We lift sales.'),
      consecutive('buyers', 'We find buyers.', 'Would more buyers help?'),
    ])
    expect(out).toHaveLength(3)
    expect(out.map(line => line.match(/consecutive_word: "([^"]+)"/)?.[1])).toEqual(['abroad', 'sales', 'buyers'])
    expect(out.join(' ')).not.toContain('more renders')
  })

  it('PLANTED: one word in several pairs of sentences is ONE line, the first pair', () => {
    const out = compactViolations([
      consecutive('sales', 'Sales abroad stall.', 'We lift sales.'),
      consecutive('sales', 'Sales can slip.', 'We lift sales.'),
    ])
    expect(out).toEqual([consecutive('sales', 'Sales abroad stall.', 'We lift sales.').replace(' [slot-free w000]', '')])
  })

  it('PLANTED: an over and an under of one band are never one group: the under is shown', () => {
    const band = (words: number, fix: string) => `fact email1 [long / frame 0 / exporters / w000]: word_band: ${words} words counting greeting and sign-off, outside 40 to 90: ${fix}`
    const out = compactViolations([band(92, 'cut at least 2 words'), band(95, 'cut at least 5 words'), band(31, 'add at least 9 words')])
    expect(out.some(line => line.includes('add at least 9 words'))).toBe(true)
    expect(out.some(line => line.includes('cut at least'))).toBe(true)
  })

  it('PLANTED: where a cap still hides a finding, it is counted as a FAULT, never as a render', () => {
    const idiom = (phrase: string) => `email3 [slot-free]: idiom: "${phrase}": say it literally`
    const out = compactViolations([idiom('in waves'), idiom('dry spell'), idiom('on your plate')])
    expect(out).toHaveLength(2)
    expect(out[1]).toContain('(and 1 more fault of this rule in this email, not shown)')
    expect(out.join(' ')).not.toContain('render')
  })
})

describe('the writer is priced at Opus 4.6\'s published rate, in both price tables (review of 2026-10-02)', () => {
  // Read from Anthropic's pricing page on 2026-10-02: $5 input, $25 output, $6.25 for a
  // five-minute cache write and $0.50 for a cache read, per million tokens. Both tables held
  // $15 / $75 / $18.75 / $1.50, the retired Opus 4.1 price, so the spend cap stopped a run
  // at about a third of the money it named.
  it('PLANTED: a million tokens in and a million out cost $30, not $90', async () => {
    const { USD_PER_MTOK } = await import('@/lib/agents/research/cost-constants')
    const { MODEL_PRICES, tokenCost } = await import('@/lib/tuner/pricing')
    expect(USD_PER_MTOK['claude-opus-4-6']).toEqual({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 })
    expect(usdForTokens({ input_tokens: 1e6, output_tokens: 1e6 }, OUTBOUND_TEMPLATE_MODEL)).toBeCloseTo(30, 9)
    expect(MODEL_PRICES['claude-opus-4-6'].input * 1e6).toBeCloseTo(5, 9)
    expect(MODEL_PRICES['claude-opus-4-6'].output * 1e6).toBeCloseTo(25, 9)
    expect(tokenCost('claude-opus-4-6', 1e6, 1e6)).toBeCloseTo(30, 9)
  })

  it('the Sonnet row, which was right, is unchanged (control)', () => {
    expect(usdForTokens({ input_tokens: 1e6, output_tokens: 1e6 }, OUTBOUND_SCOPE_JUDGE_MODEL)).toBeCloseTo(18, 9)
  })
})

// ─── Second fix round of 2026-10-02 ──────────────────────────────────────────

describe('a frame word the peer label repeats costs no variant repair (second round, 2026-10-02)', () => {
  // Measured on a stub run before this round: default label "trade show exhibitors" under
  // the frame "Your site shows {does}." gave 22 repair calls, $1.82 and "0 of 2 variants
  // passed". The finding sat under each variant, whose writer was told the frames are
  // already written and could not move a word of the label.
  const tradeShowBrief = () => {
    const brief = inventedBrief()
    brief.peer_group_default.label = 'trade show exhibitors'
    return brief
  }
  // Variant A names its source with {peer_group} in Email 1, Email 2 and Email 3. Under a
  // three-word default label that is "trade show exhibitors" three times in one sequence,
  // which phrase_repeat refuses (see the report of 2026-10-03: the label is the brief's).
  // This test is about the FRAME, so Email 3's pain here says its source without the slot.
  const variantsForFrames = () => {
    const variants = inventedVariants()
    variants.A.followups[1].paragraphs[0] = { text: 'We often hear that free tools came first and buyers noticed the errors.', slots: [], slot_free: null, from: ['PA3', 'T1'], kind: 'pain' }
    return variants
  }
  const answer = (frames: string[]) => (call: FakeCall) => ({
    opener_frames: frames,
    variants: call.kind === 'repair' ? {} : Object.fromEntries(Object.entries(variantsForFrames()).map(([k, v]) => [k, linesToRaw(v)])),
  })

  it('PLANTED: the finding goes to the frames: no variant is sent for repair, and one call rewrites the frames', async () => {
    const fake = fakeModel({
      generation: call => answer(call.kind === 'repair' ? ['Your site says {does}.', 'Can see {does}.'] : ['Your site shows {does}.', 'Can see {does}.'])(call),
    })
    const result = await generateOutboundTemplates({ brief: tradeShowBrief(), signoff: INVENTED_SIGNOFF, apiKey: 'unused', client: fake.client })
    const repairs = fake.calls.filter(c => c.kind === 'repair')
    // No repair call carries a variant: the writer is never asked to fix a label.
    expect(repairs.every(c => !/Variant [A-Z], previous attempt:/.test(c.user))).toBe(true)
    expect(repairs).toHaveLength(1)
    expect(repairs[0].user).toContain('opener_frames[0]: consecutive_word: "show"')
    expect(result.opener_frames).toEqual(['Your site says {does}.', 'Can see {does}.'])
    expect(Object.keys(result.variants).sort()).toEqual(['A', 'B'])
  })

  it('frames that do not say the word cost no repair call of any kind (control)', async () => {
    const fake = fakeModel({ generation: answer(['Your site says {does}.', 'Can see {does}.']) })
    const result = await generateOutboundTemplates({ brief: tradeShowBrief(), signoff: INVENTED_SIGNOFF, apiKey: 'unused', client: fake.client })
    expect(fake.calls.filter(c => c.kind === 'repair')).toEqual([])
    expect(Object.keys(result.variants).sort()).toEqual(['A', 'B'])
  })
})

describe('floor two excuses the brief\'s own sentence in the shapes the prompt asks for (second round, 2026-10-02)', () => {
  const clean = (n: number) => ({ n, claims: [], proof_used: [], excludes: null, idiom: null, ambiguous: null, unnatural: null as string | null, fragment: false, slot_reads: true, sells_outcome: true, resolves_pain: true, asserts_about_reader: false, self_diagnosis: false, narrow_consequence: false, consequence_follows: true, question_matches: true })
  const judged = (text: string, quote: string) =>
    scopeHitsFromJudge([{ ...clean(1), unnatural: quote }], [{ variant: 'A', line: 'email2.p2', text, kind: 'pain', angle: 'PA2' }], inventedBrief())

  // Each quote is a consequence in the invented brief word for word ("Sales abroad can
  // stall.", "Growth plans can slip."). Widened by a word either side it picks up the linking
  // word the prompt REQUIRES, or the "and" that joins two consequences, and the brief holds
  // neither. A repair cannot fix the brief's own sentence.
  it.each([
    ['As a result, sales abroad can stall.', 'sales abroad can stall'],
    ['So growth plans can slip.', 'growth plans can slip'],
    ['Growth plans can slip, and the launch can cost more.', 'growth plans can slip'],
    ['So growth plans can slip.', 'So growth plans can slip'],
  ])('PLANTED: "%s" quoted as "%s" is excused: the quote is a whole brief sentence', (text, quote) => {
    expect(judged(text, quote).hits).toEqual([])
  })

  it.each([
    // Round one's cases, which must stay refused.
    ['Exporters often say new market grows as planned only on paper.', 'new market grows'],
    ['So orders can come in stall.', 'stall'],
    // A brief sentence with a word dropped is not the brief's sentence.
    ['So growth can slip.', 'growth can slip'],
    // One word is never excused, even when the brief sentence is that word.
    ['So growth plans can slip.', 'slip'],
    // Merge review: a word in front that breaks the sentence is not a linker a whole clause
    // follows, so the brief's sentence behind it is not excused.
    ['Without growth plans can slip.', 'Without growth plans can slip'],
    ['Because sales abroad can stall.', 'Because sales abroad can stall'],
    ['Soon growth plans can slip.', 'Soon growth plans can slip'],
    ['The result growth plans can slip.', 'The result growth plans can slip'],
  ])('"%s" quoted as "%s" is still refused (control)', (text, quote) => {
    expect(judged(text, quote).hits).toHaveLength(1)
  })
})

describe('an unknown model is priced at an explicit ceiling, $15 in and $75 out (second round, 2026-10-02)', () => {
  it('PLANTED: a model in neither table costs $90 for a million tokens in and a million out, in both tables', async () => {
    const { tokenCost } = await import('@/lib/tuner/pricing')
    expect(usdForTokens({ input_tokens: 1e6, output_tokens: 1e6 }, 'claude-something-unreleased')).toBeCloseTo(90, 9)
    expect(usdForTokens({ input_tokens: 1e6, output_tokens: 1e6 }, null)).toBeCloseTo(90, 9)
    expect(tokenCost('claude-something-unreleased', 1e6, 1e6)).toBeCloseTo(90, 9)
    expect(tokenCost(null, 1e6, 1e6)).toBeCloseTo(90, 9)
  })

  it('a known Sonnet model is priced at its own row (control)', async () => {
    const { tokenCost } = await import('@/lib/tuner/pricing')
    expect(usdForTokens({ input_tokens: 1e6, output_tokens: 1e6 }, 'claude-sonnet-4-6')).toBeCloseTo(18, 9)
    expect(tokenCost('claude-sonnet-4-6', 1e6, 1e6)).toBeCloseTo(18, 9)
  })
})
