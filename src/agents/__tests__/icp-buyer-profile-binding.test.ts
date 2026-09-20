// The ICP agent reading the buyer-targeting answers: what changes, and what must not.
//
// The claims split in two and the second half is the one that protects everybody:
//
//   WITH ANSWERS     a stated country list beats the domain-ending guess, and the block
//                    binding the schema fields is present and placed last.
//   WITHOUT ANSWERS  the message is byte-identical to the one this client got before any
//                    of this existed. Four of the five live organisations are here.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildResearchPlan, buildUserMessage } from '@/agents/icp-generation-agent'
import { geographyFromIntake } from '@/lib/agents/research-descriptors'
import { EMPTY_BUYER_PROFILE, type BuyerProfile } from '@/lib/intake/buyer-profile'
import { BUYER_PROFILE_BLOCK_HEADING } from '@/lib/intake/buyer-profile-authority'

const ROOT = process.cwd()

function row(field_key: string, response_value: string) {
  return { field_key, field_label: field_key, response_value, section: 's', is_critical: true }
}

function profile(overrides: Partial<BuyerProfile> = {}): BuyerProfile {
  return { ...EMPTY_BUYER_PROFILE, ...overrides }
}

const A_PLACE = 'Placeholderia'
const ANOTHER_PLACE = 'Exampleland'

/**
 * A domain whose ending the guess DOES recognise, recovered from the guess itself rather
 * than written down.
 *
 * Nothing in this file names a real country. Finding the domain by asking the function is
 * also the only way the assertions below stay true if the allowlist changes, and it throws
 * rather than returning a placeholder, so a test built on it cannot pass vacuously.
 */
function aRecognisedDomainAndItsCountry(): { url: string; country: string } {
  for (let a = 97; a <= 122; a++) {
    for (let b = 97; b <= 122; b++) {
      const tld = String.fromCharCode(a) + String.fromCharCode(b)
      const url = `https://example.${tld}`
      const country = geographyFromIntake(url)
      if (country) return { url, country }
    }
  }
  throw new Error(
    'no two-letter domain ending resolves to a country. The guess has no allowlist left, ' +
    'and every test below would prove nothing.',
  )
}

const DOMAIN = aRecognisedDomainAndItsCountry()

// A buyer descriptor good enough that research is not skipped, so the geography hint is
// actually reached. A skipped plan has no queries to assert on.
const INTAKE = [
  row('clients_clone', 'operations leads at mid-sized service businesses'),
  row('company_url', DOMAIN.url),
]

// ═════════════════════════════════════════════════════════════════════════════
// A STATED COUNTRY LIST BEATS THE DOMAIN GUESS
// ═════════════════════════════════════════════════════════════════════════════

describe('the research geography hint', () => {
  it('the domain guess is a real, working guess, so beating it means something', () => {
    // POSITIVE CONTROL for every test below. If the guess returned nothing here, "the
    // stated list won" would be indistinguishable from "neither source produced anything".
    expect(DOMAIN.country.length).toBeGreaterThan(2)
    const plan = buildResearchPlan(INTAKE, EMPTY_BUYER_PROFILE)
    expect(plan.skipped).toBe(false)
    expect(plan.queries.every(q => q.includes(DOMAIN.country))).toBe(true)
  })

  it('a single stated country replaces the domain country in every query', () => {
    const plan = buildResearchPlan(INTAKE, profile({ target_countries: [A_PLACE] }))
    expect(plan.queries.length).toBeGreaterThan(0)
    for (const query of plan.queries) {
      expect(query).toContain(A_PLACE)
      expect(query).not.toContain(DOMAIN.country)
    }
  })

  it('several stated countries suppress the domain guess and add no hint', () => {
    // The branch worth pinning. Falling back to the domain here would name one country out
    // of a set the client did not single out, and possibly one they never listed.
    const plan = buildResearchPlan(
      INTAKE,
      profile({ target_countries: [A_PLACE, ANOTHER_PLACE] }),
    )
    for (const query of plan.queries) {
      expect(query).not.toContain(DOMAIN.country)
      expect(query).not.toContain(A_PLACE)
      expect(query).not.toContain(ANOTHER_PLACE)
    }
  })

  it('no stated country leaves the domain guess exactly as it was', () => {
    for (const query of buildResearchPlan(INTAKE, EMPTY_BUYER_PROFILE).queries) {
      expect(query).toContain(DOMAIN.country)
    }
  })

  it('a profile argument that is omitted altogether behaves as no answers', () => {
    // Every existing caller and every existing test calls this with one argument.
    expect(buildResearchPlan(INTAKE)).toEqual(buildResearchPlan(INTAKE, EMPTY_BUYER_PROFILE))
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// AN ORGANISATION WITH NO ROW
// ═════════════════════════════════════════════════════════════════════════════

const BASE = {
  organisation_id: 'org-under-test',
  intake: INTAKE.map(r => ({ ...r, never_presented: false })),
  existingDocument: null,
  patterns: [],
  completeness: 100,
  research: { results: [], anyLimited: false, limitedNote: '' },
  researchSkipped: false,
  refDocs: [],
  websitePages: [],
  regeneration_notes: undefined,
}

describe('an organisation with no buyer-targeting answers', () => {
  it('gets a message containing no trace of the block', () => {
    const message = buildUserMessage({ ...BASE, buyerProfile: EMPTY_BUYER_PROFILE })
    expect(message).not.toContain(BUYER_PROFILE_BLOCK_HEADING)
    expect(message).not.toContain('company_profile.geography')
    expect(message).not.toContain('tier_3.disqualifiers')
  })

  it('gets a message identical to one built from a row of blanks', () => {
    // A row exists but every answer is empty or whitespace: the same state as no row, and
    // it must produce the same bytes.
    const blanks = profile({
      target_countries: ['', '   '],
      buyer_job_titles: [' '],
      first_contact_role: '  ',
      disqualifiers: [''],
    })
    expect(buildUserMessage({ ...BASE, buyerProfile: blanks }))
      .toBe(buildUserMessage({ ...BASE, buyerProfile: EMPTY_BUYER_PROFILE }))
  })

  it('the message is not empty and still carries the rest of the prompt', () => {
    // Anti-vacuity. Two empty strings are also identical.
    const message = buildUserMessage({ ...BASE, buyerProfile: EMPTY_BUYER_PROFILE })
    expect(message.length).toBeGreaterThan(400)
    expect(message).toContain('INTAKE QUESTIONNAIRE RESPONSES')
  })
})

describe('an organisation that answered', () => {
  const answered = profile({
    target_countries: [A_PLACE],
    buyer_headcount_min: 5,
    buyer_headcount_max: 50,
    buyer_job_titles: ['Chief Placeholder'],
  })

  it('gets the block exactly once', () => {
    const message = buildUserMessage({ ...BASE, buyerProfile: answered })
    expect(message.split(BUYER_PROFILE_BLOCK_HEADING)).toHaveLength(2)
  })

  it('gets the block AFTER the research, the website and the previous version', () => {
    // THE POSITION IS THE ARGUMENT. The block says it beats those inputs, so it is read
    // after them rather than several thousand tokens before them.
    const message = buildUserMessage({
      ...BASE,
      buyerProfile: answered,
      existingDocument: {
        id: 'd1', version: 'v2', plain_text: 'the previous document', content: {},
      },
    })
    const block = message.indexOf(BUYER_PROFILE_BLOCK_HEADING)
    expect(block).toBeGreaterThan(message.indexOf('INTAKE QUESTIONNAIRE RESPONSES'))
    expect(block).toBeGreaterThan(message.indexOf('WEB RESEARCH'))
    expect(block).toBeGreaterThan(message.indexOf('THE ICP DOCUMENT NOW LIVE'))
  })

  it('carries the answers themselves, not a summary of them', () => {
    const message = buildUserMessage({ ...BASE, buyerProfile: answered })
    expect(message).toContain(A_PLACE)
    expect(message).toContain('Chief Placeholder')
    expect(message).toContain('5')
    expect(message).toContain('50')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE SYSTEM PROMPT
// ═════════════════════════════════════════════════════════════════════════════

describe('the ICP system prompt', () => {
  const prompt = readFileSync(join(ROOT, 'docs/prompts/icp-agent.md'), 'utf-8')

  it('was read, so every assertion below means something', () => {
    expect(prompt.length).toBeGreaterThan(20000)
  })

  it('no longer labels its worked example as the closest canonical matches', () => {
    // THE DEFECT. Rule 7 says do not substitute a near miss, produce a shorter array, an
    // empty array is legal. The example then showed two canonical names labelled as the
    // closest available ones, which demonstrates the substitution the rule forbids. A
    // demonstration beats an instruction.
    expect(prompt).not.toContain('closest canonical match')
  })

  it('states the rule the example broke, so the absence above is not merely silence', () => {
    expect(prompt).toContain('DO NOT SUBSTITUTE A NEAR MISS')
    expect(prompt).toContain('the array may be empty')
  })

  it('the worked example now demonstrates the refusal', () => {
    const example = prompt.slice(prompt.indexOf('## Worked example'))
    expect(example).toContain('REFUSED')
    expect(example).toContain('shorter array is the correct')
  })

  it('does not add unknown to the canonical industries list', () => {
    // A validator throws on a non-member, and the escape hatch already exists in
    // unmatched_industries. Adding "unknown" would make every unresolved sector valid.
    const canonical = prompt.slice(
      prompt.indexOf('CANONICAL_INDUSTRIES'),
      prompt.indexOf('CANONICAL_INDUSTRIES') + 4000,
    )
    expect(canonical.toLowerCase()).not.toContain('| unknown')
    expect(canonical.toLowerCase()).not.toContain('"unknown"')
  })

  it('tells the model the direct answers outrank every other input', () => {
    expect(prompt).toContain('THEY ARE THE VALUES, NOT EVIDENCE')
    expect(prompt).toContain('Answers the client typed into a control built for the field')
  })

  it('the heading it quotes is the one the block actually renders', () => {
    // A prompt referring to a heading by a slightly different wording is a rule about a
    // section that never arrives. Pinned against the constant, not against a copy.
    const quoted = BUYER_PROFILE_BLOCK_HEADING.replace(/^##\s*/, '')
    expect(prompt).toContain(quoted)
  })

  it('no longer claims the intake asks no headcount question', () => {
    // It does now. Leaving the old sentence would tell the model to disbelieve an answer
    // it is being handed in the same message.
    expect(prompt).not.toContain('The intake asks no headcount question of any kind')
    expect(prompt).toContain('The intake NOW ASKS the client for their buyer')
  })

  it('still says the client own revenue has no question behind it', () => {
    // The other half of that pair is unchanged and must stay. No question is planned for
    // the buyer's revenue, and this session did not add one.
    expect(prompt).toContain('never asks what their buyer earns')
  })

  it('fixes the conversion event rather than leaving it to be invented', () => {
    expect(prompt).toContain('A BOOKED CALL')
    expect(prompt).toContain('The client is never asked what their conversion event is')
  })

  it('names what the conversion event is NOT, so the default has edges', () => {
    const section = prompt.slice(prompt.indexOf('### The conversion event'))
    for (const wrong of ['demo', 'trial', 'download', 'proposal']) {
      expect(section.toLowerCase(), `the default does not rule out a ${wrong}`)
        .toContain(wrong)
    }
  })
})
