// The buyer-targeting answers presented as BINDING, and Rule Zero over the text that says so.
//
// Every guard here was mutation-proved: broken on purpose, observed red, restored. A test
// whose failure has never been seen is a test whose assertion might be unreachable.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  buildBuyerProfileBlock,
  statedGeographyHint,
  statedHeadcount,
  hasStatedCountries,
  BUYER_PROFILE_BLOCK_HEADING,
} from '@/lib/intake/buyer-profile-authority'
import { EMPTY_BUYER_PROFILE, type BuyerProfile } from '@/lib/intake/buyer-profile'
import { PROVIDER_SENIORITY_BANDS } from '@/lib/sourcing/handlers/provider-seniority'
import { knownIso2CountryCodes, aliasesForIso2 } from '@/lib/sourcing/country-code'

const ROOT = process.cwd()
const MODULE_PATH = 'src/lib/intake/buyer-profile-authority.ts'

/**
 * A profile, built from the empty one so a field added to the interface arrives here as its
 * empty value rather than as undefined. Two hand-written literals of the same shape is the
 * parallel-array defect in a fixture.
 */
function profile(overrides: Partial<BuyerProfile> = {}): BuyerProfile {
  return { ...EMPTY_BUYER_PROFILE, ...overrides }
}

// Invented. Nothing in this file names a real country, title, sector or seniority level;
// the seniority values are read from the provider module, which is the one list of them.
const A_PLACE = 'Placeholderia'
const ANOTHER_PLACE = 'Exampleland'
const A_TITLE = 'Chief Placeholder'

// ═════════════════════════════════════════════════════════════════════════════
// ABSENT, NOT EMPTY
// ═════════════════════════════════════════════════════════════════════════════

describe('an organisation that answered none of these questions', () => {
  it('produces no block at all, not an empty one', () => {
    // THE GUARD ON EVERY EXISTING CLIENT. Four of the five live organisations have no row.
    // A block of headings with "[not answered]" under each would change their prompt, which
    // is a change to document generation for clients this work was not asked to touch.
    expect(buildBuyerProfileBlock(EMPTY_BUYER_PROFILE)).toBe('')
  })

  it('produces no block when every answer is whitespace', () => {
    // A repeater produces blank rows as a matter of course, and a row of spaces stored
    // before normalisation is not an answer.
    expect(buildBuyerProfileBlock(profile({
      target_countries: ['  ', ''],
      buyer_job_titles: [' '],
      first_contact_role: '   ',
      signoff_role: '  ',
      disqualifiers: ['', '   '],
    }))).toBe('')
  })

  it('says nothing about a field the client skipped', () => {
    // Field by field, not all or nothing. A client who named countries and skipped the
    // headcount question must leave the headcount rules elsewhere in the prompt untouched.
    const block = buildBuyerProfileBlock(profile({ target_countries: [A_PLACE] }))
    expect(block).toContain(A_PLACE)
    expect(block).not.toContain('company_profile.headcount')
    expect(block).not.toContain('buyer_profile.title')
    expect(block).not.toContain('tier_3.disqualifiers')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// EACH ANSWER BINDS A NAMED SCHEMA FIELD
// ═════════════════════════════════════════════════════════════════════════════

describe('each answer names the schema field it binds', () => {
  it('countries bind company_profile.geography', () => {
    const block = buildBuyerProfileBlock(
      profile({ target_countries: [A_PLACE, ANOTHER_PLACE] }),
    )
    expect(block).toContain('company_profile.geography')
    expect(block).toContain(A_PLACE)
    expect(block).toContain(ANOTHER_PLACE)
  })

  it('the headcount pair binds company_profile.headcount as two numbers', () => {
    const block = buildBuyerProfileBlock(
      profile({ buyer_headcount_min: 11, buyer_headcount_max: 250 }),
    )
    expect(block).toContain('company_profile.headcount')
    expect(block).toContain('11')
    expect(block).toContain('250')
  })

  it('titles bind buyer_profile.title in the client own words', () => {
    const block = buildBuyerProfileBlock(profile({ buyer_job_titles: [A_TITLE] }))
    expect(block).toContain('buyer_profile.title')
    expect(block).toContain(A_TITLE)
  })

  it('seniority binds buyer_profile.seniority', () => {
    const band = PROVIDER_SENIORITY_BANDS[0]
    const block = buildBuyerProfileBlock(profile({ buyer_seniority_bands: [band] }))
    expect(block).toContain('buyer_profile.seniority')
    expect(block).toContain(band)
  })

  it('disqualifiers bind tier_3.disqualifiers and may not be dropped', () => {
    const block = buildBuyerProfileBlock(profile({ disqualifiers: ['a stated exclusion'] }))
    expect(block).toContain('tier_3.disqualifiers')
    expect(block).toContain('a stated exclusion')
    expect(block.toLowerCase()).toContain('may not drop')
  })

  it('binds tier 1 and tier 2 and never tier 3, except for the disqualifiers', () => {
    // Tier 3 is the do-not-target tier. Binding a TARGETING answer into it would make the
    // disqualifier tier describe the target. The geography derivation and the filter spec
    // both read tiers 1 and 2 and neither reads tier 3, so this matches the pipeline.
    const block = buildBuyerProfileBlock(profile({
      target_countries: [A_PLACE],
      buyer_headcount_min: 5,
      buyer_headcount_max: 50,
      buyer_job_titles: [A_TITLE],
    }))
    expect(block).not.toContain('tier_3')
    expect(block).toContain('tier 1 and tier 2')
  })
})

describe('the block states its own authority, not merely its contents', () => {
  const block = buildBuyerProfileBlock(profile({ target_countries: [A_PLACE] }))

  it('opens by saying these are values and not evidence', () => {
    expect(block).toContain(BUYER_PROFILE_BLOCK_HEADING)
    expect(BUYER_PROFILE_BLOCK_HEADING).toMatch(/VALUES, NOT EVIDENCE/)
  })

  it('names what it beats, so "authoritative" is not left to be inferred', () => {
    const lower = block.toLowerCase()
    for (const beaten of ['research', 'website', 'uploaded document', 'previous version']) {
      expect(lower, `the block does not say it beats the ${beaten}`).toContain(beaten)
    }
  })

  it('says an unnamed field is NOT established by it', () => {
    // Without this the block reads as a complete specification, and a model reading it that
    // way would stop adding unresolved_fields entries for everything else.
    expect(block).toContain('A field NOT named below is not established by this section')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// A STATED COUNTRY LIST BEATS THE DOMAIN GUESS
// ═════════════════════════════════════════════════════════════════════════════

describe('the research geography hint', () => {
  it('is the stated country when the client named exactly one', () => {
    expect(statedGeographyHint(profile({ target_countries: [A_PLACE] }))).toBe(A_PLACE)
  })

  it('is empty when the client named several', () => {
    // Deliberate, and explained where the function is defined: a web search query ANDs its
    // words, so appending several countries returns pages mentioning all of them. The full
    // list still binds company_profile.geography, which is the channel that decides who is
    // sourced. This one only shapes what is searched for.
    expect(statedGeographyHint(profile({ target_countries: [A_PLACE, ANOTHER_PLACE] })))
      .toBe('')
  })

  it('is empty when the client named none', () => {
    expect(statedGeographyHint(EMPTY_BUYER_PROFILE)).toBe('')
  })

  it('ignores blank entries when deciding there is exactly one', () => {
    expect(statedGeographyHint(profile({ target_countries: ['  ', A_PLACE, ''] })))
      .toBe(A_PLACE)
  })

  it('hasStatedCountries is what decides whether the guess is consulted at all', () => {
    // The two functions answer different questions and the caller needs both: several
    // stated countries produce no hint AND must still suppress the domain guess.
    const several = profile({ target_countries: [A_PLACE, ANOTHER_PLACE] })
    expect(hasStatedCountries(several)).toBe(true)
    expect(statedGeographyHint(several)).toBe('')
    expect(hasStatedCountries(EMPTY_BUYER_PROFILE)).toBe(false)
    expect(hasStatedCountries(profile({ target_countries: ['   '] }))).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE STATED HEADCOUNT PAIR
// ═════════════════════════════════════════════════════════════════════════════

describe('the stated headcount pair', () => {
  it('is both integers when the client answered', () => {
    expect(statedHeadcount(profile({ buyer_headcount_min: 2, buyer_headcount_max: 600 })))
      .toEqual({ min: 2, max: 600 })
  })

  it('is null when the client did not answer', () => {
    expect(statedHeadcount(EMPTY_BUYER_PROFILE)).toBeNull()
  })

  it('is null for half a range, so no caller reads .min on nothing', () => {
    expect(statedHeadcount(profile({ buyer_headcount_min: 5 }))).toBeNull()
    expect(statedHeadcount(profile({ buyer_headcount_max: 5 }))).toBeNull()
  })

  it('is null for an inverted or impossible pair', () => {
    // The database CHECK forbids both. This repeats the condition because the value also
    // arrives from fakes and from rows written before that constraint existed.
    expect(statedHeadcount(profile({ buyer_headcount_min: 80, buyer_headcount_max: 20 })))
      .toBeNull()
    expect(statedHeadcount(profile({ buyer_headcount_min: 0, buyer_headcount_max: 10 })))
      .toBeNull()
  })

  it('is null for a non-integer, because NaN in a filter is silent', () => {
    const fractional = { buyer_headcount_min: 1.5, buyer_headcount_max: 9 } as Partial<BuyerProfile>
    expect(statedHeadcount(profile(fractional))).toBeNull()
  })

  it('equal bounds pass: a buyer that is always one size is an answer', () => {
    expect(statedHeadcount(profile({ buyer_headcount_min: 12, buyer_headcount_max: 12 })))
      .toEqual({ min: 12, max: 12 })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// SIGN-OFF HAS THREE STATES AND THE THIRD IS NOT THE SECOND
// ═════════════════════════════════════════════════════════════════════════════

describe('sign-off', () => {
  it('unanswered says nothing, so no hesitation is invented or denied', () => {
    expect(buildBuyerProfileBlock(profile({ signoff_required: null })))
      .toBe('')
  })

  it('required puts the internal sell where it belongs', () => {
    const block = buildBuyerProfileBlock(
      profile({ signoff_required: true, signoff_role: A_TITLE }),
    )
    expect(block).toContain('four_forces.anxiety')
    expect(block).toContain(A_TITLE)
    expect(block).toContain('is NOT the buyer this document describes')
  })

  it('not required forbids writing an approval step in', () => {
    // The opposite instruction, and it has to be stated. Silence here would leave the model
    // free to invent the internal sell it writes by default, against an explicit answer.
    const block = buildBuyerProfileBlock(profile({ signoff_required: false }))
    expect(block).toContain('CAN BUY ALONE')
    expect(block).toContain('Do not write an internal approval step')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// RULE ZERO
// ═════════════════════════════════════════════════════════════════════════════

describe('Rule Zero: the module names no real place, title, sector or archetype', () => {
  const source = readFileSync(join(ROOT, MODULE_PATH), 'utf-8')
  const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  it('contains no country NAME this platform recognises, in any capitalisation', () => {
    const names: string[] = []
    for (const code of knownIso2CountryCodes()) {
      for (const alias of aliasesForIso2(code)) {
        if (alias.length > 2) names.push(alias)
      }
    }
    // The scan must have teeth. An empty list would pass over nothing.
    expect(names.length).toBeGreaterThan(40)

    const found = names.filter(n => new RegExp(`\\b${escape(n)}\\b`, 'i').test(source))
    expect(found).toEqual([])
  })

  it('contains no bare ISO-2 country CODE', () => {
    // Case-sensitive, because several codes are ordinary English words. This file is
    // deliberately written with no two-letter word in capitals at all, so the scan needs no
    // exclusions and therefore keeps its teeth. See the geography agent test for the same
    // hazard solved the same way.
    const codes = Array.from(knownIso2CountryCodes())
    expect(codes.length).toBeGreaterThan(20)
    const found = codes.filter(c => new RegExp(`\\b${escape(c)}\\b`).test(source))
    expect(found).toEqual([])
  })

  it('both scans detect a planted name and a planted code', () => {
    // POSITIVE CONTROL. Without it, a regex broken so that it never matched would leave the
    // two scans above green over a file full of real place names.
    const code = Array.from(knownIso2CountryCodes())[0]
    const name = Array.from(aliasesForIso2(code)).find(a => a.length > 2)!
    const polluted = `${source}\n// Target ${name} and ${code}.`
    expect(new RegExp(`\\b${escape(name)}\\b`, 'i').test(polluted)).toBe(true)
    expect(new RegExp(`\\b${escape(code)}\\b`).test(polluted)).toBe(true)
  })

  it('carries no worked example, because an example in a targeting rule is an instruction', () => {
    // The strongest mechanical form of the rule. Every concrete value in the rendered block
    // is the client's own text; nothing in the module supplies one to copy.
    const rendered = buildBuyerProfileBlock(profile({
      target_countries: [A_PLACE],
      buyer_headcount_min: 5,
      buyer_headcount_max: 50,
      buyer_job_titles: [A_TITLE],
      buyer_seniority_bands: [PROVIDER_SENIORITY_BANDS[0]],
      first_contact_role: A_TITLE,
      signoff_required: true,
      signoff_role: A_TITLE,
      disqualifiers: ['a stated exclusion'],
    }))
    // Anything the block contains that the client did not supply is static text. Remove the
    // supplied values and no digit naming a size may remain.
    const staticOnly = rendered
      .split('\n')
      .filter(l => !l.trim().startsWith('- ') && !/lower bound|upper bound/.test(l))
      .join('\n')
    expect(staticOnly).not.toMatch(/\b\d{2,}\b/)
  })

  it('names no industry or sector shape that has reached this repo before', () => {
    // Patterns, not a dictionary: the shapes that have actually appeared in these prompts.
    const SHAPES =
      /\b(consult(ing|ant|ancy)|SaaS|logistics|recruitment agenc(y|ies)|law firm|accountanc(y|ies)|hospitality|construction|e-?commerce|fintech|manufactur(ing|er)|healthcare provider|coaching)\b/i
    expect(SHAPES.test(source), 'a sector name reached the module').toBe(false)
    // Positive control for the pattern itself.
    expect(SHAPES.test('we work with a law firm')).toBe(true)
  })
})
