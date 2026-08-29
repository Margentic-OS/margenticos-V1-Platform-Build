import { describe, it, expect } from 'vitest'
import { buildResearchPlan } from '../icp-generation-agent'
import { buildResearchQueries as buildPositioningQueries } from '../positioning-generation-agent'

// The ICP agent may now DECLINE to search when intake names no buyer population, so its
// entry point returns a plan rather than a bare array. This adapter keeps the shared
// agnosticism assertions below applicable to both agents. The skip path itself is covered
// in research-query-usability.test.ts.
const buildIcpQueries = (intake: Parameters<typeof buildResearchPlan>[0]) =>
  buildResearchPlan(intake).queries

// These tests guard the industry-agnosticism rule in CLAUDE.md at the point it was
// broken: the web research queries. The previous implementation chose between two
// hardcoded consulting literals on each branch of every ternary, so intake could not
// change the query. The .length checks read intake values but never interpolated them.
//
// The assertions below are deliberately about the SEAM: that intake text reaches the
// query string. A test that only checked "no consulting words" would pass against a
// query that ignored intake entirely and said nothing at all.

function row(field_key: string, response_value: string) {
  return { field_key, field_label: field_key, response_value, section: 's', is_critical: true }
}

// A client whose business has nothing to do with consulting: the school-meals case
// that the live 360 Bia Og document covers.
const SCHOOLS_INTAKE = [
  row('company_what_you_do', 'We supply hot school meals to primary schools'),
  row('clients_clone', 'Irish primary school principals and board members'),
  row('clients_trigger', 'a failed food safety inspection or a catering contract ending'),
  row('company_currency', 'EUR'),
  row('offer_deliverables', 'daily hot meal delivery and menu planning'),
]

// Terms that belong to MargenticOS's own market, not to an arbitrary client's.
const LEAKED_TERMS = [
  'consulting', 'consultant', 'coaching', 'cold email', 'outbound',
  'lead generation', 'pipeline agency', 'feast famine',
]

describe('research query builders are industry-agnostic', () => {
  for (const [name, build] of [
    ['ICP', buildIcpQueries],
    ['positioning', buildPositioningQueries],
  ] as const) {
    describe(name, () => {
      const queries = build(SCHOOLS_INTAKE)

      it('returns four non-empty queries', () => {
        expect(queries).toHaveLength(4)
        for (const q of queries) expect(q.trim().length).toBeGreaterThan(0)
      })

      it('interpolates the client intake text into the queries', () => {
        const joined = queries.join(' | ').toLowerCase()
        // The seam: intake must actually reach the query, not merely gate a literal.
        expect(joined).toContain('school')
      })

      it('leaks no term from MargenticOS own market', () => {
        const joined = queries.join(' | ').toLowerCase()
        for (const term of LEAKED_TERMS) {
          expect(joined, `"${term}" leaked into ${name} queries: ${joined}`).not.toContain(term)
        }
      })

      it('changes the queries when the intake changes', () => {
        const other = build([
          row('company_what_you_do', 'We distribute surgical implants to hospitals'),
          row('clients_clone', 'hospital procurement leads'),
          row('company_currency', 'GBP'),
        ])
        // If any hardcoded literal survives, at least one query pair stays identical.
        for (let i = 0; i < 4; i++) {
          expect(other[i], `query ${i} did not change with intake`).not.toBe(queries[i])
        }
      })
    })
  }

  it('the positioning agent still produces usable queries when intake is empty', () => {
    const queries = buildPositioningQueries([])
    expect(queries).toHaveLength(4)
    for (const q of queries) expect(q.trim().length).toBeGreaterThan(0)
  })

  it('the ICP agent skips rather than searching a generic population on empty intake', () => {
    // Deliberately NOT the same contract as positioning. Three of the four ICP queries are
    // about the buyer, so with no buyer there is nothing worth asking. Positioning's
    // queries are about the client's own service and still mean something without one.
    // See BACKLOG: the positioning builder has not had this fix applied.
    const plan = buildResearchPlan([])
    expect(plan.skipped).toBe(true)
    expect(plan.queries).toEqual([])
  })
})
