// Tests for the deterministic half of write-in-context. Taste is the judge's job and is
// not tested here; these cover the three gates and the fail-closed verdict parse.

import { describe, it, expect } from 'vitest'
import { FIRMOGRAPHIC_RULE_TEXT } from '@/lib/style/firmographic'
import {
  checkOpeningGates,
  parseChoice,
  buildFindingsBlock,
  buildWriterPrompt,
  buildJudgePrompt,
  OPENING_MAX_WORDS,
} from '../write-opening'
import type { ObservationCandidate } from '../types'

const FINDINGS = [
  'Blue Sky is hiring delivery consultants, posted 2026 on LinkedIn.',
  'The website blueskyerp.ca has no blog and no case studies.',
  'Apollo headcount is approximately 12.',
].join('\n')

describe('gate: word cap', () => {
  it('passes an opening at the cap', () => {
    const opening = Array.from({ length: OPENING_MAX_WORDS }, () => 'word').join(' ')
    expect(checkOpeningGates(opening, null, opening)).toEqual([])
  })

  it('fails an opening one word over', () => {
    const opening = Array.from({ length: OPENING_MAX_WORDS + 1 }, () => 'word').join(' ')
    expect(checkOpeningGates(opening, null, opening).some(f => f.includes('cap is'))).toBe(true)
  })
})

describe('gate: second person', () => {
  it('fails the real third-person failure from tonight', () => {
    const opening = 'Jason left Pani as Director of Product in July 2024.'
    const failures = checkOpeningGates(opening, 'Jason', 'Jason left Pani as Director of Product in July 2024.')
    expect(failures.some(f => f.includes('names the prospect'))).toBe(true)
  })

  it('passes the same fact written to the prospect', () => {
    const opening = 'You left Pani in July 2024.'
    expect(checkOpeningGates(opening, 'Jason', 'Jason left Pani in July 2024.')).toEqual([])
  })

  it('does not fire when the first name is absent from prospects', () => {
    expect(checkOpeningGates('You left Pani in July 2024.', null, 'left Pani in July 2024')).toEqual([])
  })
})

describe('gate: firmographic figures', () => {
  it('fails the real "$5M consulting firm" that shipped in Bob\'s opening', () => {
    const findings = 'Fitch Consulting is a $5M consulting firm launching Fitch Media.'
    const failures = checkOpeningGates('Launching Fitch Media while running a $5M consulting firm is a real plate to spin.', null, findings)
    expect(failures.some(f => f.includes('firmographic') || f.includes("prospect's record"))).toBe(true)
  })

  it('fails even though the figure IS in the findings, which is the point', () => {
    // Traceability passes it. Being sourced is what makes a revenue figure dangerous.
    const findings = 'Apollo reports 12 employees.'
    expect(checkOpeningGates('You have 12 employees now.', null, findings).length).toBeGreaterThan(0)
  })

  it('leaves dates, tenures and post counts alone', () => {
    const findings = 'Fourteen months running CRC. Three posts since 2016. Last 30 reviews.'
    expect(checkOpeningGates('Fourteen months running CRC says a lot, and your last 30 reviews show it.', null, findings)).toEqual([])
  })
})

describe('gate: factual traceability', () => {
  it('passes claims that appear in the findings', () => {
    const opening = 'Blue Sky is hiring delivery consultants. There is no blog and no case studies.'
    expect(checkOpeningGates(opening, null, FINDINGS)).toEqual([])
  })

  it('fails an invented number', () => {
    const opening = 'Blue Sky is hiring delivery consultants and now has 47 people.'
    const failures = checkOpeningGates(opening, null, FINDINGS)
    expect(failures.some(f => f.includes('47'))).toBe(true)
  })

  it('fails an invented proper noun', () => {
    const opening = 'Blue Sky is hiring delivery consultants after the Fastrack acquisition.'
    const failures = checkOpeningGates(opening, null, FINDINGS)
    expect(failures.some(f => f.includes('Fastrack'))).toBe(true)
  })

  it('does not treat a sentence-initial capital as a name', () => {
    const opening = 'Hiring is underway. There is no blog on the site.'
    expect(checkOpeningGates(opening, null, FINDINGS)).toEqual([])
  })
})

describe('judge choice parsing falls back to the template, never to the written opening', () => {
  it('reads a clean pick of A', () => {
    const r = parseChoice('CHOICE: A\nREASON: The opening earns the offer line.', 'A')
    expect(r.chosen).toBe('A')
    expect(r.written_won).toBe(true)
  })

  it('reads a clean pick of B', () => {
    const r = parseChoice('CHOICE: B\nREASON: Template is sharper.', 'A')
    expect(r.chosen).toBe('B')
    expect(r.written_won).toBe(false)
  })

  it('tracks written_won against the randomised label, not the letter', () => {
    // Same reply, opposite mapping: the written version was labelled B this time.
    const r = parseChoice('CHOICE: B\nREASON: Sharper opening.', 'B')
    expect(r.written_won).toBe(true)
  })

  it('resolves an unparseable reply to the template', () => {
    expect(parseChoice('honestly both are fine', 'A').written_won).toBe(false)
    expect(parseChoice('honestly both are fine', 'B').written_won).toBe(false)
  })

  it('resolves an empty reply to the template', () => {
    expect(parseChoice('', 'A').written_won).toBe(false)
  })
})

describe('findings block ranks by six-test score', () => {
  const cand = (id: string, total: number, obs: string): ObservationCandidate => ({
    id, observation: obs, source: 'apollo', provenance: 'Apollo employment_history',
    date: null, is_composite: false,
    scores: { specific: true, verifiable: true, inferential: true, relevant: true, useful: true, non_judgemental: true },
    passes_all: total === 6, score_total: total, model_readable_claim: true,
    opposite_reading: null, inference_direction: 'only_reading',
    readability: { hard_fail: false, penalty: 0, max_sentence_words: 5, hedges: [], nominalisation_density: 0, nominalisation_over_threshold: false, reasons: [] },
    demoted: false, rejection_reason: null,
  })

  it('puts the highest scoring finding first', () => {
    const block = buildFindingsBlock([cand('c1', 3, 'weaker finding'), cand('c2', 6, 'stronger finding')])
    expect(block.indexOf('stronger finding')).toBeLessThan(block.indexOf('weaker finding'))
  })

  it('carries provenance for every finding', () => {
    expect(buildFindingsBlock([cand('c1', 6, 'a finding')])).toContain('Apollo employment_history')
  })
})

describe('prompt shape', () => {
  it('the writer prompt embeds the variant P3 and CTA verbatim', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'THE_P3_LINE', cta: 'THE_CTA_LINE' })
    expect(p).toContain('THE_P3_LINE')
    expect(p).toContain('THE_CTA_LINE')
  })

  it('the judge prompt asks exactly one question and no checklist', () => {
    const p = buildJudgePrompt()
    expect((p.match(/\?/g) ?? []).length).toBe(1)
  })



  it('the judge prompt frames a choice between two sendable drafts, with no free rejection', () => {
    const p = buildJudgePrompt()
    expect(p).toContain('both ready to send')
    expect(p).toContain('Both go out under your name')
    expect(p).toContain('both ready to send')
    // The costless-rejection framing is gone: it is what produced 0 of 13.
    expect(p).not.toContain('HOLD')
    expect(p).not.toContain('costs nothing')
  })

  it('the writer prompt establishes the senior persona and bans absence openers', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })
    expect(p).toContain('senior BDR with fifteen years')
    expect(p).toContain('NEVER OPEN BY NAMING WHAT THEY LACK')
  })

  it('the writer prompt still bans absence openers and names what IS observable', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('NEVER OPEN BY NAMING WHAT THEY LACK')
    expect(flat).toContain('Notice something that IS there instead')
    // Says explicitly what is visible, so the writer is not guessing at the boundary.
    expect(flat).toContain('what they posted, what they published, who they hired')
    expect(p).not.toContain('There is no blog, no case studies')
  })

  it('the writer prompt bans verdicts and carries the Richard and Robert failures verbatim', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('THE BRIDGE NAMES A PATTERN. IT NEVER DELIVERS A VERDICT')
    // Richard: the bridge that was actually wrong, not merely presumptuous.
    expect(flat).toContain('What a Chamber event and a strong network cannot do')
    // Robert: invented outright.
    expect(flat).toContain('a firm that size fills its diary through relationships')
    // The two Doug accepted, as the pattern-framed models.
    expect(flat).toContain('tends to be exactly where new client conversations get quietly deprioritised')
    expect(flat).toContain('tends to be when the next engagement goes uncontested')
    // And the corrected Richard.
    expect(flat).toContain('often find the network fills the first months and not the ones after that')
  })

  it('the writer prompt blocks generic patterns with the standalone test', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('PATTERN FRAMING IS NOT PERMISSION TO GO GENERIC')
    expect(flat).toContain('Most firms at this stage find pipeline slips')
    expect(flat).toContain('reads as a non-sequitur without its observation')
  })

  it('the writer prompt requires clarity on one reading, with the Stephen riddle', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('EVERY SENTENCE MUST BE CLEAR ON ONE READING')
    // Correctly pattern-framed and still a riddle: stance alone is not enough.
    expect(flat).toContain('goes uncontested to whoever stayed visible')
  })

  it('the writer prompt aims the bridge at the offer, with the Shevonne failure verbatim', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('START BY READING THOSE TWO LINES')
    expect(p).toContain('AIMED WRONG:')
    expect(p).toContain('AIMED RIGHT')
    // The real failure, verbatim.
    expect(flat).toContain('The clients you actually want are a different current')
    expect(flat).toContain('Is getting more conversations in front of you something')
    // And the explicit test for aiming.
    expect(flat).toContain('that is not quite my problem')
  })

  it('the writer prompt carries the shared firmographic ban', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })
    expect(p).toContain(FIRMOGRAPHIC_RULE_TEXT)
  })

  it('the judge now tests the closing question, not general flow', () => {
    const flat = buildJudgePrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('the closing question is the obvious thing to ask this person')
  })

  it('the writer prompt asks for the observation AND the bridge, with the worked pair', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })
    expect(p).toContain('YOUR JOB IS TWO THINGS')
    // The bridge must be prospect-specific, not reusable filler.
    expect(p).toContain('PATTERN FRAMING IS NOT PERMISSION TO GO GENERIC')
  })

  it('the writer prompt states the loosened limits and nothing wider', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })
    expect(p).toContain('At most three sentences')
    expect(p).toContain('50 words')
  })

  it('the opening cap fits composition\'s 90-word ceiling on the tightest variant', () => {
    // Measured against the live document: the fixed remainder (greeting, P3, CTA,
    // two-line sign-off) is at most 31 words, so 90 - 31 = 59 words of headroom.
    expect(OPENING_MAX_WORDS).toBeLessThanOrEqual(59)
  })

  it('both FAILING examples are retained', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })
    expect(p).toContain('Jason left Pani as Director of Product')
    expect(p).toContain('You left Visteon at SVP level')
  })
})

describe('possessive forms are traceable', () => {
  it('does not flag "SCG\'s" when the findings contain "SCG"', () => {
    const findings = 'Daedra left GP Strategies in June 2024, making SCG her sole focus.'
    expect(checkOpeningGates("You left GP Strategies in June 2024. SCG's been the focus since.", null, findings)).toEqual([])
  })
})
