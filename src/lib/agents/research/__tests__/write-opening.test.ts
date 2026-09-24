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
  buildFindingsEvidence,
  buildWriterPrompt,
  buildWriterAssignment,
  buildJudgePrompt,
  joinOpening,
  OPENING_MAX_WORDS,
  OPENING_BUDGET,
  OPENING_TARGET_WORDS,
  WRITER_MAX_SENTENCE_WORDS,
  OBSERVATION_MAX_WORDS,
} from '../write-opening'
import { BatchUniquenessRegistry } from '../batch-uniqueness'
import { MAX_SENTENCE_WORDS } from '@/lib/style/readability'
import { ABSTRACT_NOUNS, countAbstractNouns, countFigurativeVerbs } from '@/lib/style/abstract-nouns'
import { shapeModels, concreteRewrites, plainRewrites, printShopBridge } from './writer-prompt-specimens'
import type { ObservationCandidate } from '../types'

const FINDINGS = [
  'Green Field is hiring delivery consultants, posted 2026 on LinkedIn.',
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
    const opening = 'Devon left Calder as Director of Product in July 2024.'
    const failures = checkOpeningGates(opening, 'Devon', 'Devon left Calder as Director of Product in July 2024.')
    expect(failures.some(f => f.includes('names the prospect'))).toBe(true)
  })

  it('passes the same fact written to the prospect', () => {
    const opening = 'You left Calder in July 2024.'
    expect(checkOpeningGates(opening, 'Devon', 'Devon left Calder in July 2024.')).toEqual([])
  })

  it('does not fire when the first name is absent from prospects', () => {
    expect(checkOpeningGates('You left Calder in July 2024.', null, 'left Calder in July 2024')).toEqual([])
  })
})

describe('gate: firmographic figures', () => {
  it('fails the real "$5M consulting firm" that shipped in Sasha\'s opening', () => {
    const findings = 'Acme Consulting is a $5M consulting firm launching Acme Media.'
    const failures = checkOpeningGates('Launching Acme Media while running a $5M consulting firm is a real plate to spin.', null, findings)
    expect(failures.some(f => f.includes('firmographic') || f.includes("prospect's record"))).toBe(true)
  })

  it('fails even though the figure IS in the findings, which is the point', () => {
    // Traceability passes it. Being sourced is what makes a revenue figure dangerous.
    const findings = 'Apollo reports 12 employees.'
    expect(checkOpeningGates('You have 12 employees now.', null, findings).length).toBeGreaterThan(0)
  })

  it('leaves dates, tenures and post counts alone', () => {
    const findings = 'Fourteen months running ORRIN. Three posts since 2016. Last 30 reviews.'
    expect(checkOpeningGates('Fourteen months running ORRIN says a lot, and your last 30 reviews show it.', null, findings)).toEqual([])
  })
})

describe('gate: factual traceability', () => {
  it('passes claims that appear in the findings', () => {
    const opening = 'Green Field is hiring delivery consultants. There is no blog and no case studies.'
    expect(checkOpeningGates(opening, null, FINDINGS)).toEqual([])
  })

  it('fails an invented number', () => {
    const opening = 'Green Field is hiring delivery consultants and now has 47 people.'
    const failures = checkOpeningGates(opening, null, FINDINGS)
    expect(failures.some(f => f.includes('47'))).toBe(true)
  })

  it('fails an invented proper noun', () => {
    const opening = 'Green Field is hiring delivery consultants after the Fastrack acquisition.'
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

  it('tracks written_won against the assigned label, not the letter', () => {
    // Same reply, opposite mapping: the written version was labelled B this time.
    const r = parseChoice('CHOICE: B\nREASON: Sharper opening.', 'B')
    expect(r.written_won).toBe(true)
  })

  it('reads the REASON-first order the judge prompt now asks for', () => {
    // buildJudgePrompt emits REASON before CHOICE so the reason cannot be written
    // after the choice is already fixed. The reason match is greedy to end-of-string,
    // so this is the case that would silently capture the CHOICE line into the reason.
    const r = parseChoice('REASON: The opening earns the offer line.\nCHOICE: A', 'A')
    expect(r.chosen).toBe('A')
    expect(r.written_won).toBe(true)
    expect(r.reason).toBe('The opening earns the offer line.')
  })

  it('still reads the old CHOICE-first order, so the swap is not a one-way door', () => {
    const r = parseChoice('CHOICE: B\nREASON: Template is sharper.', 'B')
    expect(r.chosen).toBe('B')
    expect(r.reason).toBe('Template is sharper.')
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

  // ── What synthesis passes forward, and what it deliberately does not ────────

  const withCounter = (id: string, total: number, obs: string, opposite: string | null): ObservationCandidate => ({
    ...cand(id, total, obs),
    opposite_reading: opposite,
    inference_direction: opposite ? 'compatible_with_both' : 'ambiguous_unhandled',
  })

  it('passes the counter-reading and its direction for every candidate', () => {
    const block = buildFindingsBlock([withCounter('c1', 6, 'a finding', 'THE_OPPOSITE_CONCLUSION')])
    expect(block).toContain('THE_OPPOSITE_CONCLUSION')
    expect(block).toContain('compatible_with_both')
  })

  it('says so when a candidate has no counter-reading, rather than omitting the line', () => {
    // Silence would read as "no counter-reading exists", which is the opposite of the
    // truth: a missing one is exactly the case the writer must not build a conclusion on.
    const block = buildFindingsBlock([withCounter('c1', 6, 'a finding', null)])
    expect(block).toContain('none supplied')
  })

  it('marks the selected candidate and only that one', () => {
    const block = buildFindingsBlock(
      [withCounter('c1', 6, 'chosen finding', 'x'), withCounter('c2', 5, 'other finding', 'y')],
      { selectedCandidateId: 'c1' },
    )
    expect(block.match(/\[SELECTED BY SYNTHESIS\]/g)).toHaveLength(1)
    expect(block.slice(0, block.indexOf('other finding'))).toContain('[SELECTED BY SYNTHESIS]')
  })

  it('marks nothing when no candidate was selected, which is the stored-findings case', () => {
    const block = buildFindingsBlock([withCounter('c1', 6, 'a finding', 'x')], { selectedCandidateId: null })
    expect(block).not.toContain('SELECTED BY SYNTHESIS')
  })

  it('carries the relevance reason once, for the result rather than per candidate', () => {
    const block = buildFindingsBlock(
      [withCounter('c1', 6, 'a', 'x'), withCounter('c2', 5, 'b', 'y')],
      { relevanceReason: 'THE_RELEVANCE_REASON' },
    )
    expect(block.match(/THE_RELEVANCE_REASON/g)).toHaveLength(1)
  })

  it('passes no score, no test booleans and no readability verdict', () => {
    const block = buildFindingsBlock(
      [withCounter('c1', 6, 'a finding', 'x')],
      { selectedCandidateId: 'c1', relevanceReason: 'because' },
    )
    // Every field named here is either downstream of a test the writer does not run, or a
    // gate the writer's own output is measured against separately. Showing the writer how
    // it is about to be marked is an invitation to write to the mark.
    for (const banned of [
      'score_total', 'passes_all', 'specific', 'verifiable', 'inferential',
      'useful', 'non_judgemental', 'demoted', 'model_readable_claim',
      'readable', 'readability', 'penalty', 'hard_fail', 'nominalisation',
    ]) {
      expect(block).not.toContain(banned)
    }
    // And no bare six-out-of-six style score leaks in as a number either.
    expect(block).not.toMatch(/\b6\s*\/\s*6\b/)
  })
})

// THE GATE CORPUS MUST NOT WIDEN. This is the test that would fail if someone later
// "simplified" the two findings functions back into one.
//
// untraceableClaims asks whether a proper noun in the written opening appears anywhere in
// the findings corpus. It is a substring test, so anything added to that corpus becomes
// evidence. A counter-reading is prose about the same evidence and carries the same names,
// so folding it in would silently mark as traceable a name the writer was told not to
// build on, and the gate would keep returning an empty array while covering less.
describe('findings evidence corpus is narrower than the findings prompt block', () => {
  const candWithCounter = (obs: string, opposite: string): ObservationCandidate => ({
    id: 'c1', observation: obs, source: 'apollo', provenance: 'Apollo employment_history',
    date: null, is_composite: false,
    scores: { specific: true, verifiable: true, inferential: true, relevant: true, useful: true, non_judgemental: true },
    passes_all: true, score_total: 6, model_readable_claim: true,
    opposite_reading: opposite, inference_direction: 'compatible_with_both',
    readability: { hard_fail: false, penalty: 0, max_sentence_words: 5, hedges: [], nominalisation_density: 0, nominalisation_over_threshold: false, reasons: [] },
    demoted: false, rejection_reason: null,
  })

  const cands = [candWithCounter('You took a second role in March.', 'They left Wexbourne because their own firm got busy.')]

  it('the evidence corpus excludes the counter-reading the prompt block includes', () => {
    expect(buildFindingsBlock(cands)).toContain('Wexbourne')
    expect(buildFindingsEvidence(cands)).not.toContain('Wexbourne')
  })

  it('a name that appears only in a counter-reading is still untraceable to the gate', () => {
    const failures = checkOpeningGates(
      'You took a second role in March. Wexbourne is where the work went.',
      null,
      buildFindingsEvidence(cands),
    )
    expect(failures.join(' ')).toContain('Wexbourne')
  })

  it('and would NOT be, if the gate were fed the prompt block instead', () => {
    // The mutation, written out. If this ever stops passing, the two functions have been
    // merged and the traceability gate has quietly stopped covering counter-readings.
    const failures = checkOpeningGates(
      'You took a second role in March. Wexbourne is where the work went.',
      null,
      buildFindingsBlock(cands),
    )
    expect(failures.join(' ')).not.toContain('Wexbourne')
  })
})

describe('prompt shape', () => {
  // WAS: "the writer prompt embeds the variant P3 and CTA verbatim". They moved to the
  // assignment block in the user message on 2026-08-25 so the system prompt is a constant
  // and can be cached. The prompt is ~9,300 tokens and the writer call runs up to three
  // times per prospect, so a per-variant prefix was costing a full re-read every attempt.
  // CHANGED 2026-09-24. The assignment carried the variant's offer line, and the writer is
  // no longer shown it at all: told to lead into it, the writer restated it, and the echo
  // gate rejected the whole variant. Measured across two identical cohorts of 20, the echo
  // went from 1 to 5. The offer line is composed in afterwards and the gate is unchanged.
  it('the assignment block carries the reason, and NOT the offer line or the approved question', () => {
    const a = buildWriterAssignment({
      clientName: 'Acme', buyer: 'THE_BUYER_TITLE',
      prospectReason: 'THE_REASON_SENTENCE',
    })
    expect(a).toContain('THE_REASON_SENTENCE')
    expect(a).toContain('Acme')
    expect(a).not.toMatch(/OFFER LINE/i)
    // CHANGED 2026-09-24, second half of the same day's change. The assignment used to
    // carry the variant's approved closing question "to show register and length". The
    // writer handed it back: eight of nine shipped questions ended in the same four words.
    // The signature no longer accepts it, so there is no value to leak; this asserts the
    // block cannot grow one back by any other route.
    expect(a).not.toMatch(/approved closing question/i)
    expect(a).not.toMatch(/\?/)
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
    expect(p).toContain('Never name what they lack')
    expect(p).not.toContain('NEVER OPEN BY NAMING WHAT THEY LACK')
  })

  it('the writer prompt still bans absence openers and names what IS observable', () => {
    const p = buildWriterPrompt()
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('Never name what they lack')
    expect(flat).toContain('Notice something that IS there instead')
    // Says explicitly what is visible, so the writer is not guessing at the boundary.
    expect(flat).toContain('what they posted, what they published, who they hired')
    expect(p).not.toContain('There is no blog, no case studies')
  })

  it('the writer prompt bans verdicts and carries both real failures verbatim', () => {
    const p = buildWriterPrompt()
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('THE BRIDGE NAMES A PATTERN. IT NEVER DELIVERS A VERDICT')
    // The first: the bridge that was actually wrong, not merely presumptuous.
    expect(flat).toContain('What a Chamber event and a strong network cannot do')
    // The second: invented outright.
    expect(flat).toContain('a firm that size fills its diary through relationships')
    // The corrected half no longer belongs to the first case. The writer reproduced it
    // almost verbatim, so it was re-welded to a print shop, whose facts belong to nobody
    // in the batch.
    expect(flat).toContain('Your second press needs work from customers you have not quoted yet')
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
    expect(flat).toContain('Most firms at this stage find pipeline slips')
    expect(flat).toContain('reads as a non-sequitur without its observation')
  })

  it('the writer prompt requires clarity on one reading, with the Stephen riddle', () => {
    const p = buildWriterPrompt()
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('EVERY SENTENCE MUST BE CLEAR ON ONE READING')
    // Correctly pattern-framed and still a riddle: stance alone is not enough.
    expect(flat).toContain('goes uncontested to whoever stayed visible')
  })

  it('the writer prompt aims the bridge at the REASON, with the Rowan failure verbatim', () => {
    const p = buildWriterPrompt()
    const flat = p.replace(/\s+/g, ' ')
    // CHANGED 2026-09-24. The instruction used to be START BY READING THE OFFER LINE, and
    // the writer was told to work out which problem it answers and aim at that. Two offer
    // lines say the sender does the prospecting, so the target the writer derived was "this
    // reader does their own prospecting", which is an assumption about a stranger's
    // staffing that then appeared in the copy run after run.
    //
    // CHANGED AGAIN THE SAME DAY. The replacement told the writer the offer line was what
    // the email LEADS INTO, and still showed it the line. The writer copies what it is
    // shown: the echo gate went from 1 rejection in 20 to 5 in 20 across two identical
    // cohorts. The offer line is now removed from everything the writer sees, and it is
    // composed in afterwards. The gate that catches an echo is unchanged.
    expect(p).toContain('START BY READING THE REASON')
    expect(p).not.toMatch(/LEADS INTO/i)
    expect(p).not.toMatch(/offer line/i)
    expect(p).toContain('AIMED WRONG:')
    expect(p).toContain('AIMED RIGHT')
    // The real failure, verbatim.
    expect(flat).toContain('The clients you actually want are a different current')
    expect(flat).toContain('Is getting more conversations in front of you something')
    // And the explicit test for aiming.
    expect(flat).toContain('that is not quite my problem')
    // CHANGED 2026-09-10. The AIMED RIGHT bridge compared the right clients with the
    // observation ("take longer", "a different route") and so pointed back at it. No fix was
    // possible without a fact the example did not have, so it is described, not shown.
    expect(flat).toContain('AIMED RIGHT is not shown as a sentence, deliberately')
    expect(flat).not.toContain('Collaborators find you first')
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

  it('both FAILING examples are retained', () => {
    const p = buildWriterPrompt()
    expect(p).toContain('Devon left Calder as Director of Product')
    expect(p).toContain('You left Visteon at SVP level')
  })
})

describe('possessive forms are traceable', () => {
  it('does not flag "SCG\'s" when the findings contain "SCG"', () => {
    const findings = 'Ines left Beta Strategies in June 2024, making SCG her sole focus.'
    expect(checkOpeningGates("You left Beta Strategies in June 2024. SCG's been the focus since.", null, findings)).toEqual([])
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

describe('the writer prompt carries the question job and the Rowan failure', () => {
  it('names the three parts and pins the middle paragraph as fixed AND unseen', () => {
    const p = buildWriterPrompt()
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('[YOUR CLOSING QUESTION GOES HERE]')
    // The slot still exists, so the writer knows a paragraph sits between the bridge and
    // the question. Its TEXT is gone, and so is every instruction to read it.
    expect(flat).toContain('A FIXED PARAGRAPH YOU DO NOT WRITE AND ARE NOT SHOWN')
    expect(flat).toContain('The paragraph in the middle is FIXED and you are not shown it')
    expect(flat).not.toMatch(/THE OFFER LINE/)
  })

  it('carries no sendable anchor questions, only a description of the register', () => {
    // CHANGED 2026-09-10. This test used to require the four approved CTAs in the system
    // prompt. The prompt is byte-identical for every client, so those four were one client's
    // copy shown to every client's writer, and six of twelve prospects shipped one verbatim.
    // They were deleted. The register is now described, and the anchor is the variant's own
    // approved question, which the assignment block already carries.
    const p = buildWriterPrompt()
    const flat = p.replace(/\s+/g, ' ')
    expect(flat).not.toContain('Is pipeline consistency something you\'re actively trying to fix?')
    expect(flat).not.toContain('Is this a gap you\'re looking to close?')
    expect(flat).not.toContain('Worth a look to see if it fits where you are?')
    // The second of the four still appears inside two FAILING examples, as the question the
    // bridge ran into, so a whole-prompt check on it would pass for the wrong reason. The
    // closing-question section is checked on its own instead.
    const from = p.indexOf('WRITE THE CLOSING QUESTION. YOU ARE NOT SHOWN ONE.')
    const to = p.indexOf('And no two prospects in this batch')
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    const section = p.slice(from, to)
    expect(section).not.toMatch(/"[^"]*\?"/)
    expect(section.replace(/\s+/g, ' ')).toContain('There is no approved question in front of you, deliberately')
  })

  it('carries the Rowan browsers-versus-buyers failure verbatim, with a correction', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('builds an audience of browsers before it builds a pipeline of buyers')
    expect(flat).toContain('She does not want more. She wants different ones.')
    expect(flat).toContain('Is turning browsers into the right kind of buyer something you\'re working on?')
  })

  it('the cap fits the tightest variant with room to spare', () => {
    // Measured live: greeting + P3 + two sign-off lines leaves 70 words on variant D.
    // Three words of margin, down from eight. Eight was not caution, it was 8 words of
    // copy thrown away on every prospect, and two prospects lost to it outright.
    expect(OPENING_MAX_WORDS).toBeLessThanOrEqual(70 - 3)
  })
})


// ═══════════════════════════════════════════════════════════════════════════════
// NO RULE TELLS THE WRITER TO DO SOMETHING ANOTHER RULE REJECTS.
//
// This is the claim the 2026-09-24 change was made for, and it is asserted here rather than
// argued in a comment, because the contradiction it replaces survived in this file for a day
// while every individual rule read as sensible on its own.
describe('the prompt and the gates agree about the observation', () => {
  it('the target sits BELOW the hard cap, so the target is reachable', () => {
    // The whole defect in one line. Before this, the target was 22 and the reachable maximum
    // was WRITER_MAX_SENTENCE_WORDS (18), because the observation had to be one sentence.
    expect(OPENING_BUDGET.observation).toBeLessThan(OBSERVATION_MAX_WORDS)
  })

  it('every sentence-level cap is reachable inside the observation cap', () => {
    // The two limits must not overlap: one bounds the PART, the other bounds a SENTENCE in
    // it. A per-sentence cap at or above the part cap would make the sentence rule dead, and
    // a part cap below it would make a legal sentence illegal as a part.
    expect(WRITER_MAX_SENTENCE_WORDS).toBeLessThan(OBSERVATION_MAX_WORDS)
  })

  it('the prompt states the observation cap the gate enforces', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain(`AT MOST ${OBSERVATION_MAX_WORDS} WORDS`)
    expect(flat).toContain(`HARD LIMIT ${OBSERVATION_MAX_WORDS}`)
  })

  it('the prompt never asks the observation for one sentence', () => {
    // POSITIVE CONTROL ON THE ABSENCE: the prompt must still say what the observation IS
    // limited by, or this assertion would also pass on a prompt that says nothing at all.
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).not.toContain('ONE SENTENCE. Name what you noticed and stop')
    expect(flat).not.toContain('The observation names ONE thing, in one sentence')
    expect(flat).toContain('Use one sentence or two')
  })

  it('the prompt tells the bridge to shorten and the observation to split', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('IN THE OBSERVATION, two short sentences beat one long one')
    expect(flat).toContain('IN THE BRIDGE THERE IS NO SPLIT AVAILABLE')
  })
})

// ─── One fact per sentence, the first-read test, and the conditional second retry ───

describe('the writer prompt enforces one fact per sentence', () => {
  it('states the structural rule rather than a length rule', () => {
    const p = buildWriterPrompt()
    const flat = p.replace(/\s+/g, ' ')
    expect(p).toContain('ONE FACT PER SENTENCE')
    expect(flat).toContain('about STRUCTURE, not length')
    // CHANGED TWICE ON 2026-09-24, and the second change reversed the first. The rule was
    // tightened to "in one sentence" to match a one-sentence observation gate; that gate
    // contradicted the sentence-length gate and was replaced by a total word limit, so the
    // prompt goes back to constraining the FACT rather than the sentence count. The
    // structural claim this test is about never moved: one fact per sentence.
    expect(flat).toContain('The observation names ONE thing and the bridge is ONE sentence')
    // The reading-age line was removed deliberately: it measured word difficulty while the
    // real failures were figurative. What replaces it is the camera test.
    expect(flat).not.toContain('reading at eleven years old')
    expect(flat).toContain('a sentence they go back over has already lost')
  })

  it('carries both cramped examples, each with the diagnosis of why it fails', () => {
    // CHANGED 2026-09-10. Both used to be real shipped sentences carrying real organisation
    // names. They were replaced with constructed examples from industries no prospect is in,
    // and the label no longer claims they shipped.
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    // The first, and the diagnosis of why it fails.
    expect(flat).toContain('The latest Friday post. A fig sourdough, rye, spelt, goes up on your shop page at seven.')
    expect(flat).toContain('a verb whose subject is three clauses back')
    // The second.
    expect(flat).toContain('The town hall and the station hotel, on top of a shop open six days a week, is a lot of flowers.')
    expect(flat).toContain('An appositive list swallows the subject')
    expect(flat).not.toContain('CRAMPED, and both of these shipped')
  })

  it('pairs each cramped example with a clean rewrite of the same facts', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('You post the Friday bake on your shop page at seven. Your latest Friday post showed a fig sourdough, rye and spelt.')
    // "already" carries the move this pair exists for: the new commitment sits on top of
    // work that was already there.
    expect(flat).toContain('You took on two standing orders in March, for the town hall and the station hotel. Your shop was already open six days a week.')
    // And says explicitly that only the joins moved, so it is not read as "make it shorter".
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

  it('carries the hard and easy pair, plus a rewrite of the hard one', () => {
    // REFRAMED, NOT REMOVED. Both halves used to be built on "[population] often find X",
    // which is the shape "NEVER TELL THE READER WHAT PEOPLE LIKE THEM THINK" now bans, and
    // the EASY half was endorsed. The prompt was showing the banned frame working one page
    // after banning it. The structural lesson is what this test guards, so the assertions
    // are on the STRUCTURE each half demonstrates, not on the sentences it happens to use.
    const flat = prompt().replace(/\s+/g, ' ')
    // The hard sentence: a long qualified subject, and the diagnosis that names why.
    expect(flat).toContain('The pipeline at firms that rely on the conference appearances that bring in new conversations')
    expect(flat).toContain('Fifteen words before the verb')
    expect(flat).toContain('Three relative clauses, one nested inside another')
    // The easy sentence, to show the fix is not "make it shorter".
    expect(flat).toContain('Most homeowners sign the cheapest of the three window quotes that land on the doormat in the same week.')
    expect(flat).toContain('length is not what changed')
    expect(flat).toContain('A two-word subject, one relative clause, nothing nested')
    // And the rewrite of the hard one, same facts.
    expect(flat).toContain('At firms that rely on conferences, the pipeline follows the event calendar rather than delivery demand.')
    expect(flat).toContain('A short subject, one relative clause, and the verb arrives early')
    expect(flat).toContain('Nothing was dropped and nothing was softened')
  })

  it('neither half of the pair uses the banned frame any more', () => {
    // SCOPED TO THE PAIR ON PURPOSE. The frame survives twice elsewhere in the prompt and
    // both survivors are REJECTED specimens: the construction that collapsed across a batch,
    // and the one labelled generic and therefore useless. A rejected instance of a banned
    // shape is the prompt working. An ENDORSED one is the contradiction this closes, so the
    // assertion runs on the digestibility block and nowhere else.
    const p = prompt()
    const from = p.indexOf('DIGESTIBILITY. THIS IS WHAT MAKES A SENTENCE NEED A SECOND PASS')
    const to = p.indexOf('CONCRETE NOUNS ONLY')
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    expect(p.slice(from, to)).not.toMatch(/often find|firms .{0,40}find\b|founders .{0,40}find\b/i)
  })
})

describe('the writer prompt varies the bridge construction', () => {
  const prompt = () => buildWriterPrompt()

  it('names the frame that collapsed and says why it matters', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('NAME THE PATTERN IN A DIFFERENT SHAPE EVERY TIME')
    expect(flat).toContain('NAME THE PATTERN IN A DIFFERENT SHAPE EVERY TIME')
    expect(flat).toContain('must not share a sentence shape with another prospect in this batch')
  })

  it('offers four genuinely different shapes, each labelled', () => {
    // CHANGED 2026-09-10. A CONDITIONAL was an endorsed conditional sitting under the rule
    // that bans conditionals, and A CONSEQUENCE named no shape, because every bridge names a
    // consequence. Both labels are gone, and the four models now land on four different places.
    const p = prompt()
    const flat = p.replace(/\s+/g, ' ')
    expect(flat).toContain('ONE FLAT SENTENCE.')
    expect(flat).toContain('WHAT HAPPENS, WITH ITS SETTING.')
    expect(flat).toContain('A COUNT THAT MAKES THE POINT.')
    expect(flat).toContain('WHAT A WORKING THING DOES NOT REACH.')
    expect(flat).not.toContain('A CONDITIONAL')
    // CHANGED 2026-09-11: the bridge is one sentence, so the two-sentence shapes went too.
    expect(flat).not.toContain('TWO FLAT FACTS')
    expect(p).not.toMatch(/^\s*A CONTRAST\. /m)
    // Matched as a LABEL LINE. The bare phrase "A CONSEQUENCE" still opens an unrelated rule
    // near the top of the prompt, so a substring check would pass after the label was gone.
    expect(p).not.toMatch(/^\s*A CONSEQUENCE\. /m)
    // The illustrations moved out of consulting entirely, because two batches lifted the
    // in-industry ones almost verbatim and the batch gate then threw the attempts away.
    expect(flat).toContain('Families new to your town book whichever dentist comes up first on a phone search.')
    expect(flat).toContain('On a year-long build, the next tender gets priced at night.')
    expect(flat).toContain('At an expo, shippers walk past your stand for two days a year.')
    expect(flat).toContain('People who like your wedding photos rarely ask for your prices.')
  })

  it('limits the concession model to reasons about people already reached', () => {
    // It lands on people who already know the work, which the rule above bans when the
    // reason is about people they have NOT reached. The condition is now carried by the
    // reason rather than by an offer line the writer cannot see.
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('only permitted where the REASON is about people they have already reached')
  })

  it('the four worked shapes do not collide with each other', () => {
    // A worked example that shares a skeleton with another worked example teaches the
    // opposite of what this section is for.
    // READ FROM THE PROMPT since 2026-09-10. This test used to hold four bridges of its own,
    // and by then none of the four was in the prompt: it checked copies and passed whatever
    // the prompt said. Every pair gets a fresh registry, so one collision cannot hide behind
    // another. The question is left empty, which switches the question key off, because this
    // test is about the bridges.
    const models = shapeModels()
    expect(models).toHaveLength(4)
    for (let i = 0; i < models.length; i++) {
      for (let j = i + 1; j < models.length; j++) {
        const reg = new BatchUniquenessRegistry()
        reg.reserve(`model-${i + 1}`, models[i], '')
        expect(reg.reserve(`model-${j + 1}`, models[j], ''), `models ${i + 1} and ${j + 1} share a skeleton`).toEqual([])
      }
    }
  })

  it('states the batch rule, not just the preference', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('must not share a sentence shape with another prospect in this batch')
    expect(flat).toContain('Vary the CONSTRUCTION, not just the nouns')
  })
})

describe('the writer prompt treats the approved questions as register, not a menu', () => {
  const prompt = () => buildWriterPrompt()

  it('says write, and says there is nothing to pick from', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('WRITE THE CLOSING QUESTION. YOU ARE NOT SHOWN ONE')
    expect(flat).toContain('There is no approved question in front of you, deliberately')
  })

  it('cites the actual collapse so the instruction has a reason attached', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    // WAS the 2026-09-10 collapse, where six of twelve shipped one of four prompt-resident
    // questions verbatim. The fix then was to delete the four and keep the variant's own,
    // which collapsed the same way on 2026-09-24. The reason attached is now that one.
    expect(flat).toContain('eight of nine shipped questions ended in the same four words')
  })

  // CHANGED 2026-09-24. This used to assert the opposite: that the variant's approved
  // question reached the writer through the assignment block, framed as register only. It
  // did reach it, and the writer handed it back. Both halves are now asserted ABSENT,
  // which is the same shape as the offer-line removal earlier the same day. If a future
  // change puts a question in front of the writer again, exactly one of these goes red.
  it('shows the writer no approved question, in the prompt or in the assignment', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).not.toContain('The approved question for this particular variant is named in the ASSIGNMENT block')
    expect(flat).not.toContain('It is there to show you REGISTER AND LENGTH')

    const assignment = buildWriterAssignment({ clientName: 'Acme', buyer: 'THE_BUYER_TITLE' })
      .replace(/\s+/g, ' ')
    expect(assignment).not.toMatch(/approved closing question/i)
    expect(assignment).not.toContain('it shows register and length')

    // POSITIVE CONTROL. The register and length still have to be STATED, or this pair of
    // absences would also pass on a prompt that says nothing about the question at all.
    expect(flat).toContain(`REGISTER AND LENGTH: one question, about ${OPENING_BUDGET.question} words`)
  })

  it('states the batch-uniqueness rule for questions too', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('no two prospects in this batch may get the same closing question')
    expect(flat).toContain('ask about a different aspect of the problem')
  })
})

describe('the writer prompt asks for three paragraphs, returned as three blocks', () => {
  const prompt = () => buildWriterPrompt()

  it('shows the observation and the bridge as separate slots in the skeleton', () => {
    const p = prompt()
    expect(p).toContain('[YOUR OBSERVATION GOES HERE]')
    expect(p).toContain('[YOUR BRIDGE GOES HERE]')
    // Order matters: observation, bridge, the fixed paragraph, question.
    const fixedSlot = p.indexOf('A FIXED PARAGRAPH YOU DO NOT WRITE')
    expect(p.indexOf('[YOUR OBSERVATION GOES HERE]')).toBeLessThan(p.indexOf('[YOUR BRIDGE GOES HERE]'))
    expect(p.indexOf('[YOUR BRIDGE GOES HERE]')).toBeLessThan(fixedSlot)
    expect(fixedSlot).toBeLessThan(p.indexOf('[YOUR CLOSING QUESTION GOES HERE]'))
  })

  it('says explicitly that they are separate paragraphs', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('SEPARATE PARAGRAPHS with a blank line between them')
    expect(flat).toContain('never run together')
  })

  it('asks for exactly five labelled blocks, with the scratch first and the subject last', () => {
    const p = prompt()
    expect(p).toContain('exactly five labelled blocks')
    expect(p).toContain('SCRATCH:')
    // First, because it is where the deliberation goes instead of into the bridge.
    expect(p.lastIndexOf('SCRATCH:')).toBeLessThan(p.lastIndexOf('OBSERVATION:'))
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

  // INVERTED 2026-09-23, with the block-to-report change. This used to assert that a
  // colliding reservation recorded NOTHING, which was right while a collision ended the
  // attempt: there was no point booking frames that were about to be thrown away. The
  // attempt now proceeds and the copy ships, so not recording it would mean the end-of-batch
  // tally counted a phrase used by five prospects as used by one.
  it('RECORDS a colliding reservation, because the attempt it belongs to now ships', () => {
    const reg = new BatchUniquenessRegistry()
    reg.reserve('p1', BRIDGE_A, 'Is that a gap?')
    reg.reserve('p2', BRIDGE_A_NOUNS_SWAPPED, 'Is that a gap?')
    expect(reg.holds('p2')).toBe(true)
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

// REPLACES the three uniquenessFeedback tests, 2026-09-23. They pinned the wording of the
// retry instruction sent when a repeated bridge REJECTED an attempt. That rejection is gone
// (see batch-uniqueness.ts), so the function that wrote the instruction is gone with it, and
// a test pinning a string nothing sends is worse than no test: it reads as coverage.
//
// What replaced them asserts the contract that actually changed, at the same level.
describe('a repeated bridge is recorded and reported, never refused', () => {
  it('reserve RETURNS the collision and RECORDS it anyway, so the tally can count it', () => {
    const r = new BatchUniquenessRegistry()
    const bridge = 'The weeks you spend delivering are weeks nobody is filling the diary.'
    expect(r.reserve('p1', bridge, 'Worth a look?')).toEqual([])
    const collisions = r.reserve('p2', bridge, 'Any use to you?')
    expect(collisions.length).toBeGreaterThan(0)
    // THE CHANGE. The old version recorded nothing when it collided, because the attempt
    // was about to be thrown away. The attempt now proceeds, so p2 must be on the books.
    expect(r.holds('p2')).toBe(true)
  })

  it('names whoever said it FIRST, so the report can tell them apart', () => {
    const r = new BatchUniquenessRegistry()
    const bridge = 'The weeks you spend delivering are weeks nobody is filling the diary.'
    r.reserve('p1', bridge, 'Worth a look?')
    const collisions = r.reserve('p2', bridge, 'Any use to you?')
    expect(collisions.every(c => c.firstSeenId === 'p1')).toBe(true)
  })

  it('a retry by the same prospect never collides with itself', () => {
    const r = new BatchUniquenessRegistry()
    const bridge = 'The weeks you spend delivering are weeks nobody is filling the diary.'
    r.reserve('p1', bridge, 'Worth a look?')
    expect(r.reserve('p1', bridge, 'Worth a look?')).toEqual([])
  })

  it('releasing the first owner hands the reservation to whoever is still using it', () => {
    const r = new BatchUniquenessRegistry()
    const bridge = 'The weeks you spend delivering are weeks nobody is filling the diary.'
    r.reserve('p1', bridge, 'Worth a look?')
    r.reserve('p2', bridge, 'Any use to you?')
    r.release('p1')
    // p3 must be told p2 said it first. Pointing at the released p1 would name a prospect
    // no longer in the batch; deleting it would make p3 look like the first to say it.
    const collisions = r.reserve('p3', bridge, 'Handy?')
    expect(collisions.length).toBeGreaterThan(0)
    expect(collisions.every(c => c.firstSeenId === 'p2')).toBe(true)
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
  const FINDINGS_TEXT = 'Green Field hired a Manager of Delivery and Operations in March.'

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


// ─── THE PROMPT SAYS NOTHING ABOUT ATTRIBUTION ───────────────────────────────
//
// WHAT THIS ARM IS. Three consecutive rule blocks discussed attribution: WHERE it may sit
// (position and budget), WHOSE it may be (the sender, never the peer group), and WHAT it
// may claim (only what the sender has actually done). All three are deleted. No
// replacement and no ban were added, because a rule saying never attribute is another
// twenty lines about attribution, and the whole question is whether the prose is what
// produces the shape.
//
// THE MEASUREMENTS THAT LED HERE. The prompt has held ZERO endorsed attributed bridge
// specimens since 223d7f4 on 2026-08-31, and the writer produced the construction anyway:
// 4 of 41 with rules and examples present, 10 of 37 with all 77 worked examples removed,
// 7 of 39 with two of the three rule blocks deleted. The third block survived that arm,
// and it alone carries "BEFORE YOU WRITE AN ATTRIBUTED CLAUSE" and "the clause has to say
// so", so no arm had measured the prompt with attribution actually absent.
//
// THIS IS THE MUTATION GUARD FOR THE ARM. Restoring any of the three blocks turns it red,
// and so does restoring the endorsed example deleted in 223d7f4.

describe('the writer prompt says nothing about attribution', () => {
  const flat = () => buildWriterPrompt().replace(/\s+/g, ' ')

  it('uses no form of the word anywhere in the prompt', () => {
    // The whole deletion in one assertion. All fourteen occurrences of the stem sat inside
    // the three blocks, so one scan covers all three and cannot be satisfied by deleting
    // two of them.
    expect(flat()).not.toMatch(/attribut/i)
  })

  it('none of the three rule headings is back', () => {
    const f = flat()
    expect(f, 'the sender-only block is back')
      .not.toContain('YOU MAY ATTRIBUTE THE PATTERN, BUT ONLY TO YOURSELF')
    expect(f, 'the position block is back')
      .not.toContain('IT MAY NOT OPEN THE BRIDGE')
    expect(f, 'the honesty block is back')
      .not.toContain('ATTRIBUTION MUST BE HONEST ABOUT WHOSE EXPERIENCE IT IS')
  })

  it('the endorsed attribution-first example stays deleted', () => {
    // Carried over from the 2026-08-31 mutation test. The rule that guard was attached to
    // is gone; the guard it bought is not. That clause is the most copyable sentence the
    // page ever held.
    const f = flat()
    expect(f).not.toContain('ATTRIBUTED, same claim, inside the bridge budget')
    expect(f).not.toContain('The founders I speak to describe the same split')
  })
})


// ─── THE PEER-GROUP PROHIBITION, RESTORED WITHOUT THE WORD ───────────────────
//
// WHAT THIS REPAIRS. Deleting the three attribution blocks took a fourth thing with it:
// the only prohibition on telling the reader what people in their position think. That
// prohibition lived inside the sender-only block and was collateral, not the target. It is
// a different fault: sender-attribution is a claim about the WRITER, this is a claim about
// the READER.
//
// STATED WITHOUT THE WORD, DELIBERATELY. The measured finding of the attribution-full arm
// is that prose discussing the construction is what produces it: 0 of 36 with the prose
// gone, against 4 of 41, 7 of 39 and 10 of 37 with it present in various amounts. So this
// rule names the shape it bans and never names the category the old blocks named.
//
// NO WORKED EXAMPLE, for the reason RULE ZERO gives: this file has eight recorded instances
// of an example being lifted verbatim into a prospect's email.

describe('the writer prompt bans telling the reader what people like them think', () => {
  const flat = () => buildWriterPrompt().replace(/\s+/g, ' ')

  it('states the rule', () => {
    const f = flat()
    expect(f).toContain('NEVER TELL THE READER WHAT PEOPLE LIKE THEM THINK')
    expect(f).toContain('assume, believe, realise, discover or find')
    expect(f).toContain('Naming a larger population makes it worse, not softer')
  })

  it('says what to write instead, so the rule is not only a ban', () => {
    expect(flat()).toContain('Say what happens to a firm in that position instead')
  })

  it('uses no form of the word the deleted blocks used', () => {
    // THE WHOLE POINT OF THE REWORDING. A rule that reintroduces the stem reintroduces the
    // fault the arm was built to measure, and this is what stops that happening by degrees.
    expect(flat()).not.toMatch(/attribut/i)
  })

  it('carries no worked example sentence', () => {
    const from = buildWriterPrompt().indexOf('NEVER TELL THE READER WHAT PEOPLE LIKE THEM THINK')
    const rest = buildWriterPrompt().slice(from)
    const block = rest.slice(0, rest.indexOf('THE BRIDGE STATES ONE TRUE THING'))
    expect(block.length).toBeGreaterThan(100)
    expect([...block.matchAll(/"([^"]{25,})"/g)].map(m => m[1])).toEqual([])
  })

  it('sits inside the verdict section, which is the line it narrows', () => {
    // Proved by ORDER. The rule refines "what is TYPICALLY true of firms in this position",
    // so a placement test is the only thing that keeps it next to the sentence it qualifies.
    const p = buildWriterPrompt()
    const verdict = p.indexOf('THE BRIDGE NAMES A PATTERN. IT NEVER DELIVERS A VERDICT')
    const rule    = p.indexOf('NEVER TELL THE READER WHAT PEOPLE LIKE THEM THINK')
    const next    = p.indexOf('THE BRIDGE STATES ONE TRUE THING')
    expect(verdict).toBeGreaterThan(-1)
    expect(rule).toBeGreaterThan(verdict)
    expect(next).toBeGreaterThan(rule)
  })

  it('no worked example in the prompt still endorses the banned frame', () => {
    // THE COLLATERAL THIS CLOSES. The digestibility pair was endorsed for STRUCTURE and
    // both halves were built on the frame, so the prompt was banning a shape one page after
    // showing it working. Reframed to keep the structural lesson: the HARD half still has a
    // long qualified subject and a nested relative clause, the EASY half still reaches its
    // verb in two words.
    const f = flat()
    expect(f).not.toContain('Founders who move that fast often find')
    expect(f).not.toContain('Independent firms that rely on conference appearances for new conversations often find')
    expect(f).toContain('Most homeowners sign the cheapest of the three window quotes that land on the doormat in the same week.')
    expect(f).toContain('The pipeline at firms that rely on the conference appearances that bring in new conversations')
    // And the gloss the new rule falsified is gone: the generic specimen no longer claims
    // to obey every rule above it, because it no longer does.
    expect(f).not.toContain('it obeys every rule above')
  })
})


describe('the writer is asked for the same number of blocks in both turns', () => {
  it('stops the lifting by making the words unusable rather than by warning harder', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    // Warning was tried twice and failed twice: "development is usually what gives" off
    // "prospecting is usually what gives", then "Delivery has a deadline" verbatim. The
    // examples are now from other industries, so a lift is wrong on sight.
    expect(flat).toContain('EVERY EXAMPLE BELOW IS FROM A DIFFERENT INDUSTRY')
    expect(flat).toContain('EVERY WORD IN THEM IS UNUSABLE HERE')
    expect(flat).toContain('write your own sentence out of your own prospect\'s facts')
  })
})


describe('the writer may not hand back the approved offer line', () => {
  const P3 = 'We get qualified conversations into the diary without pulling you out of delivery.'
  const FINDINGS_TEXT = 'Sasha took on Publisher and CEO at Acme Media alongside Acme Consulting.'

  it('rejects the exact echo that shipped in Sasha Email 1', () => {
    const opening = 'You took on Publisher and CEO at Acme Media.\n\nTwo leadership positions running in parallel means prospecting is usually the first thing that waits. We get qualified conversations into the diary without pulling you out of delivery. Is this a gap you are looking to close?'
    expect(checkOpeningGates(opening, null, FINDINGS_TEXT, P3).join(' ')).toContain('repeats the approved offer line')
  })

  it('rejects a truncated echo, not just a verbatim one', () => {
    const opening = 'You took on a second role.\n\nWe get qualified conversations into the diary. Is this a gap?'
    expect(checkOpeningGates(opening, null, FINDINGS_TEXT, P3).join(' ')).toContain('repeats the approved offer line')
  })

  it('leaves a normal opening alone', () => {
    const opening = 'You took on Publisher and CEO at Acme Media.\n\nTwo leadership roles at once means prospecting waits. Is this a gap you are looking to close?'
    expect(checkOpeningGates(opening, null, FINDINGS_TEXT, P3)).toEqual([])
  })

  it('does not fire on incidental shared words', () => {
    // "conversations" and "delivery" are ordinary vocabulary for this offer. Only an
    // eight-word run of the offer line itself counts.
    const opening = 'You hired a delivery lead.\n\nThe right conversations get harder to find. Is that a gap?'
    expect(checkOpeningGates(opening, null, 'Green Field hired a delivery lead.', P3)).toEqual([])
  })

  it('is inert when no approved P3 is supplied', () => {
    const opening = 'You took on a second role.\n\nProspecting waits. Is this a gap?'
    expect(checkOpeningGates(opening, null, FINDINGS_TEXT)).toEqual([])
  })
})


// ─── Cross-industry bridge examples, and concrete nouns ─────────────────────

describe('the bridge examples come from outside the client industry', () => {
  const prompt = () => buildWriterPrompt()

  it('uses four industries deliberately foreign to the prospect', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('A dentist:')
    expect(flat).toContain('A commercial builder:')
    expect(flat).toContain('A freight broker:')
    expect(flat).toContain('A wedding photographer:')
  })

  it('keeps the four constructions and labels none as preferred', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('ONE FLAT SENTENCE.')
    expect(flat).toContain('WHAT HAPPENS, WITH ITS SETTING.')
    expect(flat).toContain('A COUNT THAT MAKES THE POINT.')
    expect(flat).toContain('WHAT A WORKING THING DOES NOT REACH.')
    expect(flat).not.toContain('preferred answer')
  })

  it('says the words are unusable, not merely that copying is discouraged', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('THE SHAPE IS WHAT TRANSFERS')
    expect(flat).toContain('EVERY WORD IN THEM IS UNUSABLE HERE')
  })

  it('no longer carries the two phrases that were lifted and then rejected', () => {
    // One prospect returned "development is usually what gives" off "prospecting is
    // usually what gives"; a second lifted "Delivery has a deadline" verbatim into its
    // bridge. Both collided and cost the prospect. The bridge examples are gone, so they
    // cannot recur.
    const p = prompt()
    const examplesSection = p.slice(
      p.indexOf('EVERY EXAMPLE BELOW IS FROM A DIFFERENT INDUSTRY'),
      p.indexOf('There are more shapes than these four'),
    )
    expect(examplesSection).not.toContain('prospecting is usually what gives')
    expect(examplesSection).not.toContain('Delivery has a deadline')
  })

  it('the four examples do not collide with each other under the batch gate', () => {
    // READ FROM THE PROMPT since 2026-09-10. Three of the four strings this test used to hold
    // had been reworded in the prompt and never here. Reserved into ONE registry in prompt
    // order, which is how a batch actually fills.
    const models = shapeModels()
    expect(models).toHaveLength(4)
    const reg = new BatchUniquenessRegistry()
    models.forEach((m, i) => {
      expect(reg.reserve(`example-${i + 1}`, m, ''), `model ${i + 1} collided`).toEqual([])
    })
  })

  it('the examples themselves are concrete', () => {
    // An example carrying a banned noun would teach the opposite of the section below it.
    // REPOINTED 2026-09-10. The start marker used to be 'A CONDITIONAL'. When that label was
    // deleted, indexOf returned -1, the slice came back empty and this test passed having
    // checked nothing. Both markers are now asserted present, and the slice must hold all
    // four models, so a lost marker fails instead of going quiet.
    const p = buildWriterPrompt()
    const from = p.indexOf('ONE FLAT SENTENCE.')
    const to = p.indexOf('There are more shapes than these four')
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    const examplesSection = p.slice(from, to)
    for (const label of ['A dentist:', 'A commercial builder:', 'A freight broker:', 'A wedding photographer:']) {
      expect(examplesSection).toContain(label)
    }
    expect(countAbstractNouns(examplesSection)).toBe(0)
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
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('Load and output are judgement calls, not bans')
    expect(flat).toContain('a real operational load')
    expect(flat).toContain('that output shows')
  })

  it('bans metaphors outright', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('NO METAPHORS')
    expect(flat).toContain('a picture the reader has to unpack')
  })

  it('carries both abstract failures, each with a concrete rewrite', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('The remainder tends to shrink before it grows')
    expect(flat).toContain('Nobody can picture a remainder')
    expect(flat).toContain('A day job and delivery leave outreach fewer hours every week.')
    // CHANGED 2026-09-10. The second pair was a real shipped sentence about regions and a
    // rewrite about markets in the UK. Replaced with a constructed pair about a seafront.
    expect(flat).toContain('The winter months need an engine of their own.')
    expect(flat).toContain('The seafront ice-cream kiosks with August queues stay shut all January.')
  })

  it('offers no standard sentence to copy, only a description of what films', () => {
    // CHANGED 2026-09-10, and the claim is INVERTED, not relaxed. This test used to require
    // "Delivery has a deadline" as the standard to aim at. That sentence was lifted verbatim
    // into a real bridge while still endorsed, so it was deleted, and its slot is now a
    // description with no sentence in it to copy.
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).not.toContain('this is the standard')
    expect(flat).not.toContain('Delivery has a deadline')
    expect(flat).toContain('What you can film is a calendar with a date on it, and something pushed to next week.')
  })

  it('the concrete rewrites in the prompt score zero on the report-only check', () => {
    // READ FROM THE PROMPT since 2026-09-10, instead of from copies held here.
    const rewrites = concreteRewrites()
    expect(rewrites).toHaveLength(2)
    for (const r of rewrites) expect(countAbstractNouns(r), r).toBe(0)
  })
})


// ─── The per-part budget ────────────────────────────────────────────────────

describe('the budget is per part and sits below the gate', () => {
  it('sums to the stated target', () => {
    expect(OPENING_BUDGET.observation + OPENING_BUDGET.bridge + OPENING_BUDGET.question)
      .toBe(OPENING_TARGET_WORDS)
    expect(OPENING_TARGET_WORDS).toBeLessThan(OPENING_MAX_WORDS)
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
    expect(flat).toContain(`bridge ONE sentence, about ${OPENING_BUDGET.bridge} words`)
    expect(flat).toContain(`closing question about ${OPENING_BUDGET.question} words`)
    expect(flat).toContain(`${OPENING_TARGET_WORDS} words in total`)
  })

  it('the prompt says which number is the target and which is the limit', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('These are TARGETS')
    expect(flat).toContain(`The HARD LIMIT is ${OPENING_MAX_WORDS} words`)
    expect(flat).toContain('words in total')
  })

  it('the prompt forbids borrowing between parts', () => {
    const flat = buildWriterPrompt().replace(/\s+/g, ' ')
    expect(flat).toContain('observation about 22 words')
    expect(flat).toContain(`bridge ONE sentence, about ${OPENING_BUDGET.bridge} words`)
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
    expect(msg).toContain(`observation 31 (target ${OPENING_BUDGET.observation}, OVER by ${31 - OPENING_BUDGET.observation})`)
    expect(msg).toContain(`bridge 32 (target ${OPENING_BUDGET.bridge}, OVER by ${32 - OPENING_BUDGET.bridge})`)
    expect(msg).toContain(`question 15 (target ${OPENING_BUDGET.question}, OVER by ${15 - OPENING_BUDGET.question})`)
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
    // Possible because the three targets leave slack under the hard cap: each part can
    // sit exactly at target and the block still clear 67. This covers the boundary rather
    // than leaving the message to say "cut the " with nothing after it. Derived from
    // OPENING_BUDGET so a budget change moves the fixture with it.
    const observation = long(OPENING_BUDGET.observation)
    const bridge = long(OPENING_BUDGET.bridge)
    const question = long(OPENING_BUDGET.question)
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

describe('the writer prompt forbids asserting a track record', () => {
  const prompt = () => buildWriterPrompt()

  // WHERE THIS RULE NOW SITS, AND WHY IT MOVED. It was written inside the block that let
  // the sender attribute a pattern to their own experience, and it is not about
  // attribution: it is a truthfulness guard about inventing client work. When the three
  // attribution blocks were deleted it moved to the end of the findings-traceability
  // section, next to the other rules about what a claim has to be traceable to.

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

  it('sits with the findings-traceability rules, not stranded on its own', () => {
    // Proved by ORDER, not by presence. The rule lost its neighbours when the attribution
    // blocks went, so a test that only checks it is still in the prompt would pass with it
    // left anywhere at all.
    const p = prompt()
    const traceability = p.indexOf('NEVER ASSERT WHAT THE FINDINGS DO NOT EVIDENCE')
    const record = p.indexOf('NEVER ASSERT A TRACK RECORD')
    const next = p.indexOf('THE BRIDGE MUST FOLLOW FROM ITS OWN OBSERVATION')
    expect(traceability).toBeGreaterThan(-1)
    expect(record).toBeGreaterThan(traceability)
    expect(next).toBeGreaterThan(record)
  })

  it('drops the clause inside it that presupposed attribution', () => {
    // "A pattern you have noticed is yours to report" sat in this rule as the positive half
    // of a contrast. It licenses the construction without using the word, so it went with
    // the blocks. The negative half is a complete rule standing on its own.
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).not.toContain('A pattern you have noticed is yours to report')
    expect(flat).toContain('An outcome you cannot point to in the documents is not yours to mention')
  })
})

// ─── The camera test and plain verbs ────────────────────────────────────────

describe('the writer prompt runs a camera test, not a reading age', () => {
  const prompt = () => buildWriterPrompt()

  it('drops the reading-age line and says why it failed', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    // It was in the prompt for two batches and stopped neither "hours shrink before they
    // grow" nor "become a conversation", because it measures word difficulty and the
    // problem is figurative language.
    expect(flat).not.toContain('Someone reading at eleven years old should follow it')
    expect(flat).toContain('THE CAMERA TEST')
    expect(flat).toContain('Point a camera at their week')
  })

  it('states the camera test and where the abstraction now hides', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('THE CAMERA TEST')
    expect(flat).toContain('Point a camera at their week')
    expect(flat).toContain('TWICE ON THE LAST FEW WORDS OF THE BRIDGE')
    expect(flat).toContain('the abstraction moved into the verbs and the endings')
  })

  it('carries the filmable and unfilmable pair', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('"Hours shrink before they grow" is unfilmable')
    expect(flat).toContain('a calendar with a date on it, and something pushed to next week')
  })

  it('gives the verb rule as a do and a do-not list', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('PLAIN VERBS')
    expect(flat).toContain('something a PERSON DOES or something that PLAINLY HAPPENS')
    // The do/do-not verb lists were removed by the prompt trim. no_finite_verb does the
    // enforcing and its failure message names the offending sentence.
  })

  it('requires a concrete ending, with the contrast the brief gave', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('FINISH ON A CONCRETE THING, NOT A CATEGORY')
    expect(flat).toContain('FINISH ON A CONCRETE THING, NOT A CATEGORY')
  })

  it('carries two failures, each with a plain rewrite', () => {
    // CHANGED 2026-09-10. Both pairs were real shipped sentences. Replaced with constructed
    // pairs from an orchard and a violin maker, landing somewhere other than a full week.
    const flat = prompt().replace(/\s+/g, ' ')
    // The first.
    expect(flat).toContain('A few drivers convert into cider buyers after passing your orchard sign.')
    expect(flat).toContain('Hardly anyone turns into an unfamiliar farm gate at fifty miles an hour.')
    // The second.
    expect(flat).toContain('tend to need a nudge before they become an order')
    expect(flat).toContain("A child's first violin is usually bought in September, not at a June concert.")
    expect(flat).not.toContain('Two of these shipped last week')
  })

  it('the plain rewrites obey every rule they sit under', () => {
    // READ FROM THE PROMPT since 2026-09-10, instead of from copies held here.
    const rewrites = plainRewrites()
    expect(rewrites).toHaveLength(2)
    for (const r of rewrites) {
      expect(countFigurativeVerbs(r), r).toBe(0)
      expect(countAbstractNouns(r), r).toBe(0)
      expect(r.trim().split(/\s+/).length, r).toBeLessThanOrEqual(OPENING_BUDGET.bridge)
    }
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
    expect(flat).toContain('NO CAUSAL CONSTRUCTIONS')
  })

  it('carries the working bridge verbatim as the standard', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('The founders who need you next are not reading your feed yet.')
  })

  // NOT A DELETED ASSERTION. The second WORKS example used to be pinned here and is now
  // pinned ABSENT, because removing the check would let it return silently. It was deleted
  // on 2026-09-21 after four of 84 prospects shipped a bridge on its exact frame and six
  // more on a one-clause variant. The prompt carries the reasoning beside the survivor.
  it('does NOT carry the event-deferral bridge that the batch copied', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).not.toContain('The next qualified sales conversation tends to wait for the next event.')
    // The frame, not just the sentence: a reworded reinstatement fails this too.
    expect(flat).not.toMatch(/next\s+\w*\s*sales conversation tends to wait/i)
  })

  it('carries all three causal failures verbatim', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('When delivery runs first for 13 months, that tends to be what stays visible.')
    expect(flat).toContain('before the next event is on the calendar, are where the pipeline has to run on something else')
    expect(flat).toContain('the follow-up after a public appearance rarely gets its own slot')
  })

  it('bans the causal constructions by name', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('NO CAUSAL CONSTRUCTIONS')
    expect(flat).toContain('no condition in front of it')
    expect(flat).toContain('No "because"')
    expect(flat).toContain('stating what follows, with no condition in front of it')
  })

  it('prefers one plain sentence to one conditional, with nothing trailing', () => {
    // CHANGED 2026-09-11. This rule said two short sentences beat one conditional. The bridge
    // is now one sentence, enforced by a gate, and the rule says so as well.
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('The bridge is ONE sentence stating what follows')
    expect(flat).toContain('no condition in front of it and no until, before, while or when clause trailing after it')
    expect(flat).not.toContain('TWO SHORT SENTENCES BEAT ONE CONDITIONAL')
  })

  it('forbids chaining back to the observation, and says why', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('Do not build a causal chain back to the observation')
    expect(flat).toContain('Do not build a causal chain back to the observation')
  })

  it('requires the observation and bridge to be read together, with the real contradiction', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('THEY MUST NOT CONTRADICT EACH OTHER')
    expect(flat).toContain('The observation says his feed is regulatory news')
    expect(flat).toContain('Both cannot be true')
  })
})

describe('two more things the bridge may not assume', () => {
  const prompt = () => buildWriterPrompt()

  it('bans assuming they have nobody, and ties it to the pipeline ban', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('DO NOT ASSUME THEY HAVE NOBODY')
    expect(flat).toContain('With three active CEO roles, the follow-up after a public appearance rarely gets its own slot')
    expect(flat).toContain('He probably has people')
    expect(flat).toContain('same error as claiming to know their pipeline')
    expect(flat).toContain('Never say who is or is not doing it')
  })

  it('extends the absence ban to implied choice, with Devon verbatim', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    // "THE ABSENCE BAN COVERS..." forward-referenced a ban 426 lines below it, so the
    // reader met the exception first. The ban now sits directly above, and the heading
    // resolves locally.
    expect(flat).toContain('THE BAN COVERS IMPLIED CHOICE')
    expect(flat).toContain('When your feed points elsewhere, the people who might hire you do not know BrightlaneIQ exists.')
    expect(flat).toContain('it implies he chose that')
    expect(flat).toContain('Never tell the reader what they have decided to put first')
  })
})

describe('the corrected pattern example is welded to facts nobody in the batch has', () => {
  const prompt = () => buildWriterPrompt()

  it('is about a print shop, not a hire and a network', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('PATTERN, corrected, and deliberately about a PRINT SHOP')
    expect(flat).toContain('You added a second large-format press in March.')
    expect(flat).toContain('Your second press needs work from customers you have not quoted yet.')
  })

  it('no longer carries the phrasing that was reproduced almost verbatim', () => {
    // One prospect returned "A network fills the first months after a hire like that. The
    // months after it are the harder ones." That was the seventh instance of example copying.
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).not.toContain('A network fills the first months after a hire like that')
    expect(flat).not.toContain('The months after it are the harder ones')
  })

  it('records why it was re-welded, so it is not quietly reverted', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('deliberately about a PRINT SHOP')
    expect(flat).toContain('You added a second large-format press in March')
  })

  it('the corrected bridge obeys every rule it now sits under', () => {
    // READ FROM THE PROMPT since 2026-09-10, instead of from a copy held here.
    const bridge = printShopBridge()
    expect(countFigurativeVerbs(bridge)).toBe(0)
    expect(countAbstractNouns(bridge)).toBe(0)
    expect(bridge.trim().split(/\s+/).length).toBeLessThanOrEqual(OPENING_BUDGET.bridge)
    // One sentence (the bridge gate), no conditional, no "because".
    expect(bridge).not.toMatch(/\bbecause\b|\bwhen\b/i)
    expect(bridge.split(/(?<=\.)\s+/).filter(Boolean)).toHaveLength(1)
  })

  it('does not collide with the other worked examples under the batch gate', () => {
    // READ FROM THE PROMPT since 2026-09-10. Three of the five strings this test used to hold
    // had been reworded in the prompt and never here.
    const examples = [printShopBridge(), ...shapeModels()]
    expect(examples).toHaveLength(5)
    const reg = new BatchUniquenessRegistry()
    examples.forEach((ex, i) => {
      expect(reg.reserve(`example-${i + 1}`, ex, ''), `example ${i + 1} collided`).toEqual([])
    })
  })
})


// ─── The gap points at strangers, and the bridge follows its own observation ──

describe('the offer line rules one destination out without choosing the other', () => {
  const prompt = () => buildWriterPrompt()

  it('derives the rule from the REASON rather than naming a service', () => {
    // Stated as a principle so it holds for any client. It used to be derived from the offer
    // line; the writer is no longer shown one, and the reason carries the same information
    // because it says what the event leaves the company needing.
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('THE CONSEQUENCE MUST NOT TURN THE REASON INTO A DIFFERENT NEED')
    expect(flat).toContain('Go back to the REASON')
    expect(flat).toContain('has to be that need and not a neighbouring one')
    expect(flat).not.toMatch(/offer line/i)
  })

  it('bans the three ways of naming an audience they already have', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('Never name a gap about converting, following up with, or re-engaging an audience they already have')
  })

  it('carries all three failing bridges verbatim, each with what is wrong', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    // The first.
    expect(flat).toContain('The right buyers hear the talk on the day. Then the event ends, and most buyers do not follow up first.')
    expect(flat).toContain('the room that already saw him speak')
    // The second, which fails twice over.
    expect(flat).toContain('A product shop builds an audience of people who browse.')
    expect(flat).toContain('tells her the thing she just built is not working, which is banned above')
    // The third.
    expect(flat).toContain('The founders who need you next are reading your feed already.')
    expect(flat).toContain('There is no gap in that sentence at all')
  })

  it('carries the working example and says why it works', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('London is full of people who have never heard of you.')
    expect(flat).toContain('The gap is people who do not know her')
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
    //
    // RETARGETED 2026-09-23. The bridge used to be defined as "the CONSEQUENCE that follows
    // from the observation", which left the model to work out for itself what a fact
    // implied, and what it worked out was usually a claim about the reader's pipeline. It
    // now states THE REASON, supplied by synthesis from the client's documents. The test
    // keeps its job: the job definition still has to settle what the bridge is.
    expect(flat).toContain('stating THE REASON the observation gives this person to want what the sender offers')
    // And the test that matters most about that sentence: it must hold whatever their
    // situation, which is the rule that stops it guessing.
    expect(flat).toContain('IT MUST BE TRUE WHATEVER THEIR SITUATION')
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
    // "Pick another finding" until 2026-09-14. Reworded when the selection mark began
    // reaching the writer on the reuse path: the instruction is unchanged in force, but it
    // now says it OUTRANKS the mark rather than expressing a free preference between
    // findings. Wording only; this rule still sends the writer off a marked finding.
    expect(flat).toContain('Move to another finding')
    expect(flat).toContain('This is one of the reasons that outranks the mark')
  })
})

describe('the absence ban states its own scope and its own subject', () => {
  const prompt = () => buildWriterPrompt()

  it('says which paragraphs it covers, without a lookup into joinOpening', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    // THE OLD PHRASING was "never OPEN by naming what they lack", governing an example
    // that is a BRIDGE. "Opening" means observation and bridge together, and the only way
    // to learn that was to read joinOpening in another part of this file.
    expect(flat).toContain('THE ABSENCE BAN, COVERING THE OBSERVATION AND THE BRIDGE BOTH')
    expect(flat).toContain('COVERING THE OBSERVATION AND THE BRIDGE BOTH')
  })

  it('locates the fault in the verdict, not in the absence', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('State a consequence, never a judgement')
    expect(flat).toContain('The fault is DELIVERING A VERDICT ON THE READER')
    expect(flat).toContain('The fault is DELIVERING A VERDICT ON THE READER')
    expect(flat).toContain('State a consequence, never a judgement')
  })

  it('applies the same test to something present, which is the half that was missing', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('whether it is built on something present or something absent')
    expect(flat).toContain('the same test applies to something PRESENT')
    expect(flat).toContain('State a consequence, never a judgement, whether it is built on something present or something absent')
  })

  it('sits with its own exception rather than 426 lines from it', () => {
    // THE ORIGINAL FAULT, and it is a distance, so the assertion has to be one too. The
    // ban and the exception that names it were 426 lines apart and a reader met the
    // exception first. A substring check on either would pass in both worlds.
    const lines = prompt().split('\n')
    const ban = lines.findIndex(l => l.includes('Never name what they lack'))
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

  it('states the rule and carries the Ines mismatch', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('THE BRIDGE MUST FOLLOW FROM ITS OWN OBSERVATION')
    expect(flat).toContain('Board seats and LinkedIn posts are two different subjects')
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

  it('carries the empty change-of-state construction verbatim', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('Outreach for the new-business side sits until it does not.')
    expect(flat).toContain('"Until it does not" is a shape where a fact should be')
  })

  it('carries the longest and still-explaining bridge, with the fix', () => {
    const flat = prompt().replace(/\s+/g, ' ')
    expect(flat).toContain('AND KEEP IT INSIDE THE BUDGET')
    expect(flat).toContain('Keep the one clause that matters, said plainly')
  })
})

describe('the new failing examples do not become the next thing copied', () => {
  it('every quoted FAILING bridge is labelled as failing, not as a model', () => {
    // Seven instances of example-copying so far, all from examples labelled as good. These
    // are all labelled FAILING, which is the only reason it is safe to quote them verbatim.
    const p = buildWriterPrompt()
    for (const quote of [
      'The right buyers hear the talk on the day.',
      'A product shop builds an audience of people who browse.',
      'The founders who need you next are reading your feed already.',
      'Outreach for the new-business side sits until it does not.',
    ]) {
      const idx = p.indexOf(quote)
      expect(idx).toBeGreaterThan(-1)
      // The nearest label above the quote must be FAILING.
      const before = p.slice(0, idx)
      expect(before.lastIndexOf('FAILING')).toBeGreaterThan(before.lastIndexOf('WORKING'))
    }
  })

  it('the one WORKING bridge quoted here is Makesha own, already shipped and hers', () => {
    const p = buildWriterPrompt()
    const idx = p.indexOf('London is full of people who have never heard of you.')
    const before = p.slice(0, idx)
    expect(before.lastIndexOf('WORKING')).toBeGreaterThan(before.lastIndexOf('FAILING'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FIX 4, 2026-09-21, RE-POINTED 2026-09-23. The writer's own sentences are gated, LENGTH
// ONLY. readabilityScore has hard-failed both over-length sentences AND hedge phrases since
// it was written, and it gated CANDIDATE SELECTION with both; on the writer it ran log-only.
// Measured on the 84 openings of 2026-09-21: 17 carried a sentence over 25, 39 carried a
// hedge. Length gates, hedges log, and the asymmetry is the point.
//
// THE CAP IS NOW THE WRITER'S OWN, NOT THE SHARED 25. These tests were written against
// MAX_SENTENCE_WORDS and are re-pointed at WRITER_MAX_SENTENCE_WORDS rather than deleted,
// because every one of them still asks a question worth asking. The gate they described was
// replaced when writer-trim merged, and a test left pinned to the old constant would have
// gone on passing while testing a code path that no longer exists.
describe('gate: writer sentence length (FIX 4)', () => {
  // Plain lowercase words only: untraceableClaims exempts nothing capitalised mid-sentence,
  // and a stray proper noun here would fail these for a different reason than the one
  // under test. Also no digits, for the same reason.
  const words = (n: number) => Array.from({ length: n }, () => 'thing').join(' ')
  const parts = (observation: string, bridge: string) => ({
    observation, bridge, question: 'is that something you are working on?',
  })
  // Findings must contain the text, or traceability fires instead of length.
  const gate = (observation: string, bridge: string) => {
    const opening = `${observation}\n\n${bridge}`
    const findings = `${opening} is that something you are working on?`
    return checkOpeningGates(opening, null, findings, undefined, parts(observation, bridge))
  }
  const lengthFailures = (o: string, b: string) =>
    gate(o, b).filter(f => /has a sentence of \d+ words/.test(f))

  it('FIRES on an observation one word over the cap', () => {
    const over = `${words(WRITER_MAX_SENTENCE_WORDS + 1)}.`
    const hits = lengthFailures(over, 'short bridge here.')
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain(`sentence of ${WRITER_MAX_SENTENCE_WORDS + 1} words`)
    expect(hits[0]).toContain('observation')
  })

  it('FIRES on the bridge too, and names the bridge', () => {
    const hits = lengthFailures('short observation here.', `${words(WRITER_MAX_SENTENCE_WORDS + 5)}.`)
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain('bridge')
  })

  // THE OTHER DIRECTION. Exactly at the cap must pass, or the gate is off by one and
  // rejects legal copy: readabilityScore fails sentences OVER the cap, not AT it.
  it('does NOT fire at exactly the cap', () => {
    expect(lengthFailures(`${words(WRITER_MAX_SENTENCE_WORDS)}.`, 'short bridge here.')).toEqual([])
  })

  it('does NOT fire on two short sentences that sum over the cap', () => {
    // Each is legal on its own and the pair is well over. 12 + 12 = 24, over 18, and the
    // numbers are derived so this keeps working if the cap moves again.
    const half = Math.max(2, WRITER_MAX_SENTENCE_WORDS - 6)
    const two = `${words(half)}. ${words(half)}.`
    expect(lengthFailures(two, 'short bridge here.')).toEqual([])
  })

  // HEDGES STAY LOGGED. 39 of 84 carried one; gating them would drop 46% of openings to
  // the authored template, which is worse copy than what it rejected.
  it('does NOT gate a hedge phrase, however many', () => {
    const hedged = 'they often find the week fills up.'
    const bridge = 'that tends to be what usually waits.'
    expect(lengthFailures(hedged, bridge)).toEqual([])
    expect(gate(hedged, bridge).some(f => /hedg/i.test(f))).toBe(false)
  })

  // MUTATION GUARD. Reverting the gate to log-only must fail this file rather than pass it.
  it('fails if the length gate is reverted to log-only', () => {
    const over = `${words(WRITER_MAX_SENTENCE_WORDS + 9)}.`
    expect(gate(over, 'short bridge here.').length).toBeGreaterThan(0)
  })
})

// ─── THE CAP IS THE WRITER'S OWN NUMBER, AND THE PROMPT SAYS SO ──────────────
//
// The block above covers the gate's BEHAVIOUR. These two cover the things it cannot see:
// which constant the gate is pointed at, and whether the prompt agrees with it.
//
// WHY 18 RATHER THAN 15. 15 was tried and MEASURED END TO END on 2026-09-22 across the same
// 84-prospect cohort: the template rate went to 31 to 38 percent, there were 135
// sentence-length rejections, and good bridges of 17 and 19 words were lost. A prospect that
// exhausts its retries ships the approved template instead of personalised copy, so an
// over-tight cap spends the very thing the writer exists to produce. 18 was the agreed fix.
describe('gate: the writer cap is its own number, and the prompt agrees', () => {
  it('is the writer s OWN cap, strictly tighter than the shared 25-word one', () => {
    // The mutation this kills: re-pointing readabilityScore back at MAX_SENTENCE_WORDS. A
    // 19-word sentence is legal under 25 and illegal under the writer's cap, so that change
    // would silently stop rejecting most of what the writer actually writes.
    expect(WRITER_MAX_SENTENCE_WORDS).toBe(18)
    expect(WRITER_MAX_SENTENCE_WORDS).toBeLessThan(MAX_SENTENCE_WORDS)
  })

  it('the PROMPT states the same number the gate enforces', () => {
    // A gate the prompt contradicts spends retries on a rule the writer was never told,
    // and an exhausted prospect ships the template. Interpolated, so they cannot drift.
    expect(buildWriterPrompt()).toContain(`AT MOST ${WRITER_MAX_SENTENCE_WORDS} WORDS`)
  })
})
