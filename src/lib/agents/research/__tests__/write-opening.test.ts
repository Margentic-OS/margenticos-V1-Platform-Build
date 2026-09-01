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
  buildWriterAssignment,
  buildJudgePrompt,
  joinOpening,
  OPENING_MAX_WORDS,
  OPENING_BUDGET,
  OPENING_TARGET_WORDS,
} from '../write-opening'
import { BatchUniquenessRegistry, uniquenessFeedback } from '../batch-uniqueness'
import { ABSTRACT_NOUNS, countAbstractNouns, countFigurativeVerbs } from '@/lib/style/abstract-nouns'
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
  // WAS: "the writer prompt embeds the variant P3 and CTA verbatim". They moved to the
  // assignment block in the user message on 2026-08-25 so the system prompt is a constant
  // and can be cached. The prompt is ~9,300 tokens and the writer call runs up to three
  // times per prospect, so a per-variant prefix was costing a full re-read every attempt.
  it('the assignment block carries the variant P3 and CTA verbatim', () => {
    const a = buildWriterAssignment({ clientName: 'Acme', buyer: 'THE_BUYER_TITLE', p3: 'THE_P3_LINE', cta: 'THE_CTA_LINE' })
    expect(a).toContain('THE_P3_LINE')
    expect(a).toContain('THE_CTA_LINE')
    expect(a).toContain('Acme')
  })

  // THE CACHE INVARIANT. If any per-prospect, per-variant or per-client value gets
  // interpolated back into the system prompt, the prefix stops being stable, every call
  // silently reverts to full input price, and nothing else in the suite would notice.
  it('the writer system prompt is a constant, identical for every client and variant', () => {
    expect(buildWriterPrompt()).toBe(buildWriterPrompt())
    const p = buildWriterPrompt()
    expect(p).not.toContain('THE_P3_LINE')
    expect(p).not.toContain('THE_CTA_LINE')
    expect(p).not.toContain('Acme')
  })

  it('the judge prompt asks exactly one question and no checklist', () => {
    const p = buildJudgePrompt('THE_BUYER_TITLE')
    expect((p.match(/\?/g) ?? []).length).toBe(1)
  })



  it('the judge prompt frames a choice between two sendable drafts, with no free rejection', () => {
    const p = buildJudgePrompt('THE_BUYER_TITLE')
    expect(p).toContain('both ready to send')
    expect(p).toContain('Both go out under your name')
    expect(p).toContain('both ready to send')
    // The costless-rejection framing is gone: it is what produced 0 of 13.
    expect(p).not.toContain('HOLD')
    expect(p).not.toContain('costs nothing')
  })

  it('the writer prompt establishes the senior persona and bans absence openers', () => {
    const p = buildWriterPrompt()
    expect(p).toContain('senior BDR with fifteen years')
    // HEADING CHANGED when the ban moved to sit with its own exception. It read "NEVER
    // OPEN BY NAMING WHAT THEY LACK", and "open" was resolvable only by reading
    // joinOpening. The ban is unchanged in force; it now says which paragraphs it covers.
    expect(p).toContain('NEVER NAME WHAT THEY LACK')
    expect(p).not.toContain('NEVER OPEN BY NAMING WHAT THEY LACK')
  })

  it('the writer prompt still bans absence openers and names what IS observable', () => {
    const p = buildWriterPrompt()
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('NEVER NAME WHAT THEY LACK')
    expect(flat).toContain('Notice something that IS there instead')
    // Says explicitly what is visible, so the writer is not guessing at the boundary.
    expect(flat).toContain('what they posted, what they published, who they hired')
    expect(p).not.toContain('There is no blog, no case studies')
  })

  it('the writer prompt bans verdicts, and no longer illustrates one', () => {
    // PURPOSE SURVIVES. The rule is the ban. The three worked verdicts it carried were
    // removed with every other example on this branch.
    const p = buildWriterPrompt()
    expect(p).toContain('THE BRIDGE NAMES A PATTERN. IT NEVER DELIVERS A VERDICT')
    expect(p.replace(/\s+/g, ' ')).toContain('never tell them something they are doing is not working')
  })

  it('no longer offers the model that seeded the batch collapse', () => {
    // "That kind of operational weight tends to be exactly where new client conversations
    // get quietly deprioritised" shipped in this prompt as an accepted model. Three of
    // twelve prospects then came back with "new client conversations are the first thing
    // that quietly gets deprioritised". The example was the cause, so it is deleted rather
    // than reworded, and this test stops it being reinstated.
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).not.toContain('quietly deprioritised')
    expect(flat).not.toContain('tends to be exactly where new client conversations')
  })

  it('the writer prompt blocks generic patterns with the standalone test', () => {
    const p = buildWriterPrompt()
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('PATTERN FRAMING IS NOT PERMISSION TO GO GENERIC')
    expect(flat).toContain('reads as a non-sequitur without its observation')
  })

  it('the writer prompt requires clarity on one reading', () => {
    const p = buildWriterPrompt()
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('EVERY SENTENCE MUST BE CLEAR ON ONE READING')
    // The rule the riddle illustrated: stance alone is not enough.
    expect(flat).toContain('correctly pattern-framed and still fail here')
  })

  it('the writer prompt aims the bridge at the offer', () => {
    const p = buildWriterPrompt()
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('START BY READING THE OFFER LINE')
    // The explicit test for aiming survives; the worked failure under it does not.
    expect(flat).toContain('that is not quite my problem')
  })

  it('the writer prompt carries the shared firmographic ban', () => {
    const p = buildWriterPrompt()
    expect(p).toContain(FIRMOGRAPHIC_RULE_TEXT)
  })

  it('the judge now tests the closing question, not general flow', () => {
    const flat = buildJudgePrompt('THE_BUYER_TITLE').replace(/\s+/g, ' ')
    expect(flat).toContain('still find the closing question the obvious thing to ask them')
  })

  it('the writer prompt asks for the observation AND the bridge, with the worked pair', () => {
    const p = buildWriterPrompt()
    expect(p).toContain('YOUR JOB IS THREE THINGS')
    // The bridge must be prospect-specific, not reusable filler.
    expect(p).toContain('PATTERN FRAMING IS NOT PERMISSION TO GO GENERIC')
  })

  it('the writer prompt states the loosened limits and nothing wider', () => {
    const p = buildWriterPrompt()
    // Five, not four: one fact per sentence necessarily splits sentences, and the cap that
    // actually bounds length is the word count, which is gated and did not move.
    expect(p).toContain('At most five sentences')
    expect(p).toContain('67 words')
  })

  it('the cap fits the 90-word ceiling now the writer owns the CTA too', () => {
    // Measured live: the approved CTA no longer consumes budget, so what stays fixed is
    // the greeting, P3 and the two sign-off lines. Tightest variant (D) leaves 70 words.
    expect(OPENING_MAX_WORDS).toBeLessThanOrEqual(70)
  })

  it('the cap is set to the measured headroom, not below it', () => {
    // It was 62 against 70 of headroom, and rejected a prospect at 70 words against a limit the
    // email did not have. Pinned from BOTH sides so a future tightening is as visible as a
    // future raise: too low silently costs prospects, too high silently breaches 90.
    expect(OPENING_MAX_WORDS).toBe(67)
  })

  it('the two dossier failures are stated as rules, not as quoted copy', () => {
    // THE TEST'S OLD PURPOSE GOES WITH THE EXAMPLES. It existed to keep two quoted
    // openings in the prompt. What it protected is now prose.
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('Writing in the third person, about them rather than to them, is a dossier entry')
    expect(flat).toContain('reciting their own CV back at them is still wrong')
    expect(flat).not.toContain('Jason left Pani')
    expect(flat).not.toContain('You left Visteon')
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
    const p = buildWriterPrompt()
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('[YOUR CLOSING QUESTION GOES HERE]')
    expect(flat).toContain('The offer line in the middle is FIXED')
    // The skeleton now names the slot and points at the assignment block, rather than
    // interpolating the variant's own P3, which is what made the prompt cacheable.
    expect(flat).toContain('THE OFFER LINE')
    expect(flat).toContain('ASSIGNMENT block')
  })

  it('carries no approved CTA of its own, and defers register to the assignment', () => {
    // PURPOSE SURVIVES, MECHANISM CHANGED. Register still reaches the writer, but only
    // through the variant's own CTA in the ASSIGNMENT block, which is per-prospect text
    // outside the cached system prompt. The four anchors were the most-copied specimens
    // on the page: six of twelve prospects returned one word for word.
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).not.toContain('Is pipeline consistency something you\'re actively trying to fix?')
    expect(flat).not.toContain('Is getting more conversations in front of you something you\'re working on?')
    expect(flat).not.toContain('Is this a gap you\'re looking to close?')
    expect(flat).not.toContain('Worth a look to see if it fits where you are?')
    expect(flat).toContain('The approved question for this particular variant is named in the ASSIGNMENT block')
  })

  it('states the question-aim rule without illustrating it', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('THE QUESTION MUST ASK ABOUT THE PROBLEM YOU JUST NAMED')
    expect(flat).not.toContain('builds an audience of browsers')
  })

  it('the cap fits the tightest variant with room to spare', () => {
    // Measured live: greeting + P3 + two sign-off lines leaves 70 words on variant D.
    // Three words of margin, down from eight. Eight was not caution, it was 8 words of
    // copy thrown away on every prospect, and two prospects lost to it outright.
    expect(OPENING_MAX_WORDS).toBeLessThanOrEqual(70 - 3)
  })
})


// ─── One fact per sentence, the first-read test, and the conditional second retry ───

describe('the writer prompt enforces one fact per sentence', () => {
  it('states the structural rule rather than a length rule', () => {
    const p = buildWriterPrompt()
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('ONE FACT PER SENTENCE')
    expect(flat).toContain('about STRUCTURE, not length')
    expect(flat).toContain('If you are naming two things, use two sentences')
    // The reading-age line was removed deliberately: it measured word difficulty while the
    // real failures were figurative. What replaces it is the camera test.
    expect(flat).not.toContain('reading at eleven years old')
    expect(flat).toContain('a sentence they go back over has already lost')
  })

  it('keeps the diagnosis of the cramped shape, without the shape', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('a verb whose subject is three clauses back')
    expect(flat).toContain('an appositive list that swallows the subject')
  })

  it('still says the fix is the joins, not the facts', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('sentences that each carry a single idea')
    // The line that stops it being read as "make it shorter".
    expect(flat).toContain('Only the joins moved')
  })
})

describe('the judge tests the first read, still as one question', () => {
  it('asks about reading once at speed without re-reading ANY sentence', () => {
    const flat = buildJudgePrompt('THE_BUYER_TITLE').replace(/\s+/g, ' ')
    // Widened from "the first paragraph": the observation and the bridge are now two
    // paragraphs, so a test scoped to the first one would miss the bridge entirely.
    expect(flat).toContain('read once, at speed, without going back over any sentence')
    expect(flat).not.toContain('the first paragraph')
  })

  it('is still exactly one question and still not a checklist', () => {
    const p = buildJudgePrompt('THE_BUYER_TITLE')
    expect((p.match(/\?/g) ?? []).length).toBe(1)
    expect(p).not.toContain('1.')
    expect(p).not.toContain('- ')
  })

  it('still keeps the closing-question test in the same sentence', () => {
    const flat = buildJudgePrompt('THE_BUYER_TITLE').replace(/\s+/g, ' ')
    expect(flat).toContain('the obvious thing to ask them')
  })
})


// ─── Digestibility, varied bridge shapes, and batch uniqueness ───────────────

describe('the writer prompt targets load before resolution, not length', () => {
  const prompt = () => buildWriterPrompt()

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

  it('keeps the diagnosis of load, without the two sentences that carried it', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('ten words before the verb')
    expect(flat).toContain('three relative clauses, one nested inside another')
    // The half that stops the fix being read as "make it shorter".
    expect(flat).toContain('barely shorter')
    expect(flat).toContain('Nothing is dropped and nothing is softened')
  })
})

describe('the writer prompt varies the bridge construction', () => {
  const prompt = () => buildWriterPrompt()

  it('names the frame that collapsed and says why it matters', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('NAME THE PATTERN IN A DIFFERENT SHAPE EVERY TIME')
    expect(flat).toContain('"Firms that X often find Y" is one construction')
    expect(flat).toContain('eleven bridges built on that frame')
  })

  it('offers four genuinely different shapes, each labelled, none illustrated', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('A CONDITIONAL')
    expect(flat).toContain('WHAT USUALLY HAPPENS NEXT')
    expect(flat).toContain('A CONTRAST')
    expect(flat).toContain('A CONSEQUENCE')
    // The illustrations are gone. Naming the shape is now the whole instruction.
    expect(flat).not.toContain('A dentist:')
    expect(flat).not.toContain('A wedding photographer:')
  })

  it('states the batch rule, not just the preference', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('must not share a sentence shape with another prospect in this batch')
    expect(flat).toContain('Vary the CONSTRUCTION, not just the nouns')
  })
})

describe('the writer prompt treats the approved questions as register, not a menu', () => {
  const prompt = () => buildWriterPrompt()

  it('says write, do not pick', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('WRITE THE CLOSING QUESTION. DO NOT PICK ONE')
    expect(flat).toContain('It is not a menu')
    expect(flat).toContain('Your default is to WRITE a question for this prospect')
    expect(flat).toContain('which will be rare')
  })

  it('cites the actual collapse so the instruction has a reason attached', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('six of them carried the same approved question word for word')
  })

  // The variant CTA moved into the assignment block so the system prompt could become a
  // cacheable constant. The register-only framing still has to reach the writer, so it is
  // now asserted on both halves: the prompt points at the assignment, the assignment carries
  // the question and repeats the framing.
  it('extends the register-only framing to the variant CTA it is handed', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('The approved question for this particular variant is named in the ASSIGNMENT block')
    expect(flat).toContain('It is not a menu and it is not an instruction to reuse it')

    const assignment = buildWriterAssignment({ clientName: 'Acme', buyer: 'THE_BUYER_TITLE', p3: 'x', cta: 'Worth a look?' })
      .replace(/\s+/g, ' ')
    expect(assignment).toContain('The approved closing question for this particular variant is "Worth a look?"')
    expect(assignment).toContain('it shows register and length')
    expect(assignment).toContain('It is not an instruction to reuse it')
  })

  it('states the batch-uniqueness rule for questions too', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('no two prospects in this batch may get the same closing question')
    expect(flat).toContain('do not reword it slightly')
  })
})

describe('the writer prompt asks for three paragraphs, returned as three blocks', () => {
  const prompt = () => buildWriterPrompt()

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

  it('asks for exactly four labelled blocks, with the subject last', () => {
    const p = prompt()
    expect(p).toContain('exactly four labelled blocks')
    expect(p).toContain('OBSERVATION:')
    expect(p).toContain('BRIDGE:')
    expect(p).toContain('QUESTION:')
    expect(p).toContain('SUBJECT:')
    // Last, because it is written from the observation. Order is the instruction.
    expect(p.lastIndexOf('QUESTION:')).toBeLessThan(p.lastIndexOf('SUBJECT:'))
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


// ─── One question mark, and the punctuation it must not be mangled by ────────
//
// This whole block exists because splitting the bridge into its own paragraph and then
// listing sentence shapes to vary created a hole that did not exist before: a
// question-shaped bridge. It gives Email 1 two question marks against a standing house rule
// of one, and composition then appended a full stop after the '?', so a real prospect would
// have read "...after that hire?.".

describe('the opening may not carry its own question mark', () => {
  const FINDINGS_TEXT = 'Blue Sky hired a Manager of Delivery and Operations in March.'

  it('rejects a question-shaped bridge', () => {
    const opening = 'You hired a delivery lead in March.\n\nSo what fills the months after that hire? Is that a gap you are looking to close?'
    const failures = checkOpeningGates(opening, null, FINDINGS_TEXT)
    expect(failures.join(' ')).toContain('question marks')
  })

  it('passes the normal case: one question mark, the closing question', () => {
    const opening = 'You hired a delivery lead in March. A network fills the first months. Is that a gap you are looking to close?'
    expect(checkOpeningGates(opening, null, FINDINGS_TEXT)).toEqual([])
  })

  it('does not fire on zero question marks, which has its own clearer check', () => {
    // writeOnce reports a missing question separately. Two messages for one problem would
    // send the retry after the wrong thing.
    const opening = 'You hired a delivery lead in March. A network fills the first months.'
    expect(checkOpeningGates(opening, null, FINDINGS_TEXT).join(' ')).not.toContain('question marks')
  })

  it('the prompt states the same rule the gate enforces', () => {
    // CLAUDE.md: when a prompt and a validator enforce the same rule they must agree.
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('The bridge is NEVER a question')
    expect(flat).toContain('exactly one question mark and it is the closing question')
  })

  it('the prompt no longer offers a question as a bridge shape', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).not.toContain('There are more shapes than these four: a question')
  })
})


// ─── ATTRIBUTION MAY NOT OPEN THE BRIDGE ─────────────────────────────────────
//
// THE MEASUREMENT THAT BOUGHT THE RULE. The prompt already said attribution was optional
// and never a fixed opener, and it was becoming one anyway: 2 of 24 bridges opened with an
// attribution in one run and 6 of 20 in the next. Those openers spend 5 to 15 words before
// the claim begins, against a bridge budget of 22, and one of them spent 15. Mean bridge
// length rose from 19.2 words to 23.0 between the two runs, and all four length-gate
// failures in the second run were on over-budget bridges.
//
// "Optional" was doing no work, because nothing said WHERE. The rule now fixes the
// position: the claim first, the source after it if at all.
//
// AND THE ENDORSED EXAMPLE WENT WITH IT, which is the part worth noticing. The old rule
// sat directly above a worked ATTRIBUTED example whose whole first clause was an
// attribution. A page with eight recorded instances of an example being lifted verbatim
// into a prospect's email was teaching, by example, the exact shape the prose forbade.
// Tightening the words and leaving that example in place would have changed nothing.
// Nothing replaces it: an example of a permitted attribution is precisely the short,
// prospect-agnostic clause most likely to be copied.

describe('attribution may not open the bridge', () => {
  const flat = () => buildWriterPrompt().replace(/\s+/g, ' ')

  it('states the position, not just that attribution is optional', () => {
    expect(flat()).toContain('IT MAY NOT OPEN THE BRIDGE')
    expect(flat()).toContain('The claim comes first')
    expect(flat()).toContain('it is never the clause the bridge begins with')
  })

  it('gives the budget as the reason, at category level', () => {
    // CLAUDE.md: a rule states WHY. The number is interpolated from OPENING_BUDGET rather
    // than typed, so the prompt and the gate cannot disagree about what the budget is.
    const f = flat()
    expect(f).toContain('THE REASON IS THE BUDGET')
    expect(f).toContain(`The bridge is ${OPENING_BUDGET.bridge} words`)
    expect(f).toContain('before the sentence has said anything')
  })

  // ─── THE MUTATION TEST ─────────────────────────────────────────────────────
  //
  // Restoring the old rule text turns this red. Without it the two assertions above are
  // satisfied by ADDING the new prose beside the old, which is the change that would look
  // done and leave the endorsed attribution-first example in the prompt for the writer to
  // copy. Both halves of the old passage are named: the sentence that was too weak, and
  // the worked example that contradicted its replacement.
  it('the old rule and its attribution-first example are gone, not merely added to', () => {
    const f = flat()
    expect(f, 'the old, weaker sentence is back')
      .not.toContain('ATTRIBUTION IS OPTIONAL AND NEVER A FIXED OPENER')
    expect(f, 'the endorsed example opening on an attribution is back')
      .not.toContain('ATTRIBUTED, same claim, inside the bridge budget')
    expect(f, 'the endorsed attribution-first clause is back')
      .not.toContain('The founders I speak to describe the same split')
  })

  it('offers no worked example of a permitted attribution, and says so', () => {
    expect(flat()).toContain('NO EXAMPLE OF A PERMITTED ATTRIBUTION IS GIVEN')
  })

  it('still keeps attribution optional and still subject to the batch gate', () => {
    // The two properties the old passage carried that the tightening does NOT change.
    // Restricting where an attribution may sit is not the same as requiring one.
    const f = flat()
    expect(f).toContain('ATTRIBUTION IS OPTIONAL')
    expect(f).toContain('An unattributed pattern is still fine')
    expect(f).toContain('There is no house phrase for this')
  })
})


describe('the writer may not hand back the approved offer line', () => {
  const P3 = 'We get qualified conversations into the diary without pulling you out of delivery.'
  const FINDINGS_TEXT = 'Bob took on Publisher and CEO at Fitch Media alongside Fitch Consulting.'

  it('rejects the exact echo that shipped in Bob Email 1', () => {
    const opening = 'You took on Publisher and CEO at Fitch Media.\n\nTwo leadership positions running in parallel means prospecting is usually the first thing that waits. We get qualified conversations into the diary without pulling you out of delivery. Is this a gap you are looking to close?'
    expect(checkOpeningGates(opening, null, FINDINGS_TEXT, P3).join(' ')).toContain('repeats the approved offer line')
  })

  it('rejects a truncated echo, not just a verbatim one', () => {
    const opening = 'You took on a second role.\n\nWe get qualified conversations into the diary. Is this a gap?'
    expect(checkOpeningGates(opening, null, FINDINGS_TEXT, P3).join(' ')).toContain('repeats the approved offer line')
  })

  it('leaves a normal opening alone', () => {
    const opening = 'You took on Publisher and CEO at Fitch Media.\n\nTwo leadership roles at once means prospecting waits. Is this a gap you are looking to close?'
    expect(checkOpeningGates(opening, null, FINDINGS_TEXT, P3)).toEqual([])
  })

  it('does not fire on incidental shared words', () => {
    // "conversations" and "delivery" are ordinary vocabulary for this offer. Only an
    // eight-word run of the offer line itself counts.
    const opening = 'You hired a delivery lead.\n\nThe right conversations get harder to find. Is that a gap?'
    expect(checkOpeningGates(opening, null, 'Blue Sky hired a delivery lead.', P3)).toEqual([])
  })

  it('is inert when no approved P3 is supplied', () => {
    const opening = 'You took on a second role.\n\nProspecting waits. Is this a gap?'
    expect(checkOpeningGates(opening, null, FINDINGS_TEXT)).toEqual([])
  })
})


// ─── Cross-industry bridge examples, and concrete nouns ─────────────────────

describe('the bridge shapes are named and never illustrated', () => {
  const prompt = () => buildWriterPrompt()

  it('keeps the four constructions and labels none as preferred', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('A CONDITIONAL')
    expect(flat).toContain('WHAT USUALLY HAPPENS NEXT')
    expect(flat).toContain('A CONTRAST')
    expect(flat).toContain('A CONSEQUENCE')
    expect(flat).not.toContain('preferred answer')
  })

})

describe('the writer prompt bans abstract nouns and metaphors', () => {
  const prompt = () => buildWriterPrompt()

  it('names the reader cost, not just the rule', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('CONCRETE NOUNS ONLY')
    expect(flat).toContain('translate your sentence into their own week')
  })

  it('lists every banned noun', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    for (const noun of ABSTRACT_NOUNS) expect(flat).toContain(noun)
  })

  it('keeps load and output as judgement calls with both readings shown', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('Load and output are judgement calls, not bans')
    expect(flat).toContain('a real operational load')
    expect(flat).toContain('"that output"')
  })

  it('bans metaphors outright', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('NO METAPHORS')
    expect(flat).toContain('a picture the reader has to unpack')
  })

  it('keeps the abstraction diagnosis, without the sentences that carried it', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('Nobody can picture a remainder')
    expect(flat).toContain('A metaphor does work a plain sentence should do')
    expect(flat).toContain('names the place, the people and what is missing')
  })

})


// ─── The per-part budget, and attribution ───────────────────────────────────

describe('the budget is per part and sits below the gate', () => {
  it('sums to the stated target', () => {
    expect(OPENING_BUDGET.observation + OPENING_BUDGET.bridge + OPENING_BUDGET.question)
      .toBe(OPENING_TARGET_WORDS)
    expect(OPENING_TARGET_WORDS).toBe(58)
  })

  it('leaves real slack under the hard cap', () => {
    // The point of aiming low: a measured overshoot of roughly ten words has to land
    // inside the cap rather than outside it. Nine words of slack is what does that.
    expect(OPENING_TARGET_WORDS).toBeLessThan(OPENING_MAX_WORDS)
    expect(OPENING_MAX_WORDS - OPENING_TARGET_WORDS).toBeGreaterThanOrEqual(9)
  })

  it('the target is a target, not a second gate', () => {
    // A block over the target but inside the cap must pass. Tightening the gate to the
    // target would reject copy the email can hold and undo the headroom re-measurement.
    const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ')
    expect(checkOpeningGates(words(OPENING_TARGET_WORDS + 5), null, words(OPENING_TARGET_WORDS + 5))).toEqual([])
  })

  it('the prompt states each part separately, not just a total', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('A BUDGET PER PART, NOT ONE TOTAL')
    expect(flat).toContain(`observation about ${OPENING_BUDGET.observation} words`)
    expect(flat).toContain(`bridge about ${OPENING_BUDGET.bridge} words`)
    expect(flat).toContain(`closing question about ${OPENING_BUDGET.question} words`)
    expect(flat).toContain(`${OPENING_TARGET_WORDS} words in total`)
  })

  it('the prompt says which number is the target and which is the limit', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('These are TARGETS')
    expect(flat).toContain(`The HARD LIMIT is ${OPENING_MAX_WORDS} words`)
    expect(flat).toContain('Aim below the limit deliberately')
  })

  it('the prompt forbids borrowing between parts', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('CANNOT BORROW FROM ANOTHER')
    expect(flat).toContain('the worst possible place to economise')
  })
})

describe('a length failure names the part that is over', () => {
  const long = (n: number) => Array.from({ length: n }, () => 'word').join(' ')

  it('reports every part with its own count and target', () => {
    const observation = long(31)
    const bridge = long(32)
    const question = long(15)
    const combined = `${observation} ${bridge} ${question}`
    const msg = checkOpeningGates(combined, null, combined, undefined, { observation, bridge, question }).join(' ')
    expect(msg).toContain('observation 31 (target 22, OVER by 9)')
    expect(msg).toContain('bridge 32 (target 22, OVER by 10)')
    expect(msg).toContain('question 15 (target 14, OVER by 1)')
  })

  it('states both the hard cap and the target', () => {
    const observation = long(40), bridge = long(30), question = long(10)
    const combined = `${observation} ${bridge} ${question}`
    const msg = checkOpeningGates(combined, null, combined, undefined, { observation, bridge, question }).join(' ')
    expect(msg).toContain(`hard cap of ${OPENING_MAX_WORDS}`)
    expect(msg).toContain(`target of ${OPENING_TARGET_WORDS}`)
  })

  it('names only the parts actually over, and says not to rob another', () => {
    const observation = long(50), bridge = long(10), question = long(10)
    const combined = `${observation} ${bridge} ${question}`
    const msg = checkOpeningGates(combined, null, combined, undefined, { observation, bridge, question }).join(' ')
    expect(msg).toContain('Cut the observation.')
    expect(msg).not.toContain('Cut the observation and the bridge')
    expect(msg).toContain('Do not pay for it out of another part')
  })

  it('handles a block over the cap with every part inside its target', () => {
    // Possible because 22 + 22 + 14 leaves slack: three parts can each sit at target and
    // still clear 67 only if the targets are met. This covers the boundary rather than
    // leaving the message to say "cut the " with nothing after it.
    const observation = long(22), bridge = long(22), question = long(14)
    const padded = `${observation} ${bridge} ${question} ${long(20)}`
    const msg = checkOpeningGates(padded, null, padded, undefined, { observation, bridge, question }).join(' ')
    expect(msg).toContain('Every part is inside its target')
  })

  it('falls back to the plain total when no parts are supplied', () => {
    const combined = long(80)
    const msg = checkOpeningGates(combined, null, combined).join(' ')
    expect(msg).toBe(`opening is 80 words, cap is ${OPENING_MAX_WORDS}`)
  })
})

describe('the bridge may attribute, but only to the sender', () => {
  const prompt = () => buildWriterPrompt()

  it('allows the sender own experience and says why', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('YOU MAY ATTRIBUTE THE PATTERN, BUT ONLY TO YOURSELF')
    expect(flat).toContain('a claim about your own experience')
  })

  it('rules out the peer group as fact, and says it is not the softer option', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('attributing to THEIR peer group as fact')
    expect(flat).toContain('are not softer versions of the same thing')
    expect(flat).toContain('a verdict wearing a larger number')
    // Both real offenders, quoted so they cannot come back as "acceptable hedging".
    expect(flat).toContain("Here's the assumption most founders make")
    expect(flat).toContain('Most firms at this stage find')
  })

  it('forbids asserting a track record, and says nothing about how many clients exist', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('NEVER ASSERT A TRACK RECORD')
    expect(flat).toContain('unless the approved documents you were given state it outright')
    // THE HALF THAT MUST NOT COME BACK. The paragraph this replaced also said "There are
    // no clients yet", which was true of one client in one month and false for any client
    // with a customer base. The universal half is the rule; the count never was.
    expect(flat).not.toContain('There are no clients yet')
    expect(flat).not.toMatch(/no clients yet|first client(?:s)? we/i)
  })

  // WHERE THE REST OF THIS RULE IS NOW TESTED. Three tests stood here covering the
  // paragraph that said attribution was optional, and the worked ASSERTED/ATTRIBUTED pair
  // beneath it. That passage was replaced by a rule fixing attribution's POSITION, and the
  // endorsed example went with it because its first clause was an attribution. See
  // "attribution may not open the bridge" above.
})

// ─── The camera test and plain verbs ────────────────────────────────────────

describe('the writer prompt runs a camera test, not a reading age', () => {
  const prompt = () => buildWriterPrompt()

  it('drops the reading-age line and says why it failed', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).not.toContain('Someone reading at eleven years old should follow it')
    expect(flat).toContain('a reading age measures how hard the WORDS are')
    expect(flat).toContain('Eight easy words can describe nothing at all')
  })

  it('states the camera test and where the abstraction now hides', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('THE CAMERA TEST')
    expect(flat).toContain('Point a camera at their week')
    expect(flat).toContain('TWICE ON THE LAST FEW WORDS OF THE BRIDGE')
    expect(flat).toContain('the abstraction moved into the verbs and the endings')
  })

  it('says what the camera can and cannot see, without a worked pair', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('Nobody can photograph an hour shrinking')
    expect(flat).toContain('A calendar with a date on it, and something pushed to next week')
  })

  it('gives the verb rule as a do and a do-not list', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('PLAIN VERBS')
    expect(flat).toContain('something a PERSON DOES or something that PLAINLY HAPPENS')
    for (const good of ['waits', 'gets skipped', 'goes to someone else', 'never gets made']) {
      expect(flat).toContain(good)
    }
    for (const bad of ['moves', 'shrinks', 'becomes', 'converts', 'translates', 'materialises']) {
      expect(flat).toContain(bad)
    }
  })

  it('requires a concrete ending, with the contrast the brief gave', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('FINISH ON A CONCRETE THING, NOT A CATEGORY')
    expect(flat).toContain('"goes to whoever was in the room last" beats "rather than from anything systematic"')
  })

  it('keeps both camera diagnoses, without the four sentences that carried them', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('Hours do not grow')
    expect(flat).toContain('People do not become conversations')
    expect(flat).toContain('An inbox with nothing in it is filmable')
  })

})


// ─── The bridge states, it does not explain ─────────────────────────────────
//
// The observations came good: all ten inside the word target, seven of ten using "your",
// none abstract or accusatory. Every remaining fault was in the bridge and they shared one
// cause, so this section addresses that cause and nothing else.

describe('the bridge states one true thing', () => {
  const prompt = () => buildWriterPrompt()

  it('names the cause rather than listing symptoms', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('THE BRIDGE STATES ONE TRUE THING. IT NEVER EXPLAINS WHY')
    expect(flat).toContain('the bridge EXPLAINS when it should STATE')
  })

  it('states the rule without two endorsed bridges under it', () => {
    // THE TEST'S PURPOSE GOES WITH THE EXAMPLES. Both "working" bridges it pinned were
    // endorsed specimens, which is the category with every recorded copy incident.
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('the bridge EXPLAINS when it should STATE')
    expect(flat).not.toContain('are not reading your feed yet')
  })

  it('bans the causal shapes by name rather than by specimen', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('NO CAUSAL CONSTRUCTIONS')
    expect(flat).not.toContain('When delivery runs first for 13 months')
  })

  it('bans the causal constructions by name', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('NO CAUSAL CONSTRUCTIONS')
    expect(flat).toContain('No "when X, that tends to be Y"')
    expect(flat).toContain('No "because"')
    expect(flat).toContain('Say the consequence flat, in a sentence of its own')
  })

  it('prefers two short sentences to one conditional', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('TWO SHORT SENTENCES BEAT ONE CONDITIONAL')
    expect(flat).toContain('State the fact. Then state what follows')
  })

  it('forbids chaining back to the observation, and says why', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('DO NOT BUILD A CAUSAL CHAIN BACK TO THE OBSERVATION')
    expect(flat).toContain('the reader joins them without any help from you')
  })

  it('requires the observation and bridge to be read together', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('THEY MUST NOT CONTRADICT EACH OTHER')
    expect(flat).toContain('The reader is the one who notices')
  })
})

describe('two more things the bridge may not assume', () => {
  const prompt = () => buildWriterPrompt()

  it('bans assuming they have nobody, and ties it to the pipeline ban', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('DO NOT ASSUME THEY HAVE NOBODY')
    expect(flat).toContain('They probably have people')
    expect(flat).toContain('same error as claiming to know their pipeline')
    expect(flat).toContain('Never say who is or is not doing it')
  })

  it('extends the absence ban to implied choice', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('THE BAN COVERS IMPLIED CHOICE')
    expect(flat).toContain('Never tell the reader what they have decided to put first')
  })
})

// ─── The gap points at strangers, and the bridge follows its own observation ──

describe('the offer line rules one destination out without choosing the other', () => {
  const prompt = () => buildWriterPrompt()

  it('derives the rule from the offer line rather than naming a service', () => {
    // Stated as a principle so it holds for any client whose offer line generates rather
    // than follows up. Naming the product would make it one client's rule.
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('THE CONSEQUENCE MUST NOT TURN THE OFFER LINE INTO A DIFFERENT JOB')
    expect(flat).toContain('Go back to the offer line')
    expect(flat).toContain('whether it promises to GENERATE new conversations or to follow up on ones that already exist')
    expect(flat).toContain('It is not a fact about one product')
  })

  it('bans the three ways of naming an audience they already have', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('Never name a gap about converting, following up with, or re-engaging an audience they already have')
  })

  it('bans the three ways of naming an audience they already have, without specimens', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('Never name a gap about converting, following up with, or re-engaging an audience they already have')
    expect(flat).not.toContain('The right buyers hear it on the day')
  })

})

// ─── THE THREE RULE CHANGES OF 2026-08-31 ────────────────────────────────────
//
// WHY THESE EXIST. buildWriterPrompt taught the absence shape by EXAMPLE: ten endorsed
// worked examples landed the bridge on an absence, including both canonical clean
// bridges, and exactly one example was faulted for lacking one. No RULE ever asked for an
// absence. The only rule that came close legislated where a gap may sit while treating its
// existence as settled somewhere else, and it was not settled anywhere. The measured
// consequence: where the observation showed visible activity, the bridge asserted an
// absence that contradicted it.
//
// These tests hold the rules, not the examples. No example was touched in that pass, on
// purpose, so the next measurement reads how much of the fault the rules alone carried.
describe('the bridge names a consequence, and an absence is permitted but never required', () => {
  const prompt = () => buildWriterPrompt()

  it('the job definition asks for a consequence, not for a problem or a gap', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    // ESTABLISHED IN THE JOB DEFINITION, which is the point: every rule that assumes an
    // absence sits below this, so it has to be settled before they are read.
    expect(flat).toContain('naming the CONSEQUENCE that follows from the observation above it')
  })

  it('permits an absence without requiring one', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('A CONSEQUENCE MAY BE AN ABSENCE. IT DOES NOT HAVE TO BE.')
    expect(flat).toContain('do not manufacture one in order to have something to name')
    expect(flat).toContain('Nothing in these instructions requires a bridge to find a gap')
  })

  it('the offer-line rule constrains the consequence without choosing it', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    // WHAT WAS KEPT: a gap about an audience they already have still turns the offer line
    // into a different job. That half was always right.
    expect(flat).toContain('Never name a gap about converting, following up with, or re-engaging an audience they already have')
    // WHAT CHANGED: it no longer sends every bridge to strangers regardless of the
    // observation.
    expect(flat).toContain('THIS RULE RULES ONE DESTINATION OUT. IT DOES NOT CHOOSE THE OTHER.')
    expect(flat).not.toContain('the gap you name has to be about buyers who have never encountered this prospect')
  })

  it('makes the bridge engage with visible activity rather than deny it', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    // THE MEASURED FAULT THIS ANSWERS: two real prospects showing plain evidence of effort
    // were told that effort was absent.
    expect(flat).toContain('Where the observation shows visible activity, the consequence engages with that activity')
    expect(flat).toContain('Never assert an absence of effort against evidence of effort')
  })

  it('bans naming a channel or way of operating the observation does not evidence', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('Never name a channel, a source of work, or a way of operating that the observation does not evidence')
  })

  it('sends a consequence-free observation back rather than inventing a consequence', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('that observation was the wrong one to choose')
    expect(flat).toContain('Pick another finding')
  })
})

describe('the absence ban states its own scope and its own subject', () => {
  const prompt = () => buildWriterPrompt()

  it('says which paragraphs it covers, without a lookup into joinOpening', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    // THE OLD PHRASING was "never OPEN by naming what they lack", governing an example
    // that is a BRIDGE. "Opening" means observation and bridge together, and the only way
    // to learn that was to read joinOpening in another part of this file.
    expect(flat).toContain('"Opening" in these instructions means the observation and the bridge together')
    expect(flat).toContain('so it governs BOTH paragraphs')
  })

  it('locates the fault in the verdict, not in the absence', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('It is not a ban on absence')
    expect(flat).toContain('The fault is DELIVERING A VERDICT ON THE READER')
    expect(flat).toContain('An absence stated as a fact about a THING is permitted')
    expect(flat).toContain('An absence that implies a conclusion about their JUDGEMENT is not')
  })

  it('applies the same test to something present, which is the half that was missing', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('The same is true of something PRESENT')
    expect(flat).toContain('Being built on something visible exempts nothing')
    expect(flat).toContain('the bridge states a consequence, never a judgement, whether it is built on something present or something absent')
  })

  it('sits with its own exception rather than 426 lines from it', () => {
    // THE ORIGINAL FAULT, and it is a distance, so the assertion has to be one too. The
    // ban and the exception that names it were 426 lines apart and a reader met the
    // exception first. A substring check on either would pass in both worlds.
    const lines = prompt().split('\n')
    const ban = lines.findIndex(l => l.includes('NEVER NAME WHAT THEY LACK'))
    const exception = lines.findIndex(l => l.includes('THE BAN COVERS IMPLIED CHOICE'))
    expect(ban).toBeGreaterThan(-1)
    expect(exception).toBeGreaterThan(-1)
    // The ban comes FIRST. That ordering is the whole repair.
    expect(ban).toBeLessThan(exception)
    expect(exception - ban).toBeLessThan(40)
  })
})

describe('the bridge follows from its own observation', () => {
  const prompt = () => buildWriterPrompt()

  it('states the rule that the bridge follows its own observation', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('THE BRIDGE MUST FOLLOW FROM ITS OWN OBSERVATION')
    expect(flat).toContain('wondering when the subject changed')
  })

  it('gives a check the writer can actually run', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('ask whether the bridge could sit under ANY other observation')
    expect(flat).toContain('Rewrite it so it could only sit under the one you wrote')
  })
})

describe('two smaller bridge faults', () => {
  const prompt = () => buildWriterPrompt()

  it('names the empty change-of-state construction', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    // The banned SHAPE stays, quoted as a fragment. The sentence built on it does not.
    expect(flat).toContain('"until it does not" is a shape where a fact should be')
    expect(flat).not.toContain('Outreach for the new-business side sits')
  })

  it('keeps the budget lesson, without the bridge that taught it', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('The longest bridge in the last batch was 32 words')
    expect(flat).toContain('Two sentences, each standing on its own, and inside the bridge budget')
  })
})


// ─── THE NO-EXAMPLES EXPERIMENT ──────────────────────────────────────────────
//
// WHAT THIS BRANCH DID. Every worked example was removed from buildWriterPrompt and the
// rules kept. 77 quoted specimens, 68 of them distinct. The premise: this file has eight
// recorded instances of an example being copied verbatim into a real prospect's email, and
// two rounds of rule changes moved none of the four measured faults, so the examples may
// have been overriding the rules.
//
// THIS TEST GENERALISES `RULE ZERO` IN writer-four-rules.test.ts, which asserted the same
// property over four rule blocks. It now covers the whole prompt.

describe('the writer prompt carries no worked example', () => {
  // Quoted spans are extracted by SPLITTING on the quote character, not by a paired
  // regex. A regex with a length floor backtracks past a short pair and silently shifts
  // the parity, so from that point on it reports the text BETWEEN quotations as if it
  // were quoted. That version reported 25 spans, none of them real.
  function quotedSpans(text: string): string[] {
    const parts = text.replace(/\s+/g, ' ').split('"')
    expect((parts.length - 1) % 2, 'unbalanced quote characters in the prompt').toBe(0)
    return parts.filter((_, i) => i % 2 === 1)
  }

  // Every quoted span long enough to be lifted into an email. Each one is a banned SHAPE
  // the rule names, a permitted phrase, or a phrase from the shared firmographic rule.
  // None is a sendable observation, bridge or closing question.
  const ALLOWED = [
    'when X, that tends to be Y',
    'with no case studies',
    "Here's the assumption most founders make",
    'Most firms at this stage find',
    'Firms that X often find Y',
    'a real operational load',
    'goes to whoever was in the room last',
    'rather than from anything systematic',
    'The next conversation',
    'the next sales conversation',
    'that is not quite my problem',
    'your last three posts',
  ]

  it('every quoted span of 20+ characters is a named shape, not a sendable sentence', () => {
    const long = quotedSpans(buildWriterPrompt()).filter(q => q.length >= 20)
    expect(long.sort()).toEqual([...ALLOWED].sort())
  })

  it('names nobody: no prospect, company, school or place survives in the prompt', () => {
    // Measured on main: all 33 unvouched capitalised tokens flagged by prompt-names.test.ts
    // lived inside worked examples. Removing the examples takes that source to zero.
    const p = buildWriterPrompt()
    for (const name of [
      'Chamber', 'Blue Sky', 'HydrospherIQ', 'London', 'DTCC', 'Treasury', 'Taffet',
      'Hollywood', 'Sovern', 'SCG', 'Stanford', 'GSB', 'CAVE', 'Jason', 'Pani', 'Visteon',
    ]) {
      expect(p, `${name} is back in the prompt`).not.toContain(name)
    }
  })

  it('carries no FAILING / WORKING / CRAMPED / ABSTRACT specimen labels', () => {
    // The labels are how a worked example was introduced. No label, no example.
    const p = buildWriterPrompt()
    for (const label of [
      // 'AIMED WRONG' without the colon is rule prose further down ("THE BRIDGE IS AIMED
      // WRONG"), so the label form is what is asserted, not the phrase.
      'FAILING:', 'WORKING:', 'AIMED WRONG:', 'AIMED RIGHT,', 'CRAMPED:', 'CLEAN:',
      'ABSTRACT,', 'CONCRETE,', 'HARD, and this shipped', 'EASY, and this shipped',
      'PATTERN, corrected', 'VERDICT,', 'THE THREE WORKED PAIRS',
    ]) {
      expect(p, `specimen label back in the prompt: ${label}`).not.toContain(label)
    }
  })

  it('the prompt is still a zero-argument constant', () => {
    expect(buildWriterPrompt.length).toBe(0)
    expect(buildWriterPrompt()).toBe(buildWriterPrompt())
  })
})
