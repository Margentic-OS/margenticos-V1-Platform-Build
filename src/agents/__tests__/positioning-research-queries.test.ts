// Guards the positioning research query port, 2026-08-29 (ADR-045).
//
// The positioning builder was untouched from the start of the project while the ICP
// builder was fixed twice. It carried four defects, all measured against the real intake
// of the five live organisations before the port:
//
//   1. Query 2 interpolated `clients_clone` RAW into a quoted-phrase search. All five
//      organisations sent narrative prose. One read: 'When a problem becomes our problem,
//      that's my aim. let me solve "looking for" OR "need help with" ...'.
//   2. Geography came from CURRENCY, which CLAUDE.md's geography rule forbids. Every EUR
//      client was searched against "Europe", including an .ie client whose own domain
//      says Ireland.
//   3. No skip path. With no service description it substituted the literal
//      "B2B service providers" and searched anyway.
//   4. `service` fell back to `offer_deliverables`, which is an OUTCOME in all five live
//      answers, so one organisation's competitor query searched "A qualified meeting in
//      the diary that flows into pipeline and drives".

import { describe, it, expect } from 'vitest'
import { buildResearchPlan } from '../positioning-generation-agent'

function row(field_key: string, response_value: string) {
  return { field_key, field_label: field_key, response_value, section: 's', is_critical: true }
}

describe('positioning research plan', () => {
  it('never sends raw narrative prose into the quoted-phrase buyer query', () => {
    // Defect 1. The quoted-phrase form makes this worse than the ICP case: a sentence of
    // prose next to '"looking for" OR "need help with"' cannot match anything.
    const plan = buildResearchPlan([
      row('company_what_you_do', 'We supply hot meals to primary schools'),
      row('clients_clone', "When a problem becomes our problem, that's my aim. let me solve"),
    ])
    for (const q of plan.queries) {
      expect(q, `narrative prose survived into: ${q}`).not.toContain('let me solve')
      expect(q).not.toContain("that's my aim")
    }
    // The prose is rejected, and the buyer then resolves from the service RECIPIENT, the
    // same order the ICP agent uses. So query 2 still names a population; it just is not
    // the one someone typed a story into.
    expect(plan.buyerSource).toBe('service_recipient')
    expect(plan.queries[1]).toContain('primary schools')
  })

  it('takes the no-buyer form when nothing at all names a population', () => {
    // A service description that genuinely names no recipient. Real, not contrived:
    // plenty of businesses describe what they make without saying who buys it.
    const plan = buildResearchPlan([
      row('company_what_you_do', 'We manufacture industrial fasteners'),
      row('clients_clone', 'They were the founder, with two people working for them'),
    ])
    expect(plan.skipped).toBe(false)
    expect(plan.buyerSource).toBe('none')
    expect(plan.queries[1]).toContain('buyer search intent category language')
    expect(plan.queries[1]).not.toContain('"looking for"')
    // The service queries still work: this agent's other three do not need a buyer.
    expect(plan.queries[0]).toContain('industrial fasteners')
  })

  it('uses a usable ideal-client answer for the buyer query', () => {
    const plan = buildResearchPlan([
      row('company_what_you_do', 'We supply hot meals to primary schools'),
      row('clients_clone', 'primary school principals and board members'),
    ])
    expect(plan.buyerSource).toBe('ideal_client')
    expect(plan.queries[1]).toContain('primary school principals and board members')
    expect(plan.queries[1]).toContain('"looking for" OR "need help with"')
  })

  it('takes geography from the domain and never from currency', () => {
    // Defect 2.
    const eur = buildResearchPlan([
      row('company_what_you_do', 'We supply hot meals to primary schools'),
      row('company_currency', 'EUR'),
      row('company_url', 'www.example.ie'),
    ])
    for (const q of eur.queries) {
      expect(q, `currency zone reached: ${q}`).not.toContain('Europe')
      expect(q).not.toContain('EUR')
    }
    expect(eur.queries[0]).toContain('Ireland')

    const gbp = buildResearchPlan([
      row('company_what_you_do', 'We supply hot meals to primary schools'),
      row('company_currency', 'GBP'),
    ])
    // No domain, so no hint at all. Broader beats wrong.
    for (const q of gbp.queries) expect(q).not.toContain('UK')
  })

  it('SKIPS rather than searching a hardcoded category when intake describes no service', () => {
    // Defect 3.
    const plan = buildResearchPlan([row('clients_clone', 'primary school principals')])
    expect(plan.skipped).toBe(true)
    expect(plan.queries).toEqual([])
    expect(plan.skipReason).toMatch(/SKIPPED/)
    expect(plan.skipReason).toMatch(/did not.*describe what this business sells/i)
  })

  it('does not fall back to offer_deliverables, which describes an outcome', () => {
    // Defect 4. Every live offer_deliverables answer is an outcome, so using it as the
    // service descriptor searched the result rather than the category.
    const plan = buildResearchPlan([
      row('company_what_you_do', ''),
      row('offer_deliverables',
        'A qualified meeting in the diary that flows into pipeline and drives revenue'),
    ])
    expect(plan.skipped).toBe(true)
    for (const q of plan.queries) expect(q).not.toContain('qualified meeting')
  })

  it('returns four queries when intake describes a service', () => {
    const plan = buildResearchPlan([
      row('company_what_you_do', 'We supply hot meals to primary schools'),
      row('clients_clone', 'primary school principals and board members'),
      row('company_url', 'example.com'),
    ])
    expect(plan.skipped).toBe(false)
    expect(plan.queries).toHaveLength(4)
    for (const q of plan.queries) {
      expect(q.trim().length).toBeGreaterThan(0)
      expect(q, `double space in: "${q}"`).not.toMatch(/\s{2}/)
      expect(q).toBe(q.trim())
      expect(q).toContain('hot meals to primary schools')
    }
  })

  it('trims a dangling function word left by a hard cut', () => {
    // "...on a contractual basis with" promises a complement that was cut off. Measured
    // on the live school-meals client, whose first sentence is over the word budget.
    const plan = buildResearchPlan([
      row('company_what_you_do',
        'We provide hot school lunches to children in Ireland on a contractual basis with the government.'),
      row('clients_clone', 'primary school principals and board members'),
    ])
    for (const q of plan.queries) {
      expect(q, `dangling function word in: ${q}`).not.toMatch(/\bbasis with\b/)
    }
  })
})
