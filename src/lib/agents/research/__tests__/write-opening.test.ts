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
  joinOpening,
  OPENING_MAX_WORDS,
} from '../write-opening'
import { BatchUniquenessRegistry, uniquenessFeedback } from '../batch-uniqueness'
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
    // And the corrected Richard, rewritten out of the "Firms that X often find Y" frame.
    expect(flat).toContain('A network fills the first months after a hire like that')
  })

  it('no longer offers the model that seeded the batch collapse', () => {
    // "That kind of operational weight tends to be exactly where new client conversations
    // get quietly deprioritised" shipped in this prompt as an accepted model. Three of
    // twelve prospects then came back with "new client conversations are the first thing
    // that quietly gets deprioritised". The example was the cause, so it is deleted rather
    // than reworded, and this test stops it being reinstated.
    const flat = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' }).replace(/\s+/g, ' ')
    expect(flat).not.toContain('quietly deprioritised')
    expect(flat).not.toContain('tends to be exactly where new client conversations')
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
    expect(p).toContain('YOUR JOB IS THREE THINGS')
    // The bridge must be prospect-specific, not reusable filler.
    expect(p).toContain('PATTERN FRAMING IS NOT PERMISSION TO GO GENERIC')
  })

  it('the writer prompt states the loosened limits and nothing wider', () => {
    const p = buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })
    // Five, not four: one fact per sentence necessarily splits sentences, and the cap that
    // actually bounds length is the word count, which is gated and did not move.
    expect(p).toContain('At most five sentences')
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
  it('asks about reading once at speed without re-reading ANY sentence', () => {
    const flat = buildJudgePrompt().replace(/\s+/g, ' ')
    // Widened from "the first paragraph": the observation and the bridge are now two
    // paragraphs, so a test scoped to the first one would miss the bridge entirely.
    expect(flat).toContain('read once, at speed, without going back over any sentence')
    expect(flat).not.toContain('the first paragraph')
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


// ─── Digestibility, varied bridge shapes, and batch uniqueness ───────────────

describe('the writer prompt targets load before resolution, not length', () => {
  const prompt = () => buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })

  it('names the real problem and refuses to restate it as a word cap', () => {
    const p = prompt()
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('DIGESTIBILITY')
    expect(flat).toContain('LOAD BEFORE RESOLUTION')
    expect(flat).toContain('A short sentence can be heavy and a longer one can be effortless')
  })

  it('caps relative clauses at one and bans nesting', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('ONE RELATIVE CLAUSE PER SENTENCE')
    expect(flat).toContain('Count your "that", "which", "who" and "where"')
    expect(flat).toContain('One nested inside another is never acceptable')
  })

  it('asks for the verb early, with a concrete subject length', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('GET TO THE VERB EARLY')
    expect(flat).toContain('roughly four words before the main verb')
  })

  it('carries the hard and easy pair verbatim, plus a rewrite of the hard one', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    // The real hard sentence, with its diagnosis.
    expect(flat).toContain('Consulting firms that rely on conference appearances for new conversations')
    expect(flat).toContain('Ten words before the verb')
    expect(flat).toContain('Three relative clauses, one nested inside another')
    // The real easy sentence, to show the fix is not "make it shorter".
    expect(flat).toContain('Founders who move that fast often find the first clients come quickly')
    expect(flat).toContain('Barely shorter')
    // And the rewrite of the hard one, same facts.
    expect(flat).toContain('Conferences deliver in bursts')
    expect(flat).toContain('The pipeline tends to follow the event calendar')
    expect(flat).toContain('Nothing was dropped and nothing was softened')
  })
})

describe('the writer prompt varies the bridge construction', () => {
  const prompt = () => buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'y' })

  it('names the frame that collapsed and says why it matters', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('NAME THE PATTERN IN A DIFFERENT SHAPE EVERY TIME')
    expect(flat).toContain('"Firms that X often find Y" is one construction')
    expect(flat).toContain('eleven bridges built on that frame')
  })

  it('offers four genuinely different shapes, each labelled', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('A CONDITIONAL')
    expect(flat).toContain('WHAT USUALLY HAPPENS NEXT')
    expect(flat).toContain('A CONTRAST')
    expect(flat).toContain('A CONSEQUENCE')
    expect(flat).toContain('When the calendar fills that fast, prospecting is usually what gives')
    expect(flat).toContain('A move like that runs on existing relationships for the first few months')
    expect(flat).toContain('Delivery has a deadline. Business development never does, so it waits')
    expect(flat).toContain('That leaves one person deciding, every week, whether to sell or to deliver')
  })

  it('the four worked shapes do not collide with each other', () => {
    // A worked example that shares a skeleton with another worked example teaches the
    // opposite of what this section is for.
    const examples = [
      'When the calendar fills that fast, prospecting is usually what gives.',
      'A move like that runs on existing relationships for the first few months. After that it gets harder.',
      'Delivery has a deadline. Business development never does, so it waits.',
      'That leaves one person deciding, every week, whether to sell or to deliver.',
    ]
    // Deliberately distinct questions: this test is about the bridges, and "question 1?"
    // versus "question 2?" would normalise to the same key and fail for the wrong reason.
    const questions = [
      'Is that a gap you are looking to close?',
      'Worth a look to see if it fits?',
      'Is protecting that time something you are working on?',
      'Is any of this on your list for the quarter?',
    ]
    const reg = new BatchUniquenessRegistry()
    examples.forEach((ex, i) => {
      expect(reg.reserve(`example-${i}`, ex, questions[i])).toEqual([])
    })
  })

  it('states the batch rule, not just the preference', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('must not share a sentence shape with another prospect in this batch')
    expect(flat).toContain('Vary the CONSTRUCTION, not just the nouns')
  })
})

describe('the writer prompt treats the approved questions as register, not a menu', () => {
  const prompt = () => buildWriterPrompt({ clientName: 'Acme', p3: 'x', cta: 'Worth a look?' })

  it('says write, do not pick', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('WRITE THE CLOSING QUESTION. DO NOT PICK ONE')
    expect(flat).toContain('They are not a menu')
    expect(flat).toContain('Your default is to WRITE a question for this prospect')
    expect(flat).toContain('which will be rare')
  })

  it('cites the actual collapse so the instruction has a reason attached', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('six of them carried the same approved question word for word')
  })

  it('extends the register-only framing to the variant CTA it is handed', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('The approved question for this particular variant is "Worth a look?"')
    expect(flat).toContain('the same applies to it')
  })

  it('states the batch-uniqueness rule for questions too', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('no two prospects in this batch may get the same closing question')
    expect(flat).toContain('do not reword it slightly')
  })
})

describe('the writer prompt asks for three paragraphs, returned as three blocks', () => {
  const prompt = () => buildWriterPrompt({ clientName: 'Acme', p3: 'OFFER LINE', cta: 'y' })

  it('shows the observation and the bridge as separate slots in the skeleton', () => {
    const p = prompt()
    expect(p).toContain('[YOUR OBSERVATION GOES HERE]')
    expect(p).toContain('[YOUR BRIDGE GOES HERE]')
    // Order matters: observation, bridge, offer line, question.
    expect(p.indexOf('[YOUR OBSERVATION GOES HERE]')).toBeLessThan(p.indexOf('[YOUR BRIDGE GOES HERE]'))
    expect(p.indexOf('[YOUR BRIDGE GOES HERE]')).toBeLessThan(p.indexOf('OFFER LINE'))
    expect(p.indexOf('OFFER LINE')).toBeLessThan(p.indexOf('[YOUR CLOSING QUESTION GOES HERE]'))
  })

  it('says explicitly that they are separate paragraphs', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('SEPARATE PARAGRAPHS with a blank line between them')
    expect(flat).toContain('never run together')
  })

  it('asks for exactly three labelled blocks', () => {
    const p = prompt()
    expect(p).toContain('exactly three labelled blocks')
    expect(p).toContain('OBSERVATION:')
    expect(p).toContain('BRIDGE:')
    expect(p).toContain('QUESTION:')
  })
})

describe('parseWriterOutput reads three blocks', () => {
  it('splits observation, bridge and question, and joins the first two as paragraphs', () => {
    const raw = [
      'OBSERVATION: You spoke at the 2026 conference about industry pressure.',
      'BRIDGE: Delivery has a deadline. Prospecting never does, so it waits.',
      'QUESTION: Is protecting that time something you are working on?',
    ].join('\n')
    const out = parseWriterOutput(raw)
    expect(out.observation).toBe('You spoke at the 2026 conference about industry pressure.')
    expect(out.bridge).toBe('Delivery has a deadline. Prospecting never does, so it waits.')
    expect(out.question).toBe('Is protecting that time something you are working on?')
    expect(out.opening).toBe(`${out.observation}\n\n${out.bridge}`)
    expect(out.opening.split(/\n{2,}/)).toHaveLength(2)
  })

  it('collapses a soft-wrapped block onto one line, so a wrap is not a paragraph', () => {
    const raw = 'OBSERVATION: You spoke at the 2026\nconference about pressure.\nBRIDGE: It waits.\nQUESTION: Yes?'
    const out = parseWriterOutput(raw)
    expect(out.observation).toBe('You spoke at the 2026 conference about pressure.')
    expect(out.opening.split(/\n{2,}/)).toHaveLength(2)
  })

  it('falls back to the old OPENING block rather than dropping the observation', () => {
    // A writer that ignores the new labels used to lose its whole observation to the
    // OPENING regex and ship a bridge alone, which reads as generic with no anchor.
    const raw = 'OPENING: You hired a delivery lead.\n\nThe first months run on the network.\nQUESTION: Is that a gap?'
    const out = parseWriterOutput(raw)
    expect(out.observation).toBe('You hired a delivery lead.')
    expect(out.bridge).toBe('The first months run on the network.')
    expect(out.question).toBe('Is that a gap?')
  })

  it('leaves the bridge empty when nothing separable was returned, so the gate rejects', () => {
    const out = parseWriterOutput('OPENING: One line only.\nQUESTION: Is that a gap?')
    expect(out.observation).toBe('One line only.')
    expect(out.bridge).toBe('')
  })
})

describe('joinOpening', () => {
  it('separates the two halves with a blank line', () => {
    expect(joinOpening('A.', 'B.')).toBe('A.\n\nB.')
  })

  it('drops an empty half rather than emitting a leading or trailing blank line', () => {
    expect(joinOpening('A.', '')).toBe('A.')
    expect(joinOpening('', 'B.')).toBe('B.')
  })
})

describe('BatchUniquenessRegistry gates the bridge and the closing question', () => {
  const BRIDGE_A = 'Firms that hire delivery leads often find the pipeline is the first thing that slips.'
  // Same skeleton, different nouns: exactly the failure the gate exists to catch.
  const BRIDGE_A_NOUNS_SWAPPED = 'Firms that hire account leads often find the diary is the first thing that slips.'
  const BRIDGE_B = 'Delivery has a deadline. Business development never does, so it waits.'

  it('accepts the first bridge and refuses the same shape with different nouns', () => {
    const reg = new BatchUniquenessRegistry()
    expect(reg.reserve('p1', BRIDGE_A, 'Is that a gap?')).toEqual([])
    const collisions = reg.reserve('p2', BRIDGE_A_NOUNS_SWAPPED, 'Something else entirely?')
    expect(collisions.length).toBeGreaterThan(0)
    expect(collisions.every(c => c.kind === 'bridge')).toBe(true)
    expect(collisions[0].firstSeenId).toBe('p1')
  })

  it('accepts a genuinely different construction', () => {
    const reg = new BatchUniquenessRegistry()
    expect(reg.reserve('p1', BRIDGE_A, 'Is that a gap?')).toEqual([])
    expect(reg.reserve('p2', BRIDGE_B, 'Is protecting that time the problem?')).toEqual([])
  })

  it('refuses a repeated closing question even when the bridge is fine', () => {
    const reg = new BatchUniquenessRegistry()
    reg.reserve('p1', BRIDGE_A, 'Is pipeline consistency something you are trying to fix?')
    const collisions = reg.reserve('p2', BRIDGE_B, 'Is pipeline consistency something you are trying to fix?')
    expect(collisions).toHaveLength(1)
    expect(collisions[0].kind).toBe('question')
  })

  it('catches a question reworded only by swapping the company name', () => {
    // sentenceKey masks proper nouns, so "vary the nouns" does not clear this either.
    const reg = new BatchUniquenessRegistry()
    reg.reserve('p1', BRIDGE_A, 'Is keeping Acme pipeline moving something you are working on?')
    const collisions = reg.reserve('p2', BRIDGE_B, 'Is keeping Globex pipeline moving something you are working on?')
    expect(collisions.map(c => c.kind)).toContain('question')
  })

  it('records NOTHING when it refuses, so a rejected attempt cannot block a third prospect', () => {
    const reg = new BatchUniquenessRegistry()
    reg.reserve('p1', BRIDGE_A, 'Is that a gap?')
    const before = reg.bridgeFrameCount
    reg.reserve('p2', BRIDGE_A_NOUNS_SWAPPED, 'Is that a gap?')
    expect(reg.bridgeFrameCount).toBe(before)
    expect(reg.holds('p2')).toBe(false)
  })

  it('lets a prospect retry against itself without colliding with its own last attempt', () => {
    const reg = new BatchUniquenessRegistry()
    expect(reg.reserve('p1', BRIDGE_A, 'Is that a gap?')).toEqual([])
    expect(reg.reserve('p1', BRIDGE_A, 'Is that a gap?')).toEqual([])
    expect(reg.holds('p1')).toBe(true)
  })

  it('frees the shape for a later prospect when the attempt is released', () => {
    // A bridge that lost to its template never shipped, so it must not block anyone.
    const reg = new BatchUniquenessRegistry()
    reg.reserve('p1', BRIDGE_A, 'Is that a gap?')
    reg.release('p1')
    expect(reg.holds('p1')).toBe(false)
    expect(reg.reserve('p2', BRIDGE_A, 'Is that a gap?')).toEqual([])
  })

  it('release is safe on an id holding nothing', () => {
    const reg = new BatchUniquenessRegistry()
    expect(() => reg.release('never-seen')).not.toThrow()
  })

  it('reserves atomically, so no await can interleave a check and a commit', async () => {
    // The gate runs synchronously before the floor and judge calls. This pins that: two
    // prospects resolving concurrently cannot both pass.
    const reg = new BatchUniquenessRegistry()
    const results = await Promise.all([
      Promise.resolve().then(() => reg.reserve('p1', BRIDGE_A, 'Q one?')),
      Promise.resolve().then(() => reg.reserve('p2', BRIDGE_A_NOUNS_SWAPPED, 'Q two?')),
    ])
    const accepted = results.filter(r => r.length === 0)
    expect(accepted).toHaveLength(1)
  })
})

describe('uniquenessFeedback tells the writer what to change', () => {
  it('asks for a different construction on a bridge collision', () => {
    const text = uniquenessFeedback([{ kind: 'bridge', key: 'often find the pipeline', firstSeenId: 'p1' }])
    expect(text).toContain('already uses that sentence shape for the bridge')
    expect(text).toContain('genuinely different CONSTRUCTION')
    expect(text).toContain('conditional')
  })

  it('forbids a slight reword on a question collision', () => {
    const text = uniquenessFeedback([{ kind: 'question', key: 'is that a gap', firstSeenId: 'p1' }])
    expect(text).toContain('already uses that closing question')
    expect(text).toContain('Do not reword it slightly')
  })

  it('reports both when both collided', () => {
    const text = uniquenessFeedback([
      { kind: 'bridge', key: 'often find the pipeline', firstSeenId: 'p1' },
      { kind: 'question', key: 'is that a gap', firstSeenId: 'p1' },
    ])
    expect(text).toContain('sentence shape for the bridge')
    expect(text).toContain('closing question')
  })
})
