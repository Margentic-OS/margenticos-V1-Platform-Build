// Tests for the deterministic half of write-in-context. Taste is the judge's job and is
// not tested here; these cover the three gates and the fail-closed verdict parse.

import { describe, it, expect } from 'vitest'
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

  it('the judge now asks about coherence across the whole message', () => {
    // The phrase wraps across a line in the template literal, so normalise whitespace.
    const flat = buildJudgePrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('reads as a single message where every line follows from the one before')
  })

  it('the judge prompt frames a choice between two sendable drafts, with no free rejection', () => {
    const p = buildJudgePrompt()
    expect(p).toContain('gets a reply?')
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

  it('the writer GOOD examples notice something present, not something absent', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })
    expect(p).toContain('Saw your post asking your network for restaurant chains')
    // The old absence-pattern GOOD examples are what taught the writer to list absences.
    expect(p).not.toContain('There is no blog, no case studies')
  })

  it('the writer prompt asks for the observation AND the bridge, with the worked pair', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })
    expect(p).toContain('YOUR JOB IS TWO THINGS, NOT ONE')
    expect(p).toContain('INCOMPLETE:')
    expect(p).toContain('COMPLETE:')
    // The bridge must be prospect-specific, not reusable filler.
    expect(p).toContain('THE BRIDGE MUST COME FROM THIS OBSERVATION')
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
