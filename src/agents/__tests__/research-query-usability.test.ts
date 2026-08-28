// Guards the two fixes to the ICP research query builder, made 2026-08-28.
//
// The bug they replace: `const buyer = cloneClient || whatYouDo` fell back only when the
// ideal-client answer was EMPTY, so a non-empty answer that did not answer the question
// became the buyer descriptor verbatim. Four of the five live organisations produced a
// descriptor of that shape, and the document that prompted the fix came back with a
// research note saying web search returned limited results. Research did not fail. It was
// asked a sentence of narrative prose.
//
// The cases below are the REAL condensed intake values from those five organisations,
// measured on 2026-08-28. A test built from invented strings would prove the check matches
// its own examples and nothing about the answers people actually write.

import { describe, it, expect } from 'vitest'
import { buildResearchQueries, usableDescriptor, geographyFromIntake } from '../icp-generation-agent'

function row(field_key: string, response_value: string) {
  return { field_key, field_label: field_key, response_value, section: 's', is_critical: true }
}

describe('usableDescriptor', () => {
  // Verbatim, as condense() produces them from the live intake.
  const REJECTED: Array<[string, string]> = [
    ['pronoun opener, narrative about a past engagement',
      'They were the founder, with two people working for them on a contract'],
    ['pronoun opener, describes an attitude rather than a population',
      'They understand that people pay for ease of use. Most mattresses you'],
    ['conjunction opener plus first person, answers a different question entirely',
      "When a problem becomes our problem, that's my aim. let me solve"],
    ['first-person preamble before the descriptor ever starts',
      "I don't have a client yet, but my single best client would be"],
  ]

  it.each(REJECTED)('rejects: %s', (_label, value) => {
    expect(usableDescriptor(value)).toBe('')
  })

  it('accepts the one live answer that does name a population', () => {
    const v = 'Founder-led B2B service businesses, £2m-£20m revenue, 15-80 staff. Usually the founder is'
    expect(usableDescriptor(v)).toBe(v)
  })

  it('accepts a possessive opener, which is an ordinary way to name a buyer', () => {
    // 'our' and 'my' are deliberately NOT in the opener set. Rejecting them would throw
    // away a good descriptor to catch a shape that has never appeared.
    const v = 'our clients are hospital procurement leads'
    expect(usableDescriptor(v)).toBe(v)
  })

  it('rejects an answer that is too thin to carry more than the generic fallback', () => {
    expect(usableDescriptor('they needed support')).toBe('')
    expect(usableDescriptor('small firms')).toBe('')
  })

  it('rejects on a first-person marker anywhere, not only at the front', () => {
    expect(usableDescriptor('Best client was my first and took a lot from that')).toBe('')
  })

  it('empty in, empty out', () => {
    expect(usableDescriptor('')).toBe('')
  })
})

describe('geographyFromIntake', () => {
  it('reads the country from the ccTLD of the client own domain', () => {
    expect(geographyFromIntake('www.360biaog.ie')).toBe('Ireland')
    expect(geographyFromIntake('https://partscale.co.uk')).toBe('United Kingdom')
    expect(geographyFromIntake('  HTTPS://Example.DE/about?x=1  ')).toBe('Germany')
  })

  it('returns nothing for a generic TLD rather than guessing', () => {
    expect(geographyFromIntake('simcairmedical.com')).toBe('')
    expect(geographyFromIntake('margenticOS.com ')).toBe('')
  })

  it('returns nothing for a ccTLD sold as a vanity domain', () => {
    // .io, .ai, .co and friends are country codes that say nothing about where a business
    // operates. The allowlist omits them on purpose.
    for (const d of ['example.io', 'example.ai', 'example.co', 'example.me', 'example.tv']) {
      expect(geographyFromIntake(d), d).toBe('')
    }
  })

  it('returns nothing when there is no usable input', () => {
    expect(geographyFromIntake('')).toBe('')
    expect(geographyFromIntake('localhost')).toBe('')
  })

  it('never derives geography from currency', () => {
    // The whole of cause two. EUR spans twenty-odd countries and CLAUDE.md's geography
    // rule says currency alone is insufficient. If currency ever reaches the query again,
    // this fails.
    const withCurrencyOnly = buildResearchQueries([
      row('company_what_you_do', 'We supply hot meals to primary schools'),
      row('clients_clone', 'primary school principals and board members'),
      row('company_currency', 'EUR'),
    ]).join(' | ')
    expect(withCurrencyOnly).not.toContain('Europe')
    expect(withCurrencyOnly).not.toContain('EUR')

    const gbp = buildResearchQueries([
      row('company_what_you_do', 'We supply hot meals to primary schools'),
      row('company_currency', 'GBP'),
    ]).join(' | ')
    expect(gbp).not.toContain('UK')
    expect(gbp).not.toContain('United Kingdom')
  })
})

describe('buildResearchQueries end to end', () => {
  // The live school-meals client, reduced to the fields the builder reads.
  const LIVE = [
    row('company_what_you_do',
      'We provide hot school lunches to children in Ireland on a contractual basis with the government.'),
    row('clients_clone',
      "When a problem becomes our problem, that's my aim. let me solve our problem."),
    row('clients_trigger', 'they needed support'),
    row('company_currency', 'EUR'),
    row('company_url', 'www.360biaog.ie'),
  ]

  it('falls back to the service description when the ideal-client answer is off-question', () => {
    for (const q of buildResearchQueries(LIVE)) {
      expect(q, `narrative prose survived into: ${q}`).not.toContain('let me solve')
      expect(q).not.toContain("that's my aim")
      expect(q).toContain('school lunches')
    }
  })

  it('uses the country from the domain and not the currency zone', () => {
    for (const q of buildResearchQueries(LIVE)) {
      expect(q).toContain('Ireland')
      expect(q, `currency zone contradicted the country in: ${q}`).not.toContain('Europe')
    }
  })

  it('emits no double spaces when the geography hint is absent', () => {
    const queries = buildResearchQueries([
      row('company_what_you_do', 'We supply hot meals to primary schools'),
      row('clients_clone', 'primary school principals and board members'),
      row('company_url', 'example.com'),
    ])
    for (const q of queries) {
      expect(q, `double space in: "${q}"`).not.toMatch(/\s{2}/)
      expect(q).toBe(q.trim())
    }
  })

  it('still returns four usable queries when every descriptor is unusable', () => {
    const queries = buildResearchQueries([
      row('clients_clone', 'They were the founder, with two people working for them'),
      row('company_currency', 'EUR'),
    ])
    expect(queries).toHaveLength(4)
    for (const q of queries) {
      expect(q.trim().length).toBeGreaterThan(0)
      expect(q).not.toContain('They were the founder')
    }
  })
})
