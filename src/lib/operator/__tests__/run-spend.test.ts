// A paid run stops itself before it can spend more than its cap, and the cap is 3 US
// dollars when nobody said otherwise.
//
// Run:
//   npx vitest run src/lib/operator/__tests__/run-spend.test.ts
//
// WHAT THIS COVERS. The arithmetic in run-spend.ts, and the one run loop that can be
// driven without a database or a model: the follow-up backfill's, which takes everything
// it touches as an argument.
//
// WHAT IT DOES NOT. The other three scripts (run-firm-fact, run-competitor-screen,
// run-research) have no harness and call paid APIs, so nothing here runs them. Their caps
// are a few lines each over the functions tested below, and a test of this file proves
// those functions, not that each script still calls them. Deleting the cap from a script
// would pass every test here.
//
// THE ONE EXCEPTION is the last suite, which READS the four scripts as text: every value
// flag a script reads is on the list it refuses in the wrong form, --limit goes through
// parseLimit, and the research worst case is computed. A scan of the text proves the text.
// It cannot see a call that is present and unreachable.
//
// No real name, company or organisation appears in a fixture.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { COST_WEB_SEARCH_PER_SEARCH, USD_PER_MTOK } from '@/lib/agents/research/cost-constants'
import {
  DEFAULT_RUN_CAP_USD,
  RunSpend,
  parseCapUsd,
  parseLimit,
  researchFetchWorstCaseUsd,
  researchUsageRowUsd,
  valueFlagProblems,
} from '../run-spend'
import type { FollowupsForStoredEmail1, StoredEmail1Row } from '../../../../scripts/backfill-followups'

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

describe('the default cap', () => {
  it('PLANTED: is three dollars', () => {
    expect(DEFAULT_RUN_CAP_USD).toBe(3)
  })

  it('PLANTED: a run that was given no cap still has one', () => {
    expect(new RunSpend().capUsd).toBe(3)
    expect(new RunSpend().canAfford(3.01)).toBe(false)
  })
})

describe('parseCapUsd', () => {
  it('PLANTED: nothing typed is the default', () => {
    expect(parseCapUsd(undefined)).toBe(3)
  })

  it('reads a plain number of dollars', () => {
    expect(parseCapUsd('3')).toBe(3)
    expect(parseCapUsd('0.50')).toBe(0.5)
    expect(parseCapUsd('12.25')).toBe(12.25)
    expect(parseCapUsd(' 2 ')).toBe(2)
  })

  // Every one of these is something a person could type meaning a cap. None may come back
  // as the default: a cap somebody typed and did not get is the failure this guards.
  it.each([
    ['an empty string', ''],
    ['spaces', '   '],
    ['a word', 'abc'],
    ['zero', '0'],
    ['zero with decimals', '0.00'],
    ['a negative number', '-1'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['a currency sign', '$3'],
    ['a number with a unit', '3usd'],
    ['exponent notation', '1e3'],
    ['hexadecimal', '0x10'],
    ['the next flag, swallowed as the value', '--commit'],
  ])('PLANTED: throws on %s and does not fall back to the default', (_what, raw) => {
    expect(() => parseCapUsd(raw)).toThrow(/--max-usd must be a number of US dollars greater than zero/)
  })

  it('the message quotes what was typed, so the person can see what was read', () => {
    expect(() => parseCapUsd('abc')).toThrow(/Got "abc"/)
  })
})

describe('RunSpend', () => {
  it('PLANTED: refuses a cap that is not a positive number', () => {
    expect(() => new RunSpend(0)).toThrow(/greater than zero/)
    expect(() => new RunSpend(-3)).toThrow(/greater than zero/)
    expect(() => new RunSpend(Number.NaN)).toThrow(/greater than zero/)
    expect(() => new RunSpend(Number.POSITIVE_INFINITY)).toThrow(/greater than zero/)
  })

  it('starts with nothing spent and the whole cap left', () => {
    const spend = new RunSpend(3)
    expect(spend.spent).toBe(0)
    expect(spend.remaining).toBe(3)
  })

  it('PLANTED: add accumulates, and what is left goes down by the same amount', () => {
    const spend = new RunSpend(3)
    spend.add(0.5)
    spend.add(0.22)
    expect(spend.spent).toBeCloseTo(0.72, 10)
    expect(spend.remaining).toBeCloseTo(2.28, 10)
  })

  it('adding zero is allowed: a free step is a real result', () => {
    const spend = new RunSpend(3)
    spend.add(0)
    expect(spend.spent).toBe(0)
  })

  it('PLANTED: a cost that is not a number throws instead of blinding the total', () => {
    const spend = new RunSpend(3)
    spend.add(1)
    expect(() => spend.add(Number.NaN)).toThrow(/cannot be trusted/)
    expect(() => spend.add(Number.POSITIVE_INFINITY)).toThrow(/cannot be trusted/)
    expect(spend.spent).toBe(1)
  })

  it('PLANTED: a negative cost throws, so nothing can hand the run its budget back', () => {
    const spend = new RunSpend(3)
    spend.add(2)
    expect(() => spend.add(-1.5)).toThrow(/zero or more/)
    expect(spend.spent).toBe(2)
  })

  it('PLANTED: what is left is never negative after an overshoot', () => {
    const spend = new RunSpend(1)
    spend.add(1.4)
    expect(spend.remaining).toBe(0)
  })

  describe('canAfford', () => {
    it('control: a step well inside the cap is affordable', () => {
      expect(new RunSpend(3).canAfford(0.02)).toBe(true)
    })

    it('PLANTED: landing exactly on the cap is affordable', () => {
      const spend = new RunSpend(3)
      spend.add(2.5)
      expect(spend.canAfford(0.5)).toBe(true)
    })

    it('PLANTED: one cent past the cap is not', () => {
      const spend = new RunSpend(3)
      spend.add(2.5)
      expect(spend.canAfford(0.51)).toBe(false)
    })

    it('PLANTED: counts what is already spent, not only the next step', () => {
      const spend = new RunSpend(3)
      expect(spend.canAfford(2)).toBe(true)
      spend.add(2)
      expect(spend.canAfford(2)).toBe(false)
    })

    it('PLANTED: a sum that lands on the cap only by float error is still affordable', () => {
      // 0.1 + 0.2 is 0.30000000000000004 in floating point. Nobody is billed the difference.
      const spend = new RunSpend(0.3)
      spend.add(0.1)
      expect(0.1 + 0.2).toBeGreaterThan(0.3)
      expect(spend.canAfford(0.2)).toBe(true)
    })

    it('PLANTED: the float allowance does not admit a real overspend, however small', () => {
      const spend = new RunSpend(0.3)
      spend.add(0.1)
      expect(spend.canAfford(0.2001)).toBe(false)
    })

    it('PLANTED: a worst case that is not a number is not affordable', () => {
      expect(new RunSpend(3).canAfford(Number.NaN)).toBe(false)
      expect(new RunSpend(3).canAfford(Number.POSITIVE_INFINITY)).toBe(false)
    })
  })

  describe('affordableCount', () => {
    it('PLANTED: is how many whole steps fit under the cap', () => {
      expect(new RunSpend(3).affordableCount(1)).toBe(3)
      expect(new RunSpend(3).affordableCount(0.7)).toBe(4)
      expect(new RunSpend(3).affordableCount(0.011)).toBe(272)
    })

    it('PLANTED: counts from what is left, not from the whole cap', () => {
      const spend = new RunSpend(3)
      spend.add(2)
      expect(spend.affordableCount(0.5)).toBe(2)
    })

    it('PLANTED: is not one short when the division lands a hair under a whole number', () => {
      // 0.3 / 0.1 is 2.9999999999999996 in floating point.
      expect(0.3 / 0.1).toBeLessThan(3)
      expect(new RunSpend(0.3).affordableCount(0.1)).toBe(3)
    })

    it('is zero when the cap cannot cover one step, and after an overshoot', () => {
      expect(new RunSpend(0.005).affordableCount(0.011)).toBe(0)
      const spend = new RunSpend(1)
      spend.add(1.2)
      expect(spend.affordableCount(0.1)).toBe(0)
    })

    it('PLANTED: refuses a worst case of zero, which would otherwise allow any number of steps', () => {
      expect(() => new RunSpend(3).affordableCount(0)).toThrow(/greater than zero/)
      expect(() => new RunSpend(3).affordableCount(-1)).toThrow(/greater than zero/)
      expect(() => new RunSpend(3).affordableCount(Number.NaN)).toThrow(/greater than zero/)
    })
  })

  describe('summary', () => {
    it('PLANTED: reads as dollars spent of a dollar cap', () => {
      const spend = new RunSpend(3)
      spend.add(0.72)
      expect(spend.summary()).toBe('$0.72 of a $3.00 cap')
    })

    it('nothing spent reads as zero', () => {
      expect(new RunSpend(3).summary()).toBe('$0.00 of a $3.00 cap')
    })

    it('PLANTED: a spend under a cent does not read as nothing spent', () => {
      const spend = new RunSpend(3)
      spend.add(0.0042)
      expect(spend.summary()).toBe('$0.0042 of a $3.00 cap')
    })

    it('a cap that is not a whole number of dollars is shown as typed', () => {
      expect(new RunSpend(1.5).summary()).toBe('$0.00 of a $1.50 cap')
    })
  })
})

describe('valueFlagProblems', () => {
  const EQUALS_FLAGS = ['org', 'ids', 'limit', 'after', 'max-usd']

  describe('a script that reads --name=value', () => {
    it('control: the form it reads is not a problem', () => {
      expect(valueFlagProblems(['--org=abc', '--limit=10', '--ids=a,b', '--after=x', '--max-usd=3', '--commit'], EQUALS_FLAGS, 'equals')).toEqual([])
    })

    it.each([
      ['--limit', '10'],
      ['--org', 'an-organisation-id'],
      ['--ids', 'a,b'],
      ['--after', 'x'],
      ['--max-usd', '3'],
    ])('PLANTED: %s written with a space is refused, and the form to use is given', (flag, value) => {
      const problems = valueFlagProblems(['--commit', flag, value], EQUALS_FLAGS, 'equals')
      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain(`Write ${flag}=${value}`)
    })

    it('PLANTED: a value flag with nothing after it is refused too', () => {
      expect(valueFlagProblems(['--limit'], EQUALS_FLAGS, 'equals')).toEqual([
        '--limit is read only with an equals sign and no space. Write --limit=<value>',
      ])
      // The next argument is another flag, not this flag's value.
      expect(valueFlagProblems(['--limit', '--commit'], EQUALS_FLAGS, 'equals')[0]).toContain('Write --limit=<value>')
    })

    it('PLANTED: an equals sign with nothing after it is refused: it would read as no limit', () => {
      expect(valueFlagProblems(['--limit='], EQUALS_FLAGS, 'equals')).toHaveLength(1)
    })

    it('PLANTED: every misread flag is reported, not only the first', () => {
      expect(valueFlagProblems(['--limit', '10', '--max-usd', '3'], EQUALS_FLAGS, 'equals')).toHaveLength(2)
    })

    it('a flag that takes no value is never mistaken for one', () => {
      expect(valueFlagProblems(['--commit', '--dry-run'], EQUALS_FLAGS, 'equals')).toEqual([])
    })

    it('a longer flag that starts the same way is left alone', () => {
      expect(valueFlagProblems(['--limited', '--organisation'], EQUALS_FLAGS, 'equals')).toEqual([])
    })
  })

  describe('a script that reads --name value', () => {
    const SPACE_FLAGS = ['org', 'limit', 'max-usd']

    it('control: the form it reads is not a problem', () => {
      expect(valueFlagProblems(['--org', 'abc', '--limit', '5', '--max-usd', '0.50', '--commit'], SPACE_FLAGS, 'space')).toEqual([])
    })

    it('PLANTED: an equals sign is refused, and the form to use is given', () => {
      expect(valueFlagProblems(['--org', 'abc', '--limit=5'], SPACE_FLAGS, 'space')).toEqual([
        '--limit=5 is not read: this script takes a space, not an equals sign. Write --limit 5',
      ])
      expect(valueFlagProblems(['--max-usd=1'], SPACE_FLAGS, 'space')[0]).toContain('Write --max-usd 1')
    })

    it('PLANTED: a flag left without its value is refused, at the end or before another flag', () => {
      expect(valueFlagProblems(['--org', 'abc', '--max-usd'], SPACE_FLAGS, 'space')).toEqual([
        '--max-usd has no value after it. Write --max-usd <value>, or leave the flag off',
      ])
      expect(valueFlagProblems(['--max-usd', '--commit'], SPACE_FLAGS, 'space')).toHaveLength(1)
    })

    it('a longer flag that starts the same way is left alone', () => {
      expect(valueFlagProblems(['--limits=5', '--limited'], SPACE_FLAGS, 'space')).toEqual([])
    })
  })
})

describe('parseLimit', () => {
  it('nothing typed is no limit of its own: the caller applies its default', () => {
    expect(parseLimit(undefined)).toBeNull()
  })

  it('reads a whole number greater than zero', () => {
    expect(parseLimit('1')).toBe(1)
    expect(parseLimit('20')).toBe(20)
    expect(parseLimit(' 5 ')).toBe(5)
  })

  // Each of these used to switch the limit OFF or to nothing without a word. Number('abc')
  // is NaN and `attempted >= NaN` is never true; Number('0') is falsy where the limit was
  // tested for truth; Number('2.5') cut a list at two.
  it.each([
    ['a word', 'abc'],
    ['zero', '0'],
    ['a negative number', '-1'],
    ['a fraction', '2.5'],
    ['an empty string', ''],
    ['spaces', '   '],
    ['exponent notation', '1e3'],
    ['hexadecimal', '0x10'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['a number with letters after it', '10abc'],
    ['the next flag, swallowed as the value', '--out'],
  ])('PLANTED: throws on %s, and never falls back to no limit', (_what, raw) => {
    expect(() => parseLimit(raw)).toThrow(/--limit must be a whole number greater than zero/)
  })

  it('the message quotes what was typed', () => {
    expect(() => parseLimit('abc')).toThrow(/Got "abc"/)
  })
})

describe('researchFetchWorstCaseUsd: what one prospect fetching every source can cost', () => {
  const sonnet = USD_PER_MTOK['claude-sonnet-4-6']
  const sonnetOutput = sonnet.output
  // SYNTHESIS_MAX_OUTPUT_TOKENS in synthesize.ts at the time of writing. A number here on
  // purpose: importing that module would pull the whole research pipeline into a test of
  // arithmetic. The script passes the constant itself, which the last suite checks.
  const CEILING = 24_000
  // The script's figures for the input side of one synthesis (see run-research.ts): the
  // cached system prefix, and the prospect's own part of the request.
  const PREFIX = 8_500
  const USER = 3_000
  // What the script prices beside synthesis: 0.08 + 0.02 + 0.01.
  const OTHER = 0.11
  const worst = (synthesisMaxOutputTokens = CEILING, otherThanSynthesisUsd = OTHER, prefix = PREFIX, user = USER) =>
    researchFetchWorstCaseUsd({
      otherThanSynthesisUsd, synthesisMaxOutputTokens,
      synthesisSystemPrefixTokens: prefix, synthesisUserTokens: user,
    })
  /** One synthesis's input on a COLD cache: the prefix written at the cache-write rate, the rest at the input rate. */
  const coldInput = (prefix = PREFIX, user = USER) => (prefix * sonnet.cacheWrite + user * sonnet.input) / 1e6

  it('can find the prices it is about to use', () => {
    expect(sonnetOutput).toBeGreaterThan(0)
    expect(sonnet.cacheWrite).toBeGreaterThan(sonnet.input)
  })

  it('PLANTED: covers TWO syntheses cut off at the output ceiling, at full price, on top of the rest', () => {
    const twoCutOff = (2 * CEILING * sonnetOutput) / 1e6
    expect(twoCutOff).toBeCloseTo(0.72, 10)
    expect(worst()).toBeGreaterThanOrEqual(OTHER + twoCutOff - 1e-9)
  })

  it('PLANTED: covers the input side of both syntheses on a COLD cache, so the figure is $1.00', () => {
    // A 24,000-token answer can stream past the cache's five-minute life, so both answers
    // may write the prefix to cache. Warm, the two inputs are about 2 cents; cold, about 8.
    expect(coldInput()).toBeCloseTo(0.040875, 10)
    const total = OTHER + (2 * CEILING * sonnetOutput) / 1e6 + 2 * coldInput()
    expect(total).toBeCloseTo(0.91175, 10)
    expect(worst()).toBeGreaterThanOrEqual(total - 1e-9)
    // 0.11 + 0.72 + 0.08175 = 0.91175, rounded up. It was $0.90, under this total.
    expect(worst()).toBeCloseTo(1.0, 10)
    expect(worst(CEILING, OTHER, 0, 0)).toBeCloseTo(0.9, 10)
  })

  it('PLANTED: six prospects that all truncate are refused under the default cap, where the old figure admitted them', () => {
    // The review's case: at the $0.50 this replaces, six fetching prospects were admitted
    // under $3 and could cost $3.90 to $4.98.
    expect(new RunSpend(3).canAfford(6 * 0.5)).toBe(true)
    expect(new RunSpend(3).canAfford(6 * worst())).toBe(false)
    expect(new RunSpend(3).affordableCount(worst())).toBe(3)
    expect(new RunSpend(3).canAfford(3 * worst())).toBe(true)
  })

  it('PLANTED: moves with the ceiling', () => {
    expect(worst(12_000)).toBeCloseTo(0.6, 10)    // 0.11 + 0.36 + 0.08175 = 0.55175
    expect(worst(48_000)).toBeCloseTo(1.7, 10)    // 0.11 + 1.44 + 0.08175 = 1.63175
  })

  it('PLANTED: moves with the input token counts the script passes', () => {
    // A prefix of 30,000 tokens: 0.83 + 2 x (0.1125 + 0.009) = 1.073, rounded up.
    expect(worst(CEILING, OTHER, 30_000, USER)).toBeCloseTo(1.1, 10)
    const expected = (prefix: number, user: number) => Math.ceil((OTHER + (2 * CEILING * sonnetOutput) / 1e6 + 2 * coldInput(prefix, user)) * 10 - 1e-6) / 10
    for (const [prefix, user] of [[8_500, 3_000], [20_000, 3_000], [8_500, 30_000], [1, 1]] as const) {
      expect(worst(CEILING, OTHER, prefix, user), `${prefix} and ${user} tokens`).toBeCloseTo(expected(prefix, user), 10)
    }
  })

  it('PLANTED: moves with the price table and with what the script prices beside synthesis', () => {
    const expected = (tokens: number, other: number) => Math.ceil((other + (2 * tokens * sonnetOutput) / 1e6 + 2 * coldInput()) * 10 - 1e-6) / 10
    for (const [tokens, other] of [[24_000, 0.11], [24_000, 0.31], [30_000, 0.05], [1_000, 0.01]] as const) {
      expect(worst(tokens, other), `${tokens} tokens, $${other}`).toBeCloseTo(expected(tokens, other), 10)
    }
  })

  it('PLANTED: rounds UP to the next ten cents, and leaves a figure already on ten cents where it is', () => {
    // With no input side: 0.11 + 2 x 3,000 x 15 / 1e6 = 0.20 exactly. One more token is over it.
    expect(worst(3_000, OTHER, 0, 0)).toBeCloseTo(0.2, 10)
    expect(worst(3_001, OTHER, 0, 0)).toBeCloseTo(0.3, 10)
    // Never down: 0.11 + 0.003 is 0.113, and the answer is not 0.10.
    expect(worst(100, OTHER, 0, 0)).toBeCloseTo(0.2, 10)
  })

  it('PLANTED: a ceiling, a remainder or a token count that is not a usable number throws, and is never priced as nothing', () => {
    for (const tokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => worst(tokens), String(tokens)).toThrow(/output ceiling/)
    }
    for (const other of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => worst(CEILING, other), String(other)).toThrow(/beside synthesis/)
    }
    for (const count of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2.5]) {
      expect(() => worst(CEILING, OTHER, count, USER), `prefix ${count}`).toThrow(/input tokens/)
      expect(() => worst(CEILING, OTHER, PREFIX, count), `user ${count}`).toThrow(/input tokens/)
    }
  })
})

describe('researchUsageRowUsd', () => {
  const sonnet = USD_PER_MTOK['claude-sonnet-4-6']
  const haiku = USD_PER_MTOK['claude-haiku-4-5-20251001']
  const opus = USD_PER_MTOK['claude-opus-4-6']
  const zero = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, calls: 0 }
  const noSearch = { input_tokens: 0, output_tokens: 0, model: null, search_count: 0 }

  const SYNTHESIS = { input_tokens: 1000, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, calls: 1 }
  const OPENING = { input_tokens: 2000, output_tokens: 200, cache_creation_input_tokens: 400, cache_read_input_tokens: 10000, calls: 3 }
  const synthesisUsd = (1000 * sonnet.input + 1000 * sonnet.output) / 1e6
  const openingUsd = (2000 * sonnet.input + 200 * sonnet.output + 400 * sonnet.cacheWrite + 10000 * sonnet.cacheRead) / 1e6

  it('can find the prices it is about to use, so a miss below is the code and not the table', () => {
    expect(sonnet.output).toBeGreaterThan(0)
    expect(haiku.input).toBeGreaterThan(0)
    expect(opus.input).toBeGreaterThan(haiku.input)
  })

  it('a reuse run is the opening alone: nothing synthesised, nothing searched', () => {
    expect(researchUsageRowUsd({ synthesis: zero, opening: OPENING, followups: null, web_search: noSearch, synthesis_batched: false }))
      .toBeCloseTo(openingUsd, 12)
  })

  it('PLANTED: every stage is added, each at its own rate, with a fee per search', () => {
    const cost = researchUsageRowUsd({
      synthesis: SYNTHESIS,
      opening: OPENING,
      followups: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, calls: 1 },
      web_search: { input_tokens: 1000, output_tokens: 100, model: 'claude-haiku-4-5-20251001', search_count: 2 },
      synthesis_batched: false,
    })
    const followupsUsd = (1000 * sonnet.input + 100 * sonnet.output) / 1e6
    const searchUsd = (1000 * haiku.input + 100 * haiku.output) / 1e6 + 2 * COST_WEB_SEARCH_PER_SEARCH
    expect(cost).toBeCloseTo(synthesisUsd + openingUsd + followupsUsd + searchUsd, 12)
  })

  it('PLANTED: synthesis that went through the Batch API is billed at half, and only synthesis', () => {
    const row = { synthesis: SYNTHESIS, opening: OPENING, followups: null, web_search: noSearch }
    expect(researchUsageRowUsd({ ...row, synthesis_batched: true })).toBeCloseTo(synthesisUsd / 2 + openingUsd, 12)
    expect(researchUsageRowUsd({ ...row, synthesis_batched: false })).toBeCloseTo(synthesisUsd + openingUsd, 12)
  })

  it('PLANTED: a search with no model on record is priced at the unknown-model ceiling, never at nothing', () => {
    const cost = researchUsageRowUsd({
      synthesis: zero, opening: zero, followups: null,
      web_search: { input_tokens: 1000, output_tokens: 0, model: null, search_count: 0 },
    })
    // $15 in per million since 2026-10-02: the explicit ceiling, not the Opus row.
    expect(cost).toBeCloseTo((1000 * 15) / 1e6, 12)
  })

  it('PLANTED: a firm-fact row is the dollar figure stored beside its usage', () => {
    expect(researchUsageRowUsd({
      synthesis: zero, opening: zero, followups: null, web_search: noSearch,
      firm_fact: { extraction: { input_tokens: 3000, output_tokens: 300 }, judge: null, cost_usd_full_price: 0.0135 },
    })).toBe(0.0135)
  })

  it('a firm-fact attempt that cost nothing is a real zero', () => {
    expect(researchUsageRowUsd({ synthesis: zero, opening: zero, web_search: noSearch, firm_fact: { cost_usd_full_price: 0 } })).toBe(0)
  })

  // NULL, NOT ZERO. A row this cannot read spent something. Returned as nothing it would
  // disappear into a total that then looks complete.
  it.each([
    ['no synthesis', { opening: OPENING, followups: null, web_search: noSearch }],
    ['no opening', { synthesis: SYNTHESIS, followups: null, web_search: noSearch }],
    ['no web search', { synthesis: SYNTHESIS, opening: OPENING, followups: null }],
    ['a search with no count', { synthesis: SYNTHESIS, opening: OPENING, followups: null, web_search: { input_tokens: 0, output_tokens: 0, model: null } }],
    ['token counts that are not numbers', { synthesis: { input_tokens: '1000', output_tokens: 1000 }, opening: OPENING, followups: null, web_search: noSearch }],
    ['follow-ups present and unreadable', { synthesis: SYNTHESIS, opening: OPENING, followups: { calls: 2 }, web_search: noSearch }],
    ['a firm-fact row with no cost', { synthesis: zero, opening: zero, web_search: noSearch, firm_fact: { extraction: null, judge: null } }],
    ['a firm-fact row with a negative cost', { synthesis: zero, opening: zero, web_search: noSearch, firm_fact: { cost_usd_full_price: -1 } }],
  ])('PLANTED: %s cannot be priced, and comes back null', (_what, row) => {
    expect(researchUsageRowUsd(row)).toBeNull()
  })
})

// ─── The backfill's run loop, with the cap in it ─────────────────────────────
//
// Imported inside the suite, not at the top of the file: the script pulls in the whole
// composition and research path, and a fault anywhere in that chain should fail these
// tests and leave the arithmetic above still reporting.
describe('scripts/backfill-followups.ts: the run stops at the cap', () => {
  let backfillCohort: typeof import('../../../../scripts/backfill-followups').backfillCohort
  let floorUsd: number

  beforeAll(async () => {
    const script = await import('../../../../scripts/backfill-followups')
    backfillCohort = script.backfillCohort
    floorUsd = script.FOLLOWUP_RESERVE_FLOOR_USD
  })

  const ran = (usd: number): FollowupsForStoredEmail1 => ({
    status: 'ran', fingerprint: 'fp', storedResultId: 'r1', usd, carriesOne: false,
    result: { email2: { prose: 'Two.', failures: [] }, email3: { prose: 'Three.', failures: [] }, usage: null, retries_used: 0, attempts: [] } as never,
  })
  const paidSkip = (usd: number): FollowupsForStoredEmail1 => ({ status: 'skipped', reason: 'no_reference', usd, carriesOne: true })
  const cohort = (...ids: string[]): StoredEmail1Row[] =>
    ids.map(id => ({ id, followup_email2: null, followup_email3: null, followup_email1_fingerprint: null }))

  async function drive(outcomes: Record<string, FollowupsForStoredEmail1>, spend?: RunSpend) {
    const asked: string[] = []
    const lines: string[] = []
    const totals = await backfillCohort({
      cohort: cohort(...Object.keys(outcomes)), limit: null, commit: false, spend,
      forOne: async row => { asked.push(row.id); return outcomes[row.id] },
      recordAttempts: async () => null,
      store: async () => null,
      log: line => lines.push(line),
    })
    return { totals, asked, lines }
  }

  it('the floor it reserves at the start of a run is five cents', () => {
    expect(floorUsd).toBe(0.05)
  })

  it('control: under the cap, everybody is looked at and nothing is said about a cap', async () => {
    const { totals, asked, lines } = await drive({ a: ran(0.01), b: ran(0.01), c: ran(0.01) }, new RunSpend(3))
    expect(asked).toEqual(['a', 'b', 'c'])
    expect(totals).toMatchObject({ ran: 3, notLookedAt: 0, lastId: 'c' })
    expect(lines.join('\n')).not.toContain('--max-usd reached')
  })

  it('PLANTED: stops before the prospect the cap could not cover, and says where to carry on from', async () => {
    // 0.04 each against a 0.12 cap, reserving 0.05: a and b run (0.08 spent), and c would
    // need 0.13.
    const spend = new RunSpend(0.12)
    const { totals, asked, lines } = await drive({ a: ran(0.04), b: ran(0.04), c: ran(0.04), d: ran(0.04) }, spend)
    expect(asked).toEqual(['a', 'b'])
    expect(totals).toMatchObject({ ran: 2, notLookedAt: 2, lastId: 'b' })
    expect(totals.usd).toBeCloseTo(0.08, 10)
    expect(spend.spent).toBeCloseTo(0.08, 10)
    expect(lines.join('\n')).toMatch(/--max-usd reached: \$0\.08 of a \$0\.12 cap.*2 not looked at/)
  })

  it('PLANTED: reserves the dearest prospect seen so far, not only the floor', async () => {
    // a costs 0.40, so every later prospect is reserved at 0.40. After d the run has spent
    // 0.70 of 1.00: the floor alone (0.75) would let e start, the dearest seen (1.10) does not.
    const { asked } = await drive({ a: ran(0.4), b: ran(0.1), c: ran(0.1), d: ran(0.1), e: ran(0.1) }, new RunSpend(1))
    expect(asked).toEqual(['a', 'b', 'c', 'd'])
  })

  it('PLANTED: a paid call that ended in a skip counts against the cap', async () => {
    const spend = new RunSpend(0.12)
    const { asked } = await drive({ a: paidSkip(0.04), b: paidSkip(0.04), c: ran(0.04) }, spend)
    expect(asked).toEqual(['a', 'b'])
    expect(spend.spent).toBeCloseTo(0.08, 10)
  })

  it('PLANTED: a caller that passes no cap gets the three dollar default, not an unbounded run', async () => {
    // A dollar each: three fit under the default, and the fourth would make four.
    const { totals, asked } = await drive({ a: ran(1), b: ran(1), c: ran(1), d: ran(1), e: ran(1) })
    expect(asked).toEqual(['a', 'b', 'c'])
    expect(totals.notLookedAt).toBe(2)
  })

  it('PLANTED: a cap under the floor looks at nobody, and offers no place to carry on from', async () => {
    const { totals, asked, lines } = await drive({ a: ran(0.01), b: ran(0.01) }, new RunSpend(0.04))
    expect(asked).toEqual([])
    expect(totals).toMatchObject({ ran: 0, notLookedAt: 2, lastId: null })
    expect(lines.join('\n')).toContain('--max-usd reached')
  })
})

// ─── The four scripts, read as text ──────────────────────────────────────────
//
// None of them can be imported and run here: three start a paid run on import. So these
// tests read each script's source and hold three things a person could undo with one
// edit and never notice, because the run would carry on without a word.
describe('the scripts: what each one reads is what each one checks', () => {
  const SCRIPTS = [
    { file: 'scripts/run-firm-fact.ts', form: 'space', hasLimit: true },
    { file: 'scripts/run-research.ts', form: 'space', hasLimit: false },
    { file: 'scripts/run-competitor-screen.ts', form: 'space', hasLimit: true },
    { file: 'scripts/backfill-followups.ts', form: 'equals', hasLimit: true },
  ] as const
  const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf-8')

  /** Every value flag the script reads: arg('name') in a space script, '--name=' in an equals one. */
  const flagsRead = (text: string, form: 'space' | 'equals') => [...new Set(
    [...text.matchAll(form === 'space' ? /\barg\('([a-z-]+)'\)/g : /startsWith\('--([a-z-]+)='\)/g)].map(m => m[1]),
  )]
  /** The list the script hands to valueFlagProblems. */
  const flagsChecked = (text: string) =>
    [...(text.match(/const VALUE_FLAGS = \[([^\]]*)\] as const/)?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map(m => m[1])

  it.each(SCRIPTS)('PLANTED: $file refuses every value flag it reads when it is typed in the other form', ({ file, form }) => {
    const text = source(file)
    const read = flagsRead(text, form)
    const checked = flagsChecked(text)
    // A scan that found nothing would pass over an empty set.
    expect(read.length, 'flags read').toBeGreaterThanOrEqual(4)
    expect(read).toContain('max-usd')
    expect(checked.length, 'flags checked').toBeGreaterThan(0)
    for (const name of read) expect(checked, `--${name} is read and not checked`).toContain(name)
    // And the list is the one handed over, in the form the script reads.
    expect(text).toMatch(new RegExp(`valueFlagProblems\\([^\\n]*VALUE_FLAGS, '${form}'\\)`))
  })

  it('the scan can tell a flag that is read and not checked (control)', () => {
    const text = "const VALUE_FLAGS = ['org', 'max-usd'] as const\nconst a = arg('org'); const b = arg('limit')"
    expect(flagsRead(text, 'space')).toEqual(['org', 'limit'])
    expect(flagsChecked(text)).toEqual(['org', 'max-usd'])
    expect(flagsChecked(text)).not.toContain('limit')
  })

  it.each(SCRIPTS.filter(script => script.hasLimit))('PLANTED: $file reads --limit through parseLimit and in no other way', ({ file }) => {
    const text = source(file)
    expect(text).toMatch(/parseLimit\(/)
    // The three ways it was read before: each let a mistyped limit mean no limit.
    expect(text).not.toMatch(/Number\(arg\('limit'\)/)
    expect(text).not.toMatch(/Number\(limitArg\)/)
  })

  it('PLANTED: run-research.ts computes its fetching worst case from the synthesis ceiling, and holds no fixed figure for it', () => {
    const text = source('scripts/run-research.ts')
    expect(text).toMatch(/const FETCH_WORST_USD = researchFetchWorstCaseUsd\(\{/)
    expect(text).toMatch(/synthesisMaxOutputTokens: SYNTHESIS_MAX_OUTPUT_TOKENS/)
    // The input side, from named constants the script states and explains.
    expect(text).toMatch(/synthesisSystemPrefixTokens: SYNTHESIS_SYSTEM_PREFIX_TOKENS/)
    expect(text).toMatch(/synthesisUserTokens: SYNTHESIS_USER_TOKENS/)
    expect(text).toMatch(/const SYNTHESIS_SYSTEM_PREFIX_TOKENS = \d/)
    expect(text).toMatch(/const SYNTHESIS_USER_TOKENS = \d/)
    expect(text).not.toMatch(/const FETCH_WORST_USD = \d/)
    // Control: the reuse figure is still a stated one, so the pattern above can match a literal.
    expect(text).toMatch(/const REUSE_WORST_USD = \d/)
  })

  it('PLANTED: run-research.ts does not say that queuing spends nothing in this process', () => {
    // It does: the queue path asks the paid competitor questions before it queues anything.
    const text = source('scripts/run-research.ts')
    expect(text).not.toContain('queuing spends nothing in this process')
    expect(text).not.toContain('nothing has been billed yet')
    expect(text).toContain('competitor')
  })
})
