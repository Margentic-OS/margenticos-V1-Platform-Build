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

// ─── THE PLURAL CHAIN AND THE SIX ADDED WORDS, 2026-09-14 ────────────────────
//
// THE REPORT. The gate rejected "Qualified", "Boutique", "Decision-makers",
// "Cross-market", "Producers" and "Drivers" at the start of a sentence. Each cost a writer
// attempt, and two prospects shipped the generic template because of it.
//
// TWO SEPARATE CAUSES, and reading them as one is why the earlier narrow fix in
// prompt-name-scan.ts did not reach the shipped gate:
//
//   THE CHAIN     "drivers" and "producers" are plurals of words that are only ordinary
//                 THROUGH a suffix rule. lemmaCandidates applied one step, never two.
//   THE WORDS     "qualify", "boutique" and "cross" were simply absent from the list.
//
// BOTH DIRECTIONS ARE ASSERTED BELOW, because a gate that allows everything is an outage
// that reports success. The permissive tests and the discriminating tests are equally
// load-bearing, and the invented-plural block is the one that proves the chain did not
// simply switch the check off.
describe('an ordinary word opening a sentence is not a name', () => {
  const opens = (word: string) =>
    findSentenceInitialNames(`${word} carry the rest of this sentence along.`, UNRELATED_FINDINGS)

  // The six from the report, each with the cause it exercises.
  it.each([
    ['Qualified',       'past participle; needed "qualify" in the vocabulary'],
    ['Boutique',        'needed "boutique" in the vocabulary'],
    ['Decision-makers', 'compound; "makers" needed the plural chain to reach "make"'],
    ['Cross-market',    'compound; needed "cross" in the vocabulary'],
    ['Producers',       'plural chain: producers -> producer -> produce'],
    ['Drivers',         'plural chain: drivers -> driver -> drive'],
  ])('allows %s at the start of a sentence (%s)', word => {
    expect(opens(word), `${word} must not be read as a name`).toEqual([])
  })

  // Measured in the stored writer runs of 2026-09-14. Every one of these was the ONLY gate
  // that failed on its attempt, so each cost a whole writer attempt for nothing.
  it.each(['Boutiques', 'Referral-dependent', 'Scouting', 'Sole-owner'])(
    'allows %s, rejected in a real run with no other gate failing',
    word => { expect(opens(word)).toEqual([]) },
  )

  // THE OTHER DIRECTION, ON THE SAME CORPUS. These were rejected in the same runs and the
  // rejections are CORRECT. If this block ever goes green-by-allowing, the fix above has
  // been widened into an outage.
  it('still catches the real company the same runs rejected three times', () => {
    expect(opens('Salesforce')).toHaveLength(1)
  })

  it('still catches the writer leaking its own drafting labels', () => {
    // "Bridge" and "OBSERVATION" are the writer printing its field names into the answer.
    // Deliberately kept out of the vocabulary, for the reason "treasury" and "cave" are:
    // an ordinary word that is also a label is worth more as a leak detector.
    for (const label of ['Bridge', 'OBSERVATION', 'BRIDGE']) {
      expect(opens(label), `${label} must stay rejected`).toHaveLength(1)
    }
  })

  it('still catches every real entity in the writer prompt', () => {
    for (const name of ['Taffet', 'Sovern', 'Visteon', 'Stanford', 'Hollywood', 'Pani',
                        'DTCC', 'Treasury', 'Zentara', 'Quillion', 'Fernbrook']) {
      expect(opens(name), `${name} LEAKED`).toHaveLength(1)
    }
  })

  // THE MUTATION TEST FOR THE CHAIN ITSELF, and the reason the chain is bounded at one
  // extra step through a plural rather than being general recursion. An invented name with
  // a plural ending is the exact shape the chain could have let through, so it is the shape
  // that has to be asserted rather than reasoned about.
  it('still catches an INVENTED name that merely looks plural', () => {
    for (const name of ['Zentaras', 'Quillions', 'Fernbrooks', 'Taffets', 'Soverns',
                        'Cormacks', 'Brindles', 'Halveras', 'Norvaks', 'Ludderns']) {
      expect(opens(name), `${name} LEAKED through the plural chain`).toHaveLength(1)
    }
  })

  it('still catches a plural name MID-sentence, where capitalisation is evidence again', () => {
    // The gate only ever judges sentence-initial tokens; untraceableClaims owns the rest.
    // Asserted so widening the vocabulary is never mistaken for widening the position set.
    const mid = findSentenceInitialNames(
      'The firms we spoke to all named Zentaras as the incumbent.', UNRELATED_FINDINGS)
    expect(mid).toEqual([])
  })
})

describe('the plural chain, at the vocabulary level', () => {
  // THE DEFECT, STATED AS THE MEASUREMENT THAT FOUND IT. Measured at ce13be3:
  // driver=true drivers=FALSE, producer=true producers=FALSE, maker=true makers=FALSE.
  // A singular and its plural must agree, and before this they did not.
  it.each([
    ['driver', 'drivers'], ['producer', 'producers'], ['maker', 'makers'],
    ['buyer', 'buyers'], ['founder', 'founders'], ['training', 'trainings'],
  ])('%s and %s agree', (singular, plural) => {
    expect(isOrdinaryWord(singular)).toBe(true)
    expect(isOrdinaryWord(plural), `${plural} must follow ${singular}`).toBe(true)
  })

  // WHY THE BUG WAS INVISIBLE TO A SPOT CHECK, kept as an assertion so the next person
  // does not re-derive it. "buyers" and "founders" worked by luck: the -ers rule also
  // proposes the three-letter stem, and "buy" and "found" are in the list where "driv"
  // and "produc" are not. Anyone checking the obvious words would have seen it work.
  it('the words that worked before did so through a DIFFERENT rule', () => {
    expect(isOrdinaryWord('buy')).toBe(true)     // buyers -> buy, one step
    expect(isOrdinaryWord('found')).toBe(true)   // founders -> found, one step
    expect(isOrdinaryWord('driv')).toBe(false)   // drivers -> driv, dead end
    expect(isOrdinaryWord('produc')).toBe(false) // producers -> produc, dead end
    expect(isOrdinaryWord('drive')).toBe(true)   // reached only by the chain
    expect(isOrdinaryWord('produce')).toBe(true) // reached only by the chain
  })

  // THE SELF-LIMIT, which is what makes the chain safe. Every step proposes CANDIDATES,
  // and a candidate only counts if the vocabulary already holds it. The chain can never
  // admit a word the list does not already carry.
  it('cannot admit a word the vocabulary does not already hold', () => {
    expect(isOrdinaryWord('zentara')).toBe(false)
    expect(isOrdinaryWord('zentaras')).toBe(false)
    expect(isOrdinaryWord('zentarer')).toBe(false)
    expect(isOrdinaryWord('zentarers')).toBe(false)
  })

  // THE CHAIN IS BOUNDED AT ONE EXTRA STEP, AND ONLY THROUGH A PLURAL. A non-plural first
  // step is not re-expanded. This is the assertion that fails if someone later turns the
  // chain into general recursion, which would widen the gate well past what was measured.
  it('does not chain a non-plural first step', () => {
    // "runninger" -> (-er) "runnin"/"running" and STOPS. General recursion would carry
    // "running" on to "run" and call this ordinary English, which it is not.
    expect(isOrdinaryWord('runninger')).toBe(false)
  })

  it('the six added words are in the vocabulary, not reached by some accident of a rule', () => {
    for (const w of ['boutique', 'cross', 'dependent', 'qualify', 'scout', 'sole']) {
      expect(isOrdinaryWord(w), `${w} missing`).toBe(true)
    }
  })

  // The list only ever grows, and it grew by six. Asserted so an edit that empties or
  // truncates it is visible, in the same spirit as the count assertion further up.
  it('grew by exactly the six words that were argued for', () => {
    expect(ORDINARY_WORD_COUNT).toBe(1753)
  })
})

// ─── AN ACRONYM WRITTEN IN THE OTHER NUMBER, 2026-09-15 ──────────────────────
//
// THE SHAPE. An acronym never reaches the vocabulary. hasNameOrthography fires on the
// all-caps run first and short-circuits, so no word-list entry and no lemma rule can ever
// rescue one. Traceability is the ONLY thing that can clear an acronym, which makes an
// exact-match-only traceability test load-bearing in a way it is not for ordinary words.
//
// MEASURED at 9311a26, before the fix: the EXACT token already passed, and only the number
// mismatch failed.
//
//     CFOs  findings say "their CFO"      FAIL (orthography)     <- the whole defect
//     CFO   findings say "two CFOs"       FAIL (orthography)
//     MQS   findings say "they run MQS"   pass
//     DTCC  findings say "DTCC published" pass
//
// WHY ORTHOGRAPHY ITSELF WAS NOT TOUCHED, which is the change a reader will expect and
// which would have been wrong. Measured across all 22 stored writer exports, the
// orthography signal has fired 13 times on three distinct words: BRIDGE (9), OBSERVATION
// (3), OFFER (1). Every one is the writer leaking its own drafting label into the answer,
// and every one of those rejections is CORRECT. Exempting all-caps words as a class would
// switch off the only thing orthography is observed to do. CFOs, MQS and DTCC have never
// been rejected in any stored run, so there was no measured false positive to weigh
// against that.
describe('an acronym the findings supply is not an invented name', () => {
  const opens = (word: string, findings: string) =>
    findSentenceInitialNames(`${word} came up in the last review.`, findings)

  it.each([
    ['CFOs', 'their CFO joined in May'],
    ['CFO', 'two CFOs left last year'],
    ['MQSs', 'they run MQS on site'],
    ['DTCCs', 'DTCC published the rule'],
  ])('allows %s when the findings carry it as "%s"', (word, finding) => {
    expect(opens(word, `1. Note: ${finding}.`), `${word} must not read as a name`).toEqual([])
  })

  it.each(['CFOs', 'MQS', 'DTCC'])('allows %s when the findings carry the exact token', word => {
    expect(opens(word, `1. Note: ${word} came up in their update.`)).toEqual([])
  })

  // THE OTHER DIRECTION. The variant is still a TRACEABILITY test: both forms are looked
  // up in the same corpus, so an acronym the findings never mention is rejected exactly as
  // before. This is what stops the fix becoming a blanket all-caps exemption.
  it.each(['CFOs', 'MQS', 'DTCC'])('still catches %s when the findings do not mention it', word => {
    expect(opens(word, UNRELATED_FINDINGS)).toHaveLength(1)
  })

  it('does not let one acronym borrow another acronym\'s traceability', () => {
    expect(opens('CFOs', '1. They mentioned SLA and KPI targets.')).toHaveLength(1)
    expect(opens('DTCC', '1. They mentioned SLA and KPI targets.')).toHaveLength(1)
  })

  it('still catches an INVENTED acronym, which is the mutation test for this rule', () => {
    for (const name of ['ZQX', 'NVRA', 'QLLN', 'ZNTR', 'BRDX', 'KVRO']) {
      expect(opens(name, UNRELATED_FINDINGS), `${name} LEAKED`).toHaveLength(1)
    }
  })

  it('still catches the drafting labels, which is all orthography actually catches', () => {
    for (const label of ['BRIDGE', 'OBSERVATION', 'OFFER']) {
      expect(opens(label, UNRELATED_FINDINGS), `${label} must stay rejected`).toHaveLength(1)
    }
  })

  // The variant rule must not reach anything that is not an acronym. These all still go
  // through the unchanged path, so an internal-capital name is judged exactly as before.
  it('leaves non-acronyms untouched', () => {
    for (const name of ['Salesforce', 'HydrospherIQ', 'FinTechIQ', 'LinkedIn', 'Web3',
                        'Taffet', 'Sovern', 'Visteon', 'Zentara']) {
      expect(opens(name, UNRELATED_FINDINGS), `${name} LEAKED`).toHaveLength(1)
    }
  })

  // A plural s alone must not make a name traceable. WRITTEN EXPECTING 0 AND CORRECTED TO
  // 1 BY THE RUN: "Zentaras" is rejected even when the findings name "Zentara", because
  // the variant rule requires an ALL-CAPS token and a title-case word never gets one. That
  // is the stricter outcome and the right one, and it is the assertion that fails first if
  // someone later widens the shape from `^\p{Lu}{2,}s?$` to any capitalised plural.
  it('does not treat a title-case plural as an acronym pair', () => {
    expect(opens('Zentaras', '1. Note: Zentara came up in their update.')).toHaveLength(1)
    expect(opens('Zentaras', UNRELATED_FINDINGS)).toHaveLength(1)
    // The acronym pair, by contrast, does resolve. The two lines together are the rule.
    expect(opens('ZQXs', '1. Note: ZQX came up in their update.')).toHaveLength(0)
  })

  // POSITION. This gate judges only the first word of a sentence; untraceableClaims owns
  // every other position and is deliberately not changed here. Asserted so that widening
  // traceability is never mistaken for widening the position set.
  it('still judges only sentence-initial tokens', () => {
    expect(findSentenceInitialNames(
      'The team told us ZQX came up in the review.', UNRELATED_FINDINGS)).toEqual([])
  })
})
