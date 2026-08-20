// Tests for the deterministic half of write-in-context. Taste is the judge's job and is
// not tested here; these cover the three gates and the fail-closed verdict parse.

import { describe, it, expect } from 'vitest'
import { FIRMOGRAPHIC_RULE_TEXT } from '@/lib/style/firmographic'
import {
  buildFloorPrompt,
  parseFloor,
  parseWriterOutput,
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
    expect(p).toContain('START BY READING THE OFFER LINE')
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
    expect(flat).toContain('still find the closing question the obvious thing to ask them')
  })

  it('the writer prompt asks for the observation AND the bridge, with the worked pair', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })
    expect(p).toContain('YOUR JOB IS TWO THINGS')
    // The bridge must be prospect-specific, not reusable filler.
    expect(p).toContain('PATTERN FRAMING IS NOT PERMISSION TO GO GENERIC')
  })

  it('the writer prompt states the loosened limits and nothing wider', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })
    expect(p).toContain('At most four sentences')
    expect(p).toContain('62 words')
  })

  it('the cap fits the 90-word ceiling now the writer owns the CTA too', () => {
    // Measured live: the approved CTA no longer consumes budget, so what stays fixed is
    // the greeting, P3 and the two sign-off lines. Tightest variant (D) leaves 70 words.
    expect(OPENING_MAX_WORDS).toBeLessThanOrEqual(70)
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


// ─── The floor, and the writer's two-block output ────────────────────────────

describe('the floor disqualifies claims of private knowledge', () => {
  it('asks one question about knowability and nothing about quality', () => {
    const p = buildFloorPrompt()
    expect((p.match(/\?/g) ?? []).length).toBe(1)
    expect(p.replace(/\s+/g, ' ')).toContain('could not be known from public information')
    // It is not a comparison: no A, no B, no "which".
    expect(p).not.toContain('VERSION A')
    expect(p).not.toContain('Which one')
  })

  it('reads a clean pass', () => {
    const f = parseFloor('CLAIMS_PRIVATE: NO\nREASON: Everything asserted is visible publicly.')
    expect(f.claims_private).toBe(false)
  })

  it('reads a clean disqualification', () => {
    const f = parseFloor('CLAIMS_PRIVATE: YES\nREASON: It claims their pipeline runs warm.')
    expect(f.claims_private).toBe(true)
    expect(f.reason).toContain('pipeline runs warm')
  })

  it('treats an unreadable reply as disqualified, never as a pass', () => {
    // Ambiguity can only ever fall back to the approved template.
    expect(parseFloor('hard to say really').claims_private).toBe(true)
    expect(parseFloor('').claims_private).toBe(true)
  })
})

describe('writer output parsing', () => {
  it('splits the two labelled blocks', () => {
    const r = parseWriterOutput('OPENING: An observation and a bridge.\nQUESTION: Is that something you are working on?')
    expect(r.opening).toBe('An observation and a bridge.')
    expect(r.question).toBe('Is that something you are working on?')
  })

  it('handles a multi-sentence opening across lines', () => {
    const r = parseWriterOutput('OPENING: First sentence here. Second sentence here.\n\nQUESTION: Is this the gap?')
    expect(r.opening).toContain('Second sentence here.')
    expect(r.question).toBe('Is this the gap?')
  })

  it('returns an empty question when the writer omits it, so the gate can catch it', () => {
    expect(parseWriterOutput('OPENING: Just an observation.').question).toBe('')
  })
})

describe('the writer prompt carries the question job and the Shevonne failure', () => {
  it('names the three parts and pins the offer line as fixed', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'THE_P3', cta: 'THE_CTA' })
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('[YOUR CLOSING QUESTION GOES HERE]')
    expect(flat).toContain('The offer line in the middle is FIXED')
    expect(p).toContain('THE_P3')
  })

  it('passes the four approved CTAs as register anchors', () => {
    const flat = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' }).replace(/\s+/g, ' ')
    expect(flat).toContain('Is pipeline consistency something you\'re actively trying to fix?')
    expect(flat).toContain('Is getting more conversations in front of you something you\'re working on?')
    expect(flat).toContain('Is this a gap you\'re looking to close?')
    expect(flat).toContain('Worth a look to see if it fits where you are?')
  })

  it('carries the Shevonne browsers-versus-buyers failure verbatim, with a correction', () => {
    const flat = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' }).replace(/\s+/g, ' ')
    expect(flat).toContain('builds an audience of browsers before it builds a pipeline of buyers')
    expect(flat).toContain('She does not want more. She wants different ones.')
    expect(flat).toContain('Is turning that audience into the right kind of buyer something you\'re working on?')
  })

  it('the cap fits the tightest variant with room to spare', () => {
    // Measured live: greeting + P3 + two sign-off lines leaves 70 words on variant D.
    expect(OPENING_MAX_WORDS).toBeLessThanOrEqual(70 - 8)
  })
})


// ─── One fact per sentence, the first-read test, and the conditional second retry ───

describe('the writer prompt enforces one fact per sentence', () => {
  it('states the structural rule rather than a length rule', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('ONE FACT PER SENTENCE')
    expect(flat).toContain('about STRUCTURE, not length')
    expect(flat).toContain('If you are naming two things, use two sentences')
    expect(flat).toContain('reading at eleven years old')
  })

  it('carries both real cramped examples verbatim', () => {
    const flat = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' }).replace(/\s+/g, ' ')
    // Robert's, and the diagnosis of why it fails.
    expect(flat).toContain('DTCC tokenization, Treasury clearing, SEC crypto posture, shows where the thinking is')
    expect(flat).toContain('a verb whose subject is three clauses back')
    // Daedra's.
    expect(flat).toContain('Hollywood Food Coalition and Sovern LA, on top of running SCG full-time is a real load')
    expect(flat).toContain('An appositive list swallows the subject')
  })

  it('pairs each cramped example with a clean rewrite of the same facts', () => {
    const flat = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' }).replace(/\s+/g, ' ')
    expect(flat).toContain('Taffet publishes regulatory commentary regularly')
    expect(flat).toContain('You took two board seats in early 2026, at Hollywood Food Coalition and Sovern LA')
    // And says explicitly that only the joins moved, so it is not read as "make it shorter".
    expect(flat).toContain('Only the joins moved')
  })
})

describe('the judge tests the first read, still as one question', () => {
  it('asks about reading once at speed without re-reading', () => {
    const flat = buildJudgePrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('read once, at speed, without going back over the first paragraph')
  })

  it('is still exactly one question and still not a checklist', () => {
    const p = buildJudgePrompt()
    expect((p.match(/\?/g) ?? []).length).toBe(1)
    expect(p).not.toContain('1.')
    expect(p).not.toContain('- ')
  })

  it('still keeps the closing-question test in the same sentence', () => {
    const flat = buildJudgePrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('the obvious thing to ask them')
  })
})
