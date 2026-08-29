// Guards the ICP research query builder.
//
// FIXED 2026-08-28: `const buyer = cloneClient || whatYouDo` fell back only when the
// ideal-client answer was EMPTY, so a non-empty answer that did not answer the question
// became the buyer descriptor verbatim.
//
// FIXED 2026-08-29, and this is what most of the file is about: that fallback still went
// to `whatYouDo`, which describes the client's SERVICE rather than the client's BUYER.
// The live query read "<service description> typical company size revenue headcount
// profile 2025", which is not a population a search engine can serve. Three consecutive
// ICP generations reported research returning nothing. Two changes replace it:
//   1. The buyer is now the RECIPIENT named inside the service description, not the whole
//      service description.
//   2. When nothing names a population, research is SKIPPED with a stated reason rather
//      than attempted with a bad query and reported as a search that found nothing.
//
// The cases below are the REAL condensed intake values from the five live organisations,
// measured on 2026-08-28 and re-measured on 2026-08-29. A test built from invented strings
// would prove the checks match their own examples and nothing about what people write.

import { describe, it, expect } from 'vitest'
import {
  buildResearchPlan,
  usableDescriptor,
  geographyFromIntake,
  recipientFromServiceDescription,
  resolveBuyerDescriptor,
} from '../icp-generation-agent'

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
    const v = 'Founder-led B2B service businesses, £2m-£20m revenue, 15-80 staff.'
    expect(usableDescriptor(v)).toBe(v)
  })

  it('accepts a possessive opener, which is an ordinary way to name a buyer', () => {
    // 'our' and 'my' are deliberately NOT in the opener set. Rejecting them would throw
    // away a good descriptor to catch a shape that has never appeared.
    const v = 'our clients are hospital procurement leads'
    expect(usableDescriptor(v)).toBe(v)
  })

  it('rejects a free-text answer too thin to carry more than a generic term', () => {
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

describe('recipientFromServiceDescription', () => {
  // Every case is a real company_what_you_do answer from the live intake.
  it('takes the complement of a recipient preposition', () => {
    expect(recipientFromServiceDescription(
      'We provide fractional COO and operations leadership to founder-led businesses, ' +
      'mostly £2m-£20m service companies. Founder steps back from day to day.',
    )).toBe('founder-led businesses, mostly £2m-£20m service companies')
  })

  it('prefers a preposition over an earlier beneficiary verb', () => {
    // "sell" appears before "into". Matching the verb first returns the PRODUCT
    // ("medical mattresses into hospitals") instead of the buyer, which is why
    // RECIPIENT_MARKERS is ordered rather than a single alternation.
    expect(recipientFromServiceDescription(
      'We sell medical mattresses into hospitals, care homes, etc. They are self-powered.',
    )).toBe('hospitals, care homes')
  })

  it('stops at the verb that opens a predicate about the recipient', () => {
    // Without the verb boundary this ran on into the benefit being sold and the query
    // asked about meetings rather than about consultants.
    expect(recipientFromServiceDescription(
      'I help B2B consultants get more qualified meetings in their diary through cold email.',
    )).toBe('B2B consultants')
  })

  it('stops at a function word that opens an adjunct', () => {
    expect(recipientFromServiceDescription(
      'We provide hot school lunches to children in Ireland on a contractual basis.',
    )).toBe('children in Ireland')
  })

  it('returns nothing when the description names no recipient', () => {
    // A real outcome, not an error: this genuinely does not say who buys.
    expect(recipientFromServiceDescription('We manufacture industrial fasteners.')).toBe('')
    expect(recipientFromServiceDescription('')).toBe('')
  })

  it('keeps a two-word recipient, which the prose floor would have rejected', () => {
    // An extracted phrase is already a noun phrase, so shortness is precision, not
    // thinness. The three-word prose floor skipped research for a client whose buyer the
    // intake names perfectly clearly.
    expect(recipientFromServiceDescription('We sell software to dental practices.'))
      .toBe('dental practices')
  })
})

describe('resolveBuyerDescriptor', () => {
  it('prefers the field that actually asks who the buyer is', () => {
    const d = resolveBuyerDescriptor([
      row('clients_clone', 'hospital procurement leads and clinical directors'),
      row('company_what_you_do', 'We sell surgical implants to hospitals'),
    ])
    expect(d).toEqual({ text: 'hospital procurement leads and clinical directors', source: 'ideal_client' })
  })

  it('falls back to the recipient inside the service description, never to the service', () => {
    const d = resolveBuyerDescriptor([
      row('clients_clone', 'They were the founder, with two people working for them'),
      row('company_what_you_do', 'We sell surgical implants to hospital procurement teams'),
    ])
    expect(d.source).toBe('service_recipient')
    expect(d.text).toBe('hospital procurement teams')
    // The regression that prompted the fix: the whole service description as the buyer.
    expect(d.text).not.toContain('surgical implants')
  })

  it('reports none when neither field names a population', () => {
    expect(resolveBuyerDescriptor([
      row('clients_clone', 'They were the founder, with two people working for them'),
      row('company_what_you_do', ''),
    ])).toEqual({ text: '', source: 'none' })
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
    for (const d of ['example.io', 'example.ai', 'example.co', 'example.me', 'example.tv']) {
      expect(geographyFromIntake(d), d).toBe('')
    }
  })

  it('returns nothing when there is no usable input', () => {
    expect(geographyFromIntake('')).toBe('')
    expect(geographyFromIntake('localhost')).toBe('')
  })

  it('never derives geography from currency', () => {
    // EUR spans twenty-odd countries and CLAUDE.md's geography rule says currency alone
    // is insufficient. If currency ever reaches the query again, this fails.
    const withCurrencyOnly = buildResearchPlan([
      row('company_what_you_do', 'We supply hot meals to primary schools'),
      row('clients_clone', 'primary school principals and board members'),
      row('company_currency', 'EUR'),
    ]).queries.join(' | ')
    expect(withCurrencyOnly).not.toContain('Europe')
    expect(withCurrencyOnly).not.toContain('EUR')

    const gbp = buildResearchPlan([
      row('company_what_you_do', 'We supply hot meals to primary schools'),
      row('company_currency', 'GBP'),
    ]).queries.join(' | ')
    expect(gbp).not.toContain('UK')
    expect(gbp).not.toContain('United Kingdom')
  })
})

describe('buildResearchPlan', () => {
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

  it('researches the recipient, not the service, when the ideal-client answer is off-question', () => {
    const plan = buildResearchPlan(LIVE)
    expect(plan.skipped).toBe(false)
    expect(plan.buyerSource).toBe('service_recipient')
    // The three buyer queries ask about the population.
    for (const q of plan.queries.slice(0, 3)) {
      expect(q, `service description survived into: ${q}`).not.toContain('hot school lunches')
      expect(q).toContain('children in Ireland')
    }
  })

  it('never lets narrative prose reach the provider', () => {
    for (const q of buildResearchPlan(LIVE).queries) {
      expect(q, `narrative prose survived into: ${q}`).not.toContain('let me solve')
      expect(q).not.toContain("that's my aim")
    }
  })

  it('applies the usability check to the trigger as well as to the descriptors', () => {
    // The gap the 2026-08-28 fix left: the trigger was condensed but never checked, so
    // all five live organisations sent a query 2 opening with narrative prose.
    const plan = buildResearchPlan([
      row('clients_clone', 'hospital procurement leads and clinical directors'),
      row('clients_trigger',
        'They were dealing with feast and famine cycles. Their revenue was all over the place.'),
    ])
    const q2 = plan.queries[1]
    expect(q2, `raw trigger prose reached the query: ${q2}`).not.toContain('They were dealing')
    expect(q2).toContain('buying trigger events')
  })

  it('keeps a trigger that reads as an event', () => {
    const plan = buildResearchPlan([
      row('clients_clone', 'hospital procurement leads and clinical directors'),
      row('clients_trigger', 'Founder is the bottleneck. Cannot take a holiday.'),
    ])
    expect(plan.queries[1]).toContain('Founder is the bottleneck.')
  })

  it('uses the country from the domain and not the currency zone', () => {
    for (const q of buildResearchPlan(LIVE).queries) {
      expect(q).toContain('Ireland')
      expect(q, `currency zone contradicted the country in: ${q}`).not.toContain('Europe')
    }
  })

  it('emits no double spaces when the geography hint is absent', () => {
    const plan = buildResearchPlan([
      row('company_what_you_do', 'We supply hot meals to primary schools'),
      row('clients_clone', 'primary school principals and board members'),
      row('company_url', 'example.com'),
    ])
    for (const q of plan.queries) {
      expect(q, `double space in: "${q}"`).not.toMatch(/\s{2}/)
      expect(q).toBe(q.trim())
    }
  })

  it('truncates the descriptor at a sentence boundary, not mid-clause', () => {
    // The live answer used to end "... 15-80 staff. Usually the founder is", a subject
    // with no predicate, and that fragment was in every query.
    const plan = buildResearchPlan([
      row('clients_clone',
        'Founder-led B2B service businesses, £2m-£20m revenue, 15-80 staff. Usually the ' +
        'founder is still in everything, and it is breaking.'),
    ])
    for (const q of plan.queries) {
      expect(q, `dangling clause in: ${q}`).not.toContain('Usually the founder is')
    }
  })

  // ─── The skip path ──────────────────────────────────────────────────────────

  it('SKIPS research rather than sending a bad query when nothing names a buyer', () => {
    const plan = buildResearchPlan([
      row('clients_clone', 'They were the founder, with two people working for them'),
      row('company_what_you_do', ''),
      row('company_currency', 'EUR'),
    ])
    expect(plan.skipped).toBe(true)
    expect(plan.queries).toEqual([])
    expect(plan.buyerSource).toBe('none')
  })

  it('states that research was SKIPPED, not that a search returned nothing', () => {
    // The two are different facts about a document and only one is actionable. The old
    // behaviour reported a bad query as "web search returned limited results", which
    // reads as a provider problem and tells the operator nothing to do.
    const reason = buildResearchPlan([row('clients_clone', 'they needed support')]).skipReason
    expect(reason).toMatch(/SKIPPED/)
    expect(reason).toMatch(/did not supply/i)
    expect(reason.toLowerCase()).not.toMatch(/returned limited|returned no results/)
  })

  it('skips on empty intake rather than searching a generic population', () => {
    const plan = buildResearchPlan([])
    expect(plan.skipped).toBe(true)
    expect(plan.queries).toEqual([])
  })

  it('flags a service-recipient descriptor so a wrong population is visible', () => {
    // A service delivered to one party and bought by another gives a real population and
    // the wrong one. No category-level rule separates those, so the note makes it visible.
    const plan = buildResearchPlan(LIVE)
    expect(plan.descriptorNote).toContain('children in Ireland')
    expect(plan.descriptorNote).toMatch(/who actually BUYS/)
  })

  it('emits no descriptor note when the ideal-client answer was used', () => {
    const plan = buildResearchPlan([
      row('clients_clone', 'hospital procurement leads and clinical directors'),
    ])
    expect(plan.buyerSource).toBe('ideal_client')
    expect(plan.descriptorNote).toBe('')
  })
})
