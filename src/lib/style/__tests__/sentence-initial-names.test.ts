import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  findSentenceInitialNames,
  checkSentenceInitialNames,
  SENTENCE_INITIAL_GATE_MODE,
} from '../sentence-initial-names'
import { isOrdinaryWord, ORDINARY_WORD_COUNT } from '../ordinary-words'
import { checkOpeningGates, joinOpening } from '@/lib/agents/research/write-opening'

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
import { logger } from '@/lib/logger'

beforeEach(() => { vi.mocked(logger.warn).mockClear() })

// Findings that mention nothing in the entity list, so a hit is a genuine hit.
const UNRELATED_FINDINGS = `1. You posted about a new hire last month.
   source: social | post 2026-08-01`

/** The exact shape production builds: observation, blank line, bridge, space, question. */
function productionBlock(observation: string, bridge: string, question: string): string {
  return `${joinOpening(observation, bridge)} ${question}`.trim()
}

describe('the hole, reproduced at the real production shape', () => {
  // Every named entity in the writer prompt's worked examples. Measured 2026-08-28:
  // twelve of these sixteen pass the existing untraceableClaims when placed
  // sentence-initially, because the observation before them always ends in a full stop.
  const PROMPT_ENTITIES = [
    'Taffet', 'HydrospherIQ', 'London', 'DTCC', 'Treasury', 'SEC', 'Sovern LA',
    'LinkedIn', 'CAVE', 'Jason', 'Pani', 'Visteon',
    // These three leaked their FIRST token sentence-initially too. The old gate caught
    // them only by the tail, which is luck rather than cover.
    'Hollywood Food Coalition', 'Stanford GSB', 'Knot Consulting',
  ]

  it.each(PROMPT_ENTITIES)('catches "%s" opening the bridge', entity => {
    const observation = 'You took two board seats early this year.'
    const bridge = `${entity} is the kind of place where that happens.`
    const question = 'Worth a look?'

    const hits = findSentenceInitialNames(
      productionBlock(observation, bridge, question), UNRELATED_FINDINGS,
    )
    expect(hits.map(h => h.word)).toContain(entity.split(' ')[0])
  })

  // THE ONE ENTITY THIS GATE DOES NOT CATCH, AND WHY THAT IS CORRECT.
  //
  // "Blue" is ordinary English, so allowing it is the design working rather than failing:
  // rejecting every sentence that opens with a common adjective is exactly the false
  // positive that costs writer attempts. "Blue Sky" is still defended, because "Sky" is
  // not sentence-initial and untraceableClaims has always caught it.
  //
  // Asserted as a PAIR on purpose. Each gate alone leaves this name uncovered, and a test
  // of either one alone would report success while the seam between them was the only
  // thing holding.
  it('leaves "Blue" to the existing gate, which catches the tail "Sky"', () => {
    const block = productionBlock(
      'You took two board seats early this year.',
      'Blue Sky has been growing since then.',
      'Worth a look?',
    )
    expect(findSentenceInitialNames(block, UNRELATED_FINDINGS)).toEqual([])

    const failures = checkOpeningGates(block, null, UNRELATED_FINDINGS)
    expect(failures.find(f => f.startsWith('claims not traceable'))).toContain('Sky')
  })

  it('reports a multi-token name as the whole run, so "Sovern LA" is not judged on "LA"', () => {
    const hits = findSentenceInitialNames(
      productionBlock(
        'You took two board seats early this year.',
        'Sovern LA has been growing since then.',
        'Worth a look?',
      ),
      UNRELATED_FINDINGS,
    )
    // The old gate skipped "Sovern" as sentence-initial and skipped "LA" as under three
    // characters, so the pair fell through both exemptions at once.
    expect(hits).toHaveLength(1)
    expect(hits[0].run).toBe('Sovern LA')
  })

  it('catches a name in the QUESTION, which is sentence-initial for the same reason', () => {
    const hits = findSentenceInitialNames(
      productionBlock(
        'You took two board seats early this year.',
        'That tends to fill the calendar.',
        'Visteon aside, is that worth a look?',
      ),
      UNRELATED_FINDINGS,
    )
    expect(hits.map(h => h.word)).toContain('Visteon')
  })

  it('catches a name at index 0, the observation\'s own first word', () => {
    const hits = findSentenceInitialNames(
      productionBlock(
        'Taffet has been running two mandates at once.',
        'That tends to fill the calendar.',
        'Worth a look?',
      ),
      UNRELATED_FINDINGS,
    )
    expect(hits.map(h => h.word)).toContain('Taffet')
  })

  it('catches an INVENTED company, which no denylist could hold', () => {
    // The failure that matters. This name exists nowhere: not in the prompt, not in the
    // findings, not in any list. It is caught because it is not English.
    const hits = findSentenceInitialNames(
      productionBlock(
        'You took two board seats early this year.',
        'Verdantis Partners sees that pattern often.',
        'Worth a look?',
      ),
      UNRELATED_FINDINGS,
    )
    expect(hits.map(h => h.word)).toContain('Verdantis')
    expect(hits[0].signal).toBe('not-english')
  })

  it('catches a name carrying a digit', () => {
    const hits = findSentenceInitialNames(
      productionBlock(
        'You took two board seats early this year.',
        'Web3 buyers behave differently.',
        'Worth a look?',
      ),
      UNRELATED_FINDINGS,
    )
    expect(hits.map(h => h.word)).toContain('Web3')
    expect(hits[0].signal).toBe('orthography')
  })

  it('catches a hallucinated regulator by orthography alone', () => {
    const hits = findSentenceInitialNames(
      productionBlock(
        'You took two board seats early this year.',
        'FINRA rules changed for firms like that.',
        'Worth a look?',
      ),
      UNRELATED_FINDINGS,
    )
    expect(hits.map(h => h.word)).toContain('FINRA')
    expect(hits[0].signal).toBe('orthography')
  })
})

describe('legitimate copy is not rejected', () => {
  // THE CASE THAT MATTERS MOST. A gate that rejects real personalisation is worse than
  // the hole it closes.
  it('lets a real prospect name through when the findings supplied it', () => {
    const findings = `1. Taffet publishes regulatory commentary regularly.
   source: website | taffet.com/insights`
    const hits = findSentenceInitialNames(
      productionBlock(
        'You publish regulatory commentary most weeks.',
        'Taffet reaches a different reader than the buyer does.',
        'Worth a look?',
      ),
      findings,
    )
    expect(hits).toEqual([])
  })

  it('lets a real prospect name through at index 0 too', () => {
    const findings = `1. Sovern LA added two board members in 2026.
   source: linkedin | post 2026-02-10`
    const hits = findSentenceInitialNames(
      productionBlock(
        'Sovern LA added two board seats this year.',
        'That tends to fill the calendar.',
        'Worth a look?',
      ),
      findings,
    )
    expect(hits).toEqual([])
  })

  // The fifteen distinct sentence-initial words measured across all 24 stored openings
  // that do NOT appear in their own findings. Every one is ordinary English, and every
  // one must survive, or the gate rejects copy that already shipped.
  const REAL_OPENERS = [
    'Between', 'Buyers', 'Finding', 'Founders', 'Most', 'New', 'Running', 'Shows',
    'That', 'Then', 'They', 'Those', 'When', 'You', 'Your',
  ]

  it.each(REAL_OPENERS)('does not reject "%s", measured in real shipped copy', opener => {
    const hits = findSentenceInitialNames(
      productionBlock(
        'You took two board seats early this year.',
        `${opener} tends to follow from that.`,
        'Worth a look?',
      ),
      UNRELATED_FINDINGS,
    )
    expect(hits).toEqual([])
  })

  // Open-class nouns that no function-word list would contain. These are the words a
  // closed-class allowlist would have falsely rejected, which is why the discriminator
  // is a vocabulary.
  const OPEN_CLASS = ['Delivery', 'Referrals', 'Pipeline', 'Consultants', 'Retainers', 'Proposals']

  it.each(OPEN_CLASS)('does not reject the open-class opener "%s"', opener => {
    const hits = findSentenceInitialNames(
      productionBlock(
        'You took two board seats early this year.',
        `${opener} tend to arrive in bursts.`,
        'Worth a look?',
      ),
      UNRELATED_FINDINGS,
    )
    expect(hits).toEqual([])
  })

  it('ignores a lowercase word, whatever else is true of it', () => {
    // Capitalisation is not evidence of a name here, but its ABSENCE is evidence against
    // one. Without this guard the check reads ordinary lowercase prose as candidate names.
    const hits = findSentenceInitialNames(
      productionBlock(
        'You took two board seats early this year.',
        'taffet tends to follow from that.',
        'Worth a look?',
      ),
      UNRELATED_FINDINGS,
    )
    expect(hits).toEqual([])
  })

  it('does not reject a hyphenated compound of two ordinary words', () => {
    // "Follow-up" is one token to the splitter and matches no lemma whole, so without the
    // compound rule it reads as an invented name and rejects perfectly good copy.
    const hits = findSentenceInitialNames(
      productionBlock(
        'You took two board seats early this year.',
        'Follow-up tends to slip in that stretch.',
        'Worth a look?',
      ),
      UNRELATED_FINDINGS,
    )
    expect(hits).toEqual([])
  })

  it('never looks at a word that is not sentence-initial, because that one is already checked', () => {
    // "Visteon" mid-sentence is untraceableClaims' job. Reporting it here would double up.
    const hits = findSentenceInitialNames(
      productionBlock(
        'You took two board seats early this year.',
        'That happened after Visteon changed hands.',
        'Worth a look?',
      ),
      UNRELATED_FINDINGS,
    )
    expect(hits).toEqual([])
  })
})

describe('blocking, and the report-only path it replaced', () => {
  // FLIPPED 2026-08-31. Was 'report'. The flip is the point of the change, so it is
  // asserted rather than left to be inferred from behaviour: a constant nothing checks is
  // a constant that can be reverted by accident.
  it('ships in BLOCK mode', () => {
    expect(SENTENCE_INITIAL_GATE_MODE).toBe('block')
  })

  it('now returns a failure at the shipped mode, with no mode argument passed', () => {
    // The production call site passes no mode, so this is the call production makes. It is
    // the test that would have stayed green through the whole observation week and gone
    // red the moment the constant flipped, which is exactly what it is for.
    const failures = checkSentenceInitialNames(
      productionBlock(
        'You took two board seats early this year.',
        'Verdantis Partners sees that pattern often.',
        'Worth a look?',
      ),
      UNRELATED_FINDINGS,
      { prospectId: 'p1' },
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('Verdantis Partners')
  })

  // KEPT, NOT DELETED. The report path is still reachable through the parameter and is
  // what any future gate of this shape will be introduced behind. A path with no test is
  // a path that has quietly stopped working by the time someone next needs it.
  it('the report path still returns nothing, however bad the copy is', () => {
    const failures = checkSentenceInitialNames(
      productionBlock(
        'You took two board seats early this year.',
        'Verdantis Partners sees that pattern often.',
        'Worth a look?',
      ),
      UNRELATED_FINDINGS,
      { prospectId: 'p1' },
      'report',
    )
    expect(failures).toEqual([])
  })

  it('THE FLIP WORKS: block mode returns a failure naming the run', () => {
    const failures = checkSentenceInitialNames(
      productionBlock(
        'You took two board seats early this year.',
        'Verdantis Partners sees that pattern often.',
        'Worth a look?',
      ),
      UNRELATED_FINDINGS,
      { prospectId: 'p1' },
      'block',
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('Verdantis Partners')
  })

  it('block mode still allows a name the findings supplied', () => {
    const findings = '1. Taffet publishes commentary.\n   source: website | taffet.com'
    expect(checkSentenceInitialNames(
      productionBlock('You publish weekly.', 'Taffet reaches a different reader.', 'Worth a look?'),
      findings, { prospectId: 'p1' }, 'block',
    )).toEqual([])
  })
})

describe('wired into checkOpeningGates, and now blocking through it', () => {
  it('adds the failure to the gate list, which is what the flip changed', () => {
    const failures = checkOpeningGates(
      productionBlock(
        'You took two board seats early this year.',
        'Verdantis Partners sees that pattern often.',
        'Worth a look?',
      ),
      null, UNRELATED_FINDINGS, undefined,
      undefined, { prospectId: 'p1' },
    )
    expect(failures.filter(f => f.includes('opens a sentence with a name'))).toHaveLength(1)
  })

  // THE CASE THAT COSTS MONEY IF IT IS WRONG. Now that the gate blocks, a false positive
  // is a discarded writer attempt and another Sonnet call, so the no-false-rejection
  // property is asserted through the REAL production entry point rather than only through
  // the pure function.
  it('does not reject a real opening whose names all trace to the findings', () => {
    const findings = `1. Taffet added two board seats in early 2026.
   source: linkedin | post 2026-02-10`
    const failures = checkOpeningGates(
      productionBlock(
        'You took two board seats early this year.',
        'Taffet reaches a different reader than the buyer does.',
        'Worth a look?',
      ),
      null, findings, undefined, undefined, { prospectId: 'p1' },
    )
    expect(failures.filter(f => f.includes('opens a sentence with a name'))).toEqual([])
  })

  // KEPT AFTER THE FLIP, WITH ITS REASON REWRITTEN RATHER THAN LEFT STALE. While the mode
  // was 'report' this was the ONLY thing protecting the wiring: the check returned an empty
  // array, so deleting the call in checkOpeningGates changed no gate result and no other
  // test went red. That is no longer true, and the test above it would now catch a deleted
  // call on its own.
  //
  // It still earns its place, because it is the only assertion on the LOG, and the log is
  // what a human reads when this gate rejects something. It also pins the mode that reaches
  // the log line, so a half-done revert that flips the constant without the tests is caught
  // here as well as above.
  //
  // This is the monitor-sweep shape: a check that runs, reports success, and never reached
  // the thing it was supposed to protect.
  it('WIRING: checkOpeningGates actually calls the check, proved by the log', () => {
    checkOpeningGates(
      productionBlock(
        'You took two board seats early this year.',
        'Verdantis Partners sees that pattern often.',
        'Worth a look?',
      ),
      null, UNRELATED_FINDINGS, undefined,
      undefined, { prospectId: 'p-wiring' },
    )
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('sentence-initial-gate'),
      expect.objectContaining({ prospectId: 'p-wiring', mode: 'block' }),
    )
  })

  it('the existing untraceable gate still misses it, which is the defect this records', () => {
    // Kept deliberately. If someone later fixes untraceableClaims itself, this test fails
    // and tells them this gate is now redundant rather than leaving both in place.
    const failures = checkOpeningGates(
      productionBlock(
        'You took two board seats early this year.',
        'Verdantis Partners sees that pattern often.',
        'Worth a look?',
      ),
      null, UNRELATED_FINDINGS,
    )
    // "Partners" is not sentence-initial, so the old gate catches the TAIL and not the name.
    const traceable = failures.find(f => f.startsWith('claims not traceable'))
    expect(traceable).toBeDefined()
    expect(traceable).not.toContain('Verdantis')
  })
})

describe('the vocabulary', () => {
  it('holds a substantial list, so a botched edit that empties it is visible', () => {
    expect(ORDINARY_WORD_COUNT).toBeGreaterThan(1500)
  })

  it('does not contain the names it must catch', () => {
    for (const name of ['taffet', 'sovern', 'visteon', 'pani', 'hydrospheriq', 'verdantis']) {
      expect(isOrdinaryWord(name)).toBe(false)
    }
  })

  it('resolves inflections, so the list can stay lemma-sized', () => {
    expect(isOrdinaryWord('Buyers')).toBe(true)   // buyer -> buy
    expect(isOrdinaryWord('Finding')).toBe(true)  // find
    expect(isOrdinaryWord('Running')).toBe(true)  // run, doubled consonant
    expect(isOrdinaryWord('Founders')).toBe(true) // founder -> found
    expect(isOrdinaryWord('Scaled')).toBe(true)   // scale, dropped e
    expect(isOrdinaryWord('Tried')).toBe(true)    // try, ied -> y
  })

  // THE ONE FALSE POSITIVE THE 2026-08-31 REPLAY FOUND, and the family it belongs to.
  // Every other rule in lemmaCandidates is a SUFFIX rule, and an irregular past tense
  // escapes all of them by changing the stem instead of adding to it.
  it('resolves irregular past tense and past participle forms', () => {
    // The measured case: "Saw your post from last week: networking presentations..."
    expect(isOrdinaryWord('Saw')).toBe(true)      // see
    expect(isOrdinaryWord('Went')).toBe(true)     // go
    expect(isOrdinaryWord('Took')).toBe(true)     // take
    expect(isOrdinaryWord('Built')).toBe(true)    // build
    expect(isOrdinaryWord('Brought')).toBe(true)  // bring
    expect(isOrdinaryWord('Told')).toBe(true)     // tell
    expect(isOrdinaryWord('Written')).toBe(true)  // write
    expect(isOrdinaryWord('Understood')).toBe(true) // understand
  })

  // THE MAP IS CANDIDATES, NOT AN ALLOWLIST, and that distinction is the safety property.
  // A form only resolves if its LEMMA is already in the vocabulary, so the map can never
  // admit a word the list does not already carry. Without this test the difference between
  // the two designs is invisible, and the next person to widen it would not know the
  // constraint existed.
  it('does not admit an irregular form whose lemma is absent from the vocabulary', () => {
    // "draw" and "rise" are not in the list, so their irregular forms stay caught even
    // though both are in the map. "Drew" and "Rose" are common names, so this matters.
    expect(isOrdinaryWord('Drew')).toBe(false)
    expect(isOrdinaryWord('Rose')).toBe(false)
  })

  it('an irregular form does not rescue a name that merely looks like one', () => {
    for (const name of ['taffet', 'sovern', 'visteon', 'pani', 'verdantis']) {
      expect(isOrdinaryWord(name)).toBe(false)
    }
  })
})

describe('traceability matches whole words, not substrings', () => {
  // MEASURED over the 262 real findings blocks in prospect_research_results: a bare
  // `includes` falsely cleared "SEC" in 104 of the 120 blocks it matched, via
  // "section"/"sector"/"second"/"securities", and "Pani" in 38, via "companies".
  const CARRIER_FINDINGS = `1. The company has grown across several sections of the market.
   source: website | about page`

  it('does not clear "Pani" because "companies" contains it', () => {
    const findings = `1. Most companies in that position hire slowly.
   source: website | about page`
    const hits = findSentenceInitialNames(
      productionBlock('You hired twice this year.', 'Pani has been growing since then.', 'Worth a look?'),
      findings,
    )
    expect(hits.map(h => h.word)).toContain('Pani')
  })

  it('does not clear "SEC" because "section" and "second" contain it', () => {
    const hits = findSentenceInitialNames(
      productionBlock('You hired twice this year.', 'SEC rules changed for firms like that.', 'Worth a look?'),
      CARRIER_FINDINGS,
    )
    expect(hits.map(h => h.word)).toContain('SEC')
  })

  // THE OTHER DIRECTION, WHICH IS THE ONE THAT COSTS COPY. Tightening traceability makes
  // the gate stricter, so the risk is now rejecting a name the findings really did supply.
  it('still clears a name the findings supply as a whole word', () => {
    const findings = `1. Pani Group added two board members in 2026.
   source: linkedin | post 2026-02-10`
    expect(findSentenceInitialNames(
      productionBlock('You hired twice this year.', 'Pani has been growing since then.', 'Worth a look?'),
      findings,
    )).toEqual([])
  })

  it('clears a name adjacent to punctuation, which is not a word character', () => {
    const findings = `1. Two board seats, at Sovern LA and elsewhere.
   source: linkedin | post 2026-02-10`
    expect(findSentenceInitialNames(
      productionBlock('You hired twice this year.', 'Sovern LA has been growing.', 'Worth a look?'),
      findings,
    )).toEqual([])
  })
})
