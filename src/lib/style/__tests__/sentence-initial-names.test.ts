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

describe('report-only, and the flip', () => {
  it('ships in report mode', () => {
    expect(SENTENCE_INITIAL_GATE_MODE).toBe('report')
  })

  it('returns no failures in report mode, however bad the copy is', () => {
    const failures = checkSentenceInitialNames(
      productionBlock(
        'You took two board seats early this year.',
        'Verdantis Partners sees that pattern often.',
        'Worth a look?',
      ),
      UNRELATED_FINDINGS,
      { prospectId: 'p1' },
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

describe('wired into checkOpeningGates without changing its behaviour today', () => {
  it('adds no failure while the mode is report', () => {
    const failures = checkOpeningGates(
      productionBlock(
        'You took two board seats early this year.',
        'Verdantis Partners sees that pattern often.',
        'Worth a look?',
      ),
      null, UNRELATED_FINDINGS, undefined,
      undefined, { prospectId: 'p1' },
    )
    expect(failures.filter(f => f.includes('opens a sentence with a name'))).toEqual([])
  })

  // WITHOUT THIS TEST THE WIRING IS UNPROTECTED. In report mode the check returns an empty
  // array, so deleting the call in checkOpeningGates changes no gate result and no other
  // test goes red. The log line is the only observable effect there is during the
  // observation week, so the log line is what proves the call happens at all.
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
      expect.objectContaining({ prospectId: 'p-wiring', mode: 'report' }),
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
})
