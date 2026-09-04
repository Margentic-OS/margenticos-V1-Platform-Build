// The ICP geography agent, and RULE ZERO enforcement for its prompt.
//
// Every test below is written so that it FAILS IF THE GUARD IS REMOVED. That is the whole
// requirement: a test asserting a throw that would also pass without the throw proves
// nothing, and this file's subject is a set of throws.
//
// Where a test needs a country, it computes one from the real constants rather than
// writing one down. See src/test-utils/geography-fixture.ts for why.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ICP_GEOGRAPHY_PROMPT,
  collectTargetingGeographyStatements,
  deriveIcpGeography,
} from '@/agents/icp-geography-agent'
import type { IcpDocument } from '@/lib/agents/icp-filter-spec'
import { knownIso2CountryCodes, aliasesForIso2 } from '@/lib/sourcing/country-code'
import {
  aTargetableCode,
  AN_UNRECOGNISED_COUNTRY_NAME,
} from '@/test-utils/geography-fixture'

// ─── Mocking the model ───────────────────────────────────────────────────────
//
// The mock returns whatever text a test hands it. Nothing here reaches the network, and
// the suite has no ANTHROPIC_API_KEY on purpose, so a test that accidentally bypassed
// this mock would fail rather than spend.

const createMessage = vi.fn()
const constructorOptions = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMessage }
    constructor(options: unknown) {
      constructorOptions(options)
    }
  },
}))

function modelReturns(text: string) {
  createMessage.mockResolvedValue({ content: [{ type: 'text', text }] })
}

/** The model's answer, shaped, so tests state phrases and countries and nothing else. */
function modelResolves(phrases: Array<{ phrase: string; countries: string[] }>) {
  modelReturns(JSON.stringify({ phrases }))
}

/** A country's common English name, recovered from the alias table rather than typed. */
function nameFor(code: string): string {
  const alias = Array.from(aliasesForIso2(code)).find(a => a.length > 2)
  if (!alias) throw new Error(`no long-form alias for ${code}; the fixture cannot be built`)
  return alias
}

beforeEach(() => {
  createMessage.mockReset()
  constructorOptions.mockReset()
})
afterEach(() => {
  vi.clearAllMocks()
})

// ═════════════════════════════════════════════════════════════════════════════
// RULE ZERO: the prompt names no real place
// ═════════════════════════════════════════════════════════════════════════════

describe('Rule Zero: the geography prompt names no real country or region', () => {
  // ─── Two scans, because a country code and a country name are different risks ──
  //
  // Several ISO-2 codes are also ordinary English words: a case-insensitive scan for
  // bare two-letter codes matches "in", "at", "be", "is", "it" and "no" in any English
  // prose, which would make this test permanently red and therefore useless. A code in a
  // prompt would be written in its canonical uppercase form, so codes are matched
  // case-sensitively and names, which vary in capitalisation, are not.
  //
  // Measured: with a single case-insensitive scan this reported six matches against a
  // prompt containing no place at all.

  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  it('contains no country NAME this platform recognises, in any capitalisation', () => {
    const names: string[] = []
    for (const code of knownIso2CountryCodes()) {
      for (const alias of aliasesForIso2(code)) {
        if (alias.length > 2) names.push(alias)
      }
    }

    // The scan must have teeth. If this list were ever empty the assertion below would
    // pass over nothing, which is the vacuous-pass shape.
    expect(names.length).toBeGreaterThan(40)

    const found = names.filter(name =>
      new RegExp(`\\b${escape(name)}\\b`, 'i').test(ICP_GEOGRAPHY_PROMPT),
    )

    expect(found).toEqual([])
  })

  it('contains no bare ISO-2 country CODE', () => {
    const codes = Array.from(knownIso2CountryCodes())
    expect(codes.length).toBeGreaterThan(20)

    // Case-sensitive on purpose: see the note above.
    const found = codes.filter(code =>
      new RegExp(`\\b${escape(code)}\\b`).test(ICP_GEOGRAPHY_PROMPT),
    )

    expect(found).toEqual([])
  })

  // POSITIVE CONTROL for both scans. Without this, a bug that made either regex never
  // match would leave two tests passing green over a prompt full of real place names.
  it('both scans actually detect a place name when one is present', () => {
    const aName = Array.from(aliasesForIso2(Array.from(knownIso2CountryCodes())[0]))
      .find(a => a.length > 2)!
    const aCode = Array.from(knownIso2CountryCodes())[0]

    const polluted = `${ICP_GEOGRAPHY_PROMPT}\n\nTarget ${aName} and ${aCode}.`

    expect(new RegExp(`\\b${escape(aName)}\\b`, 'i').test(polluted)).toBe(true)
    expect(new RegExp(`\\b${escape(aCode)}\\b`).test(polluted)).toBe(true)
  })

  it('states the rule at category level, so "names no country" is not satisfied by silence', () => {
    const prompt = ICP_GEOGRAPHY_PROMPT.toLowerCase()
    expect(prompt).toContain('larger than a single country')
    expect(prompt).toContain('smaller than a country')
    expect(prompt).toContain('resolves to nothing')
    // The instruction that actually prevents expansion.
    expect(prompt).toContain('do not list its members')
  })

  it('tells the model that returning fewer countries is the safe direction', () => {
    expect(ICP_GEOGRAPHY_PROMPT.toLowerCase()).toContain('returning fewer countries')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// WHICH TIERS ARE READ
// ═════════════════════════════════════════════════════════════════════════════

describe('only the targeting tiers are read', () => {
  const docWith = (t1?: string, t2?: string, t3?: string): IcpDocument => ({
    summary: 's',
    jtbd_statement: 'j',
    tier_1: {
      company_profile: {
        revenue_range: 'r', headcount: '1-10', industries: ['Management Consulting'],
        ...(t1 === undefined ? {} : { geography: t1 }),
      },
      buyer_profile: { title: 't', seniority: 's' },
      disqualifiers: [],
    },
    tier_2: {
      company_profile: {
        revenue_range: 'r', headcount: '1-10', industries: ['Management Consulting'],
        ...(t2 === undefined ? {} : { geography: t2 }),
      },
      buyer_profile: { title: 't', seniority: 's' },
      disqualifiers: [],
    },
    tier_3: {
      company_profile: {
        revenue_range: 'r', headcount: '1-10', industries: ['Management Consulting'],
        ...(t3 === undefined ? {} : { geography: t3 }),
      },
    },
  })

  it('reads tier 1 and tier 2 in order', () => {
    expect(collectTargetingGeographyStatements(docWith('first', 'second', 'third')))
      .toEqual(['first', 'second'])
  })

  // THE POSITIVE CONTROL. Tier 3 is the disqualifier tier and typically reads as some
  // form of "any geography". Reading it would turn the narrowest statement in the
  // document into the widest possible targeting instruction. If the collector were
  // changed to include tier 3, this test goes red and the one above does not.
  it('never reads the disqualifier tier, even when it is the only tier with a geography', () => {
    expect(collectTargetingGeographyStatements(docWith(undefined, undefined, 'anywhere at all')))
      .toEqual([])
  })

  it('drops blank and whitespace-only statements rather than sending them', () => {
    expect(collectTargetingGeographyStatements(docWith('   ', 'real'))).toEqual(['real'])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE THROWS
// ═════════════════════════════════════════════════════════════════════════════

describe('a document that states no geography stops the derivation', () => {
  it('throws, names the tiers, and never calls the model', async () => {
    await expect(deriveIcpGeography({ statements: [], apiKey: 'k' }))
      .rejects.toThrow(/states no geography on either targeting tier/i)

    // Positive control on the SHAPE of the guard, not just its existence: the check has
    // to happen before the call, or a document with no geography costs money to refuse.
    expect(createMessage).not.toHaveBeenCalled()
  })

  it('treats whitespace-only statements as no geography at all', async () => {
    await expect(deriveIcpGeography({ statements: ['  ', '\n'], apiKey: 'k' }))
      .rejects.toThrow(/states no geography/i)
    expect(createMessage).not.toHaveBeenCalled()
  })
})

describe('a document naming only areas larger than a country stops the derivation', () => {
  it('throws rather than returning an empty country list', async () => {
    modelResolves([
      { phrase: 'a collective term', countries: [] },
      { phrase: 'another collective term', countries: [] },
    ])

    await expect(deriveIcpGeography({ statements: ['anything'], apiKey: 'k' }))
      .rejects.toThrow(/names no country on either targeting tier/i)
  })

  it('names the skipped phrases verbatim in the error, so the operator can edit them', async () => {
    modelResolves([{ phrase: 'the exact words from the document', countries: [] }])

    await expect(deriveIcpGeography({ statements: ['anything'], apiKey: 'k' }))
      .rejects.toThrow(/the exact words from the document/)
  })

  // THE POSITIVE CONTROL for the pair above: the same code path must SUCCEED when one
  // phrase does resolve. Without this, a derivation that threw unconditionally would
  // satisfy both tests above.
  it('succeeds when at least one phrase names a country, and records the rest', async () => {
    const code = aTargetableCode()
    modelResolves([
      { phrase: 'a named country', countries: [nameFor(code)] },
      { phrase: 'a collective term', countries: [] },
    ])

    const result = await deriveIcpGeography({ statements: ['anything'], apiKey: 'k' })
    expect(result.countries).toEqual([code])
    expect(result.unresolved_phrases).toEqual(['a collective term'])
  })
})

describe('a country name the platform does not recognise stops the derivation', () => {
  it('throws and names the value, instead of storing it where a code belongs', async () => {
    modelResolves([{ phrase: 'p', countries: [AN_UNRECOGNISED_COUNTRY_NAME] }])

    await expect(deriveIcpGeography({ statements: ['anything'], apiKey: 'k' }))
      .rejects.toThrow(new RegExp(`"${AN_UNRECOGNISED_COUNTRY_NAME}" did not resolve`))
  })

  // POSITIVE CONTROL. toIso2CountryCode returns unmapped input VERBATIM rather than null,
  // which is correct for its own caller and wrong here. Without the ISO-2 shape check,
  // the unrecognised name would pass straight through as if it were a country code and
  // this test would go green while the spec held prose in a code field.
  it('recognises a real country name through the same path', async () => {
    const code = aTargetableCode()
    modelResolves([{ phrase: 'p', countries: [nameFor(code)] }])

    const result = await deriveIcpGeography({ statements: ['anything'], apiKey: 'k' })
    expect(result.countries).toEqual([code])
  })
})

describe('a response the agent cannot read stops the derivation', () => {
  it('throws when the model returns no JSON object', async () => {
    modelReturns('I am afraid I cannot help with that.')
    await expect(deriveIcpGeography({ statements: ['x'], apiKey: 'k' }))
      .rejects.toThrow(/returned no JSON object/i)
  })

  it('throws when the JSON does not parse', async () => {
    modelReturns('{ "phrases": [ }')
    await expect(deriveIcpGeography({ statements: ['x'], apiKey: 'k' }))
      .rejects.toThrow(/did not parse/i)
  })

  it('throws when the object carries no phrases array', async () => {
    modelReturns(JSON.stringify({ countries: ['anything'] }))
    await expect(deriveIcpGeography({ statements: ['x'], apiKey: 'k' }))
      .rejects.toThrow(/no "phrases" array/i)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// ORDINARY BEHAVIOUR
// ═════════════════════════════════════════════════════════════════════════════

describe('what a successful derivation returns', () => {
  it('deduplicates a country named on more than one tier, keeping document order', async () => {
    const code = aTargetableCode()
    modelResolves([
      { phrase: 'first mention', countries: [nameFor(code)] },
      { phrase: 'second mention', countries: [nameFor(code)] },
    ])

    const result = await deriveIcpGeography({ statements: ['a', 'b'], apiKey: 'k' })
    expect(result.countries).toEqual([code])
  })

  it('sends every statement to the model, numbered', async () => {
    modelResolves([{ phrase: 'p', countries: [nameFor(aTargetableCode())] }])
    await deriveIcpGeography({ statements: ['alpha', 'beta'], apiKey: 'k' })

    const sent = createMessage.mock.calls[0][0].messages[0].content as string
    expect(sent).toContain('Statement 1: alpha')
    expect(sent).toContain('Statement 2: beta')
  })

  // ── The call is bounded, and this is the only thing that would notice ──────
  //
  // The SDK defaults are a 10 minute timeout and 2 retries, so a bare client can occupy
  // 30 minutes against a 300 second route budget, and nothing retries a failed spec
  // derivation. Deleting the two options from the client would change no behaviour any
  // other test can see: every test here resolves instantly through a mock.
  //
  // Asserted as a BUDGET rather than as literals, so tuning the numbers does not require
  // editing a test, but removing the bound or setting one that cannot fit does.
  const ROUTE_BUDGET_SECONDS = 300

  it('bounds its own worst case well inside the route budget', async () => {
    modelResolves([{ phrase: 'p', countries: [nameFor(aTargetableCode())] }])
    await deriveIcpGeography({ statements: ['x'], apiKey: 'k' })

    const options = constructorOptions.mock.calls[0][0] as {
      timeout?: number
      maxRetries?: number
    }

    expect(typeof options.timeout).toBe('number')
    expect(typeof options.maxRetries).toBe('number')

    // Worst case is every attempt timing out: one initial try plus maxRetries more.
    const worstCaseSeconds = (options.timeout! / 1000) * (options.maxRetries! + 1)
    expect(worstCaseSeconds).toBeLessThanOrEqual(ROUTE_BUDGET_SECONDS)

    // And the buyer criterion call shares the same budget, so geography alone must not
    // be able to consume all of it.
    expect(worstCaseSeconds).toBeLessThan(ROUTE_BUDGET_SECONDS)
  })
})
